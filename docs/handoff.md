# 交接与后续开发清单

2026-10-13。先读 `README.md / CONTRIBUTING.md`，再读 `development.md / plugin-development.md`。实际功能及边界见 `baseline.md / plugins.md`，目标设计见 `architecture.md / roadmap.md`。

2026-10-16 补充：第二轮常驻内存优化与最终交付见 [按需窗口及字体子集](memory-footprint.md)。overlay 不再开机创建，状态/穿透/边框可在创建前使用；隔离 smoke 需要窗口时调用 `showNativeOverlay`。保持本地插件文件，旧 bundle 有字体兼容路径，重建后才获得完整按需收益。最终前端 96 / Rust 16 项测试及原生验证通过，默认 exe 已更新，原 exe 保留。

## 先核实，不覆盖

2026-10-16 托盘行为：此前工作区成果已提交为 `dbaab72`；新增关闭到托盘、销毁主窗口和会话恢复，见 [托盘生命周期](tray-lifecycle.md)。最终前端 98 / Rust 19 项测试及原生托盘、旧 AMLL 插件、PCM、恢复和重置回归通过，默认 exe 已更新并保留旧版。测试必须使用独立 profile 和端口，不能把用户主窗口关闭操作用作 smoke。

```powershell
git status --short --branch
git log -5 --oneline
git remote -v
git ls-remote origin refs/heads/main
gh repo view Kevin-2106/Lyrscape --json isPrivate,defaultBranchRef
Get-NetTCPConnection -LocalPort 11444 -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name = 'lyrscape.exe'" |
  Select-Object ProcessId,ExecutablePath
```

历史基线为 `81d3fe1`；本轮开始前的插件 UI、插件包及内存优化已归入 `dbaab72`。当前提交与修改情况仍以 git log / status 为准。不要 reset 或覆盖他人修改，不自动公开仓库，不把未提交的 exe 当作该 commit 的产物。

## 运行中的用户实例

用户使用网易云 AMLL WS Connector，`ws://localhost:11444`，自动连接。Origin 为 `orpheus://orpheus`，broker 精确允许。默认只绑定 `127.0.0.1`；没有 Origin 的 native 客户端可连接，Origin 检查不等于本机客户端认证。

先查端口归属和 exe 路径。做 fixture 使用独立实例、11445、CDP 9228、新的 `qa/` WebView2 profile；不要对用户实例运行 smoke、`--start`、停止 adapter 或恢复默认配置。`scripts/live-status.mjs` 无参数只读，`--start` 会 reload 并切换到 AMLL / 启动服务。

需要更新实际应用时，先完成构建和隔离验证，保存用户文字 / 插件设置与 overlay 布局，保留旧 exe；只关闭身份已核实的目标进程，再复制新 exe 并恢复设置 / 接入。重连结果只能写是否收到元数据、歌词和进度，不保存歌曲正文或原始协议消息。

2026-10-13 内存修复已构建并更新 `builds/Lyrscape.exe`，旧版为 `builds/Lyrscape-before-memory-20261013.exe`。PCM 已改为二进制 Channel，状态同步只向 overlay 发送且进度使用增量消息，隐藏 overlay 卸载 renderer；详见 [内存验证记录](memory-optimization.md)。用户配置、页面、AMLL 连接和 overlay 几何已恢复并核验，哈希/自然采样在 `qa/memory/`。恢复脚本支持 `--input` / `--output` 独立快照；原生状态字段为 `clickThrough`。

## 已实现与仍待实现

- 已实现：可信插件 scope / 激活回滚 / 依赖停用保护、管理 UI、内置可选启停与配置、普通文字 / Aurora / 三个文字 PV renderer、基础 parser / timeline、透明窗口、AMLL V1 / V2 只读接入。
- 已实现（10-14）：运行期插件注册表（`src/plugins/registry.ts`）、内置目录（`manifests.ts` 纯数据 + `catalog.ts` 工厂）、manifest 校验与「重新扫描插件列表」（开发源码 / exe 旁 plugins 目录，双窗口两阶段同步），见 [手动插件热重载](manual-plugin-reload.md)。
- 不完整：来源切换和 adapter 选择仍是显式组合；第三方包安装、权限声明、版本协商、Worker / iframe 隔离、通用 effect 插槽未实现。
- 已实现 SMTC adapter 与在线歌词（[说明](smtc-adapter.md)）；尚未实现：外部播放器播放 / seek 控制。
- 仍需实机验证：多显示器 / 多 DPI、独占全屏、休眠恢复、长期资源稳定性、其他真实客户端。

## 本轮需求与验证入口

本轮包括：开发文档、overlay 左上角残影、无逐字数据不做猜测填充、长歌词自动换行、用户拖动左右边缘调整宽度、星星持续缓慢闪烁而不逐行跳出。

检查数量、失效尝试、屏幕帧结果及 exe hash 见 [Overlay 验证](overlay-validation.md) 与最新 [PV 验证和交付](pv-renderers.md)。当前最后验证为前端 46 项、Rust 8 项，最终 PV 有效屏幕采样 270 帧；仍须以新改动后的实际检查结果为准。

残影可在真实桌面复现，而 CDP 截图可能没有；移除重复的祖先渐变文字遮罩，overlay 的滤镜换成 text-shadow，保留 transform 进入动画。只关闭滤镜的第一次新进程检查仍失败，不能恢复为该不完整修复。回归记录应包括 OS 帧，不只记录 computed CSS。长歌词检查覆盖纯文本、逐行和很长的单个真实字词片段；resize 检查关闭穿透后原生拖拽，穿透时把手隐藏，中间仍负责拖动窗口。

脚本角色：

- `smoke-browser.mjs`：原有文字样式、解析显示、存储和窗口同步。
- `smoke-packages.mjs`：`.lyrx` 导入（篡改拒绝、确认、校验）→ 两窗口运行 → 重启自动加载并恢复选择 → 导出带配置 → 卸载回退。先运行 `npm run plugin:pack -- examples/plugins/wave/index.mjs`。
- `smoke-plugins.mjs`：分类 / 配置 / renderer 与 AMLL 启停（会改状态）。
- `smoke-overlay-layout.mjs`：长行 / 长字词换行、无假时间填充和 resize DOM。
- `smoke-pv.mjs`：三个 PV 插件的精确时间弹入 / 弹出、暂停、seek、持久化、回退和跨窗口同步。
- `render-pv-demo.mjs`：隔离浏览器的自产歌词时间采样演示，不是 OS 屏幕录像。
- `smoke-desktop.mjs`：原生窗口与 11445 V1 / V2 socket fixture。
- `prepare-overlay-fixture.mjs / capture-overlay-screen.ps1 / analyze-overlay-frames.ps1`：受控背景上的真实桌面帧检查。
- `probe-overlay-compositing.mjs`：诊断 CSS A/B，只用于测试实例，不属于生产 UI。
- `check-overlay-resize.ps1`：用实际鼠标输入拖动左右边缘，仅对明确指定的隔离实例操作，结束恢复鼠标位置。

记录每次改动实际跑过的测试数量、截图位置、产物 hash、运行实例和未测边界。Bark 只发送简短完成消息，不发送私有项目状态、commit、部署或用户曲目详情。
