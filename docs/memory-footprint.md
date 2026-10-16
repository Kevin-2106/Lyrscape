# 常驻内存优化（2026-10-16）

这轮处理的是剩余常驻成本；上轮的内存增长排查见 [2026-10-13 记录](memory-optimization.md)。基线与优化版均从当前工作区构建，使用相同的新 WebView2 profile、普通文字、暂停的自制演示歌词。没有对用户配置运行测试，也没有触发主动 GC 或调用系统工作集裁剪 API。

## 资源生命周期

- **桌面歌词按需创建**：`tauri.conf.json` 的 overlay 配置保留，但 `create:false`。状态查询、隐藏状态下调整穿透/边框、首次显示前重载插件，都不会创建第二个 renderer。首次显示或全局快捷键才通过原配置创建窗口，保留透明、无边框、缩放和置顶行为。
- **插件同步**：没有 overlay 时事务在控制窗提交；首次显示后，overlay 主动拉取已提交插件与最新播放状态。已经存在的窗口仍进行原有双端提交/回滚。全局快捷键的创建操作移到后台线程，避免 Windows UI 线程上的 WebView 创建死锁。
- **字体按需注册**：19 个字体族及全部字体文件仍随程序打包。CSS 拆成独立本地 chunk，只有实际需要的字体族才加载；只为当前歌词/译文包含的 code point 注册相关 `@font-face` 子集。新字符出现时增量插入规则，不反复替换已经加载的字面。
- **完整覆盖元数据**：字体覆盖不能取自当前 `document.fonts`，因为这里现在只有已用子集。构建脚本从本地字体 CSS 生成完整覆盖表，合并区间后以 varint/base64 存储（约 208 KiB），按需解码；整行缺字后备、简繁/日文字形及用户自定义字体保持可用。
- **隐藏缓存回收**：Windows overlay 隐藏、控制窗最小化时，请求 WebView2 的 Low 内存目标；显示/恢复时回到 Normal。没有暂停脚本或音频接收，插件 IPC 继续运行。旧 WebView2 不支持接口时正常回退。

相关依据：[Tauri 窗口按需创建](https://v2.tauri.app/reference/config/#windowconfig)、[Microsoft WebView2 内存目标](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.memoryusagetargetlevel)。Low 是浏览器回收提示，不是硬性内存上限；它不能代替减少字体对象或延迟创建窗口。

## 本地插件兼容

旧的可编辑 bundle 曾假设宿主预先注册字体。加载这种 bundle 时，兼容层为其代码引用的字体族注册完整 CSS，保留原有外观；不会改写已有 `.mjs` 或 `.css`。因此旧插件会保留一部分内存成本。

新构建的 bundle 通过共享字体 registry 复用宿主的按需加载。手动迁移时，先保留自己的修改，再用 `npm run plugins:build -- --out-dir=<新目录>` 输出新 bundle；默认不覆盖已有文件。

## 验证与复现

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run desktop:build
node scripts/smoke-memory-idle.mjs --exe=qa/memory-v2/baseline.exe --label=baseline
node scripts/smoke-memory-idle.mjs --exe=qa/memory-v2/release.exe --label=optimized
```

该基准自行启动隔离实例，测量初次预览、尚未创建 overlay、显示/隐藏、最小化/恢复六个状态。数据是整组进程私有内存与工作集，不等同于任务管理器的任意单列。缓存、显卡与其他进程会影响工作集，不将短期采样描述为数小时稳定性结论。

### 最终原生采样

普通文字、无旧本地插件的新 profile；两版使用同一套流程。单位 MiB，均为瞬时样本；下表包含没有改善的状态，不能把启动收益外推到所有使用场景。

| 状态 | 之前私有内存 | 之后私有内存 | 之前工作集 | 之后工作集 |
| --- | ---: | ---: | ---: | ---: |
| 首次预览 | 309.2 | 234.3 | 576.9 | 285.2 |
| 插件页，尚未打开 overlay | 353.8 | 294.2 | 613.2 | 380.7 |
| overlay 显示 | 373.6 | 362.7 | 645.6 | 391.4 |
| overlay 再次隐藏 | 372.5 | 356.8 | 648.4 | 335.5 |
| 控制窗最小化 | 343.5 | 342.2 | 356.7 | 346.7 |
| 控制窗恢复 | 331.8 | 318.8 | 278.2 | 308.0 |

首次预览的私有内存下降约 24%；打开 overlay 后私有内存下降约 3%，说明 WebView2 / GPU 常驻成本仍占主要部分。工作集受浏览器回收、GPU 与系统调度影响较大，恢复状态的单次样本还会反向波动。普通中文演示场景中每窗口字面数从 2,575 降到 24，首次打开前进程树少一个 renderer。对照数据为 `qa/memory-v2/comparison-final.json`，对应 `baseline-1792125154109` / `optimized-1792125265591`。

最终字体原生检查中，随着 SC → 新 SC 字符 → TC → 日文，字面数依次为 24 → 30 → 42 → 66；新字符仍保持正确的整行字体，不因未加载子集错误切换后备字体。自定义 Share Tech Mono 的真实字体加载与像素截图也通过。

前端回归覆盖按需字面注册、避免重复、传统文楷与简体文楷名称区分、新歌词字符使用完整覆盖元数据、自定义字体与旧插件兼容。原生检查覆盖首次热重载不创建窗口、真实 Windows 快捷键首次创建、隐藏恢复、七种 PV 实际像素与节拍音频。

最终 96 项前端测试、16 项 Rust 测试通过；Edge 的七种 PV 与 Apple Music 风格回归通过，原生七种 PV、约 120 BPM PCM 节拍、按需窗口和多语言字体检查通过。初次 Vite 预热超时及测试选择器/启动页竞态的失败日志均保留，修正测试后通过。

`builds/Lyrscape.exe` 已更新，另有 `builds/Lyrscape-memory-20261016.exe`；两者与最终 release 的 SHA-256 一致。旧版备份为 `builds/Lyrscape-before-memory-20261016.exe`。本轮开始时没有用户应用进程；没有启动用户 profile，也没有写入其设置或旧插件文件。

脚本与截图、基线 exe、失败迭代及测量原始数据均在未提交的 `qa/memory-v2/`；保留测试失败记录，最终验证以对应 final/quiet 日志为准。
