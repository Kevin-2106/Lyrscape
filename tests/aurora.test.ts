// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { PluginHost } from '../src/kernel/host';
import type { AppState, Renderer } from '../src/sdk/types';
import { auroraPlugin } from '../src/plugins/aurora';
import { AURORA_RENDERER, normalizePreferences } from '../src/plugins/management';
import { normalizeSettings } from '../src/plugins/theme';

afterEach(() => vi.unstubAllGlobals());
const setup = async (lyrics: AppState['lyrics']) => {
  let frame = () => {};
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frame = fn; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = new PluginHost(); await host.start([auroraPlugin]);
  const state = { lyrics, settings: normalizeSettings(null), plugins: normalizePreferences(null) } as AppState;
  const root = document.createElement('div'); let position = 500;
  const dispose = host.service<Renderer>('renderer.aurora@1').mount(root, () => state, { position: () => position });
  return { host, root, state, dispose, tick: () => frame(), seek: (value: number) => { position = value; frame(); } };
};

it('keeps real word progress, spacing and node identity across clock samples', async () => {
  const { root, tick, dispose } = await setup({ timingMode: 'word', lines: [
    { id: 'line', text: 'Hello world', startMs: 0, endMs: 3000, words: [{ text: 'Hello ', startMs: 0, endMs: 1000 }, { text: 'world', startMs: 1000, endMs: 2000 }] },
  ] });
  const word = root.querySelector<HTMLElement>('.word-fill')!;
  expect(word.style.clipPath).toBe('inset(0 50% 0 0)');
  expect([...root.querySelectorAll('.word-base')].map(e => e.textContent).join('')).toBe('Hello world');
  tick(); expect(root.querySelector('.word-fill')).toBe(word);
  dispose(); expect(root.children.length).toBe(0); expect(root.classList.contains('aurora-surface')).toBe(false);
});
it('renders literal markup and grapheme clusters without inventing word timestamps', async () => {
  const { root, dispose } = await setup({ timingMode: 'none', lines: [{ id: 'line', text: '<img>👨‍👩‍👧‍👦' }] });
  expect(root.querySelector('.lyric-current')!.textContent).toBe('<img>👨‍👩‍👧‍👦');
  expect(root.querySelector('img')).toBeNull(); expect(root.querySelectorAll('.word-fill')).toHaveLength(0);
  expect(root.querySelector('.lyric-current')!.lastChild!.textContent).toBe('👨‍👩‍👧‍👦'); dispose();
});
it('splits line-timed entrances by grapheme without fabricating played progress', async () => {
  const { root, seek, dispose } = await setup({ timingMode: 'line', lines: [
    { id: 'line', text: 'A 👨‍👩‍👧‍👦中', startMs: 0, endMs: 10000 },
  ] });
  const first = root.querySelector('.aurora-unit');
  expect([...root.querySelectorAll('.aurora-unit')].map(node => node.textContent)).toEqual(['A', ' ', '👨‍👩‍👧‍👦', '中']);
  expect(root.querySelectorAll('.word-fill,.word-base')).toHaveLength(0);
  seek(8000); expect(root.querySelector('.aurora-unit')).toBe(first);
  expect(root.querySelectorAll('.word-fill')).toHaveLength(0); dispose();
});
it('bounds individual entrance nodes and applies motion config on a revision', async () => {
  const { root, state, tick, dispose } = await setup({ timingMode: 'none', lines: [{ id: 'long', text: '长'.repeat(10000) }] });
  expect(root.querySelectorAll('.aurora-unit')).toHaveLength(1);
  const firstBlock = root.querySelector('.aurora-block');
  expect(firstBlock!.textContent).toHaveLength(10000);
  state.lyrics = { timingMode: 'none', lines: [{ id: 'next', text: '新'.repeat(1000) }] }; tick();
  expect(root.querySelector('.aurora-block')).not.toBe(firstBlock);
  expect(root.querySelectorAll('.aurora-unit')).toHaveLength(1);
  state.plugins.configs[AURORA_RENDERER].motion = false; tick();
  expect(root.classList.contains('aurora-motion')).toBe(false); dispose();
});
it('releases live mounts when disabled and leaves a replacement view intact on repeated disposal', async () => {
  const { host, root, tick, dispose } = await setup({ timingMode: 'none', lines: [{ id: 'text', text: '旧视图' }] });
  host.deactivate(AURORA_RENDERER);
  expect(root.children).toHaveLength(0); expect(root.classList.contains('aurora-surface')).toBe(false);
  root.textContent = '新的普通文字视图'; dispose(); tick();
  expect(root.textContent).toBe('新的普通文字视图');
});
it('preserves twinkling star nodes when lyrics and entrance configuration change', async () => {
  const { root, state, tick, dispose } = await setup({ timingMode: 'none', lines: [{ id: 'one', text: '第一行' }] });
  const stars = [...root.querySelectorAll('.aurora-ornament i')];
  expect(stars).toHaveLength(8);
  state.lyrics = { timingMode: 'none', lines: [{ id: 'two', text: '第二行' }] }; tick();
  state.plugins.configs[AURORA_RENDERER].entrance = 'prism'; tick();
  expect([...root.querySelectorAll('.aurora-ornament i')]).toEqual(stars); dispose();
});
it('does not sweep played progress when the source has only a whole-line time span', async () => {
  const { root, seek, dispose } = await setup({ timingMode: 'word', lines: [
    { id: 'line', text: '整行时间', startMs: 0, endMs: 10000, words: [{ text: '整行时间', startMs: 0, endMs: 10000 }] },
  ] });
  expect(root.querySelectorAll('.word-fill')).toHaveLength(0);
  expect([...root.querySelectorAll('.aurora-unit')].map(node => node.textContent)).toEqual(['整', '行', '时', '间']);
  seek(8000); expect(root.querySelectorAll('.word-fill')).toHaveLength(0); dispose();
});
