import type { AppState, ConfigField, PluginStatus } from '../../sdk/types';
import { defaults } from '../../plugins/theme';
import type { UiServices } from '../context';
import { icons } from '../icons';
import { renderConfigFields, type ConfigFieldsView } from '../kit/config-fields';
import { html, q } from '../kit/dom';
import { mountTextPanel, sectionKeys, type ThemeSection } from './text-panel';

/** A stable two-color tile per plugin, so lists read at a glance without screenshots. */
export function swatch(id: string): string {
  if (id === 'official.renderer.text') return 'linear-gradient(135deg,#d9dcea,#7d8296)';
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 50) % 360} 65% 42%))`;
}

interface View { render(state: AppState): void; dispose(): void }
const keyOf = (plugins: PluginStatus[]) => JSON.stringify(plugins.map(p => [p.id, p.name, p.description, p.fields, p.theme, p.active, p.category, p.origin]));

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

const GROUP_ORDER = ['选项', '构图', '动效', '特效', '字体', '颜色', '显示'];
const TAB_IDS: Record<string, string> = { 选项: 'options', 构图: 'layout', 动效: 'motion', 特效: 'effects', 颜色: 'color', 字体: 'font', 显示: 'display' };
const SECTION_TAB: Record<ThemeSection, string> = { font: '字体', color: '颜色', display: '显示' };
interface InspectorTab { id: string; label: string; fields: ConfigField[]; sections: ThemeSection[] }

/**
 * Tabs for one renderer: its options grouped by `field.group`, plus the shared
 * text-theme sections it actually follows (字体 / 颜色 only for theme-driven
 * renderers; 显示 for every renderer) merged into the tab of the same name.
 */
export function inspectorTabs(plugin: Pick<PluginStatus, 'fields' | 'theme'> | undefined): InspectorTab[] {
  const tabs = new Map<string, InspectorTab>();
  const tab = (label: string) => {
    let entry = tabs.get(label);
    if (!entry) { entry = { id: TAB_IDS[label] ?? `group-${tabs.size}`, label, fields: [], sections: [] }; tabs.set(label, entry); }
    return entry;
  };
  for (const field of plugin?.fields ?? []) tab(field.group ?? '选项').fields.push(field);
  const uses = plugin?.theme ?? ['font', 'color', 'nextLine'];
  const sections: ThemeSection[] = [...uses.includes('font') ? ['font' as const] : [], ...uses.includes('color') ? ['color' as const] : [], 'display'];
  for (const section of sections) tab(SECTION_TAB[section]).sections.push(section);
  const rank = (label: string) => { const index = GROUP_ORDER.indexOf(label); return index < 0 ? GROUP_ORDER.length - 1.5 : index; };
  return [...tabs.values()].sort((a, b) => rank(a.label) - rank(b.label));
}

export interface InspectorView extends View { reveal(target: string): boolean }

/**
 * Settings of the selected renderer, one tab per category. Rebuilt only when the
 * renderer or its option metadata changes; preference updates just sync values.
 */
export function mountRendererInspector(host: HTMLElement, services: UiServices): InspectorView {
  const { ctx, perform } = services;
  const tablist = html(`<div class="tabs inspector-tabs" role="tablist" aria-label="设置分类"></div>`);
  const body = html(`<div class="inspector-body"></div>`);
  const intro = html(`<p class="inspector-intro" data-renderer-intro></p>`);
  host.append(tablist, body);
  const controller = new AbortController(), { signal } = controller;
  const api = () => ctx.pluginManagement;
  let views: { tab: InspectorTab; config?: ConfigFieldsView; text?: ReturnType<typeof mountTextPanel>; panel: HTMLElement; reset: HTMLButtonElement }[] = [];
  let builtFor = '', selected = 'options';
  const select = (id: string) => {
    const known = views.find(view => view.tab.id === id) ?? views[0];
    if (!known) return;
    selected = known.tab.id;
    tablist.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]').forEach(button => {
      const on = button.dataset.inspectorTab === selected;
      button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1;
    });
    for (const view of views) view.panel.hidden = view.tab.id !== selected;
  };
  const clear = () => { for (const view of views) view.text?.dispose(); views = []; tablist.replaceChildren(); body.replaceChildren(); };
  const build = (state: AppState) => {
    clear();
    const id = state.plugins.rendererId, plugin = api().list().find(p => p.id === id);
    const tabs = inspectorTabs(plugin);
    intro.textContent = plugin?.theme && !plugin.theme.length ? '这个渲染器自带字体与配色；共享的文字设置只有「显示」页。' : '';
    body.append(intro);
    for (const tab of tabs) {
      const button = html<HTMLButtonElement>(`<button role="tab" type="button"></button>`);
      button.dataset.inspectorTab = tab.id; button.textContent = tab.label;
      button.id = `inspector-tab-${tab.id}`;
      tablist.append(button);
      const panel = html(`<div role="tabpanel" class="inspector-panel"></div>`);
      panel.dataset.inspectorPanel = tab.id; panel.setAttribute('aria-labelledby', button.id);
      let config: ConfigFieldsView | undefined, text: ReturnType<typeof mountTextPanel> | undefined;
      if (tab.fields.length && plugin) {
        const section = html(`<section class="inspector-section"><div class="option-list" data-renderer-options></div></section>`);
        // The tab names the category; a heading only separates renderer options from shared ones.
        if (tab.sections.length) {
          const head = html(`<header class="section-head"><h3></h3></header>`);
          q(head, 'h3').textContent = `${tab.label} · 渲染器`; section.prepend(head);
        }
        panel.append(section);
        config = renderConfigFields(q(section, '[data-renderer-options]'), { ...plugin, fields: tab.fields }, patch => void perform(() => api().configure(id, patch)), signal);
      }
      if (tab.sections.length) {
        const holder = html('<div></div>'); panel.append(holder);
        text = mountTextPanel(holder, services, tab.sections, !plugin?.theme || plugin.theme.includes('nextLine'));
      }
      const footer = html<HTMLElement>(`<div class="form-footer"><span class="helper">自动保存，同步到桌面歌词</span><button class="button-secondary" data-inspector-reset>${icons.reset}恢复本页默认</button></div>`);
      panel.append(footer);
      const reset = q<HTMLButtonElement>(footer, '[data-inspector-reset]');
      reset.addEventListener('click', () => void perform(async () => {
        if (tab.fields.length) await api().configure(id, Object.fromEntries(tab.fields.map(field => [field.key, field.default])));
        const keys = tab.sections.flatMap(section => sectionKeys[section]);
        if (keys.length) await ctx.updateSettings(Object.fromEntries(keys.map(key => [key, defaults[key]])));
      }, '已恢复本页默认值'), { signal });
      body.append(panel);
      views.push({ tab, config, text, panel, reset });
    }
    select(selected);
  };
  tablist.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-inspector-tab]');
    if (button) select(button.dataset.inspectorTab!);
  }, { signal });
  tablist.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const index = views.findIndex(view => view.tab.id === selected);
    if (index < 0) return;
    select(views[(index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length].tab.id);
    tablist.querySelector<HTMLButtonElement>(`[data-inspector-tab="${selected}"]`)?.focus();
  }, { signal });
  const refresh = (state: AppState) => {
    const stored = state.plugins.configs[builtFor] ?? {};
    for (const item of views) {
      item.config?.sync(state.plugins.configs[builtFor]);
      item.text?.render(state);
      item.reset.disabled = !item.tab.fields.some(field => stored[field.key] !== undefined && stored[field.key] !== field.default)
        && !item.tab.sections.some(section => sectionKeys[section].some(key => state.settings[key] !== defaults[key]));
    }
  };
  const view = structured(ctx, () => api().list().filter(p => p.rendererService), () => { builtFor = ''; }, state => {
    if (builtFor !== state.plugins.rendererId) { builtFor = state.plugins.rendererId; build(state); }
    refresh(state);
  });
  // Shared text settings are not plugin preferences; keep their sections current too.
  let settings: AppState['settings'] | undefined;
  return {
    render(state) {
      view.render(state);
      if (state.settings !== settings) { settings = state.settings; refresh(state); }
    },
    reveal(target) {
      const id = target === 'text' ? (views.find(item => item.tab.id === 'font') ?? views.find(item => item.tab.id === 'display'))?.tab.id : target === 'options' ? views[0]?.tab.id : target;
      if (!id || !views.some(item => item.tab.id === id)) return false;
      select(id); return true;
    },
    dispose() { controller.abort(); view.unsubscribe(); clear(); tablist.remove(); body.remove(); },
  };
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
