# 本地开发与验证

适用当前源码，2026-10-13。Windows 优先，Tauri 2 + WebView2 + TypeScript，未引入 UI 框架。

## 从零运行

安装 Node.js 20.19+ / 22.12+、Rust 1.90+、Visual Studio C++ Build Tools 和 WebView2 Runtime。安装依赖使用 lockfile：

```powershell
npm ci
npm run dev
```

浏览器入口为 `http://127.0.0.1:1420`。它支持演示、歌词导入、视觉设置、插件管理、BroadcastChannel overlay 预览；没有 native WS 接收服务或真实置顶 / 穿透 / 调整窗口大小。

桌面开发：停止已有 Vite 后运行 `npm run desktop:dev`。先检查 11444 的归属，再在 UI 启动 AMLL；新开发实例不要抢占正在听歌的 release。

## 找到代码

| 路径 | 当前职责 |
| --- | --- |
| `src/main.ts` | controller / overlay 两种启动组合、注册表、状态、命令与跨窗口发布 |
| `src/sdk/types.ts` | 当前统一歌词 / 播放 / 配置 / renderer / 管理接口 |
| `src/kernel/host.ts` | 依赖排序、服务注册、scope、激活回滚与停用依赖保护 |
| `src/kernel/store.ts` | 同步快照订阅；更新时保留未变化歌词的对象身份 |
| `src/plugins/management.ts` | 管理功能、配置 schema、持久化归一化与 renderer 选择 |
| `src/plugins/renderer.ts` | 普通文字、DOM renderer hooks、逐字填充和 view scope |
| `src/plugins/aurora.*` | Aurora 进入动画；清晰前景与光晕后景分层，渐变由实际 glyph 层绘制 |
| `src/plugins/pv*` | 三个独立文字 PV renderer，共用行边界、绝对时间相位和字符预算 |
| `src/plugins/amll.ts` / `parsers.ts` / `timeline.ts` | adapter / 格式解析 / 时间采样策略 |
| `src/plugins/surface.ts` | overlay 挂载、状态接收、拖动、左右 resize 把手与高度适配 |
| `src/ui/` | 控制窗口：应用外壳 `shell.ts`（侧栏、哈希路由、常驻播放栏、Toast、快捷键）、`pages/`（播放›歌词 / 插件›渲染器、特效、全部插件 / 应用›设置）、`components/`、`kit/`（DOM、字段、Toast、对话框）、`styles/` |
| `src/platform.ts` | 浏览器 / Tauri 的窄能力封装 |
| `src-tauri/src/` | WebSocket broker / codec、窗口和来源检查 |
| `src-tauri/capabilities/` | 各窗口的原生命令权限；overlay 仅开放所需能力 |

## 时间与文本约束

`LyricDocument.timingMode` 为 `none / line / word`。只有来源确实提供细分 `words[].startMs / endMs` 时才填充字词进度。一个覆盖整行的多字符时间片段按逐行显示，不扫动整行进度；单个 grapheme 自带明确时长仍可显示该字进度。没有真实逐字时间的 LRC、TTML 段落或纯文本保持整行固定颜色；Aurora 的字符进入顺序只是视觉，不产生时间戳。组合 emoji 用 Unicode grapheme 切分。

时间采样来自 timeline 服务，renderer 自己 requestAnimationFrame 采样，不逐帧广播跨窗口事件。overlay 接收原始采样并换算各自单调时钟域；未变化歌词保持对象身份，避免每秒同步重播动画。

长字词片段允许换行，base 与 fill 保持相同排版。overlay 最小宽度 320，关闭穿透后拖左右把手调整宽度；宽度变化触发内容排版和高度适配。高度根据 layout border box 计算，不能使用动画会改变的 scrollHeight。原生高度仍受显示器高度限制。

## 检查与产物

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
# 需要先启动 npm run dev，且本机安装 Edge
node scripts/smoke-browser.mjs
node scripts/smoke-plugins.mjs
node scripts/smoke-overlay-layout.mjs
node scripts/smoke-pv.mjs
node scripts/smoke-debug.mjs          # 调试页；设置 LYRSCAPE_CDP 时另测 AMLL 原始消息
npm run desktop:build
# 安装包 → 导入插件 → 升级 → 卸载的端到端检查（见 docs/release.md）
npm run desktop:package; node scripts/smoke-install.mjs
```

插件目录：exe 旁有 `plugins\` 时使用它（`builds\Lyrscape.exe` 与 `npm run plugins:build` 生成的 `builds\plugins\` 正是这种情况），否则使用 `%LOCALAPPDATA%\io.github.kevin2106.lyrscape\plugins\`；隔离实例可用 `LYRSCAPE_DATA_DIR` 指定。

`src-tauri/target/release/lyrscape.exe` 是 release 产物；`builds/Lyrscape.exe` 是交付副本，**构建不会自动复制**。运行中的 exe 可能被 Windows 锁定；先保存配置 / 布局，确认进程路径，保留旧 exe，再替换。不要直接关闭未知 PID。原生更新后必须重新启动进程，reload WebView 不能更新已编入 exe 的资源。

PowerShell 的非终止错误可能让脚本在复制失败后继续启动旧 exe。更新步骤使用 `$ErrorActionPreference = 'Stop'`，等待目标进程完全退出，对短暂文件锁做有界重试；确认交付副本与 release 的 SHA-256 相同后再启动。`save-app-session.mjs / restore-app-session.mjs / restore-overlay-geometry.ps1` 可显式保存 / 恢复用户设置、连接状态和布局；保存文件在 `qa/`，不包含曲目或歌词。这些脚本会操作指定实例，先核实 CDP 与 PID，不作为自动启动逻辑。

浏览器检查不能替代原生检查。原生 fixture 使用 11445，用户 Connector 默认 11444；CDP 建议测试实例用 9228，正常实例通常 9227。`WEBVIEW2_USER_DATA_FOLDER` 指向新的、未提交的 `qa/` 子目录，防止 smoke 修改用户设置。开启 CDP 仅用于本机调试，不是发布功能。

源码与 lockfile 提交；`node_modules/`、`dist/`、`src-tauri/target/`、`builds/`、`qa/` 不提交。原生 / 浏览器截图在 `qa/`，不要记录用户歌词或完整协议 payload。

## 透明窗口排查

先用自产 fixture 排除私人歌词，再比较 preview / overlay，确认 DOM 是否只有一份。然后分别关闭 filter、3D transform 和 glow，**逐项**对照，不全局禁用 GPU 当作默认修复。

本轮真实桌面复现显示，包含逐字渐变、祖先 background-clip:text 遮罩与动态变换的路径会出现左上角额外字形。只关闭 filter 的首次新进程检查仍失败；最终移除重复的祖先渐变遮罩，让实际 glyph / fill 层各自绘制渐变。overlay 同时改为 text-shadow 和动画单元 filter:none，继续保留 transform。不要重新引入重复遮罩或 filter 而只检查 CDP PNG。

渐变文字的字色是透明的，直接在其背景裁剪元素上加 text-shadow 会让阴影覆在渐变背景前。Aurora 使用独立 `aurora-glow-layer`（z-index 0）和 `aurora-solid`（z-index 1），前景不带阴影，只有前景绘制渐变；逐字 clip-path 保留在 word-fill 容器上。后景文字通过 aria-hidden 空节点的 CSS content 绘制，不重复正文 textContent。`smoke-glow-layer.mjs` 和 `check-glow-pixels.ps1` 对比光晕开关前后截图，检查不透明字面像素不变。

`scripts/prepare-overlay-fixture.mjs` 只适用于隔离实例：它将控制窗变为纯色测试背景，并循环演示自产歌词。`scripts/capture-overlay-screen.ps1` 只保存完全位于该背景内的 overlay 矩形，拒绝超界截图；`scripts/analyze-overlay-frames.ps1` 检查 fixture 保留角落的紫色异常像素。它是该 fixture 的检查，不是通用图像正确性证明。

```powershell
# 隔离 release 已用 CDP 9228 启动后
node scripts/prepare-overlay-fixture.mjs
./scripts/capture-overlay-screen.ps1 -AppProcessId <测试PID> -OutputDirectory qa/overlay-frames
./scripts/analyze-overlay-frames.ps1 -Directory qa/overlay-frames -FailOnContamination
```

相关上游报告：[WebView2 表面截图与屏幕呈现不一致](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5574)。该报告的触发条件是 video，不能据此认定与本项目是同一个底层 bug；它说明为什么还需 OS 屏幕检查。项目的具体依据是本机 fixture 对照。


## 控制窗口 UI 结构

- `ui/context.ts`：`UiContext`（状态与命令的唯一入口）、`PageDefinition`、`UiServices`。页面不直接碰 store 或 host。
- 新增页面：在 `ui/pages/` 写一个 `PageDefinition`（`group` 是侧栏一级菜单），加入 `ui/pages/index.ts`；顺序即侧栏顺序和 `Ctrl+N` 映射。某类插件需要日常交互时给它单开一个页面，否则留在「全部插件」。`navigate(id, target)` 可让页面显示某个部分（检查器页签、插件、分组、导入）。
- 页面常驻 DOM、仅隐藏；`render(state)` 只对当前页调用，激活时先补一次渲染。渲染器预览放在 `activate()` / `deactivate()` 中挂载与释放，所以隐藏页不占资源，也意味着自动化脚本要先切到对应页面再断言预览（见 `scripts/lib/nav.mjs`）。
- 路由是 `#/页面id`，并在本地记住上次页面；旧页面名（lyrics 之外的 style / overlay / about）会映射到新页面。快捷键见 `ui/shortcuts.ts` 与设置页。
- 「全部插件」把整个页面作为插件文件的拖放区（`.lyrx` / `.mjs`），与歌词导入卡片的拖放互不冲突。
- 控制窗口关闭了 Tauri 的原生文件拖放（`dragDropEnabled: false`），歌词文件拖入导入卡片走网页 DnD。
