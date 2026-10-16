import type { PageDefinition } from '../context';
import { icons } from '../icons';
import { html } from '../kit/dom';
import { mountPluginManager } from '../plugin-manager';

export const pluginsPage: PageDefinition = {
  id: 'plugins', group: '插件', title: '全部插件', subtitle: '按职责分类管理插件：启停、配置、导入导出与热重载', icon: icons.plugins,
  mount(root, { ctx, notify, navigate, confirm }) {
    const panel = html('<div class="manager-host" aria-label="插件管理与配置" data-plugin-manager></div>');
    root.append(panel);
    const manager = mountPluginManager(panel, ctx.pluginManagement, ctx.getState, listener => ctx.subscribe(() => listener()), { notify, navigate, confirm });
    return {
      render() { /* the manager subscribes to state and management itself */ },
      reveal: manager.reveal,
      commands: { search: manager.focusSearch },
      dispose() { manager(); root.replaceChildren(); },
    };
  },
};
