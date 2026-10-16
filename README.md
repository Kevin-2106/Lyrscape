# Lyrscape

**Your lyrics. Your landscape.**

基于 WebView 的自由桌面歌词宿主。逐字、逐行与无时间轴歌词，桌面 overlay，可替换的渲染器、主题和特效。

## 项目状态

2026-10-13：第一版 Windows 应用已实现，仓库保持 private。普通文字 renderer 支持逐行/逐字歌词，设置可实时调整 CSS 颜色、渐变与字体；AMLL V1/V2 接入和桌面透明 overlay 已实现。当前插件宿主运行显式注册的可信 TypeScript 插件，尚不支持任意第三方包安装或隔离运行。

## 运行

环境：Windows、WebView2 Runtime、Node.js 20.19+ 或 22.12+、Rust 1.90+、Visual Studio C++ 构建工具。

```powershell
npm ci
npm run desktop:dev
```

仅在浏览器查看设置与歌词预览：`npm run dev`。浏览器模式不提供原生 overlay 或 AMLL 监听服务。

构建独立 exe：`npm run desktop:build`，产物位于 `src-tauri/target/release/lyrscape.exe`。构建安装包使用 `npm run desktop:package`。

## 第一版功能

- 普通文字歌词；LRC、增强 LRC、常用歌词 TTML、纯文本导入，逐字数据按真实提供的时间显示。
- CSS 颜色值、未激活文字颜色、双色线性渐变与角度。
- 按歌词语言自动选择的打包字体（简体 / 繁体 / 日文不混排，见 [字体](docs/fonts.md)）、本机字体/自定义 font-family、字号、字重、行高、对齐、阴影、背景透明度、译文和下一行开关。
- 样式自动保存，设置与 overlay 共用时间基准和状态。
- 透明置顶窗口、鼠标穿透/编辑模式、拖动，按内容调整高度。
- 本机 AMLL WebSocket 接收服务，默认 `ws://localhost:11444`。在播放来源中选择 AMLL 并启动服务，然后在播放器 Connector 中填入地址。
- 插件管理与配置：分类 / 搜索、状态 / 依赖、可选插件启停、配置保存；普通文字默认，另有 Aurora 动画 renderer（彗星、旋转、棱镜进入）。
- 三种 PV renderer（canvas）：糖果波普、情书、水底挽歌，按 DECO*27 PV 的字体、配色与特效重做；副歌大字 / 主歌字幕自动构图，跟随歌词时间，可独立配置。

当前只读接收播放信息，不向外部播放器发送播放/seek 控制。更多实现边界与验证证据见 [第一版说明](docs/baseline.md)。

## All is plugin

所有产品功能均由插件贡献，包括内置功能。宿主保留最小运行底座：插件生命周期、服务注册、权限代理、数据契约、资源清理与恢复入口。

- 播放接入：首个 adapter 使用 AMLL WebSocket 协议；之后可加入 SMTC、MPRIS、浏览器桥接等。
- 歌词：格式解析、来源、匹配、校准与转换分别作为插件。
- 时间：时钟策略可替换，同一会话的视图共享一份时间基准。
- 视觉：渲染器、布局、主题、特效、可视化分别作为插件。
- 桌面：overlay、舞台、控制面板、设置与快捷键绑定均由插件贡献。

AMLL adapter 与 AMLL 渲染器是两个独立插件；接入 AMLL 协议不要求使用 AMLL 的显示样式。

## 文档

- [插件架构](docs/architecture.md)
- [AMLL adapter 调研与设计](docs/amll-adapter.md)
- [PCM 音频与全局快捷键](docs/audio-and-shortcuts.md)
- [节拍检测（PCM → 渲染器）](docs/beat-detection.md)
- [字体与歌词语言（简体 / 繁体 / 日文自动选择）](docs/fonts.md)
- [手动插件热重载](docs/manual-plugin-reload.md)
- [实施路线和验收标准](docs/roadmap.md)
- [第一版说明与验证](docs/baseline.md)
- [插件管理与动画 renderer](docs/plugins.md)
- [文字 PV 风格、时间规则与开发](docs/pv-renderers.md)
- [开发与贡献入口](CONTRIBUTING.md)
- [本地开发与验证](docs/development.md)
- [内存排查、优化与原生对比](docs/memory-optimization.md)
- [常驻内存、按需窗口与字体子集](docs/memory-footprint.md)
- [关闭到托盘与主窗口资源释放](docs/tray-lifecycle.md)
- [插件编写手册（.lyrx 包格式、渲染器 / 特效、打包与发布）](docs/plugin-authoring.md)
- [插件开发与可编译示例](docs/plugin-development.md)
- [交接清单](docs/handoff.md)
- [Overlay 修复与本轮验证](docs/overlay-validation.md)
- [AMLL adapter manifest 示例](examples/amll-adapter/plugin.json)

技术方向：Windows 优先；Tauri 2 + WebView2 + TypeScript。SDK 与插件契约不绑定 React/Vue，原生平台能力由 Rust 宿主代理。

## 参考与许可

参考 [AMLL](https://github.com/amll-dev/applemusic-like-lyrics)、[AMLL WS Protocol](https://github.com/amll-dev/ws-protocol) 和 [Lyricify](https://github.com/WXRIW/Lyricify-App)。AMLL wire codec 根据公开协议独立实现，未复制或依赖 AMLL/Lyricify 的实现；应用依赖及版本记录在 npm/Cargo lockfile。Lyrscape 的许可证尚未选定；以后采用第三方实现前须确认具体版本的许可信息，详见 adapter 调研。
