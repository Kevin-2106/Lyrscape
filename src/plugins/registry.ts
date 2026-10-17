import type { Plugin } from '../kernel/host';
import type { ConfigField, PluginCategory, PluginInfo, PluginManifest, PluginOrigin, ThemeUse } from '../sdk/types';

export interface RegistryEntry { info: PluginInfo; plugin: Plugin; origin: PluginOrigin }

/** Plugin IDs are dotted lowercase names, which also keeps them safe as file names. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){1,5}$/;
const SERVICE = /^renderer\.[a-z0-9][a-z0-9.-]*@\d{1,4}$/;
const FIELD_KEY = /^[A-Za-z][\w-]{0,31}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const THEME_USES: ThemeUse[] = ['font', 'color', 'nextLine'];
const CATEGORIES: PluginCategory[] = ['playback-adapter', 'audio-provider', 'lyric-parser', 'timeline-provider', 'renderer', 'theme', 'effect', 'surface', 'settings'];
/** Categories a rescan may add; others need host wiring that only a rebuild provides. */
export const ADDABLE_CATEGORIES: PluginCategory[] = ['renderer', 'effect'];

const text = (value: unknown, name: string, max: number, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`manifest.${name} 必须是 1–${max} 字的文本`);
  return value;
};
function field(input: unknown, index: number): ConfigField {
  if (!input || typeof input !== 'object') throw Error(`manifest.fields[${index}] 必须是对象`);
  const value = input as Record<string, unknown>;
  if (typeof value.key !== 'string' || !FIELD_KEY.test(value.key)) throw Error(`manifest.fields[${index}].key 无效`);
  const result: ConfigField = { key: value.key, label: text(value.label, `fields[${index}].label`, 40)!, type: value.type as ConfigField['type'], default: false,
    description: text(value.description, `fields[${index}].description`, 200, true) };
  if (value.group !== undefined) result.group = text(value.group, `fields[${index}].group`, 8)!;
  if (value.type === 'boolean') {
    if (typeof value.default !== 'boolean') throw Error(`${value.key}: 布尔配置的默认值必须是 true / false`);
    result.default = value.default;
  } else if (value.type === 'number') {
    const numbers = [value.default, value.min, value.max, value.step ?? 1];
    if (numbers.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw Error(`${value.key}: 数字配置需要有限的 default / min / max`);
    const [def, min, max, step] = numbers as number[];
    if (min > max || def < min || def > max || step <= 0) throw Error(`${value.key}: 数字范围无效`);
    Object.assign(result, { default: def, min, max, step });
  } else if (value.type === 'select') {
    const options = value.options;
    if (!Array.isArray(options) || !options.length || options.length > 40) throw Error(`${value.key}: 选择配置需要 1–40 个选项`);
    result.options = options.map((option, i) => {
      if (!option || typeof option.value !== 'string' || !option.value) throw Error(`${value.key}: 选项 ${i} 无效`);
      return { value: option.value, label: text(option.label, `${value.key}.options[${i}].label`, 40)! };
    });
    if (!result.options.some(option => option.value === value.default)) throw Error(`${value.key}: 默认值不在选项中`);
    result.default = value.default as string;
  } else if (value.type === 'color') {
    if (typeof value.default !== 'string' || !HEX.test(value.default)) throw Error(`${value.key}: 颜色配置的默认值必须是 #rrggbb`);
    result.default = value.default.toLowerCase();
  } else throw Error(`${value.key}: 不支持的配置类型`);
  if (result.description === undefined) delete result.description;
  return result;
}

/** Validates an untrusted manifest (local files, rebuilt source) into a clean copy. */
export function validateManifest(input: unknown, expectedId: string): PluginManifest {
  if (!input || typeof input !== 'object') throw Error('插件需要导出 manifest 对象');
  const value = input as Record<string, unknown>;
  if (value.id !== expectedId || !PLUGIN_ID.test(expectedId)) throw Error(`manifest.id 必须与插件 ID 相同：${expectedId}`);
  if (!CATEGORIES.includes(value.category as PluginCategory)) throw Error('manifest.category 无效');
  const category = value.category as PluginCategory;
  const manifest: PluginManifest = { id: expectedId, name: text(value.name, 'name', 60)!, description: text(value.description, 'description', 300)!, category };
  const version = text(value.version, 'version', 20, true);
  if (version) manifest.version = version;
  const author = text(value.author, 'author', 60, true), license = text(value.license, 'license', 40, true);
  if (author) manifest.author = author;
  if (license) manifest.license = license;
  if (value.homepage !== undefined) {
    if (typeof value.homepage !== 'string' || value.homepage.length > 200 || !/^https:\/\/[^\s]+$/.test(value.homepage)) throw Error('manifest.homepage 必须是 https:// 链接');
    manifest.homepage = value.homepage;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 8 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 16)) throw Error('manifest.tags 最多 8 个、每个 1–16 字');
    manifest.tags = [...new Set(value.tags as string[])];
  }
  if (category === 'renderer') {
    if (typeof value.rendererService !== 'string' || !SERVICE.test(value.rendererService)) throw Error('渲染器 manifest 需要 rendererService，例如 renderer.my-style@1');
    manifest.rendererService = value.rendererService;
  } else if (value.rendererService !== undefined) throw Error('只有渲染器可以声明 rendererService');
  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields) || value.fields.length > 40) throw Error('manifest.fields 必须是最多 40 项的数组');
    manifest.fields = value.fields.map(field);
    const keys = new Set(manifest.fields.map(f => f.key));
    if (keys.size !== manifest.fields.length) throw Error('manifest.fields 的 key 不能重复');
  }
  if (value.theme !== undefined) {
    if (category !== 'renderer') throw Error('只有渲染器可以声明 theme');
    if (!Array.isArray(value.theme) || value.theme.some(use => !THEME_USES.includes(use as ThemeUse))) throw Error('manifest.theme 只能包含 font / color / nextLine');
    manifest.theme = [...new Set(value.theme as ThemeUse[])];
  }
  if (value.surfaces !== undefined) {
    if (!Array.isArray(value.surfaces) || !value.surfaces.length || value.surfaces.some(s => s !== 'control' && s !== 'overlay')) throw Error('manifest.surfaces 只能包含 control / overlay');
    manifest.surfaces = [...new Set(value.surfaces as ('control' | 'overlay')[])];
  }
  return manifest;
}

/** Windows that run a plugin: renderers and effects draw in both unless the manifest narrows it. */
export const surfacesOf = (manifest: Pick<PluginManifest, 'category' | 'surfaces'>): ('control' | 'overlay')[] =>
  manifest.surfaces ?? (manifest.category === 'renderer' || manifest.category === 'effect' ? ['control', 'overlay'] : ['control']);

export const infoOf = (manifest: PluginManifest, essential = false): PluginInfo => ({
  id: manifest.id, name: manifest.name, description: manifest.description, category: manifest.category,
  version: manifest.version ?? '0.1.0', ...(essential ? { essential } : {}),
  ...(manifest.rendererService ? { rendererService: manifest.rendererService } : {}), ...(manifest.fields ? { fields: manifest.fields } : {}),
  ...Object.fromEntries((['surfaces', 'theme', 'author', 'homepage', 'license', 'tags'] as const).filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]])),
});

/** Comparable metadata in a fixed shape (property order and implied defaults ignored), so a rescan only reports real changes. */
export const metadataKey = (info: PluginInfo) => JSON.stringify([info.name, info.description, info.category, info.version, info.rendererService ?? '',
  info.surfaces ?? [], info.theme ?? null, info.author ?? '', info.homepage ?? '', info.license ?? '', info.tags ?? [],
  (info.fields ?? []).map(f => [f.key, f.label, f.description ?? '', f.type, f.group ?? '', f.default, f.min ?? null, f.max ?? null,
    f.type === 'number' ? f.step ?? 1 : null, (f.options ?? []).map(o => [o.value, o.label])])]);

/**
 * The live plugin list of one window. Management, renderer selection and UI
 * read it instead of fixed tables, so a rescan can add, remove or re-describe
 * plugins without reloading the page.
 */
export class PluginRegistry {
  private entries = new Map<string, RegistryEntry>();
  private listeners = new Set<() => void>();
  constructor(entries: Iterable<RegistryEntry> = []) { for (const entry of entries) this.entries.set(entry.info.id, entry); }
  list(): RegistryEntry[] { return [...this.entries.values()]; }
  get(id: string): RegistryEntry | undefined { return this.entries.get(id); }
  has(id: string): boolean { return this.entries.has(id); }
  /** Renderer entries, in registration order. */
  renderers(): { id: string; name: string; service: string }[] {
    return this.list().filter(entry => entry.info.rendererService).map(({ info }) => ({ id: info.id, name: info.name, service: info.rendererService! }));
  }
  /** Which registered plugin (other than `except`) already claims a renderer service. */
  serviceOwner(service: string, except?: string): string | undefined {
    return this.list().find(entry => entry.info.id !== except && entry.info.rendererService === service)?.info.id;
  }
  set(entry: RegistryEntry): void { this.entries.set(entry.info.id, entry); this.notify(); }
  update(id: string, patch: Partial<RegistryEntry>): void {
    const entry = this.entries.get(id);
    if (!entry) throw Error(`插件未注册：${id}`);
    this.entries.set(id, { ...entry, ...patch }); this.notify();
  }
  remove(id: string): void { if (this.entries.delete(id)) this.notify(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { this.listeners.forEach(listener => listener()); }
}
