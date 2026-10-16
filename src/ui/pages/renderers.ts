import type { AppState } from '../../sdk/types';
import type { PageDefinition } from '../context';
import { mountRendererList, mountRendererOptions } from '../components/look-panel';
import { mountStage } from '../components/stage';
import { mountTextPanel } from '../components/text-panel';
import { icons } from '../icons';
import { html, q } from '../kit/dom';

type Tab = 'options' | 'text';

/** Renderer workspace: gallery · live preview · inspector (renderer options / shared text style). */
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
      <aside class="inspector" aria-label="渲染器设置">
        <div class="tabs" role="tablist" aria-label="设置分类"><button role="tab" data-inspector-tab="options">${icons.style}选项</button><button role="tab" data-inspector-tab="text">${icons.text}文字</button></div>
        <div class="inspector-body"><div role="tabpanel" data-inspector-panel="options"></div><div role="tabpanel" data-inspector-panel="text"></div></div>
      </aside>
    </div>`);
    root.append(layout);
    const gallery = mountRendererList(q(layout, '[data-gallery]'), services);
    const stage = mountStage(q(layout, '[data-stage]'), services, 'style-preview');
    const options = mountRendererOptions(q(layout, '[data-inspector-panel="options"]'), services);
    const text = mountTextPanel(q(layout, '[data-inspector-panel="text"]'), services);
    const controller = new AbortController();
    let tab: Tab = 'options';
    const select = (next: Tab) => {
      tab = next;
      layout.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]').forEach(button => {
        const selected = button.dataset.inspectorTab === tab;
        button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      });
      layout.querySelectorAll<HTMLElement>('[data-inspector-panel]').forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== tab; });
    };
    select('options');
    layout.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (button?.dataset.inspectorTab) select(button.dataset.inspectorTab as Tab);
      else if (button?.matches('[data-renderer-import]')) services.navigate('plugins', 'import');
      else if (button?.matches('[data-renderer-manage]')) services.navigate('plugins', 'group:look');
    }, { signal: controller.signal });
    q(layout, '.tabs').addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      select(tab === 'options' ? 'text' : 'options');
      q<HTMLButtonElement>(layout, `[data-inspector-tab="${tab}"]`).focus();
    }, { signal: controller.signal });
    return {
      render(state: AppState) {
        gallery.render(state); stage.render(state); options.render(state); text.render(state);
        q(layout, '[data-renderer-count]').textContent = String(services.ctx.pluginManagement.list().filter(p => p.rendererService).length);
      },
      activate: stage.activate, deactivate: stage.deactivate,
      reveal(target) { if (target === 'options' || target === 'text') select(target); },
      dispose() { controller.abort(); gallery.dispose(); stage.dispose(); options.dispose(); text.dispose(); root.replaceChildren(); },
    };
  },
};
