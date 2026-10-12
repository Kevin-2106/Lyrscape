import { expect, it } from 'vitest';
import { activeLine } from '../src/plugins/renderer';

it('keeps the active foreground line when a shorter background line ends', () => {
  const lines = [
    { id: 'main', text: 'Main', startMs: 0, endMs: 10000 },
    { id: 'bg', text: 'Background', startMs: 1000, endMs: 2000, isBackground: true },
  ];
  expect(activeLine(lines, 1500)).toBe(0); expect(activeLine(lines, 3000)).toBe(0);
  expect(activeLine(lines, 10000)).toBe(-1);
});

it('displays timed background lyrics if no foreground lyric is active', () => {
  expect(activeLine([{ id: 'bg', text: 'Hey', startMs: 1000, endMs: 2000, isBackground: true }], 1500)).toBe(0);
});
