import type { AppState } from '../../sdk/types';
import type { PageDefinition } from '../context';
import { rendererName } from '../../plugins/management';
import { icons } from '../icons';
import { html, q } from '../kit/dom';
import { shortcuts } from '../shortcuts';
import { shortcutLabels } from '../../plugins/shortcuts';

export const aboutPage: PageDefinition = {
  id: 'about', title: '关于', subtitle: '版本、快捷键与数据', icon: icons.about,
  mount(root, services) {
    const { ctx } = services;
    const card = html(`<div class="page-grid two">
      <section class="card about-card">
        <div class="about-brand"><span class="brand-icon" aria-hidden="true">L</span><div><h2>Lyrscape</h2><p class="helper">让歌词成为风景 · All is plugin.</p></div></div>
        <dl class="facts"><dt>版本</dt><dd>${ctx.appVersion} · EARLY PREVIEW</dd><dt>运行环境</dt><dd data-runtime></dd><dt>渲染器</dt><dd data-renderer></dd></dl>
      </section>
      <section class="card about-card"><h2>快捷键</h2><dl class="shortcut-list">${shortcuts.map(item => `<dt>${item.label}</dt><dd><kbd>${item.keys}</kbd></dd>`).join('')}</dl><h3>全局快捷键</h3><dl class="shortcut-list" data-global-shortcuts></dl><p class="helper">在「桌面歌词」页配置并查看注册状态。</p></section>
      <section class="card about-card danger-zone"><h2>数据</h2><p class="helper">设置与插件偏好保存在本机。重置会清除它们并重新加载应用。</p><button class="button-danger" data-reset-all>${icons.reset}重置全部设置</button></section>
    </div>`);
    root.append(card);
    const button = q(card, '[data-reset-all]');
    const onReset = () => void services.confirm({ title: '重置全部设置？', body: '文字样式与所有插件偏好将被清除，应用会重新加载。歌词内容不受影响。', accept: '重置并重新加载', danger: true })
      .then(ok => { if (ok) ctx.resetEverything(); });
    button.addEventListener('click', onReset);
    return {
      render(state: AppState) {
        q(card, '[data-runtime]').textContent = state.isDesktop ? '桌面应用' : '浏览器预览';
        q(card, '[data-renderer]').textContent = rendererName(services.ctx.pluginManagement, state.plugins.rendererId) ?? state.plugins.rendererId;
        const list = q(card, '[data-global-shortcuts]'); list.replaceChildren();
        for (const binding of state.shortcuts ?? []) {
          const label = document.createElement('dt'), value = document.createElement('dd');
          label.textContent = shortcutLabels[binding.action]; value.textContent = `${binding.accelerator || '未绑定'}${binding.registered ? '' : '（未注册）'}`;
          list.append(label, value);
        }
      },
      dispose() { button.removeEventListener('click', onReset); root.replaceChildren(); },
    };
  },
};
