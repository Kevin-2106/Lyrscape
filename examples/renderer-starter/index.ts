import type { Plugin } from '../../src/kernel/host';
import type { PluginInfo } from '../../src/sdk/types';
import { createDomRenderer, ownRenderer } from '../../src/plugins/renderer';

export const starterInfo: PluginInfo = {
  id: 'example.renderer.rise', name: '示例 · 轻轻浮现', version: '0.1.0', category: 'renderer',
  description: '共享原有时间填充；每行只做一个无滤镜的 2D 进入动画。',
  rendererService: 'renderer.example-rise@1',
};

/** Trusted source example; import explicitly. This is not an installable package. */
export const starterPlugin: Plugin = {
  id: starterInfo.id,
  activate(ctx) {
    const animations = new Map<HTMLElement, Animation>();
    ctx.provide(starterInfo.rendererService!, ownRenderer(ctx, createDomRenderer({
      mount(root) {
        return () => { animations.get(root)?.cancel(); animations.delete(root); };
      },
      line(root, line) {
        animations.get(root)?.cancel();
        if (typeof line.animate !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        animations.set(root, line.animate([
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' }));
      },
    })));
  },
};
