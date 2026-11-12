import {
  InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry, Quaternion, Vector3,
} from 'three/webgpu';
import { attribute, float, length, smoothstep, uv, vec2 } from 'three/tsl';
import type { Skeleton } from '../builder/skeleton';

/** A creature's shadow on the ground at its feet, never darker than this (the sun's real shadow adds to it). */
const STRENGTH = 0.35;
/** The footprint is a little wider than the skeleton, so the soft edge reaches past the body. */
const PAD = 1.15;
/** The quad floats this far (m) over the ground, on top of the material's polygon offset, so bumps do not cut it. */
const LIFT = 0.02;

/** Half-sizes of a creature's ground footprint (m, × 1.15 of its skeleton's x and z extents) and its centre offset. */
export function footprint(sk: Skeleton): { hx: number; hz: number; cx: number; cz: number } {
  return {
    hx: (PAD * (sk.max.x - sk.min.x)) / 2, hz: (PAD * (sk.max.z - sk.min.z)) / 2,
    cx: (sk.max.x + sk.min.x) / 2, cz: (sk.max.z + sk.min.z) / 2,
  };
}

/** Shadow strength: 0.35 on the ground, fading to 0 at one body length up; 0 in water. */
export function contactOpacity(height: number, bodyLength: number, inWater: boolean): number {
  if (inWater) return 0;
  return STRENGTH * Math.min(1, Math.max(0, 1 - height / Math.max(1e-6, bodyLength)));
}

/** The unit normal of the ground at (x, z) from `heightAt` there and `d` m along x and along z, written into `out`. */
export function groundNormal(heightAt: (x: number, z: number) => number, x: number, z: number, d: number, out: Vector3): Vector3 {
  const h = heightAt(x, z);
  return out.set(h - heightAt(x + d, z), d, h - heightAt(x, z + d)).normalize();
}

export type ContactShadows = {
  mesh: InstancedMesh;
  set(i: number, pos: Vector3, normal: Vector3, yaw: number, fp: ReturnType<typeof footprint>, opacity: number): void;
  hide(i: number): void;
  dispose(): void;
};

const m4 = new Matrix4(), q = new Quaternion(), qYaw = new Quaternion(), scale = new Vector3(), Y = new Vector3(0, 1, 0);

/**
 * One instanced quad per creature: a soft black ellipse (strong in the middle, nothing at the edge) lying on the ground
 * under it, so it looks planted. Instances start hidden; `set` places one, `hide` takes it away.
 */
export function createContactShadows(max: number): ContactShadows {
  const geometry = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2); // −1..1 in x and z, facing up
  const opacity = new InstancedBufferAttribute(new Float32Array(max), 1);
  geometry.setAttribute('opacity', opacity);
  const material = new MeshBasicNodeMaterial({ color: 0x000000, transparent: true, depthWrite: false });
  material.name = 'contact-shadow';
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -4;
  const r = length(uv().sub(vec2(0.5)).mul(2)); // the elliptical radius: 1 at the quad's edge
  const soft = float(1).sub(smoothstep(0.4, 1, r));
  material.opacityNode = soft.mul(soft).mul(attribute('opacity', 'float'));
  const mesh = new InstancedMesh(geometry, material, max);
  mesh.name = 'contact-shadows';
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.frustumCulled = false; // the instances are all over the valley; the bounds are not worked out
  mesh.renderOrder = 1; // after the ground
  const hide = (i: number) => {
    if (opacity.getX(i) === 0) return; // already hidden: nothing to upload
    mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
    opacity.setX(i, 0);
    mesh.instanceMatrix.needsUpdate = true;
    opacity.needsUpdate = true;
  };
  for (let i = 0; i < max; i++) mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
  return {
    mesh,
    set(i, pos, normal, yaw, fp, o) {
      q.setFromUnitVectors(Y, normal).multiply(qYaw.setFromAxisAngle(Y, yaw));
      mesh.setMatrixAt(i, m4.compose(pos, q, scale.set(fp.hx, 1, fp.hz)));
      opacity.setX(i, o);
      mesh.instanceMatrix.needsUpdate = true;
      opacity.needsUpdate = true;
    },
    hide,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

/** What `castUnder` reads of a rig. */
export type Standing = { position: { x: number; z: number }; yaw: number; altitude: number; inWater: boolean; bodyLength: number };

const at = new Vector3(), up = new Vector3();

/**
 * Lays instance `i` under a creature standing as `rig` shows, on `ground`: at its footprint centre, tilted to the slope,
 * as strong as `contactOpacity` says, × `fade` (0..1: less of the body is above the ground to cast it, say). When that is
 * nothing (in water, high in the air, faded out) the instance is hidden and this returns false. Allocation-free: call it
 * once a frame.
 */
export function castUnder(shadows: ContactShadows, i: number, rig: Standing, ground: { heightAt(x: number, z: number): number }, fp: ReturnType<typeof footprint>, fade = 1): boolean {
  const o = contactOpacity(rig.altitude, rig.bodyLength, rig.inWater) * Math.min(1, Math.max(0, fade));
  if (o <= 0) {
    shadows.hide(i);
    return false;
  }
  const s = Math.sin(rig.yaw), c = Math.cos(rig.yaw);
  const x = rig.position.x + fp.cx * c + fp.cz * s, z = rig.position.z - fp.cx * s + fp.cz * c; // the centre's offset, turned by the heading
  groundNormal(ground.heightAt, x, z, 0.5 * Math.max(fp.hx, fp.hz), up);
  at.set(x, ground.heightAt(x, z), z).addScaledVector(up, LIFT);
  shadows.set(i, at, up, rig.yaw, fp, o);
  return true;
}
