import { native, part, region } from './kit';

/** A red fox: slim body, black socks, pointed black-backed ears, a big white-tipped brush. */
export const fox = native({
  id: 'fox',
  name: 'Red Fox',
  seed: 13,
  parts: [
    part('hips', null, 'torso', [0, 0.02, 1], 0.2, 0.08, 0.09),
    part('chest', 'hips', 'torso', [0, 0.05, 1], 0.2, 0.095, 0.08),
    part('neck', 'chest', 'neck', [0, 0.7, 0.7], 0.12, 0.062, 0.052, { at: 0.9, offset: [0, 0.03, 0] }),
    part('head', 'neck', 'head', [0, -0.1, 1], 0.09, 0.058, 0.045),
    part('snout', 'head', 'mouth', [0, -0.25, 1], 0.09, 0.03, 0.012, { region: 'snout' }),
    part('ear', 'head', 'ear', [0.35, 1, -0.1], 0.09, 0.036, 0.004, { at: 0.3, offset: [0.032, 0.04, 0], squash: 0.25, pointed: true, mirror: true, region: 'ears' }),
    part('eye', 'head', 'eye', [1, 0.3, 0.6], 0.01, 0.014, 0.014, { at: 0.6, offset: [0.038, 0.024, 0], mirror: true }),
    part('arm', 'chest', 'leg', [0, -1, 0.05], 0.14, 0.035, 0.024, { at: 0.8, offset: [0.052, -0.055, 0], mirror: true }),
    part('fore', 'arm', 'leg', [0, -1, -0.02], 0.13, 0.018, 0.015, { region: 'socks' }),
    part('paw_f', 'fore', 'foot', [0, -0.3, 1], 0.035, 0.017, 0.015, { region: 'socks' }),
    part('thigh', 'hips', 'leg', [0, -0.8, 0.45], 0.15, 0.05, 0.03, { at: 0.2, offset: [0.052, -0.035, 0], mirror: true }),
    part('shin', 'thigh', 'leg', [0, -0.7, -0.7], 0.12, 0.022, 0.016, { region: 'socks' }),
    part('meta', 'shin', 'leg', [0, -1, 0.1], 0.08, 0.016, 0.014, { region: 'socks' }),
    part('paw_h', 'meta', 'foot', [0, -0.3, 1], 0.035, 0.016, 0.015, { region: 'socks' }),
    part('tail1', 'hips', 'tail', [0, -0.2, -1], 0.14, 0.045, 0.06, { at: 0, offset: [0, 0.05, 0], region: 'brush' }),
    part('tail2', 'tail1', 'tail', [0, -0.35, -1], 0.14, 0.06, 0.055, { region: 'brush' }),
    part('tail3', 'tail2', 'tail', [0, -0.4, -1], 0.12, 0.05, 0.02, { region: 'tip' }),
  ],
  skin: {
    // the russet a little deeper and less saturated (was #c8641e, #c4621e, #c0601f): at dusk the fox glowed against the dim wood
    regions: [
      region('body', 'fur', '#b9612a', { belly: '#f1ebe0', furLength: 0.018, fluff: 0.35, coat: 'soft' }),
      region('snout', 'fur', '#b65f29', { belly: '#f4efe6', furLength: 0.008, coat: 'sleek' }),
      region('ears', 'fur', '#3a2416', { furLength: 0.006, coat: 'sleek' }),
      region('socks', 'fur', '#2a1d16', { furLength: 0.01, fluff: 0.2, coat: 'soft' }),
      region('brush', 'fur', '#b25d2a', { belly: '#d9a37a', furLength: 0.035, fluff: 0.75, coat: 'shaggy' }),
      region('tip', 'fur', '#f4efe6', { furLength: 0.035, fluff: 0.75, coat: 'shaggy' }),
    ],
    eyes: { color: '#c88a1a', pupil: 'slit', size: 0.95 },
  },
  build: { muscle: 0.6, feet: 'paws' },
  face: { nose: 'pad', noseColor: '#1a1410', earInner: '#f0e6da', brow: 0.35 },
  motion: { gait: 'walk', bounce: 0.35, sway: 0.4, stance: 'normal' },
  life: { sizeM: 1.0, massKg: 6, topSpeed: 13, stamina: 0.6, lifespanDays: 1800, maturityDays: 300, litterMin: 3, litterMax: 6, juvenileHead: 1.4, juvenileFluff: 0.6 },
  mind: {
    plants: ['berries'], preyMin: 0.05, preyMax: 0.5, scavenger: true, boldness: 0.5, jumpiness: 0.6,
    social: 'pair', activity: 'twilight', habitat: ['ground', 'burrow'],
    senses: { fov: 260, acuity: 0.6, night: 0.8, smell: 0.9, hearing: 0.95, colour: 'muted' },
  },
});
