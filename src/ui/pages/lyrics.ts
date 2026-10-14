import type { AppState } from '../../sdk/types';
import { rendererName } from '../../plugins/management';
import type { PageDefinition } from '../context';
import { createPreview } from '../components/preview';
import { mountImportPanel } from '../components/import-panel';
import { mountSourcePanel } from '../components/source-panel';
import { icons } from '../icons';
import { html, q } from '../kit/dom';

export const lyricsPage: PageDefinition = {
  id: 'lyrics', title: '歌词', subtitle: '预览、播放来源与歌词导入', icon: icons.lyrics,
  mount(root, services) {
    const stage = html(`<section class="card preview-card" aria-label="歌词预览">
      <div class="preview-stage"><div id="lyrics-preview" aria-label="歌词预览"></div></div>
      <div class="preview-note"><span class="live-indicator"><i aria-hidden="true"></i>实时预览 · 样式修改即时生效</span><span data-renderer-label>普通文字渲染器</span></div>
    </section>`);
    const grid = html('<div class="page-grid two"></div>');
    root.append(stage, grid);
    const preview = createPreview(q(stage, '#lyrics-preview'), services.ctx);
    const source = mountSourcePanel(grid, services);
    const importer = mountImportPanel(grid, services);
    return {
      render(state: AppState) {
        source.render(state);
        q(stage, '[data-renderer-label]').textContent = `${rendererName(services.ctx.pluginManagement, state.plugins.rendererId) ?? '普通文字'}渲染器`;
      },
      activate: preview.activate, deactivate: preview.deactivate,
      commands: { import: importer.openFilePicker },
      dispose() { preview.deactivate(); source.dispose(); importer.dispose(); root.replaceChildren(); },
    };
  },
};
