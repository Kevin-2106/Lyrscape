import type { PageId } from './context';

export interface ShortcutInfo { label: string; keys: string }
/** Display table only; bindings live in the shell. */
export const shortcuts: ShortcutInfo[] = [
  { label: '播放 / 暂停', keys: 'Space' },
  { label: '回到开头', keys: 'Home' },
  { label: '快退 / 快进 5 秒', keys: '← →' },
  { label: '打开歌词文件', keys: 'Ctrl+O' },
  { label: '切换页面', keys: 'Ctrl+1 … 6' },
  { label: '上 / 下一页', keys: 'Ctrl+Tab' },
  { label: '搜索插件', keys: 'Ctrl+F' },
];

export const pageOrder: PageId[] = ['lyrics', 'renderers', 'effects', 'plugins', 'settings', 'debug'];
