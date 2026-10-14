import type { PageId } from './context';

const STORAGE_KEY = 'lyrscape.ui.page';

/** Hash router: `#/style`. The hash makes Alt+← work and survives reloads; storage restores the last page on a bare launch. */
export function createRouter(valid: PageId[], onChange: (id: PageId) => void): { current(): PageId; go(id: PageId): void; start(): void; stop(): void } {
  const parse = (): PageId | undefined => {
    const id = location.hash.replace(/^#\/?/, '') as PageId;
    return valid.includes(id) ? id : undefined;
  };
  let active: PageId | undefined;
  const sync = () => {
    const id = parse() ?? valid[0];
    if (id === active) return;
    active = id;
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* remembering the page is optional */ }
    onChange(id);
  };
  return {
    current: () => parse() ?? active ?? valid[0],
    go(id) { if (parse() === id) sync(); else location.hash = `#/${id}`; },
    start() {
      if (!parse()) {
        let saved: string | null = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
        if (saved && valid.includes(saved as PageId)) history.replaceState(null, '', `#/${saved}`);
      }
      window.addEventListener('hashchange', sync);
      sync();
    },
    stop() { window.removeEventListener('hashchange', sync); },
  };
}
