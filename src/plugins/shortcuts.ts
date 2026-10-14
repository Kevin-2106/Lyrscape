import type { Plugin } from '../kernel/host';
import type { Store } from '../kernel/store';
import type { AppState, GlobalShortcutBinding, GlobalShortcuts, ShortcutAction } from '../sdk/types';
import { desktop, native, onEvent } from '../platform';

export const shortcutDefaults: Record<ShortcutAction, string> = { visibility: 'Ctrl+Shift+L', clickthrough: 'Ctrl+Shift+P', border: 'Ctrl+Shift+B' };
export const shortcutLabels: Record<ShortcutAction, string> = { visibility: '显示 / 隐藏桌面歌词', clickthrough: '切换鼠标穿透', border: '显示 / 隐藏调整边框' };

export function normalizeAccelerator(input: string): string {
  if (!input.trim()) return '';
  const parts = input.split('+').map(s => s.trim());
  const modifiers = new Set<string>();
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    const mod = ({ ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Super', super: 'Super', win: 'Super' } as Record<string, string>)[lower];
    if (mod) modifiers.add(mod);
    else {
      if (key) throw Error('快捷键只能包含一个普通按键');
      key = part.replace(/^Key(?=[a-z]$)/i, '').replace(/^Digit(?=\d$)/i, '');
      if (/^[a-z\d]$/i.test(key) || /^f(?:[1-9]|1\d|2[0-4])$/i.test(key)) key = key.toUpperCase();
      else key = ({ space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', left: 'Left', right: 'Right', up: 'Up', down: 'Down', enter: 'Enter', tab: 'Tab', escape: 'Escape', delete: 'Delete', backspace: 'Backspace' } as Record<string, string>)[key.toLowerCase()] ?? '';
    }
  }
  if (!modifiers.size || !key) throw Error('请使用 Ctrl、Alt、Shift 或 Win 加一个按键');
  const accelerator = [...['Ctrl', 'Alt', 'Shift', 'Super'].filter(m => modifiers.has(m)), key].join('+');
  if (/^Ctrl\+[1-5]$/.test(accelerator) || ['Ctrl+O', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+R', 'Alt+F4', 'Super+L', 'Ctrl+Alt+Delete'].includes(accelerator)) throw Error('快捷键与程序导航或系统常用操作冲突，请换一个组合');
  return accelerator;
}

export function globalShortcutsPlugin(store: Store<AppState>): Plugin {
  return {
    id: 'official.shortcuts.global', requires: ['surface.overlay@1'],
    async activate(ctx) {
      let saved: Partial<Record<ShortcutAction, string>> = {};
      try { saved = JSON.parse(localStorage.getItem('lyrscape.shortcuts.v1') ?? '{}') ?? {}; } catch { /* recover */ }
      if (typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      let bindings: GlobalShortcutBinding[] = Object.entries(shortcutDefaults).map(([action, accelerator]) => ({ action: action as ShortcutAction, accelerator, registered: false }));
      let queue = Promise.resolve();
      const persist = () => { try { localStorage.setItem('lyrscape.shortcuts.v1', JSON.stringify(saved)); } catch { /* session usable */ } };
      const refresh = async () => {
        if (desktop) bindings = await native<GlobalShortcutBinding[]>('shortcuts_status');
        store.update(s => ({ ...s, shortcuts: bindings }));
      };
      const set = async (action: ShortcutAction, input: string) => {
        const accelerator = normalizeAccelerator(input);
        if (!desktop) throw Error('全局快捷键需要桌面版 Lyrscape');
        const duplicate = bindings.find(b => b.action !== action && b.registered && b.accelerator === accelerator && accelerator);
        if (duplicate) throw Error(`快捷键冲突：已用于「${shortcutLabels[duplicate.action]}」`);
        try {
          bindings = await native<GlobalShortcutBinding[]>('shortcut_set', { action, accelerator });
          saved[action] = accelerator; persist();
        } finally { await refresh(); }
      };
      ctx.provide<GlobalShortcuts>('shortcuts.global@1', { list: () => bindings, set(action, accelerator) {
        const task = queue.then(() => set(action, accelerator)); queue = task.catch(() => {}); return task;
      } });
      ctx.own(await onEvent<string>('shortcut-error', error => { store.update(s => ({ ...s, error })); }));
      if (desktop) {
        for (const action of Object.keys(shortcutDefaults) as ShortcutAction[]) {
          try { await set(action, typeof saved[action] === 'string' ? saved[action]! : shortcutDefaults[action]); }
          catch (error) {
            // Invalid saved config or an OS conflict must not prevent startup.
            const message = error instanceof Error ? error.message : String(error);
            if (!bindings.some(b => b.action === action)) bindings.push({ action, accelerator: saved[action] ?? shortcutDefaults[action], registered: false, error: message });
            store.update(s => ({ ...s, shortcuts: [...bindings], error: message }));
          }
        }
        ctx.own(() => { void native('shortcuts_clear').catch(console.error); });
      } else store.update(s => ({ ...s, shortcuts: bindings }));
    },
  };
}
