import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

/** Code points a WOFF 1.0 file maps (cmap format 12, else 4), for faces published without unicode-range. */
function woffCoverage(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'wOFF') throw Error('not a WOFF 1.0 file');
  const tables = buffer.readUInt16BE(12);
  let cmap;
  for (let i = 0; i < tables; i++) {
    const at = 44 + i * 20;
    if (buffer.toString('latin1', at, at + 4) !== 'cmap') continue;
    const offset = buffer.readUInt32BE(at + 4), compressed = buffer.readUInt32BE(at + 8), length = buffer.readUInt32BE(at + 12);
    const raw = buffer.subarray(offset, offset + compressed);
    cmap = compressed < length ? inflateSync(raw) : raw;
  }
  if (!cmap) throw Error('WOFF without cmap');
  const records = cmap.readUInt16BE(2), subtables = [];
  for (let i = 0; i < records; i++) {
    const at = 4 + i * 8, platform = cmap.readUInt16BE(at), encoding = cmap.readUInt16BE(at + 2);
    if (platform === 3 || platform === 0) subtables.push({ format: cmap.readUInt16BE(cmap.readUInt32BE(at + 4)), offset: cmap.readUInt32BE(at + 4), encoding });
  }
  const spans = [];
  const twelve = subtables.find(table => table.format === 12), four = subtables.find(table => table.format === 4);
  if (twelve) {
    const groups = cmap.readUInt32BE(twelve.offset + 12);
    for (let g = 0; g < groups; g++) { const at = twelve.offset + 16 + g * 12; spans.push([cmap.readUInt32BE(at), cmap.readUInt32BE(at + 4)]); }
  } else if (four) {
    const base = four.offset, segments = cmap.readUInt16BE(base + 6) / 2;
    for (let s = 0; s < segments; s++) {
      const end = cmap.readUInt16BE(base + 14 + s * 2), start = cmap.readUInt16BE(base + 16 + segments * 2 + s * 2);
      if (start !== 0xffff) spans.push([start, end]);
    }
  } else throw Error('no Unicode cmap subtable');
  return spans;
}

// Paths come from the same explicit local catalog that Vite bundles.
const source = await readFile('src/plugins/font-catalog.ts', 'utf8');
const families = new Map();
for (const [, file] of source.matchAll(/import\('([^']+)\?inline'\)/g)) {
  const css = await readFile(`node_modules/${file}`, 'utf8');
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    if (!family) throw Error(`Missing family in ${file}`);
    const spans = families.get(family) ?? [];
    const ranges = /unicode-range:\s*([^;}]+)/.exec(body)?.[1];
    const woff = /url\(([^)]+\.woff)\)\s*format\('woff'\)/.exec(body)?.[1];
    if (!ranges && woff) spans.push(...woffCoverage(await readFile(join('node_modules', dirname(file), woff))));
    else for (const [, low, high] of (ranges ?? 'U+0-10FFFF').matchAll(/U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/gi)) {
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
