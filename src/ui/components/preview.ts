import type { UiContext } from '../context';

/** A renderer mount that only lives while its page is visible. */
export function createPreview(host: HTMLElement, ctx: UiContext): { activate(): void; deactivate(): void } {
  let dispose: (() => void) | undefined;
  const deactivate = () => { dispose?.(); dispose = undefined; host.replaceChildren(); };
  return { activate() { if (!dispose) dispose = ctx.mountPreview(host); }, deactivate };
}
