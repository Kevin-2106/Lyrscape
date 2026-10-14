# 手动插件热重载与插件列表重新扫描

2026-10-13。开发源码与桌面版本地 JS 两条路径已实现。当前开放 Aurora、三个 PV renderer 和 AMLL adapter；基础管理、恢复入口和原生 Rust 模块不通过此入口替换。

## 使用

在「插件」页找到对应卡片，先启用插件，选择重载来源，再点「热重载」。选择的 renderer、配置与歌词状态保持；AMLL 接入重载会关闭旧连接并重新监听原端口，发送端需要重连、重新提供状态。

| 运行方式 | 重载来源 | 修改位置 |
| --- | --- | --- |
| `npm run dev` / `npm run desktop:dev` | 当前开发源码 | `src/plugins/` 下对应 TS、依赖与 CSS |
| 独立 exe | 本地插件文件 | exe 旁 `plugins/<插件 ID>.mjs` 和可选的同名 `.css` |
| 独立 exe | 内置版本 | 重新激活该 exe 编译时的内置实现，用于回到基线 |

开发模式保存插件文件后会提示“源码已修改”，不会自动刷新页面或立即应用新样式。点击按钮时通过 esbuild 从当前文件重新打包该插件及其依赖，随后加载新实现。Vite 中间件只存在于开发服务器，发布版不需要 Node、Vite 或 esbuild。

桌面版本可直接修改 `.mjs` / `.css`，保存后点「本地插件文件 → 热重载」，无需重新构建 exe。普通浏览器预览不读取本机 exe 目录；其本地文件选项不可用。

## 重新扫描插件列表

「插件」页工具栏的「重新扫描插件列表」在不刷新页面的情况下更新**列表本身**：

| 运行方式 | 扫描的目录 | 结果 |
| --- | --- | --- |
| `npm run dev` | 源码目录 `src/plugins/manifests.ts`（经 `/__lyrscape/plugin-catalog`） | 新 ID 注册并激活；已有插件的名称 / 说明 / 版本 / 配置项更新；源码中删除的可选插件停用并移除 |
| 独立 exe | exe 旁 `plugins/*.mjs`（Rust `plugin_catalog`） | 文件名对应的新 ID 注册并激活；之前由该目录新增、文件已删除的插件移除；已有 ID 不变，改代码仍用「热重载」 |
| 浏览器预览（非开发） | 无 | 按钮隐藏 |

- 新增插件的模块必须导出 `manifest`（见下方契约），并且只能是 `renderer` 或 `effect`；ID 与已注册插件或 rendererService 冲突、manifest 无效、激活失败、桌面歌词未确认都会单独列为失败，不影响其他插件，半途失败的新增会在两个窗口中回滚。
- 新增渲染器同时在桌面歌词中准备 / 提交（与热重载相同的两阶段消息）；之后打开的 overlay 会同步收到；控制面板重新加载时会让 overlay 丢弃运行期新增的插件，两边从同一份列表重新开始。
- 设置：新插件默认启用；之前保存过的启停与配置会被采用。应用重启后运行期新增的插件不会自动加载（与「重启后先用内置版本」一致），但其配置保留，再次扫描即可恢复；当时选中的渲染器回退为普通文字。
- 删除：正在使用的渲染器被移除时回退普通文字；仍被其他插件依赖的插件不会被移除并报告原因。
- 目前没有沙箱：本地插件与应用同权限运行，只放入自己信任的文件。

验证：`node scripts/smoke-catalog.mjs`（开发服务器 1420；拦截目录接口新增 / 改说明 / 移除一个自写测试渲染器，检查两个窗口、迟开的 overlay、控制面板重载后的重置与配置保留），以及 `tests/catalog.test.ts`。exe 旁目录扫描只有 Rust 单元测试（`plugin_catalog` 过滤与排序），尚未在原生实例中端到端验证。

## 生成可编辑文件

从 TS 源码生成桌面插件：

```powershell
npm run plugins:build
```

默认输出到仓库 `builds/plugins/`，供放在 `builds/` 的 exe 使用。**默认保留已有文件**，防止覆盖手动修改。明确需要重新生成已有文件时：

```powershell
npm run plugins:build -- --overwrite
```

输出到其他 exe 所在目录的示例：

```powershell
npm run plugins:build -- --out-dir=builds/hot-reload/plugins
```

可直接编辑源码输出的 JS，也可以使用自包含的 [示例模块](../examples/editable-aurora.mjs)。示例占用已注册的 Aurora 插件 ID；不要直接覆盖自己的文件，先另存备份。部署时需要把 exe 和同目录的 `plugins` 文件夹一起复制。

`plugins:build` 为 `src/plugins/manifests.ts` 目录中的每个插件生成 `plugins/<插件 ID>.mjs`（当前 10 个：Aurora、7 个 PV / Apple Music 风格渲染器、AMLL 连接、节拍检测），每个文件都带 `manifest`，约 210 KB（包含整个内置目录）。因此旧 exe 旁放入较新源码生成的文件，例如旧版本没有的 `official.renderer.pv-halo.mjs`，点「重新扫描插件列表」即可加入。`official.audio.beat` 在主窗口与 overlay 同时重载，见 [节拍检测](beat-detection.md)。

本地文件 ID 须为点分小写名（`[a-z0-9-]`，2–6 段，例如 `local.renderer.my-style`），文件名即 ID。

## 模块契约

`.mjs` 默认导出一个 `Plugin`，或导出返回 `Plugin` 的工厂（工厂可收到当前窗口的 `Store<AppState>`）。必须保留对应 ID、`activate(ctx)` 和已有服务 ID。`requires` 如有填写必须是字符串数组。

可选的命名导出 `manifest` 描述卡片与配置：`{ id, name, description, category, version?, rendererService?, fields?, surfaces? }`。新增插件必须提供；热重载已注册插件时如提供，名称 / 说明 / 版本 / 配置项随代码一起更新（`rendererService` 不能在运行中改名）。

```js
export default {
  id: 'official.renderer.aurora',
  activate(ctx) {
    // 提供 renderer.aurora@1，所有 mount/timer/listener 都登记到 ctx.own。
  },
};
```

模块必须自包含。当前构建工具会把代码依赖合并进一个 ESM 文件，CSS 单独输出；字体沿用宿主已加载的本地字体。手写模块不要保留 npm 裸包导入或相对 JS 导入；宿主通过 Blob 模块 URL 加载，无法把它们当成本地目录依赖解析。

资源在 `activate` / `mount` 中创建，并用 `ctx.own` 登记。清理可以返回 Promise，热重载会等待清理完成；renderer 的 dispose 必须可重复调用。不要在模块顶层创建定时器、修改 DOM 或打开连接：模块导入发生在旧版仍运行的准备阶段，宿主不能撤销未登记的顶层副作用。

插件列表、名称 / 说明与配置 schema 通过「重新扫描插件列表」或带 manifest 的热重载更新。仍需重启 / 重新构建的：基础组合插件、新增非 renderer / effect 类别、修改 rendererService、原生 Rust / 权限配置。对已有依赖消费者的 provider，宿主会阻止单独替换，防止消费者继续持有旧服务。

## 加载、同步和恢复

加载流程：先读取/构建新代码并检查模块接口；渲染器还会在 overlay 中准备同一份模块。准备成功后按 scope 逆序释放旧资源，激活新版，并确认原有服务仍存在。两窗口均提交成功才记录这次重载；任一窗口激活失败，会尝试恢复两边上一份工作定义。语法/构建/读取错误发生在旧版停用前，因此旧版保持工作。

Renderer 选择服务观察实际服务对象的变化，同一个 service ID 被替换也会重新 mount；旧 renderer 的全部已登记 mount 会释放。预览只在歌词或样式页显示时挂载，因此在插件页点击后，回到预览页才能看到预览内容。Overlay 则可持续更新。

Overlay 刷新后会请求主窗口缓存的已提交模块，重新恢复该版本。缓存仅在当前进程运行期间保留；重启 exe 后先用内置版本，再由用户手动应用本地文件。插件配置继续使用原有存储，不写入代码缓存。

管理服务把启停和重载放入同一个串行队列，界面显示忙碌状态。旧 scope 的迟到 `provide` / `service` 调用会拒绝，防止旧实例覆盖新实例。窗口无响应或资源无法释放时会显示具体错误；无法保证操作系统拒绝释放资源时仍能完成恢复。

## 信任与限制

本地插件是当前用户主动加载的可信代码，具有与内置插件相同的执行权限；这不是隔离运行、签名验证或第三方安装器。Rust 读取端仅接受上述 ID，只允许读取当前 exe 的 `plugins` 目录；目录/文件链接不能逃逸到该范围之外。JS 上限 2 MiB、CSS 上限 512 KiB，内容必须为 UTF-8。

Blob 模块加载由 CSP 显式允许；没有增加 `unsafe-eval`。ES 模块实例由浏览器缓存，撤销 Blob URL 不等于卸载 JS 引擎的模块代码；频繁进行大量版本调试后，可以重启测试实例释放这部分缓存。宿主负责清理登记的运行资源，不能保证移除插件任意产生的全局副作用。

## 验证

- 58 项前端测试通过，覆盖逆序异步清理、旧 scope 拒绝迟到调用、激活/服务不兼容失败恢复、依赖保护、串行重载与配置保留。
- 14 项 Rust 测试通过，包含未注册 ID / 路径拒绝、读取大小预算和 UTF-8 校验。
- Edge 开发模式实际修改并恢复 Aurora TS/CSS：保存不刷新页面、按钮应用新实现、两窗口与 CSS 更新、overlay 刷新恢复、语法错误保留旧版、仅 overlay 激活失败时两窗口回滚，通过。
- 独立 release WebView2（CDP 9230、独立数据目录、独立插件副本）验证同一组本地 JS/CSS 行为，通过；AMLL 本地插件重载关闭旧客户端，恢复 11445 监听，并接收新客户端曲目，通过。
- 使用交付目录中新生成的插件副本，三个 PV renderer 的本地重载及双窗口 canvas 挂载均通过。
- 插件管理浏览器回归通过。原实例与其文件未被测试重载；测试对源码与插件副本的临时改动均恢复。

测试脚本：`scripts/smoke-manual-reload.mjs`。浏览器模式测试源码；设置 `LYRSCAPE_CDP` 后测试独立 exe 的插件副本。请勿对正在使用的实例执行该 fixture，它会重载插件并在 11445 建立模拟连接。

实现依据：[Vite Plugin API](https://vite.dev/guide/api-plugin.html)与 [esbuild Build API](https://esbuild.github.io/api/#build)。具体行为以当前仓库的 Vite 7 与 esbuild 锁文件版本及上述验证为准。

交付目录：`builds/hot-reload/`，包含 `Lyrscape.exe` 和五组 `plugins/*.mjs` / `.css`。exe 与 Rust release 产物 SHA-256 一致：`BFB7FD5570A5231D92F77725C7135CF3AB549CE3637713A2A4DB93224DA0DCBC`。本轮开发服务器和独立测试实例已关闭；原实例与历史 exe 保留。
