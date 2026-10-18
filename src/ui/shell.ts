import type { AppState } from '../sdk/types';
import type { PageId, PageInstance, UiContext, UiServices } from './context';
import { mountTransport } from './components/transport';
import { icons } from './icons';
import { confirmDialog } from './kit/dialog';
import { html, isEditable, q } from './kit/dom';
import { createToaster } from './kit/toast';
import { pages } from './pages';
import { createRouter } from './router';
import { pageOrder } from './shortcuts';

const connectionLabels: Record<string, string> = { connected: 'AMLL 已连接', listening: 'AMLL 等待连接', connecting: 'AMLL 启动中', disconnected: 'AMLL 等待连接', error: 'AMLL 连接异常' };

/** Sidebar menu: first-level groups with their pages as second-level entries. */
function navMarkup(): string {
  const groups = [...new Set(pages.map(page => page.group))];
  return groups.map(group => `<div class="nav-group"><span class="nav-heading">${group}</span>${pages.filter(page => page.group === group).map(page => {
    const index = pages.indexOf(page);
    return `<a class="nav-item" href="#/${page.id}" data-nav="${page.id}" title="${page.title} (Ctrl+${index + 1})">${page.icon}<span class="nav-label">${page.title}</span><kbd class="nav-key">${index + 1}</kbd></a>`;
  }).join('')}</div>`).join('');
}

/** Application frame: sidebar navigation, toolbar, routed full-height pages, transport bar, toasts and shortcuts. */
export function mountApp(root: HTMLElement, ctx: UiContext): () => void {
  const frame = html(`<div class="app-frame">
    <aside class="sidebar">
      <a class="wordmark" href="#/lyrics" aria-label="Lyrscape"><span class="brand-icon" aria-hidden="true">L</span><span class="wordmark-text">Lyrscape<span class="wordmark-caption">让歌词成为风景</span></span></a>
      <nav class="nav" aria-label="主导航">${navMarkup()}</nav>
      <span class="sidebar-version" data-runtime></span>
    </aside>
    <div class="content">
      <header class="toolbar">
        <div class="toolbar-title"><h1 data-page-title></h1><p data-page-subtitle></p></div>
        <div class="toolbar-actions">
          <button class="status-chip" data-chip="connection" title="播放来源"><span class="status-dot" data-chip-dot></span><span class="chip-text" data-chip-text></span></button>
          <button class="overlay-quick" data-overlay-quick aria-pressed="false"><span class="overlay-quick-icon" aria-hidden="true">${icons.overlay}</span><span data-overlay-quick-text>桌面歌词</span><span class="quick-switch" aria-hidden="true"></span></button>
        </div>
      </header>
      <main class="workspace" data-scroll tabindex="-1"></main>
      <footer class="transport-host" data-transport></footer>
    </div>
    <div data-toasts></div>
  </div>`);
  root.replaceChildren(frame);

  const toaster = createToaster(q(frame, '[data-toasts]'));
  const workspace = q(frame, '[data-scroll]');
  let disposed = false;

  const services: UiServices = {
    ctx,
    notify: toaster.notify,
    async perform(action, success) {
      try { await action(); if (success) toaster.notify(success, 'success'); return true; }
      catch (error) { toaster.notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
    },
    navigate(id, target) { router.go(id); if (target) instances.get(id)?.reveal?.(target); },
    confirm: confirmDialog,
  };

  const instances = new Map<PageId, PageInstance>();
  const sections = new Map<PageId, HTMLElement>();
  for (const page of pages) {
    const section = html(`<section class="page page-${page.id}" id="page-${page.id}" aria-label="${page.title}" hidden></section>`);
    workspace.append(section); sections.set(page.id, section);
    instances.set(page.id, page.mount(section, services));
  }
  const transport = mountTransport(q(frame, '[data-transport]'), services);

  let activeId: PageId | undefined;
  const router = createRouter(pages.map(page => page.id), id => {
    if (disposed) return;
    if (activeId) { instances.get(activeId)?.deactivate?.(); sections.get(activeId)!.hidden = true; }
    activeId = id;
    const page = pages.find(entry => entry.id === id)!;
    sections.get(id)!.hidden = false;
    q(frame, '[data-page-title]').textContent = page.title;
    q(frame, '[data-page-subtitle]').textContent = page.subtitle;
    document.title = `${page.title} — Lyrscape`;
    frame.querySelectorAll<HTMLElement>('[data-nav]').forEach(link => {
      if (link.dataset.nav === id) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    instances.get(id)!.render(ctx.getState());
    instances.get(id)!.activate?.();
  });

  const chip = q<HTMLButtonElement>(frame, '[data-chip="connection"]');
  chip.addEventListener('click', () => services.navigate('lyrics', 'source'));
  const quick = q<HTMLButtonElement>(frame, '[data-overlay-quick]');
  quick.addEventListener('click', () => void services.perform(() => ctx.overlay(ctx.getState().overlay.visible ? 'hide' : 'show')));

  function render(state: AppState): void {
    if (disposed) return;
    transport.render(state);
    if (activeId) instances.get(activeId)!.render(state);
    const status = String(state.connection.status);
    const amllOn = state.plugins.enabled['official.adapter.amll'] !== false;
    const amll = state.adapterId === 'amll';
    if (state.adapterId === 'smtc') {
      const media = state.media;
      q(chip, '[data-chip-dot]').className = `status-dot ${media?.error ? 'is-error' : media?.available ? 'is-connected' : 'is-waiting'}`;
      q(chip, '[data-chip-text]').textContent = media?.available ? `SMTC · ${media.source}` : 'SMTC 等待媒体';
    } else {
      q(chip, '[data-chip-dot]').className = `status-dot ${amll && status === 'connected' ? 'is-connected' : amll && status === 'error' ? 'is-error' : amll ? 'is-waiting' : ''}`;
      q(chip, '[data-chip-text]').textContent = amll ? (!amllOn ? 'AMLL 已停用' : connectionLabels[status] ?? 'AMLL 未启动') : '本地演示';
    }
    chip.dataset.chip = 'connection';
    quick.setAttribute('aria-pressed', String(state.overlay.visible));
    quick.classList.toggle('is-on', state.overlay.visible);
    quick.disabled = !state.isDesktop;
    quick.title = state.isDesktop ? `${state.overlay.visible ? '隐藏' : '显示'}桌面歌词 (${state.shortcuts?.find(b => b.action === 'visibility')?.accelerator || '未绑定快捷键'})` : '桌面歌词需要在桌面应用中运行';
    q(quick, '[data-overlay-quick-text]').textContent = state.overlay.visible ? '桌面歌词 · 开' : '桌面歌词';
    q(frame, '[data-runtime]').textContent = state.isDesktop ? `v${ctx.appVersion}` : '浏览器';
    if (state.error !== lastError) { lastError = state.error; if (state.error) toaster.notify(state.error, 'error'); }
  }
  let lastError: string | undefined;

  const go = (offset: number) => {
    const order = pageOrder.filter(id => sections.has(id));
    router.go(order[(order.indexOf(router.current()) + offset + order.length) % order.length]);
  };
  const seekBy = (delta: number) => {
    const state = ctx.getState();
    if (state.adapterId !== 'demo') return;
    void services.perform(() => ctx.seek((ctx.getPosition?.() ?? state.playback.positionMs) + delta));
  };

  const controller = new AbortController();
  const { signal } = controller;
  document.addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]')) return;
    const mod = event.ctrlKey || event.metaKey;
    const target = event.target as Element | null;
    const interactive = Boolean(target?.closest?.('button, summary, select, input, textarea, [contenteditable], [role="option"], [role="tab"]'));
    if (mod && /^[1-9]$/.test(event.key) && Number(event.key) <= pages.length) { event.preventDefault(); router.go(pages[Number(event.key) - 1].id); }
    else if (mod && event.key === 'Tab') { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
    else if (mod && event.key.toLowerCase() === 'o') { event.preventDefault(); router.go('lyrics'); instances.get('lyrics')?.commands?.import?.(); }
    else if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); router.go('plugins'); instances.get('plugins')?.commands?.search?.(); }
    else if (!mod && !event.altKey && !isEditable(target)) {
      if (event.key === ' ' && !interactive) { event.preventDefault(); void services.perform(() => ctx.setPlaying(!ctx.getState().playback.playing)); }
      else if (event.key === 'Home' && !interactive) { event.preventDefault(); void services.perform(() => ctx.seek(0)); }
      else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !interactive) { event.preventDefault(); seekBy(event.key === 'ArrowLeft' ? -5000 : 5000); }
    }
    // A packaged app has no page to refresh or devtools-style reload.
    if (import.meta.env.PROD && ctx.getState().isDesktop && (event.key === 'F5' || (mod && event.key.toLowerCase() === 'r'))) event.preventDefault();
  }, { signal });
  // Keep the browser's own menu only where editing needs it; stop stray file drops from navigating away.
  document.addEventListener('contextmenu', event => { if (!isEditable(event.target)) event.preventDefault(); }, { signal });
  for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, event => event.preventDefault(), { signal });

  render(ctx.getState());
  const unsubscribe = ctx.subscribe(render);
  router.start();
  const timer = window.setInterval(() => { if (!disposed) transport.tick(); }, 200);

  return () => {
    disposed = true; window.clearInterval(timer); controller.abort(); router.stop(); unsubscribe();
    activeId && instances.get(activeId)?.deactivate?.();
    instances.forEach(instance => instance.dispose());
    transport.dispose(); toaster.dispose(); root.replaceChildren();
  };
}
