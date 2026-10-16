import type { Plugin } from '../kernel/host';
import { activeLine, createDomRenderer, hasGranularWordTiming, ownRenderer } from './renderer';

/**
 * Host helpers for dynamically loaded plugins (`requires: ['sdk@1']`). A `.lyrx`
 * module cannot import the app's source, so the pieces built-ins share are handed
 * over as a service instead: the same DOM renderer with real word-timed fill,
 * mount ownership, and line lookup.
 */
export interface LyrscapeSdk {
  apiVersion: 1;
  createDomRenderer: typeof createDomRenderer;
  ownRenderer: typeof ownRenderer;
  activeLine: typeof activeLine;
  hasGranularWordTiming: typeof hasGranularWordTiming;
  /** Unicode grapheme clusters; never split lyrics with `split('')`. */
  graphemes(text: string): string[];
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

export const sdk: LyrscapeSdk = Object.freeze({
  apiVersion: 1, createDomRenderer, ownRenderer, activeLine, hasGranularWordTiming,
  graphemes: (text: string) => segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text),
});

export const sdkPlugin: Plugin = { id: 'official.sdk', activate(ctx) { ctx.provide<LyrscapeSdk>('sdk@1', sdk); } };
