import type { LyricDocument, LyricLine, LyricWord } from '../sdk/types';

// Limits apply before the renderer receives untrusted file or adapter data.
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_LINES = 10_000;
const MAX_WORDS = 100_000;
const MAX_LINE_TEXT = 65_536;
const MAX_TIME = 7 * 24 * 60 * 60 * 1000;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function fail(message: string): never {
  throw new Error(`Lyric parser: ${message}`);
}

function checkedText(value: unknown, label: string, optional = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') return fail(`${label} must be text.`);
  if (value.length > MAX_LINE_TEXT) return fail(`${label} exceeds 65,536 characters.`);
  return value;
}

function checkedTime(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIME) {
    return fail(`${label} must be a finite millisecond time between 0 and 7 days.`);
  }
  return value;
}

function checkRange(start: number | undefined, end: number | undefined, label: string): void {
  if (start !== undefined && end !== undefined && end < start) fail(`${label} ends before it starts.`);
}

function finish(lines: LyricLine[], source: string): LyricDocument {
  if (lines.length > MAX_LINES) fail('Too many lyric lines (maximum 10,000).');
  let textSize = 0;
  let wordCount = 0;
  for (const line of lines) {
    textSize += line.text.length + (line.translation?.length ?? 0) + (line.romanization?.length ?? 0);
    wordCount += line.words?.length ?? 0;
    checkedText(line.text, 'Lyric line');
    checkedTime(line.startMs, 'Lyric line start');
    checkedTime(line.endMs, 'Lyric line end');
    checkRange(line.startMs, line.endMs, 'Lyric line');
  }
  if (textSize > MAX_TEXT) fail('Lyrics exceed the 2 MiB text budget.');
  if (wordCount > MAX_WORDS) fail('Too many lyric words (maximum 100,000).');

  // A stable sort keeps simultaneous foreground/background lines in source order.
  lines.sort((a, b) => (a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY));
  let currentStart: number | undefined;
  let nextStart: number | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startMs === undefined) continue;
    if (currentStart !== line.startMs) {
      nextStart = currentStart;
      currentStart = line.startMs;
    }
    if (line.endMs === undefined && nextStart !== undefined) line.endMs = nextStart;
  }
  return {
    timingMode: lines.some((line) => line.words?.length)
      ? 'word'
      : lines.some((line) => line.startMs !== undefined) ? 'line' : 'none',
    lines,
    source,
  };
}

function parseLrcTime(value: string): number {
  const match = /^(?:(\d+):)?(\d+):(\d{2})(?:[.:](\d{1,3}))?$/.exec(value);
  if (!match || Number(match[3]) >= 60 || (match[1] && Number(match[2]) >= 60)) {
    return fail(`Invalid LRC timestamp "${value}".`);
  }
  const result = ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000
    + Number((match[4] ?? '').padEnd(3, '0'));
  return checkedTime(result, 'LRC timestamp')!;
}

type WordDraft = { text: string; startMs: number; endMs?: number };

function completeWords(draft: WordDraft[], line: LyricLine): void {
  if (!draft.length || draft.map((word) => word.text).join('') !== line.text) return;
  const words: LyricWord[] = [];
  for (let i = 0; i < draft.length; i++) {
    const word = draft[i];
    const endMs = word.endMs ?? draft[i + 1]?.startMs ?? line.endMs;
    // Without a real boundary the final token stays in the line renderer. No
    // guessed equal word durations are created for incomplete timestamps.
    if (endMs === undefined) return;
    checkedTime(word.startMs, 'Lyric word start');
    checkedTime(endMs, 'Lyric word end');
    if (i && word.startMs < draft[i - 1].startMs) fail('Word timestamps must follow the lyric text order.');
    checkRange(word.startMs, endMs, 'Lyric word');
    words.push({ text: word.text, startMs: word.startMs, endMs });
  }
  line.words = words;
}

function parseLrc(text: string, source: string): LyricDocument {
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > MAX_LINES) fail('Too many source lines (maximum 10,000).');
  let offset = 0;
  for (const raw of rawLines) {
    const match = /^\s*\[offset:([+-]?\d+)\]\s*$/i.exec(raw);
    if (/^\s*\[offset:/i.test(raw) && !match) fail('Invalid LRC offset.');
    if (match) {
      offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > MAX_TIME) fail('Invalid LRC offset.');
    }
  }
  const lines: LyricLine[] = [];
  const drafts = new Map<LyricLine, WordDraft[]>();
  let index = 0;
  let wordCount = 0;
  // Bilingual LRC convention: a line repeating the previous line's timestamps is
  // its translation (a third one its romanization), not another sung line.
  let previous: { stamps: number[]; lines: LyricLine[] } | undefined;
  for (const raw of rawLines) {
    if (/^\s*\[[a-z][a-z0-9_-]*:.*\]\s*$/i.test(raw)) continue;
    const stamps: number[] = [];
    let content = /^\s*\[\d+:/.test(raw) ? raw.trimStart() : raw;
    while (true) {
      const match = /^\[(\d+(?::\d+){1,2}(?:[.:]\d{1,3})?)\]/.exec(content);
      if (!match) break;
      stamps.push(parseLrcTime(match[1]));
      content = content.slice(match[0].length);
    }
    if (/^\[\d+:/.test(content)) fail('Invalid LRC timestamp.');
    if (!stamps.length) continue;
    checkedText(content, 'LRC line');
    const markers = [...content.matchAll(/<(\d+(?::\d+){1,2}(?:[.:]\d{1,3})?)>/g)];
    const annotation = content.trim();
    if (previous && !markers.length && annotation && previous.stamps.length === stamps.length && previous.stamps.every((stamp, i) => stamp === stamps[i])
      && previous.lines.every(line => line.text.trim() && line.romanization === undefined)) {
      const key = previous.lines[0].translation === undefined ? 'translation' : 'romanization';
      for (const line of previous.lines) line[key] = annotation;
      continue;
    }
    wordCount += markers.length * stamps.length;
    if (wordCount > MAX_WORDS) fail('Too many lyric word markers (maximum 100,000).');
    const originalDraft: WordDraft[] = [];
    let displayText = content;
    if (markers.length) {
      const prefix = content.slice(0, markers[0].index);
      displayText = prefix;
      for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const tokenText = content.slice(marker.index! + marker[0].length, markers[i + 1]?.index ?? content.length);
        displayText += tokenText;
        const startMs = parseLrcTime(marker[1]);
        if (tokenText) originalDraft.push({ text: (i === 0 ? prefix : '') + tokenText, startMs });
        else if (originalDraft.length) originalDraft[originalDraft.length - 1].endMs = startMs;
      }
      // Untimed non-whitespace text before the first marker has no word timing.
      if (prefix.trim()) originalDraft.length = 0;
    }
    previous = { stamps, lines: [] };
    for (const stamp of stamps) {
      const shift = stamp - stamps[0] + offset;
      const line: LyricLine = { id: `lrc-${index++}`, text: displayText, startMs: Math.max(0, stamp + offset) };
      previous.lines.push(line);
      if (originalDraft.length) {
        const draft = originalDraft.map((word) => ({
          text: word.text,
          startMs: Math.max(0, word.startMs + shift),
          endMs: word.endMs === undefined ? undefined : Math.max(0, word.endMs + shift),
        }));
        const lastEnd = draft[draft.length - 1].endMs;
        if (lastEnd !== undefined) line.endMs = lastEnd;
        drafts.set(line, draft);
      }
      lines.push(line);
      if (lines.length > MAX_LINES) fail('Too many expanded LRC lines (maximum 10,000).');
    }
  }
  const result = finish(lines, source);
  for (const [line, draft] of drafts) completeWords(draft, line);
  result.timingMode = lines.some((line) => line.words?.length) ? 'word' : 'line';
  return result;
}

/** Common lyric TTML uses media-absolute p/span times. This baseline supports
 * clock times and h/m/s/ms offsets, not TTML sequential/frame/tick time bases. */
function parseTtmlTime(value: string, label: string): number {
  const trimmed = value.trim();
  const clock = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(trimmed);
  let result: number;
  if (clock) {
    if (Number(clock[2]) >= 60 || Number(clock[3]) >= 60) fail(`Invalid ${label}: "${value}".`);
    result = (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000
      + (clock[4] ? Number(`0.${clock[4]}`) * 1000 : 0);
  } else {
    const offset = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
    if (!offset) return fail(`Unsupported ${label}: "${value}". Use hh:mm:ss, h, m, s, or ms.`);
    const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[offset[2]]!;
    result = Number(offset[1]) * factor;
  }
  return checkedTime(result, label)!;
}

function attribute(element: Element, name: string): string | undefined {
  return [...element.attributes].find((attr) => attr.localName === name)?.value;
}

function role(element: Element): 'translation' | 'romanization' | 'background' | undefined {
  const value = attribute(element, 'role') ?? '';
  if (/\b(?:x-translation|translation)\b/i.test(value)) return 'translation';
  if (/\b(?:x-roman|x-romanization|romanization)\b/i.test(value)) return 'romanization';
  if (/\b(?:x-bg|background)\b/i.test(value)) return 'background';
  return undefined;
}

function elementTiming(element: Element): { startMs?: number; endMs?: number } {
  const begin = element.getAttribute('begin');
  const end = element.getAttribute('end');
  const dur = element.getAttribute('dur');
  const startMs = begin === null ? undefined : parseTtmlTime(begin, 'TTML begin');
  let endMs = end === null ? undefined : parseTtmlTime(end, 'TTML end');
  if (dur !== null) {
    const duration = parseTtmlTime(dur, 'TTML duration');
    if (startMs === undefined) fail('TTML dur requires an explicit begin in this baseline.');
    const durationEnd = checkedTime(startMs! + duration, 'TTML duration end')!;
    endMs = endMs === undefined ? durationEnd : Math.min(endMs, durationEnd);
  }
  checkRange(startMs, endMs, 'TTML element');
  return { startMs, endMs };
}

type Segment = { text: string; preserve: boolean; timing?: { startMs?: number; endMs?: number } };

function ttmlSegments(container: Element): { segments: Segment[]; translation?: string; romanization?: string } {
  const segments: Segment[] = [];
  const annotations: { translation?: string; romanization?: string } = {};
  const inheritedPreserve = (element: Element): boolean => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const mode = current.getAttributeNS(XML_NS, 'space') ?? current.getAttribute('xml:space');
      if (mode) return mode === 'preserve';
    }
    return false;
  };
  function walk(node: Node, timing?: Segment['timing'], preserve = inheritedPreserve(container)): void {
    if (node.nodeType === 3 || node.nodeType === 4) {
      segments.push({ text: node.nodeValue ?? '', preserve, timing });
      if (segments.length > MAX_WORDS) fail('TTML has too many text tokens (maximum 100,000).');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const kind = element === container ? undefined : role(element);
    if (kind === 'translation' || kind === 'romanization') {
      const raw = element.textContent ?? '';
      annotations[kind] = inheritedPreserve(element) ? raw : raw.replace(/\s+/g, ' ').trim();
      return;
    }
    if (['metadata', 'head', 'image', 'audio', 'set', 'animate'].includes(element.localName)) return;
    const mode = element.getAttributeNS(XML_NS, 'space') ?? element.getAttribute('xml:space');
    if (mode) preserve = mode === 'preserve';
    if (element.localName === 'br') {
      segments.push({ text: '\n', preserve: true, timing });
      return;
    }
    if (element !== container && (element.hasAttribute('begin') || element.hasAttribute('end') || element.hasAttribute('dur'))) {
      const own = elementTiming(element);
      timing = { startMs: own.startMs ?? timing?.startMs, endMs: own.endMs ?? timing?.endMs };
    }
    for (const child of element.childNodes) walk(child, timing, preserve);
  }
  walk(container);
  // Collapse default XML whitespace across span boundaries, while xml:space
  // preserve and explicit <br> retain their exact text.
  let previousWasSpace = false;
  for (const segment of segments) {
    if (!segment.preserve) {
      segment.text = segment.text.replace(/[\t\r\n ]+/g, ' ');
      if (previousWasSpace && segment.text.startsWith(' ')) segment.text = segment.text.slice(1);
    }
    if (segment.text) previousWasSpace = /\s$/.test(segment.text);
  }
  const first = segments.find((segment) => segment.text);
  const last = [...segments].reverse().find((segment) => segment.text);
  if (first && !first.preserve) first.text = first.text.replace(/^ +/, '');
  if (last && !last.preserve) last.text = last.text.replace(/ +$/, '');
  return { segments, ...annotations };
}

function wordDraftFromSegments(segments: Segment[]): WordDraft[] {
  const draft: WordDraft[] = [];
  let prefix = '';
  for (const segment of segments) {
    if (!segment.text) continue;
    if (segment.timing?.startMs === undefined) {
      if (segment.text.trim()) return [];
      if (draft.length) draft[draft.length - 1].text += segment.text;
      else prefix += segment.text;
      continue;
    }
    const previous = draft[draft.length - 1];
    if (previous && previous.startMs === segment.timing.startMs && previous.endMs === segment.timing.endMs) {
      previous.text += segment.text;
    } else {
      draft.push({ text: prefix + segment.text, startMs: segment.timing.startMs, endMs: segment.timing.endMs });
      prefix = '';
    }
  }
  return draft;
}

function parseTtml(text: string, source: string): LyricDocument {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('TTML document declarations and entities are not accepted.');
  if (typeof DOMParser === 'undefined') fail('TTML requires the WebView XML parser.');
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length || xml.documentElement.localName !== 'tt') fail('Invalid TTML XML document.');
  const timeBase = attribute(xml.documentElement, 'timeBase');
  if (timeBase && timeBase !== 'media') fail('Only the TTML media time base is supported by this baseline.');
  const elements: Element[] = [];
  const stack: { element: Element; depth: number }[] = [{ element: xml.documentElement, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > 64) fail('TTML nesting exceeds 64 levels.');
    elements.push(item.element);
    if (elements.length > MAX_WORDS) fail('TTML has too many elements (maximum 100,000).');
    if (item.element.getAttribute('timeContainer') === 'seq') fail('Sequential TTML timing is not supported by this baseline.');
    for (const child of item.element.children) stack.push({ element: child, depth: item.depth + 1 });
  }
  const paragraphs = elements.filter((element) => element.localName === 'p').reverse();
  if (paragraphs.length > MAX_LINES) fail('Too many TTML paragraphs (maximum 10,000).');
  const lines: LyricLine[] = [];
  const drafts = new Map<LyricLine, WordDraft[]>();
  for (const paragraph of paragraphs) {
    const data = ttmlSegments(paragraph);
    const draft = wordDraftFromSegments(data.segments);
    const timing = elementTiming(paragraph);
    const startMs = timing.startMs ?? (draft.length ? draft.reduce((min, word) => Math.min(min, word.startMs), MAX_TIME) : undefined);
    const knownEnds = draft.flatMap((word) => word.endMs === undefined ? [] : [word.endMs]);
    const endMs = timing.endMs ?? (knownEnds.length === draft.length && draft.length ? knownEnds.reduce((max, end) => Math.max(max, end), 0) : undefined);
    const line: LyricLine = {
      id: paragraph.getAttributeNS(XML_NS, 'id') ?? `ttml-${lines.length}`,
      text: data.segments.map((segment) => segment.text).join(''),
      startMs,
      endMs,
      translation: data.translation,
      romanization: data.romanization,
      isBackground: role(paragraph) === 'background',
    };
    if (draft.length) drafts.set(line, draft);
    lines.push(line);
  }
  const result = finish(lines, source);
  for (const [line, draft] of drafts) {
    // Clip explicit word extents to the paragraph's active interval.
    for (const word of draft) {
      if (line.startMs !== undefined) word.startMs = Math.max(word.startMs, line.startMs);
      if (line.endMs !== undefined) {
        word.startMs = Math.min(word.startMs, line.endMs);
        if (word.endMs !== undefined) word.endMs = Math.min(Math.max(word.startMs, word.endMs), line.endMs);
      }
    }
    completeWords(draft, line);
  }
  result.timingMode = lines.some((line) => line.words?.length) ? 'word' : lines.some((line) => line.startMs !== undefined) ? 'line' : 'none';
  return result;
}

/** Parse a local lyric file. Plain text is never interpreted as HTML. */
export function parseLyrics(text: string, filename = 'lyrics'): LyricDocument {
  if (typeof text !== 'string') fail('Input must be text.');
  if (text.length > MAX_TEXT) fail('Input exceeds the 2 MiB text budget.');
  text = text.replace(/^\uFEFF/, '');
  if (/\.(?:ttml|xml)$/i.test(filename) || /^\s*(?:<\?xml[^>]*>\s*)?<(?:(?:\w+):)?tt(?:\s|>)/i.test(text)) return parseTtml(text, filename);
  if (/\.(?:json)$/i.test(filename)) {
    let input: unknown;
    try { input = JSON.parse(text); } catch { return fail('Invalid structured lyric JSON.'); }
    const result = parseAmllStructured(input);
    result.source = filename;
    return result;
  }
  if (/^\s*\[\d+:/m.test(text) || /\.lrc$/i.test(filename)) {
    const result = parseLrc(text, filename);
    if (result.lines.length) return result;
  }
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > MAX_LINES) fail('Too many source lines (maximum 10,000).');
  return finish(rawLines.filter((line) => line.trim()).map((line, index) => ({ id: `text-${index}`, text: line })), filename);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

/** Accept AMLL V1/V2 decoded lines and native LyricDocument-like JSON.
 * All timestamps are milliseconds; field aliases only affect serialization. */
export function parseAmllStructured(input: unknown): LyricDocument {
  const list = Array.isArray(input) ? input : (() => {
    const wrapper = record(input, 'Structured lyrics');
    return wrapper.lines ?? wrapper.data;
  })();
  if (!Array.isArray(list)) fail('Structured lyrics must contain a line array.');
  if (list.length > MAX_LINES) fail('Too many lyric lines (maximum 10,000).');
  let wordCount = 0;
  let textSize = 0;
  const lines = list.map((raw, index): LyricLine => {
    const entry = record(raw, `Line ${index + 1}`);
    const startMs = checkedTime(entry.startMs ?? entry.startTime ?? entry.start_time, `Line ${index + 1} start`);
    const endMs = checkedTime(entry.endMs ?? entry.endTime ?? entry.end_time, `Line ${index + 1} end`);
    checkRange(startMs, endMs, `Line ${index + 1}`);
    let words: LyricWord[] | undefined;
    if (entry.words !== undefined) {
      if (!Array.isArray(entry.words)) fail(`Line ${index + 1} words must be an array.`);
      wordCount += entry.words.length;
      if (wordCount > MAX_WORDS) fail('Too many lyric words (maximum 100,000).');
      words = entry.words.map((rawWord, wordIndex) => {
        const word = record(rawWord, `Line ${index + 1} word ${wordIndex + 1}`);
        const begin = checkedTime(word.startMs ?? word.startTime ?? word.start_time, 'Word start');
        const end = checkedTime(word.endMs ?? word.endTime ?? word.end_time, 'Word end');
        if (begin === undefined || end === undefined) fail('Structured words require start and end times.');
        checkRange(begin, end, 'Lyric word');
        return { text: checkedText(word.text ?? word.word, 'Lyric word'), startMs: begin!, endMs: end! };
      });
      for (let i = 1; i < words.length; i++) {
        if (words[i].startMs < words[i - 1].startMs) fail('Word timestamps must follow the lyric text order.');
      }
      if (words.reduce((sum, word) => sum + word.text.length, 0) > MAX_LINE_TEXT) fail('Lyric line exceeds 65,536 characters.');
    }
    const text = words?.length ? words.map((word) => word.text).join('') : checkedText(entry.text ?? entry.lyric, 'Lyric line', true);
    const translated = entry.translation ?? entry.translatedLyric ?? entry.translated_lyric;
    const romanized = entry.romanization ?? entry.romanLyric ?? entry.roman_lyric;
    const translation = translated === undefined ? undefined : checkedText(translated, 'Translation');
    const romanization = romanized === undefined ? undefined : checkedText(romanized, 'Romanization');
    textSize += text.length + (translation?.length ?? 0) + (romanization?.length ?? 0);
    if (textSize > MAX_TEXT) fail('Lyrics exceed the 2 MiB text budget.');
    return {
      id: typeof entry.id === 'string' ? checkedText(entry.id, 'Line ID') : `structured-${index}`,
      text,
      startMs: startMs ?? words?.[0]?.startMs,
      endMs: endMs ?? (words?.length ? words.reduce((max, word) => Math.max(max, word.endMs), 0) : undefined),
      words: words?.length ? words : undefined,
      translation,
      romanization,
      isBackground: entry.isBackground === true || entry.isBG === true || (typeof entry.flag === 'number' && (entry.flag & 1) !== 0),
    };
  });
  return finish(lines, 'AMLL / structured lyrics');
}
