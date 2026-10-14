import type { PluginManifest } from '../../src/sdk/types';
export function loadManifests(workspace?: string): Promise<PluginManifest[]>;
export function bundlePlugin(id: string, workspace?: string): Promise<{ id: string; javascript: string; css: string }>;
