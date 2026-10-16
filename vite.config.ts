import { defineConfig } from 'vite';
import { bundlePlugin, loadManifests } from './scripts/lib/plugin-bundler.mjs';
import path from 'node:path';

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  plugins: [{
    name: 'lyrscape-manual-plugin-reload',
    configureServer(server) {
      server.middlewares.use('/__lyrscape/plugin-catalog', async (request, response) => {
        if (request.method !== 'GET') { response.statusCode = 405; response.end(); return; }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        try { response.end(JSON.stringify({ manifests: await loadManifests(server.config.root) })); }
        catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); }
      });
      server.middlewares.use('/__lyrscape/plugin-source/', async (request, response) => {
        if (request.method !== 'GET') { response.statusCode = 405; response.end(); return; }
        const id = (request.url ?? '').split('?')[0].replace(/^\//, '');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        try { response.end(JSON.stringify(await bundlePlugin(id, server.config.root))); }
        catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); }
      });
    },
    handleHotUpdate(context) {
      const pluginRoot = path.resolve(context.server.config.root, 'src/plugins') + path.sep;
      if (!path.resolve(context.file).startsWith(pluginRoot)) return;
      // Defer source/CSS edits until the explicit reload button builds a fresh bundle.
      context.server.ws.send({ type: 'custom', event: 'lyrscape:plugin-edited', data: {} });
      return [];
    },
  }, {
    // Fontsource lists a .woff fallback next to every .woff2; WebView2 only needs
    // woff2, so drop the fallbacks instead of bundling every subset twice.
    name: 'lyrscape-woff2-only', enforce: 'pre',
    transform(code, id) {
      if (!/[\\/](@fontsource|lxgw-wenkai-webfont)[\\/].+\.css$/.test(id.split('?')[0])) return;
      return code.replace(/,\s*url\([^)]+\.woff\)\s*format\('woff'\)/g, '');
    },
  }],
});
