import type { PageId } from './context';

const STORAGE_KEY = 'lyrscape.ui.page';
/** Pages that were merged in the desktop redesign keep working as links and saved state. */
const aliases: Record<string, PageId> = { studio: 'lyrics', style: 'renderers', overlay: 'settings', about: 'settings' };

/** Hash router: `#/studio`. The hash makes Alt+← work and survives reloads; storage restores the last page on a bare launch. */
export function createRouter(valid: PageId[], onChange: (id: PageId) => void): { current(): PageId; go(id: PageId): void; start(): void; stop(): void } {
  const resolve = (value: string | null | undefined): PageId | undefined => {
    const id = (value && aliases[value]) || value;
    return valid.includes(id as PageId) ? id as PageId : undefined;
  };
  const parse = () => resolve(location.hash.replace(/^#\/?/, '').split('/')[0]);
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
    go(id) { if (location.hash === `#/${id}`) sync(); else location.hash = `#/${id}`; },
    start() {
      const hashed = parse();
      if (hashed && location.hash !== `#/${hashed}`) history.replaceState(null, '', `#/${hashed}`);
      if (!hashed) {
        let saved: string | null = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
        const page = resolve(saved);
        if (page) history.replaceState(null, '', `#/${page}`);
      }
      window.addEventListener('hashchange', sync);
      sync();
    },
    stop() { window.removeEventListener('hashchange', sync); },
  };
}
