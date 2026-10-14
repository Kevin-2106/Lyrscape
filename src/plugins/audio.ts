import { Channel } from '@tauri-apps/api/core';
import type { Plugin } from '../kernel/host';
import type { PcmAudio, PcmFrame } from '../sdk/types';
import { desktop, native } from '../platform';

export type AudioPacket =
  | { type: 'reset'; connectionId: string | null; revision: number }
  | { type: 'pcm'; connectionId: string; revision: number; sequence: number; protocolVersion: 1 | 2; receivedAtEpochMs: number; droppedFrames: number; data: number[] | Uint8Array };

/** LPCM v1: 40-byte LE header, UTF-8 source ID, then unchanged PCM bytes.
 * JSON resets and binary blocks share a channel so revisions remain ordered. */
export function decodeAudioPacket(value: ArrayBuffer | AudioPacket): AudioPacket {
  if (!(value instanceof ArrayBuffer)) return value;
  if (value.byteLength < 40) throw Error('截断的 PCM IPC 头');
  const view = new DataView(value);
  const sourceLength = view.getUint16(6, true), offset = 40 + sourceLength;
  if (view.getUint32(0, true) !== 0x4d43504c || view.getUint8(4) !== 1 || ![1, 2].includes(view.getUint8(5)) ||
    sourceLength < 1 || sourceLength > 80 || offset >= value.byteLength || value.byteLength - offset > 65536 || (value.byteLength - offset) % 4) throw Error('无效的 PCM IPC 包');
  const integer = (at: number) => {
    const number = Number(view.getBigUint64(at, true));
    if (!Number.isSafeInteger(number)) throw Error('PCM IPC 序号超出安全范围');
    return number;
  };
  return { type: 'pcm', connectionId: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value, 40, sourceLength)),
    revision: integer(8), sequence: integer(16), receivedAtEpochMs: integer(24), droppedFrames: integer(32),
    protocolVersion: view.getUint8(5) as 1 | 2, data: new Uint8Array(value, offset) };
}

export function createPcmStream(now = () => performance.now()) {
  let latest: PcmFrame | undefined, sourceId: string | null = null, revision = -1, sequence = -1;
  const listeners = new Set<(frame: PcmFrame | undefined) => void>();
  const publish = (frame?: PcmFrame) => {
    latest = frame;
    for (const listener of listeners) { try { listener(frame); } catch (error) { console.error(error); } }
  };
  return {
    accept(packet: AudioPacket) {
      if (packet.type === 'reset') {
        if (packet.revision < revision) return;
        revision = packet.revision; sourceId = packet.connectionId; sequence = -1; publish(); return;
      }
      if (packet.revision !== revision || packet.connectionId !== sourceId || packet.sequence <= sequence) return;
      if (!packet.data.length || packet.data.length > 65536 || packet.data.length % 4 ||
        !(packet.data instanceof Uint8Array) && packet.data.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return;
      sequence = packet.sequence;
      publish({ sourceId: packet.connectionId, revision, sequence, receivedAtMonoMs: now(), receivedAtEpochMs: packet.receivedAtEpochMs,
        droppedFrames: packet.droppedFrames, frameCount: packet.data.length / 4, data: packet.data instanceof Uint8Array ? packet.data : new Uint8Array(packet.data),
        format: { sampleRate: 48000, channels: 2, sampleFormat: 'i16le', interleaved: true, basis: packet.protocolVersion === 1 ? 'amll-v1-spec' : 'amll-player-compat' } });
    },
    read(maxAgeMs = 500) { return latest && now() - latest.receivedAtMonoMs <= Math.max(0, maxAgeMs) ? latest : undefined; },
    subscribe(listener: (frame: PcmFrame | undefined) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear() { publish(); listeners.clear(); },
  };
}

export const pcmAudioPlugin: Plugin = {
  id: 'official.audio.pcm',
  async activate(ctx) {
    const stream = createPcmStream();
    let active = true;
    ctx.own(() => { active = false; stream.clear(); });
    ctx.provide<PcmAudio>('audio.pcm@1', { read: stream.read, subscribe: stream.subscribe,
      async selectSource(sourceId) { if (desktop) await native('amll_audio_select', { connectionId: sourceId ?? null }); } });
    if (desktop) {
      const channel = new Channel<ArrayBuffer | AudioPacket>();
      channel.onmessage = value => {
        const packet = decodeAudioPacket(value);
        try { if (active) stream.accept(packet); }
        finally { if (packet.type === 'pcm') void native('amll_audio_ack', { sequence: packet.sequence }).catch(console.error); }
      };
      await native('amll_audio_subscribe', { onAudio: channel });
      ctx.own(() => { void native('amll_audio_unsubscribe').catch(console.error); });
    }
  },
};
