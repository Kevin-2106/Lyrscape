// Plugin gallery: renders plugins.json (written by scripts/build-site.mjs).
// Plugin text comes from manifests, so it is always set with textContent.
const CATEGORY = { renderer: '渲染器', effect: '特效' };
const list = document.querySelector('[data-list]'), search = document.querySelector('[data-search]');
const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
let plugins = [];

function render() {
  const query = search.value.trim().toLowerCase();
  const shown = plugins.filter(p => !query || [p.name, p.id, p.description, ...(p.tags ?? [])].some(text => String(text ?? '').toLowerCase().includes(query)));
  list.replaceChildren(...shown.map(p => {
    const card = make('article', undefined, 'card plugin');
    const meta = make('div', undefined, 'meta');
    meta.append(make('span', CATEGORY[p.category] ?? p.category, 'tag'), make('span', `v${p.version}`), make('span', `${Math.max(1, Math.round(p.size / 1024))} KB`));
    if (p.author) meta.append(make('span', p.author));
    if (p.license) meta.append(make('span', p.license));
    const tags = make('div', undefined, 'meta');
    for (const tag of p.tags ?? []) tags.append(make('span', `#${tag}`));
    const download = make('a', '下载 .lyrx', 'button');
    download.href = p.file; download.download = p.file.split('/').pop();
    card.append(make('h3', p.name), meta, make('p', p.description), make('code', p.id), tags, download);
    if (p.homepage?.startsWith('https://')) { const home = make('a', '主页'); home.href = p.homepage; home.rel = 'noopener'; card.append(home); }
    return card;
  }));
  if (!shown.length) list.replaceChildren(make('p', plugins.length ? '没有匹配的插件。' : '还没有插件。', 'note'));
}

fetch('plugins.json').then(response => response.json()).then(data => { plugins = data.plugins ?? []; render(); })
  .catch(() => list.replaceChildren(make('p', '插件列表加载失败。', 'note')));
search.addEventListener('input', render);
