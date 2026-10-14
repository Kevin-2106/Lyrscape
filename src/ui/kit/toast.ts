import type { ToastKind } from '../context';

/** Transient, non-modal feedback. Errors stay longer; identical messages collapse. */
export function createToaster(host: HTMLElement): { notify(text: string, kind?: ToastKind): void; dispose(): void } {
  host.classList.add('toast-region');
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  const timers = new Map<HTMLElement, number>();
  const remove = (toast: HTMLElement) => {
    window.clearTimeout(timers.get(toast)); timers.delete(toast); toast.remove();
  };
  return {
    notify(text, kind = 'info') {
      if (!text) return;
      for (const existing of timers.keys()) if (existing.textContent === text) remove(existing);
      const toast = document.createElement('div');
      toast.className = `toast is-${kind}`; toast.textContent = text;
      toast.addEventListener('click', () => remove(toast));
      host.append(toast);
      while (host.childElementCount > 3) remove(host.firstElementChild as HTMLElement);
      timers.set(toast, window.setTimeout(() => remove(toast), kind === 'error' ? 7000 : 2800));
    },
    dispose() { timers.forEach(timer => window.clearTimeout(timer)); timers.clear(); host.replaceChildren(); },
  };
}
