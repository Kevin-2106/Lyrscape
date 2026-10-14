import type { PageDefinition } from '../context';
import { icons } from '../icons';
import { html } from '../kit/dom';
import { mountPluginManager } from '../plugin-manager';

export const pluginsPage: PageDefinition = {
  id: 'plugins', title: '插件', subtitle: '自由组合歌词的来源与表现，设置自动保存', icon: icons.plugins,
  mount(root, { ctx }) {
    const panel = html('<section class="plugin-panel" aria-label="插件管理与配置" data-plugin-manager></section>');
    root.append(panel);
    const dispose = mountPluginManager(panel, ctx.pluginManagement, ctx.getState, listener => ctx.subscribe(() => listener()));
    return { render() { /* the manager subscribes to state and management itself */ }, dispose() { dispose(); root.replaceChildren(); } };
  },
};
