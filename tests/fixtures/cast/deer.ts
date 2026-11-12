import { native, part, region } from './kit';

/** A white-tailed doe: ~0.95 m at the shoulder, long thin legs, a deep chest, big ears. */
export const deer = native({
  id: 'deer',
  name: 'Deer',
  seed: 11,
  parts: [
    part('hips', null, 'torso', [0, 0.05, 1], 0.34, 0.14, 0.165),
    part('belly', 'hips', 'torso', [0, 0, 1], 0.3, 0.165, 0.175),
    part('chest', 'belly', 'torso', [0, 0.12, 1], 0.24, 0.175, 0.14, { offset: [0, 0.01, 0] }),
    part('neck', 'chest', 'neck', [0, 0.85, 0.55], 0.4, 0.085, 0.055, { at: 0.8, offset: [0, 0.05, 0] }),
    part('head', 'neck', 'head', [0, -0.35, 1], 0.17, 0.065, 0.05),
    part('muzzle', 'head', 'mouth', [0, -0.5, 1], 0.11, 0.045, 0.026, { region: 'muzzle' }),
    part('ear', 'head', 'ear', [0.85, 0.6, -0.25], 0.15, 0.045, 0.04, { at: 0.3, offset: [0.035, 0.05, 0], squash: 0.25, mirror: true }),
    part('eye', 'head', 'eye', [1, 0.15, 0.35], 0.012, 0.019, 0.019, { at: 0.5, offset: [0.048, 0.022, 0], mirror: true }),
    // front legs: upper leg, long thin cannon, small hoof
    part('arm', 'chest', 'leg', [0, -1, 0.04], 0.3, 0.06, 0.035, { at: 0.7, offset: [0.085, -0.1, 0], mirror: true }),
    part('cannon_f', 'arm', 'leg', [0, -1, 0], 0.32, 0.024, 0.019),
    part('hoof_f', 'cannon_f', 'foot', [0, -0.45, 1], 0.055, 0.02, 0.016, { region: 'hoof' }),
    // hind legs: thigh angled forward, gaskin back to the hock, cannon, hoof
    part('thigh', 'hips', 'leg', [0, -0.8, 0.45], 0.3, 0.085, 0.05, { at: 0.25, offset: [0.085, -0.05, 0], mirror: true }),
    part('gaskin', 'thigh', 'leg', [0, -0.75, -0.55], 0.26, 0.035, 0.024),
    part('cannon_h', 'gaskin', 'leg', [0, -1, 0.05], 0.22, 0.021, 0.018),
    part('hoof_h', 'cannon_h', 'foot', [0, -0.45, 1], 0.055, 0.02, 0.016, { region: 'hoof' }),
    part('tail', 'hips', 'tail', [0, 0.3, -1], 0.15, 0.045, 0.03, { at: 0, offset: [0, 0.07, 0], squash: 0.55, region: 'tail' }),
  ],
  skin: {
    regions: [
      region('body', 'fur', '#7d5536', { belly: '#eadfc8', furLength: 0.012, fluff: 0.15, coat: 'sleek' }),
      region('muzzle', 'fur', '#5e4634', { belly: '#efe8dc', furLength: 0.006, coat: 'sleek' }),
      region('hoof', 'shell', '#2a221c'),
      region('tail', 'fur', '#7c5026', { belly: '#f6f2ea', furLength: 0.02, fluff: 0.4, coat: 'soft' }),
    ],
    eyes: { color: '#2a1a10', pupil: 'bar', size: 0.95 },
  },
  build: { muscle: 0.8, feet: 'hooves' },
  face: { nose: 'pad', noseColor: '#1c1714', earInner: '#e9d6cc', brow: 0.3 },
  motion: { gait: 'walk', bounce: 0.3, sway: 0.3, stance: 'normal' },
  life: { sizeM: 1.6, massKg: 70, topSpeed: 13, stamina: 0.7, lifespanDays: 4000, maturityDays: 500, litterMin: 1, litterMax: 2, juvenileHead: 1.35, juvenileFluff: 0.4 },
  mind: {
    plants: ['grass', 'leaves', 'acorns'], preyMin: 0, preyMax: 0, scavenger: false, boldness: 0.2, jumpiness: 0.85,
    social: 'herd', activity: 'twilight', habitat: ['ground'],
    senses: { fov: 310, acuity: 0.5, night: 0.7, smell: 0.8, hearing: 0.9, colour: 'muted' },
  },
});
