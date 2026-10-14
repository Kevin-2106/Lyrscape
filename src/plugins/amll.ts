import type { Plugin } from '../kernel/host';
import type { AppState, PlaybackSnapshot, PcmAudio } from '../sdk/types';
import type { Store } from '../kernel/store';
import type { Timeline } from '../sdk/types';
import { parseAmllStructured, parseLyrics } from './parsers';
import { desktop, native, onEvent } from '../platform';

export interface AmllAdapter { start(port: number): Promise<void>; stop(): Promise<void>; snapshot(): PlaybackSnapshot }
const emptyLyrics = { timingMode: 'none' as const, lines: [] };
type WireMessage = { connectionId: string; payload: { type: string; value?: Record<string, unknown> } };

export function amllPlugin(store: Store<AppState>): Plugin {
  return {
    id: 'official.adapter.amll', requires: ['timeline@1', 'audio.pcm@1'],
    async activate(ctx) {
      let selected: string | undefined;
      const clients = new Set<string>();
      const snapshots = new Map<string, PlaybackSnapshot>();
      const blank = (): PlaybackSnapshot => ({
        lyrics: emptyLyrics, track: { title: '等待播放器', artists: [] },
        playback: { positionMs: 0, playing: false, observedAtMonoMs: performance.now(), rate: 1 },
      });
      let session = blank();
      const time = ctx.service<Timeline>('timeline@1');
      const audio = ctx.service<PcmAudio>('audio.pcm@1');
      await audio.selectSource();
      let audioSource: string | undefined;
      let audioQueue = Promise.resolve();
      const selectAudio = () => {
        const next = active && store.get().adapterId === 'amll' ? selected : undefined;
        if (audioSource === next) return;
        audioSource = next;
        audioQueue = audioQueue.then(() => audio.selectSource(next)).catch(error => console.error(error));
      };
      let active = true;
      ctx.own(() => { active = false; });
      ctx.own(store.subscribe(selectAudio));
      ctx.own(() => { active = false; selectAudio(); return audioQueue; });
      const error = (message: string) => store.update(s => ({ ...s, error: message }));
      const applySession = () => store.update(s => s.adapterId === 'amll' ? { ...s, ...session } : s);
      const resetSession = () => { session = blank(); snapshots.clear(); applySession(); };
      const setSession = (state: AppState, id: string) => {
        const snapshot = { track: state.track, playback: state.playback, lyrics: state.lyrics };
        snapshots.set(id, snapshot);
        if (id === selected) {
          session = snapshot;
          store.update(current => current.adapterId === 'amll' ? { ...current, ...snapshot, error: state.error } : current);
        }
      };
      if (desktop) {
        ctx.own(await onEvent<{ connectionId: string; connected: boolean }>('amll-connection', e => {
          if (!active) return;
          if (e.connected) { clients.add(e.connectionId); snapshots.set(e.connectionId, blank()); }
          else { clients.delete(e.connectionId); snapshots.delete(e.connectionId); }
          // Each connection is isolated. First connection owns the single baseline session.
          if (!selected && e.connected) selected = e.connectionId;
          if (e.connectionId === selected && !e.connected) {
            selected = clients.values().next().value;
            session = selected ? snapshots.get(selected) ?? blank() : blank(); applySession();
          }
          selectAudio();
          store.update(s => ({ ...s, connection: { ...s.connection, clients: clients.size, status: clients.size ? 'connected' : s.connection.status === 'stopped' ? 'stopped' : 'listening' } }));
        }));
        ctx.own(await onEvent<WireMessage>('amll-message', e => {
          if (!active) return;
          if (!selected) selected = e.connectionId;
          const value = e.payload?.value;
          if (e.payload?.type !== 'state' || !value) return;
          try {
            const state = { ...store.get(), ...(snapshots.get(e.connectionId) ?? blank()), adapterId: 'amll' as const }, now = performance.now();
            switch (value.update) {
              case 'setMusic': {
                const title = typeof value.musicName === 'string' ? value.musicName.slice(0, 1000) : '未知曲目';
                const artists = Array.isArray(value.artists) ? value.artists.slice(0, 100).map(a => typeof a?.name === 'string' ? a.name.slice(0, 1000) : '').filter(Boolean) : [];
                const duration = Number(value.duration);
                setSession({ ...state, error: undefined, track: { title, artists, durationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined }, lyrics: emptyLyrics, playback: { positionMs: 0, playing: false, rate: 1, observedAtMonoMs: now } }, e.connectionId);
                break;
              }
              case 'progress': {
                const position = Number(value.progress);
                if (!Number.isFinite(position) || position < 0) throw new Error('AMLL 进度无效');
                setSession({ ...state, playback: { ...state.playback, positionMs: position, observedAtMonoMs: now } }, e.connectionId); break;
              }
              case 'paused': case 'resumed':
                setSession({ ...state, playback: { ...state.playback, positionMs: time.position(state), playing: value.update === 'resumed', observedAtMonoMs: now } }, e.connectionId); break;
              case 'setLyric': {
                const lyrics = value.format === 'ttml' ? parseLyrics(String(value.data ?? ''), 'amll.ttml') : parseAmllStructured(value.lines);
                setSession({ ...state, lyrics, error: undefined }, e.connectionId); break;
              }
            }
          } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); }
        }));
        ctx.own(await onEvent<{ message: string }>('amll-error', e => { if (active) error(e.message); }));
      }
      const adapter: AmllAdapter = {
        snapshot: () => session,
        async start(port) {
          if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024–65535 的整数');
          // Stop and clear before restarting; events from closed native tasks cannot own the new session.
          await native('amll_stop'); clients.clear(); selected = undefined; resetSession();
          await native('amll_start', { port });
          store.update(s => ({ ...s, error: undefined, connection: { status: 'listening', port, clients: 0 } }));
        },
        async stop() {
          if (desktop) await native('amll_stop'); selected = undefined; clients.clear(); resetSession();
          store.update(s => ({ ...s, connection: { ...s.connection, status: 'stopped', clients: 0 } }));
        },
      };
      ctx.provide('adapter.amll@1', adapter);
      ctx.own(async () => { if (desktop && store.get().connection.status !== 'stopped') await native('amll_stop'); });
    },
  };
}
