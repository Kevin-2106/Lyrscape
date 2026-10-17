# Lyrscape 插件编写手册

2026-10-15。面向想给 Lyrscape 写渲染器或特效、并以 `.lyrx` 文件分发的作者。本手册只描述当前代码里真实可用的接口；宿主内部结构见 [plugin-development.md](plugin-development.md)。

> **信任边界**：插件代码与应用同权限运行，可以读取歌词、播放状态和设置，没有沙箱。只安装来自可信来源的插件；导入时应用会显示 ID、作者、大小和完整性校验结果并要求确认。

## 1. 五分钟上手

一个插件就是**一个 ES 模块**，导出两样东西：

```js
// my-plugin.mjs
export const manifest = {                // 描述：名称、类别、配置项
  id: 'me.renderer.hello',
  name: '你好渲染器',
  description: '最小示例：把当前行显示成大号文字。',
  category: 'renderer',
  version: '1.0.0',
  rendererService: 'renderer.me-hello@1',
};

export default {                         // 代码：Plugin 对象（或返回它的工厂函数）
  id: manifest.id,
  requires: ['sdk@1'],
  activate(ctx) {
    const sdk = ctx.service('sdk@1');
    ctx.provide(manifest.rendererService, sdk.ownRenderer(ctx, sdk.createDomRenderer()));
  },
};
```

打包并导入：

```powershell
npm run plugin:pack -- my-plugin.mjs          # → builds/packages/me.renderer.hello-1.0.0.lyrx
```

在 Lyrscape 中打开「插件 › 全部插件」→「导入插件」，选择 `.lyrx`，或者直接把文件拖进窗口，再确认安装。插件会立即在控制面板和桌面歌词两个窗口中运行，不需要重启。然后到「插件 › 渲染器」选用它。

完整示例见 `examples/plugins/wave/`（「示例 · 波浪浮现」：逐字浮起、可配置、带 CSS）。

## 2. 插件能做什么

| 类别 `category` | 可通过 `.lyrx` 安装 | 出现在 | 说明 |
| --- | --- | --- | --- |
| `renderer` | ✅ | 插件 › 渲染器 | 决定歌词长什么样。需要 `rendererService` |
| `effect` | ✅ | 插件 › 特效 | 叠加效果或分析服务（如节拍检测），供渲染器读取 |
| `playback-adapter`、`lyric-parser`、`timeline-provider`、`audio-provider`、`theme`、`surface`、`settings` | ❌ | 全部插件 | 需要宿主接线，目前只能随应用构建 |

导航按职责划分：日常要交互的类别（渲染器、特效）各有独立页面，其他插件集中在「全部插件」里管理。

## 3. manifest 字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | ✅ | 2–6 段点分小写，如 `author.renderer.name`。同时用作文件名，不能与内置插件重复 |
| `name` | ✅ | 1–60 字 |
| `description` | ✅ | 1–300 字，显示在列表和详情中 |
| `category` | ✅ | 见上表 |
| `version` | | 1–20 字，默认 `0.1.0`。建议语义化版本 |
| `rendererService` | 渲染器必填 | `renderer.<名字>@<主版本>`，全局唯一，运行中不能改名 |
| `fields` | | 配置项，最多 40 个，见下节 |
| `surfaces` | | `['control', 'overlay']` 的子集。渲染器和特效默认两个窗口都运行 |
| `author` / `license` | | 1–60 / 1–40 字 |
| `homepage` | | `https://` 链接 |
| `tags` | | 最多 8 个，每个 1–16 字，可用于搜索 |

manifest 会在打包时和导入时各校验一次（`src/plugins/registry.ts` 的 `validateManifest`），错误信息会指出具体字段。

### 配置项 `fields`

```js
fields: [
  { key: 'speed', label: '速度', type: 'number', default: 1, min: 0.2, max: 3, step: 0.1, description: '可选说明' },
  { key: 'glow', label: '光晕', type: 'boolean', default: true },
  { key: 'mode', label: '模式', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'ink', label: '文字', type: 'color', default: '#ffffff', group: '颜色' },
]
```

- 界面会自动生成：`number` 是滑块加精确输入框，`boolean` 是开关，`select` 是下拉菜单，`color` 是颜色选择器加 HEX 输入框（默认值必须是 `#rrggbb`，保存为小写）。
- `group`（可选，最多 8 个字）决定配置项出现在渲染器检查器的哪个页签；与「字体」「颜色」「显示」同名时会和共享文字设置合并到同一页。未设置时放在「选项」页。
- renderer 可在 manifest 顶层声明 `theme: ['font', 'color', 'nextLine']` 的子集，表示使用哪些共享文字设置；省略为全部，`[]` 表示只使用「显示」页（字号、背景、译文）。
- 读取方式：`state.plugins.configs[manifest.id]?.speed`。宿主保证值合法：数字会被夹在 min–max 范围内并对齐 step，选项一定在 options 里。
- 修改 `fields` 后重新导入即可。已保存的配置会按新的定义重新归一化，未知字段会被丢弃。

## 4. 代码：Plugin 与上下文

```ts
interface Plugin { id: string; requires?: string[]; activate(ctx): void | Promise<void> }
interface PluginContext {
  service<T>(id: string): T;     // 取用其他插件提供的服务（需在 requires 中声明）
  provide<T>(id: string, value: T): void;
  own(cleanup: () => unknown): void;  // 登记清理；停用、卸载、热重载时逆序执行
}
```

`export default` 可以是 Plugin 对象，也可以是 `(store) => Plugin` 工厂。它的 `id` 必须与 manifest 相同。

**资源规则**：定时器、事件监听、`requestAnimationFrame` 和插入的 DOM 都必须通过 `ctx.own` 或 mount 返回的 dispose 释放。插件会被停用、卸载和热重载，泄漏的资源会在两个窗口里累积。

### 可用服务

| 服务 | 提供者 | 内容 |
| --- | --- | --- |
| `sdk@1` | 宿主 | `createDomRenderer`、`ownRenderer`、`activeLine`、`hasGranularWordTiming`、`graphemes`、`apiVersion: 1` |
| `timeline@1` | 宿主 | `position(state)`：当前播放位置（毫秒），已插值 |
| `theme@1` | 宿主 | 文字主题默认值与归一化 |
| `audio.pcm@1` | 宿主 | 原始 PCM 帧，见 [音频与节拍](beat-detection.md) |
| `audio.beat@1` | 节拍检测插件（可停用） | `sample()` → `{ active, bpm, phase, pulse, level, confidence }` |

可选服务不要写进 `requires`，否则对方停用时你的插件会无法启动。改为在使用时 `try { ctx.service('audio.beat@1') } catch {}`。

## 5. 编写渲染器

渲染器服务实现：

```ts
interface Renderer { mount(root: HTMLElement, getState: () => AppState, timeline: Timeline): () => void }
```

`mount` 在预览和桌面歌词中各调用一次（两个窗口是独立的 JS 环境），每次都要返回自己的 dispose。

**推荐做法**：使用 `sdk.createDomRenderer(hooks)`。它负责当前行查找、真实的逐字填充进度、译文、下一行、字体（按歌词语言选择中文简体、繁体或日文字形）和文字主题，你只需要加上自己的表现：

| hook | 时机 |
| --- | --- |
| `mount(root)` | 初始化，返回清理函数 |
| `revision(state)` | 返回一个字符串；它变化时本行重建（例如把你的配置序列化后返回） |
| `line(root, lineElement, state)` | 每次换行或重建后。逐字歌词已拆成 `.lyric-word` |
| `frame(root, state, { position, index })` | 每帧，只做轻量操作 |

用 `sdk.ownRenderer(ctx, renderer)` 包装后再 `provide`，插件停用时会自动释放仍存活的 mount。

完全自绘（canvas、WebGL）也可以：自己实现 `mount`，在 `requestAnimationFrame` 中用 `timeline.position(getState())` 取时间。注意以下几点：

- **不能伪造逐字时间**：`timingMode !== 'word'` 时不要按字数平分行时长；按字符进入只是视觉效果。
- 按字拆分用 `sdk.graphemes(text)`，不要用 `split('')`，否则会拆坏 emoji 和组合字符。
- 歌词一律用 `textContent` 写入，不能拼进 `innerHTML`。
- 桌面歌词窗口是透明的：避免 CSS `filter: blur()` / `drop-shadow()`（WebView2 下会留下残影），用 `text-shadow`、`transform`、`opacity` 代替。
- 尊重 `matchMedia('(prefers-reduced-motion: reduce)')`。
- 长歌词要有预算，例如最多给前 96 个字单独做动画。

### 样式

与模块同名的 `.css`（如 `index.mjs` 旁的 `index.css`）会被打进包里。插件激活时注入，停用时移除。选择器请限定在你自己的类名下，例如 `.wave-lyric …`，不要影响其他渲染器。

## 6. 编写特效

特效插件用 `category: 'effect'`，通常 `provide` 一个服务供渲染器读取（参考内置的 `audio.beat@1`），并在「插件 › 特效」里显示开关和配置。效果是否生效取决于渲染器是否读取它，所以请在 `description` 中写明适用范围。

## 7. 打包、调试与发布

```powershell
npm run plugin:pack -- path/to/index.mjs              # 单文件或带 import 的入口都可以（esbuild 打成一个模块）
npm run plugin:pack -- path/to/index.ts --css a.css   # TypeScript 也可以；--css 指定额外样式
npm run plugin:pack -- official.renderer.aurora       # 把内置插件导出为包
```

- 输出位于 `builds/packages/<id>-<version>.lyrx`，打包时会按应用的规则校验。
- 迭代时可以直接把 `.mjs` 拖进「全部插件」：应用会先确认，再读取 manifest 并安装。正式分发请使用 `.lyrx`，它带有完整性校验。
- 桌面版把已安装的插件保存为 exe 旁 `plugins/<id>.mjs` 和 `<id>.css`（「打开插件文件夹」按钮可以直达）。直接编辑这些文件后，在插件详情里选择「本地插件文件」→「热重载」即可，不需要重新导入。浏览器预览版保存在 IndexedDB。
- 更新：导入同 ID 的新版本即为更新。插件正在运行时会热重载，保留选择和配置；失败时恢复上一版文件和代码。
- 卸载：插件详情 →「卸载」。插件会在两个窗口停止，文件和配置被删除；如果它是当前渲染器，会回到普通文字。
- 导出：已安装的插件（以及开发模式下的所有目录插件）可以在详情里「导出」，导出的包带有当前配置。桌面版保存到「下载」文件夹并在资源管理器中选中。

## 8. `.lyrx` 格式规范（formatVersion 1）

`.lyrx` 是一个 UTF-8 JSON 文件：

```json
{
  "format": "lyrscape.plugin",
  "formatVersion": 1,
  "manifest": { "id": "…", "name": "…", "description": "…", "category": "renderer", "…": "…" },
  "javascript": "export const manifest = …; export default …",
  "css": "",
  "config": { "speed": 1.5 },
  "integrity": "sha256-…",
  "exportedAt": "2026-10-15T08:00:00.000Z"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `format` | ✅ | 固定为 `"lyrscape.plugin"` |
| `formatVersion` | ✅ | 固定为 `1`。不认识的版本会被拒绝，并提示更新应用 |
| `manifest` | ✅ | 同第 3 节。用于安装前预览，必须与模块导出的 `manifest.id` 一致 |
| `javascript` | ✅ | 自包含的 ES 模块源码，≤ 2 MB（UTF-8）。不能 `import` 外部文件，宿主能力通过服务获得 |
| `css` | | ≤ 512 KB |
| `config` | | 安装时，如果本机还没有这个插件的配置，就用它作为初始配置（最多 40 个基本类型值） |
| `integrity` | | `"sha256-" + base64(SHA-256(UTF8(javascript) ‖ 0x00 ‖ UTF8(css)))`。存在时必须匹配，否则拒绝安装 |
| `exportedAt` | | ISO 时间，仅供参考 |

导入流程：解析 JSON → 校验格式、manifest、大小和 integrity → 显示确认对话框 → 写入插件存储 → 在两个窗口加载模块并校验导出的 Plugin → 注册并启动（如果之前被停用过，则保持停用）。任何一步失败都会回滚，不会留下坏文件。

## 9. 发布前检查清单

- [ ] `id` 用自己的前缀（不要用 `official.`），`rendererService` 唯一
- [ ] 停用 → 启用、切换渲染器、卸载后，没有残留节点、定时器和样式
- [ ] 打开桌面歌词，在两个窗口里分别确认显示正常
- [ ] 逐字歌词、逐行歌词和纯文本三种情况都看过
- [ ] 开启「减少动态效果」时保持静态
- [ ] 浅色和透明背景下可读（「渲染器」页的预览背景开关）
- [ ] 用 `npm run plugin:pack` 打包成功，导入时显示「完整性：已校验」
