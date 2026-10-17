import type { Plugin } from '../kernel/host';
import { optionalBeat } from './beat';
import type { BeatDetector, Renderer } from '../sdk/types';
import { ownRenderer } from './renderer';
import { pvFields, pvProfiles, type PvProfile } from './pv-presets';
import { createPvStage, type PvStyle } from './pv/stage';
import { popStyle } from './pv/pop';
import { letterStyle } from './pv/letter';
import { elegyStyle } from './pv/elegy';
import { vampStyle } from './pv/vamp';
import { synthStyle } from './pv/synth';
import { amllStyle } from './pv/amll';
import { haloStyle, haloTypeStyle } from './pv/halo';
import { halo3Style } from './pv/halo3';
import { azureStyle } from './pv/azure';
import { gamedevStyle } from './pv/gamedev';
import './pv.css';

const styles: Record<PvProfile['style'], PvStyle<never>> = { pop: popStyle, letter: letterStyle, elegy: elegyStyle, vamp: vampStyle, synth: synthStyle, halo: haloStyle, halo2: haloTypeStyle, halo3: halo3Style, azure: azureStyle, gamedev: gamedevStyle, amll: amllStyle } as never;

export function createPvRenderer(profile: PvProfile, beat?: () => BeatDetector | undefined): Renderer {
  return createPvStage(styles[profile.style], profile.id, pvFields(profile), beat);
}

export const pvPlugins: Plugin[] = pvProfiles.map(profile => ({
  id: profile.id,
  activate(ctx) { ctx.provide(profile.service, ownRenderer(ctx, createPvRenderer(profile, optionalBeat(ctx)))); },
}));
