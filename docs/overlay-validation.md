# Overlay 修复与开发文档验证

2026-10-13。验证 Windows 本机 WebView2（UA 为 Edge / Chrome 154）、Tauri release、Edge 浏览器。本页区分复现、失效尝试、最终修复与验证边界。

## 实现

- 普通 renderer 和 Aurora 共用长字词换行：`max-width:100% / pre-wrap / overflow-wrap:anywhere`，base / fill 保持同样排版。
- Aurora 的实际 glyph / fill 层绘制渐变；移除祖先再次对动画后代做 background-clip:text 的重复遮罩。overlay 使用 text-shadow、动画单元 filter:none；保留 transform 动效。
- 不存在细分字时间就不显示播放填充。仅有一个覆盖整行的多字符片段也按逐行处理，原始文档不修改；无逐字时按 grapheme 进入。
- 关闭穿透后拖左右把手改变窗口宽度，中间移动窗口；overlay 增加窄范围的 start-resize-dragging 权限。高度按 layout border box 自适应，不按动画变化的 scrollHeight。
- 8 颗星保留在同一个 mount 中，以 3.6–5 秒、错开相位的 opacity 循环缓慢闪烁；换行 / 进入配置不重建节点或动画实例。减少动态效果时静止。
- 新增 CONTRIBUTING、开发指南、插件开发指南、交接清单和可编译 renderer starter；文档明确当前显式注册与持久化 / 路由的扩展位置。

## 复现与失败记录

使用隔离实例和自产 fixture，在纯色受控控制窗口上采集实际 OS overlay 矩形；未采集用户歌词或整个桌面。

| 检查 | 结果 | 解释 |
| --- | --- | --- |
| 原版首次桌面采样 `qa/ghost-before` | 6 / 40 帧异常，角落最多 1400 个高亮紫色像素 | 实际复现左上角额外字形 |
| 已稳定实例移除 filter `qa/ghost-no-filter` | 0 / 85 帧异常 | 当时的对照不足以证明首次启动修复 |
| 仅关闭 filter 的新构建 `qa/ghost-fixed` | 5 / 85 帧异常，最多 1063 像素 | 该修复不完整，已继续修复 |
| 去掉父级渐变遮罩 `qa/ghost-no-parent-gradient` | 0 / 30 帧异常，最多 2 像素 | 指向重复遮罩路径 |
| 保留父级遮罩但改用 2D / 无 filter `qa/ghost-safe` | 15 / 30 帧异常，最多 1070 像素 | 仅改动效类型不能解决 |
| 慢闪烁前的 comet 检查 | 3 / 100 帧被阈值标记，最多 34 像素 | 已检查截图，来自角落采样区域边缘的移动星芒；不是大块字形。之后星星改为静态位置缓慢闪烁，并完整重测 |

“异常帧”指固定 fixture 保留角落中超过 10 个高亮紫色像素；不是通用屏幕正确性分类器。已查看实际截图，确认大块错误字形与星芒边缘的区别。诊断截图和 JSON 保存在未提交的 qa。

复制交付 exe 首次遇到 Windows 文件锁；发现副本哈希仍是旧版，未将该次当成成功。之后等待已核实进程完全退出，复制有界重试且失败停止，哈希一致后才启动。

## 最终验证

- 构建与前端 40 项测试通过；Rust 8 项通过。starter 纳入 TypeScript 构建检查。
- 原有 browser smoke、plugin smoke、overlay layout smoke 通过。覆盖静态 / 逐行 / 长时间片段在 320 / 520 / 1100px 换行，无猜测进度，emoji grapheme，跨行保留星星节点与 CSSAnimation 实例，减少动态效果。
- 原生 V1 / V2 11445 fixture、窗口置顶 / 穿透、透明 overlay 与 plugin smoke 通过，采用隔离 profile / CDP 9228。
- 完整渐变遮罩修复 + 慢闪烁版本，三种预设各 100 帧 OS 采样（qa/final-orbit、final-comet、final-prism）均 0 / 100 异常帧、0 个异常紫色像素，已检查图像。该采样先于最后的整行时间片段降级 guard；最终 exe 又补查该降级路径的三种预设各 40 帧（qa/final-line-orbit、final-line-comet、final-line-prism），均 0 / 40 异常帧、0 个异常紫色像素。
- 实际鼠标输入拖左右把手：East 1357 → 1261、West 1261 → 1165（物理像素），两个方向各改变 96px，均通过。
- 本地 Markdown 文件链接检查通过；文档区分现有实现与架构提案。
- 已备份旧版到 builds/Lyrscape-before-overlay-fix.exe，原 baseline 备份仍保留。最终交付副本 SHA-256 与 release 一致：

```text
5598BF341323D212E31C927C5BD43699F4778E0423429AD1FF547B1A2D91C3EA
```

- 运行中的用户实例已更新；恢复文字 / 插件设置、overlay 位置 / 宽度 / 可见 / 置顶 / 穿透和监听状态。11444 真实网易云 Connector 自动重连，元数据 / 歌词 / 播放位置已收到，UI 无错误；整行片段已不创建 word-fill。未记录私人歌曲内容。

尚未检查：其他机器 / GPU / WebView2 版本、多显示器不同 DPI、独占全屏与长期稳定性。本机采样通过不能外推为所有原生合成路径都已验证。

## 光晕与 solid 分层修正

同日后续：渐变前景使用透明字色 + background-clip:text，直接在同一元素绘制 text-shadow 会让阴影盖在渐变背景前。现在拆成 `aurora-glow-layer`（z-index 0、aria-hidden、CSS 生成文字）和 `aurora-solid`（z-index 1、无 text-shadow、实际文本 / 渐变）。clip-path 仍由 word-fill 容器按真实字时间控制，不重复正文 textContent。进入动画也不再对整体单元使用 blur，前景保持清晰，模糊光晕只在后景。

验证：前端 40 项、构建、插件 / 长歌词浏览器 smoke 通过。蓝色不透明字面与白色光晕的截图像素对照，浏览器 preview / overlay 各 7863 个 solid 像素、原生 preview / overlay 各 12638 个 solid 像素，开启光晕后变化均为 0。脚本为 `smoke-glow-layer.mjs / check-glow-pixels.ps1`，截图在 qa/glow-layers。原生三种实际动画各 60 帧，qa/glow-stack-guarded-orbit / comet / prism 均 0 异常帧、0 异常紫色像素；该检查在最后删除 preview 动画整体 blur 前完成，overlay 在这两版中均强制 filter:none，路径不变。

验证工具修正记录：fixture 的 timed base/fill 会让原始 textContent 包含两份文本，改为检查 word-base；fixture 显式恢复 motion / sparks / glow，避免像素对照冻结动画后误测静态。一次采样中背景临时不可见，五张无效桌面帧已删除，不计入通过结论。截图工具现保存前检查四角为受控背景色，背景不可见立即拒绝保存；像素分析也拒绝空采样。

交付已保留 builds/Lyrscape-before-glow-layer.exe。新交付副本与 release SHA-256 一致：

```text
DF7B2E3FDCCF3324B2F5CF8D53E9D004F4A80700A96461630F09FF67C9B27672
```

## 后续文字 PV 检查

同日新增三个时间驱动的 PV renderer，最新有效屏幕采样、工具失效记录和交付 hash 见 [PV renderer 验证](pv-renderers.md)。最终三种风格各 90 张正在播放的 OS 帧，共 270 张，左上角异常像素为 0，并检查正文场景确实绘出。fixture 现在等待异步导入完成后再播放；分析除了角落污染，也拒绝只有空白背景的场景。不能把早期暂停在 0ms 的 PV 采样视为有效运动验证。
