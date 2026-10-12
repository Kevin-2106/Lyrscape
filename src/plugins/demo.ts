import type { LyricDocument } from '../sdk/types';
import type { Plugin } from '../kernel/host';

const text = ['让每一个字，都有自己的风景。', '颜色跟随心情，歌词留在桌面。', '从一行文字开始，慢慢编织你的世界。', 'Your lyrics. Your landscape.'];
export const demoLyrics: LyricDocument = {
  timingMode: 'word', source: 'Lyrscape 原创演示文本',
  lines: text.map((line, i) => {
    const startMs = i * 8000, duration = 6000;
    const chunks = i === 3 ? ['Your ', 'lyrics. ', 'Your ', 'landscape.'] : Array.from(line);
    // This authored demo has its own explicit timings. Imported line lyrics are never synthesized.
    return {
      id: `demo-${i}`, text: line, startMs, endMs: startMs + 8000,
      words: chunks.map((word, n) => ({ text: word, startMs: startMs + n * duration / chunks.length, endMs: startMs + (n + 1) * duration / chunks.length })),
    };
  }),
};
export const demoPlugin: Plugin = {
  id: 'official.adapter.demo', activate(ctx) { ctx.provide('adapter.demo@1', { lyrics: demoLyrics }); },
};
