# 当前插件开发指南

2026-10-13。本指南面向修改宿主与内置插件的开发者；只想写一个可分发的渲染器 / 特效，请看 [插件编写手册](plugin-authoring.md)（`.lyrx` 包，无需改动应用代码）。本指南只描述能在当前代码中运行的接口。`architecture.md` 中的第三方包、权限协商、Worker / iframe、通用 effect 插槽仍是目标设计。

开发源码与桌面本地 JS 现在支持[手动热重载](manual-plugin-reload.md)：插件卡片中选择来源并点击「热重载」。开放的 ID、资源清理、双窗口同步和失败恢复要求见该说明。

## 最小接口

插件实现 `Plugin`（当前定义在 `src/kernel/host.ts`）：

```ts
const plugin: Plugin = {
  id: 'example.feature',
  requires: ['timeline@1'],
  activate(ctx) {
    const timeline = ctx.service<Timeline>('timeline@1');
    ctx.provide('example.feature@1', { timeline });
    const timer = setInterval(() => { /* 自己的功能 */ }, 1000);
    ctx.own(() => clearInterval(timer));
  },
};
```

`requires` 声明必需服务，按实际 provider 就绪顺序激活；插件 ID 唯一，同一个 service ID 只有一个 provider。`ctx.own` 追踪资源，退出和激活失败时逆序释放。不要创建未登记的定时器、事件监听或 view。缺服务 / 循环依赖会使启动失败；可选插件再次启用失败会回滚其激活并在管理 UI 显示错误。

分类是 `PluginInfo.category` 元数据，所有类别使用同一个生命周期接口。当前类别在 `src/sdk/types.ts` 的 `PluginCategory`，中文名称在 `src/ui/plugin-manager.ts`。无需引入一组只用于分类的基类。

## Renderer

契约是 `Renderer.mount(root, getState, timeline): () => void`。root 属于这次 mount，退出清空自己创建的节点 / 样式 / 动画；不要修改其他 renderer 的私有 DOM。每个 mount 独立，controller 与 overlay 各自的 JS realm 不是同一个对象。

`examples/renderer-starter/index.ts` 是可编译的可信源码示例。它提供独立 `renderer.example-rise@1`，使用 `createDomRenderer` 保留真实时间填充，并只添加无滤镜的 2D 进入动画；不默认装入产品组合。

`createDomRenderer` 的公开 hooks：

| Hook | 时机 |
| --- | --- |
| `mount(root)` | 当前 view 初始化，返回 cleanup |
| `revision(state)` | 可选配置修订 key；变更才重建本行 |
| `line(root, line, state)` | 当前行、文档或配置修订变化之后；只负责这个 view 的节点 |
| `frame(root, state, {position, index})` | 每帧，可选；拿到共享 timeline 位置和当前行索引，只执行有界的轻量操作 |

用 `ownRenderer(ctx, renderer)` 包装 provider：插件停用时释放仍存活的 mount，已退出的 mount 不会累计 scope 引用；dispose 必须可重复调用。长歌词的动画单元需要预算，不能因 10 万个字符创建 10 万个滤镜图层。

没有逐字时间就没有逐字填充。按字符进入使用 `Intl.Segmenter(..., {granularity:'grapheme'})`，不能按 `split('')` 拆 emoji，也不能平均分配歌词时长造出字时间。

透明 overlay 中避免 CSS `filter: blur/drop-shadow`，它在当前本机 WebView2 曾产生左上角额外字形。用 text-shadow、transform / opacity；真实桌面检查见开发指南。长字词允许 `pre-wrap / overflow-wrap:anywhere / max-width:100%`，不要只把 overflow:hidden 当作布局修复。

## 在现有组合注册新 renderer

可选插件由一份目录驱动（2026-10-14 起），**不再需要改 `main.ts`**，也不需要重启开发页面：

1. 在 `src/plugins/manifests.ts` 的 `builtinManifests` 增加 manifest：`{ id, name, description, category: 'renderer', rendererService: 'renderer.example-rise@1', fields }`。这是纯数据文件（开发服务器在 Node 中读取它列出目录），不要在这里导入插件代码。PV 风格只需在 `pv-presets.ts` 增加 profile，会自动进入目录。
2. 在 `src/plugins/catalog.ts` 的 `factories` 增加 `[id]: store => starterPlugin`。缺少工厂会在启动时报错。
3. 开发模式下到「全部插件」点「重新扫描」：新插件在控制面板与桌面歌词中同时注册并激活，卡片、配置、选择路由和预览标签全部来自 manifest；不存在或停用时回退 `renderer.text@1`。修改名称 / 说明 / fields 同样重新扫描即可，已保存的配置按新 fields 重新归一化。
4. 两个窗口都从同一目录启动（renderer 与 effect 默认运行在两个窗口，可用 `surfaces` 收窄），不再有 preview 可用、overlay 回退普通文字的漏注册。
5. 浏览器和原生分别验证选择 / 停用 / 保存 / 回退 / 多窗口同步，不能只测一个 mount。将验证记录写入文档。时间驱动的弹入 / 弹出可参考 [PV renderer](pv-renderers.md)，真实逐字进度不能用视觉相位替代。

运行中扫描只能新增 `renderer` 与 `effect`；其他类别需要宿主接线，仍要重启或重新构建。基础组合（essential）插件不在目录中，不能被扫描替换。

所有 renderer 使用各自的服务 ID；选择插件对 surface 暴露 `renderer@1`。不要让新 renderer 同时抢占这个公共选择服务。

## 配置、adapter 和 UI

独立配置目前支持 `number / select / boolean`，字段默认值、min / max / step / options 在 manifest 声明，加载外部 manifest 时由 `src/plugins/registry.ts` 的 `validateManifest` 校验（ID 格式、类别、rendererService、字段类型 / 范围 / 选项 / 重复 key）；管理服务会去掉未声明字段。尚未注册的插件（例如还没扫描到的本地文件）的已保存配置原样保留，扫描到后再按其 fields 归一化。保存键为 `lyrscape.plugins.v1`，文字主题键为 `lyrscape.settings.v1`。这不是完整的 JSON Schema 或权限声明。

Adapter 提供自己的命令与快照服务，向统一 `AppState` 发布模型，不向 renderer 传递 wire 协议对象。当前 `AppState.adapterId` 和 `SettingsUiContext.selectAdapter` 是 demo / amll 联合类型；增加 adapter 需要扩展该类型、状态切换、UI 和跨窗口组合，并处理旧连接的迟到消息。native WS 创建与来源控制留在 broker，不能在 renderer 实现 AMLL socket。

UI 通过 `SettingsUiContext` / `PluginManagement` 调用功能。新增可选 provider 前，检查 settings plugin 的 `requires` 是否错误地把它变成必须依赖。基础组合保护是管理插件策略，kernel 只处理生命周期和依赖；要替换基础组合，先保证回退和管理入口可用。

引入原生能力时同时检查 `src/platform.ts`、Rust 窗口身份校验和 `src-tauri/capabilities/`；overlay 只获得自己的拖动 / resize 与事件能力，不获得控制窗的 AMLL 命令权限。
