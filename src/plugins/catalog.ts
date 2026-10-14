import type { Plugin } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, PluginManifest } from '../sdk/types';
import { amllPlugin } from './amll';
import { auroraPlugin } from './aurora';
import { beatPlugin } from './beat';
import { AMLL_ADAPTER, AURORA_RENDERER, BEAT_DETECTOR, builtinManifests } from './manifests';
import { pvPlugins } from './pv';

/** A built-in optional plugin: its manifest plus a factory for the window's store. */
export interface CatalogItem { manifest: PluginManifest; create(store: Store<AppState>): Plugin }

const factories: Record<string, (store: Store<AppState>) => Plugin> = {
  [BEAT_DETECTOR]: store => beatPlugin(store),
  [AMLL_ADAPTER]: store => amllPlugin(store),
  [AURORA_RENDERER]: () => auroraPlugin,
  ...Object.fromEntries(pvPlugins.map(plugin => [plugin.id, () => plugin])),
};

/** Built-in hot-reloadable plugins. Development bundles and `npm run plugins:build` are generated from this list. */
export const catalog: CatalogItem[] = builtinManifests.map(manifest => {
  const create = factories[manifest.id];
  if (!create) throw Error(`catalog: ${manifest.id} 缺少插件工厂`);
  return { manifest, create };
});
