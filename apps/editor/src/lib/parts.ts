import { Color, MeshStandardMaterial, type Material, type Mesh, type Texture } from 'three';
import { decodeFaceSizes, regionContext, type RegionContext, type RegionDef, type SampledTexture } from '@rigforge/core';
import { setMaterialColor } from '@rigforge/three';
import { pixels } from './remesh';

/** Parts as the editor keeps them: regions per triangle plus preview colours. */
export interface PartsState {
  defs: RegionDef[];
  /** Region per triangle, in the rig mesh's original triangle order. */
  faces: Uint8Array;
  /** Preview recolour per region (sRGB hex), or null for the original. Not exported. */
  tints: Array<string | null>;
}

/** Triangle colours, areas and neighbours of the character's mesh (original triangle order). */
export function buildRegionContext(mesh: Mesh): RegionContext {
  const g = mesh.geometry;
  const orig = mesh.userData.rfOriginal as { index: Uint32Array; groups: Array<{ start: number; count: number; materialIndex: number }>; material: Material | Material[]; faceSizes?: string } | undefined;
  const index = orig?.index ?? (g.index!.array as ArrayLike<number>);
  const groups = orig?.groups ?? g.groups;
  const material = orig?.material ?? mesh.material;
  const mats = (Array.isArray(material) ? material : [material]) as Array<Material & { color?: Color; map?: Texture | null; vertexColors?: boolean }>;
  const T = index.length / 3;
  const materialOfTriangle = new Uint16Array(T);
  for (const x of groups) materialOfTriangle.fill(x.materialIndex ?? 0, x.start / 3, (x.start + x.count) / 3);
  const cache = new Map<Texture, SampledTexture | null>();
  const tex = (t: Texture | null | undefined) => {
    if (!t) return null;
    if (!cache.has(t)) {
      const p = pixels(t);
      t.updateMatrix();
      cache.set(t, p && { ...p, transform: Array.from(t.matrix.elements) });
    }
    return cache.get(t)!;
  };
  const faceSizes = orig?.faceSizes !== undefined ? decodeFaceSizes({ userData: { faceSizes: orig.faceSizes } } as never) : decodeFaceSizes(g);
  return regionContext({
    positions: g.attributes.position.array as ArrayLike<number>,
    index,
    uvs: (g.attributes.uv?.array as ArrayLike<number>) ?? null,
    colors: (g.attributes.color?.array as ArrayLike<number>) ?? null,
    materialOfTriangle,
    materials: mats.map((m) => {
      const c = (m.color ?? new Color(1, 1, 1)).clone().convertLinearToSRGB();
      return { color: [c.r, c.g, c.b] as [number, number, number], texture: tex(m.map), vertexColors: !!m.vertexColors };
    }),
    faceSizes,
  });
}

const overlayCache = new WeakMap<Material, Map<string, Material>>();
const previewCache = new WeakMap<Material, Material>();

function regionIndex(m: Material, defs: RegionDef[]): number {
  const name = (m.userData?.rigforge as { region?: { name: string } } | undefined)?.region?.name;
  return defs.findIndex((d) => d.name === name);
}

/**
 * Materials for the Parts step: 'parts' shows each region in its colour over
 * the texture; 'colours' shows the preview recolours as the game will.
 */
export function partsDisplayMaterials(base: Material[], parts: PartsState, view: 'parts' | 'colours', highlight: number | null): Material[] {
  return base.map((m) => {
    const r = regionIndex(m, parts.defs);
    if (r < 0) return m;
    if (view === 'colours') {
      let p = previewCache.get(m);
      if (!p) {
        p = m.clone();
        previewCache.set(m, p);
      }
      const baseColor = (m.userData.rigforge as { region: { baseColor: string } }).region.baseColor;
      setMaterialColor(p, baseColor, parts.tints[r] ?? null);
      return p;
    }
    const def = parts.defs[r];
    const key = `${def.color}|${highlight === r ? 'hi' : ''}`;
    let byKey = overlayCache.get(m);
    if (!byKey) overlayCache.set(m, (byKey = new Map()));
    let o = byKey.get(key);
    if (!o) {
      const src = m as MeshStandardMaterial;
      const color = new Color(def.color);
      o = new MeshStandardMaterial({
        map: src.map ?? null,
        color: color.clone().lerp(new Color(1, 1, 1), 0.35),
        emissive: color,
        emissiveIntensity: highlight === r ? 0.75 : 0.35,
        roughness: 0.8,
        metalness: 0,
        side: src.side,
        transparent: src.transparent,
        alphaTest: src.alphaTest,
        vertexColors: src.vertexColors,
      });
      byKey.set(key, o);
    }
    return o;
  });
}
