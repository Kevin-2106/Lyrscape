import type { AppState, CatalogReport, PluginCategory, PluginManagement, PluginOrigin, PluginPackage, PluginStatus } from '../sdk/types';
import { packageFileName, packageFromModule, parsePackage, serializePackage } from '../plugins/package';
import { pluginStorage, saveExport } from '../plugins/storage';
import type { UiServices } from './context';
import { swatch } from './components/look-panel';
import { icons } from './icons';
import { renderConfigFields, type ConfigFieldsView } from './kit/config-fields';
import { confirmDialog } from './kit/dialog';
import { html, q } from './kit/dom';

export const categoryLabels: Record<PluginCategory, string> = {
  'audio-provider': '音频来源',
  'playback-adapter': '播放接入', 'lyric-parser': '歌词解析', 'timeline-provider': '时间轴',
  renderer: '渲染器', theme: '主题', effect: '特效', surface: '桌面视图', settings: '设置与管理',
};

/** Plugins grouped by the job they do for the user, not by internal category. */
export const pluginGroups: { id: string; label: string; icon: string; categories: PluginCategory[] }[] = [
  { id: 'look', label: '渲染器', icon: icons.palette, categories: ['renderer'] },
  { id: 'effects', label: '特效与音频', icon: icons.sparkle, categories: ['effect', 'audio-provider'] },
  { id: 'sources', label: '播放与解析', icon: icons.plug, categories: ['playback-adapter', 'lyric-parser', 'timeline-provider'] },
  { id: 'system', label: '系统组件', icon: icons.chip, categories: ['theme', 'surface', 'settings'] },
];
const groupOf = (category: PluginCategory) => pluginGroups.find(group => group.categories.includes(category))!;
const filters: { id: string; label: string; icon: string; test(plugin: PluginStatus): boolean; optional?: boolean }[] = [
  { id: 'installed', label: '已安装', icon: icons.box, test: plugin => plugin.origin !== 'builtin' },
  { id: 'disabled', label: '已停用', icon: icons.power, test: plugin => !plugin.active && !plugin.essential, optional: true },
  { id: 'problems', label: '需要处理', icon: icons.warning, test: plugin => Boolean(plugin.error), optional: true },
];

const originLabels: Record<PluginOrigin, string> = { builtin: '内置', source: '源码新增', local: '已安装' };
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** One-line summary of a rescan for the status message. */
export function describeReport(report: CatalogReport): string {
  const parts = [report.added.length && `新增 ${report.added.join('、')}`, report.updated.length && `更新说明 / 配置 ${report.updated.join('、')}`,
    report.removed.length && `移除 ${report.removed.join('、')}`].filter(Boolean) as string[];
  const failed = report.failed.map(item => `${item.id}：${item.error}`);
  return [parts.length ? `插件列表已更新：${parts.join('；')}` : '插件列表没有变化', ...failed.length ? [`未能加载 ${failed.join('；')}`] : []].join('。');
}

const bytes = (text: string) => { const size = new TextEncoder().encode(text).length; return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`; };

export interface PluginManagerHandle { (): void; reveal(target: string): void; focusSearch(): void }

/**
 * 全部插件: category navigation · list · details. Import (.lyrx / .mjs, picker or
 * drop), export, uninstall, hot reload and rescans live here; daily appearance
 * work has its own pages.
 */
export function mountPluginManager(root: HTMLElement, api: PluginManagement, state: () => AppState,
  subscribe: (fn: () => void) => () => void, services: Partial<Pick<UiServices, 'notify' | 'navigate' | 'confirm'>> = {}): PluginManagerHandle {
  const confirm = services.confirm ?? confirmDialog;
  root.innerHTML = `<div class="manager">
    <aside class="manager-nav" aria-label="插件分类">
      <label class="search-field">${icons.search}<span class="sr-only">搜索插件</span><input type="search" placeholder="搜索名称、说明或 ID" data-plugin-search></label>
      <div class="manager-groups" role="tablist" aria-orientation="vertical" data-plugin-groups></div>
      <div class="manager-actions">
        <button class="button-primary" data-plugin-import>${icons.importIcon}导入插件</button>
        <button class="button-secondary" data-plugin-folder hidden>${icons.folder}打开插件文件夹</button>
        <button class="button-secondary" data-plugin-rescan hidden title="读取插件目录：新增、移除插件，并应用名称、说明与配置项的变化">${icons.refresh}重新扫描</button>
        <input type="file" data-plugin-file accept=".lyrx,.json,.mjs,.js" hidden>
        <p class="helper manager-boundary">插件代码与应用同权限运行，没有沙箱隔离；只导入自己信任的插件。<span data-plugin-storage></span></p>
      </div>
    </aside>
    <section class="manager-list" aria-label="插件列表">
      <header class="pane-head"><h2 data-plugin-list-title>全部插件</h2><span class="pane-count plugin-count"></span></header>
      <p class="plugin-message" role="status" aria-live="polite" hidden></p>
      <div class="pane-scroll plugin-rows" role="listbox" aria-label="插件" data-plugin-rows></div>
      <p class="plugin-empty empty-state" hidden>没有匹配的插件。</p>
      <div class="drop-hint" aria-hidden="true">${icons.importIcon}<span>松开以导入插件</span></div>
    </section>
    <section class="manager-detail" aria-label="插件详情" data-plugin-detail-host></section>
  </div>`;
  const manager = q(root, '.manager');
  const search = q<HTMLInputElement>(root, '[data-plugin-search]');
  const groupsHost = q(root, '[data-plugin-groups]'), rows = q(root, '[data-plugin-rows]'), detailHost = q(root, '[data-plugin-detail-host]');
  const message = q(root, '.plugin-message');
  const controller = new AbortController(), { signal } = controller;
  let disposed = false, group = 'all', selected: string | undefined;
  let fieldsView: ConfigFieldsView | undefined;

  const say = (text: string, kind: 'info' | 'error' = 'info') => {
    if (disposed) return;
    message.textContent = text; message.hidden = !text; message.classList.toggle('is-error', kind === 'error');
  };
  const report = async (action: () => void | Promise<void>, success?: string) => {
    try { await action(); say(''); if (success) services.notify?.(success, 'success'); }
    catch (error) { say(error instanceof Error ? error.message : String(error), 'error'); }
    if (!disposed) render();
  };

  // Group navigation.
  const groupButton = (id: string, label: string, icon: string) => {
    const button = html<HTMLButtonElement>(`<button class="manager-group" role="tab" aria-selected="false"><span class="group-icon" aria-hidden="true">${icon}</span><span class="group-label"></span><span class="group-count"></span></button>`);
    button.dataset.pluginGroup = id; q(button, '.group-label').textContent = label;
    return button;
  };
  groupsHost.append(groupButton('all', '全部', icons.grid), ...pluginGroups.map(entry => groupButton(entry.id, entry.label, entry.icon)),
    html('<span class="manager-separator" role="presentation"></span>'), ...filters.map(entry => groupButton(entry.id, entry.label, entry.icon)));
  groupsHost.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-plugin-group]');
    if (button) { group = button.dataset.pluginGroup!; render(); }
  }, { signal });

  // Rescan, folder, storage label.
  const rescanSources: ('source' | 'local')[] = (import.meta.env.DEV ? ['source', 'local'] as const : ['local'] as const).filter(source => api.canRescan(source));
  const rescan = q<HTMLButtonElement>(root, '[data-plugin-rescan]');
  rescan.hidden = !rescanSources.length;
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    try {
      const reports: CatalogReport[] = [];
      for (const source of rescanSources) reports.push(await api.rescan(source));
      const merged = reports.reduce((all, next) => ({ added: [...all.added, ...next.added], updated: [...all.updated, ...next.updated], removed: [...all.removed, ...next.removed], unchanged: [...all.unchanged, ...next.unchanged], failed: [...all.failed, ...next.failed] }));
      say(describeReport(merged), merged.failed.length ? 'error' : 'info');
    } catch (error) { say(error instanceof Error ? error.message : String(error), 'error'); }
    finally { rescan.disabled = false; if (!disposed) render(); }
  }, { signal });
  const folder = q<HTMLButtonElement>(root, '[data-plugin-folder]');
  folder.hidden = !pluginStorage?.reveal || !api.canInstall?.();
  folder.addEventListener('click', () => void report(() => pluginStorage!.reveal!()), { signal });
  q(root, '[data-plugin-storage]').textContent = pluginStorage && api.canInstall?.() ? ` 已安装的插件保存在${pluginStorage.label}。` : '';

  // Import: picker, drop anywhere on the page.
  const picker = q<HTMLInputElement>(root, '[data-plugin-file]');
  const importButton = q<HTMLButtonElement>(root, '[data-plugin-import]');
  importButton.hidden = !api.canInstall?.();
  importButton.addEventListener('click', () => picker.click(), { signal });
  picker.addEventListener('change', () => { const file = picker.files?.[0]; picker.value = ''; if (file) void importFile(file); }, { signal });
  manager.addEventListener('dragover', event => {
    if (!api.canInstall?.() || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); manager.classList.add('is-dropping');
  }, { signal });
  manager.addEventListener('dragleave', event => { if (!manager.contains(event.relatedTarget as Node)) manager.classList.remove('is-dropping'); }, { signal });
  manager.addEventListener('drop', event => {
    event.preventDefault(); manager.classList.remove('is-dropping');
    const file = event.dataTransfer?.files[0];
    if (file && api.canInstall?.()) void importFile(file);
  }, { signal });

  async function importFile(file: File) {
    try {
      if (file.size > MAX_IMPORT_BYTES) throw Error('插件文件超过 5 MB');
      const text = await file.text();
      let pkg: PluginPackage;
      if (/\.m?js$/i.test(file.name)) {
        const ok = await confirm({ title: '读取未打包的插件模块？', body: `需要运行 ${file.name} 才能读出它的名称和配置。`, accept: '读取', warning: '模块代码会以应用权限运行。只打开自己信任的文件。' });
        if (!ok) return;
        pkg = await packageFromModule(text);
      } else pkg = await parsePackage(text);
      const { manifest } = pkg, existing = api.list().find(plugin => plugin.id === manifest.id);
      const accepted = await confirm({
        title: existing ? `更新「${manifest.name}」？` : `安装「${manifest.name}」？`,
        body: manifest.description,
        details: [['ID', manifest.id], ['版本', `${existing ? `${existing.version} → ` : ''}${manifest.version ?? '0.1.0'}`], ['类别', categoryLabels[manifest.category]],
          ...(manifest.author ? [['作者', manifest.author] as [string, string]] : []), ['大小', bytes(pkg.javascript + (pkg.css ?? ''))],
          ['完整性', pkg.integrity ? '已校验' : '未提供校验值'], ...(pkg.config ? [['附带配置', `${Object.keys(pkg.config).length} 项`] as [string, string]] : [])],
        warning: '插件代码与应用同权限运行，可以读取歌词与设置。只安装来自可信来源的插件。',
        accept: existing ? '更新' : '安装',
      });
      if (!accepted) return;
      const result = await api.install(pkg);
      selected = result.id; group = 'all';
      const text2 = `${result.action === 'updated' ? '已更新' : '已安装'}「${manifest.name}」`;
      say(''); services.notify?.(text2, 'success');
      render();
    } catch (error) { say(error instanceof Error ? error.message : String(error), 'error'); }
  }

  // List.
  const matches = (plugin: PluginStatus) => {
    const term = search.value.trim().toLowerCase();
    if (term && !`${plugin.name} ${plugin.id} ${plugin.description} ${plugin.author ?? ''} ${(plugin.tags ?? []).join(' ')}`.toLowerCase().includes(term)) return false;
    if (group === 'all') return true;
    const filter = filters.find(entry => entry.id === group);
    return filter ? filter.test(plugin) : groupOf(plugin.category).id === group;
  };
  rows.addEventListener('click', event => {
    const row = (event.target as Element).closest<HTMLElement>('[data-plugin-row]');
    if (row) { selected = row.dataset.pluginRow; render(); }
  }, { signal });
  rows.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const visible = [...rows.querySelectorAll<HTMLElement>('[data-plugin-row]')];
    const index = visible.findIndex(row => row.dataset.pluginRow === selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (!visible[next]) return;
    event.preventDefault(); selected = visible[next].dataset.pluginRow; render();
    rows.querySelector<HTMLElement>(`[data-plugin-row="${selected}"]`)?.focus();
  }, { signal });

  function rowFor(plugin: PluginStatus, current: string): HTMLElement {
    const row = html(`<div class="plugin-row" role="option" tabindex="-1"><span class="plugin-icon" aria-hidden="true"></span><span class="row-text"><span class="row-title"><strong></strong><span class="row-badges"></span></span><span class="row-desc"></span></span><span class="row-state"></span></div>`);
    row.dataset.pluginRow = plugin.id;
    const tile = q(row, '.plugin-icon');
    if (plugin.category === 'renderer' || plugin.category === 'effect') tile.style.background = swatch(plugin.id);
    else { tile.innerHTML = groupOf(plugin.category).icon; tile.classList.add('is-glyph'); }
    q(row, 'strong').textContent = plugin.name;
    q(row, '.row-desc').textContent = plugin.description;
    const badges = q(row, '.row-badges');
    const badge = (text: string, tone: string) => { const span = document.createElement('span'); span.className = `badge ${tone}`; span.textContent = text; badges.append(span); };
    if (plugin.rendererService && current === plugin.id) badge('使用中', 'is-accent');
    if (plugin.origin !== 'builtin') badge(originLabels[plugin.origin], 'is-installed');
    if (plugin.error) badge('错误', 'is-danger');
    const state = q(row, '.row-state');
    if (plugin.essential) { state.innerHTML = icons.lock; state.title = '基础组件，保持启用'; }
    else { state.className = `row-state status-dot ${plugin.active ? 'is-connected' : ''}`; state.title = plugin.active ? '已启用' : '已停用'; }
    row.classList.toggle('is-off', !plugin.active);
    row.setAttribute('aria-selected', String(plugin.id === selected));
    if (plugin.id === selected) row.tabIndex = 0;
    return row;
  }

  // Details.
  let detailKey = '';
  function buildDetail(plugin: PluginStatus | undefined) {
    fieldsView = undefined;
    if (!plugin) { detailHost.innerHTML = `<div class="empty-state detail-empty">${icons.plugins}<p>从列表中选择一个插件查看详情。</p></div>`; return; }
    const detail = html(`<article class="plugin-detail" data-plugin-detail>
      <header class="detail-head"><span class="plugin-icon is-large" aria-hidden="true"></span><div class="detail-title"><h3></h3><div class="detail-meta"><span class="plugin-version"></span><code class="plugin-id selectable"></code></div><div class="detail-badges"><span class="badge plugin-status"></span><span class="badge is-installed plugin-origin"></span><span class="badge plugin-category"></span></div></div></header>
      <div class="detail-actions">
        <button class="button-primary" data-plugin-use hidden>使用此渲染器</button>
        <button class="button-secondary" data-plugin-tune hidden>${icons.style}在渲染器页调整</button>
        <button class="button-secondary" data-plugin-toggle></button>
        <span class="action-group" data-reload-group hidden><select data-plugin-reload-source aria-label="热重载来源"><option value="source">${import.meta.env.DEV ? '当前开发源码' : '内置版本'}</option><option value="local">本地插件文件</option></select><button class="button-secondary" data-plugin-reload>${icons.refresh}热重载</button></span>
        <button class="button-secondary" data-plugin-export hidden>${icons.exportIcon}导出</button>
        <button class="button-ghost-danger" data-plugin-uninstall hidden>${icons.trash}卸载</button>
      </div>
      <p class="inline-error plugin-error" hidden></p>
      <p class="plugin-description"></p>
      <section class="detail-section" data-detail-config><header class="section-head"><h4>配置</h4><button class="button-link" data-plugin-reset>恢复默认</button></header><div class="option-list plugin-fields"></div></section>
      <section class="detail-section"><header class="section-head"><h4>详细信息</h4></header><dl class="facts detail-facts"></dl></section>
    </article>`);
    detail.dataset.pluginId = plugin.id; detail.dataset.pluginOrigin = plugin.origin;
    const tile = q(detail, '.plugin-icon');
    if (plugin.category === 'renderer' || plugin.category === 'effect') tile.style.background = swatch(plugin.id);
    else { tile.innerHTML = groupOf(plugin.category).icon; tile.classList.add('is-glyph'); }
    q(detail, 'h3').textContent = plugin.name;
    q(detail, '.plugin-version').textContent = `v${plugin.version}`;
    q(detail, '.plugin-id').textContent = plugin.id;
    const origin = q(detail, '.plugin-origin'); origin.textContent = originLabels[plugin.origin]; origin.hidden = plugin.origin === 'builtin';
    q(detail, '.plugin-category').textContent = categoryLabels[plugin.category];
    q(detail, '.plugin-description').textContent = plugin.description;
    q(detail, '[data-plugin-use]').hidden = !plugin.rendererService;
    q(detail, '[data-plugin-tune]').hidden = !plugin.rendererService || !services.navigate;
    q(detail, '[data-reload-group]').hidden = !plugin.reloadable;
    const source = q<HTMLSelectElement>(detail, '[data-plugin-reload-source]');
    if (state().isDesktop && !import.meta.env.DEV) source.value = 'local';
    q<HTMLOptionElement>(source, '[value="local"]').disabled = !pluginStorage;
    q(detail, '[data-plugin-export]').hidden = !plugin.exportable;
    q(detail, '[data-plugin-uninstall]').hidden = !plugin.removable;
    const config = q(detail, '[data-detail-config]');
    if (plugin.fields?.length) fieldsView = renderConfigFields(q(detail, '.plugin-fields'), plugin, patch => void report(() => api.configure(plugin.id, patch)), signal);
    else {
      q(detail, '[data-plugin-reset]').remove();
      const note = document.createElement('p'); note.className = 'helper';
      note.textContent = plugin.category === 'theme' ? '文字颜色与字体在「渲染器 › 文字」中配置。' : '此插件没有独立配置项。';
      q(detail, '.plugin-fields').replaceWith(note);
    }
    config.hidden = false;
    const facts = q(detail, '.detail-facts');
    const fact = (label: string, value: string | undefined, className = '') => {
      if (!value) return;
      const term = document.createElement('dt'), data = document.createElement('dd');
      term.textContent = label; data.textContent = value; if (className) data.className = className; facts.append(term, data);
    };
    fact('分组', groupOf(plugin.category).label === categoryLabels[plugin.category] ? categoryLabels[plugin.category] : `${groupOf(plugin.category).label} · ${categoryLabels[plugin.category]}`);
    fact('来源', plugin.origin === 'builtin' ? '随应用内置' : plugin.origin === 'local' ? `已安装 · ${pluginStorage?.label ?? '本地文件'}` : '开发源码目录');
    fact('作者', plugin.author); fact('许可', plugin.license); fact('主页', plugin.homepage, 'selectable');
    fact('标签', plugin.tags?.join('、'));
    fact('运行窗口', (plugin.surfaces ?? (plugin.category === 'renderer' || plugin.category === 'effect' ? ['control', 'overlay'] : ['control'])).map(s => s === 'control' ? '控制面板' : '桌面歌词').join('、'));
    fact('依赖', plugin.requires.join('、') || '无', 'plugin-dependencies selectable');
    fact('提供服务', '…', 'plugin-services selectable');
    detailHost.replaceChildren(detail);
  }
  detailHost.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    const id = button?.closest<HTMLElement>('[data-plugin-detail]')?.dataset.pluginId;
    if (!button || !id || button.disabled) return;
    const plugin = api.list().find(p => p.id === id);
    if (!plugin) return;
    if (button.matches('[data-plugin-toggle]')) void report(() => api.setEnabled(id, !plugin.active));
    else if (button.matches('[data-plugin-use]')) void report(() => api.selectRenderer(id));
    else if (button.matches('[data-plugin-tune]')) { void report(() => { if (plugin.active) api.selectRenderer(id); }); services.navigate?.('renderers', 'options'); }
    else if (button.matches('[data-plugin-reload]')) void report(() => api.reload(id, q<HTMLSelectElement>(detailHost, '[data-plugin-reload-source]').value as 'source' | 'local'));
    else if (button.matches('[data-plugin-reset]')) void report(() => api.resetConfig(id));
    else if (button.matches('[data-plugin-export]')) void report(async () => {
      const pkg = await api.exportPackage(id);
      const path = await saveExport(packageFileName(pkg.manifest), serializePackage(pkg));
      services.notify?.(path ? `已导出到 ${path}` : `已导出 ${packageFileName(pkg.manifest)}`, 'success');
    });
    else if (button.matches('[data-plugin-uninstall]')) void confirm({ title: `卸载「${plugin.name}」？`, body: '插件会在两个窗口中停止，文件和它的配置会被删除。', accept: '卸载', danger: true })
      .then(ok => { if (ok) void report(() => api.uninstall(id), `已卸载「${plugin.name}」`); });
  }, { signal });

  function syncDetail(plugin: PluginStatus, current: AppState['plugins']) {
    const detail = detailHost.querySelector<HTMLElement>('[data-plugin-detail]');
    if (!detail) return;
    const inUse = Boolean(plugin.rendererService) && current.rendererId === plugin.id;
    detail.classList.toggle('is-current', inUse);
    const status = q(detail, '.plugin-status');
    status.textContent = plugin.busy ? '正在切换…' : inUse ? '使用中' : plugin.essential ? '基础组件' : plugin.active ? '已启用' : plugin.error ? '启动失败' : '已停用';
    status.className = `badge plugin-status ${inUse ? 'is-accent' : plugin.error ? 'is-danger' : plugin.active ? 'is-ok' : ''}`;
    const toggle = q<HTMLButtonElement>(detail, '[data-plugin-toggle]');
    toggle.innerHTML = `${plugin.essential ? icons.lock : icons.power}<span>${plugin.essential ? '基础组件' : plugin.active ? '停用' : '启用'}</span>`;
    toggle.setAttribute('aria-label', `启停 ${plugin.name}`);
    toggle.disabled = Boolean(plugin.essential) || plugin.busy;
    toggle.title = plugin.essential ? '基础组件需保持启用，保障预览和管理入口。' : '';
    const use = q<HTMLButtonElement>(detail, '[data-plugin-use]');
    use.textContent = inUse ? '正在使用' : '使用此渲染器'; use.disabled = inUse || !plugin.active || plugin.busy;
    const reload = q<HTMLButtonElement>(detail, '[data-plugin-reload]');
    reload.disabled = !plugin.active || plugin.busy; reload.title = plugin.reloadRevision ? `已成功热重载 ${plugin.reloadRevision} 次` : '修改后手动应用；加载或激活失败时恢复上一版';
    q<HTMLSelectElement>(detail, '[data-plugin-reload-source]').disabled = plugin.busy;
    for (const selector of ['[data-plugin-export]', '[data-plugin-uninstall]']) q<HTMLButtonElement>(detail, selector).disabled = plugin.busy;
    const error = q(detail, '.plugin-error'); error.hidden = !plugin.error; error.textContent = plugin.error ?? '';
    detail.querySelector('.plugin-services')!.textContent = plugin.provides.join('、') || (plugin.active ? 'UI / 管理入口' : '未激活');
    fieldsView?.sync(current.configs[plugin.id]);
  }

  // Rendering: rows and details are rebuilt only when the list or metadata changes,
  // so playback updates don't steal focus or reset scroll.
  let rowsKey = '';
  const metaOf = (plugins: PluginStatus[]) => JSON.stringify(plugins.map(p => [p.id, p.name, p.description, p.version, p.category, p.origin, p.rendererService, p.fields, p.reloadable, p.exportable, p.removable, p.author, p.license, p.homepage, p.tags, p.requires]));
  function render() {
    if (disposed) return;
    const plugins = api.list(), current = state().plugins;
    const visible = plugins.filter(matches);
    if (!selected || !plugins.some(p => p.id === selected)) selected = (plugins.find(p => p.id === current.rendererId) ?? visible[0] ?? plugins[0])?.id;
    for (const button of groupsHost.querySelectorAll<HTMLButtonElement>('[data-plugin-group]')) {
      const id = button.dataset.pluginGroup!, filter = filters.find(entry => entry.id === id);
      const count = id === 'all' ? plugins.length : filter ? plugins.filter(filter.test).length : plugins.filter(p => groupOf(p.category).id === id).length;
      q(button, '.group-count').textContent = String(count);
      button.setAttribute('aria-selected', String(id === group));
      button.hidden = Boolean(filter?.optional) && count === 0 && group !== id;
    }
    const title = group === 'all' ? '全部插件' : pluginGroups.find(entry => entry.id === group)?.label ?? filters.find(entry => entry.id === group)?.label ?? '';
    q(root, '[data-plugin-list-title]').textContent = title;
    q(root, '.plugin-count').textContent = `${visible.filter(p => p.active).length} / ${visible.length} 已启用`;
    const nextRows = JSON.stringify([metaOf(visible), group, current.rendererId, selected, visible.map(p => [p.active, p.error, p.busy])]);
    if (nextRows !== rowsKey) {
      rowsKey = nextRows;
      const scroll = rows.scrollTop;
      rows.replaceChildren();
      if (group === 'all' && !search.value.trim()) {
        for (const entry of pluginGroups) {
          const members = visible.filter(p => groupOf(p.category).id === entry.id);
          if (!members.length) continue;
          const heading = html(`<div class="row-heading" role="presentation"><span></span><span class="group-count"></span></div>`);
          q(heading, 'span').textContent = entry.label; q(heading, '.group-count').textContent = String(members.length);
          rows.append(heading, ...members.map(plugin => rowFor(plugin, current.rendererId)));
        }
      } else rows.append(...visible.map(plugin => rowFor(plugin, current.rendererId)));
      rows.scrollTop = scroll;
    }
    q(root, '.plugin-empty').hidden = visible.length > 0;
    const plugin = plugins.find(p => p.id === selected);
    const nextDetail = plugin ? JSON.stringify([selected, metaOf([plugin])]) : '';
    if (nextDetail !== detailKey) { detailKey = nextDetail; buildDetail(plugin); }
    if (plugin) syncDetail(plugin, current);
  }
  search.addEventListener('input', render, { signal });
  let preferences = state().plugins;
  const unmanage = api.subscribe(render), unstate = subscribe(() => {
    const next = state().plugins;
    if (next !== preferences) { preferences = next; render(); }
  });
  render();
  const edited = () => say('插件源码已修改：点击对应插件的「热重载」应用代码；新增或删除插件、修改名称 / 配置项请点「重新扫描」。');
  import.meta.hot?.on('lyrscape:plugin-edited', edited);
  const dispose = () => { disposed = true; import.meta.hot?.off?.('lyrscape:plugin-edited', edited); controller.abort(); unmanage(); unstate(); root.replaceChildren(); };
  return Object.assign(dispose, {
    reveal(target: string) {
      if (target === 'import') { if (api.canInstall?.()) picker.click(); return; }
      if (target.startsWith('group:')) { group = target.slice(6); render(); return; }
      if (api.list().some(p => p.id === target)) { selected = target; group = 'all'; search.value = ''; render(); }
    },
    focusSearch() { search.focus(); search.select(); },
  });
}
