import { native, part, region } from './kit';

/** A mallard drake: boat-shaped body, green head, yellow bill, orange webbed feet. Waddles, swims, flies. */
export const duck = native({
  id: 'duck',
  name: 'Duck',
  seed: 15,
  parts: [
    part('body', null, 'torso', [0, 0.05, 1], 0.2, 0.08, 0.09),
    part('chest', 'body', 'torso', [0, 0.25, 1], 0.08, 0.09, 0.068),
    part('neck', 'chest', 'neck', [0, 1, 0.2], 0.11, 0.034, 0.03, { at: 0.8, offset: [0, 0.03, 0], region: 'head' }),
    part('head', 'neck', 'head', [0, 0.1, 1], 0.06, 0.038, 0.034, { region: 'head' }),
    part('bill', 'head', 'mouth', [0, -0.25, 1], 0.072, 0.02, 0.016, { squash: 0.45, flatFacing: 'up', region: 'bill' }),
    part('eye', 'head', 'eye', [1, 0.2, 0.3], 0.006, 0.009, 0.009, { at: 0.4, offset: [0.03, 0.012, 0], mirror: true }),
    part('wing', 'body', 'wing', [1, 0.1, -0.4], 0.14, 0.05, 0.04, { at: 0.65, offset: [0.065, 0.04, 0], squash: 0.15, mirror: true, region: 'wing' }),
    part('wingtip', 'wing', 'wing', [1, 0, -0.6], 0.16, 0.04, 0.015, { squash: 0.12, region: 'wing' }),
    part('thigh', 'body', 'leg', [0, -1, 0.1], 0.045, 0.014, 0.01, { at: 0.45, offset: [0.04, -0.06, 0], mirror: true, region: 'feet' }),
    part('shin', 'thigh', 'leg', [0, -1, 0], 0.04, 0.008, 0.008, { region: 'feet' }),
    part('foot', 'shin', 'foot', [0, -0.1, 1], 0.04, 0.01, 0.013, { squash: 0.4, flatFacing: 'up', region: 'feet' }),
    part('tail', 'body', 'tail', [0, 0.4, -1], 0.06, 0.04, 0.015, { at: 0, offset: [0, 0.04, 0], squash: 0.3, flatFacing: 'up' }),
  ],
  skin: {
    regions: [
      region('body', 'feathers', '#8c8070', { belly: '#cfc8ba', furLength: 0.02, coat: 'smooth' }),
      region('head', 'feathers', '#1d5a3a', { furLength: 0.02, coat: 'smooth' }),
      region('bill', 'skin', '#d8b02a'),
      region('wing', 'feathers', '#6e6458', { belly: '#b9b0a2', furLength: 0.02, coat: 'smooth' }),
      region('feet', 'skin', '#e07a20'),
    ],
    eyes: { color: '#1a120c', pupil: 'round', size: 1 },
  },
  build: { muscle: 0.4, feet: 'webbed' },
  face: { nose: 'bill', brow: 0.2 },
  motion: { gait: 'waddle', bounce: 0.4, sway: 0.5, stance: 'normal' },
  life: { sizeM: 0.55, massKg: 1.2, topSpeed: 3, stamina: 0.7, lifespanDays: 2500, maturityDays: 300, litterMin: 6, litterMax: 12, juvenileHead: 1.4, juvenileFluff: 0.9 },
  mind: {
    plants: ['water plants', 'seeds'], preyMin: 0.005, preyMax: 0.05, scavenger: false, boldness: 0.45, jumpiness: 0.5,
    social: 'flock', activity: 'day', habitat: ['ground', 'water', 'air'],
    senses: { fov: 330, acuity: 0.6, night: 0.3, smell: 0.3, hearing: 0.6, colour: 'vivid' },
  },
});
