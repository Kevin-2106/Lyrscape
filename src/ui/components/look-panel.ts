import type { AppState, PluginStatus } from '../../sdk/types';
import type { UiServices } from '../context';
import { renderConfigFields, type ConfigFieldsView } from '../kit/config-fields';
import { html, q } from '../kit/dom';

/** A stable two-color tile per plugin, so lists read at a glance without screenshots. */
export function swatch(id: string): string {
  if (id === 'official.renderer.text') return 'linear-gradient(135deg,#d9dcea,#7d8296)';
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 50) % 360} 65% 42%))`;
}

interface View { render(state: AppState): void; dispose(): void }
const keyOf = (plugins: PluginStatus[]) => JSON.stringify(plugins.map(p => [p.id, p.name, p.description, p.fields, p.active, p.category, p.origin]));

/**
 * Re-renders `build` only when the plugin list or metadata changes and `sync` when
 * preferences change, so playback ticks never rebuild controls or steal focus.
 */
function structured(ctx: UiServices['ctx'], pick: () => PluginStatus[], build: (state: AppState) => void, sync: (state: AppState) => void) {
  let structure = '', preferences: AppState['plugins'] | undefined;
  const render = (state: AppState) => {
    const next = keyOf(pick());
    if (next !== structure) { structure = next; preferences = state.plugins; build(state); sync(state); return; }
    if (state.plugins !== preferences) { preferences = state.plugins; sync(state); }
  };
  const unsubscribe = ctx.pluginManagement?.subscribe(() => { preferences = undefined; render(ctx.getState()); });
  return { render, unsubscribe: () => unsubscribe?.() };
}

/** Renderer gallery: one radio per renderer; choosing a disabled one enables it first. */
export function mountRendererList(host: HTMLElement, { ctx, perform }: UiServices): View {
  const list = html(`<div class="renderer-list" role="radiogroup" aria-label="渲染器" data-renderer-list></div>`);
  host.append(list);
  const controller = new AbortController(), { signal } = controller;
  const api = () => ctx.pluginManagement;
  const renderers = () => api().list().filter(p => p.rendererService);
  list.addEventListener('click', event => {
    const choice = (event.target as Element).closest<HTMLButtonElement>('[data-renderer-choice]');
    if (!choice || choice.disabled) return;
    const id = choice.dataset.rendererChoice!, plugin = api().list().find(p => p.id === id);
    if (plugin) void perform(async () => { if (!plugin.active) await api().setEnabled(id, true); api().selectRenderer(id); });
  }, { signal });
  // Arrow keys move through the group like a native radio group.
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const choices = [...list.querySelectorAll<HTMLButtonElement>('[data-renderer-choice]')];
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
  }, { signal });
  const view = structured(ctx, renderers, () => {
    list.replaceChildren();
    for (const plugin of renderers()) {
      const choice = html<HTMLButtonElement>(`<button class="renderer-choice" role="radio" aria-checked="false"><span class="renderer-swatch" aria-hidden="true"></span><span class="renderer-text"><strong></strong><span></span></span><span class="renderer-state"></span></button>`);
      choice.dataset.rendererChoice = plugin.id;
      q(choice, '.renderer-swatch').style.background = swatch(plugin.id);
      q(choice, 'strong').textContent = plugin.name;
      q(choice, '.renderer-text > span').textContent = plugin.description;
      choice.title = plugin.description;
      list.append(choice);
    }
  }, state => {
    const plugins = renderers();
    for (const choice of list.querySelectorAll<HTMLButtonElement>('[data-renderer-choice]')) {
      const plugin = plugins.find(p => p.id === choice.dataset.rendererChoice);
      const selected = choice.dataset.rendererChoice === state.plugins.rendererId;
      choice.setAttribute('aria-checked', String(selected)); choice.tabIndex = selected ? 0 : -1;
      choice.disabled = Boolean(plugin?.busy);
      const label = plugin?.error ? '错误' : plugin && !plugin.active ? '已停用' : plugin?.origin !== 'builtin' ? '已安装' : '';
      q(choice, '.renderer-state').textContent = label;
    }
    if (!list.querySelector('[aria-checked="true"]')) list.querySelector<HTMLButtonElement>('[data-renderer-choice]')?.setAttribute('tabindex', '0');
  });
  return { render: view.render, dispose() { controller.abort(); view.unsubscribe(); list.remove(); } };
}

/** Options of the selected renderer. */
export function mountRendererOptions(host: HTMLElement, { ctx, perform }: UiServices): View {
  const panel = html(`<section class="inspector-section">
      <header class="section-head"><h3 data-renderer-options-title>选项</h3><button class="button-link" data-renderer-reset>恢复默认</button></header>
      <div class="option-list" data-renderer-options></div>
      <p class="helper" data-renderer-options-empty hidden>这个渲染器没有额外选项。字体、颜色和显示细节在「文字」页签。</p>
    </section>`);
  host.append(panel);
  const controller = new AbortController(), { signal } = controller;
  const api = () => ctx.pluginManagement;
  const options = q(panel, '[data-renderer-options]');
  let optionsFor = '', optionsView: ConfigFieldsView | undefined;
  q(panel, '[data-renderer-reset]').addEventListener('click', () => void perform(() => api().resetConfig(ctx.getState().plugins.rendererId), '已恢复默认选项'), { signal });
  const view = structured(ctx, () => api().list().filter(p => p.rendererService), () => { optionsFor = ''; }, state => {
    const current = state.plugins.rendererId, plugin = api().list().find(p => p.id === current);
    if (optionsFor !== current) {
      optionsFor = current;
      optionsView = plugin?.fields?.length ? renderConfigFields(options, plugin, patch => void perform(() => api().configure(current, patch)), signal) : (options.replaceChildren(), undefined);
      q(panel, '[data-renderer-options-title]').textContent = plugin ? `${plugin.name} 选项` : '选项';
    }
    q(panel, '[data-renderer-options-empty]').hidden = Boolean(plugin?.fields?.length);
    q(panel, '[data-renderer-reset]').hidden = !plugin?.fields?.length;
    optionsView?.sync(state.plugins.configs[current]);
  });
  return { render: view.render, dispose() { controller.abort(); view.unsubscribe(); panel.remove(); } };
}

/** Effect plugins as cards: a switch each, and their options while running. */
export function mountEffects(host: HTMLElement, { ctx, perform }: UiServices): View {
  const list = html(`<div class="effect-list" data-effects></div>`);
  host.append(list);
  const controller = new AbortController(), { signal } = controller;
  const api = () => ctx.pluginManagement;
  const effects = () => api().list().filter(p => p.category === 'effect');
  const views = new Map<string, ConfigFieldsView>();
  list.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.effectToggle) void perform(() => api().setEnabled(input.dataset.effectToggle!, input.checked));
  }, { signal });
  const view = structured(ctx, effects, () => {
    list.replaceChildren(); views.clear();
    for (const plugin of effects()) {
      const card = html(`<article class="effect-card"><header class="effect-head"><span class="plugin-icon" aria-hidden="true"></span><div class="effect-title"><h3></h3><p></p></div><span class="option-control switch-host"><input class="switch" type="checkbox"><span class="switch-track" aria-hidden="true"></span></span></header><p class="inline-error" hidden></p><div class="option-list"></div></article>`);
      card.dataset.effectId = plugin.id;
      q(card, '.plugin-icon').style.background = swatch(plugin.id);
      q(card, 'h3').textContent = plugin.name; q(card, '.effect-title p').textContent = plugin.description;
      const toggle = q<HTMLInputElement>(card, 'input'); toggle.dataset.effectToggle = plugin.id; toggle.setAttribute('aria-label', `启用${plugin.name}`);
      const fields = q(card, '.option-list');
      if (plugin.active && plugin.fields?.length) views.set(plugin.id, renderConfigFields(fields, plugin, patch => void perform(() => api().configure(plugin.id, patch)), signal));
      else if (plugin.fields?.length) { fields.className = 'helper'; fields.textContent = '启用后可以调整选项。'; }
      else fields.remove();
      list.append(card);
    }
    if (!effects().length) list.append(html('<p class="empty-state">还没有特效插件。可以在「全部插件」导入 .lyrx 特效包。</p>'));
  }, state => {
    for (const plugin of effects()) {
      const card = list.querySelector<HTMLElement>(`[data-effect-id="${plugin.id}"]`);
      if (!card) continue;
      const toggle = q<HTMLInputElement>(card, '[data-effect-toggle]'); toggle.checked = plugin.active; toggle.disabled = plugin.busy;
      const error = q(card, '.inline-error'); error.hidden = !plugin.error; error.textContent = plugin.error ?? '';
      card.classList.toggle('is-off', !plugin.active);
      views.get(plugin.id)?.sync(state.plugins.configs[plugin.id]);
    }
  });
  return { render: view.render, dispose() { controller.abort(); view.unsubscribe(); list.remove(); } };
}
