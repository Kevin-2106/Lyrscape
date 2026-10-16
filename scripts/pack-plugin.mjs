import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundlePlugin } from './lib/plugin-bundler.mjs';

// npm run plugin:pack -- <entry.mjs|entry.ts|built-in id> [--css file.css] [--out dir]
// Bundles a plugin into one self-contained ES module and writes a .lyrx package.
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const cssArg = option('--css'), outDir = path.resolve(option('--out') ?? 'builds/packages');
const target = args[0];
if (!target) { console.error('用法：npm run plugin:pack -- <插件入口 .mjs/.ts 或内置插件 ID> [--css 样式.css] [--out 目录]'); process.exit(1); }

let javascript, css = '';
if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(target) && !/\.(m?js|ts)$/.test(target)) {
  ({ javascript, css } = await bundlePlugin(target));
} else {
  const entry = path.resolve(target);
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, outdir: 'out', logLevel: 'silent' });
  javascript = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  const sibling = entry.replace(/\.(m?js|ts)$/, '.css');
  const extra = cssArg ? path.resolve(cssArg) : sibling;
  try { css += await readFile(extra, 'utf8'); } catch { if (cssArg) throw Error(`找不到样式文件 ${cssArg}`); }
}
// Read the manifest the same way the app does: by importing the module.
let manifest;
try { manifest = (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)).manifest; }
catch (error) { throw Error(`无法读取 manifest：模块顶层不能访问 DOM（${error.message}）`); }
if (!manifest?.id) throw Error('插件需要 export const manifest = { id, name, description, category, ... }');

const integrity = `sha256-${createHash('sha256').update(Buffer.concat([Buffer.from(javascript), Buffer.from([0]), Buffer.from(css)])).digest('base64')}`;
const pkg = { format: 'lyrscape.plugin', formatVersion: 1, manifest, javascript, css, integrity, exportedAt: new Date().toISOString() };
// The app validates again on import; check here too so authors see errors at pack time.
const { validatePackage } = await import('./lib/package-check.mjs');
await validatePackage(pkg);
await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `${manifest.id}-${manifest.version ?? '0.1.0'}.lyrx`);
await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`PACKED ${manifest.id} → ${path.relative(process.cwd(), file)} (${Math.round(Buffer.byteLength(javascript) / 1024)} KB js, ${Math.round(Buffer.byteLength(css) / 1024)} KB css)`);
