import type { AppState } from '../../sdk/types';
import { defaults } from '../../plugins/theme';
import { AUTO_FAMILIES } from '../../plugins/typeface';
import type { UiServices } from '../context';
import { html, q } from '../kit/dom';
import { colorField, rangeField, setSelected, setValue, toggleField } from '../kit/fields';

// Automatic presets use the bundled CJK faces and pick Simplified / Traditional / Japanese per lyric.
const fontFamilies = [
  ...Object.entries(AUTO_FAMILIES).map(([value, { label }]) => [value, value === defaults.fontFamily ? `${label}（默认）` : label] as const),
  ['system-ui, "Microsoft YaHei", sans-serif', '系统字体'],
  ['"Microsoft YaHei", sans-serif', '微软雅黑'],
  ['"Segoe UI", "Microsoft YaHei", sans-serif', 'Segoe UI'],
  ['"SimSun", serif', '宋体'],
  ['"KaiTi", serif', '楷体'],
  ['"Consolas", "Microsoft YaHei", monospace', '等宽字体'],
] as const;
const colorKeys = ['color', 'inactiveColor', 'gradientStart', 'gradientEnd'];

/**
 * Parts of the shared text theme. `display` (size, background, translation) applies
 * to every renderer; `font` and `color` only to renderers that follow the theme.
 */
export type ThemeSection = 'font' | 'color' | 'display';
/** Settings each section owns, so a tab can restore just its own defaults. */
export const sectionKeys: Record<ThemeSection, (keyof AppState['settings'])[]> = {
  font: ['fontFamily', 'fontWeight', 'lineHeight', 'textAlign'],
  color: ['color', 'inactiveColor', 'gradientEnabled', 'gradientStart', 'gradientEnd', 'gradientAngle', 'shadow'],
  display: ['fontSize', 'backgroundOpacity', 'showTranslation', 'showNextLine'],
};

const templates: Record<ThemeSection, string> = {
  font: `<section class="inspector-section" data-theme-section="font"><header class="section-head"><h3>字体与排版</h3></header>
      <label class="field"><span>字体</span><select data-font-select aria-label="预设字体">${fontFamilies.map(([, label], index) => `<option value="${index}">${label}</option>`).join('')}<option value="custom">自定义字体</option></select></label>
      <label class="field custom-font-field" data-custom-font-field hidden><span>CSS 字体族</span><input type="text" data-setting="fontFamily" placeholder='"Arial", "Microsoft YaHei", sans-serif' spellcheck="false"><small>使用本机已安装字体；填写 CSS font-family。不按歌词语言切换。</small></label>
      ${rangeField('fontWeight', '字重', 100, 900, 100)}
      ${rangeField('lineHeight', '行高', 1, 2.5, 0.05)}
      <div class="field"><span>对齐方式</span><div class="segmented alignment-tabs" role="group" aria-label="文字对齐"><button data-align="left" aria-label="左对齐">左</button><button data-align="center" aria-label="居中">中</button><button data-align="right" aria-label="右对齐">右</button></div></div>
    </section>`,
  color: `<section class="inspector-section" data-theme-section="color"><header class="section-head"><h3>文字颜色与渐变</h3></header>
      ${colorField('color', '文字颜色')}
      ${colorField('inactiveColor', '未激活文字')}
      ${toggleField('渐变文字', 'data-setting="gradientEnabled"')}
      <div class="gradient-fields" data-gradient-fields>${colorField('gradientStart', '起始颜色')}${colorField('gradientEnd', '结束颜色')}${rangeField('gradientAngle', '渐变角度', 0, 360, 1)}<div class="gradient-swatch" data-gradient-swatch aria-label="渐变预览"></div></div>
      ${rangeField('shadow', '文字阴影', 0, 1, 0.05)}
      <p class="helper color-helper">颜色支持 HEX、RGB / RGBA 与 CSS 颜色名称。</p>
    </section>`,
  display: `<section class="inspector-section" data-theme-section="display"><header class="section-head"><h3>显示</h3></header>
      ${rangeField('fontSize', '字号', 18, 100, 1)}
      ${rangeField('backgroundOpacity', '背景不透明度', 0, 0.9, 0.05)}
      ${toggleField('显示译文', 'data-setting="showTranslation"')}
      ${toggleField('显示下一行', 'data-setting="showNextLine"')}
      <p class="helper">同步到桌面歌词，所有渲染器共用。</p>
    </section>`,
};

/**
 * Shared text theme sections (font, colors, display). `nextLine` decides whether
 * the 显示下一行 switch is offered; it only affects renderers that draw it.
 */
export function mountTextPanel(host: HTMLElement, services: UiServices, sections: ThemeSection[], nextLine = true): { render(state: AppState): void; dispose(): void } {
  const { ctx, perform } = services;
  const form = html(`<div class="style-form">${sections.map(section => templates[section]).join('')}</div>`);
  host.append(form);
  const fontSelect = form.querySelector<HTMLSelectElement>('[data-font-select]');
  form.querySelector('[data-setting="showNextLine"]')?.closest('label')?.toggleAttribute('hidden', !nextLine);
  const controller = new AbortController();
  const { signal } = controller;

  form.addEventListener('input', event => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement)) return;
    const key = element.dataset.setting as keyof AppState['settings'] | undefined;
    if (!key) return;
    const value = element.type === 'checkbox' ? element.checked : element.type === 'range' ? Number(element.value) : element.value;
    if (colorKeys.includes(key) && !CSS.supports('color', String(value))) { element.setAttribute('aria-invalid', 'true'); return; }
    if (key === 'fontFamily' && !String(value).trim()) return;
    element.removeAttribute('aria-invalid');
    void perform(() => ctx.updateSettings({ [key]: value }));
  }, { signal });
  fontSelect?.addEventListener('change', () => {
    const family = fontFamilies[Number(fontSelect.value)]?.[0];
    q(form, '[data-custom-font-field]').hidden = fontSelect.value !== 'custom';
    if (family) void perform(() => ctx.updateSettings({ fontFamily: family }));
    else q<HTMLInputElement>(form, '[data-setting="fontFamily"]').focus();
  }, { signal });
  form.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (button?.dataset.align) void perform(() => ctx.updateSettings({ textAlign: button.dataset.align as AppState['settings']['textAlign'] }));
  }, { signal });

  let rendered: AppState['settings'] | undefined;
  return {
    render(state: AppState) {
      const { settings } = state;
      if (settings === rendered) return;
      rendered = settings;
      form.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(element =>
        setValue(element, settings[element.dataset.setting as keyof AppState['settings']]));
      const outputs: Record<string, string> = {
        fontSize: `${settings.fontSize}px`, fontWeight: String(settings.fontWeight),
        lineHeight: settings.lineHeight.toFixed(2), gradientAngle: `${settings.gradientAngle}°`,
        shadow: `${Math.round(settings.shadow * 100)}%`, backgroundOpacity: `${Math.round(settings.backgroundOpacity * 100)}%`,
      };
      form.querySelectorAll<HTMLOutputElement>('[data-output]').forEach(element => { element.value = outputs[element.dataset.output ?? ''] ?? ''; });
      form.querySelectorAll<HTMLInputElement>('input[type="range"][data-setting]').forEach(element => {
        const min = Number(element.min), max = Number(element.max);
        element.style.setProperty('--progress', `${(Number(element.value) - min) / (max - min) * 100}%`);
      });
      if (fontSelect) {
        const preset = fontFamilies.findIndex(([family]) => family === settings.fontFamily);
        if (document.activeElement !== fontSelect) fontSelect.value = preset < 0 ? 'custom' : String(preset);
        q(form, '[data-custom-font-field]').hidden = fontSelect.value !== 'custom';
        setSelected(form.querySelectorAll<HTMLButtonElement>('[data-align]'), button => button.dataset.align === settings.textAlign);
      }
      const gradient = form.querySelector<HTMLElement>('[data-gradient-fields]');
      if (gradient) {
        gradient.classList.toggle('is-disabled', !settings.gradientEnabled);
        gradient.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = !settings.gradientEnabled; });
        q(form, '[data-gradient-swatch]').style.background = `linear-gradient(${settings.gradientAngle}deg, ${settings.gradientStart}, ${settings.gradientEnd})`;
      }
    },
    dispose() { controller.abort(); form.remove(); },
  };
}
