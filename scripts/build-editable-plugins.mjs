import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { bundlePlugin, loadManifests } from './lib/plugin-bundler.mjs';

const outputArg = process.argv.find(arg => arg.startsWith('--out-dir='));
const output = path.resolve(outputArg?.slice('--out-dir='.length) || 'builds/plugins');
await mkdir(output, { recursive: true });
const overwrite = process.argv.includes('--overwrite');
let built = 0;
for (const { id } of await loadManifests()) {
  const modulePath = path.join(output, `${id}.mjs`);
  if (!overwrite) { try { await access(modulePath); console.log(`KEEP ${id}: existing editable file`); continue; } catch {} }
  const bundle = await bundlePlugin(id);
  await writeFile(modulePath, bundle.javascript);
  await writeFile(path.join(output, `${id}.css`), bundle.css);
  built++; console.log(`BUILT ${id}`);
}
console.log(`${built} plugin bundles written to ${output}. Existing edits are preserved unless --overwrite is explicit.`);
