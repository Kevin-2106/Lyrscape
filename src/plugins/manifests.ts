import type { ConfigField, PluginManifest } from '../sdk/types';
import { pvFields, pvProfiles, pvTheme } from './pv-presets';

// Pure data: no DOM, fonts or platform imports. The development server evaluates
// this module in Node to list the source catalog without loading any plugin code.

export const TEXT_RENDERER = 'official.renderer.text';
export const AURORA_RENDERER = 'official.renderer.aurora';
export const AMLL_ADAPTER = 'official.adapter.amll';
export const BEAT_DETECTOR = 'official.audio.beat';

export const auroraFields: ConfigField[] = [
  { key: 'entrance', label: '进入动画', type: 'select', default: 'comet', options: [
    { value: 'comet', label: '彗星飞入' }, { value: 'orbit', label: '旋转落位' }, { value: 'prism', label: '棱镜展开' },
  ] },
  { key: 'duration', label: '进入时长（毫秒）', type: 'number', default: 850, min: 200, max: 1800, step: 50 },
  { key: 'stagger', label: '字间延迟（毫秒）', description: '仅控制视觉进入顺序，不改变歌词时间。', type: 'number', default: 28, min: 0, max: 80, step: 4 },
  { key: 'intensity', label: '动效幅度', type: 'number', default: 1, min: 0.2, max: 1.5, step: 0.1 },
  { key: 'glow', label: '文字光晕', type: 'boolean', default: true },
  { key: 'sparks', label: '星芒与流光', type: 'boolean', default: true },
  { key: 'beat', label: '跟随节拍', description: '启用「节拍检测」且播放器发送 PCM 时，当前行随鼓点轻微放大；0 为关闭。', type: 'number', default: 0.8, min: 0, max: 1.5, step: 0.1 },
  { key: 'motion', label: '启用进入动画', description: '系统设置减少动态效果时，自动使用静态显示。', type: 'boolean', default: true },
];
export const beatFields: ConfigField[] = [
  { key: 'offset', label: '节拍延迟（毫秒）', description: '效果比听到的鼓点早就调大，晚就调小。', type: 'number', default: 0, min: -400, max: 400, step: 10 },
];
export const amllFields: ConfigField[] = [
  { key: 'port', label: '监听端口', description: '下次启动服务时使用；修改不会断开当前连接。', type: 'number', default: 11444, min: 1024, max: 65535, step: 1 },
];

/**
 * The optional, hot-reloadable plugins. Adding a manifest here (plus a factory in
 * catalog.ts) is all a new built-in needs; a running app picks it up with 重新扫描.
 */
export const builtinManifests: PluginManifest[] = [
  { id: BEAT_DETECTOR, name: '节拍检测', description: '从 PCM 实时估计速度与鼓点相位，供渲染器跟随节拍；没有音频时不产生效果。', category: 'effect', fields: beatFields },
  { id: AMLL_ADAPTER, name: 'AMLL 连接', description: '只读接收 AMLL V1 / V2 曲目、歌词与进度，独立于渲染器。', category: 'playback-adapter', fields: amllFields, surfaces: ['control'] },
  { id: AURORA_RENDERER, name: 'Aurora · 流光', description: '彗星飞入、旋转落位、棱镜展开，配合文字光晕与星芒。', category: 'renderer', rendererService: 'renderer.aurora@1', fields: auroraFields },
  ...pvProfiles.map((profile): PluginManifest => ({ id: profile.id, name: profile.name, description: profile.description,
    category: 'renderer', rendererService: profile.service, fields: pvFields(profile), theme: pvTheme(profile) })),
];
