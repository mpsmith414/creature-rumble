import type { Part, Recipe } from '../../src/recipe/schema';
import { loadFixture } from './fighters';

const part = (id: string, parent: string | null, role: Part['role'], o: Partial<Part> = {}): Part => ({
  id, parent, role, attach: 1, offset: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 1, z: 0 }, length: 0.2, r0: 0.05, r1: 0.04,
  squash: 1, flatFacing: 'up', pointed: false, mirror: false, region: 'body', ...o,
});

/** A torso with 12 mirrored limbs of three bones each, plus a long tail and 12 horns: 48 parts, well over 90 bones and 24 segments. */
export function monster48Parts(): Recipe {
  const parts: Part[] = [part('torso', null, 'torso', { length: 0.6, r0: 0.2, r1: 0.18 })];
  for (let i = 0; i < 12; i++) {
    const at = (i + 1) / 13;
    const dir = { x: 1, y: -0.2, z: (i - 6) / 12 };
    parts.push(part(`arm${i}`, 'torso', 'arm', { attach: at, mirror: true, dir, length: 0.3 }));
    parts.push(part(`fore${i}`, `arm${i}`, 'arm', { dir, length: 0.25 }));
    parts.push(part(`claw${i}`, `fore${i}`, 'hand', { dir, length: 0.15 }));
  }
  parts.push(part('head', 'torso', 'head'));
  let prev = 'torso';
  for (let i = 0; i < 10; i++) {
    parts.push(part(`tail${i}`, prev, 'tail', { dir: { x: 0, y: -0.1, z: -1 }, length: 0.2 }));
    prev = `tail${i}`;
  }
  for (let i = 0; i < 12; i++) parts.push(part(`horn${i}`, 'head', 'horn', { offset: { x: 0.02 * i, y: 0, z: 0 }, length: 0.1 }));
  return { ...loadFixture('fists'), parts, fight: null } as Recipe;
}
