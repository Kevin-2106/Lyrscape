import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Writes THIRD_PARTY_NOTICES.txt: the licenses of everything shipped inside the
// app — the npm runtime dependencies (bundled fonts, @tauri-apps/api) with their
// license texts, and the Rust crates compiled into the exe. The app shows it in
// 设置 › 关于; the release workflow regenerates it before building.
// Run after `npm ci` with cargo on PATH: node scripts/build-notices.mjs
const OFL = 'SIL OPEN FONT LICENSE Version 1.1';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = [`Lyrscape ${pkg.version} — third-party notices`, '', 'Lyrscape itself is licensed under the MIT License (LICENSE).',
  'It includes the following third-party software and fonts.', ''];

let oflBody;
const section = title => out.push('='.repeat(78), title, '='.repeat(78), '');
section('Fonts and JavaScript packages (npm)');
for (const name of Object.keys(pkg.dependencies).sort()) {
  const dir = path.join('node_modules', name);
  const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
  out.push(`${name}@${meta.version} — ${meta.license}${repo ? `\n${repo.replace(/^git\+/, '')}` : ''}`, '');
  for (const file of readdirSync(dir).filter(f => /^(licen[cs]e|copying|ofl)/i.test(f) && !/\.spdx$/i.test(f)).sort()) {
    const text = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    const at = text.indexOf(OFL);
    if (at >= 0) {
      // Font licenses differ only in their copyright header; print the OFL text once at the end.
      oflBody ??= text.slice(text.lastIndexOf('-'.repeat(20), at) >= 0 ? text.lastIndexOf('-'.repeat(20), at) : at).trim();
      const header = text.slice(0, at).replace(/-{20,}\s*$/, '').trim();
      out.push(`  ${file}: ${header.split('\n').filter(Boolean).join('\n  ')}`, '  (SIL Open Font License 1.1, full text below)', '');
    } else out.push(text.split('\n').map(line => `  ${line}`.trimEnd()).join('\n'), '');
  }
}

section('Rust crates compiled into lyrscape.exe');
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--filter-platform', 'x86_64-pc-windows-msvc'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const byId = new Map(metadata.packages.map(p => [p.id, p]));
const root = metadata.resolve.root, nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
// Normal (runtime) dependencies only, walked from the app crate; build scripts and dev tools are not shipped.
const shipped = new Set(), stack = [root];
while (stack.length) {
  const id = stack.pop();
  if (shipped.has(id)) continue;
  shipped.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some(kind => kind.kind === null)) stack.push(dep.pkg);
}
shipped.delete(root);
const crates = [...shipped].map(id => byId.get(id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const licenses = new Map();
for (const crate of crates) licenses.set(crate.license ?? crate.license_file ?? 'see repository', (licenses.get(crate.license ?? crate.license_file ?? 'see repository') ?? 0) + 1);
out.push(`${crates.length} crates. Licenses: ${[...licenses].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join('; ')}.`,
  'Full MIT and Apache-2.0 texts follow; other license texts are in each crate\'s repository.', '');
for (const crate of crates) out.push(`${crate.name} ${crate.version} — ${crate.license ?? 'see repository'}${crate.repository ? ` — ${crate.repository}` : ''}`);
out.push('');

section('License texts');
out.push('SIL Open Font License 1.1', '', oflBody ?? '', '', '-'.repeat(78), '');
out.push('MIT License (as used by the packages and crates marked MIT; each with its own copyright notice in its repository)', '',
  readFileSync('LICENSE', 'utf8').replace(/Copyright \(c\)[^\n]*\n\n/, '').trim(), '', '-'.repeat(78), '');
// The Apache-2.0 text, as shipped by @tauri-apps/api (Apache-2.0 OR MIT).
out.push(readFileSync('node_modules/@tauri-apps/api/LICENSE-APACHE-2.0', 'utf8').trim(), '');
writeFileSync('THIRD_PARTY_NOTICES.txt', `${out.join('\n')}\n`);
console.log(`NOTICES THIRD_PARTY_NOTICES.txt (${Object.keys(pkg.dependencies).length} npm packages, ${crates.length} crates)`);
