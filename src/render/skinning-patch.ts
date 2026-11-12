import { ReferenceNode } from 'three/webgpu';

/**
 * A stable WGSL name for a skinned mesh's bone-matrix buffer. Written against three r186; check it on every upgrade.
 *
 * Why: three's skinning reads the bones through `referenceBuffer('skeleton.boneMatrices', 'mat4', n)`, which has no name,
 * so the WGSL builder calls the buffer `NodeBuffer_<node id>`. Each material build gets a fresh id, so every skinned
 * material compiles shader code of its own: no two creatures (not even two of one species, or two fur shells) ever share
 * a GPU pipeline, and each new one stalls the GPU for its compile (about 10 s for a furry body on D3D12, measured in the
 * Valley). Naming the buffer makes equal materials produce equal code, and three then shares the pipeline.
 *
 * How: `ReferenceNode.setNodeType` creates the inner buffer node and copies `this.name` onto it, so the name is set just
 * before that. If three changes those internals the patch warns once and does nothing (creatures still draw, only slower).
 */
export const SKIN_BONES = 'skinBones';
const BONES = 'skeleton.boneMatrices';

type Ref = { name: string | null; property: string; setNodeType(type: string): void };

let warned = false;
const warn = (why: string) => {
  if (warned) return;
  warned = true;
  console.warn(`skinning patch not applied (${why}): creatures will compile a shader each. Check three's ReferenceNode.`);
};

function apply(): boolean {
  const proto = ReferenceNode.prototype as unknown as Ref & { __skinBones?: true };
  if (proto.__skinBones) return true;
  if (typeof proto.setNodeType !== 'function') return warn('no ReferenceNode.setNodeType'), false;
  const probe = new ReferenceNode(BONES, 'mat4', null, 1) as unknown as Ref;
  if (probe.property !== BONES || !('name' in probe)) return warn('ReferenceNode has no property or name'), false;
  const setNodeType = proto.setNodeType;
  proto.setNodeType = function (this: Ref, type: string) {
    if (this.name === null && this.property === BONES) this.name = SKIN_BONES;
    setNodeType.call(this, type);
  };
  proto.__skinBones = true;
  return true;
}

/** True when the patch is in place (it applies itself on import). */
export const skinningPatched = apply();
