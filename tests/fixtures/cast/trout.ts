import { native, part, region } from './kit';

/** A brown trout: a body flat from side to side, spotted scales, a forked tail fin. Lives in the pond. */
export const trout = native({
  id: 'trout',
  name: 'Trout',
  seed: 17,
  parts: [
    part('body', null, 'torso', [0, 0, 1], 0.14, 0.045, 0.05, { squash: 0.6, flatFacing: 'side' }),
    part('front', 'body', 'torso', [0, 0, 1], 0.1, 0.05, 0.035, { squash: 0.6, flatFacing: 'side' }),
    part('head', 'front', 'head', [0, -0.05, 1], 0.07, 0.035, 0.018, { squash: 0.7, flatFacing: 'side' }),
    part('eye', 'head', 'eye', [1, 0.1, 0.3], 0.005, 0.009, 0.009, { at: 0.4, offset: [0.021, 0.008, 0], mirror: true }),
    part('tail', 'body', 'tail', [0, 0, -1], 0.09, 0.045, 0.018, { at: 0, squash: 0.55, flatFacing: 'side' }),
    part('tail2', 'tail', 'tail', [0, 0, -1], 0.05, 0.018, 0.012, { squash: 0.5, flatFacing: 'side' }),
    part('tailfin', 'tail2', 'fin', [0, 0, -1], 0.06, 0.012, 0.04, { squash: 0.12, region: 'fin' }),
    part('dorsal', 'body', 'fin', [0, 1, -0.5], 0.04, 0.025, 0.006, { at: 0.7, offset: [0, 0.035, 0], squash: 0.12, region: 'fin' }),
    part('pectoral', 'front', 'fin', [1, -0.6, -0.6], 0.035, 0.015, 0.004, { at: 0.2, offset: [0.025, -0.02, 0], squash: 0.12, flatFacing: 'up', mirror: true, region: 'fin' }),
  ],
  skin: {
    regions: [
      region('body', 'scales', '#8a7a4a', {
        belly: '#e8dcb0',
        pattern: { kind: 'spots', color: '#3a2a18', scale: 0.025, amount: 0.35, along: false },
      }),
      region('fin', 'skin', '#9a8a5a'),
    ],
    eyes: { color: '#c9a23a', pupil: 'round', size: 1 },
  },
  build: { muscle: 0.3, feet: 'plain' },
  face: { nose: 'slits', lids: false, brow: 0 },
  motion: { gait: 'swim', bounce: 0, sway: 0.6, stance: 'low' },
  life: { sizeM: 0.4, massKg: 0.8, topSpeed: 3, stamina: 0.6, lifespanDays: 2500, maturityDays: 700, litterMin: 6, litterMax: 12, juvenileHead: 1.3, juvenileFluff: 0 },
  mind: {
    plants: [], preyMin: 0.005, preyMax: 0.1, scavenger: false, boldness: 0.3, jumpiness: 0.7,
    social: 'solitary', activity: 'twilight', habitat: ['water'],
    senses: { fov: 330, acuity: 0.5, night: 0.5, smell: 0.6, hearing: 0.5, colour: 'vivid' },
  },
});
