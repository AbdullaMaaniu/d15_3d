import { BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute, type Material } from 'three';
import { separateGarments, type GarmentOptions, type GarmentSeparation, type JointMap, type RegionSet, type RiggedCharacter } from '@rigforge/core';
import { garmentRegions, useStore } from '../store';

interface Original {
  index: Uint32Array;
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  material: Material | Material[];
}

/** The character mesh as imported: triangles in the regions' order, and its materials per triangle. */
function source(built: RiggedCharacter) {
  const mesh = built.mesh;
  const g = mesh.geometry;
  const orig = mesh.userData.rfOriginal as Original | undefined;
  const index = orig?.index ?? (g.index!.array as ArrayLike<number>);
  const groups = orig?.groups ?? g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex ?? 0 }));
  const material = orig?.material ?? mesh.material;
  const T = index.length / 3;
  const materialOfTriangle = new Uint16Array(T);
  for (const x of groups) materialOfTriangle.fill(x.materialIndex, x.start / 3, (x.start + x.count) / 3);
  return { index, materialOfTriangle, materials: Array.isArray(material) ? material : [material] };
}

/** Cuts the character into garment pieces (bind pose, rig space). */
export function separateCharacter(built: RiggedCharacter, joints: JointMap | null, regions: RegionSet, options: GarmentOptions): GarmentSeparation {
  const g = built.mesh.geometry;
  const { index, materialOfTriangle } = source(built);
  return separateGarments(
    {
      positions: g.attributes.position.array as ArrayLike<number>,
      normals: (g.attributes.normal?.array as ArrayLike<number>) ?? null,
      uvs: (g.attributes.uv?.array as ArrayLike<number>) ?? null,
      index,
      skinIndex: g.attributes.skinIndex.array as ArrayLike<number>,
      skinWeight: g.attributes.skinWeight.array as ArrayLike<number>,
      bones: built.skeleton.bones.map((b) => b.name),
      materialOfTriangle,
      regions,
      joints,
    },
    options,
  );
}

/**
 * Each garment as a skinned mesh on the character's skeleton, with the
 * character's own materials (double-sided: a garment is a single surface, so
 * its inside shows at the openings). Vertex colours are carried over through
 * the pieces' source vertices.
 */
export function buildGarmentMeshes(built: RiggedCharacter, sep: GarmentSeparation): SkinnedMesh[] {
  const g = built.mesh.geometry;
  const { materials } = source(built);
  const colors = g.attributes.color?.array as ArrayLike<number> | undefined;
  const itemSize = g.attributes.color?.itemSize ?? 3;
  return sep.pieces.map((p) => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(p.positions, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(p.normals, 3));
    if (p.uvs) geo.setAttribute('uv', new Float32BufferAttribute(p.uvs, 2));
    if (colors) {
      const V = p.positions.length / 3;
      const out = new Float32Array(V * itemSize);
      for (let v = 0; v < V; v++) {
        for (let k = 0; k < 3; k++) {
          const w = p.sourceWeight[v * 3 + k];
          if (!w) continue;
          const s = p.source[v * 3 + k];
          for (let c = 0; c < itemSize; c++) out[v * itemSize + c] += colors[s * itemSize + c] * w;
        }
      }
      geo.setAttribute('color', new Float32BufferAttribute(out, itemSize));
    }
    geo.setAttribute('skinIndex', new Uint16BufferAttribute(p.skinIndex, 4));
    geo.setAttribute('skinWeight', new Float32BufferAttribute(p.skinWeight, 4));
    geo.setIndex(new Uint32BufferAttribute(p.index, 1));
    for (const x of p.groups) geo.addGroup(x.start, x.count, x.materialIndex);
    const mats = materials.map((m) => {
      const c = m.clone();
      c.side = DoubleSide;
      return c;
    });
    const mesh = new SkinnedMesh(geo, mats);
    mesh.name = p.name;
    mesh.frustumCulled = false;
    mesh.userData.rfGarment = { kind: p.kind, region: p.region };
    mesh.bind(built.skeleton, new Matrix4());
    return mesh;
  });
}

/**
 * The separated garments for export, from the current project: meshes on the
 * character's skeleton (they replace its own mesh) and the separation itself,
 * whose `headCut` and pieces give the body's hidden triangles through
 * `coveredBodyTriangles`. Null when separation is off or not possible.
 */
export function garmentsForExport(): { meshes: SkinnedMesh[]; separation: GarmentSeparation } | null {
  const { character, joints, rigType, garments } = useStore.getState();
  const built = character?.built;
  if (!built || rigType !== 'humanoid' || !garments.separate) return null;
  const found = garmentRegions();
  if (!found) return null;
  const separation = separateCharacter(built, joints, found.regions, { keepHead: garments.keepHead });
  return { meshes: buildGarmentMeshes(built, separation), separation };
}
