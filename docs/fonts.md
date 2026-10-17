# 字体与歌词语言

2026-10-13。字体按歌词语言自动选择：简体中文、繁体中文、日文各用对应字形的字体，一行（及一条译文）只使用一种 CJK 字体，不会出现中日字体混排。字体随应用打包（OFL，@fontsource 与 `lxgw-wenkai-webfont`），按 unicode-range 子集只加载歌词实际用到的部分，不访问网络。

## 语言判断

`src/plugins/typeface.ts`：

- **整首歌**（歌词与译文分别判断，按歌词文档缓存）：假名 ≥ 3 个或占 CJK 字符 ≥ 5% → 日文；韩文字母占多数 → 韩文；有汉字 → 中文，按约 770 个简体专用字与 780 个繁体专用字（们/們、这/這、说/說……）多数决定简体或繁体（只、台、后等两边都常用的字不计票）；否则为拉丁文字。长音符「ー」和「・」不算日文证据，中文歌里偶尔的「の」不会改变判断。
- **每行**：含平假名或片假名的行一律用日文；含韩文字母用韩文；其余汉字行跟随整首歌（日文歌的纯汉字行仍用日文字形）。拉丁文歌里的汉字行单独判断。
- `lang` 属性同步写到 PV 的隐藏文本与普通文字 / Aurora 的各行元素上（`zh-CN` / `zh-TW` / `ja` / `ko` / `en`），系统后备字体也会取对应字形。

## 字体表

| 角色（使用者） | 日文 / 拉丁 | 简体 | 繁体 |
| --- | --- | --- | --- |
| pop（糖果波普） | Mochiy Pop One | 站酷快乐体 | jf 粉圆 Huninn |
| maru（波普译文、情书大字 / 标签） | Zen Maru Gothic | 霞鹜文楷 | jf 粉圆 Huninn |
| hand（情书便签） | Klee One | 霞鹜文楷 | 霞鹜文楷 TC |
| gothic（挽歌正文、译文） | Noto Sans JP | Noto Sans SC | Noto Sans TC |
| mincho（挽歌巨字） | Shippori Mincho | Noto Serif SC | Noto Serif TC |
| heavy（吸血鬼） | Dela Gothic One | 站酷庆科黄油体 | Noto Sans TC Black |
| code（合成谱） | M PLUS 1 Code | Noto Sans SC | Noto Sans TC |
| rounded（一起出发） | M PLUS Rounded 1c 500 / 800 / 900 | Noto Sans SC | Noto Sans TC |
| pixel（游戏开发部） | Fusion Pixel 12px Proportional JP | Fusion Pixel 12px Proportional SC | Fusion Pixel 12px Proportional TC |

- arcade（游戏开发部 HUD）：Press Start 2P，只画拉丁文字，非拉丁文字改用 pixel。
- PV 的「字体」选项把中日文角色整体替换为上表中的另一种角色；拉丁专用角色（mono / script / serif / arcade）不受影响。
- 拉丁专用角色：译文的 Playfair Display / EB Garamond 斜体与 HUD 的 Share Tech Mono 只画拉丁文字；中文 / 日文译文与曲名自动改用同语言的 hand / mincho / code 字体（不再斜体）。
- 韩文使用系统 Malgun Gothic / Batang（未打包）。
- 字重取打包字重中最接近的一个，不让浏览器合成粗体。
- **覆盖检查**：装饰字体（站酷、粉圆等）字库较小。若某行有它没有的字符（读取打包的 unicode-range），整行改用该语言的 Noto 字体，而不是逐字后备；若该语言的 Noto 也缺字（例如日文段落里夹了简体专用字「们」），整行改用能完整覆盖的另一种 Noto。系统字体与未知字体视为完整覆盖。

## 主题字体

「渲染器 › 文字 → 字体」新增 4 个自动预设，用于普通文字、Aurora 与 Apple Music 风格；默认值为「自动 · 黑体」：

| 预设 | 对应角色 |
| --- | --- |
| 自动 · 黑体 | gothic |
| 自动 · 宋体 / 明朝 | mincho |
| 自动 · 楷体 / 手写 | hand |
| 自动 · 圆体 | maru |

保存值为 `auto:sans` 等标记；DOM renderer 对当前行、译文、下一行分别解析，并关闭 `font-synthesis`。旧默认值（`"Microsoft YaHei", "Segoe UI", sans-serif`）会迁移为「自动 · 黑体」。其他预设与自定义 font-family 保持原样，不按语言切换。PV 风格仍使用各自的字体表。

## 开发

- PV 风格不再引用固定字体族：`PvLine.face(role, weight?, style?)` / `tface(...)` 返回该行 / 译文的 `{ family, weight, style }`，并请求加载恰好这段文字的子集；`faceFont(face, size)` 生成 canvas font 字符串。`PvStyle.fonts` 只列固定的拉丁 / HUD 字体。
- 字体 CSS 由 `src/plugins/font-catalog.ts` 声明本地动态 chunk；`font-assets.ts` 按实际字符注册子集，`pv/fonts.ts` 等待注册后再加载字节。构建先运行 `scripts/build-font-manifest.mjs` 生成完整覆盖元数据，缺字判定不依赖已注册的局部字面。Fusion Pixel 的 CSS 没有 `unicode-range`，构建脚本改为直接读取 WOFF 的 cmap 表（format 12，退回 format 4）得到覆盖范围（约 3.1 万个码位）。普通文字的自定义字体也走这个入口。
- 热重载插件包把 `@fontsource/*` 与 `lxgw-wenkai-webfont/*` 映射为空模块，复用宿主共享字体 registry；旧 bundle 按引用字体族加载兼容 CSS，不覆盖用户本地修改。2026-10-16 的常驻内存对比见 [第二轮优化](memory-footprint.md)。

## 代价与验证

- 体积：`dist` 约 60 MB，桌面 exe 31.7 → 66 MB；CSS 约 2,250 条 `@font-face`（此前约 1,130 条）。字体文件只在用到时加载。
- 原生内存（`scripts/smoke-memory.mjs`，独立 profile，同一 Pop 场景约 2.5 分钟）：私有内存终点 544.8 MiB（之前）/ 541.6 MiB（之后），工作集 828 / 810 MiB；启动时多约 35 MiB（解析 font-face），运行中差异消失。报告在 `qa/memory/before-fonts-*`、`qa/memory/fonts-*`。
- `tests/typeface.test.ts`：语言判断、逐行判断、每个角色 × 语言只有一种 CJK 字体、主题预设与迁移、缺字整行后备。
- Edge 实验页（`qa/pv-lab.html?lang=sc|tc|mix`）：七种 PV / Apple Music 风格的简体、繁体、日文 + 中文译文截图在 `qa/fonts/`；`document.fonts` 显示简体歌词只加载 SC 系字体、繁体只加载 TC 系字体。普通文字 renderer 的行元素分别解析为 Noto Sans SC / TC / JP。
- `smoke-pv`、`smoke-amll-style`、`smoke-browser` 通过。
