import { readFile, writeFile } from 'node:fs/promises';

// Paths come from the same explicit local catalog that Vite bundles.
const source = await readFile('src/plugins/font-catalog.ts', 'utf8');
const families = new Map();
for (const [, file] of source.matchAll(/import\('([^']+)\?inline'\)/g)) {
  const css = await readFile(`node_modules/${file}`, 'utf8');
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    if (!family) throw Error(`Missing family in ${file}`);
    const spans = families.get(family) ?? [];
    const ranges = /unicode-range:\s*([^;}]+)/.exec(body)?.[1] ?? 'U+0-10FFFF';
    for (const [, low, high] of ranges.matchAll(/U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/gi)) {
      spans.push([parseInt(low.replace(/\?/g, '0'), 16), parseInt(high ?? low.replace(/\?/g, 'f'), 16)]);
    }
    families.set(family, spans);
  }
}
const result = {};
for (const [family, spans] of families) {
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of spans) {
    if (merged.length && span[0] <= merged.at(-1)[1] + 1) merged.at(-1)[1] = Math.max(merged.at(-1)[1], span[1]);
    else merged.push([...span]);
  }
  const bytes = []; let previous = -1;
  const integer = value => { while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; } bytes.push(value); };
  for (const [lo, hi] of merged) { integer(lo - previous - 1); integer(hi - lo); previous = hi; }
  result[family] = Buffer.from(bytes).toString('base64');
}
const output = `${JSON.stringify(result)}\n`, target = 'src/plugins/font-ranges.json';
if (await readFile(target, 'utf8').catch(() => '') !== output) await writeFile(target, output);
console.log(`Font coverage: ${families.size} families, ${(Buffer.byteLength(output) / 1024).toFixed(1)} KiB`);
