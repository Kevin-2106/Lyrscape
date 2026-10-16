import type { LyricDocument } from '../sdk/types';
import { bundledCoverage, ensureBundledFonts } from './font-assets';

/**
 * Lyric-language aware typefaces. Every rendered line names exactly one CJK
 * family, chosen for the line's language, so Chinese and Japanese glyph forms
 * never mix inside a line. A decorative face that lacks any character of the
 * line (per its bundled unicode-range) is swapped for that language's complete
 * Noto face for the whole line rather than falling back glyph by glyph.
 */
export type Lang = 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'latin';
export type Role = 'pop' | 'maru' | 'hand' | 'gothic' | 'mincho' | 'heavy' | 'code' | 'mono' | 'script' | 'serif';
export interface Face { family: string; weight: number; style: string }

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u, HANGUL = /\p{Script=Hangul}/u;
// Common characters that exist in only one Chinese script (simplified | traditional). Characters that are
// also ordinary in the other script (只 台 后 几 叶 …) are left out so they cannot tip the vote.
const SIMPLIFIED = '们这说时会来个为国对没发过还么见长开关门问间听写书东车马鸟鱼龙爱觉梦让谁两样边头声电话气觉记认识语读请谢经结给红绿约终级纸线练细织网罗难风飞饭馆钱钟铁银错锁阳阴陈随际层岁归当忆恋泪伤脸亲杂态满灭点热烦烧灯灵爷恶惊惯悬愿虽丽乐习买卖乱争亚产亿仅从众优伟传伤侠俩储儿党兰关兴养兽内冈册写军农决况冻净凉减凤击凿刘则刚创删别剧劝办务动劳势勋区华单卖卢卫却厅历厉压厌厕县参双发变叙叠号叹吓吗启员呜咏响哑唤啰喷嘱团园围图圆圣场坏块坚坛坝坟坠垄垒备复够夸夺奋奖妆妇妈娱婴孙学宁宝实宠审宪宫宽宾对寻导寿将尔尘尝层属岗岛岭岳峡币师帐帘带帮库应庙废广庆张弹强录彻径忧怀态怜总恳恼悦惊惧惨愤战户扑执扩扫扬扰抚抛抢护报担拟拢拣拥拦拨择挂挡挤挥损换据掳掷揽搀摄摆摇摊撑撵击敌数斋无旧时旷昼显晓晕暂术机杀杂权条来杨极构枪柜标栏树样桥档梦检楼横欢欧歼毁毕气汇汉汤沟没沥沦沧泽洁洒浅测济浏浑浓涌涛涝润涨渊渐渔温湿满滚滞滤滥滨滩潜澜灾灿炉炼烂烛烟烦烧热焕爱牍牵犹狈独狭狮猎猪献环现玛玮琐瑶电画畅疗疮疯痒症瘫癣皑盏盐监盖盘眯着睁矫矿码砖础确碍禅祸离秃种积称稳穷窃窍窝竖竞笔笼筑筹签简篮类粮紧纠红纤约级纪纫纬纯纱纲纳纵纷纸纹纺练组细织终绍经结绕绘给络绝统绢继绩绪续绳维绵综缎缓编缘缩缴网罗罚罢羡翘耻聋职联肃肠肤肿胀胁胆胜胶脉脏脑脚腊舰艰艳节芦苍苏苹茎荐荡荣药莲获莹营萝蔼虏虑虽虾蚀蛮蜡蝇衔补衬袄袜袭见观规视览觉触誉计订认讨让训议讯记讲讳许论设访证评识诉诊词译试诗诚话诞询该详诧诫语误诱说请诸诺读课谁调谅谈谊谋谎谐谓谜谢谣谨谱谴贝负贡财责贤败账货质贩贪贫购贯贵贸费贺赋赌赏赐赔赖赚赛赞赠赵赶趋跃践踪轨轩转轮软轰轻载较辅辆辈辉辖辞辟辩边辽达迁过迈运还这进远违连迟适选逊递逻遗遥邓邮邻郑酱酿释针钓钞钟钢钥钦钩钱钻铁铃铅铜铭银铺链销锁锅锋锐错锤锦键锻镇镜长门闪闭问闯闲间闷闸闹闻阀阁阅队阳阴阵阶际陆陈陕险随隐隶难雾静页顶项顺须顾顿颁颂预领颇频颗题颜额颠颤风飘飞饥饭饮饰饱饲饶饿馆馈首马驰驱驳驶驻驼驾骂骄骆验骑骗骚骤鱼鲁鲜鸟鸡鸣鸭鸽鹅鹤黄齐齿龄龙龟';
const TRADITIONAL = '們這說時會來個為國對沒發過還後麼見長開關門問間聽寫書東車馬鳥魚龍愛覺夢讓誰兩樣邊頭聲電話氣記認識語讀請謝經結給紅綠約終級紙線練細織網羅難風飛飯館錢鐘鐵銀錯鎖陽陰陳隨際層歲歸當憶戀淚傷臉親雜態滿滅點熱煩燒燈靈爺惡驚慣懸願雖麗樂習買賣亂爭亞產億僅從眾優夥偉傳俠倆儲兒黨蘭興養獸內岡冊軍農衝決況凍淨涼減幾鳳擊鑿劉則剛創刪別劇勸辦務動勞勢勳區華單盧衛卻廳歷厲壓厭廁縣參雙變敘疊隻臺葉號嘆嚇嗎啟員嗚詠響啞喚囉噴囑團園圍圖圓聖場壞塊堅壇壩墳墜壟壘備複夠誇奪奮獎妝婦媽娛嬰孫學寧寶實寵審憲宮寬賓尋導壽將爾塵嘗屬崗島嶺嶽峽幣師帳簾帶幫庫應廟廢廣慶張彈強錄徹徑憂懷憐總懇惱悅懼慘憤戰戶撲執擴掃揚擾撫拋搶護報擔擬攏揀擁攔撥擇掛擋擠揮損換據擄擲攬攙攝擺搖攤撐攆敵數齋鬥無舊曠晝顯曉暈暫術機殺權條楊傑極構槍櫃標欄樹橋檔檢樓橫歡歐殲毀畢匯漢湯溝瀝淪滄澤潔灑淺測濟瀏渾濃湧濤澇潤漲淵漸漁溫濕滾滯濾濫濱灘潛瀾災燦爐煉爛燭煙煥牘牽猶狽獨狹獅獵豬獻環現瑪瑋瑣瑤畫暢療瘡瘋癢癥癱癬皚盞鹽監蓋盤瞇睜矯礦碼磚礎確礙禪禍離禿種積稱穩窮竊竅窩豎競筆籠築籌簽簡籃類糧緊糾纖紀紉緯純紗綱納縱紛紋紡組紹繞繪絡絕統絹繼績緒續繩維綿綜緞緩編緣縮繳罰罷羨翹恥聾職聯肅腸膚腫脹脅膽勝膠脈臟腦腳臘艦艱豔節蘆蒼蘇蘋莖薦蕩榮藥蓮獲瑩營蘿藹虜慮蝦蝕蠻蠟蠅銜補襯襖襪襲觀規視覽觸譽計訂討訓議訊講諱許論設訪證評訴診詞譯試詩誠誕詢該詳詫誡誤誘諸諾課調諒談誼謀謊諧謂謎謠謹譜譴貝負貢財責賢敗賬貨質販貪貧購貫貴貿費賀賦賭賞賜賠賴賺賽贊贈趙趕趨躍踐蹤軌軒轉輪軟轟輕載較輔輛輩輝轄辭闢辯遼達遷邁運進遠違連遲適選遜遞邏遺遙鄧郵鄰鄭醬釀釋針釣鈔鋼鑰欽鉤鑽鈴鉛銅銘鋪鏈銷鍋鋒銳錘錦鍵鍛鎮鏡閃閉闖閒悶閘鬧聞閥閣閱隊陣階陸陝險隱隸霧靜頁頂項順須顧頓頒頌預領頗頻顆題顏額顛顫飄飢飲飾飽飼饒餓饋駛馳驅駁駐駝駕罵驕駱驗騎騙騷驟魯鮮雞鳴鴨鴿鵝鶴黃齊齒齡龜';
const simplified = new Set(SIMPLIFIED), traditional = new Set(TRADITIONAL);

/** Language of a body of text: kana → Japanese, Hangul → Korean, Han → Chinese (script by distinctive characters), else Latin. */
export function detectLang(texts: string[]): Lang {
  let kana = 0, han = 0, hangul = 0, simp = 0, trad = 0;
  for (const text of texts) for (const char of text) {
    if (KANA.test(char) && char !== 'ー' && char !== '・') kana++;
    else if (HAN.test(char)) { han++; if (simplified.has(char)) simp++; else if (traditional.has(char)) trad++; }
    else if (HANGUL.test(char)) hangul++;
  }
  if (hangul > kana + han) return 'ko';
  if (kana >= 3 || (kana > 0 && kana >= (han + kana) * 0.05)) return 'ja';
  if (han > 0) return trad > simp ? 'zh-Hant' : 'zh-Hans';
  return 'latin';
}
/** A line follows its song's language unless its own script is decisive (kana in a Chinese song, Hangul…). */
export function lineLang(text: string, songLang: Lang): Lang {
  if (KANA.test(text) && /[\p{Script=Hiragana}]|[ァ-ヺ]/u.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (HAN.test(text) && (songLang === 'latin' || songLang === 'ko')) return detectLang([text]);
  return songLang;
}
const docCache = new WeakMap<LyricDocument, { lyrics: Lang; translation: Lang }>();
/** Song-level languages of the lyrics and of their translations, cached per document. */
export function documentLangs(doc: LyricDocument): { lyrics: Lang; translation: Lang } {
  let result = docCache.get(doc);
  if (!result) {
    const main = doc.lines.filter(line => !line.isBackground).map(line => line.text);
    result = { lyrics: detectLang(main), translation: detectLang(doc.lines.map(line => line.translation ?? line.romanization ?? '')) };
    docCache.set(doc, result);
  }
  return result;
}

// Per role: the family for each language. Single-weight faces pin their weight.
type Entry = { family: string; weights?: number[]; italic?: boolean };
const NOTO: Record<Exclude<Lang, 'latin'>, Entry> = {
  ja: { family: 'Noto Sans JP', weights: [500, 700, 900] }, 'zh-Hans': { family: 'Noto Sans SC', weights: [500, 700, 900] },
  'zh-Hant': { family: 'Noto Sans TC', weights: [500, 700, 900] }, ko: { family: 'Malgun Gothic' },
};
const NOTO_SERIF: Record<Exclude<Lang, 'latin'>, Entry> = {
  ja: { family: 'Shippori Mincho', weights: [700] }, 'zh-Hans': { family: 'Noto Serif SC', weights: [700] },
  'zh-Hant': { family: 'Noto Serif TC', weights: [700] }, ko: { family: 'Batang' },
};
const KAI: Record<'zh-Hans' | 'zh-Hant', Entry> = {
  'zh-Hans': { family: 'LXGW WenKai', weights: [400] }, 'zh-Hant': { family: 'LXGW WenKai TC', weights: [400] },
};
const TABLE: Record<Role, Partial<Record<Lang, Entry>>> = {
  pop: { ja: { family: 'Mochiy Pop One', weights: [400] }, 'zh-Hans': { family: 'ZCOOL KuaiLe', weights: [400] }, 'zh-Hant': { family: 'Huninn', weights: [400] } },
  maru: { ja: { family: 'Zen Maru Gothic', weights: [500] }, 'zh-Hans': KAI['zh-Hans'], 'zh-Hant': { family: 'Huninn', weights: [400] } },
  hand: { ja: { family: 'Klee One', weights: [600] }, ...KAI },
  gothic: NOTO,
  mincho: NOTO_SERIF,
  heavy: { ja: { family: 'Dela Gothic One', weights: [400] }, 'zh-Hans': { family: 'ZCOOL QingKe HuangYou', weights: [400] }, 'zh-Hant': { family: 'Noto Sans TC', weights: [900] } },
  code: { ja: { family: 'M PLUS 1 Code', weights: [300, 500] }, 'zh-Hans': NOTO['zh-Hans'], 'zh-Hant': NOTO['zh-Hant'] },
  // Latin-only roles: CJK text in them is routed to a matching CJK role instead.
  mono: { latin: { family: 'Share Tech Mono', weights: [400] } },
  script: { latin: { family: 'Playfair Display', weights: [400], italic: true } },
  serif: { latin: { family: 'EB Garamond', weights: [400], italic: true } },
};
const LATIN_ROUTE: Partial<Record<Role, Role>> = { mono: 'code', script: 'hand', serif: 'mincho' };
const GENERIC: Record<Role, string> = { pop: 'sans-serif', maru: 'sans-serif', hand: 'cursive', gothic: 'sans-serif', mincho: 'serif',
  heavy: 'sans-serif', code: 'monospace', mono: 'monospace', script: 'serif', serif: 'serif' };

let rangeVersion = -1;
const ranges = new Map<string, [number, number][] | null>();
/** Code-point ranges a bundled family covers (from its @font-face unicode-range), or null if unknown (system font). */
function coverage(family: string): [number, number][] | null {
  // Registered faces are only a subset of the family. Future lyric characters
  // must be checked against the full bundled atlas, not today's loaded subsets.
  const bundled = bundledCoverage(family);
  if (bundled) return bundled;
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts) return bundledCoverage(family);
  if (rangeVersion !== fonts.size) { rangeVersion = fonts.size; ranges.clear(); }
  if (ranges.has(family)) return ranges.get(family)!;
  let found: [number, number][] | null = null;
  fonts.forEach(face => {
    if (face.family.replace(/["']/g, '') !== family) return;
    found ??= [];
    for (const part of face.unicodeRange.split(',')) {
      const match = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
      if (!match) continue;
      const lo = parseInt(match[1].replace(/\?/g, '0'), 16), hi = match[2] ? parseInt(match[2], 16) : parseInt(match[1].replace(/\?/g, 'F'), 16);
      found.push([lo, hi]);
    }
  });
  const result = found ?? bundledCoverage(family);
  ranges.set(family, result);
  return result;
}
/** Whether `family` has every visible character of `text` but emoji. Unknown (system) families are trusted. */
export function covers(family: string, text: string): boolean {
  const spans = coverage(family);
  if (!spans) return true;
  for (const char of text) {
    if (/\s|\p{Extended_Pictographic}|[\u200d\ufe0f]/u.test(char)) continue;
    const code = char.codePointAt(0)!;
    if (!spans.some(([lo, hi]) => code >= lo && code <= hi)) return false;
  }
  return true;
}

const nearest = (weights: number[] | undefined, wanted: number) =>
  !weights?.length ? wanted : weights.reduce((best, w) => Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best);

/**
 * Face for `role` drawing `text` in language `lang`: one family plus a generic
 * fallback, never a second CJK family. Weights snap to the bundled ones so the
 * browser does not synthesise bold.
 */
export function faceFor(role: Role, lang: Lang, text: string, weight = 400, style = 'normal'): Face {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  const latinOnly = role in LATIN_ROUTE;
  if (latinOnly && cjk) return faceFor(LATIN_ROUTE[role]!, lang === 'latin' ? detectLang([text]) : lang, text, weight, 'normal');
  const key: Lang = latinOnly ? 'latin' : lang === 'latin' ? 'ja' : lang;
  let entry = TABLE[role][key] ?? (key === 'ko' ? NOTO.ko : NOTO.ja);
  // Decorative faces lacking a character hand the whole line to the language's complete face.
  if (!covers(entry.family, text)) {
    const base = role === 'mincho' ? NOTO_SERIF : NOTO;
    entry = key === 'latin' ? entry : base[key as Exclude<Lang, 'latin'>];
    if (!covers(entry.family, text) && role === 'mincho') entry = NOTO[key as Exclude<Lang, 'latin'>];
    // Even the language's complete face lacks something (e.g. 们 in Japanese text): take the
    // whole text to whichever bundled Noto has every character, still one family.
    if (!covers(entry.family, text)) entry = [NOTO.ja, NOTO['zh-Hans'], NOTO['zh-Hant']].find(noto => covers(noto.family, text)) ?? entry;
  }
  if (text) void ensureBundledFonts(entry.family, text).catch(console.error);
  return { family: `"${entry.family}", ${GENERIC[role]}`, weight: nearest(entry.weights, weight), style: entry.italic ? 'italic' : style === 'italic' && !cjk ? style : 'normal' };
}

/** BCP 47 tag for `lang` attributes, so system fallback fonts also pick the right glyph forms. */
export const langTag = (lang: Lang) => lang === 'zh-Hans' ? 'zh-CN' : lang === 'zh-Hant' ? 'zh-TW' : lang === 'latin' ? 'en' : lang;

/** Theme presets that follow the lyric language (bundled faces), resolved per document. */
export const AUTO_FAMILIES: Record<string, { label: string; role: Role }> = {
  'auto:sans': { label: '自动 · 黑体（按歌词语言）', role: 'gothic' },
  'auto:serif': { label: '自动 · 宋体 / 明朝（按歌词语言）', role: 'mincho' },
  'auto:hand': { label: '自动 · 楷体 / 手写（按歌词语言）', role: 'hand' },
  'auto:round': { label: '自动 · 圆体（按歌词语言）', role: 'maru' },
};
/** Resolves a theme font setting: auto presets pick the face for `lang`; anything else is the user's CSS family. */
export function themeFamily(setting: string, lang: Lang, text = ''): string {
  const preset = AUTO_FAMILIES[setting];
  if (!preset && text) void ensureBundledFonts(setting, text).catch(console.error);
  return preset ? faceFor(preset.role, lang, text).family : setting;
}
