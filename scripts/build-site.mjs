import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Builds the GitHub Pages site into dist-site/: the static pages in site/, plus
// every plugin listed in site/gallery.json packed to plugins/<id>-<version>.lyrx
// and described in plugins.json (read by the gallery page).
const out = path.resolve('dist-site'), plugins = path.join(out, 'plugins');
await rm(out, { recursive: true, force: true });
await cp('site', out, { recursive: true, filter: source => path.basename(source) !== 'gallery.json' });
await cp('src-tauri/icons/icon.png', path.join(out, 'icon.png'));
await mkdir(plugins, { recursive: true });

const entries = JSON.parse(await readFile('site/gallery.json', 'utf8'));
for (const entry of entries) {
  const result = spawnSync(process.execPath, ['scripts/pack-plugin.mjs', entry, '--out', plugins], { stdio: 'inherit' });
  if (result.status !== 0) throw Error(`packing ${entry} failed`);
}
const list = [];
for (const file of (await readdir(plugins)).filter(name => name.endsWith('.lyrx')).sort()) {
  const pkg = JSON.parse(await readFile(path.join(plugins, file), 'utf8'));
  const { id, name, description, category, version = '0.1.0', author, license, homepage, tags = [] } = pkg.manifest;
  list.push({ id, name, description, category, version, author, license, homepage, tags, file: `plugins/${file}`, size: (await stat(path.join(plugins, file))).size, integrity: pkg.integrity });
}
await writeFile(path.join(out, 'plugins.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), plugins: list }, null, 2)}\n`);
console.log(`SITE dist-site/ (${list.length} plugin${list.length === 1 ? '' : 's'})`);
