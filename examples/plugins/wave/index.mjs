// 示例渲染器「波浪浮现」：一个完整、可直接打包的动态插件。
// 打包：npm run plugin:pack -- examples/plugins/wave/index.mjs
// 然后在 Lyrscape「全部插件」→「导入插件」选择生成的 .lyrx。

export const manifest = {
  id: 'example.renderer.wave',
  name: '示例 · 波浪浮现',
  description: '每个字依次从下方浮起；逐字歌词保留真实的填充进度。插件编写手册的配套示例。',
  category: 'renderer',
  version: '1.0.0',
  rendererService: 'renderer.example-wave@1',
  author: 'Lyrscape',
  license: 'MIT',
  tags: ['示例', '入门'],
  fields: [
    { key: 'height', label: '浮起高度（像素）', type: 'number', default: 18, min: 0, max: 60, step: 2 },
    { key: 'stagger', label: '字间隔（毫秒）', type: 'number', default: 40, min: 0, max: 120, step: 5 },
    { key: 'tint', label: '当前行描边', type: 'select', default: 'none', options: [
      { value: 'none', label: '无' }, { value: 'glow', label: '柔光' }, { value: 'outline', label: '描边' },
    ] },
  ],
};

export default {
  id: manifest.id,
  // sdk@1 is provided by the host in both windows: the shared DOM renderer and helpers.
  requires: ['sdk@1'],
  activate(ctx) {
    const sdk = ctx.service('sdk@1');
    const config = state => state.plugins.configs[manifest.id] ?? {};
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    ctx.provide(manifest.rendererService, sdk.ownRenderer(ctx, sdk.createDomRenderer({
      mount(root) {
        root.classList.add('wave-lyric');
        return () => root.classList.remove('wave-lyric');
      },
      // Re-run the entrance when an option changes, not on every frame.
      revision: state => JSON.stringify(config(state)),
      line(root, line, state) {
        const { height = 18, stagger = 40, tint = 'none' } = config(state);
        root.dataset.waveTint = tint;
        if (reduced() || typeof line.animate !== 'function') return;
        // Word-timed lines already contain one span per word; plain lines are split by grapheme.
        let units = [...line.querySelectorAll('.lyric-word')];
        if (!units.length && line.textContent) {
          const text = line.textContent;
          line.replaceChildren(...sdk.graphemes(text).map(part => Object.assign(document.createElement('span'), { className: 'wave-unit', textContent: part })));
          units = [...line.children];
        }
        units.slice(0, 96).forEach((unit, index) => unit.animate(
          [{ opacity: 0, transform: `translateY(${height}px)` }, { opacity: 1, transform: 'none' }],
          { duration: 520, delay: index * stagger, easing: 'cubic-bezier(.2,.9,.25,1.2)', fill: 'backwards' }));
      },
    })));
  },
};
