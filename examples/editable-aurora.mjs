// A self-contained editable renderer. Save as plugins/official.renderer.aurora.mjs
// beside the exe, then choose local files and click 热重载. Use only trusted code.
export default {
  id: 'official.renderer.aurora',
  activate(ctx) {
    const mounts = new Set();
    let active = true;
    ctx.own(() => { active = false; for (const dispose of [...mounts]) dispose(); });
    ctx.provide('renderer.aurora@1', {
      mount(root, getState, timeline) {
        if (!active) throw Error('Renderer has been released');
        const label = document.createElement('div'); label.className = 'editable-lyric';
        root.append(label); root.dataset.reloadProof = 'local-v1';
        let raf = 0, disposed = false;
        const frame = () => {
          if (disposed) return;
          const state = getState(), position = timeline.position(state);
          const line = state.lyrics.lines.find(l => l.startMs !== undefined && l.startMs <= position && (l.endMs === undefined || position < l.endMs));
          label.textContent = line?.text ?? state.lyrics.lines[0]?.text ?? '等待歌词';
          label.style.cssText = `font-size:${state.settings.fontSize}px;color:${state.settings.color};text-align:center;padding:26px 32px;white-space:pre-wrap;overflow-wrap:anywhere`;
          raf = requestAnimationFrame(frame);
        };
        const dispose = () => { if (disposed) return; disposed = true; cancelAnimationFrame(raf); label.remove(); delete root.dataset.reloadProof; mounts.delete(dispose); };
        mounts.add(dispose); frame(); return dispose;
      },
    });
  },
};
