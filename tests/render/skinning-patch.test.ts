import { referenceBuffer } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { SKIN_BONES, skinningPatched } from '../../src/render/skinning-patch';

type Inner = { node: { name: string } | null; setNodeType(type: string): void };

describe('skinning patch', () => {
  it('applies to this three', () => expect(skinningPatched).toBe(true));

  it('gives the bone buffer a stable name, as skinning builds it', () => {
    // three's skinning: referenceBuffer('skeleton.boneMatrices', 'mat4', bones), typed when the material builds
    const make = () => {
      const r = referenceBuffer('skeleton.boneMatrices', 'mat4', 25, null) as unknown as Inner;
      r.setNodeType('mat4');
      return r.node!.name;
    };
    expect(make()).toBe(SKIN_BONES);
    expect(make()).toBe(make()); // the same for every build, so equal materials give equal shader code
  });

  it('leaves other reference buffers alone', () => {
    const r = referenceBuffer('morphTargetInfluences', 'float', 4, null) as unknown as Inner;
    r.setNodeType('float');
    expect(r.node!.name).not.toBe(SKIN_BONES);
  });
});
