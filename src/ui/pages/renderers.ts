import type { AppState } from '../../sdk/types';
import type { PageDefinition } from '../context';
import { mountRendererInspector, mountRendererList } from '../components/look-panel';
import { mountStage } from '../components/stage';
import { icons } from '../icons';
import { html, q } from '../kit/dom';

/** Renderer workspace: gallery · live preview · inspector (the renderer's option categories as tabs). */
export const renderersPage: PageDefinition = {
  id: 'renderers', group: '插件', title: '渲染器', subtitle: '挑选歌词的呈现方式，实时预览并调整', icon: icons.palette,
  mount(root, services) {
    const layout = html(`<div class="renderer-layout">
      <aside class="gallery-pane" aria-label="渲染器列表">
        <header class="pane-head"><h2>样式</h2><span class="pane-count" data-renderer-count></span></header>
        <div class="pane-scroll" data-gallery></div>
        <footer class="pane-foot"><button class="button-secondary" data-renderer-import>${icons.importIcon}导入渲染器</button><button class="button-link" data-renderer-manage>管理</button></footer>
      </aside>
      <div class="renderer-stage" data-stage></div>
      <aside class="inspector" aria-label="渲染器设置" data-inspector></aside>
    </div>`);
    root.append(layout);
    const gallery = mountRendererList(q(layout, '[data-gallery]'), services);
    const stage = mountStage(q(layout, '[data-stage]'), services, 'style-preview');
    const inspector = mountRendererInspector(q(layout, '[data-inspector]'), services);
    const controller = new AbortController();
    layout.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (button?.matches('[data-renderer-import]')) services.navigate('plugins', 'import');
      else if (button?.matches('[data-renderer-manage]')) services.navigate('plugins', 'group:look');
    }, { signal: controller.signal });
    return {
      render(state: AppState) {
        gallery.render(state); stage.render(state); inspector.render(state);
        q(layout, '[data-renderer-count]').textContent = String(services.ctx.pluginManagement.list().filter(p => p.rendererService).length);
      },
      activate: stage.activate, deactivate: stage.deactivate,
      reveal(target) { inspector.reveal(target); },
      dispose() { controller.abort(); gallery.dispose(); stage.dispose(); inspector.dispose(); root.replaceChildren(); },
    };
  },
};
