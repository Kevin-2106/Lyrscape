import type { Plugin } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, Renderer, Timeline } from '../sdk/types';
import { desktop, dragOverlay, resizeOverlay, native, onEvent, sendEvent } from '../platform';

type NativeOverlayStatus = { visible: boolean; clickThrough: boolean; alwaysOnTop: boolean; borderVisible: boolean };
export interface OverlaySurface { update(status: Partial<AppState['overlay']>): Promise<void> }

export function overlaySurfacePlugin(root: HTMLElement, store: Store<AppState>, isOverlay: boolean): Plugin {
  return {
    id: 'official.surface.overlay', requires: ['renderer@1', 'timeline@1'],
    async activate(ctx) {
      ctx.provide<OverlaySurface>('surface.overlay@1', {
        async update(status) {
          const result = await native<NativeOverlayStatus>('overlay_update', { visible: status.visible, clickThrough: status.clickthrough, alwaysOnTop: status.alwaysOnTop, borderVisible: status.borderVisible });
          store.update(s => ({ ...s, overlay: { visible: result.visible, clickthrough: result.clickThrough, alwaysOnTop: result.alwaysOnTop, borderVisible: result.borderVisible } }));
        },
      });
      if (desktop) {
        const apply = (status: NativeOverlayStatus) => store.update(s => ({ ...s, overlay: { visible: status.visible, clickthrough: status.clickThrough, alwaysOnTop: status.alwaysOnTop, borderVisible: status.borderVisible } }));
        ctx.own(await onEvent<NativeOverlayStatus>('overlay-status', apply));
        apply(await native<NativeOverlayStatus>('overlay_status'));
      }
      if (!isOverlay) return;
      document.body.classList.add('overlay-page');
      document.documentElement.classList.add('overlay-mode');
      const canvas = document.createElement('div'); root.replaceChildren(canvas);
      const border = document.createElement('div'); border.className = 'overlay-adjustment-border'; border.setAttribute('aria-hidden', 'true'); root.append(border);
      let unmount: (() => void) | undefined;
      const syncVisibility = () => {
        if (!desktop || store.get().overlay.visible) {
          unmount ??= ctx.service<Renderer>('renderer@1').mount(canvas, () => store.get(), ctx.service<Timeline>('timeline@1'));
        } else { unmount?.(); unmount = undefined; }
      };
      syncVisibility(); ctx.own(store.subscribe(syncVisibility));
      ctx.own(() => { unmount?.(); unmount = undefined; });
      const handles: HTMLDivElement[] = [];
      for (const direction of ['West', 'East'] as const) {
        const handle = document.createElement('div');
        handle.className = `overlay-resize-handle resize-${direction.toLowerCase()}`;
        handle.dataset.resizeDirection = direction;
        handle.title = '拖动边缘调整歌词宽度';
        handle.setAttribute('aria-hidden', 'true');
        const resize = (event: PointerEvent) => {
          if (event.button !== 0 || store.get().overlay.clickthrough) return;
          event.preventDefault(); event.stopPropagation();
          void resizeOverlay(direction).catch(console.error);
        };
        handle.addEventListener('pointerdown', resize);
        ctx.own(() => handle.removeEventListener('pointerdown', resize));
        handles.push(handle); root.append(handle);
      }
      const updateHandles = () => {
        border.hidden = !store.get().overlay.borderVisible;
        root.classList.toggle('show-adjustment-border', Boolean(store.get().overlay.borderVisible));
        for (const handle of handles) handle.hidden = store.get().overlay.clickthrough;
      };
      updateHandles(); ctx.own(store.subscribe(updateHandles));
      if (desktop) {
        let previousHeight = 0;
        const fit = new ResizeObserver(() => {
          // Animated transforms can change scrollHeight without changing layout.
          const height = Math.max(90, Math.ceil(canvas.getBoundingClientRect().height));
          if (height !== previousHeight) {
            previousHeight = height;
            void native('overlay_fit', { height }).catch(console.error);
          }
        });
        fit.observe(canvas); ctx.own(() => fit.disconnect());
      }
      ctx.own(await onEvent<{ state: AppState; sentAtEpochMs: number; sampleAgeMs: number }>('lyrscape-state', ({ state, sentAtEpochMs, sampleAgeMs }) => {
        const transit = Math.max(0, Math.min(1000, Date.now() - sentAtEpochMs));
        // Structured transport clones objects. Preserve an unchanged document's identity
        // so periodic anchors don't replay entrance animations or rebuild word nodes.
        const previousLyrics = store.get().lyrics;
        const lyrics = JSON.stringify(previousLyrics) === JSON.stringify(state.lyrics) ? previousLyrics : state.lyrics;
        store.set({ ...state, lyrics, playback: { ...state.playback, observedAtMonoMs: performance.now() - sampleAgeMs - transit } });
      }));
      ctx.own(await onEvent<{ playback: AppState['playback']; sentAtEpochMs: number; sampleAgeMs: number }>('lyrscape-playback', ({ playback, sentAtEpochMs, sampleAgeMs }) => {
        const transit = Math.max(0, Math.min(1000, Date.now() - sentAtEpochMs));
        store.update(state => ({ ...state, playback: { ...playback, observedAtMonoMs: performance.now() - sampleAgeMs - transit } }));
      }));
      const drag = (event: PointerEvent) => {
        if (event.button === 0 && !store.get().overlay.clickthrough && !(event.target instanceof Element && event.target.closest('[data-resize-direction]'))) void dragOverlay().catch(console.error);
      };
      root.addEventListener('pointerdown', drag); ctx.own(() => root.removeEventListener('pointerdown', drag));
      const refresh = () => void sendEvent('lyrscape-state-request').catch(console.error);
      window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
      ctx.own(() => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); });
      await sendEvent('lyrscape-state-request');
    },
  };
}
