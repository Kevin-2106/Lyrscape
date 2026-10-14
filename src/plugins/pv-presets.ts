import type { ConfigField } from '../sdk/types';

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
  { id: 'official.renderer.pv-halo', service: 'renderer.pv-halo@1', style: 'halo', name: 'PV · 晴空终端',
    description: '天蓝与白的界面风：主歌在白色「Lyrics」小窗口里以极粗黑体逐词打出，左右交替弹开；副歌巨大白字带蓝边，从像素马赛克解码出现，退场碎回方块；青柠光环图标与引号标题 HUD。' },
  { id: 'official.renderer.pv-halo2', service: 'renderer.pv-halo2@1', style: 'halo2', name: 'PV · 晴空终端 II',
    description: '晴空终端的硬切版：所有动效按 30fps 整帧跳变。主歌窗口两帧切开，新打出的词组以一种饱和色（紫 / 红 / 蓝 / 品红轮换）闪一下再变黑，词组首字带深色选区块；副歌每行以白色面板闪切进场，每个字先切出细描边框，部分字先跳出白色小窗，字以像素块甩入后放大落定，细框淡淡留在字后。' },
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

const common: ConfigField[] = [
  { key: 'layout', label: '构图', description: '自动：重复出现的行与短句用大字，其余用字幕式排版。按段落：找出整段重复的副歌，整段用大字（含段中只出现一次的行）；没有重复段落时同「自动」。', type: 'select', default: 'auto', options: [
    { value: 'auto', label: '自动（副歌大字 / 主歌字幕）' }, { value: 'section', label: '自动 · 按段落识别副歌' }, { value: 'hero', label: '全部大字' }, { value: 'caption', label: '全部字幕' },
  ] },
  { key: 'scale', label: '整体大小', description: '以「字号」为基准缩放 PV 舞台。', type: 'number', default: 1, min: 0.6, max: 1.6, step: 0.05 },
];
const motion: ConfigField = { key: 'motion', label: '启用动效', description: '关闭或系统减少动态效果时，直接显示静止构图。', type: 'boolean', default: true };
const beat: ConfigField = { key: 'beat', label: '跟随节拍', description: '启用「节拍检测」且播放器发送 PCM 时，文字随鼓点跳动；0 为关闭。暂停或没有音频时不生效。', type: 'number', default: 0.8, min: 0, max: 1.5, step: 0.1 };

export function pvFields(profile: PvProfile): ConfigField[] {
  if (profile.style === 'amll') return [common[1],
    { key: 'rows', label: '显示行数', type: 'number', default: 3, min: 2, max: 6, step: 1 },
    { key: 'anchor', label: '当前行位置', description: '当前行顶部在舞台中的高度比例。', type: 'number', default: 0.3, min: 0.1, max: 0.6, step: 0.05 },
    { key: 'blur', label: '远处歌词模糊', type: 'boolean', default: true },
    { key: 'dots', label: '间奏圆点', description: '两句之间空出 4 秒以上时显示。', type: 'boolean', default: true },
    motion];
  if (profile.style === 'vamp') return [...common,
    { key: 'echo', label: '描边回声', description: '短句在另一侧显示一份红色描边副本。', type: 'boolean', default: true },
    motion, beat];
  if (profile.style === 'synth') return [...common,
    { key: 'hud', label: '标题与计时', description: '段落标题、下一句倒计时、剩余时间与 BPM。', type: 'boolean', default: true },
    { key: 'notes', label: '音名行', description: '随实时音频点亮正在发声的音名；没有音频时保持暗淡。', type: 'boolean', default: true },
    { key: 'scopes', label: '频谱与示波器', type: 'boolean', default: true },
    { key: 'shards', label: '彩色碎片', type: 'boolean', default: true },
    motion, beat];
  if (profile.style === 'halo' || profile.style === 'halo2') return [...common,
    ...(profile.style === 'halo2' ? [
      { key: 'chroma', label: '打字变色', description: '主歌新打出的词组以一种饱和色闪 3 帧再变黑，每组只闪一次。', type: 'boolean', default: true },
      { key: 'slots', label: '副歌预备框', description: '副歌每个字出现前的细描边框，部分字先跳出白色小窗。', type: 'boolean', default: true },
      { key: 'burst', label: '副歌白块闪入', description: '副歌每行开头约 0.1 秒的白色面板闪切。', type: 'boolean', default: true },
    ] satisfies ConfigField[] : []),
    { key: 'glitch', label: '故障强度', description: '副歌字形的切片残痕与抖动；0 只保留像素解码进场。', type: 'number', default: 0.7, min: 0, max: 1.5, step: 0.1 },
    { key: 'accent', label: '青柠光环图标', type: 'boolean', default: true },
    { key: 'hud', label: '标题与时间码', description: '右上角引号标题与右下角时间码。', type: 'boolean', default: true },
    motion, beat];
  if (profile.style === 'pop') return [...common,
    { key: 'tilt', label: '大字倾斜（度）', type: 'number', default: -3, min: -10, max: 10, step: 1 },
    { key: 'halo', label: '白色柔光描边', description: '让栗色文字在深色桌面上保持可读。', type: 'boolean', default: true },
    { key: 'particles', label: '贴纸星星', type: 'boolean', default: true },
    { key: 'drift', label: '缓慢平移', type: 'boolean', default: true },
    motion, beat];
  if (profile.style === 'letter') return [...common,
    { key: 'palette', label: '光晕颜色', type: 'select', default: 'duo', options: [
      { value: 'duo', label: '粉 + 薄荷' }, { value: 'pink', label: '粉' }, { value: 'mint', label: '薄荷' },
    ] },
    { key: 'glow', label: '光晕', type: 'boolean', default: true },
    { key: 'petals', label: '花瓣', type: 'boolean', default: true },
    motion, beat];
  return [...common,
    { key: 'theme', label: '文字颜色', description: '浅色适合深色桌面；深色还原原 PV 的墨色。', type: 'select', default: 'foam', options: [
      { value: 'foam', label: '浅色（泡沫）' }, { value: 'abyss', label: '深色（墨）' },
    ] },
    { key: 'glitch', label: '故障强度', description: '0 为纯淡入淡出。', type: 'number', default: 1, min: 0, max: 1.5, step: 0.1 },
    { key: 'kanji', label: '背景巨型汉字', type: 'boolean', default: true },
    { key: 'micro', label: '装饰微缩字', description: '没有翻译时显示不可读的细小注释线。', type: 'boolean', default: true },
    motion, beat];
}
