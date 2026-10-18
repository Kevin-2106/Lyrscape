import type { AdapterId, AppState, MediaSessionInfo } from '../../sdk/types';
import type { UiServices } from '../context';
import { AMLL_ADAPTER, SMTC_ADAPTER } from '../../plugins/management';
import { formatTime, html, q } from '../kit/dom';
import { setSelected, setValue } from '../kit/fields';

const statusLabels: Record<string, string> = {
  idle: '未启动', stopped: '未启动', disconnected: '等待连接', connecting: '正在启动', listening: '等待连接',
  connected: '已连接', error: '连接异常', unavailable: '桌面应用中可用',
};

const lookupLabels: Record<MediaSessionInfo['lookup']['state'], string> = { idle: '等待曲目', searching: '正在搜索歌词…', found: '已找到歌词', none: '没有找到歌词', error: '搜索失败' };
const providerLabels = { lrclib: 'LRCLIB', netease: '网易云音乐' };
const mediaStatus: Record<string, string> = { playing: '播放中', paused: '已暂停', stopped: '已停止', changing: '切换中', opened: '已打开', closed: '已关闭' };

/** Playback source switcher plus the AMLL server and SMTC controls. */
export function mountSourcePanel(host: HTMLElement, { ctx, perform, notify }: UiServices): { render(state: AppState): void; dispose(): void } {
  const card = html(`<section class="card source-card">
    <div class="card-title"><h2>播放来源</h2><span class="subtle">Adapter</span></div>
    <div class="segmented source-tabs" role="group" aria-label="选择播放来源"><button data-adapter="demo">本地演示</button><button data-adapter="amll">AMLL 连接</button><button data-adapter="smtc" title="Windows 系统媒体控制（SMTC）">系统媒体</button></div>
    <div class="connection-panel" data-amll-panel hidden>
      <div class="connection-status"><span class="status-dot" data-status-dot></span><span data-connection-status>未启动</span><span data-clients></span></div>
      <div class="connection-actions"><label class="port-field">监听端口<input type="number" data-port min="1024" max="65535" value="11444" aria-label="AMLL WebSocket 监听端口"></label><button class="button-secondary" data-connect>启动服务</button><button class="button-secondary" data-disconnect>停止</button></div>
      <p class="helper">在支持 AMLL 协议的播放器插件中填入 <code data-endpoint>ws://127.0.0.1:11444</code>。播放、歌词和时间进度由连接提供。</p>
      <p class="inline-error" data-connection-error hidden></p>
    </div>
    <div class="connection-panel" data-smtc-panel hidden>
      <div class="connection-status"><span class="status-dot" data-smtc-dot></span><span data-smtc-status>等待媒体</span><span data-smtc-app></span></div>
      <label class="port-field smtc-session">媒体会话<select data-smtc-session aria-label="读取哪个应用的系统媒体会话"><option value="">跟随系统当前会话</option></select></label>
      <div class="lookup-row"><span data-lookup-status>等待曲目</span><button class="button-secondary" data-research>重新搜索</button></div>
      <p class="helper" data-lookup-message hidden></p>
      <ol class="candidate-list" data-candidates aria-label="歌词候选"></ol>
      <p class="helper">进度来自 Windows 系统媒体控制，部分应用（例如浏览器）不报告进度。曲名、歌手、专辑和时长会发送给 LRCLIB / 网易云音乐搜索歌词；来源、译文与偏移在插件管理中调整。</p>
    </div>
  </section>`);
  host.append(card);
  const port = q<HTMLInputElement>(card, '[data-port]');
  const controller = new AbortController();
  const { signal } = controller;

  port.addEventListener('input', () => { q(card, '[data-endpoint]').textContent = `ws://127.0.0.1:${port.value}`; }, { signal });
  card.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.dataset.adapter) void perform(() => ctx.selectAdapter(button.dataset.adapter as AdapterId));
    else if (button.matches('[data-research]')) void perform(() => ctx.smtc?.research());
    else if (button.dataset.candidate) void perform(() => ctx.smtc?.choose(button.dataset.candidate!));
    else if (button.matches('[data-connect]')) {
      const value = Number(port.value);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) notify('端口需要是 1024–65535 之间的整数。', 'error');
      else void perform(() => { ctx.pluginManagement.configure(AMLL_ADAPTER, { port: value }); return ctx.startAmll(value); });
    } else if (button.matches('[data-disconnect]')) void perform(() => ctx.stopAmll());
  }, { signal });
  const session = q<HTMLSelectElement>(card, '[data-smtc-session]');
  session.addEventListener('change', () => void perform(() => ctx.smtc?.selectSession(session.value || undefined)), { signal });

  let shownCandidates: unknown, shownSessions = '';
  function renderMedia(media: MediaSessionInfo | undefined): void {
    const lookup: MediaSessionInfo['lookup'] = media?.lookup ?? { state: 'idle', candidates: [] };
    q(card, '[data-smtc-dot]').className = `status-dot ${media?.error ? 'is-error' : media?.available ? 'is-connected' : ''}`;
    q(card, '[data-smtc-status]').textContent = media?.error ? `读取失败：${media.error}` : media?.available ? mediaStatus[media.status] ?? media.status : '没有媒体会话';
    q(card, '[data-smtc-app]').textContent = media?.available ? media.source : '';
    const sessions = media?.sessions ?? [];
    const options = [...new Set([...sessions, ...media?.selected ? [media.selected] : []])];
    if (options.join('\n') !== shownSessions) {
      shownSessions = options.join('\n');
      session.replaceChildren(new Option('跟随系统当前会话', ''), ...options.map(id => new Option(id, id)));
    }
    if (document.activeElement !== session) session.value = media?.selected ?? '';
    const result = lookup.result;
    q(card, '[data-lookup-status]').textContent = lookup.state === 'found' && result
      ? `${providerLabels[result.provider]} · ${result.title}${result.synced === false ? '（无时间）' : ''}${lookup.cached ? ' · 缓存' : ''}` : lookupLabels[lookup.state];
    q(card, '[data-lookup-message]').textContent = lookup.message ?? '';
    q(card, '[data-lookup-message]').hidden = !lookup.message;
    q<HTMLButtonElement>(card, '[data-research]').disabled = lookup.state === 'searching' || !media?.available;
    if (lookup.candidates !== shownCandidates || card.dataset.result !== (result?.key ?? '')) {
      shownCandidates = lookup.candidates; card.dataset.result = result?.key ?? '';
      // Search results are outside data: written as text only.
      q(card, '[data-candidates]').replaceChildren(...lookup.candidates.slice(0, 8).map(candidate => {
        const item = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.dataset.candidate = candidate.key;
        button.className = `candidate${candidate.key === result?.key ? ' is-selected' : ''}`;
        const title = document.createElement('strong'); title.textContent = candidate.title;
        const meta = document.createElement('span');
        meta.textContent = [candidate.artists.join(' / '), candidate.durationMs ? formatTime(candidate.durationMs) : '', providerLabels[candidate.provider], `匹配 ${Math.round(candidate.score * 100)}%`].filter(Boolean).join(' · ');
        button.append(title, meta); item.append(button);
        return item;
      }));
    }
  }

  function render(state: AppState): void {
    const { connection } = state, status = String(connection.status);
    setSelected(card.querySelectorAll<HTMLButtonElement>('[data-adapter]'), button => button.dataset.adapter === state.adapterId);
    card.querySelectorAll<HTMLButtonElement>('[data-adapter]').forEach(button => {
      button.disabled = button.dataset.adapter === 'amll' ? state.plugins.enabled[AMLL_ADAPTER] === false
        : button.dataset.adapter === 'smtc' ? !state.isDesktop || state.plugins.enabled[SMTC_ADAPTER] === false : false;
    });
    q(card, '[data-amll-panel]').hidden = state.adapterId !== 'amll';
    q(card, '[data-smtc-panel]').hidden = state.adapterId !== 'smtc';
    if (state.adapterId === 'smtc') renderMedia(state.media);
    q(card, '[data-connection-status]').textContent = statusLabels[status] ?? status;
    q(card, '[data-status-dot]').className = `status-dot ${status === 'connected' ? 'is-connected' : status === 'error' ? 'is-error' : ''}`;
    q(card, '[data-clients]').textContent = connection.clients > 0 ? `${connection.clients} 个客户端` : '';
    q(card, '[data-connection-error]').textContent = connection.error ?? '';
    q(card, '[data-connection-error]').hidden = !connection.error;
    setValue(port, state.plugins.configs[AMLL_ADAPTER]?.port ?? connection.port);
    q(card, '[data-endpoint]').textContent = `ws://127.0.0.1:${port.value}`;
    const running = ['listening', 'connected', 'connecting', 'disconnected'].includes(status);
    q<HTMLButtonElement>(card, '[data-connect]').disabled = !state.isDesktop || running;
    q<HTMLButtonElement>(card, '[data-disconnect]').disabled = !state.isDesktop || !running;
  }

  return { render, dispose() { controller.abort(); card.remove(); } };
}
