import type { AppState } from '../../sdk/types';
import { rendererName } from '../../plugins/management';
import { defaults } from '../../plugins/theme';
import { AUTO_FAMILIES } from '../../plugins/typeface';
import type { PageDefinition } from '../context';
import { createPreview } from '../components/preview';
import { icons } from '../icons';
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

export const stylePage: PageDefinition = {
  id: 'style', title: '文字样式', subtitle: '字体、颜色与显示细节，自动保存并同步到桌面歌词', icon: icons.style,
  mount(root, services) {
    const { ctx, perform } = services;
    const form = html(`<div class="style-form">
      <section class="card settings-group"><h3>字体与排版</h3>
        <label class="field"><span>字体</span><select data-font-select aria-label="预设字体">${fontFamilies.map(([, label], index) => `<option value="${index}">${label}</option>`).join('')}<option value="custom">自定义字体</option></select></label>
        <label class="field custom-font-field" data-custom-font-field hidden><span>CSS 字体族</span><input type="text" data-setting="fontFamily" placeholder='"Arial", "Microsoft YaHei", sans-serif' spellcheck="false"><small>使用本机已安装字体；填写 CSS font-family。不按歌词语言切换。</small></label>
        ${rangeField('fontSize', '字号', 18, 100, 1)}
        ${rangeField('fontWeight', '字重', 100, 900, 100)}
        ${rangeField('lineHeight', '行高', 1, 2.5, 0.05)}
        <div class="field"><span>对齐方式</span><div class="segmented alignment-tabs" role="group" aria-label="文字对齐"><button data-align="left" aria-label="左对齐">左对齐</button><button data-align="center" aria-label="居中">居中</button><button data-align="right" aria-label="右对齐">右对齐</button></div></div>
      </section>
      <section class="card settings-group"><h3>颜色与渐变</h3>
        ${colorField('color', '文字颜色')}
        ${colorField('inactiveColor', '未激活文字')}
        ${toggleField('渐变文字', 'data-setting="gradientEnabled"')}
        <div class="gradient-fields" data-gradient-fields>${colorField('gradientStart', '起始颜色')}${colorField('gradientEnd', '结束颜色')}${rangeField('gradientAngle', '渐变角度', 0, 360, 1)}<div class="gradient-swatch" data-gradient-swatch aria-label="渐变预览"></div></div>
        <p class="helper color-helper">颜色支持 HEX、RGB / RGBA 与 CSS 颜色名称。</p>
      </section>
      <section class="card settings-group"><h3>显示细节</h3>
        ${rangeField('shadow', '文字阴影', 0, 1, 0.05)}
        ${rangeField('backgroundOpacity', '背景不透明度', 0, 0.9, 0.05)}
        ${toggleField('显示译文', 'data-setting="showTranslation"')}
        ${toggleField('显示下一行', 'data-setting="showNextLine"')}
      </section>
      <div class="form-footer"><span class="helper">更改会自动保存</span><button class="button-secondary" data-reset-style>${icons.reset}恢复默认样式</button></div>
    </div>`);
    const side = html(`<aside class="style-preview" aria-label="样式预览"><div class="card preview-frame">
      <div class="preview-stage compact"><div id="style-preview" aria-label="样式预览"></div></div>
      <div class="preview-note"><span class="live-indicator"><i aria-hidden="true"></i>实时预览</span><span data-style-renderer></span></div>
    </div></aside>`);
    const layout = html('<div class="page-grid style-layout"></div>');
    layout.append(form, side);
    root.append(layout);

    const preview = createPreview(q(side, '#style-preview'), ctx);
    const fontSelect = q<HTMLSelectElement>(form, '[data-font-select]');
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
    fontSelect.addEventListener('change', () => {
      const family = fontFamilies[Number(fontSelect.value)]?.[0];
      q(form, '[data-custom-font-field]').hidden = fontSelect.value !== 'custom';
      if (family) void perform(() => ctx.updateSettings({ fontFamily: family }));
      else q<HTMLInputElement>(form, '[data-setting="fontFamily"]').focus();
    }, { signal });
    form.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.dataset.align) void perform(() => ctx.updateSettings({ textAlign: button.dataset.align as AppState['settings']['textAlign'] }));
      else if (button.matches('[data-reset-style]')) {
        void services.confirm({ title: '恢复默认样式？', body: '字体、颜色、渐变与显示细节将回到初始值；插件配置不受影响。', accept: '恢复默认', danger: true })
          .then(ok => ok && perform(() => ctx.resetSettings(), '已恢复默认样式。'));
      }
    }, { signal });

    return {
      render(state: AppState) {
        const { settings } = state;
        form.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(element =>
          setValue(element, settings[element.dataset.setting as keyof AppState['settings']]));
        const outputs: Record<string, string> = {
          fontSize: `${settings.fontSize}px`, fontWeight: String(settings.fontWeight),
          lineHeight: settings.lineHeight.toFixed(2), gradientAngle: `${settings.gradientAngle}°`,
          shadow: `${Math.round(settings.shadow * 100)}%`, backgroundOpacity: `${Math.round(settings.backgroundOpacity * 100)}%`,
        };
        form.querySelectorAll<HTMLOutputElement>('[data-output]').forEach(element => { element.value = outputs[element.dataset.output ?? ''] ?? ''; });
        const preset = fontFamilies.findIndex(([family]) => family === settings.fontFamily);
        if (document.activeElement !== fontSelect) fontSelect.value = preset < 0 ? 'custom' : String(preset);
        q(form, '[data-custom-font-field]').hidden = fontSelect.value !== 'custom';
        setSelected(form.querySelectorAll<HTMLButtonElement>('[data-align]'), button => button.dataset.align === settings.textAlign);
        q(form, '[data-gradient-fields]').classList.toggle('is-disabled', !settings.gradientEnabled);
        form.querySelectorAll<HTMLInputElement>('[data-gradient-fields] input').forEach(input => { input.disabled = !settings.gradientEnabled; });
        q(form, '[data-gradient-swatch]').style.background = `linear-gradient(${settings.gradientAngle}deg, ${settings.gradientStart}, ${settings.gradientEnd})`;
        q<HTMLButtonElement>(form, '[data-reset-style]').disabled = JSON.stringify(settings) === JSON.stringify(defaults);
        q(side, '[data-style-renderer]').textContent = `${rendererName(services.ctx.pluginManagement, state.plugins.rendererId) ?? '普通文字'}渲染器`;
      },
      activate: preview.activate, deactivate: preview.deactivate,
      dispose() { controller.abort(); preview.deactivate(); root.replaceChildren(); },
    };
  },
};
