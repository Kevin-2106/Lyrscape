import type { AppState } from '../sdk/types';
import type { PageId, PageInstance, UiContext, UiServices } from './context';
import { mountTransport } from './components/transport';
import { confirmDialog } from './kit/dialog';
import { html, isEditable, q } from './kit/dom';
import { createToaster } from './kit/toast';
import { pages } from './pages';
import { createRouter } from './router';
import { pageOrder } from './shortcuts';

const connectionLabels: Record<string, string> = { connected: '已连接', listening: '等待连接', connecting: '正在启动', disconnected: '等待连接', error: '连接异常' };

/** Application frame: sidebar navigation, routed pages, persistent transport bar, toasts and shortcuts. */
export function mountApp(root: HTMLElement, ctx: UiContext): () => void {
  const frame = html(`<div class="app-frame">
    <aside class="sidebar">
      <a class="wordmark" href="#/lyrics" aria-label="Lyrscape"><span class="brand-icon" aria-hidden="true">L</span><span class="wordmark-text">Lyrscape<span class="wordmark-caption">让歌词成为风景</span></span></a>
      <nav class="nav" aria-label="主导航">${pages.map((page, index) =>
        `<a class="nav-item" href="#/${page.id}" data-nav="${page.id}" title="${page.title} (Ctrl+${index + 1})">${page.icon}<span class="nav-label">${page.title}</span></a>`).join('')}</nav>
      <div class="sidebar-status" aria-label="状态">
        <div class="status-chip" data-chip="connection" title="AMLL 连接"><span class="status-dot" data-chip-dot></span><span class="chip-text" data-chip-text></span></div>
        <div class="status-chip" data-chip="overlay" title="桌面歌词"><span class="status-dot" data-chip-dot></span><span class="chip-text" data-chip-text></span></div>
        <span class="runtime-label" data-runtime></span>
      </div>
    </aside>
    <div class="content">
      <header class="content-header"><div><h1 data-page-title></h1><p data-page-subtitle></p></div></header>
      <main class="page-scroll" data-scroll tabindex="-1"></main>
      <footer class="transport-host" data-transport></footer>
    </div>
    <div data-toasts></div>
  </div>`);
  root.replaceChildren(frame);

  const toaster = createToaster(q(frame, '[data-toasts]'));
  const scroller = q(frame, '[data-scroll]');
  let disposed = false;

  const services: UiServices = {
    ctx,
    notify: toaster.notify,
    async perform(action, success) {
      try { await action(); if (success) toaster.notify(success, 'success'); return true; }
      catch (error) { toaster.notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
    },
    navigate: id => router.go(id),
    confirm: confirmDialog,
  };

  const instances = new Map<PageId, PageInstance>();
  const sections = new Map<PageId, HTMLElement>();
  for (const page of pages) {
    const section = html(`<section class="page" id="page-${page.id}" aria-label="${page.title}" hidden></section>`);
    scroller.append(section); sections.set(page.id, section);
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
    scroller.scrollTop = 0;
    q(frame, '[data-page-title]').textContent = page.title;
    q(frame, '[data-page-subtitle]').textContent = page.subtitle;
    document.title = `${page.title} — Lyrscape`;
    frame.querySelectorAll<HTMLElement>('[data-nav]').forEach(link => {
      if (link.dataset.nav === id) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    instances.get(id)!.render(ctx.getState());
    instances.get(id)!.activate?.();
  });

  function chip(name: string, state: 'on' | 'error' | 'off', text: string): void {
    const element = q(frame, `[data-chip="${name}"]`);
    q(element, '[data-chip-dot]').className = `status-dot ${state === 'on' ? 'is-connected' : state === 'error' ? 'is-error' : ''}`;
    q(element, '[data-chip-text]').textContent = text;
  }
  function render(state: AppState): void {
    if (disposed) return;
    transport.render(state);
    if (activeId) instances.get(activeId)!.render(state);
    const status = String(state.connection.status);
    const amllOn = state.plugins.enabled['official.adapter.amll'] !== false;
    chip('connection', status === 'connected' ? 'on' : status === 'error' ? 'error' : 'off',
      !amllOn ? 'AMLL 已停用' : state.adapterId === 'amll' ? (connectionLabels[status] ?? 'AMLL 未启动') : 'AMLL 未使用');
    chip('overlay', state.overlay.visible ? 'on' : 'off', state.overlay.visible ? '桌面歌词显示中' : '桌面歌词未显示');
    q(frame, '[data-runtime]').textContent = state.isDesktop ? '桌面应用' : '浏览器预览';
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
    const interactive = Boolean(target?.closest?.('button, summary, select, input, textarea, [contenteditable]'));
    if (mod && /^[1-9]$/.test(event.key) && Number(event.key) <= pages.length) { event.preventDefault(); router.go(pages[Number(event.key) - 1].id); }
    else if (mod && event.key === 'Tab') { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
    else if (mod && event.key.toLowerCase() === 'o') { event.preventDefault(); router.go('lyrics'); instances.get('lyrics')?.commands?.import?.(); }
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
