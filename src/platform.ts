import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const desktop = isTauri();
const channel = !desktop && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lyrscape') : undefined;
const browserListeners = new Map<string, Set<(payload: unknown) => void>>();
if (channel) channel.onmessage = ({ data }) => {
  if (data && typeof data.event === 'string') browserListeners.get(data.event)?.forEach(fn => fn(data.payload));
};

export async function onEvent<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
  if (desktop) return listen<T>(event, message => callback(message.payload));
  const listeners = browserListeners.get(event) ?? new Set();
  listeners.add(callback as (payload: unknown) => void); browserListeners.set(event, listeners);
  return () => { listeners.delete(callback as (payload: unknown) => void); };
}
export async function sendEvent(event: string, payload?: unknown): Promise<void> {
  if (desktop) await emit(event, payload);
  else channel?.postMessage({ event, payload });
}
/** Playback/state belong to the overlay; broadcasting them also evaluates large
 * payload scripts in the control window, which has no consumer for them. */
export async function sendOverlayEvent(event: string, payload?: unknown): Promise<void> {
  if (desktop) await invoke('session_publish', { event, payload });
  else channel?.postMessage({ event, payload });
}
export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) throw new Error('此功能需要桌面版 Lyrscape。');
  return invoke<T>(command, args);
}
export async function dragOverlay(): Promise<void> { if (desktop) await getCurrentWindow().startDragging(); }
export async function resizeOverlay(direction: 'East' | 'West'): Promise<void> {
  if (desktop) await getCurrentWindow().startResizeDragging(direction);
}
