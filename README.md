# Lyrscape

**Your lyrics. Your landscape.**

基于 WebView 的自由桌面歌词宿主。逐字、逐行与无时间轴歌词，桌面 overlay，可替换的渲染器、主题和特效。

## 项目状态

2026-10-12：名称已确定，仓库先保持 private。本仓库目前提供架构设计与实施路线，尚无可运行的桌面应用；AMLL 通信、插件运行时与原生 overlay 均未实现或实机验证。

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
- [实施路线和验收标准](docs/roadmap.md)
- [AMLL adapter manifest 示例](examples/amll-adapter/plugin.json)

技术方向：Windows 优先；Tauri 2 + WebView2 + TypeScript。SDK 与插件契约不绑定 React/Vue，原生平台能力由 Rust 宿主代理。

## 参考与许可

参考 [AMLL](https://github.com/amll-dev/applemusic-like-lyrics)、[AMLL WS Protocol](https://github.com/amll-dev/ws-protocol) 和 [Lyricify](https://github.com/WXRIW/Lyricify-App)。本次初始化未复制第三方实现，也未引入这些依赖。Lyrscape 的许可证尚未选定；采用第三方实现前须确认具体版本的许可信息，详见 adapter 调研。
