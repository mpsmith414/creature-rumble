import { native, part, region } from './kit';

/** A big green frog: sits angled up, a flat head with bulging eyes, folded hind legs with webbed feet. */
export const frog = native({
  id: 'frog',
  name: 'Frog',
  seed: 18,
  parts: [
    part('body', null, 'torso', [0, 0.35, 1], 0.07, 0.045, 0.04, { region: 'back' }),
    part('head', 'body', 'head', [0, 0.05, 1], 0.045, 0.045, 0.034, { squash: 0.7, flatFacing: 'up', region: 'back' }),
    part('eye', 'head', 'eye', [0.6, 1, 0.2], 0.01, 0.014, 0.014, { at: 0.4, offset: [0.026, 0.026, 0], mirror: true }),
    part('arm', 'body', 'leg', [0.3, -1, 0.3], 0.035, 0.012, 0.009, { at: 0.85, offset: [0.035, -0.02, 0], mirror: true }),
    part('fore', 'arm', 'leg', [0, -1, 0.1], 0.03, 0.008, 0.008),
    part('hand', 'fore', 'foot', [0, -0.1, 1], 0.02, 0.009, 0.009, { squash: 0.5, flatFacing: 'up' }),
    part('thigh', 'body', 'leg', [0.4, -0.2, 1], 0.06, 0.02, 0.012, { at: 0.1, offset: [0.04, -0.01, 0], mirror: true }),
    part('shin', 'thigh', 'leg', [0, -0.3, -1], 0.06, 0.01, 0.008),
    part('webfoot', 'shin', 'foot', [0.2, -0.1, 1], 0.06, 0.008, 0.012, { squash: 0.4, flatFacing: 'up' }),
  ],
  skin: {
    regions: [
      region('back', 'slime', '#5a7a2e', {
        belly: '#e6e0b0',
        pattern: { kind: 'patches', color: '#2e3e18', scale: 0.03, amount: 0.35, along: false },
      }),
      region('body', 'skin', '#62823a', { belly: '#e2dcb0' }),
    ],
    eyes: { color: '#c8a030', pupil: 'bar', size: 1 },
  },
  build: { muscle: 0.2, feet: 'webbed' },
  face: { nose: 'slits', brow: 0.1 },
  motion: { gait: 'hop', bounce: 0.8, sway: 0.1, stance: 'low' },
  life: { sizeM: 0.18, massKg: 0.5, topSpeed: 3, stamina: 0.3, lifespanDays: 3000, maturityDays: 700, litterMin: 12, litterMax: 12, juvenileHead: 1.2, juvenileFluff: 0 },
  mind: {
    plants: [], preyMin: 0.003, preyMax: 0.04, scavenger: false, boldness: 0.3, jumpiness: 0.9,
    social: 'solitary', activity: 'twilight', habitat: ['ground', 'water'],
    senses: { fov: 330, acuity: 0.6, night: 0.6, smell: 0.3, hearing: 0.6, colour: 'vivid' },
  },
});
