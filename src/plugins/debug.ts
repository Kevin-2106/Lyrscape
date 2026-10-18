/**
 * Debug journal: a small in-memory record of what came in from outside (AMLL
 * wire messages, connection events) and what went wrong (plugin load failures,
 * uncaught errors), shown on the 调试 page. Always on, also in release builds;
 * bounded per channel so a long session cannot grow it.
 */
export type DebugChannel = 'amll' | 'smtc' | 'events';
export interface DebugEntry {
  id: number;
  channel: DebugChannel;
  /** Epoch ms when it was recorded. */
  at: number;
  /** Short kind used for filtering, e.g. `progress`, `setLyric`, `connected`, `error`. */
  kind: string;
  summary: string;
  /** JSON text of the original data, cut at MAX_DETAIL characters. */
  detail?: string;
  truncated?: boolean;
}

const LIMIT: Record<DebugChannel, number> = { amll: 400, smtc: 300, events: 200 };
const MAX_DETAIL = 256 * 1024;

const entries: Record<DebugChannel, DebugEntry[]> = { amll: [], smtc: [], events: [] };
const listeners = new Set<(entry: DebugEntry) => void>();
let next = 1, paused = false;

const stringify = (value: unknown): string => {
  try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
};

export const debugJournal = {
  record(channel: DebugChannel, kind: string, summary: string, detail?: unknown) {
    if (paused && channel !== 'events') return;
    let text = detail === undefined ? undefined : stringify(detail), truncated = false;
    if (text && text.length > MAX_DETAIL) { text = text.slice(0, MAX_DETAIL); truncated = true; }
    const entry: DebugEntry = { id: next++, channel, at: Date.now(), kind, summary, detail: text, ...(truncated ? { truncated } : {}) };
    const list = entries[channel];
    list.push(entry);
    if (list.length > LIMIT[channel]) list.splice(0, list.length - LIMIT[channel]);
    for (const listener of listeners) { try { listener(entry); } catch (error) { console.error(error); } }
  },
  list(channel: DebugChannel): readonly DebugEntry[] { return entries[channel]; },
  clear(channel: DebugChannel) { entries[channel].length = 0; },
  subscribe(listener: (entry: DebugEntry) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  get paused() { return paused; },
  /** Pausing stops recording AMLL and SMTC traffic (the lists keep what they have); events are always kept. */
  setPaused(value: boolean) { paused = value; },
};
export type DebugJournal = typeof debugJournal;

let watching = false;
/** Records uncaught errors and rejected promises of this window. */
export function watchErrors() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('error', event => debugJournal.record('events', 'error', event.message || '未捕获的错误',
    { message: event.message, source: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack }));
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    debugJournal.record('events', 'error', reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason);
  });
}
