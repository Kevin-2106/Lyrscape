import type { Plugin } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, Renderer, Timeline } from '../sdk/types';
import { desktop, dragOverlay, native, onEvent, sendEvent } from '../platform';

export interface OverlaySurface { update(status: AppState['overlay']): Promise<void> }

export function overlaySurfacePlugin(root: HTMLElement, store: Store<AppState>, isOverlay: boolean): Plugin {
  return {
    id: 'official.surface.overlay', requires: ['renderer@1', 'timeline@1'],
    async activate(ctx) {
      ctx.provide<OverlaySurface>('surface.overlay@1', {
        async update(status) {
          await native('overlay_update', { visible: status.visible, clickThrough: status.clickthrough, alwaysOnTop: status.alwaysOnTop });
        },
      });
      if (!isOverlay) return;
      document.body.classList.add('overlay-page');
      document.documentElement.classList.add('overlay-mode');
      const canvas = document.createElement('div'); root.replaceChildren(canvas);
      ctx.own(ctx.service<Renderer>('renderer@1').mount(canvas, () => store.get(), ctx.service<Timeline>('timeline@1')));
      if (desktop) {
        let previousHeight = 0;
        const fit = new ResizeObserver(() => {
          const height = Math.max(90, Math.ceil(canvas.scrollHeight));
          if (height !== previousHeight) {
            previousHeight = height;
            void native('overlay_fit', { height }).catch(console.error);
          }
        });
        fit.observe(canvas); ctx.own(() => fit.disconnect());
      }
      ctx.own(await onEvent<{ state: AppState; sentAtEpochMs: number; sampleAgeMs: number }>('lyrscape-state', ({ state, sentAtEpochMs, sampleAgeMs }) => {
        const transit = Math.max(0, Math.min(1000, Date.now() - sentAtEpochMs));
        store.set({ ...state, playback: { ...state.playback, observedAtMonoMs: performance.now() - sampleAgeMs - transit } });
      }));
      const drag = () => { if (!store.get().overlay.clickthrough) void dragOverlay().catch(console.error); };
      root.addEventListener('pointerdown', drag); ctx.own(() => root.removeEventListener('pointerdown', drag));
      const refresh = () => void sendEvent('lyrscape-state-request').catch(console.error);
      window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
      ctx.own(() => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); });
      await sendEvent('lyrscape-state-request');
    },
  };
}
