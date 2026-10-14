import type { AppState } from '../../sdk/types';
import type { UiServices } from '../context';
import { AMLL_ADAPTER } from '../../plugins/management';
import { html, q } from '../kit/dom';
import { setSelected, setValue } from '../kit/fields';

const statusLabels: Record<string, string> = {
  idle: '未启动', stopped: '未启动', disconnected: '等待连接', connecting: '正在启动', listening: '等待连接',
  connected: '已连接', error: '连接异常', unavailable: '桌面应用中可用',
};

/** Playback source switcher plus the AMLL server controls. */
export function mountSourcePanel(host: HTMLElement, { ctx, perform, notify }: UiServices): { render(state: AppState): void; dispose(): void } {
  const card = html(`<section class="card source-card">
    <div class="card-title"><h2>播放来源</h2><span class="subtle">Adapter</span></div>
    <div class="segmented source-tabs" role="group" aria-label="选择播放来源"><button data-adapter="demo">本地演示</button><button data-adapter="amll">AMLL 连接</button></div>
    <div class="connection-panel" data-amll-panel hidden>
      <div class="connection-status"><span class="status-dot" data-status-dot></span><span data-connection-status>未启动</span><span data-clients></span></div>
      <div class="connection-actions"><label class="port-field">监听端口<input type="number" data-port min="1024" max="65535" value="11444" aria-label="AMLL WebSocket 监听端口"></label><button class="button-secondary" data-connect>启动服务</button><button class="button-secondary" data-disconnect>停止</button></div>
      <p class="helper">在支持 AMLL 协议的播放器插件中填入 <code data-endpoint>ws://127.0.0.1:11444</code>。播放、歌词和时间进度由连接提供。</p>
      <p class="inline-error" data-connection-error hidden></p>
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
    if (button.dataset.adapter) void perform(() => ctx.selectAdapter(button.dataset.adapter as 'demo' | 'amll'));
    else if (button.matches('[data-connect]')) {
      const value = Number(port.value);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) notify('端口需要是 1024–65535 之间的整数。', 'error');
      else void perform(() => { ctx.pluginManagement.configure(AMLL_ADAPTER, { port: value }); return ctx.startAmll(value); });
    } else if (button.matches('[data-disconnect]')) void perform(() => ctx.stopAmll());
  }, { signal });

  function render(state: AppState): void {
    const { connection } = state, status = String(connection.status);
    setSelected(card.querySelectorAll<HTMLButtonElement>('[data-adapter]'), button => button.dataset.adapter === state.adapterId);
    card.querySelectorAll<HTMLButtonElement>('[data-adapter]').forEach(button => {
      button.disabled = button.dataset.adapter === 'amll' && state.plugins.enabled[AMLL_ADAPTER] === false;
    });
    q(card, '[data-amll-panel]').hidden = state.adapterId !== 'amll';
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
