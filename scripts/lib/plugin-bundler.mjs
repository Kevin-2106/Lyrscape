import { build } from 'esbuild';
import path from 'node:path';

/**
 * Lists the source catalog by evaluating the pure-data src/plugins/manifests.ts in
 * Node (no plugin code runs). Rebuilt on every call so newly added manifests appear.
 */
export async function loadManifests(workspace = process.cwd()) {
  const result = await build({
    entryPoints: [path.join(workspace, 'src/plugins/manifests.ts')], bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2022', write: false, logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return module.builtinManifests;
}

export async function bundlePlugin(id, workspace = process.cwd()) {
  const manifests = await loadManifests(workspace);
  if (!manifests.some(manifest => manifest.id === id)) throw Error('Plugin is not in the source catalog (src/plugins/manifests.ts)');
  // Every catalog bundle carries its manifest, so a rescan can register it and a reload can update its metadata.
  const entry = `import { catalog } from './src/plugins/catalog';
const item = catalog.find(item => item.manifest.id === ${JSON.stringify(id)});
export const manifest = item.manifest;
export default (store) => item.create(store);`;
  const result = await build({
    stdin: { contents: entry, resolveDir: workspace, sourcefile: `${id}.ts`, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    outfile: path.join(workspace, 'plugin.mjs'), logLevel: 'silent',
    plugins: [{ name: 'use-host-fonts', setup(build) {
      // Fonts are already available in the host. Keep local plugin bundles self-contained.
      build.onResolve({ filter: /^(@fontsource\/|lxgw-wenkai-webfont\/)/ }, args => ({ path: args.path, namespace: 'host-font' }));
      build.onLoad({ filter: /.*/, namespace: 'host-font' }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  const javascript = result.outputFiles.find(f => f.path.endsWith('.mjs'))?.text;
  const css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
  if (!javascript || Buffer.byteLength(javascript) > 2 * 1024 * 1024 || Buffer.byteLength(css) > 512 * 1024) throw Error('Plugin bundle exceeds the runtime budget');
  return { id, javascript, css };
}
