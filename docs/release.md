# 发布、安装与插件分发

2026-10-17。从源码到用户装上插件的完整链路：

```
打 tag ──▶ Release 工作流 ──▶ 草稿 Release（安装包、便携版、示例 .lyrx、SHA256SUMS）
                                          │ 人工检查后发布
push main ──▶ Pages 工作流 ──▶ 站点（首页、使用指南、插件页 + .lyrx 下载）
                                          │
用户：下载安装包 → 安装 → 在插件页下载 .lyrx → 拖进 Lyrscape → 确认 → 选用
```

## 发布一个版本

1. 同步修改版本号：`package.json` 的 `version` 和 `src-tauri/tauri.conf.json` 的 `version`，两者必须一致。
2. 本地先跑一遍（见下方「验证」），提交。
3. `git tag v0.2.0 && git push origin v0.2.0`。
4. `.github/workflows/release.yml` 在 `windows-latest` 上依次执行：
   - 检查 tag 与版本号是否一致；
   - `npm ci`、`npm test`、`cargo test`；
   - `tauri build`（NSIS 安装包）；
   - 生成便携版 zip，内含 `Lyrscape.exe` 和一个空的 `plugins/` 文件夹；
   - 把 `site/gallery.json` 中列出的插件打包为 `.lyrx`；
   - 写 `SHA256SUMS.txt`；
   - 创建**草稿** Release。
5. 在 GitHub 上检查草稿、补充更新说明，然后点击发布。

手动运行工作流（workflow_dispatch）只构建，不发 Release。产物在该次运行的 Artifacts 里，适合试打包。

## 站点（GitHub Pages）

- 源文件在 `site/`：
  - `index.html`、`guide.html`（使用指南）、`plugins.html`、`plugins.js`、`style.css`；
  - `gallery.json`：插件页收录的插件入口列表。
- `node scripts/build-site.mjs` 生成 `dist-site/`：复制页面，把收录的插件打包到 `plugins/*.lyrx`，并生成插件页读取的 `plugins.json`。`dist-site/` 已被 git 忽略。
- `.github/workflows/pages.yml` 在 `main` 上的 `site/`、`examples/plugins/` 或相关脚本有变化时构建并部署站点。
- **首次启用**：仓库 Settings → Pages → Source 选择 **GitHub Actions**。
- 收录新插件：把入口文件路径加入 `site/gallery.json`。插件源码要放进仓库，以便审阅；构建时会用应用自身的规则校验插件包。

> 仓库已公开（2026-10-17），Release 附件和 Pages 站点对所有人可见。

## 安装后插件存在哪里

| 情况 | 插件目录 |
| --- | --- |
| 安装版（NSIS，按用户安装） | `%LOCALAPPDATA%\io.github.kevin2106.lyrscape\plugins\` |
| exe 旁已有 `plugins\` 文件夹（便携版、开发时的 `target\release`） | exe 旁的 `plugins\` |
| 设置了环境变量 `LYRSCAPE_DATA_DIR`（隔离测试实例） | `%LYRSCAPE_DATA_DIR%\plugins\` |

规则在 `src-tauri/src/plugin_source.rs` 的 `storage_base`。以前插件一律写在 exe 旁，安装版因此有两个问题：

- 安装目录如果被改到 `Program Files`，就没有写权限，插件装不上；
- 卸载时勾选「删除应用数据」也不会删掉它们，会留下残留。

现在的位置有这些好处：

- 应用数据目录总是可写；
- NSIS 升级时，安装包会先运行旧版卸载程序，卸载程序只删除自己安装的文件，所以这个目录在升级后保留；
- 勾选「删除应用数据」卸载时，它和设置、WebView 缓存一起被删除。

WebView2 的数据（设置、插件偏好）一直放在同一个应用数据目录下的 `EBWebView\` 中。

## 许可证与第三方声明

Lyrscape 以 MIT License 发布（根目录 `LICENSE`）。随应用分发的第三方内容列在 `THIRD_PARTY_NOTICES.txt`：

- 打包的字体（SIL OFL 1.1，要求随分发附带许可文本）；
- `@tauri-apps/api`、霞鹜文楷 webfont 等 npm 运行时依赖；
- 编译进 exe 的 Rust crate（只统计运行时依赖）。

这份文件由 `node scripts/build-notices.mjs` 生成，需要先 `npm ci`，并且 PATH 里有 cargo。依赖变化后重新生成并提交。Release 工作流在构建前会自动重新生成，并把它放进便携版和 Release 附件；应用内「设置 › 关于 › 开源许可与第三方声明」按需加载显示同一份文件。

Rust 依赖中有 5 个 crate 使用 MPL-2.0（cssparser、selectors 等，来自 Tauri 的依赖链）。它们是文件级 copyleft，未修改使用即可，清单里列出了它们的源码仓库。

## 验证

```powershell
npm run desktop:package
npm run plugin:pack -- examples/plugins/wave/index.mjs
node scripts/smoke-install.mjs
```

`smoke-install.mjs` 用真实的 NSIS 安装包走完下面这些步骤：

1. 静默安装到 `qa/e2e/app`，确认全新安装不带 `plugins` 文件夹；
2. 用隔离的 WebView2 profile、CDP 9228 和 `LYRSCAPE_DATA_DIR=qa/e2e/data` 启动；
3. 导入 `.lyrx`，确认文件写入了数据目录，内容和包里一致；
4. 选用这个渲染器，然后重启应用，确认插件和选择都还在；
5. 再次运行安装包（覆盖升级），确认插件仍在；
6. 卸载插件，确认文件被删除；
7. 静默卸载应用，并确认安装目录和注册表卸载项都已清除。

它不会触碰用户正常实例的设置和插件。

站点：`node scripts/build-site.mjs` 之后，用任意静态服务器打开 `dist-site/`，确认插件页能列出插件、`.lyrx` 能下载。
