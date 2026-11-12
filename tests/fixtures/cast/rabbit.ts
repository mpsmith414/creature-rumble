import { native, part, region } from './kit';

/** A wild rabbit: a round rump, folded hind legs with long feet, tall ears, a cotton tail. */
export const rabbit = native({
  id: 'rabbit',
  name: 'Rabbit',
  seed: 12,
  parts: [
    part('rump', null, 'torso', [0, 0.25, 1], 0.12, 0.075, 0.08),
    part('chest', 'rump', 'torso', [0, 0.15, 1], 0.1, 0.08, 0.058),
    part('head', 'chest', 'head', [0, 0.1, 1], 0.075, 0.046, 0.036, { offset: [0, 0.045, 0] }),
    part('nose', 'head', 'mouth', [0, -0.3, 1], 0.03, 0.028, 0.02),
    part('ear', 'head', 'ear', [0.22, 1, -0.35], 0.11, 0.022, 0.018, { at: 0.3, offset: [0.016, 0.03, 0], squash: 0.3, mirror: true }),
    part('eye', 'head', 'eye', [1, 0.2, 0.2], 0.01, 0.014, 0.014, { at: 0.45, offset: [0.034, 0.016, 0], mirror: true }),
    part('arm', 'chest', 'leg', [0, -1, 0.1], 0.06, 0.022, 0.016, { at: 0.6, offset: [0.035, -0.05, 0], mirror: true }),
    part('fore', 'arm', 'leg', [0, -1, 0], 0.05, 0.014, 0.012),
    part('paw_f', 'fore', 'foot', [0, -0.3, 1], 0.03, 0.012, 0.011),
    part('thigh', 'rump', 'leg', [0, -0.5, 1], 0.08, 0.045, 0.03, { at: 0.2, offset: [0.05, -0.03, 0], mirror: true }),
    part('shin', 'thigh', 'leg', [0, -0.6, -1], 0.08, 0.02, 0.016),
    part('paw_h', 'shin', 'foot', [0, -0.15, 1], 0.09, 0.016, 0.014),
    part('tail', 'rump', 'tail', [0, 0.6, -1], 0.035, 0.026, 0.025, { at: 0, offset: [0, 0.05, 0], region: 'tail' }),
  ],
  skin: {
    regions: [
      region('body', 'fur', '#8a7560', { belly: '#dccfb9', furLength: 0.015, fluff: 0.5, coat: 'soft' }),
      region('tail', 'fur', '#f2efe8', { furLength: 0.02, fluff: 0.8, coat: 'soft' }),
    ],
    eyes: { color: '#1a1008', pupil: 'round', size: 0.95 },
  },
  build: { muscle: 0.4, feet: 'paws' },
  face: { nose: 'pad', noseColor: '#c98b8b', earInner: '#e8b4b0', brow: 0.2 },
  motion: { gait: 'hop', bounce: 0.7, sway: 0.2, stance: 'low' },
  life: { sizeM: 0.4, massKg: 1.8, topSpeed: 11, stamina: 0.4, lifespanDays: 3000, maturityDays: 120, litterMin: 3, litterMax: 7, juvenileHead: 1.4, juvenileFluff: 0.8 },
  mind: {
    plants: ['grass', 'clover', 'flowers'], preyMin: 0, preyMax: 0, scavenger: false, boldness: 0.15, jumpiness: 0.95,
    social: 'herd', activity: 'twilight', habitat: ['ground', 'burrow'],
    senses: { fov: 340, acuity: 0.3, night: 0.6, smell: 0.8, hearing: 0.95, colour: 'muted' },
  },
});
