// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseAmllStructured, parseLyrics } from '../src/plugins/parsers';

describe('plain text and LRC', () => {
  it('preserves literal markup and spaces in non-timed text', () => {
    const result = parseLyrics('\uFEFFHello  world\n\n<img src=x onerror=alert(1)>');
    expect(result.timingMode).toBe('none');
    expect(result.lines.map((line) => line.text)).toEqual(['Hello  world', '<img src=x onerror=alert(1)>']);
    expect(result.lines[0].startMs).toBeUndefined();
  });

  it('expands multiple stamps, applies metadata offset globally, and sorts stably', () => {
    const result = parseLyrics('[00:10.50][00:20.50]repeat\n[00:05.005]first\n[offset:-500]\n[ar:Artist]', 'song.lrc');
    expect(result.timingMode).toBe('line');
    expect(result.lines.map((line) => [line.text, line.startMs, line.endMs])).toEqual([
      ['first', 4505, 10000], ['repeat', 10000, 20000], ['repeat', 20000, undefined],
    ]);
  });

  it('uses the next distinct time for simultaneous lines and retains clear markers', () => {
    const result = parseLyrics('[00:01]one\n[00:03]\n[00:01]late duplicate\n[00:05]next');
    expect(result.lines.map(l => [l.text, l.startMs, l.endMs])).toEqual([['one', 1000, 3000], ['late duplicate', 1000, 3000], ['', 3000, 5000], ['next', 5000, undefined]]);
  });

  it('reads a following line with the same timestamps as translation, then romanization', () => {
    const result = parseLyrics('[00:01.00]<00:01.00>今日<00:01.50>も<00:02.00>\n[00:01.00] Today too \n[00:01.00]kyou mo\n[00:03.00][00:09.00]またね\n[00:03.00][00:09.00]See you\n[00:05.00]二行目\n[00:05.50]別の行');
    expect(result.timingMode).toBe('word');
    expect(result.lines.map(l => [l.text, l.startMs, l.translation, l.romanization])).toEqual([
      ['今日も', 1000, 'Today too', 'kyou mo'], ['またね', 3000, 'See you', undefined], ['二行目', 5000, undefined, undefined],
      ['別の行', 5500, undefined, undefined], ['またね', 9000, 'See you', undefined],
    ]);
    expect(result.lines[0].words?.map(w => w.text)).toEqual(['今日', 'も']);
    expect(result.lines[0].endMs).toBe(2000);
  });

  it('keeps same-timestamp lines that are not a plain annotation of the previous line', () => {
    // Different stamp sets, a timed second line, and an empty first line are not translations.
    const result = parseLyrics('[00:01]A\n[00:01][00:02]B\n[00:04]<00:04>C<00:05>\n[00:04]<00:04>D<00:05>\n[00:06]\n[00:06]E');
    expect(result.lines.map(l => [l.text, l.translation])).toEqual([['A', undefined], ['B', undefined], ['B', undefined], ['C', undefined], ['D', undefined], ['', undefined], ['E', undefined]]);
  });

  it('preserves exact Enhanced LRC word spacing and final boundary', () => {
    const result = parseLyrics('[00:01]<00:01>Hello <00:02>wide  world<00:04>\n[offset:100]', 'word.lrc');
    expect(result.timingMode).toBe('word');
    expect(result.lines[0].text).toBe('Hello wide  world');
    expect(result.lines[0].words).toEqual([
      { text: 'Hello ', startMs: 1100, endMs: 2100 },
      { text: 'wide  world', startMs: 2100, endMs: 4100 },
    ]);
  });

  it('shifts enhanced timestamps when a line is repeated', () => {
    const result = parseLyrics('[00:01][00:11]<00:01>A<00:02>B<00:03>');
    expect(result.lines[1].words).toEqual([
      { text: 'A', startMs: 11000, endMs: 12000 }, { text: 'B', startMs: 12000, endMs: 13000 },
    ]);
  });

  it('derives Enhanced LRC end from the next line without inventing a last end', () => {
    const result = parseLyrics('[00:01]<00:01>A<00:02>B\n[00:04]<00:04>unfinished');
    expect(result.lines[0].words?.[1].endMs).toBe(4000);
    expect(result.lines[1].words).toBeUndefined();
  });

  it('rejects invalid timestamps and backwards word boundaries', () => {
    expect(() => parseLyrics('[00:99]bad')).toThrow('Invalid LRC timestamp');
    expect(() => parseLyrics('[00:abc]bad')).toThrow('Invalid LRC timestamp');
    expect(() => parseLyrics('[00:01]line\n[offset:nope]')).toThrow('Invalid LRC offset');
    expect(() => parseLyrics('[10080:00]line\n[offset:1]')).toThrow('7 days');
    expect(() => parseLyrics('[00:01]<00:03>A<00:02>B<00:04>')).toThrow(/ends before|text order/);
  });
});

describe('lyric TTML', () => {
  const wrap = (body: string, extra = '') => `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ${extra}><body><div>${body}</div></body></tt>`;

  it('parses media-absolute span times without adding the paragraph start', () => {
    const result = parseLyrics(wrap('<p begin="00:00:10.000" end="14s"><span begin="10.2s" end="11s">Hello</span> <span begin="11000ms" dur="2s">world</span><span ttm:role="x-translation">你好世界</span><span ttm:role="x-roman">ni hao</span></p>'), 'song.ttml');
    expect(result.timingMode).toBe('word');
    expect(result.lines[0]).toMatchObject({
      text: 'Hello world', startMs: 10000, endMs: 14000, translation: '你好世界', romanization: 'ni hao',
      words: [{ text: 'Hello ', startMs: 10200, endMs: 11000 }, { text: 'world', startMs: 11000, endMs: 13000 }],
    });
  });

  it('preserves xml:space across spans and explicit line breaks', () => {
    const result = parseLyrics(wrap('<p begin="1s" dur="2s" xml:space="preserve"><span begin="1s" end="2s"> A  </span><span begin="2s" end="3s"> B </span></p>'));
    expect(result.lines[0].text).toBe(' A   B ');
    expect(result.lines[0].words?.map((word) => word.text).join('')).toBe(result.lines[0].text);
    const withBreak = parseLyrics(wrap('<p begin="1s" end="2s">first<br/>second</p>'));
    expect(withBreak.lines[0].text).toBe('first\nsecond');
  });

  it('collapses default XML indentation but keeps spaces between timed spans', () => {
    const result = parseLyrics(wrap(`<p begin="1s" end="3s">\n  <span begin="1s" end="2s">A </span>\n  <span begin="2s" end="3s"> B</span>\n</p>`));
    expect(result.lines[0].text).toBe('A B');
    expect(result.lines[0].words?.map((word) => word.text).join('')).toBe('A B');
  });

  it('keeps timed paragraphs as line timing when prose has no per-word timing', () => {
    const result = parseLyrics(wrap('<p begin="1m" dur="1s" ttm:role="x-bg">one &amp; two</p><p begin="0.02h" end="73s">later</p>'));
    expect(result.timingMode).toBe('line');
    expect(result.lines[0]).toMatchObject({ text: 'one & two', startMs: 60000, endMs: 61000, isBackground: true });
    expect(result.lines[1].startMs).toBe(72000);
    expect(result.lines[0].words).toBeUndefined();
  });

  it('retains source order for untimed paragraphs', () => {
    const result = parseLyrics(wrap('<p>first</p><p>second</p><p>third</p>'));
    expect(result.lines.map((line) => line.text)).toEqual(['first', 'second', 'third']);
  });

  it('rejects malformed XML, entity declarations, and unsupported time modes', () => {
    expect(() => parseLyrics('<tt><body>', 'bad.ttml')).toThrow('Invalid TTML');
    expect(() => parseLyrics('<!DOCTYPE tt [<!ENTITY x "unsafe">]><tt/>', 'bad.ttml')).toThrow('declarations');
    expect(() => parseLyrics(wrap('<p begin="30f">bad</p>'))).toThrow('Unsupported TTML');
    expect(() => parseLyrics('<tt><body timeContainer="seq"><p>bad</p></body></tt>')).toThrow('Sequential');
    expect(() => parseLyrics(wrap('<p begin="3s" end="2s">bad</p>'))).toThrow('ends before');
  });
});

describe('AMLL / native structured lyrics', () => {
  it('accepts optional arrays and line-only native data', () => {
    const result = parseAmllStructured({ lines: [{ text: 'untimed' }, { text: 'line', startMs: 1000 }, { text: 'empty array', startMs: 2000, words: [] }] });
    expect(result.timingMode).toBe('line');
    expect(result.lines.map((line) => line.text)).toEqual(['line', 'empty array', 'untimed']);
    expect(result.lines[0].endMs).toBe(2000);
    expect(result.lines[0].translation).toBeUndefined();
  });

  it('normalizes AMLL aliases and exact word text without requiring translation', () => {
    const result = parseAmllStructured({ data: [{ start_time: 1000, end_time: 4000, flag: 1, words: [{ start_time: 1000, end_time: 2000, word: 'Hello ' }, { startTime: 2000, endTime: 3500, word: 'world' }], translatedLyric: '你好', roman_lyric: 'ni hao' }] });
    expect(result.timingMode).toBe('word');
    expect(result.lines[0]).toMatchObject({ text: 'Hello world', startMs: 1000, endMs: 4000, translation: '你好', romanization: 'ni hao', isBackground: true });
    expect(result.lines[0].words?.[0].text).toBe('Hello ');
  });

  it('imports native JSON and derives extents from real word times', () => {
    const result = parseLyrics(JSON.stringify({ lines: [{ words: [{ text: 'A ', startMs: 1000, endMs: 2000 }, { text: 'B', startMs: 2000, endMs: 3000 }] }] }), 'native.json');
    expect(result.source).toBe('native.json');
    expect(result.lines[0]).toMatchObject({ text: 'A B', startMs: 1000, endMs: 3000 });
  });

  it('rejects non-finite times, invalid ranges, malformed fields and missing word times', () => {
    expect(() => parseAmllStructured([{ text: 'x', startTime: Infinity }])).toThrow('finite');
    expect(() => parseAmllStructured([{ text: 'x', startMs: -1 }])).toThrow('finite');
    expect(() => parseAmllStructured([{ text: 'x', startMs: 2, endMs: 1 }])).toThrow('ends before');
    expect(() => parseAmllStructured([{ text: {} }])).toThrow('must be text');
    expect(() => parseAmllStructured([{ words: [{ word: 'x', startTime: 0 }] }])).toThrow('require start and end');
    expect(() => parseAmllStructured([{ words: 'x' }])).toThrow('must be an array');
    expect(() => parseLyrics('{bad', 'bad.json')).toThrow('Invalid structured');
  });

  it('enforces input, line-count, word-count and XML-depth budgets', () => {
    expect(() => parseLyrics('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB');
    expect(() => parseAmllStructured(Array.from({ length: 10001 }, () => ({ text: '' })))).toThrow('10,000');
    expect(() => parseAmllStructured([{ words: Array.from({ length: 100001 }, () => ({ word: '', startTime: 0, endTime: 1 })) }])).toThrow('100,000');
    expect(() => parseLyrics('<tt>' + '<div>'.repeat(65) + '<p>deep</p>' + '</div>'.repeat(65) + '</tt>')).toThrow('64 levels');
  });
});
