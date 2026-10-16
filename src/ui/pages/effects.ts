import type { AppState } from '../../sdk/types';
import type { PageDefinition } from '../context';
import { mountEffects } from '../components/look-panel';
import { icons } from '../icons';
import { html, q } from '../kit/dom';

export const effectsPage: PageDefinition = {
  id: 'effects', group: '插件', title: '特效', subtitle: '叠加在渲染器之上的效果，例如跟随节拍', icon: icons.sparkle,
  mount(root, services) {
    const layout = html(`<div class="page-column">
      <p class="page-intro">特效插件读取音频或时间轴，为支持它的渲染器提供额外的动态。没有音频输入时不会产生效果。</p>
      <div data-effects-host></div>
      <div class="page-foot"><button class="button-secondary" data-effects-import>${icons.importIcon}导入特效</button></div>
    </div>`);
    root.append(layout);
    const effects = mountEffects(q(layout, '[data-effects-host]'), services);
    q(layout, '[data-effects-import]').addEventListener('click', () => services.navigate('plugins', 'import'));
    return {
      render(state: AppState) { effects.render(state); },
      dispose() { effects.dispose(); root.replaceChildren(); },
    };
  },
};
