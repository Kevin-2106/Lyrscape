import type { UiServices } from '../context';
import { html, q } from '../kit/dom';

const exampleLyrics = `[00:00.00]让文字轻轻浮在桌面上
[00:04.00]让每一种颜色都有自己的声音
[00:08.00]此刻的风景，由你来定义
[00:12.00]Lyrscape · 歌词的另一种可能
[00:16.00]`;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Lyrics import: paste, open a file, or drop one onto the card. */
export function mountImportPanel(host: HTMLElement, { ctx, perform, notify }: UiServices): { openFilePicker(): void; dispose(): void } {
  const card = html<HTMLDetailsElement>(`<details class="card import-card">
    <summary><span><strong>导入歌词</strong><span class="subtle">LRC / TTML / 纯文本，也可拖入文件</span></span><span class="disclosure-arrow" aria-hidden="true">⌄</span></summary>
    <div class="import-content"><label class="sr-only" for="lyrics-input">歌词内容</label><textarea id="lyrics-input" data-lyrics spellcheck="false" placeholder="粘贴歌词，例如：&#10;[00:00.00]第一行歌词&#10;[00:04.00]第二行歌词"></textarea><div class="import-actions"><button class="button-primary" data-import>应用歌词</button><button class="button-secondary" data-open-file>打开文件</button><button class="button-link" data-example>填入示例</button><input type="file" data-file accept=".lrc,.ttml,.xml,.txt,text/plain,application/xml" hidden></div><p class="helper">支持逐行 LRC、逐字 LRC 与 TTML。导入后切换到本地演示；纯文本按行展示，带时间的歌词跟随播放。</p></div>
  </details>`);
  host.append(card);
  const input = q<HTMLTextAreaElement>(card, '[data-lyrics]');
  const file = q<HTMLInputElement>(card, '[data-file]');
  const controller = new AbortController();
  const { signal } = controller;
  let importedName: string | undefined;

  async function load(picked: File | undefined): Promise<void> {
    if (!picked) return;
    try {
      if (picked.size > MAX_FILE_BYTES) throw new Error('歌词文件超过 2 MB，请选择较小的文本文件。');
      input.value = await picked.text();
      importedName = picked.name;
      card.open = true;
      notify(`已读取 ${picked.name}，点击“应用歌词”开始预览。`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  }

  file.addEventListener('change', () => { void load(file.files?.[0]).then(() => { file.value = ''; }); }, { signal });
  card.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.matches('[data-open-file]')) file.click();
    else if (button.matches('[data-example]')) { input.value = exampleLyrics; importedName = '示例歌词'; }
    else if (button.matches('[data-import]')) {
      if (!input.value.trim()) notify('先粘贴歌词，或打开一个 LRC / TTML / TXT 文件。', 'error');
      else void perform(() => ctx.importLyrics(input.value, importedName), '歌词已应用，可以开始播放。');
    }
  }, { signal });
  // Dropping a file anywhere on the card is the desktop-native way to import.
  card.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); card.classList.add('is-dragging'); } }, { signal });
  card.addEventListener('dragleave', () => card.classList.remove('is-dragging'), { signal });
  card.addEventListener('drop', event => {
    event.preventDefault(); card.classList.remove('is-dragging');
    void load(event.dataTransfer?.files[0]);
  }, { signal });

  return { openFilePicker() { card.open = true; file.click(); }, dispose() { controller.abort(); card.remove(); } };
}
