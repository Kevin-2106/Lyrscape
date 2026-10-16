import { build } from 'esbuild';
import path from 'node:path';

/** Runs the app's own package validation (src/plugins/package.ts) in Node. */
export async function validatePackage(pkg, workspace = process.cwd()) {
  const result = await build({ entryPoints: [path.join(workspace, 'src/plugins/package.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  return module.validatePackage(pkg);
}
