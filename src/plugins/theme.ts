import type { Settings } from '../sdk/types';
import type { Plugin } from '../kernel/host';

/** The pre-auto default; stored settings still holding it follow the lyric language now. */
const LEGACY_DEFAULT_FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';

export const defaults: Settings = {
  color: '#f4f2ff', inactiveColor: '#777582', gradientEnabled: false,
  gradientStart: '#b7a0ff', gradientEnd: '#8cdce4', gradientAngle: 90,
  fontFamily: 'auto:sans', fontSize: 44, fontWeight: 600,
  textAlign: 'center', lineHeight: 1.45, shadow: 0.5, backgroundOpacity: 0,
  showTranslation: true, showNextLine: true,
};
const color = (value: unknown, fallback: string) => {
  if (typeof value !== 'string' || value.length > 100 || !value.trim()) return fallback;
  if (typeof CSS !== 'undefined' && CSS.supports('color', value)) return value;
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
};
const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function normalizeSettings(input: unknown): Settings {
  const s = input && typeof input === 'object' ? input as Partial<Settings> : {};
  return {
    color: color(s.color, defaults.color), inactiveColor: color(s.inactiveColor, defaults.inactiveColor),
    gradientStart: color(s.gradientStart, defaults.gradientStart), gradientEnd: color(s.gradientEnd, defaults.gradientEnd),
    gradientEnabled: typeof s.gradientEnabled === 'boolean' ? s.gradientEnabled : defaults.gradientEnabled,
    gradientAngle: number(s.gradientAngle, defaults.gradientAngle, 0, 360),
    fontFamily: typeof s.fontFamily === 'string' && s.fontFamily.trim().length > 0 && s.fontFamily.length <= 300
      && s.fontFamily.trim() !== LEGACY_DEFAULT_FONT ? s.fontFamily.trim() : defaults.fontFamily,
    fontSize: number(s.fontSize, defaults.fontSize, 18, 100),
    fontWeight: number(s.fontWeight, defaults.fontWeight, 100, 900),
    textAlign: ['left', 'center', 'right'].includes(s.textAlign ?? '') ? s.textAlign! : defaults.textAlign,
    lineHeight: number(s.lineHeight, defaults.lineHeight, 1, 2.5),
    shadow: number(s.shadow, defaults.shadow, 0, 1),
    backgroundOpacity: number(s.backgroundOpacity, defaults.backgroundOpacity, 0, 0.9),
    showTranslation: typeof s.showTranslation === 'boolean' ? s.showTranslation : defaults.showTranslation,
    showNextLine: typeof s.showNextLine === 'boolean' ? s.showNextLine : defaults.showNextLine,
  };
}

export const themePlugin: Plugin = {
  id: 'official.theme.basic',
  activate(ctx) { ctx.provide('theme@1', { defaults, normalize: normalizeSettings }); },
};
