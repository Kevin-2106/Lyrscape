import { describe, expect, it } from 'vitest';
import { createPcmStream, decodeAudioPacket, type AudioPacket } from '../src/plugins/audio';
import { normalizeAccelerator } from '../src/plugins/shortcuts';

const packet = (overrides: Partial<Extract<AudioPacket, { type: 'pcm' }>> = {}): Extract<AudioPacket, { type: 'pcm' }> => ({
  type: 'pcm', connectionId: 'amll-1', revision: 1, sequence: 1, protocolVersion: 1,
  receivedAtEpochMs: 100, droppedFrames: 0, data: [0, 128, 255, 127, 1, 0, 255, 255], ...overrides,
});

describe('original PCM stream', () => {
  it('decodes binary IPC metadata and shares exact sample bytes without another copy', () => {
    const source = new TextEncoder().encode('amll-1'), samples = [0, 128, 255, 127, 1, 0, 255, 255];
    const raw = new ArrayBuffer(40 + source.length + samples.length), view = new DataView(raw);
    new Uint8Array(raw).set([76, 80, 67, 77, 1, 2]); view.setUint16(6, source.length, true);
    [1n, 7n, 100n, 3n].forEach((n, i) => view.setBigUint64(8 + i * 8, n, true));
    new Uint8Array(raw, 40).set(source); new Uint8Array(raw, 40 + source.length).set(samples);
    const decoded = decodeAudioPacket(raw);
    expect(decoded).toMatchObject({ type: 'pcm', connectionId: 'amll-1', revision: 1, sequence: 7, receivedAtEpochMs: 100, droppedFrames: 3, protocolVersion: 2 });
    const stream = createPcmStream(); stream.accept({ type: 'reset', connectionId: 'amll-1', revision: 1 }); stream.accept(decoded);
    expect([...stream.read()!.data]).toEqual(samples); expect(stream.read()!.data.buffer).toBe(raw);
    expect(() => decodeAudioPacket(raw.slice(0, -1))).toThrow();
    view.setUint8(4, 9); expect(() => decodeAudioPacket(raw)).toThrow();
    view.setUint8(4, 1); view.setBigUint64(16, 2n ** 54n, true); expect(() => decodeAudioPacket(raw)).toThrow();
  });
  it('preserves signed sample bytes and provenance without changing or analyzing samples', () => {
    const stream = createPcmStream(() => 50);
    stream.accept({ type: 'reset', connectionId: 'amll-1', revision: 1 }); stream.accept(packet());
    expect([...stream.read()!.data]).toEqual(packet().data);
    expect(stream.read()).toMatchObject({ frameCount: 2, format: { sampleRate: 48000, channels: 2, sampleFormat: 'i16le', basis: 'amll-v1-spec' }, receivedAtMonoMs: 50 });
  });
  it('rejects foreign sources, old revisions and replayed blocks, clears on discontinuity and ages out', () => {
    let now = 10;
    const stream = createPcmStream(() => now);
    stream.accept({ type: 'reset', connectionId: 'amll-1', revision: 1 }); stream.accept(packet());
    stream.accept(packet({ connectionId: 'amll-2', sequence: 2, data: [0, 0, 0, 0] }));
    stream.accept(packet({ data: [0, 0, 0, 0] }));
    expect(stream.read()!.frameCount).toBe(2);
    now = 511; expect(stream.read()).toBeUndefined();
    stream.accept({ type: 'reset', connectionId: 'amll-2', revision: 2 });
    stream.accept(packet({ sequence: 3 })); expect(stream.read()).toBeUndefined();
    stream.accept(packet({ connectionId: 'amll-2', revision: 2, sequence: 4, protocolVersion: 2, droppedFrames: 3 }));
    expect(stream.read()).toMatchObject({ droppedFrames: 3, format: { basis: 'amll-player-compat' } });
    stream.accept({ type: 'reset', connectionId: null, revision: 3 }); expect(stream.read()).toBeUndefined();
  });
  it('rejects malformed blocks and releases subscriber callbacks', () => {
    const stream = createPcmStream();
    stream.accept({ type: 'reset', connectionId: 'amll-1', revision: 1 });
    for (const data of [[1], [256, 0, 0, 0], [0.5, 0, 0, 0], new Array(65540).fill(0)]) stream.accept(packet({ data }));
    expect(stream.read()).toBeUndefined();
    const frames: unknown[] = [], stop = stream.subscribe(f => frames.push(f));
    stream.accept(packet()); stop(); stream.accept(packet({ sequence: 2 }));
    expect(frames).toHaveLength(1); stream.clear(); expect(stream.read()).toBeUndefined();
  });
});

describe('global shortcut conflicts and normalization', () => {
  it('canonicalizes aliases and modifier ordering, and permits unbinding', () => {
    expect(normalizeAccelerator('shift+Control+KeyL')).toBe('Ctrl+Shift+L');
    expect(normalizeAccelerator('Alt+CTRL+Digit7')).toBe('Ctrl+Alt+7');
    expect(normalizeAccelerator('')).toBe('');
  });
  it('rejects typing interference, invalid keys and reserved application/system shortcuts', () => {
    for (const input of ['L', 'Ctrl', 'Ctrl+Shift', 'Ctrl+O', 'Ctrl+1', 'Ctrl+Tab', 'Super+L', 'Ctrl+Alt+Delete', 'Alt+F4', 'Ctrl+NoSuchKey', 'Ctrl+L+P']) expect(() => normalizeAccelerator(input)).toThrow();
    expect(normalizeAccelerator('Ctrl+Shift+P')).toBe('Ctrl+Shift+P');
  });
});
