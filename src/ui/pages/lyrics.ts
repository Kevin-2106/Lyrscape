import type { AppState } from '../../sdk/types';
import type { PageDefinition } from '../context';
import { mountImportPanel } from '../components/import-panel';
import { mountSourcePanel } from '../components/source-panel';
import { mountStage } from '../components/stage';
import { icons } from '../icons';
import { html, q } from '../kit/dom';

export const lyricsPage: PageDefinition = {
  id: 'lyrics', group: '播放', title: '歌词', subtitle: '预览、播放来源与歌词导入', icon: icons.lyrics,
  mount(root, services) {
    const layout = html('<div class="split-layout"><div class="split-main"></div><aside class="split-side" aria-label="来源与导入"></aside></div>');
    root.append(layout);
    const stage = mountStage(q(layout, '.split-main'), services);
    const side = q(layout, '.split-side');
    const source = mountSourcePanel(side, services);
    const importer = mountImportPanel(side, services);
    return {
      render(state: AppState) { stage.render(state); source.render(state); },
      activate: stage.activate, deactivate: stage.deactivate,
      commands: { import: importer.openFilePicker },
      reveal(target) { if (target === 'source') side.querySelector('.source-card')?.scrollIntoView({ block: 'nearest' }); },
      dispose() { stage.dispose(); source.dispose(); importer.dispose(); root.replaceChildren(); },
    };
  },
};
