import { native, part, region } from './kit';

/** A grey wolf: deep chest, thick ruff, long legs, a darker saddle and a bushy tail. */
export const wolf = native({
  id: 'wolf',
  name: 'Wolf',
  seed: 14,
  parts: [
    part('hips', null, 'torso', [0, 0.03, 1], 0.3, 0.12, 0.135),
    part('chest', 'hips', 'torso', [0, 0.06, 1], 0.3, 0.155, 0.14, { offset: [0, -0.01, 0] }),
    part('neck', 'chest', 'neck', [0, 0.6, 0.8], 0.22, 0.11, 0.085, { at: 0.9, offset: [0, 0.05, 0] }),
    part('head', 'neck', 'head', [0, -0.3, 1], 0.15, 0.088, 0.068),
    part('snout', 'head', 'mouth', [0, -0.2, 1], 0.13, 0.05, 0.028),
    part('ear', 'head', 'ear', [0.3, 1, -0.1], 0.12, 0.046, 0.008, { at: 0.3, offset: [0.048, 0.06, 0], squash: 0.3, pointed: true, mirror: true }),
    part('eye', 'head', 'eye', [1, 0.3, 0.6], 0.012, 0.018, 0.018, { at: 0.62, offset: [0.054, 0.034, 0], mirror: true }),
    part('arm', 'chest', 'leg', [0, -1, 0.04], 0.26, 0.055, 0.04, { at: 0.78, offset: [0.08, -0.09, 0], mirror: true }),
    part('fore', 'arm', 'leg', [0, -1, 0], 0.24, 0.034, 0.028, { region: 'legs' }),
    part('paw_f', 'fore', 'foot', [0, -0.3, 1], 0.06, 0.03, 0.026, { region: 'legs' }),
    part('thigh', 'hips', 'leg', [0, -0.8, 0.45], 0.27, 0.075, 0.045, { at: 0.2, offset: [0.08, -0.06, 0], mirror: true }),
    part('shin', 'thigh', 'leg', [0, -0.7, -0.7], 0.22, 0.036, 0.028, { region: 'legs' }),
    part('meta', 'shin', 'leg', [0, -1, 0.08], 0.15, 0.028, 0.025, { region: 'legs' }),
    part('paw_h', 'meta', 'foot', [0, -0.3, 1], 0.06, 0.028, 0.025, { region: 'legs' }),
    part('tail1', 'hips', 'tail', [0, -0.5, -1], 0.2, 0.05, 0.06, { at: 0, offset: [0, 0.06, 0] }),
    part('tail2', 'tail1', 'tail', [0, -0.9, -1], 0.2, 0.06, 0.035),
  ],
  skin: {
    regions: [
      region('body', 'fur', '#6e685e', { belly: '#d8d2c6', furLength: 0.035, fluff: 0.5, coat: 'shaggy' }),
      region('legs', 'fur', '#857e72', { belly: '#b8b0a2', furLength: 0.015, fluff: 0.3, coat: 'soft' }),
    ],
    eyes: { color: '#d4a020', pupil: 'round', size: 0.9 },
  },
  build: { muscle: 0.75, feet: 'paws' },
  face: { nose: 'pad', noseColor: '#151212', earInner: '#d8cfc4', brow: 0.45 },
  motion: { gait: 'walk', bounce: 0.25, sway: 0.35, stance: 'normal' },
  life: { sizeM: 1.6, massKg: 40, topSpeed: 15, stamina: 0.9, lifespanDays: 4000, maturityDays: 700, litterMin: 4, litterMax: 6, juvenileHead: 1.4, juvenileFluff: 0.7 },
  mind: {
    plants: [], preyMin: 0.2, preyMax: 2, scavenger: true, boldness: 0.75, jumpiness: 0.35,
    social: 'pack', activity: 'twilight', habitat: ['ground'],
    senses: { fov: 250, acuity: 0.6, night: 0.85, smell: 1, hearing: 0.95, colour: 'muted' },
  },
});
