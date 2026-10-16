import type { AppState } from '../../sdk/types';
import { rendererName } from '../../plugins/management';
import type { UiServices } from '../context';
import { html, q } from '../kit/dom';
import { setSelected } from '../kit/fields';
import { createPreview } from './preview';

const BACKDROP_KEY = 'lyrscape.ui.backdrop';
type Backdrop = 'dark' | 'light' | 'grid';

/**
 * Live preview pane with the renderer name and a backdrop switch: desktop lyrics
 * float over any wallpaper, so a style has to read on light and busy backgrounds too.
 */
export function mountStage(host: HTMLElement, { ctx, navigate }: UiServices, previewId = 'lyrics-preview') {
  const pane = html(`<section class="stage-pane" aria-label="歌词预览">
    <div class="stage-toolbar">
      <button class="stage-renderer" data-stage-renderer title="切换渲染器"><span class="live-dot" aria-hidden="true"></span><span data-stage-label></span></button>
      <div class="segmented compact" role="group" aria-label="预览背景"><button data-backdrop="dark">深色</button><button data-backdrop="light">浅色</button><button data-backdrop="grid">透明</button></div>
    </div>
    <div class="preview-stage" data-backdrop-surface><div class="preview-root" id="${previewId}" aria-label="歌词预览"></div></div>
  </section>`);
  host.append(pane);
  // The 歌词 page's label is the one other views and tests refer to.
  if (previewId === 'lyrics-preview') q(pane, '[data-stage-label]').setAttribute('data-renderer-label', '');
  const preview = createPreview(q(pane, `#${previewId}`), ctx);
  let backdrop: Backdrop = 'dark';
  try { const saved = localStorage.getItem(BACKDROP_KEY); if (saved === 'light' || saved === 'grid') backdrop = saved; } catch { /* optional */ }
  const applyBackdrop = () => {
    q(pane, '[data-backdrop-surface]').dataset.backdrop = backdrop;
    setSelected(pane.querySelectorAll<HTMLButtonElement>('[data-backdrop]'), button => button.dataset.backdrop === backdrop);
  };
  applyBackdrop();
  const controller = new AbortController();
  pane.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (button?.dataset.backdrop) {
      backdrop = button.dataset.backdrop as Backdrop; applyBackdrop();
      try { localStorage.setItem(BACKDROP_KEY, backdrop); } catch { /* optional */ }
    } else if (button?.matches('[data-stage-renderer]')) navigate('renderers');
  }, { signal: controller.signal });
  return {
    render(state: AppState) { q(pane, '[data-stage-label]').textContent = rendererName(ctx.pluginManagement, state.plugins.rendererId) ?? '普通文字'; },
    activate: preview.activate, deactivate: preview.deactivate,
    dispose() { controller.abort(); preview.deactivate(); pane.remove(); },
  };
}
