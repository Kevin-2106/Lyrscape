# 内存排查与优化（2026-10-13）

## 确认的现象

用户日常实例 `builds/Lyrscape.exe` 的 Rust 进程私有内存约 21 MiB，两个 WebView2 renderer 分别约 1,266 MiB 和 570 MiB。主窗口位于插件页，未挂载歌词画布。

CDP 垃圾回收诊断中，主窗口 JS 堆由约 603 MiB 降到 4 MiB，overlay 由约 48 MiB 降到 4.4 MiB。该结果说明巨量暂时占用可回收，不能据此认定存在永久对象泄漏；也不能只靠一次 GC 排除全部长期问题。诊断用 GC 没有加入产品。

旧版还存在这些可核查的分配路径：

- 主窗口每次同步都广播整个 AppState；虽然不消费该状态，仍执行包含完整歌词的事件脚本。日常实例采样 5 秒观察到 6 次、合计约 297 KB 的匿名注入脚本，单次约 50 KB。
- 原始 PCM 在两个 WebView 中经过 JSON 数字数组及 Uint8Array 拷贝。
- 插件面板每次进度更新遍历目录并写入控件；播放图标反复替换 SVG。
- 隐藏的原生 overlay 继续运行渲染器；淘汰布局只删除 JS 引用，未立即清空离屏画布的 backing store。

## 实现

- `sendOverlayEvent` 定向发送状态，仅完整状态改变或 overlay 请求同步时发送 AppState；常规时间锚通过 `lyrscape-playback` 更新。完整同步仍保留歌词引用比较，避免跨窗口克隆重播动画。
- PCM 使用二进制 Channel，保持同通道 reset 顺序、来源校验、每窗口 4 块背压和确认语义，消费者 SDK 保持原样。
- 插件面板只响应插件配置或管理变化；播放图标只在播放状态变化时替换。
- 原生 overlay 隐藏时卸载 renderer，显示时以最新 state/time 挂载。浏览器独立 `?surface=overlay` 预览继续显示。
- PV 布局记录它创建的 Sprite，配置/歌词/字体变化、缓存淘汰、卸载时立即清空画布。缓存按数量与 32 MiB 纹理预算淘汰本帧未用布局；本帧仍使用的资源保留，因此预算不是总进程内存硬上限。主画布卸载也清空尺寸。
- 已加载字体不重复请求或触发布局失效，粒子缓存清理时同步释放纹理。

## 原生对比结果

两版分别启动独立 WebView2 数据目录，使用相同的 60 行合成逐字歌词、20 Hz 进度、10 Hz PCM、Pop renderer、显示 overlay、主窗口插件页。自然采样期间没有主动 GC。采样进程包括宿主与其全部 WebView2 子进程。

| 约 2.5 分钟的测量 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 实际运行时长 | 147.7 s | 149.1 s |
| 私有内存起点 → 终点 | 515 → 986 MiB | 474 → 547 MiB |
| 工作集起点 → 终点 | 707 → 1,215 MiB | 676 → 831 MiB |
| 自然采样最大单窗口 JS 堆 | 201 MiB | 12 MiB |
| 最后诊断 GC 后两个 JS 堆 | 3.0 / 3.2 MiB | 2.8 / 3.0 MiB |
| 隐藏后 DOM 画布数 | 1 | 0 |
| 恢复后有效绘制像素 | 78,813 | 77,847 |

私有内存终点下降约 45%，本轮运行期间的增加量下降约 85%。工作集包含共享页，不能与任务管理器的所有内存列直接等同；该表不是冷启动闲置占用，也不是数小时泄漏证明。不同字体、歌词、显示缩放和渲染器会改变占用。测试原始报告、截图与 GC 诊断在未提交的 `qa/memory/`；不把用户曲目或歌词写入交付报告。

## 复现与回归

```powershell
npm test
cd src-tauri
cargo test --lib
cd ..
npm run desktop:build
node scripts/smoke-memory.mjs --exe=qa/memory/baseline.exe --label=baseline --seconds=120
node scripts/smoke-memory.mjs --label=optimized --seconds=120
```

`smoke-memory.mjs` 自行启动独立 profile，使用 CDP 9231、fixture 11445；不要将它指向日常实例的运行中 exe。它记录自然进程/堆趋势，最后才诊断 GC，并检查隐藏/恢复及实际像素。`--seconds` 是采样等待时间，进程采样本身也耗时，报告记录实际时长。

前端 70 项测试、Rust 14 项测试通过；新增回归覆盖 PCM 二进制头/采样原样保留、拒绝截断/危险整数、播放进度不刷新插件目录、布局淘汰/换歌词/卸载时释放纹理。原生节拍回归验证两个窗口检测约 120 BPM、实际像素每拍跃动、暂停/切歌/静音停止效果。

最终独立 release 的五种 PV 原生像素回归通过：进入/保持/退出、暂停、跳转确定性、overlay 同步、布局选择、配置保留、减少动态效果与停用回退。交付 exe 与 release 的 SHA-256 一致，旧版保留为 `builds/Lyrscape-before-memory-20261013.exe`。

更新用户日常实例后，AMLL 在 11444 成功恢复真实 Connector 连接，文字/插件/快捷键配置、当前插件页、隐藏/穿透/置顶/边框及 overlay 位置/宽度均核验恢复。原来的隐藏 overlay 状态下，自然采样 45 秒的私有内存为 287–311 MiB，整组工作集为 560–573 MiB，两个 JS 堆约 2–3.5 MiB，overlay 没有画布。该采样没有主动 GC，不能代替数小时运行验证。

基础诊断依据：[Microsoft WebView2 性能说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)、[Tauri 原始字节 Channel](https://v2.tauri.app/reference/javascript/api/namespacecore/)。
