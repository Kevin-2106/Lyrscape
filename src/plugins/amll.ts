import type { Plugin } from '../kernel/host';
import type { AppState, PlaybackSnapshot, PcmAudio } from '../sdk/types';
import type { Store } from '../kernel/store';
import type { Timeline } from '../sdk/types';
import { parseAmllStructured, parseLyrics } from './parsers';
import { desktop, native, onEvent } from '../platform';

export interface AmllAdapter { start(port: number): Promise<void>; stop(): Promise<void>; snapshot(): PlaybackSnapshot }
const emptyLyrics = { timingMode: 'none' as const, lines: [] };
type WireMessage = { connectionId: string; sequence?: number; receivedAtEpochMs?: number; payload: { type: string; value?: Record<string, unknown> } };

export function amllPlugin(store: Store<AppState>, background = false): Plugin {
  return {
    id: 'official.adapter.amll', requires: ['timeline@1', 'audio.pcm@1'],
    async activate(ctx) {
      let selected: string | undefined;
      let ownsControl = !background;
      let hydrating = desktop;
      const pending: WireMessage[] = [];
      const sequences = new Map<string, number>();
      const clients = new Set<string>();
      const snapshots = new Map<string, PlaybackSnapshot>();
      const blank = (): PlaybackSnapshot => ({
        lyrics: emptyLyrics, track: { title: '等待播放器', artists: [] },
        playback: { positionMs: 0, playing: false, observedAtMonoMs: performance.now(), rate: 1 },
      });
      let session = blank();
      const time = ctx.service<Timeline>('timeline@1');
      const audio = ctx.service<PcmAudio>('audio.pcm@1');
      let audioSource: string | undefined;
      let audioQueue = Promise.resolve();
      const selectAudio = () => {
        if (!ownsControl) return;
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
      const applySession = () => { if (ownsControl) store.update(s => s.adapterId === 'amll' ? { ...s, ...session } : s); };
      const resetSession = () => { session = blank(); snapshots.clear(); applySession(); };
      const setSession = (state: AppState, id: string) => {
        const snapshot = { track: state.track, playback: state.playback, lyrics: state.lyrics };
        snapshots.set(id, snapshot);
        if (id === selected) {
          session = snapshot;
          if (ownsControl) store.update(current => current.adapterId === 'amll' ? { ...current, ...snapshot, error: state.error } : current);
        }
      };
      if (desktop) {
        ctx.own(await onEvent<{ connectionId: string; connected: boolean }>('amll-connection', e => {
          if (!active) return;
          if (e.connected) { clients.add(e.connectionId); if (!snapshots.has(e.connectionId)) snapshots.set(e.connectionId, blank()); }
          else { clients.delete(e.connectionId); snapshots.delete(e.connectionId); }
          // Each connection is isolated. First connection owns the single baseline session.
          if (!selected && e.connected) selected = e.connectionId;
          if (e.connectionId === selected && !e.connected) {
            selected = clients.values().next().value;
            session = selected ? snapshots.get(selected) ?? blank() : blank(); applySession();
          }
          selectAudio();
          if (ownsControl) store.update(s => ({ ...s, connection: { ...s.connection, clients: clients.size, status: clients.size ? 'connected' : s.connection.status === 'stopped' ? 'stopped' : 'listening' } }));
        }));
        const receive = (e: WireMessage) => {
          if (!active) return;
          if (e.sequence !== undefined) {
            if (e.sequence <= (sequences.get(e.connectionId) ?? -1)) return;
            sequences.set(e.connectionId, e.sequence);
          }
          if (!selected) selected = e.connectionId;
          const value = e.payload?.value;
          if (e.payload?.type !== 'state' || !value) return;
          try {
            const state = { ...store.get(), ...(snapshots.get(e.connectionId) ?? blank()), adapterId: 'amll' as const };
            const now = performance.now() - Math.max(0, Date.now() - (e.receivedAtEpochMs ?? Date.now()));
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
                setSession({ ...state, playback: { ...state.playback, positionMs: time.position(state, now), playing: value.update === 'resumed', observedAtMonoMs: now } }, e.connectionId); break;
              case 'setLyric': {
                const lyrics = value.format === 'ttml' ? parseLyrics(String(value.data ?? ''), 'amll.ttml') : parseAmllStructured(value.lines);
                setSession({ ...state, lyrics, error: undefined }, e.connectionId); break;
              }
            }
          } catch (cause) { if (ownsControl) error(cause instanceof Error ? cause.message : String(cause)); }
        };
        ctx.own(await onEvent<WireMessage>('amll-message', e => { if (hydrating) pending.push(e); else receive(e); }));
        if (background) ctx.own(await onEvent<boolean>('control-presence', present => {
          ownsControl = !present;
          if (ownsControl) { applySession(); selectAudio(); }
        }));
        const replay = await native<{ status: { running: boolean; port?: number; connections: string[] }; messages: WireMessage[]; controlActive: boolean; selectedConnection?: string }>('amll_replay');
        if (background) ownsControl = !replay.controlActive;
        for (const id of replay.status.connections) { clients.add(id); if (!snapshots.has(id)) snapshots.set(id, blank()); }
        selected ??= replay.selectedConnection && clients.has(replay.selectedConnection) ? replay.selectedConnection : replay.status.connections[0];
        if (ownsControl) store.update(s => ({ ...s, connection: { ...s.connection, port: replay.status.port ?? s.connection.port, clients: clients.size,
          status: replay.status.running ? clients.size ? 'connected' : 'listening' : 'stopped' } }));
        for (const message of [...replay.messages, ...pending].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) receive(message);
        pending.length = 0; hydrating = false;
        if (selected) session = snapshots.get(selected) ?? session;
        applySession(); selectAudio();
        ctx.own(await onEvent<{ message: string }>('amll-error', e => { if (active && ownsControl) error(e.message); }));
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
      ctx.own(async () => {
        if (desktop && !background && store.get().connection.status !== 'stopped' && (await native<{ controlActive: boolean }>('session_restore')).controlActive) await native('amll_stop');
      });
    },
  };
}
