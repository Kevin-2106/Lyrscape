import type { AppState, ShortcutAction } from '../../sdk/types';
import { rendererName } from '../../plugins/management';
import { shortcutDefaults, shortcutLabels } from '../../plugins/shortcuts';
import type { PageDefinition } from '../context';
import { icons } from '../icons';
import { html, q } from '../kit/dom';
import { setValue } from '../kit/fields';
import { shortcuts } from '../shortcuts';

const settingRow = (icon: string, label: string, hint: string, control: string) =>
  `<div class="setting-row"><span class="setting-icon" aria-hidden="true">${icon}</span><span class="setting-text"><span>${label}</span><small>${hint}</small></span><span class="setting-control">${control}</span></div>`;
const switchControl = (attribute: string, label: string) =>
  `<label class="switch-host"><input class="switch" type="checkbox" ${attribute} aria-label="${label}"><span class="switch-track" aria-hidden="true"></span></label>`;

/** Application settings as grouped rows: overlay window, global and in-app shortcuts, data, about. */
export const settingsPage: PageDefinition = {
  id: 'settings', group: '应用', title: '设置', subtitle: '桌面歌词窗口、快捷键与数据', icon: icons.settings,
  mount(root, services) {
    const { ctx, perform } = services;
    const page = html(`<div class="settings-page">
      <section class="settings-section" aria-labelledby="settings-overlay">
        <h2 id="settings-overlay">桌面歌词</h2>
        <div class="setting-card">
          <div class="setting-row is-hero"><span class="setting-icon" aria-hidden="true">${icons.overlay}</span><span class="setting-text"><span>桌面歌词窗口 <span class="state-pill" data-overlay-state>未显示</span></span><small data-overlay-hint>独立的透明窗口，在其他应用上方显示歌词。</small></span><span class="setting-control"><button class="button-primary overlay-button" data-overlay-toggle></button></span></div>
          ${settingRow(icons.pin, '窗口置顶', '保持在其他窗口上方', switchControl('data-overlay="alwaysOnTop"', '窗口置顶'))}
          ${settingRow(icons.pointer, '鼠标穿透', '点击直接落到下方应用；开启后无法拖动或调整窗口', switchControl('data-overlay="clickthrough"', '鼠标穿透'))}
          ${settingRow(icons.frame, '显示调整边框', '标出窗口范围与左右拖拽边缘；调整时请关闭鼠标穿透', switchControl('data-overlay="borderVisible"', '显示调整边框'))}
        </div>
        <p class="helper section-note">关闭穿透后拖动歌词中间移动窗口、拖动左右边缘调整宽度；高度随内容自动适配。桌面歌词沿用当前渲染器与文字样式。</p>
      </section>
      <section class="settings-section" aria-labelledby="settings-global" data-shortcut-card>
        <h2 id="settings-global">全局快捷键</h2>
        <div class="setting-card">
          ${Object.entries(shortcutLabels).map(([action, label]) => `<div class="setting-row shortcut-binding"><span class="setting-icon" aria-hidden="true">${icons.keyboard}</span><span class="setting-text"><span>${label}</span><small class="shortcut-status" data-shortcut-status="${action}" role="status"></small></span><span class="setting-control"><input type="text" data-shortcut="${action}" aria-label="${label}快捷键" spellcheck="false" placeholder="${shortcutDefaults[action as ShortcutAction]}"><button class="button-secondary" data-shortcut-apply="${action}">应用</button></span></div>`).join('')}
        </div>
        <p class="helper section-note">在其他程序中也能使用。输入组合，例如 Ctrl+Alt+L；留空并应用可取消注册。注册失败会保留原快捷键。</p>
      </section>
      <section class="settings-section" aria-labelledby="settings-keys">
        <h2 id="settings-keys">应用内快捷键</h2>
        <div class="setting-card"><dl class="shortcut-list">${shortcuts.map(item => `<dt>${item.label}</dt><dd><kbd>${item.keys}</kbd></dd>`).join('')}</dl></div>
      </section>
      <section class="settings-section" aria-labelledby="settings-data">
        <h2 id="settings-data">数据</h2>
        <div class="setting-card">${settingRow(icons.database, '重置全部设置', '文字样式、插件偏好与快捷键保存在本机；重置后重新加载应用。已安装的插件文件保留。', `<button class="button-danger" data-reset-all>${icons.reset}重置</button>`)}</div>
      </section>
      <section class="settings-section about-section" aria-labelledby="settings-about">
        <h2 id="settings-about">关于</h2>
        <div class="setting-card about-card">
          <div class="about-brand"><span class="brand-icon" aria-hidden="true">L</span><div><strong>Lyrscape</strong><p class="helper">让歌词成为风景 · All is plugin.</p></div></div>
          <dl class="facts"><dt>版本</dt><dd>${ctx.appVersion} · EARLY PREVIEW</dd><dt>运行环境</dt><dd data-runtime></dd><dt>当前渲染器</dt><dd data-renderer></dd><dt>插件</dt><dd data-plugin-summary></dd></dl>
        </div>
      </section>
    </div>`);
    root.append(page);
    const drafts = new Map<ShortcutAction, string>();
    const controller = new AbortController();
    const { signal } = controller;
    page.addEventListener('change', event => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.dataset.overlay) {
        const action = input.dataset.overlay as 'clickthrough' | 'alwaysOnTop' | 'borderVisible';
        void perform(() => ctx.overlay(action, input.checked));
      }
    }, { signal });
    page.addEventListener('input', event => {
      if (event.target instanceof HTMLInputElement && event.target.dataset.shortcut) drafts.set(event.target.dataset.shortcut as ShortcutAction, event.target.value);
    }, { signal });
    page.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.matches('[data-overlay-toggle]')) void perform(() => ctx.overlay(ctx.getState().overlay.visible ? 'hide' : 'show'));
      else if (button.matches('[data-reset-all]')) {
        void services.confirm({ title: '重置全部设置？', body: '文字样式与所有插件偏好将被清除，应用会重新加载。歌词内容和已安装的插件文件不受影响。', accept: '重置并重新加载', danger: true })
          .then(ok => { if (ok) ctx.resetEverything(); });
      } else if (button.dataset.shortcutApply) {
        const action = button.dataset.shortcutApply as ShortcutAction;
        const input = q<HTMLInputElement>(page, `[data-shortcut="${action}"]`);
        button.disabled = true;
        void perform(async () => {
          await ctx.globalShortcuts.set(action, input.value);
          drafts.delete(action);
          input.value = ctx.globalShortcuts.list().find(b => b.action === action)?.accelerator ?? '';
        }, '快捷键已更新').then(() => { if (!signal.aborted) button.disabled = !ctx.getState().isDesktop; });
      }
    }, { signal });

    return {
      render(state: AppState) {
        const { overlay, isDesktop } = state;
        q(page, '[data-overlay-state]').textContent = overlay.visible ? '显示中' : '未显示';
        q(page, '[data-overlay-state]').classList.toggle('is-on', overlay.visible);
        q(page, '[data-overlay-hint]').textContent = isDesktop ? '独立的透明窗口，在其他应用上方显示歌词。' : '桌面歌词与 AMLL 服务需要在桌面应用中运行。';
        const button = q<HTMLButtonElement>(page, '[data-overlay-toggle]');
        button.title = `显示 / 隐藏桌面歌词 (${state.shortcuts?.find(b => b.action === 'visibility')?.accelerator || '未绑定'})`;
        button.innerHTML = `${overlay.visible ? '关闭桌面歌词' : '打开桌面歌词'}<span aria-hidden="true">${overlay.visible ? icons.close : icons.external}</span>`;
        button.disabled = !isDesktop;
        page.querySelectorAll<HTMLInputElement>('[data-overlay]').forEach(input => {
          setValue(input, overlay[input.dataset.overlay as 'alwaysOnTop' | 'clickthrough' | 'borderVisible']);
          input.disabled = !isDesktop;
        });
        for (const action of Object.keys(shortcutDefaults) as ShortcutAction[]) {
          const binding = state.shortcuts?.find(b => b.action === action);
          const input = q<HTMLInputElement>(page, `[data-shortcut="${action}"]`);
          setValue(input, drafts.get(action) ?? binding?.accelerator ?? shortcutDefaults[action]); input.disabled = !isDesktop;
          const status = q(page, `[data-shortcut-status="${action}"]`);
          status.textContent = !isDesktop ? '仅桌面版可注册' : binding?.error || (binding?.registered ? `已注册 · ${binding.accelerator}` : '未注册');
          status.classList.toggle('shortcut-warning', Boolean(binding?.error));
          if (!isDesktop) q<HTMLButtonElement>(page, `[data-shortcut-apply="${action}"]`).disabled = true;
        }
        q(page, '[data-runtime]').textContent = isDesktop ? '桌面应用' : '浏览器预览';
        q(page, '[data-renderer]').textContent = rendererName(ctx.pluginManagement, state.plugins.rendererId) ?? state.plugins.rendererId;
        const plugins = ctx.pluginManagement.list();
        q(page, '[data-plugin-summary]').textContent = `${plugins.filter(p => p.active).length} 个运行中 · ${plugins.filter(p => p.origin !== 'builtin').length} 个已安装`;
      },
      reveal(target) { page.querySelector(`#settings-${target}`)?.scrollIntoView({ block: 'start' }); },
      dispose() { controller.abort(); root.replaceChildren(); },
    };
  },
};
