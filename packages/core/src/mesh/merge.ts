import {
  BufferAttribute,
  BufferGeometry,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type Texture,
} from 'three';

export interface PreparedMesh {
  /** Single indexed geometry (position, normal, uv[, color]) with one group per material. */
  geometry: BufferGeometry;
  materials: Material[];
}

/**
 * Bakes every mesh under `root` into one indexed geometry in world space so it can
 * become a single SkinnedMesh. Materials are preserved as geometry groups and are
 * converted to MeshStandardMaterial (the best supported glTF material in three.js).
 */
export function mergeSceneMeshes(root: Object3D): PreparedMesh {
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && m.geometry?.attributes.position && m.visible !== false) meshes.push(m);
  });
  if (meshes.length === 0) throw new Error('No meshes found in the imported file.');

  const allHaveColor = meshes.every((m) => !!m.geometry.attributes.color);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  const materials: Material[] = [];
  const materialIds = new Map<Material, number>();
  const materialIndexOf = (mat: Material) => {
    let id = materialIds.get(mat);
    if (id === undefined) {
      id = materials.length;
      materials.push(toStandardMaterial(mat));
      materialIds.set(mat, id);
    }
    return id;
  };

  for (const mesh of meshes) {
    let g = mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    }
    g.morphAttributes = {};
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(mesh.matrixWorld);
    const flip = mesh.matrixWorld.determinant() < 0;

    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const uv = g.attributes.uv;
    const col = g.attributes.color;
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
      else uvs.push(0, 0);
      if (allHaveColor) colors.push(col.getX(i), col.getY(i), col.getZ(i));
    }

    const idx = g.index;
    const triCount = idx ? idx.count : pos.count;
    const readIndex = (i: number) => (idx ? idx.getX(i) : i);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const localGroups = g.groups.length ? g.groups : [{ start: 0, count: triCount, materialIndex: 0 }];
    for (const grp of localGroups) {
      const mat = meshMaterials[grp.materialIndex ?? 0] ?? meshMaterials[0];
      const materialIndex = materialIndexOf(mat);
      const start = indices.length;
      const end = Math.min(grp.start + grp.count, triCount);
      for (let i = grp.start; i + 2 < end; i += 3) {
        const a = base + readIndex(i);
        const b = base + readIndex(i + 1);
        const c = base + readIndex(i + 2);
        if (flip) indices.push(a, c, b);
        else indices.push(a, b, c);
      }
      const count = indices.length - start;
      const last = groups[groups.length - 1];
      if (last && last.materialIndex === materialIndex && last.start + last.count === start) last.count += count;
      else if (count > 0) groups.push({ start, count, materialIndex });
    }
    g.dispose();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  if (allHaveColor) geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  for (const grp of groups) geometry.addGroup(grp.start, grp.count, grp.materialIndex);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, materials };
}

type AnyMaterial = Material & {
  color?: { clone(): any };
  map?: Texture | null;
  normalMap?: Texture | null;
  emissive?: { clone(): any };
  emissiveMap?: Texture | null;
  emissiveIntensity?: number;
  aoMap?: Texture | null;
  alphaMap?: Texture | null;
  roughness?: number;
  metalness?: number;
  roughnessMap?: Texture | null;
  metalnessMap?: Texture | null;
  shininess?: number;
  vertexColors?: boolean;
};

/** Converts Phong/Lambert/Basic materials (e.g. from FBX or OBJ) to MeshStandardMaterial. */
export function toStandardMaterial(material: Material): Material {
  const m = material as AnyMaterial;
  if ((material as MeshStandardMaterial).isMeshStandardMaterial) return material;
  const std = new MeshStandardMaterial({
    name: material.name,
    transparent: material.transparent,
    opacity: material.opacity,
    side: material.side,
    alphaTest: material.alphaTest,
    vertexColors: !!m.vertexColors,
  });
  if (m.color) std.color.copy(m.color as any);
  if (m.map) std.map = m.map;
  if (m.normalMap) std.normalMap = m.normalMap;
  if (m.emissive) std.emissive.copy(m.emissive as any);
  if (m.emissiveMap) std.emissiveMap = m.emissiveMap;
  if (m.emissiveIntensity !== undefined) std.emissiveIntensity = m.emissiveIntensity;
  if (m.aoMap) std.aoMap = m.aoMap;
  if (m.alphaMap) std.alphaMap = m.alphaMap;
  if (m.shininess !== undefined) std.roughness = Math.min(1, Math.max(0.2, 1 - Math.sqrt(m.shininess / 100)));
  else std.roughness = 0.8;
  std.metalness = 0;
  return std;
}
