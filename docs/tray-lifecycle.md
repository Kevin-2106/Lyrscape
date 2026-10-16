# 关闭到托盘与主窗口资源释放

点击主窗口的关闭按钮后，应用保留原生托盘、AMLL 服务和全局快捷键，销毁主窗口及其 WebView。点击托盘图标或右键选择“打开 Lyrscape”重建控制面板；右键“退出 Lyrscape”才完全退出。普通最小化按钮仍按系统行为最小化。

桌面歌词显示时继续播放和接收歌词。没有创建桌面歌词窗口时，关闭控制面板后无需保留任何后台 WebView。已经创建的桌面歌词窗口仍沿用原有显示、隐藏和低内存策略，本功能只销毁主窗口。

## 状态与生命周期

- Rust `session.rs` 保存当前会话快照，并将主窗口的状态和增量进度定向发送给 overlay。进度更新只替换缓存中的播放字段，避免重新复制完整歌词。
- 跨 WebView 生命周期使用 epoch 时间和样本年龄恢复时钟，不能直接沿用旧窗口的 `performance.now()`。本地歌词、播放/暂停和当前进度在本次应用进程内恢复；设置和当前页面继续由已有本地存储保存。
- broker 为每个连接仅保留最新曲目、歌词、进度和播放状态，不缓存历史消息或 PCM。曲目切换清空旧曲目，断开连接清空该连接；暂停/继续时保存归一化进度，保留时间轴已有的五秒外推限制。
- 主窗口初始化完成后还会收到一次事件重放，兼容不认识新恢复命令的旧版可编辑 AMLL bundle；当前 adapter 按序号去重。旧插件文件不需要被覆盖。
- 主窗口关闭后，已经打开的 overlay 使用同一 AMLL adapter 的后台模式继续处理消息。重建主窗口后再交回控制权，连接无需重启。没有 overlay 时，Rust 缓存下一次重建需要的消息。
- 已提交的插件重载代码保存在 Rust 会话中，重建主窗口时恢复；没有主窗口时首次通过快捷键打开 overlay，也能读取相关插件代码。插件只存在于其 JavaScript 私有变量中的临时状态仍需由插件自行持久化。
- 主窗口销毁时清除其原生音频 Channel，保留应用级音频选择、监听器和快捷键。不会创建额外的隐藏 WebView。
- 原生窗口操作串行执行。最后一个窗口销毁触发的自动退出被阻止，托盘显式退出仍正常执行 broker 清理。

会话缓存仅存于内存，不新增磁盘歌词历史；完全退出后沿用原有启动行为。

## 验证入口

`npm test`、`cargo test --manifest-path src-tauri/Cargo.toml` 和 `node scripts/smoke-tray.mjs`。原生脚本使用独立 WebView2 profile、独立 AMLL 端口，通过 Windows 关闭消息和 tray-icon 的原生回调测试关闭、重建和菜单退出；不向用户实例发送操作。进程树、CDP 页面和失败日志保存在 `qa/tray/`。

托盘 API 参考：[Tauri System Tray](https://v2.tauri.app/learn/system-tray/)。

## 2026-10-16 交付验证

98 项前端测试、19 项 Rust 测试通过，release 构建通过。最终原生记录为 `qa/tray/1792127552367/report.json`，`complete=true`、`errors=[]`；完整执行日志为 `qa/tray/final-native.log`。

| 场景 | 私有内存 MiB | 工作集 MiB | 进程数 |
| --- | ---: | ---: | ---: |
| 主窗口，本地导入歌词，未创建 overlay | 243.0 | 241.2 | 7 |
| 关闭到托盘，没有任何 WebView | 7.0 | 43.9 | 1 |
| 无 WebView，AMLL 服务接收后台新曲目 | 8.6 | 45.1 | 1 |
| 控制面板与测试渲染器 overlay 同时显示 | 286.7 | 503.6 | 8 |
| 关闭主窗口，保留 overlay | 218.6 | 463.8 | 7 |

这些是独立 profile 中短时功能场景的自然采样，未强制 GC。显示 overlay 的样本使用专门的插件恢复测试渲染器，并加载旧版可编辑 AMLL adapter，不代表所有字体、PV 或长期运行场景的内存上限。工作集包含共享页面，不能将私有内存与工作集相加。

原生检查实际覆盖：Windows 关闭请求销毁页面、无 WebView 时 WebView2 子进程退出、托盘恢复本地导入与播放位置、后台 AMLL 新曲目缓存、没有主窗口时首次从托盘创建 overlay、已提交插件 v2 在磁盘文件已改为 v3 时仍正确恢复、旧版 AMLL bundle 重建后继续连接、主窗口销毁后的歌词更新与真实二进制 PCM、偏好重置保持生效、托盘显式退出。`tray-overlay.png` 记录了主窗口销毁后仍更新的原生歌词画面。

早期固定三秒采样可能碰到 WebView2 尚未退出，验证现等待实际退出；Windows PowerShell 对无 BOM 脚本中的中文字符串解码也曾造成菜单测试误判，fixture 改用 Unicode 转义。失败日志与部分报告保留在 `qa/tray/`。

默认程序为 `builds/Lyrscape.exe`，另有 `builds/Lyrscape-tray-20261016.exe`。两者与被测 release 的 SHA-256 均为 `05BBB0E4AD0FAB6A6A9B89C2DE01A9B8209DA408B2517D7F37DDA2A8C2637353`。旧程序备份为 `builds/Lyrscape-before-tray-20261016.exe`。没有启动用户 profile 或修改原有插件文件，测试实例均已退出。
