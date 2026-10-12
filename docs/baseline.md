# 第一版实现与验证

2026-10-13。Windows、Tauri 2、TypeScript、普通 DOM 文字 renderer。

## 插件实现

入口显式注册可信插件：demo/AMLL adapter、parser、timeline、普通文字 renderer、theme、overlay surface、settings UI。插件通过服务 ID 依赖排序启动，服务/订阅/定时器/renderer 的资源通过 scope 逆序清理；激活失败回滚。相同 service ID 只能有一个 provider。

产品功能已有实际插件入口；完整的 manifest schema、版本协商、第三方包安装、Worker/iframe 隔离、在线插件目录和原生 sidecar 均未实现。当前运行边界是内置或开发者显式注册的可信代码，不能把这版作为不可信 JavaScript 插件的沙箱。

扩展方式：实现 `Plugin` 并在入口注册，用 `ctx.provide()` 提供服务，`requires` 声明依赖，`ctx.own()` 追踪资源。替换 renderer 时提供相同的 `renderer@1` 服务，并移除默认 renderer provider。不能同时注册两个相同服务。

Kernel、SDK 和插件代码分布：`src/kernel/`、`src/sdk/`、`src/plugins/`。Rust platform broker 位于 `src-tauri/src/`，只接收来自对应控制窗口的命令；overlay 只有自身拖动、内容高度调整及消息权限。

## 歌词与时间

普通文本静态展示；逐行歌词切换当前行；逐字歌词显示未激活字色并按字词时段填充。纯文本内容通过 textContent 渲染。背景声与前景声重叠时优先显示活动的前景行，本版不同时铺开多个声部。

支持常见 LRC/Enhanced LRC、AMLL 结构化歌词与媒体绝对时间的常用 TTML。完整 TTML 布局、seq、frame/tick 时间不是这版的范围，遇到不支持的时间模式会明确拒绝。XML 不允许 DTD/entity，文本/行数/字数/层级有预算。导入失败保留当前播放来源。

AMLL 有效进度作为锚点；明确恢复后逐帧插值，暂停停止，缺少播放状态不自动假定已播放。长达五秒没有新进度时停止继续外推。播放源切换保留各自的曲目/歌词/位置快照，多个连接单独缓存，主连接断开清空或切换到已有连接的快照。

跨 WebView 用事件分发原始采样和采样年龄，换算为各自 performance.now() 时钟域；同机消息延迟用系统时钟作保守补偿，并限制异常跳变。仍不构成对发送端/声卡/显示链路同步精度的保证。

## 原生窗口与接入

Overlay 初始隐藏，透明、无边框、默认置顶；开启后可拖动，内容变化时保持宽度并调整高度到显示器范围。穿透启用后可在主窗口关闭，主窗口退出会结束整个应用和服务。

原生服务只监听 `127.0.0.1`，最多四个连接。V1 根据首个二进制消息协商；V2 需要 initialize 文本首帧；连接协商后不按每帧猜版本。进度、曲目信息、歌词、暂停/恢复映射到统一模型。PCM/封面消息不会进入基础 renderer。当前客户端控制按钮只控制本地演示，AMLL 接入是只读。

消息体限制为 2 MiB，握手/首帧及写入有超时，消息频率有限制，停止服务会关闭所有客户端并释放端口。来源规则允许明确的本机/官方页面及网易云原生 `orpheus://orpheus`，拒绝任意网页来源。没有 Origin 的原生客户端可连接，Origin 检查不代表本机客户端认证。开发者可通过 amll_start 的 allowedOrigins 提供其他准确来源，尚无该项设置 UI。

## 自动与原生检查

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/smoke-browser.mjs
```

浏览器 smoke 需要已安装 Edge 和正在运行的 `npm run dev`。覆盖 CSS 颜色/渐变/字体、自动保存、纯文本/逐行/逐字显示、跨窗口同步、透明背景、歌词 HTML 注入边界及最小桌面宽度。

`scripts/smoke-desktop.mjs` 通过本机 WebView2 CDP 验证原生控制窗口和 overlay，包含 V1/V2 真实 loopback socket 到界面的全链路、来源切换缓存、断线重置及 native show/top/clickthrough 调用。通过 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 指定调试端口后启动 exe；脚本默认 CDP 地址 127.0.0.1:9227，测试完成关闭服务和 overlay。其发送端是协议 fixture，不能等同于真实音乐客户端验收。

本次前端 26 项测试、Rust 8 项测试及浏览器/原生 fixture smoke 已通过。最终 release 已与用户正在运行的网易云 AMLL WS Connector 实际联通：自动重连成功，接收到了曲目信息、歌词与播放进度；监听地址为 ws://localhost:11444，来源为 orpheus://orpheus。未将用户歌曲正文或完整消息记录写入仓库。

尚未验证：多显示器不同 DPI、独占全屏、实物声卡/显示器音画延迟、其他音乐客户端、SMTC、长期资源稳定性、无 WebView2 环境，以及未签名安装包的完整安装/升级流程。
