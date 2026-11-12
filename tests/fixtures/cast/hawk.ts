import { native, part, region } from './kit';

/** A red-tailed hawk: upright perch, barred pale belly, hooked beak, broad wings, a rusty tail. */
export const hawk = native({
  id: 'hawk',
  name: 'Hawk',
  seed: 16,
  parts: [
    part('body', null, 'torso', [0, 0.5, 1], 0.18, 0.068, 0.074),
    part('chest', 'body', 'torso', [0, 0.8, 1], 0.08, 0.074, 0.058),
    part('head', 'chest', 'head', [0, 0.15, 1], 0.06, 0.036, 0.03, { offset: [0, 0.02, 0] }),
    part('beak', 'head', 'mouth', [0, -0.65, 1], 0.056, 0.02, 0.003, { pointed: true, region: 'beak' }),
    part('eye', 'head', 'eye', [0.6, 0.2, 0.8], 0.008, 0.012, 0.012, { at: 0.55, offset: [0.025, 0.012, 0], mirror: true }),
    part('wing', 'body', 'wing', [1, 0.1, -0.3], 0.22, 0.06, 0.05, { at: 0.75, offset: [0.06, 0.03, 0], squash: 0.12, mirror: true, region: 'wing' }),
    part('wingtip', 'wing', 'wing', [1, 0, -0.45], 0.3, 0.05, 0.02, { squash: 0.1, region: 'wing' }),
    part('thigh', 'body', 'leg', [0, -1, 0.05], 0.07, 0.02, 0.014, { at: 0.3, offset: [0.035, -0.05, 0], mirror: true }),
    part('tarsus', 'thigh', 'leg', [0, -1, 0], 0.07, 0.009, 0.009, { region: 'feet' }),
    part('talons', 'tarsus', 'foot', [0, -0.1, 1], 0.04, 0.01, 0.006, { pointed: true, region: 'feet' }),
    part('tail', 'body', 'tail', [0, -0.3, -1], 0.2, 0.045, 0.06, { at: 0, offset: [0, 0.02, 0], squash: 0.15, flatFacing: 'up', region: 'tail' }),
  ],
  skin: {
    regions: [
      region('body', 'feathers', '#6b4a2e', {
        belly: '#efe4d2',
        furLength: 0.03,
        coat: 'smooth',
        pattern: { kind: 'stripes', color: '#7a5636', scale: 0.03, amount: 0.3, along: false },
      }),
      region('wing', 'feathers', '#5a3e26', { belly: '#d9cbb4', furLength: 0.03, coat: 'smooth' }),
      region('tail', 'feathers', '#b4532a', { furLength: 0.03, coat: 'smooth' }),
      region('beak', 'shell', '#3a3430'),
      region('feet', 'skin', '#e3b23c'),
    ],
    eyes: { color: '#c8901a', pupil: 'round', size: 1 },
  },
  build: { muscle: 0.6, feet: 'talons' },
  face: { nose: 'beak', brow: 0.75 },
  motion: { gait: 'fly', bounce: 0.2, sway: 0.2, stance: 'upright' },
  life: { sizeM: 0.55, massKg: 1.1, topSpeed: 18, stamina: 0.8, lifespanDays: 7000, maturityDays: 700, litterMin: 2, litterMax: 3, juvenileHead: 1.3, juvenileFluff: 1 },
  mind: {
    plants: [], preyMin: 0.05, preyMax: 0.5, scavenger: false, boldness: 0.7, jumpiness: 0.4,
    social: 'solitary', activity: 'day', habitat: ['ground', 'air', 'trees'],
    senses: { fov: 220, acuity: 1, night: 0.2, smell: 0.2, hearing: 0.7, colour: 'vivid' },
  },
});
