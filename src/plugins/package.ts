import type { ConfigValue, PluginManifest, PluginPackage } from '../sdk/types';
import { validateManifest } from './registry';

// `.lyrx` is the one exchange format for plugins: export, import, sharing and the
// pack script all produce or consume it. Pure data and Web Crypto only, so Node
// scripts and tests use the same checks as the app.

export const PACKAGE_FORMAT = 'lyrscape.plugin';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.lyrx';
export const MAX_JAVASCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_CSS_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** `sha256-<base64>` over UTF-8 javascript, one NUL byte, UTF-8 css. */
export async function packageIntegrity(javascript: string, css = ''): Promise<string> {
  const js = encoder.encode(javascript), style = encoder.encode(css);
  const data = new Uint8Array(js.length + 1 + style.length);
  data.set(js); data.set(style, js.length + 1);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let binary = '';
  for (const byte of hash) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

function config(input: unknown): Record<string, ConfigValue> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('config 必须是对象');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 40 || entries.some(([key, value]) => key.length > 32 || !['string', 'number', 'boolean'].includes(typeof value))) throw Error('config 只能包含最多 40 个文本 / 数字 / 布尔值');
  return Object.fromEntries(entries) as Record<string, ConfigValue>;
}

/** Validates an untrusted package object (parsed JSON) into a clean copy. */
export async function validatePackage(input: unknown): Promise<PluginPackage> {
  if (!input || typeof input !== 'object') throw Error('不是 Lyrscape 插件包');
  const value = input as Record<string, unknown>;
  if (value.format !== PACKAGE_FORMAT) throw Error('不是 Lyrscape 插件包（format 应为 lyrscape.plugin）');
  if (value.formatVersion !== PACKAGE_VERSION) throw Error(`不支持的插件包版本 ${String(value.formatVersion)}；请更新 Lyrscape`);
  const raw = value.manifest as Record<string, unknown> | undefined;
  const manifest = validateManifest(raw, typeof raw?.id === 'string' ? raw.id : '');
  if (typeof value.javascript !== 'string' || !value.javascript.trim()) throw Error('插件包缺少 javascript 模块');
  if (value.css !== undefined && typeof value.css !== 'string') throw Error('css 必须是文本');
  const javascript = value.javascript, css = (value.css as string | undefined) ?? '';
  if (bytes(javascript) > MAX_JAVASCRIPT_BYTES) throw Error('javascript 超过 2 MB');
  if (bytes(css) > MAX_CSS_BYTES) throw Error('css 超过 512 KB');
  if (value.integrity !== undefined) {
    if (typeof value.integrity !== 'string' || value.integrity !== await packageIntegrity(javascript, css)) throw Error('插件包校验失败：文件内容与 integrity 不一致，可能已损坏或被修改');
  }
  const pkg: PluginPackage = { format: PACKAGE_FORMAT, formatVersion: PACKAGE_VERSION, manifest, javascript, css };
  const values = config(value.config);
  if (values) pkg.config = values;
  if (typeof value.integrity === 'string') pkg.integrity = value.integrity;
  if (typeof value.exportedAt === 'string' && value.exportedAt.length <= 40) pkg.exportedAt = value.exportedAt;
  return pkg;
}

export async function parsePackage(text: string): Promise<PluginPackage> {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw Error('插件包不是有效的 JSON'); }
  return validatePackage(value);
}

export async function createPackage(manifest: PluginManifest, javascript: string, css = '', values?: Record<string, ConfigValue>): Promise<PluginPackage> {
  const pkg: PluginPackage = { format: PACKAGE_FORMAT, formatVersion: PACKAGE_VERSION, manifest, javascript, css,
    integrity: await packageIntegrity(javascript, css), exportedAt: new Date().toISOString() };
  if (values && Object.keys(values).length) pkg.config = values;
  return validatePackage(pkg);
}

export const packageFileName = (manifest: Pick<PluginManifest, 'id' | 'version'>) => `${manifest.id}-${manifest.version ?? '0.1.0'}${PACKAGE_EXTENSION}`;
export const serializePackage = (pkg: PluginPackage) => `${JSON.stringify(pkg, null, 2)}\n`;

/**
 * Wraps a bare ES module (`.mjs` with `export const manifest`) into a package.
 * Reading the manifest runs the module's top level, so call only after consent.
 */
export async function packageFromModule(javascript: string, css = ''): Promise<PluginPackage> {
  const url = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }));
  try {
    const module = await import(/* @vite-ignore */ url);
    const raw = module.manifest as Record<string, unknown> | undefined;
    if (!raw) throw Error('模块需要导出 manifest（export const manifest = {...}）');
    return createPackage(validateManifest(raw, typeof raw.id === 'string' ? raw.id : ''), javascript, css);
  } finally { URL.revokeObjectURL(url); }
}
