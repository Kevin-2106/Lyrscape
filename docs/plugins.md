# 插件管理与动画 renderer

2026-10-13。此页记录当前实现；完整第三方 manifest、包安装和隔离仍是目标架构。

## 使用

点击窗口顶部「插件与配置」进入管理区域。可按分类或名称 / ID 筛选，查看运行状态、服务和依赖，展开「配置与依赖」调整插件的独立参数。所有配置在当前设备自动保存；预览与 overlay 共用渲染器选择和配置。

默认仍为「普通文字」。在「Aurora · 流光」卡片点击「使用此渲染器」，即可启用动画歌词。AMLL 接入与 renderer 独立，切换视觉不会停止播放器连接或改变歌词时间。

另有八个独立 canvas renderer：糖果波普、情书、水底挽歌、吸血鬼、合成谱、晴空终端、晴空终端 II 七种 PV 风格，以及仿 AMLL 的 Apple Music 风格滚动列表。运动按共享歌词时间采样，暂停停住、seek 直接定位；独立配置与边界见 [PV 说明](pv-renderers.md)。

Aurora 提供三种进入方式：彗星飞入、旋转落位、棱镜展开。可调进入时长、字间视觉延迟、幅度、光晕、星芒和动画开关。逐字填充始终使用来源的真实时间；进入延迟与这些时间互不替代。无时间轴文本只做视觉进入，不生成字时间。动画按行 / 文档 / 动画配置变更触发；每秒同步、播放进度和同一行内 seek 不重新触发。系统减少动态效果时停用运动。

逐行歌词没有真实逐字数据时，也保持整行固定颜色；进入动画按 grapheme 字符切分。星星为独立的 3.6–5 秒缓慢闪烁循环，错开相位，不随歌词行或进入配置重建 / 飞入；减少动态效果时保持静态。

最多 96 个字词单元分别执行进入动画，视觉延迟上限 700ms，星芒固定为 8 个；长歌词退为整块进入。无时间轴文本按 Unicode grapheme 切分，保留 emoji 组合。正文通过 textContent 创建，不执行歌词中的 HTML。不同动画阶段不改变布局高度，避免 overlay 反复调整尺寸。

## 分类与运行边界

分类表示贡献能力，不是强制继承的类层次。所有插件仍实现同一个 `Plugin.activate(ctx)`，通过带版本的服务 ID 组合。

| 当前分类 | 内置插件 | 可操作范围 |
| --- | --- | --- |
| 播放接入 | 本地演示、AMLL | AMLL 可启停，端口可配置；本地演示为基础组合 |
| 歌词解析 | 基础解析 | 基础组合；支持 LRC / Enhanced LRC / 常用 TTML / 纯文本 |
| 时间轴 | 共享时间轴 | 基础组合 |
| 歌词渲染 | 普通文字、Aurora、三个 PV 风格 | 选择 renderer；动画 renderer 可独立启停与配置，普通文字保留回退 |
| 主题 | 基础文字主题 | 基础组合；字体和颜色使用右侧面板 |
| 特效 | 暂无独立 effect | Aurora 的内建效果属于 renderer，尚未实现通用 effect 插槽 |
| 桌面视图 | 透明 overlay | 基础组合；窗口操作使用右侧面板 |
| 设置与管理 | 控制面板（应用外壳）、插件管理、渲染器选择 | 基础组合 |

歌词来源、歌词 transform、可视化和命令贡献点保留在架构提案中，尚无实现。未来一个包可以声明多个贡献点；当前注册表每个运行入口标注一个主要分类。

「基础组合」按钮锁定只是当前产品组合的保护规则，不表示这些功能未来不可替换。AMLL 停用前先切回演示，再等待原生服务停止，然后释放监听与服务注册；重新启用只恢复 adapter，不自动开启端口。已选 Aurora 停用时释放其 view scope 并回退普通文字。依赖仍在使用的 provider 不可单独停用。

关闭鼠标穿透后，overlay 左右边缘有悬停显示的拖拽把手，用来调整宽度；中间仍负责移动窗口。长行和很长的单个真实时间片段会换行，高度使用布局尺寸自适应，避免进入动画影响窗口尺寸。窗口宽度目前只在运行期间保持，尚无独立的布局持久化配置。

## 开发接口

- `src/sdk/types.ts`：`PluginInfo`、`PluginManifest`、`ConfigField`、`PluginPreferences`、`PluginManagement`（含 `rescan`）。配置 schema 为 number / select / boolean，由 `registry.ts` 的 `validateManifest` 校验，不是完整 JSON Schema。
- `src/plugins/manifests.ts`（纯数据目录）、`catalog.ts`（工厂）、`registry.ts`（每个窗口的运行期注册表）；重新扫描见 [手动插件热重载](manual-plugin-reload.md)。
- `src/plugins/management.ts`：配置归一化、启停队列、错误记录、选择服务。配置只保留声明的字段并限制数值范围；失败不保存新启用状态。
- `src/kernel/host.ts`：生命周期、服务归属查询及带依赖检查的 deactivate；启用复用已有激活与回滚机制。
- `src/plugins/renderer.ts`：公开 DOM renderer 构造 hooks 和 mount scope 管理；普通 renderer 与 Aurora 共享文本 / 时间填充能力。Aurora 通过构造 hooks 获取自己的节点，不修改另一插件的私有 DOM。
- renderer 独立提供 `renderer.text@1` / `renderer.aurora@1`，选择插件提供 `renderer@1`。surface 与设置 UI 仅依赖选择后的 renderer 服务。
- `src/ui/plugin-manager.ts`（挂在「插件」页）：独立管理 UI，用 `PluginManagement` 和状态订阅调用功能。

持久化使用 `lyrscape.plugins.v1`，与已有 `lyrscape.settings.v1` 分开。旧设置无需迁移；损坏或未知的 renderer 配置恢复为普通文字。启动失败的恢复按钮同时清除两份设置。第三方安装、卸载包、版本协商、权限声明和执行隔离未实现，不能用这个管理界面运行不可信代码。

## 验证

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/smoke-browser.mjs
node scripts/smoke-plugins.mjs
```

浏览器检查要求 `npm run dev` 和本机 Edge。插件 smoke 验证分类 / 搜索、三种动画实际 transform、逐字填充、配置保存 / 重置、renderer 停用回退、AMLL 启停、跨窗口配置同步、周期快照不重播动画、减少动态效果与 860 / 390px 布局；截图位于未提交的 `qa/`。

`scripts/smoke-plugins.mjs` 设置 `LYRSCAPE_CDP` 后也支持 release WebView2。应以隔离的 `WEBVIEW2_USER_DATA_FOLDER` 和独立 CDP 端口启动测试实例；该脚本会切换配置并停用测试实例的 AMLL，不能用于用户正在听歌的实例。原生协议 fixture 使用 `scripts/smoke-desktop.mjs` 的 11445 端口，保留实际 Connector 的 11444。

## 本轮验证记录

2026-10-13，Windows 本机：

- 接管时 `main` 工作区干净；HEAD 和远端 main 均为 `81d3fe1`，GitHub 查询确认 private。本轮源码改动留在工作区，未提交或推送。
- `npm run build`、`npm run desktop:build` 通过；前端 37 项、Rust 8 项测试通过。新增覆盖启用失败回滚、依赖保护、配置归一化 / 保留 / 重置、并发启停、真实字进度、文字注入边界、长歌词动画预算和 provider 停用的 view 清理。
- Edge 原有 smoke 与插件 smoke 通过。实际检查三种 CSS 动画 transform、配置持久化、系统减少动态效果、860 / 390px 无横向溢出，以及周期同步不重建字节点。`qa/plugins-*.png` 为实际截图，已查看排版。
- 独立 release WebView2（CDP 9228、独立数据目录）通过原有原生 V1 / V2 fixture 和插件 smoke；窗口置顶 / 穿透、透明 overlay、配置同步、renderer 回退均通过。已连接的 11445 fixture 在切换 renderer 后保持连接；停用 AMLL 后客户端关闭、broker.running 为 false，并切回 demo。测试实例已关闭。
- 接管时 11444 属于既有实例；开发期间未向该实例发送停止或配置命令。收尾检查发现原实例、11444 和 CDP 9227 均已退出，原因未确认。确认端口空闲后启动新 `builds/Lyrscape.exe` 并恢复 11444；真实网易云 Connector 自动重连，已确认曲目元数据、歌词和播放位置，UI 无错误。只读检查只输出状态 / 字数，不记录用户曲名和歌词正文。
- 保留 `builds/Lyrscape-baseline-81d3fe1.exe`，更新 `builds/Lyrscape.exe`。新 exe 与 Rust release 产物 SHA-256 一致：

```text
853BAB85AAEBAA02F75175B9D593731273D4D278C28721027DCF6592D9DD55BA
```

依赖安装和首次本机工具运行在受限 Windows 沙箱中遇到 npm exit-handler / realpath EPERM / proc-macro 编译限制；使用正常本机权限后上述检查均通过。构建产物、依赖、测试 profile 和截图均由现有 gitignore 排除。多 DPI、多显示器、独占全屏、长期资源稳定性和其他真实客户端未重新验证。
