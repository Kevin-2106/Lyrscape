import { chromium } from '@playwright/test';
const variant = process.argv[2] ?? 'baseline';
const styles = {
  baseline: '',
  'no-filter': '.overlay-page .lyric-current,.overlay-page .aurora-unit{filter:none!important}',
  'no-parent-gradient': '.overlay-page.gradient-text .lyric-current:has(.lyric-word),.overlay-page .gradient-text .lyric-current:has(.lyric-word){background:none!important}',
  'no-clip': '.overlay-page .word-fill{clip-path:none!important}',
  'no-3d': '.overlay-page .aurora-surface{perspective:none!important}.overlay-page .aurora-unit{transform:none!important}',
  safe: `.overlay-page .lyric-current,.overlay-page .aurora-unit{filter:none!important}
    .overlay-page .aurora-surface{perspective:none!important}
    .overlay-page .aurora-motion .aurora-unit{animation-name:qa-safe-entry!important}
    @keyframes qa-safe-entry{0%{opacity:0;transform:translate(-35px,24px) rotate(-12deg) scale(.6)}70%{opacity:1;transform:translateY(-4px) scale(1.08)}100%{opacity:1;transform:none}}`,
};
if (!(variant in styles)) throw Error(`Unknown variant: ${variant}`);
const browser = await chromium.connectOverCDP(process.env.LYRSCAPE_CDP ?? 'http://127.0.0.1:9228');
try {
  const overlay = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('surface=overlay'));
  if (!overlay) throw Error('Overlay missing');
  await overlay.evaluate(css => {
    let style = document.querySelector('#qa-compositing-probe');
    if (!style) { style = document.createElement('style'); style.id = 'qa-compositing-probe'; document.head.append(style); }
    style.textContent = css;
  }, styles[variant]);
  const main = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().includes('surface=overlay'));
  if (main) {
    const entrance = process.argv[3];
    if (entrance) {
      if (!['comet', 'orbit', 'prism'].includes(entrance)) throw Error('Unknown entrance preset');
      await main.evaluate(value => {
        const input = document.querySelector('[data-plugin-id="official.renderer.aurora"] [data-plugin-config="entrance"]');
        input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
      }, entrance);
    }
    await main.evaluate(() => { document.querySelector('[data-restart]').click(); document.querySelector('[data-plugin-id="official.renderer.text"] [data-plugin-use]').click(); });
    await main.waitForTimeout(150);
    await main.evaluate(() => document.querySelector('[data-plugin-id="official.renderer.aurora"] [data-plugin-use]').click());
  }
  console.log(`Applied diagnostic variant: ${variant}`);
} finally { await browser.close(); }
