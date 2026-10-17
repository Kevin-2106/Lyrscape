import type { ConfigField, ThemeUse } from '../sdk/types';

/** Trusted product metadata; adding a profile registers an independent renderer. */
export const pvProfiles = [
  { id: 'official.renderer.pv-pop', service: 'renderer.pv-pop@1', style: 'pop', name: 'PV · 糖果波普',
    description: '圆润粗体，栗色假名配渐变汉字，副歌拼装弹入并炸出贴纸星星；主歌放进栗色字幕条逐词显现。' },
  { id: 'official.renderer.pv-letter', service: 'renderer.pv-letter@1', style: 'letter', name: 'PV · 情书',
    description: '象牙白圆体大字在粉 / 薄荷光晕中泛光浮现，花瓣飘落；主歌写在薄荷标签与信纸便签上。' },
  { id: 'official.renderer.pv-elegy', service: 'renderer.pv-elegy@1', style: 'elegy', name: 'PV · 水底挽歌',
    description: '细小黑体词组散落在发丝线两端，像素故障解码进出，背后漂着描边巨大明朝体汉字。' },
  { id: 'official.renderer.pv-vamp', service: 'renderer.pv-vamp@1', style: 'vamp', name: 'PV · 吸血鬼',
    description: '极粗白色黑体配深红硬投影：待唱的字先以红色描边等待，唱到时实心弹入，行尾从第一个字开始擦除；短句把巨大汉字甩到两端。' },
  { id: 'official.renderer.pv-synth', service: 'renderer.pv-synth@1', style: 'synth', name: 'PV · 合成谱',
    description: '乐理 HUD：代码式段落标题、到下一句的倒计时、打字机光标显现歌词；底部音名随实时音频点亮，两侧频谱与示波器，彩色碎片漂过。' },
  { id: 'official.renderer.pv-azure', service: 'renderer.pv-azure@1', style: 'azure', name: 'PV · 一起出发',
    description: '蓝色青春 MV 风：主歌圆体白字在天蓝竖条里逐字浮现，大号青色残影收拢落位，四角星沿发丝线滑过；副歌白色明朝体大字带蓝色投影逐字盖章，末字用青色描线写出，彩纸飘落、斜向跑马灯与取景框；短句换成圆粗体白字，从倾斜的青色色带上甩入。' },
  { id: 'official.renderer.pv-gamedev', service: 'renderer.pv-gamedev@1', style: 'gamedev', name: 'PV · 游戏开发部',
    description: '复古游戏风：主歌写进像素对话框，名牌在四名部员间轮换，打字机逐字显现并闪烁 ▼；副歌巨大像素字按 12fps 从上方弹落，粉 / 绿双色错位投影，金币与像素星迸出，计分、生命条与关卡 HUD，CRT 扫描线，退场像素溶解。' },
  { id: 'official.renderer.amll', service: 'renderer.amll@1', style: 'amll', name: 'Apple Music 风格',
    description: '仿 AMLL 的滚动歌词列表：当前行逐词扫亮并上浮，长音字发光放大，其余行按距离变暗、缩小、模糊，弹簧滚动与间奏圆点。使用主题字体。' },
] as const;
export type PvProfile = typeof pvProfiles[number];
/** Earlier PV renderer ids map to their closest redesigned style. */
export const legacyPvIds: Record<string, string> = {
  'official.renderer.pv-impact': 'official.renderer.pv-pop',
  'official.renderer.pv-card': 'official.renderer.pv-letter',
  'official.renderer.pv-cut': 'official.renderer.pv-elegy',
};
/** PV styles bring their own faces and palettes; Apple Music 风格 follows the theme font. */
export const pvTheme = (profile: PvProfile): ThemeUse[] => profile.style === 'amll' ? ['font'] : [];

const layout: ConfigField = { key: 'layout', group: '构图', label: '构图', description: '自动：重复出现的行与短句用大字，其余用字幕式排版。按段落：找出整段重复的副歌，整段用大字（含段中只出现一次的行）；没有重复段落时同「自动」。', type: 'select', default: 'auto', options: [
  { value: 'auto', label: '自动（副歌大字 / 主歌字幕）' }, { value: 'section', label: '自动 · 按段落识别副歌' }, { value: 'hero', label: '全部大字' }, { value: 'caption', label: '全部字幕' },
] };
const scale: ConfigField = { key: 'scale', group: '构图', label: '整体大小', description: '以「字号」为基准缩放 PV 舞台。', type: 'number', default: 1, min: 0.6, max: 1.6, step: 0.05 };
const motion: ConfigField = { key: 'motion', group: '动效', label: '启用动效', description: '关闭或系统减少动态效果时，直接显示静止构图。', type: 'boolean', default: true };
const intensity: ConfigField = { key: 'intensity', group: '动效', label: '动效强度', description: '进场位移、过冲、抖动与粒子飞散的幅度；1 为参考 PV 的力度。', type: 'number', default: 1, min: 0, max: 2, step: 0.1 };
const speed: ConfigField = { key: 'speed', group: '动效', label: '动效速度', description: '进场与退场动画的快慢；逐词出现的时间始终跟随歌词。', type: 'number', default: 1, min: 0.5, max: 2, step: 0.1 };
const beat: ConfigField = { key: 'beat', group: '动效', label: '跟随节拍', description: '启用「节拍检测」且播放器发送 PCM 时，文字随鼓点跳动；0 为关闭。暂停或没有音频时不生效。', type: 'number', default: 0.8, min: 0, max: 1.5, step: 0.1 };
const font: ConfigField = { key: 'font', group: '字体', label: '歌词字体', description: '替换风格自带的正文字体（仍按歌词语言选择简体 / 繁体 / 日文字形）；HUD 与装饰文字不变。', type: 'select', default: 'auto', options: [
  { value: 'auto', label: '风格默认' }, { value: 'gothic', label: '黑体' }, { value: 'mincho', label: '宋体 / 明朝' }, { value: 'maru', label: '圆体' },
  { value: 'rounded', label: '粗圆体' }, { value: 'hand', label: '楷体 / 手写' }, { value: 'pop', label: '波普' }, { value: 'heavy', label: '粗黑装饰体' },
  { value: 'code', label: '等宽' }, { value: 'pixel', label: '像素' },
] };
const color = (key: string, label: string, value: string, description?: string): ConfigField =>
  ({ key, group: '颜色', label, type: 'color', default: value, ...(description ? { description } : {}) });
const effect = (key: string, label: string, description?: string, value = true): ConfigField =>
  ({ key, group: '特效', label, type: 'boolean', default: value, ...(description ? { description } : {}) });
const glitch = (value: number, description: string): ConfigField =>
  ({ key: 'glitch', group: '特效', label: '故障强度', description, type: 'number', default: value, min: 0, max: 1.5, step: 0.1 });
const dynamics = [motion, intensity, speed, beat];

export function pvFields(profile: PvProfile): ConfigField[] {
  switch (profile.style) {
    case 'amll': return [{ ...scale },
      { key: 'rows', group: '构图', label: '显示行数', type: 'number', default: 3, min: 2, max: 6, step: 1 },
      { key: 'anchor', group: '构图', label: '当前行位置', description: '当前行顶部在舞台中的高度比例。', type: 'number', default: 0.3, min: 0.1, max: 0.6, step: 0.05 },
      motion,
      color('ink', '歌词颜色', '#ffffff'),
      { key: 'dim', group: '颜色', label: '未唱部分亮度', type: 'number', default: 0.42, min: 0.15, max: 0.8, step: 0.01 },
      effect('blur', '远处歌词模糊'), effect('dots', '间奏圆点', '两句之间空出 4 秒以上时显示。'), effect('glow', '长音发光', '≥ 1 秒的短词逐字放大并发白光。')];
    case 'vamp': return [layout, scale, ...dynamics, font,
      color('face', '文字', '#ffffff'), color('shadow', '硬投影', '#d8001c'), color('ghost', '待唱描边', '#ff2a44'),
      effect('echo', '描边回声', '短句在另一侧显示一份红色描边副本。'),
      { key: 'jitter', group: '特效', label: '抖动', type: 'number', default: 1, min: 0, max: 2, step: 0.1 }];
    case 'synth': return [layout, scale, ...dynamics, font,
      color('ink', '文字', '#f3f0ff'), color('glow', '光晕', '#9680ff'),
      effect('hud', '标题与计时', '段落标题、下一句倒计时、剩余时间与 BPM。'), effect('notes', '音名行', '随实时音频点亮正在发声的音名；没有音频时保持暗淡。'),
      effect('scopes', '频谱与示波器'), effect('shards', '彩色碎片')];
    case 'azure': return [layout, scale,
      { key: 'direction', group: '构图', label: '主歌排版', description: '竖排还原 MV 的竖条字幕，舞台会变高；横排适合普通桌面歌词条。', type: 'select', default: 'horizontal', options: [
        { value: 'horizontal', label: '横排' }, { value: 'vertical', label: '竖排（还原 MV）' },
      ] },
      { key: 'tilt', group: '构图', label: '副歌倾斜（度）', description: '大字句按 4 行一组交替端正 / 斜放，像 MV 前后两遍副歌；0 为始终端正。竖排时不倾斜。', type: 'number', default: 8, min: 0, max: 16, step: 1 },
      ...dynamics, font,
      color('ink', '文字', '#ffffff'), color('shadow', '投影', '#2a7fd4'), color('sky', '天蓝条', '#4fc3ee'), color('cyan', '青色描线', '#6fe3ff'),
      effect('hook', '短句圆粗体色带', '不超过 6 个字的大字句改用圆粗体，从倾斜色带上甩入。'),
      effect('confetti', '彩纸'), effect('ticker', '斜向跑马灯', '滚动显示曲名。'), effect('frame', '取景框与三角'),
      effect('sparkles', '四角星')];
    case 'gamedev': return [layout, scale, ...dynamics, { ...font, default: 'auto' },
      { key: 'cast', group: '颜色', label: '配色', description: '对话框名牌与主色。轮换：每行换一名部员。', type: 'select', default: 'rotate', options: [
        { value: 'rotate', label: '四人轮换' }, { value: 'momoi', label: '桃井（粉）' }, { value: 'midori', label: '小绿（绿）' }, { value: 'yuzu', label: '柚子（橙）' }, { value: 'aris', label: '爱丽丝（蓝）' },
      ] },
      color('box', '对话框底色', '#1b1f3b'), color('ink', '文字', '#ffffff'),
      effect('names', '名牌', '对话框左上角的部员名牌。'),
      effect('hud', '计分与生命条', '左上 SCORE 随唱过的字增加，生命条为歌曲进度，右上为关卡编号。'),
      effect('particles', '金币与像素星'),
      effect('crt', 'CRT 扫描线'),
      { key: 'fps', group: '动效', label: '复古帧率', description: '副歌动画按此帧率跳变；0 为不限制（平滑）。', type: 'number', default: 12, min: 0, max: 30, step: 1 }];
    case 'pop': return [layout, scale,
      { key: 'tilt', group: '构图', label: '大字倾斜（度）', type: 'number', default: -3, min: -10, max: 10, step: 1 },
      ...dynamics, font,
      color('ink', '假名', '#5c1a2b'), color('pill', '字幕条', '#4c1823'),
      { key: 'kanji', group: '颜色', label: '汉字配色', type: 'select', default: 'mixed', options: [{ value: 'mixed', label: '五色轮换（原 PV）' }, { value: 'custom', label: '自定义渐变' }] },
      color('kanjiStart', '汉字渐变起点', '#ff3d8b'), color('kanjiEnd', '汉字渐变终点', '#b23cc8'),
      effect('halo', '白色柔光描边', '让栗色文字在深色桌面上保持可读。'), effect('particles', '贴纸星星'), effect('drift', '缓慢平移')];
    case 'letter': return [layout, scale, ...dynamics, font,
      { key: 'palette', group: '颜色', label: '光晕颜色', type: 'select', default: 'duo', options: [
        { value: 'duo', label: '粉 + 薄荷' }, { value: 'pink', label: '粉' }, { value: 'mint', label: '薄荷' }, { value: 'custom', label: '自定义' },
      ] },
      color('glowA', '自定义光晕 1', '#ff7fb5'), color('glowB', '自定义光晕 2', '#36d9bd'), color('ink', '文字', '#fffaf0'),
      effect('glow', '光晕'), effect('petals', '花瓣')];
    case 'elegy': return [layout, scale, ...dynamics, font,
      { key: 'theme', group: '颜色', label: '文字颜色', description: '浅色适合深色桌面；深色还原原 PV 的墨色；自定义使用下方颜色。', type: 'select', default: 'foam', options: [
        { value: 'foam', label: '浅色（泡沫）' }, { value: 'abyss', label: '深色（墨）' }, { value: 'custom', label: '自定义' },
      ] },
      color('ink', '自定义文字', '#eafff8'),
      glitch(1, '0 为纯淡入淡出。'),
      effect('kanji', '背景巨型汉字'), effect('micro', '装饰微缩字', '没有翻译时显示不可读的细小注释线。')];
  }
}
