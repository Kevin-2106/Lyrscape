import type { AppState, CatalogReport, ConfigValue, PluginCategory, PluginManagement, PluginOrigin, PluginStatus } from '../sdk/types';

export const categoryLabels: Record<PluginCategory, string> = {
  'audio-provider': '音频来源',
  'playback-adapter': '播放接入', 'lyric-parser': '歌词解析', 'timeline-provider': '时间轴',
  renderer: '歌词渲染', theme: '主题', effect: '特效', surface: '桌面视图', settings: '设置与管理',
};

const originLabels: Record<PluginOrigin, string> = { builtin: '内置', source: '源码新增', local: '本地文件' };

/** One-line summary of a rescan for the status message. */
export function describeReport(report: CatalogReport): string {
  const parts = [report.added.length && `新增 ${report.added.join('、')}`, report.updated.length && `更新说明 / 配置 ${report.updated.join('、')}`,
    report.removed.length && `移除 ${report.removed.join('、')}`].filter(Boolean) as string[];
  const failed = report.failed.map(item => `${item.id}：${item.error}`);
  return [parts.length ? `插件列表已更新：${parts.join('；')}` : '插件列表没有变化', ...failed.length ? [`未能加载 ${failed.join('；')}`] : []].join('。');
}

export function mountPluginManager(root: HTMLElement, api: PluginManagement, state: () => AppState,
  subscribe: (fn: () => void) => () => void): () => void {
  root.innerHTML = `<div class="plugin-toolbar"><label class="sr-only" for="plugin-search">搜索插件</label><input id="plugin-search" type="text" placeholder="搜索插件名称或 ID" data-plugin-search><label class="sr-only" for="plugin-filter">插件分类</label><select id="plugin-filter" data-plugin-filter><option value="all">全部分类</option></select><span class="plugin-count"></span><button class="button-secondary" data-plugin-rescan hidden title="读取插件目录：新增、移除插件，并应用名称、说明与配置项的变化">重新扫描插件列表</button></div>
    <div class="plugin-list"></div><p class="plugin-empty helper" hidden>没有匹配的插件。</p><p class="plugin-message" role="status" aria-live="polite" hidden></p>
    <p class="helper plugin-boundary">管理内置插件、开发源码目录与 exe 旁 plugins 文件夹中的可信插件；插件代码与应用同权限运行，没有沙箱隔离，只放入自己信任的文件。</p>`;
  const search = root.querySelector<HTMLInputElement>('[data-plugin-search]')!;
  const filter = root.querySelector<HTMLSelectElement>('[data-plugin-filter]')!;
  Object.entries(categoryLabels).forEach(([value, label]) => { const option = new Option(label, value); filter.add(option); });
  const list = root.querySelector<HTMLElement>('.plugin-list')!;
  const message = root.querySelector<HTMLElement>('.plugin-message')!;
  const controller = new AbortController(), { signal } = controller;
  let disposed = false;
  const cards = new Map<string, HTMLElement>();
  const report = async (action: () => void | Promise<void>) => {
    try { await action(); if (!disposed) { message.hidden = true; message.textContent = ''; } }
    catch (error) { if (!disposed) { message.textContent = error instanceof Error ? error.message : String(error); message.hidden = false; } }
    if (!disposed) render();
  };
  const rescanSource: 'source' | 'local' = import.meta.env.DEV ? 'source' : 'local';
  const rescan = root.querySelector<HTMLButtonElement>('[data-plugin-rescan]')!;
  rescan.hidden = !api.canRescan(rescanSource);
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    try {
      const report = await api.rescan(rescanSource);
      if (!disposed) { message.textContent = describeReport(report); message.hidden = false; }
    } catch (error) { if (!disposed) { message.textContent = error instanceof Error ? error.message : String(error); message.hidden = false; } }
    finally { rescan.disabled = false; if (!disposed) render(); }
  }, { signal });
  // Cards are rebuilt only when the list or a plugin's metadata changes, so playback
  // updates don't steal focus or collapse configuration.
  let structure = '';
  const structureOf = (plugins: PluginStatus[]) => JSON.stringify(plugins.map(p => [p.id, p.name, p.description, p.version, p.category, p.origin, p.rendererService, p.fields, p.reloadable]));
  const buildCards = (plugins: PluginStatus[]) => {
  const open = new Set([...cards].filter(([, card]) => card.querySelector('details')?.open).map(([id]) => id));
  cards.clear(); list.replaceChildren();
  for (const plugin of plugins) {
    const card = document.createElement('article'); card.className = 'plugin-card'; card.dataset.pluginId = plugin.id;
    card.innerHTML = `<div class="plugin-card-top"><span class="plugin-category"></span><span class="plugin-origin"></span><span class="plugin-status"></span></div>
      <div class="plugin-card-title"><h3></h3><span class="plugin-version"></span></div><p class="plugin-description"></p><code class="plugin-id"></code>
      <div class="plugin-actions"><button class="button-secondary" data-plugin-toggle></button><button class="button-primary" data-plugin-use hidden>使用此渲染器</button><select data-plugin-reload-source hidden aria-label="热重载来源"><option value="source">${import.meta.env.DEV ? '当前开发源码' : '内置版本'}</option><option value="local">本地插件文件</option></select><button class="button-secondary" data-plugin-reload hidden>热重载</button></div>
      <p class="inline-error plugin-error" hidden></p><details class="plugin-details"><summary>配置与依赖</summary><div class="plugin-fields"></div><p class="helper plugin-dependencies"></p><p class="helper plugin-services"></p></details>`;
    card.querySelector('.plugin-category')!.textContent = categoryLabels[plugin.category];
    const origin = card.querySelector<HTMLElement>('.plugin-origin')!;
    origin.textContent = originLabels[plugin.origin]; origin.hidden = plugin.origin === 'builtin'; card.dataset.pluginOrigin = plugin.origin;
    if (open.has(plugin.id)) card.querySelector('details')!.open = true;
    card.querySelector('h3')!.textContent = plugin.name;
    card.querySelector('.plugin-version')!.textContent = `v${plugin.version}`;
    card.querySelector('.plugin-description')!.textContent = plugin.description;
    card.querySelector('.plugin-id')!.textContent = plugin.id;
    const toggle = card.querySelector<HTMLButtonElement>('[data-plugin-toggle]')!;
    toggle.setAttribute('aria-label', `启停 ${plugin.name}`);
    toggle.addEventListener('click', () => void report(() => api.setEnabled(plugin.id, !api.list().find(p => p.id === plugin.id)!.active)), { signal });
    const use = card.querySelector<HTMLButtonElement>('[data-plugin-use]')!;
    use.hidden = !plugin.rendererService;
    use.addEventListener('click', () => void report(() => api.selectRenderer(plugin.id)), { signal });
    const reloadSource = card.querySelector<HTMLSelectElement>('[data-plugin-reload-source]')!;
    reloadSource.hidden = !plugin.reloadable;
    if (state().isDesktop && !import.meta.env.DEV) reloadSource.value = 'local';
    reloadSource.querySelector<HTMLOptionElement>('[value="local"]')!.disabled = !state().isDesktop;
    const reload = card.querySelector<HTMLButtonElement>('[data-plugin-reload]')!;
    reload.hidden = !plugin.reloadable;
    reload.addEventListener('click', () => void report(() => api.reload(plugin.id, reloadSource.value as 'source' | 'local')), { signal });
    const fields = card.querySelector<HTMLElement>('.plugin-fields')!;
    for (const field of plugin.fields ?? []) {
      const label = document.createElement('label'); label.className = 'field plugin-field';
      const caption = document.createElement('span'); caption.textContent = field.label; label.append(caption);
      const input = field.type === 'select' ? document.createElement('select') : document.createElement('input');
      input.dataset.pluginConfig = field.key; input.setAttribute('aria-label', `${plugin.name} ${field.label}`);
      if (input instanceof HTMLSelectElement) for (const option of field.options ?? []) input.add(new Option(option.label, option.value));
      else {
        input.type = field.type === 'boolean' ? 'checkbox' : 'number';
        if (field.type === 'number') { input.min = String(field.min); input.max = String(field.max); input.step = String(field.step ?? 1); input.required = true; }
      }
      label.append(input);
      if (field.description) { const note = document.createElement('small'); note.textContent = field.description; label.append(note); }
      input.addEventListener('change', () => {
        if (input instanceof HTMLInputElement && !input.checkValidity()) { input.reportValidity(); return; }
        const value: ConfigValue = input instanceof HTMLSelectElement ? input.value : input.type === 'checkbox' ? input.checked : Number(input.value);
        void report(() => api.configure(plugin.id, { [field.key]: value }));
      }, { signal });
      fields.append(label);
    }
    if (plugin.fields?.length) {
      const reset = document.createElement('button'); reset.className = 'button-link'; reset.textContent = '恢复此插件默认配置';
      reset.dataset.pluginReset = ''; reset.addEventListener('click', () => void report(() => api.resetConfig(plugin.id)), { signal }); fields.append(reset);
    } else { const note = document.createElement('p'); note.className = 'helper'; note.textContent = plugin.category === 'theme' ? '文字颜色与字体在右侧样式面板配置。' : '此插件没有独立配置项。'; fields.append(note); }
    cards.set(plugin.id, card); list.append(card);
  }
  };
  function render() {
    if (disposed) return;
    const plugins = api.list(), current = state().plugins;
    const next = structureOf(plugins);
    if (next !== structure) { structure = next; buildCards(plugins); }
    let visible = 0;
    for (const plugin of plugins) {
      const card = cards.get(plugin.id)!;
      card.hidden = (filter.value !== 'all' && plugin.category !== filter.value) || !`${plugin.name} ${plugin.id} ${plugin.description}`.toLowerCase().includes(search.value.trim().toLowerCase());
      if (!card.hidden) visible++;
      const selected = Boolean(plugin.rendererService) && current.rendererId === plugin.id;
      card.classList.toggle('is-current', selected);
      card.querySelector('.plugin-status')!.textContent = plugin.busy ? '正在切换…' : selected ? '当前使用' : plugin.active ? '已启用' : plugin.error ? '启动失败' : '已停用';
      const toggle = card.querySelector<HTMLButtonElement>('[data-plugin-toggle]')!;
      toggle.textContent = plugin.essential ? '基础组合' : plugin.active ? '停用' : '启用';
      toggle.disabled = Boolean(plugin.essential) || plugin.busy;
      toggle.title = plugin.essential ? '当前基础组合需保持启用，保障预览和管理入口。' : '';
      const use = card.querySelector<HTMLButtonElement>('[data-plugin-use]')!;
      use.textContent = selected ? '正在使用' : '使用此渲染器'; use.disabled = selected || !plugin.active || plugin.busy;
      const reload = card.querySelector<HTMLButtonElement>('[data-plugin-reload]')!;
      reload.disabled = !plugin.active || plugin.busy; reload.title = plugin.reloadRevision ? `已成功热重载 ${plugin.reloadRevision} 次` : '修改后手动应用；加载或激活失败时恢复上一版';
      card.querySelector<HTMLSelectElement>('[data-plugin-reload-source]')!.disabled = plugin.busy;
      const error = card.querySelector<HTMLElement>('.plugin-error')!; error.hidden = !plugin.error; error.textContent = plugin.error ?? '';
      card.querySelector('.plugin-dependencies')!.textContent = `依赖：${plugin.requires.join('、') || '无'}`;
      card.querySelector('.plugin-services')!.textContent = `服务：${plugin.provides.join('、') || (plugin.active ? 'UI / 管理入口' : '未激活')}`;
      card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-plugin-config]').forEach(input => {
        const value = current.configs[plugin.id]?.[input.dataset.pluginConfig!];
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
        else if (document.activeElement !== input) input.value = String(value ?? '');
      });
    }
    root.querySelector('.plugin-count')!.textContent = `${plugins.filter(p => p.active).length} / ${plugins.length} 已启用`;
    root.querySelector<HTMLElement>('.plugin-empty')!.hidden = visible > 0;
  }
  search.addEventListener('input', render, { signal }); filter.addEventListener('change', render, { signal });
  let preferences = state().plugins;
  const unmanage = api.subscribe(render), unstate = subscribe(() => {
    const next = state().plugins;
    if (next !== preferences) { preferences = next; render(); }
  }); render();
  const edited = () => { message.textContent = '插件源码已修改：点击对应插件的「热重载」应用代码；新增或删除插件、修改名称 / 配置项请点「重新扫描插件列表」。'; message.hidden = false; };
  import.meta.hot?.on('lyrscape:plugin-edited', edited);
  return () => { disposed = true; import.meta.hot?.off?.('lyrscape:plugin-edited', edited); controller.abort(); unmanage(); unstate(); root.replaceChildren(); };
}
