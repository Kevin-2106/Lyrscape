import type { AppState, ShortcutAction } from '../../sdk/types';
import { shortcutDefaults, shortcutLabels } from '../../plugins/shortcuts';
import type { PageDefinition } from '../context';
import { icons } from '../icons';
import { html, q } from '../kit/dom';
import { setValue, toggleField } from '../kit/fields';

export const overlayPage: PageDefinition = {
  id: 'overlay', title: '桌面歌词', subtitle: '独立的透明窗口，显示在其他应用上方', icon: icons.overlay,
  mount(root, { ctx, perform }) {
    const card = html(`<section class="card overlay-card">
      <div class="overlay-hero">
        <div><span class="state-pill" data-overlay-state>未显示</span><p class="helper" data-overlay-hint>独立的透明窗口，在其他应用上方显示歌词。</p></div>
        <button class="button-primary overlay-button" data-overlay-toggle title="显示 / 隐藏桌面歌词 (Ctrl+Shift+L)"></button>
      </div>
      <div class="settings-group flat">
        ${toggleField('窗口置顶', 'data-overlay="alwaysOnTop"', '保持在其他窗口上方')}
        ${toggleField('鼠标穿透', 'data-overlay="clickthrough"', '点击直接落到下方应用；开启后无法拖动或调整窗口')}
        ${toggleField('显示调整边框', 'data-overlay="borderVisible"', '标出窗口范围与左右拖拽边缘；调整时请关闭鼠标穿透')}
      </div>
      <ul class="tips">
        <li>关闭穿透后，拖动歌词中间移动窗口，拖动左右边缘调整宽度。</li>
        <li>长歌词自动换行，窗口高度随内容自动适配。</li>
        <li>桌面歌词沿用「文字样式」页与当前渲染器的设置。</li>
      </ul>
    </section>`);
    const keys = html(`<section class="card shortcut-card"><h2>全局快捷键</h2>
      <p class="helper">在其他程序中也能使用。输入组合，例如 Ctrl+Alt+L；留空并应用可取消注册。</p>
      ${Object.entries(shortcutLabels).map(([action, label]) => `<div class="shortcut-binding"><label class="field"><span>${label}</span><input type="text" data-shortcut="${action}" aria-label="${label}快捷键" spellcheck="false" placeholder="${shortcutDefaults[action as ShortcutAction]}"></label><button class="button-secondary" data-shortcut-apply="${action}">应用</button><p class="helper shortcut-status" data-shortcut-status="${action}" role="status"></p></div>`).join('')}
      <p class="helper">注册失败会警告并保留原快捷键。系统占用检测以实际注册结果为准。</p>
    </section>`);
    root.append(card, keys);
    const drafts = new Map<ShortcutAction, string>();
    const controller = new AbortController();
    const { signal } = controller;
    card.addEventListener('change', event => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.dataset.overlay) {
        const action = input.dataset.overlay as 'clickthrough' | 'alwaysOnTop' | 'borderVisible';
        void perform(() => ctx.overlay(action, input.checked));
      }
    }, { signal });
    q(card, '[data-overlay-toggle]').addEventListener('click', () =>
      void perform(() => ctx.overlay(ctx.getState().overlay.visible ? 'hide' : 'show')), { signal });
    keys.addEventListener('input', event => {
      if (event.target instanceof HTMLInputElement && event.target.dataset.shortcut) drafts.set(event.target.dataset.shortcut as ShortcutAction, event.target.value);
    }, { signal });
    keys.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-shortcut-apply]');
      if (!button) return;
      const action = button.dataset.shortcutApply as ShortcutAction;
      const input = q<HTMLInputElement>(keys, `[data-shortcut="${action}"]`);
      button.disabled = true;
      void perform(async () => {
        await ctx.globalShortcuts.set(action, input.value);
        drafts.delete(action);
        input.value = ctx.globalShortcuts.list().find(b => b.action === action)?.accelerator ?? '';
      }, '快捷键已更新').then(() => { if (!signal.aborted) button.disabled = !ctx.getState().isDesktop; });
    }, { signal });

    return {
      render(state: AppState) {
        const { overlay, isDesktop } = state;
        q(card, '[data-overlay-state]').textContent = overlay.visible ? '显示中' : '未显示';
        q(card, '[data-overlay-state]').classList.toggle('is-on', overlay.visible);
        q(card, '[data-overlay-hint]').textContent = isDesktop ? '独立的透明窗口，在其他应用上方显示歌词。' : '桌面歌词与 AMLL 服务需要在桌面应用中运行。';
        const button = q<HTMLButtonElement>(card, '[data-overlay-toggle]');
        button.title = `显示 / 隐藏桌面歌词 (${state.shortcuts?.find(b => b.action === 'visibility')?.accelerator || '未绑定'})`;
        button.innerHTML = `${overlay.visible ? '关闭桌面歌词' : '打开桌面歌词'}<span aria-hidden="true">${overlay.visible ? icons.close : icons.external}</span>`;
        button.disabled = !isDesktop;
        card.querySelectorAll<HTMLInputElement>('[data-overlay]').forEach(input => {
          setValue(input, overlay[input.dataset.overlay as 'alwaysOnTop' | 'clickthrough' | 'borderVisible']);
          input.disabled = !isDesktop;
        });
        for (const action of Object.keys(shortcutDefaults) as ShortcutAction[]) {
          const binding = state.shortcuts?.find(b => b.action === action);
          const input = q<HTMLInputElement>(keys, `[data-shortcut="${action}"]`);
          setValue(input, drafts.get(action) ?? binding?.accelerator ?? shortcutDefaults[action]); input.disabled = !isDesktop;
          const status = q(keys, `[data-shortcut-status="${action}"]`);
          status.textContent = !isDesktop ? '仅桌面版可注册' : binding?.error || (binding?.registered ? `已注册 · ${binding.accelerator}` : '未注册');
          status.classList.toggle('shortcut-warning', Boolean(binding?.error));
          if (!isDesktop) q<HTMLButtonElement>(keys, `[data-shortcut-apply="${action}"]`).disabled = true;
        }
      },
      dispose() { controller.abort(); root.replaceChildren(); },
    };
  },
};
