import type { AppState, LyricDocument } from '../../sdk/types';
import type { DebugChannel, DebugEntry } from '../../plugins/debug';
import { activeLine } from '../../plugins/renderer';
import { documentLangs } from '../../plugins/typeface';
import type { PageDefinition, UiServices } from '../context';
import { icons } from '../icons';
import { html, q } from '../kit/dom';

// 调试: read-only views of what the app receives and derives (playback samples,
// AMLL wire messages, parsed lyrics, beat / PCM analysis, plugin status and
// errors). Available in release builds. Everything from outside (lyrics, wire
// payloads, plugin errors) is written with textContent, never as markup.

type TabId = 'playback' | 'amll' | 'lyrics' | 'beat' | 'plugins' | 'events';
const TABS: [TabId, string][] = [['playback', '播放'], ['amll', 'AMLL 原始数据'], ['lyrics', '歌词解析'], ['beat', '节拍与音频'], ['plugins', '插件'], ['events', '事件']];
const LINE_LIMIT = 400;

const clock = (epoch: number) => { const d = new Date(epoch); return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
const ms = (value: number | undefined) => value === undefined ? '—' : `${(value / 1000).toFixed(3)} s`;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
/** Rewrites a <dl class="facts"> from label/value pairs. */
const facts = (dl: HTMLElement, rows: [string, string][]) => dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));

async function copy(text: string, services: UiServices, what: string) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
  }
  services.notify(`已复制${what}`, 'success');
}

/** Counts and languages of a lyric document; the parser's output in one glance. */
function lyricFacts(doc: LyricDocument): [string, string][] {
  const words = doc.lines.reduce((n, line) => n + (line.words?.length ?? 0), 0);
  const timed = doc.lines.filter(line => line.startMs !== undefined);
  const langs = documentLangs(doc);
  return [
    ['来源', doc.source ?? '—'],
    ['时间模式', { none: '无时间（纯文本）', line: '逐行', word: '逐字 / 逐词' }[doc.timingMode]],
    ['行数', `${doc.lines.length}（带时间 ${timed.length}，背景人声 ${doc.lines.filter(l => l.isBackground).length}）`],
    ['逐字片段', `${words}（有逐字数据的行 ${doc.lines.filter(l => l.words?.length).length}）`],
    ['译文 / 音译', `${doc.lines.filter(l => l.translation).length} / ${doc.lines.filter(l => l.romanization).length} 行`],
    ['识别语言', `歌词 ${langs.lyrics} · 译文 ${langs.translation}`],
    ['时间范围', timed.length ? `${ms(timed[0].startMs)} → ${ms(Math.max(...doc.lines.map(l => l.endMs ?? l.startMs ?? 0)))}` : '—'],
  ];
}

/** A table of lyric lines; clicking a row shows its full JSON (words with times) in `detail`. */
function lyricTable(host: HTMLElement, detail: HTMLElement, doc: LyricDocument, current = -1) {
  const table = el('table', undefined, 'debug-table');
  const head = el('tr'); for (const label of ['#', '开始', '结束', '字', '歌词', '译文']) head.append(el('th', label));
  table.append(el('thead')); table.tHead!.append(head);
  const body = el('tbody');
  doc.lines.slice(0, LINE_LIMIT).forEach((line, i) => {
    const row = el('tr'); row.dataset.line = String(i);
    if (i === current) row.className = 'is-current';
    for (const cell of [String(i), ms(line.startMs), ms(line.endMs), line.words ? String(line.words.length) : '—', line.text + (line.isBackground ? '  (背景)' : ''), line.translation ?? line.romanization ?? '']) row.append(el('td', cell));
    body.append(row);
  });
  table.append(body);
  table.addEventListener('click', event => {
    const row = (event.target as Element).closest<HTMLElement>('tr[data-line]');
    if (!row) return;
    table.querySelector('.is-selected')?.classList.remove('is-selected'); row.classList.add('is-selected');
    detail.textContent = JSON.stringify(doc.lines[Number(row.dataset.line)], null, 2);
  });
  const note = doc.lines.length > LINE_LIMIT ? el('p', `只列出前 ${LINE_LIMIT} 行（共 ${doc.lines.length} 行）；完整数据请用「复制 JSON」。`, 'helper') : '';
  host.replaceChildren(table, note);
}

export const debugPage: PageDefinition = {
  id: 'debug', group: '应用', title: '调试', subtitle: '播放数据、AMLL 原始消息、歌词解析、节拍与插件状态', icon: icons.chip,
  mount(root, services) {
    const { ctx } = services;
    const debug = ctx.debug;
    const page = html(`<div class="debug-page">
      <div class="tabs debug-tabs" role="tablist" aria-label="调试分类">
        ${TABS.map(([id, label]) => `<button role="tab" type="button" data-debug-tab="${id}" id="debug-tab-${id}">${label}</button>`).join('')}
        <span class="debug-tabs-spacer"></span>
        <button class="button-secondary" data-debug-report>${icons.exportIcon}复制诊断信息</button>
      </div>
      <div class="debug-body">
        <section role="tabpanel" data-debug-panel="playback" aria-labelledby="debug-tab-playback">
          <p class="page-intro">共享时间轴看到的播放状态，每 0.2 秒刷新。「采样年龄」是距离播放器最后一次报告进度的时间；正在播放时位置由时间轴按速率外推，AMLL 来源最多外推 5 秒。</p>
          <dl class="facts" data-playback-facts></dl>
          <div class="debug-actions"><button class="button-secondary" data-copy-state>复制状态 JSON</button></div>
        </section>
        <section role="tabpanel" data-debug-panel="amll" aria-labelledby="debug-tab-amll" hidden>
          <p class="page-intro">AMLL Player 经 WebSocket 发来、由原生端解码后的消息（V1 二进制与 V2 JSON 统一为 JSON），以及连接事件与处理失败。最多保留最近 400 条，单条超过 256 KB 会截断。PCM 音频走独立通道，见「节拍与音频」。</p>
          <div class="debug-toolbar">
            <label><input type="checkbox" data-amll-progress> 显示 progress</label>
            <label><input type="checkbox" data-amll-pause> 暂停记录</label>
            <span class="helper" data-amll-count></span>
            <span class="debug-tabs-spacer"></span>
            <button class="button-secondary" data-amll-copy>复制全部</button>
            <button class="button-secondary" data-amll-clear>${icons.trash}清空</button>
          </div>
          <div class="debug-split"><ol class="debug-log" data-amll-list></ol><pre class="debug-pre" data-amll-detail>选择一条消息查看原始数据。</pre></div>
        </section>
        <section role="tabpanel" data-debug-panel="lyrics" aria-labelledby="debug-tab-lyrics" hidden>
          <p class="page-intro">当前歌词文档就是解析器的输出，渲染器读到的就是这些行与时间。点击一行查看逐字数据。也可以在下方粘贴歌词试解析，不会替换当前歌词。</p>
          <dl class="facts" data-lyric-facts></dl>
          <div class="debug-actions"><button class="button-secondary" data-lyric-copy>复制 JSON</button></div>
          <div class="debug-split"><div class="debug-table-host" data-lyric-table></div><pre class="debug-pre" data-lyric-detail>点击一行查看完整数据。</pre></div>
          <h3 class="debug-heading">试解析</h3>
          <textarea class="debug-input" data-parse-input rows="6" spellcheck="false" placeholder="粘贴 LRC、增强 LRC、TTML、AMLL JSON 或纯文本"></textarea>
          <div class="debug-actions">
            <select data-parse-kind aria-label="按此格式解析"><option value="">自动识别</option><option value="x.lrc">LRC</option><option value="x.ttml">TTML</option><option value="x.json">JSON</option><option value="x.txt">纯文本</option></select>
            <button class="button-secondary" data-parse-run>解析</button>
            <button class="button-secondary" data-parse-import hidden>${icons.importIcon}导入这份歌词</button>
          </div>
          <p class="helper debug-error" data-parse-error hidden></p>
          <dl class="facts" data-parse-facts></dl>
          <div class="debug-split"><div class="debug-table-host" data-parse-table></div><pre class="debug-pre" data-parse-detail></pre></div>
        </section>
        <section role="tabpanel" data-debug-panel="beat" aria-labelledby="debug-tab-beat" hidden>
          <p class="page-intro">节拍检测插件对实时 PCM 的分析结果。只有 AMLL Player 发送音频时才有数据；浏览器预览没有音频。上图为最近 8 秒的节拍脉冲（白）与响度（蓝），下方为 24 段频带、12 个音级与波形。</p>
          <canvas class="debug-canvas" data-beat-canvas width="760" height="260"></canvas>
          <div class="debug-columns"><div><h3 class="debug-heading">节拍</h3><dl class="facts" data-beat-facts></dl></div><div><h3 class="debug-heading">PCM</h3><dl class="facts" data-pcm-facts></dl></div></div>
        </section>
        <section role="tabpanel" data-debug-panel="plugins" aria-labelledby="debug-tab-plugins" hidden>
          <p class="page-intro">运行中的插件、提供 / 依赖的服务与错误。点击一行查看完整状态。</p>
          <div class="debug-split"><div class="debug-table-host" data-plugin-table></div><pre class="debug-pre" data-plugin-detail>点击一行查看完整状态。</pre></div>
        </section>
        <section role="tabpanel" data-debug-panel="events" aria-labelledby="debug-tab-events" hidden>
          <p class="page-intro">本窗口未捕获的错误、插件加载失败等事件，最多保留 200 条。</p>
          <div class="debug-toolbar"><span class="helper" data-event-count></span><span class="debug-tabs-spacer"></span><button class="button-secondary" data-event-clear>${icons.trash}清空</button></div>
          <div class="debug-split"><ol class="debug-log" data-event-list></ol><pre class="debug-pre" data-event-detail>选择一条事件查看详情。</pre></div>
        </section>
      </div>
    </div>`);
    root.append(page);
    const controller = new AbortController(), { signal } = controller;
    let tab: TabId = 'playback', visible = false, timer = 0, raf = 0;
    const panel = (id: TabId) => q(page, `[data-debug-panel="${id}"]`);

    // ---------- Journal lists (AMLL, events) ----------
    const selected: Record<DebugChannel, number> = { amll: 0, events: 0 };
    const listOf = { amll: q(page, '[data-amll-list]'), events: q(page, '[data-event-list]') };
    const detailOf = { amll: q(page, '[data-amll-detail]'), events: q(page, '[data-event-detail]') };
    const showProgress = q<HTMLInputElement>(page, '[data-amll-progress]');
    const filtered = (channel: DebugChannel) => (debug?.journal.list(channel) ?? []).filter(e => channel !== 'amll' || showProgress.checked || e.kind !== 'progress');
    const renderList = (channel: DebugChannel) => {
      const entries = filtered(channel).slice().reverse();
      listOf[channel].replaceChildren(...entries.map(entry => {
        const item = el('li'); item.dataset.entry = String(entry.id);
        if (entry.id === selected[channel]) item.className = 'is-selected';
        if (['error', 'rejected', 'plugin'].includes(entry.kind)) item.classList.add('is-error');
        item.append(el('time', clock(entry.at)), el('b', entry.kind), el('span', entry.summary));
        return item;
      }));
      const total = debug?.journal.list(channel).length ?? 0;
      q(page, channel === 'amll' ? '[data-amll-count]' : '[data-event-count]').textContent = `${entries.length} / ${total} 条`;
    };
    const showEntry = (channel: DebugChannel, entry: DebugEntry | undefined) => {
      selected[channel] = entry?.id ?? 0;
      detailOf[channel].textContent = entry ? `${clock(entry.at)}  ${entry.kind}\n${entry.summary}${entry.truncated ? '\n（已截断）' : ''}\n\n${entry.detail ?? ''}` : '';
    };
    for (const channel of ['amll', 'events'] as const) listOf[channel].addEventListener('click', event => {
      const item = (event.target as Element).closest<HTMLElement>('li[data-entry]');
      if (!item) return;
      showEntry(channel, debug?.journal.list(channel).find(e => e.id === Number(item.dataset.entry)));
      renderList(channel);
    }, { signal });
    let pendingList = 0;
    const queueList = (channel: DebugChannel) => {
      if (!visible || tab !== (channel === 'amll' ? 'amll' : 'events') || pendingList) return;
      pendingList = window.setTimeout(() => { pendingList = 0; renderList(channel); }, 150);
    };
    const unsubscribe = debug?.journal.subscribe(entry => queueList(entry.channel));
    showProgress.addEventListener('change', () => renderList('amll'), { signal });
    q<HTMLInputElement>(page, '[data-amll-pause]').addEventListener('change', event => debug?.journal.setPaused((event.target as HTMLInputElement).checked), { signal });

    // ---------- Playback ----------
    const renderPlayback = (state: AppState) => {
      const position = ctx.getPosition?.() ?? state.playback.positionMs;
      const index = state.lyrics.timingMode === 'none' ? -1 : activeLine(state.lyrics.lines, position);
      const line = state.lyrics.lines[index];
      facts(q(page, '[data-playback-facts]'), [
        ['播放来源', state.adapterId === 'amll' ? 'AMLL Player' : '本地演示 / 导入'],
        ['AMLL 服务', `${state.connection.status} · 端口 ${state.connection.port} · ${state.connection.clients} 个连接${state.connection.error ? ` · ${state.connection.error}` : ''}`],
        ['曲目', `${state.track.title}${state.track.artists.length ? ` — ${state.track.artists.join(' / ')}` : ''}`],
        ['时长', ms(state.track.durationMs)],
        ['状态', `${state.playback.playing ? '播放中' : '暂停'} · 速率 ${state.playback.rate}`],
        ['采样位置', ms(state.playback.positionMs)],
        ['采样年龄', `${Math.round(performance.now() - state.playback.observedAtMonoMs)} ms`],
        ['时间轴位置', ms(position)],
        ['当前行', line ? `#${index} ${ms(line.startMs)} → ${ms(line.endMs)}  ${line.text}` : '—'],
        ['歌词', `${state.lyrics.lines.length} 行 · ${state.lyrics.timingMode}`],
        ['错误', state.error ?? '—'],
      ]);
    };

    // ---------- Lyrics ----------
    let shownDoc: LyricDocument | undefined, parsed: { doc: LyricDocument; text: string; name?: string } | undefined;
    const renderLyrics = (state: AppState) => {
      if (shownDoc === state.lyrics) return;
      shownDoc = state.lyrics;
      facts(q(page, '[data-lyric-facts]'), lyricFacts(state.lyrics));
      const position = ctx.getPosition?.() ?? 0;
      lyricTable(q(page, '[data-lyric-table]'), q(page, '[data-lyric-detail]'), state.lyrics, state.lyrics.timingMode === 'none' ? -1 : activeLine(state.lyrics.lines, position));
    };
    const runParse = () => {
      const text = q<HTMLTextAreaElement>(page, '[data-parse-input]').value;
      const name = q<HTMLSelectElement>(page, '[data-parse-kind]').value || undefined;
      const error = q(page, '[data-parse-error]');
      try {
        if (!debug) throw Error('调试接口不可用');
        const doc = debug.parse(text, name);
        parsed = { doc, text, name };
        error.hidden = true;
        facts(q(page, '[data-parse-facts]'), lyricFacts(doc));
        lyricTable(q(page, '[data-parse-table]'), q(page, '[data-parse-detail]'), doc);
        q(page, '[data-parse-import]').hidden = false;
      } catch (cause) {
        parsed = undefined;
        error.hidden = false; error.textContent = `解析失败：${cause instanceof Error ? cause.message : String(cause)}`;
        q(page, '[data-parse-facts]').replaceChildren(); q(page, '[data-parse-table]').replaceChildren(); q(page, '[data-parse-detail]').textContent = '';
        q(page, '[data-parse-import]').hidden = true;
      }
    };

    // ---------- Beat / PCM ----------
    const canvas = q<HTMLCanvasElement>(page, '[data-beat-canvas]'), g = canvas.getContext('2d');
    const history: { at: number; pulse: number; level: number }[] = [];
    let lastFacts = 0;
    const drawBeat = () => {
      const now = performance.now(), detector = debug?.beat(), sample = detector?.sample(now), analysis = detector?.analysis?.(now);
      if (sample) history.push({ at: now, pulse: sample.pulse, level: sample.level });
      while (history.length && now - history[0].at > 8000) history.shift();
      if (g) {
        const W = canvas.width, H = canvas.height, top = 120;
        g.clearRect(0, 0, W, H); g.fillStyle = '#0f1014'; g.fillRect(0, 0, W, H);
        g.strokeStyle = '#23242c'; g.beginPath(); g.moveTo(0, top + 0.5); g.lineTo(W, top + 0.5); g.stroke();
        const plot = (key: 'pulse' | 'level', color: string) => {
          g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
          history.forEach((point, i) => { const x = W - (now - point.at) / 8000 * W, y = top - 6 - point[key] * (top - 14); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.stroke();
        };
        plot('level', '#6c8cff'); plot('pulse', '#f2f3f8');
        if (analysis) {
          const bw = 300 / analysis.bands.length;
          analysis.bands.forEach((v, i) => { g.fillStyle = '#aab5ff'; g.fillRect(10 + i * bw, H - 10 - v * 110, bw - 2, v * 110); });
          const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
          g.font = '10px ui-monospace, Consolas, monospace'; g.textAlign = 'center';
          analysis.chroma.forEach((v, i) => { g.fillStyle = `rgba(143,212,168,${0.25 + v * 0.75})`; g.fillRect(330 + i * 18, H - 10 - v * 100, 14, v * 100); g.fillStyle = '#9799a9'; g.fillText(names[i], 337 + i * 18, H - 1); });
          g.strokeStyle = '#f0c674'; g.lineWidth = 1; g.beginPath();
          analysis.wave.forEach((v, i) => { const x = 560 + i / analysis.wave.length * 190, y = top + 70 - v * 60; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.stroke();
        } else { g.fillStyle = '#686b7b'; g.font = '12px system-ui'; g.fillText(detector ? '没有实时音频' : '节拍检测未启用', 12, top + 30); }
      }
      if (now - lastFacts > 200) {
        lastFacts = now;
        facts(q(page, '[data-beat-facts]'), sample ? [
          ['状态', detector ? sample.active ? '跟踪中' : '等待音频' : '插件未启用'],
          ['BPM', sample.bpm ? sample.bpm.toFixed(1) : '—'], ['置信度', sample.confidence.toFixed(2)],
          ['相位', sample.phase.toFixed(2)], ['节拍序号', String(sample.index)], ['脉冲', sample.pulse.toFixed(2)], ['响度', sample.level.toFixed(2)],
        ] : [['状态', '节拍检测插件未启用（插件 › 特效）']]);
        const frame = debug?.pcm();
        let peak = 0;
        if (frame) for (let i = 0; i + 1 < frame.data.length; i += 2) peak = Math.max(peak, Math.abs((frame.data[i] | frame.data[i + 1] << 8) << 16 >> 16));
        facts(q(page, '[data-pcm-facts]'), frame ? [
          ['来源', frame.sourceId], ['序号', `${frame.sequence}（revision ${frame.revision}）`], ['距今', `${Math.round(now - frame.receivedAtMonoMs)} ms`],
          ['帧数', `${frame.frameCount}（≈ ${(frame.frameCount / frame.format.sampleRate * 1000).toFixed(1)} ms）`], ['丢帧', String(frame.droppedFrames)],
          ['格式', `${frame.format.sampleRate} Hz · ${frame.format.channels} ch · ${frame.format.sampleFormat} · ${frame.format.basis}`],
          ['峰值', `${(peak / 32768 * 100).toFixed(1)} %`],
        ] : [['状态', '最近 1 秒没有收到 PCM']]);
      }
      raf = requestAnimationFrame(drawBeat);
    };

    // ---------- Plugins ----------
    const renderPlugins = () => {
      const list = ctx.pluginManagement.list();
      const table = el('table', undefined, 'debug-table');
      const head = el('tr'); for (const label of ['插件', '类别', '来源', '状态', '提供', '错误']) head.append(el('th', label));
      table.append(el('thead')); table.tHead!.append(head);
      const body = el('tbody');
      list.forEach((plugin, i) => {
        const row = el('tr'); row.dataset.index = String(i);
        if (plugin.error) row.className = 'is-error';
        for (const cell of [`${plugin.name}\n${plugin.id}@${plugin.version}`, plugin.category, plugin.origin, plugin.busy ? '处理中' : plugin.active ? '运行中' : '停止', plugin.provides.join(', '), plugin.error ?? '']) row.append(el('td', cell));
        body.append(row);
      });
      table.append(body);
      table.addEventListener('click', event => {
        const row = (event.target as Element).closest<HTMLElement>('tr[data-index]');
        if (row) q(page, '[data-plugin-detail]').textContent = JSON.stringify(list[Number(row.dataset.index)], null, 2);
      });
      q(page, '[data-plugin-table]').replaceChildren(table);
    };

    // ---------- Tabs & lifecycle ----------
    const stopLoops = () => { clearInterval(timer); timer = 0; cancelAnimationFrame(raf); raf = 0; };
    const startLoops = () => {
      stopLoops();
      if (!visible) return;
      if (tab === 'playback') { renderPlayback(ctx.getState()); timer = window.setInterval(() => renderPlayback(ctx.getState()), 200); }
      if (tab === 'beat') raf = requestAnimationFrame(drawBeat);
    };
    const select = (id: TabId) => {
      tab = id;
      page.querySelectorAll<HTMLButtonElement>('[data-debug-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.debugTab === id)));
      for (const [other] of TABS) panel(other).hidden = other !== id;
      if (id === 'amll') renderList('amll');
      if (id === 'events') renderList('events');
      if (id === 'lyrics') { shownDoc = undefined; renderLyrics(ctx.getState()); }
      if (id === 'plugins') renderPlugins();
      startLoops();
    };
    const report = () => {
      const state = ctx.getState();
      return JSON.stringify({
        app: { version: ctx.appVersion, desktop: state.isDesktop, userAgent: navigator.userAgent, at: new Date().toISOString() },
        playback: { adapter: state.adapterId, connection: state.connection, track: state.track, playback: state.playback, position: ctx.getPosition?.(), error: state.error },
        lyrics: Object.fromEntries(lyricFacts(state.lyrics)),
        plugins: ctx.pluginManagement.list().map(p => ({ id: p.id, version: p.version, origin: p.origin, active: p.active, error: p.error })),
        renderer: state.plugins.rendererId,
        events: debug?.journal.list('events') ?? [],
        amll: (debug?.journal.list('amll') ?? []).filter(e => e.kind !== 'progress').slice(-30).map(e => ({ ...e, detail: e.detail && e.detail.length > 4000 ? `${e.detail.slice(0, 4000)}…` : e.detail })),
      }, null, 2);
    };
    page.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.dataset.debugTab) select(button.dataset.debugTab as TabId);
      else if (button.matches('[data-debug-report]')) void copy(report(), services, '诊断信息（不含歌词正文）');
      else if (button.matches('[data-copy-state]')) { const { lyrics, ...rest } = ctx.getState(); void copy(JSON.stringify({ ...rest, lyrics: { ...lyrics, lines: `${lyrics.lines.length} lines` } }, null, 2), services, '状态'); }
      else if (button.matches('[data-amll-copy]')) void copy(JSON.stringify(debug?.journal.list('amll') ?? [], null, 2), services, ' AMLL 消息');
      else if (button.matches('[data-amll-clear]')) { debug?.journal.clear('amll'); showEntry('amll', undefined); renderList('amll'); }
      else if (button.matches('[data-event-clear]')) { debug?.journal.clear('events'); showEntry('events', undefined); renderList('events'); }
      else if (button.matches('[data-lyric-copy]')) void copy(JSON.stringify(ctx.getState().lyrics, null, 2), services, '歌词 JSON');
      else if (button.matches('[data-parse-run]')) runParse();
      else if (button.matches('[data-parse-import]') && parsed) void services.perform(() => ctx.importLyrics(parsed!.text, parsed!.name), '已导入歌词');
    }, { signal });
    select('playback');

    return {
      render(state: AppState) { if (visible && tab === 'lyrics') renderLyrics(state); },
      activate() { visible = true; select(tab); },
      deactivate() { visible = false; stopLoops(); },
      dispose() { stopLoops(); clearTimeout(pendingList); unsubscribe?.(); controller.abort(); root.replaceChildren(); },
    };
  },
};
