import type { AppState } from '../../sdk/types';
import type { UiServices } from '../context';
import { icons } from '../icons';
import { formatTime, html, q } from '../kit/dom';

/** Always-visible playback bar. Position is sampled on a timer; everything else follows state. */
export function mountTransport(host: HTMLElement, { ctx, perform }: UiServices): { render(state: AppState): void; tick(): void; dispose(): void } {
  const bar = html(`<div class="transport">
    <div class="transport-track"><span class="track-icon" aria-hidden="true">${icons.lyrics}</span><div class="track-text"><strong data-track-title></strong><span data-track-artists></span></div></div>
    <div class="transport-center">
      <div class="transport-buttons">
        <button class="icon-button" data-restart title="回到开头" aria-label="回到开头">${icons.restart}</button>
        <button class="play-button" data-play aria-label="播放" title="播放 / 暂停 (空格)"><span data-play-icon aria-hidden="true">${icons.play}</span><span data-play-text>播放</span></button>
      </div>
      <div class="seek-row"><span data-position>0:00</span><input class="seek-input" type="range" data-seek min="0" max="180000" step="100" value="0" aria-label="播放位置"><span data-duration>3:00</span></div>
    </div>
    <div class="transport-side"><span class="source-badge" data-source-label></span><span class="transport-hint" data-transport-hint></span></div>
  </div>`);
  host.append(bar);
  const seek = q<HTMLInputElement>(bar, '[data-seek]');
  const controller = new AbortController();
  const { signal } = controller;
  let lastPlaying: boolean | undefined;

  seek.addEventListener('input', () => void perform(() => ctx.seek(Number(seek.value))), { signal });
  bar.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.matches('[data-play]')) void perform(() => ctx.setPlaying(!ctx.getState().playback.playing));
    else if (button.matches('[data-restart]')) void perform(() => ctx.seek(0));
  }, { signal });

  function tick(): void {
    const state = ctx.getState();
    const duration = Math.max(1, state.track.durationMs ?? 180000);
    const elapsed = Math.max(0, performance.now() - state.playback.observedAtMonoMs);
    const delta = state.adapterId === 'amll' ? Math.min(elapsed, 5000) : elapsed;
    const fallback = state.playback.positionMs + (state.playback.playing ? delta * state.playback.rate : 0);
    const position = Math.max(0, Math.min(state.track.durationMs ?? Number.MAX_SAFE_INTEGER, ctx.getPosition?.() ?? fallback));
    seek.max = String(duration);
    if (document.activeElement !== seek) seek.value = String(position);
    seek.style.setProperty('--progress', `${Math.min(100, position / duration * 100)}%`);
    q(bar, '[data-position]').textContent = formatTime(position);
    q(bar, '[data-duration]').textContent = state.track.durationMs ? formatTime(state.track.durationMs) : state.adapterId === 'demo' ? formatTime(duration) : '--:--';
  }

  function render(state: AppState): void {
    const { track, playback } = state, local = state.adapterId === 'demo';
    q(bar, '[data-track-title]').textContent = track.title || '等待歌曲';
    q(bar, '[data-track-artists]').textContent = (Array.isArray(track.artists) ? track.artists.join(' / ') : String(track.artists ?? '')) || 'Lyrscape 本地演示';
    q(bar, '[data-source-label]').textContent = local ? 'DEMO' : 'AMLL';
    q(bar, '[data-transport-hint]').textContent = local ? '本地演示播放' : '由 AMLL 控制播放';
    if (lastPlaying !== playback.playing) {
      lastPlaying = playback.playing;
      q(bar, '[data-play-icon]').innerHTML = playback.playing ? icons.pause : icons.play;
    }
    q(bar, '[data-play-text]').textContent = playback.playing ? '暂停' : '播放';
    q(bar, '[data-play]').setAttribute('aria-label', playback.playing ? '暂停' : '播放');
    q<HTMLButtonElement>(bar, '[data-play]').disabled = !local;
    q<HTMLButtonElement>(bar, '[data-restart]').disabled = !local;
    seek.disabled = !local;
    tick();
  }

  return { render, tick, dispose() { controller.abort(); bar.remove(); } };
}
