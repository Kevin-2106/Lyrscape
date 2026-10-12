import type { AppState } from '../sdk/types';

type MaybeAsync = void | Promise<void>;

/** The settings plugin uses the same public state and commands as other UI plugins. */
export interface SettingsUiContext {
  getState(): AppState;
  getPosition?(): number;
  subscribe(listener: (state: AppState) => void): () => void;
  updateSettings(settings: Partial<AppState['settings']>): MaybeAsync;
  selectAdapter(id: 'demo' | 'amll'): MaybeAsync;
  setPlaying(playing: boolean): MaybeAsync;
  seek(positionMs: number): MaybeAsync;
  importLyrics(text: string, name?: string): MaybeAsync;
  overlay(action: 'show' | 'hide' | 'clickthrough' | 'alwaysOnTop', value?: boolean): MaybeAsync;
  startAmll(port: number): MaybeAsync;
  stopAmll(): MaybeAsync;
}

const fontFamilies = [
  ['system-ui, "Microsoft YaHei", sans-serif', '系统字体'],
  ['"Microsoft YaHei", sans-serif', '微软雅黑'],
  ['"Segoe UI", "Microsoft YaHei", sans-serif', 'Segoe UI'],
  ['"SimSun", serif', '宋体'],
  ['"KaiTi", serif', '楷体'],
  ['"Consolas", "Microsoft YaHei", monospace', '等宽字体'],
] as const;

const exampleLyrics = `[00:00.00]让文字轻轻浮在桌面上
[00:04.00]让每一种颜色都有自己的声音
[00:08.00]此刻的风景，由你来定义
[00:12.00]Lyrscape · 歌词的另一种可能
[00:16.00]`;

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function colorField(key: string, label: string): string {
  return `<label class="field color-field"><span>${label}</span><span class="color-input"><input type="color" data-setting="${key}" aria-label="${label}取色器"><input type="text" data-setting="${key}" spellcheck="false" aria-label="${label} CSS 值" placeholder="#ffffff"></span></label>`;
}

function rangeField(key: string, label: string, min: number, max: number, step: number): string {
  return `<label class="field range-field"><span>${label}<output data-output="${key}"></output></span><input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}"></label>`;
}

export function mountSettings(root: HTMLElement, ctx: SettingsUiContext): () => void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <a class="wordmark" href="#" aria-label="Lyrscape 首页"><span class="brand-icon" aria-hidden="true">L</span><span>Lyrscape<span class="wordmark-caption">让歌词成为风景</span></span></a>
        <div class="header-meta"><span class="version-badge">EARLY PREVIEW</span><span class="runtime-label" data-runtime></span></div>
      </header>
      <main class="workspace">
        <section class="preview-column" aria-label="歌词预览与播放">
          <section class="preview-card">
            <div class="section-heading"><div><span class="eyebrow">LIVE PREVIEW</span><h1>你的歌词，你的风格。</h1></div><span class="live-indicator"><i aria-hidden="true"></i>实时预览</span></div>
            <div class="preview-stage"><div id="lyrics-preview" aria-label="歌词预览"></div></div>
            <div class="preview-note"><span>样式修改即时生效</span><span>普通文字渲染器</span></div>
          </section>
          <section class="transport-card" aria-label="播放控制">
            <div class="track-row"><span class="track-icon" aria-hidden="true">♪</span><div class="track-text"><strong data-track-title></strong><span data-track-artists></span></div><span class="source-badge" data-source-label></span></div>
            <div class="seek-row"><span data-position>0:00</span><input class="seek-input" type="range" data-seek min="0" max="180000" step="100" value="0" aria-label="播放位置"><span data-duration>3:00</span></div>
            <div class="transport-actions"><button class="icon-button" data-restart title="回到开头" aria-label="回到开头">↺</button><button class="play-button" data-play aria-label="播放"><span data-play-icon aria-hidden="true">▶</span><span data-play-text>播放</span></button><span class="transport-hint" data-transport-hint>本地演示播放</span></div>
          </section>
          <section class="source-card">
            <div class="card-title"><h2>播放来源</h2><span class="subtle">Adapter</span></div>
            <div class="segmented source-tabs" role="group" aria-label="选择播放来源"><button data-adapter="demo">本地演示</button><button data-adapter="amll">AMLL 连接</button></div>
            <div class="connection-panel" data-amll-panel hidden>
              <div class="connection-status"><span class="status-dot" data-status-dot></span><span data-connection-status>未启动</span><span data-clients></span></div>
              <div class="connection-actions"><label class="port-field">监听端口<input type="number" data-port min="1024" max="65535" value="11444" aria-label="AMLL WebSocket 监听端口"></label><button class="button-secondary" data-connect>启动服务</button><button class="button-secondary" data-disconnect>停止</button></div>
              <p class="helper">在支持 AMLL 协议的播放器插件中填入 <code data-endpoint>ws://127.0.0.1:11444</code>。播放、歌词和时间进度由连接提供。</p>
              <p class="inline-error" data-connection-error hidden></p>
            </div>
          </section>
          <details class="import-card">
            <summary><span><strong>导入歌词</strong><span class="subtle">LRC / TTML / 纯文本</span></span><span class="disclosure-arrow" aria-hidden="true">⌄</span></summary>
            <div class="import-content"><label class="sr-only" for="lyrics-input">歌词内容</label><textarea id="lyrics-input" data-lyrics spellcheck="false" placeholder="粘贴歌词，例如：&#10;[00:00.00]第一行歌词&#10;[00:04.00]第二行歌词"></textarea><div class="import-actions"><button class="button-primary" data-import>应用歌词</button><button class="button-secondary" data-open-file>打开文件</button><button class="button-link" data-example>填入示例</button><input type="file" data-file accept=".lrc,.ttml,.xml,.txt,text/plain,application/xml" hidden></div><p class="helper">支持逐行 LRC、逐字 LRC 与 TTML。导入后切换到本地演示；纯文本按行展示，带时间的歌词跟随播放。</p></div>
          </details>
          <div class="action-message" data-message role="status" aria-live="polite" hidden></div>
        </section>
        <aside class="settings-panel" aria-label="视觉样式设置">
          <div class="settings-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2>文字样式</h2></div><span class="autosave-badge">自动保存</span></div>
          <section class="settings-group"><h3>字体与排版</h3>
            <label class="field"><span>字体</span><select data-font-select aria-label="预设字体">${fontFamilies.map(([, label], index) => `<option value="${index}">${label}</option>`).join('')}<option value="custom">自定义字体</option></select></label>
            <label class="field custom-font-field" data-custom-font-field hidden><span>CSS 字体族</span><input type="text" data-setting="fontFamily" placeholder='"Arial", "Microsoft YaHei", sans-serif' spellcheck="false"><small>使用本机已安装字体；填写 CSS font-family。</small></label>
            ${rangeField('fontSize', '字号', 18, 100, 1)}
            ${rangeField('fontWeight', '字重', 100, 900, 100)}
            ${rangeField('lineHeight', '行高', 1, 2.5, 0.05)}
            <div class="field"><span>对齐方式</span><div class="segmented alignment-tabs" role="group" aria-label="文字对齐"><button data-align="left" aria-label="左对齐">左对齐</button><button data-align="center" aria-label="居中">居中</button><button data-align="right" aria-label="右对齐">右对齐</button></div></div>
          </section>
          <section class="settings-group"><h3>颜色与渐变</h3>
            ${colorField('color', '文字颜色')}
            ${colorField('inactiveColor', '未激活文字')}
            <label class="toggle-field"><span>渐变文字</span><input class="switch" type="checkbox" data-setting="gradientEnabled"><span class="switch-track" aria-hidden="true"></span></label>
            <div class="gradient-fields" data-gradient-fields>${colorField('gradientStart', '起始颜色')}${colorField('gradientEnd', '结束颜色')}${rangeField('gradientAngle', '渐变角度', 0, 360, 1)}<div class="gradient-swatch" data-gradient-swatch aria-label="渐变预览"></div></div>
            <p class="helper color-helper">颜色支持 HEX、RGB / RGBA 与 CSS 颜色名称。</p>
          </section>
          <section class="settings-group"><h3>显示细节</h3>
            ${rangeField('shadow', '文字阴影', 0, 1, 0.05)}
            ${rangeField('backgroundOpacity', '背景不透明度', 0, 0.9, 0.05)}
            <label class="toggle-field"><span>显示译文</span><input class="switch" type="checkbox" data-setting="showTranslation"><span class="switch-track" aria-hidden="true"></span></label>
            <label class="toggle-field"><span>显示下一行</span><input class="switch" type="checkbox" data-setting="showNextLine"><span class="switch-track" aria-hidden="true"></span></label>
          </section>
          <section class="settings-group overlay-group"><div class="card-title"><h3>桌面歌词</h3><span class="source-badge">OVERLAY</span></div>
            <p class="helper" data-overlay-hint>独立的透明窗口，在其他应用上方显示歌词。</p>
            <button class="button-primary overlay-button" data-overlay-toggle>打开桌面歌词<span aria-hidden="true">↗</span></button>
            <label class="toggle-field"><span>窗口置顶</span><input class="switch" type="checkbox" data-overlay="alwaysOnTop"><span class="switch-track" aria-hidden="true"></span></label>
            <label class="toggle-field"><span>鼠标穿透</span><input class="switch" type="checkbox" data-overlay="clickthrough"><span class="switch-track" aria-hidden="true"></span></label>
            <p class="helper">启用穿透后，鼠标操作会传递给窗口下方的应用。可随时在这里关闭。</p>
          </section>
        </aside>
      </main>
      <footer class="app-footer"><span>Lyrscape</span><span>All is plugin. Every lyric is a canvas.</span></footer>
    </div>`;

  const query = <T extends Element = HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing settings element: ${selector}`);
    return element;
  };
  const controller = new AbortController();
  const { signal } = controller;
  const seekInput = query<HTMLInputElement>('[data-seek]');
  const lyricsInput = query<HTMLTextAreaElement>('[data-lyrics]');
  const portInput = query<HTMLInputElement>('[data-port]');
  const fontSelect = query<HTMLSelectElement>('[data-font-select]');
  const colorProbe = document.createElement('span');
  colorProbe.hidden = true;
  colorProbe.setAttribute('aria-hidden', 'true');
  root.append(colorProbe);
  let importedName: string | undefined;
  let disposed = false;
  let lastStateError: string | undefined;

  function message(text: string, error = false): void {
    if (disposed) return;
    const element = query('[data-message]');
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('is-error', error);
  }

  async function perform(action: () => MaybeAsync, success?: string): Promise<void> {
    try {
      await action();
      message(success ?? '');
    } catch (error) {
      message(error instanceof Error ? error.message : String(error), true);
    }
  }

  function setValue(element: HTMLInputElement | HTMLSelectElement, value: unknown): void {
    if (document.activeElement === element) return;
    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (element instanceof HTMLInputElement && element.type === 'color') {
      const color = String(value);
      if (/^#[\da-f]{6}$/i.test(color)) element.value = color;
      else if (/^#[\da-f]{3}$/i.test(color)) element.value = `#${color.slice(1).split('').map(char => char + char).join('')}`;
      else {
        colorProbe.style.color = color;
        const rgb = getComputedStyle(colorProbe).color.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/);
        element.value = rgb ? `#${rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}` : '#ffffff';
      }
    } else {
      element.value = String(value);
    }
  }

  function renderPosition(state: AppState): void {
    const duration = Math.max(1, state.track.durationMs ?? 180000);
    const elapsed = Math.max(0, performance.now() - state.playback.observedAtMonoMs);
    const delta = state.adapterId === 'amll' ? Math.min(elapsed, 5000) : elapsed;
    const fallbackPosition = state.playback.positionMs + (state.playback.playing ? delta * state.playback.rate : 0);
    const position = Math.max(0, Math.min(state.track.durationMs ?? Number.MAX_SAFE_INTEGER, ctx.getPosition?.() ?? fallbackPosition));
    seekInput.max = String(duration);
    if (document.activeElement !== seekInput) seekInput.value = String(position);
    query('[data-position]').textContent = formatTime(position);
    query('[data-duration]').textContent = state.track.durationMs ? formatTime(state.track.durationMs) : state.adapterId === 'demo' ? formatTime(duration) : '--:--';
  }

  function render(state: AppState): void {
    if (disposed) return;
    const { settings, track, playback, connection, overlay } = state;
    root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(element => {
      const key = element.dataset.setting as keyof AppState['settings'];
      setValue(element, settings[key]);
    });
    const outputs: Record<string, string> = {
      fontSize: `${settings.fontSize}px`, fontWeight: String(settings.fontWeight),
      lineHeight: settings.lineHeight.toFixed(2), gradientAngle: `${settings.gradientAngle}°`,
      shadow: `${Math.round(settings.shadow * 100)}%`, backgroundOpacity: `${Math.round(settings.backgroundOpacity * 100)}%`,
    };
    root.querySelectorAll<HTMLOutputElement>('[data-output]').forEach(element => {
      element.value = outputs[element.dataset.output ?? ''] ?? '';
    });
    const preset = fontFamilies.findIndex(([family]) => family === settings.fontFamily);
    if (document.activeElement !== fontSelect) fontSelect.value = preset < 0 ? 'custom' : String(preset);
    query('[data-custom-font-field]').hidden = fontSelect.value !== 'custom';
    root.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(button => {
      const selected = button.dataset.align === settings.textAlign;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    query('[data-gradient-fields]').classList.toggle('is-disabled', !settings.gradientEnabled);
    root.querySelectorAll<HTMLInputElement>('[data-gradient-fields] input').forEach(input => { input.disabled = !settings.gradientEnabled; });
    query('[data-gradient-swatch]').style.background = `linear-gradient(${settings.gradientAngle}deg, ${settings.gradientStart}, ${settings.gradientEnd})`;
    query('[data-track-title]').textContent = track.title || '等待歌曲';
    query('[data-track-artists]').textContent = Array.isArray(track.artists) ? track.artists.join(' / ') || 'Lyrscape 本地演示' : String(track.artists || 'Lyrscape 本地演示');
    query('[data-source-label]').textContent = state.adapterId === 'amll' ? 'AMLL' : 'DEMO';
    renderPosition(state);
    seekInput.disabled = state.adapterId !== 'demo';
    query('[data-play-icon]').textContent = playback.playing ? 'Ⅱ' : '▶';
    query('[data-play-text]').textContent = playback.playing ? '暂停' : '播放';
    query('[data-play]').setAttribute('aria-label', playback.playing ? '暂停' : '播放');
    query<HTMLButtonElement>('[data-play]').disabled = state.adapterId !== 'demo';
    query<HTMLButtonElement>('[data-restart]').disabled = state.adapterId !== 'demo';
    query('[data-transport-hint]').textContent = state.adapterId === 'demo' ? '本地演示播放' : '由 AMLL 控制播放';
    root.querySelectorAll<HTMLButtonElement>('[data-adapter]').forEach(button => {
      const selected = button.dataset.adapter === state.adapterId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    query('[data-amll-panel]').hidden = state.adapterId !== 'amll';
    const status = String(connection.status);
    const statusLabels: Record<string, string> = { idle: '未启动', stopped: '未启动', disconnected: '等待连接', connecting: '正在启动', listening: '等待连接', connected: '已连接', error: '连接异常', unavailable: '桌面应用中可用' };
    query('[data-connection-status]').textContent = statusLabels[status] ?? status;
    query('[data-status-dot]').className = `status-dot ${status === 'connected' ? 'is-connected' : status === 'error' ? 'is-error' : ''}`;
    query('[data-clients]').textContent = connection.clients > 0 ? `${connection.clients} 个客户端` : '';
    query('[data-connection-error]').textContent = connection.error ?? '';
    query('[data-connection-error]').hidden = !connection.error;
    setValue(portInput, connection.port);
    query('[data-endpoint]').textContent = `ws://127.0.0.1:${portInput.value}`;
    const serverRunning = ['listening', 'connected', 'connecting', 'disconnected'].includes(status);
    query<HTMLButtonElement>('[data-connect]').disabled = !state.isDesktop || serverRunning;
    query<HTMLButtonElement>('[data-disconnect]').disabled = !state.isDesktop || !serverRunning;
    query('[data-runtime]').textContent = state.isDesktop ? '桌面应用' : '浏览器预览';
    query('[data-overlay-hint]').textContent = state.isDesktop ? '独立的透明窗口，在其他应用上方显示歌词。' : '桌面歌词与 AMLL 服务需要在桌面应用中运行。';
    const overlayButton = query<HTMLButtonElement>('[data-overlay-toggle]');
    overlayButton.innerHTML = `${overlay.visible ? '关闭桌面歌词' : '打开桌面歌词'}<span aria-hidden="true">${overlay.visible ? '×' : '↗'}</span>`;
    overlayButton.disabled = !state.isDesktop;
    root.querySelectorAll<HTMLInputElement>('[data-overlay]').forEach(input => {
      const key = input.dataset.overlay as 'alwaysOnTop' | 'clickthrough';
      setValue(input, overlay[key]);
      input.disabled = !state.isDesktop;
    });
    if (state.error !== lastStateError) { lastStateError = state.error; message(state.error ?? '', Boolean(state.error)); }
  }

  root.addEventListener('input', event => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement)) return;
    const key = element.dataset.setting as keyof AppState['settings'] | undefined;
    if (key) {
      let value: string | number | boolean = element.type === 'checkbox' ? element.checked : element.type === 'range' ? Number(element.value) : element.value;
      if (['color', 'inactiveColor', 'gradientStart', 'gradientEnd'].includes(key) && !CSS.supports('color', String(value))) {
        element.setAttribute('aria-invalid', 'true');
        return;
      }
      if (key === 'fontFamily' && !String(value).trim()) return;
      element.removeAttribute('aria-invalid');
      void perform(() => ctx.updateSettings({ [key]: value }));
    } else if (element.matches('[data-seek]')) {
      void perform(() => ctx.seek(Number(element.value)));
    } else if (element.matches('[data-port]')) {
      query('[data-endpoint]').textContent = `ws://127.0.0.1:${element.value}`;
    }
  }, { signal });

  root.addEventListener('change', event => {
    const element = event.target;
    if (element === fontSelect) {
      const family = fontFamilies[Number(fontSelect.value)]?.[0];
      query('[data-custom-font-field]').hidden = fontSelect.value !== 'custom';
      if (family) void perform(() => ctx.updateSettings({ fontFamily: family }));
      else query<HTMLInputElement>('[data-setting="fontFamily"]').focus();
    } else if (element instanceof HTMLInputElement && element.dataset.overlay) {
      const action = element.dataset.overlay as 'clickthrough' | 'alwaysOnTop';
      void perform(() => ctx.overlay(action, element.checked));
    } else if (element instanceof HTMLInputElement && element.matches('[data-file]')) {
      const file = element.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          if (file.size > 2 * 1024 * 1024) throw new Error('歌词文件超过 2 MB，请选择较小的文本文件。');
          lyricsInput.value = await file.text();
          importedName = file.name;
          message(`已读取 ${file.name}，点击“应用歌词”开始预览。`);
        } catch (error) { message(error instanceof Error ? error.message : String(error), true); }
        element.value = '';
      })();
    }
  }, { signal });

  root.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button');
    if (!button || !root.contains(button) || button.disabled) return;
    if (button.dataset.adapter) void perform(() => ctx.selectAdapter(button.dataset.adapter as 'demo' | 'amll'));
    else if (button.dataset.align) void perform(() => ctx.updateSettings({ textAlign: button.dataset.align as AppState['settings']['textAlign'] }));
    else if (button.matches('[data-play]')) void perform(() => ctx.setPlaying(!ctx.getState().playback.playing));
    else if (button.matches('[data-restart]')) void perform(() => ctx.seek(0));
    else if (button.matches('[data-overlay-toggle]')) void perform(() => ctx.overlay(ctx.getState().overlay.visible ? 'hide' : 'show'));
    else if (button.matches('[data-connect]')) {
      const port = Number(portInput.value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) message('端口需要是 1024–65535 之间的整数。', true);
      else void perform(() => ctx.startAmll(port));
    } else if (button.matches('[data-disconnect]')) void perform(() => ctx.stopAmll());
    else if (button.matches('[data-open-file]')) query<HTMLInputElement>('[data-file]').click();
    else if (button.matches('[data-example]')) { lyricsInput.value = exampleLyrics; importedName = '示例歌词'; }
    else if (button.matches('[data-import]')) {
      if (!lyricsInput.value.trim()) message('先粘贴歌词，或打开一个 LRC / TTML / TXT 文件。', true);
      else void perform(() => ctx.importLyrics(lyricsInput.value, importedName), '歌词已应用，可以开始播放。');
    }
  }, { signal });

  render(ctx.getState());
  const unsubscribe = ctx.subscribe(render);
  const positionTimer = window.setInterval(() => { if (!disposed) renderPosition(ctx.getState()); }, 200);
  return () => { disposed = true; window.clearInterval(positionTimer); controller.abort(); unsubscribe(); root.replaceChildren(); };
}
