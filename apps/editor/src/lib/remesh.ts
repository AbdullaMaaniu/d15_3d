import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
  type Texture,
} from 'three';
import {
  arraysToGeometry,
  decodeFaceSizes,
  geometryToArrays,
  toOBJ,
  quadOutputToArrays,
  type BakeMaterial,
  type BakeSource,
  type BakeTexture,
  type MeshArrays,
  type PreparedMesh,
  type Topology,
} from '@rigforge/core';
import { remeshQuads, remeshTriangles } from './rigClient';

export interface RemeshSettings {
  /** Target faces; null keeps the original mesh. */
  target: number | null;
  topology: Topology;
  /** Baked texture size for quads (new UVs). */
  textureSize: 1024 | 2048 | 4096;
}

export interface RemeshInfo {
  topology: Topology;
  target: number;
  faces: number;
  quads: number;
  triangles: number;
  charts: number;
  textureSize: number | null;
  seconds: number;
  /** Maps the result can't carry over (e.g. normal maps with new UVs). */
  dropped: string[];
}

/** RGBA8 pixels of a texture's image (drawn through a canvas when needed). */
function pixels(tex: Texture): BakeTexture | null {
  const img = tex.image as (CanvasImageSource & { width: number; height: number; data?: ArrayLike<number> }) | undefined;
  if (!img || !img.width || !img.height) return null;
  const { width, height } = img;
  let data: Uint8Array;
  if (img.data && img.data.length === width * height * 4) {
    data = Uint8Array.from(img.data);
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    data = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
  }
  return { width, height, data, flipY: tex.flipY, repeat: tex.wrapS === RepeatWrapping };
}

const srgb = (c: Color) => c.clone().convertLinearToSRGB();

/** What the baker needs from the source mesh and its materials; null when there's nothing to bake. */
function bakeSource(prepared: PreparedMesh, src: MeshArrays): { source: BakeSource | null; dropped: string[] } {
  const textures: BakeTexture[] = [];
  const index = new Map<Texture, number>();
  const texIndex = (t: Texture | null | undefined) => {
    if (!t) return -1;
    if (!index.has(t)) {
      const p = pixels(t);
      index.set(t, p ? textures.push(p) - 1 : -1);
    }
    return index.get(t)!;
  };
  const dropped = new Set<string>();
  const mats = prepared.materials as Array<Material & Partial<MeshStandardMaterial>>;
  const materials: BakeMaterial[] = mats.map((m) => {
    const c = srgb(m.color ?? new Color(1, 1, 1));
    const e = srgb(m.emissive ?? new Color(0, 0, 0)).multiplyScalar(m.emissiveIntensity ?? 1);
    if (m.normalMap) dropped.add('normal map');
    if (m.aoMap) dropped.add('ambient occlusion');
    return {
      baseTexture: texIndex(m.map),
      baseColor: [c.r, c.g, c.b, m.opacity ?? 1],
      mrTexture: texIndex(m.roughnessMap ?? m.metalnessMap),
      metalness: m.metalness ?? 0,
      roughness: m.roughness ?? 1,
      emissiveTexture: texIndex(m.emissiveMap),
      emissive: [e.r, e.g, e.b],
    };
  });
  const materialOfTriangle = new Uint32Array(src.index.length / 3);
  for (const g of src.groups) materialOfTriangle.fill(g.materialIndex, g.start / 3, (g.start + g.count) / 3);
  const vertexColors = mats.some((m) => m.vertexColors) && src.colors;
  let colors: Float32Array | null = null;
  if (vertexColors && src.colors) {
    const n = src.positions.length / 3;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) colors.set([src.colors[i * 3], src.colors[i * 3 + 1], src.colors[i * 3 + 2], 1], i * 4);
  }
  const metallicRoughness = mats.some((m) => m.roughnessMap || m.metalnessMap) || new Set(mats.map((m) => `${m.metalness},${m.roughness}`)).size > 1;
  const emissive = mats.some((m) => m.emissiveMap || (m.emissive && m.emissive.getHex() !== 0));
  const anything = textures.length > 0 || colors || mats.length > 1 || metallicRoughness || emissive;
  if (!anything) return { source: null, dropped: [...dropped] };
  return {
    source: { positions: src.positions, uvs: src.uvs, colors, index: src.index, materialOfTriangle, textures, materials, metallicRoughness, emissive },
    dropped: [...dropped],
  };
}

function canvasTexture(data: Uint8Array, size: number, color: boolean): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const image = new ImageData(size, size);
  image.data.set(data);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const t = new CanvasTexture(canvas);
  t.flipY = false; // glTF convention: v = 0 at the top
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Remeshes the prepared (imported) mesh in the rig worker. */
export async function remeshPrepared(prepared: PreparedMesh, settings: RemeshSettings & { target: number }, onStage: (s: string) => void): Promise<{ prepared: PreparedMesh; info: RemeshInfo }> {
  const t0 = performance.now();
  const src = geometryToArrays(prepared.geometry);
  if (settings.topology === 'triangles') {
    onStage(`Simplifying to ${settings.target.toLocaleString()} triangles…`);
    const out = await remeshTriangles(src, settings.target);
    const geometry = arraysToGeometry(out);
    const tris = out.index.length / 3;
    return {
      prepared: { geometry, materials: prepared.materials },
      info: { topology: 'triangles', target: settings.target, faces: tris, quads: 0, triangles: tris, charts: 0, textureSize: null, seconds: (performance.now() - t0) / 1000, dropped: [] },
    };
  }
  onStage('Reading textures…');
  const { source, dropped } = bakeSource(prepared, src);
  onStage(`Remeshing to ~${settings.target.toLocaleString()} quads, unwrapping UVs${source ? ' and baking textures' : ''}…`);
  const size = settings.textureSize;
  const out = await remeshQuads({
    positions: src.positions,
    index: src.index,
    targetFaces: settings.target,
    resolution: size,
    padding: Math.max(2, size / 512),
    bake: source,
  });
  const arrays = quadOutputToArrays(out);
  const geometry = arraysToGeometry(arrays);
  const first = prepared.materials[0] as MeshStandardMaterial;
  let material: MeshStandardMaterial;
  if (out.baked) {
    const b = out.baked;
    const mr = b.metallicRoughness ? canvasTexture(b.metallicRoughness, size, false) : null;
    material = new MeshStandardMaterial({
      name: 'remeshed',
      map: canvasTexture(b.base, size, true),
      roughnessMap: mr,
      metalnessMap: mr,
      metalness: mr ? 1 : first.metalness ?? 0,
      roughness: mr ? 1 : first.roughness ?? 1,
      emissiveMap: b.emissive ? canvasTexture(b.emissive, size, true) : null,
      emissive: b.emissive ? new Color(1, 1, 1) : new Color(0, 0, 0),
      transparent: prepared.materials.some((m) => m.transparent),
      alphaTest: first.alphaTest ?? 0,
      side: first.side,
    });
  } else {
    material = (first.clone() as MeshStandardMaterial);
  }
  const quads = out.sizes.filter((s) => s === 4).length;
  return {
    prepared: { geometry, materials: [material] },
    info: {
      topology: 'quads',
      target: settings.target,
      faces: out.sizes.length,
      quads,
      triangles: arrays.index.length / 3,
      charts: out.charts,
      textureSize: out.baked ? size : null,
      seconds: (performance.now() - t0) / 1000,
      dropped,
    },
  };
}

/** Polygon edges for a wireframe: quads (stored as triangle pairs) without their diagonal. */
export function polygonEdges(g: import('three').BufferGeometry): Uint32Array {
  const index = g.index ? g.index.array : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
  const sizes = decodeFaceSizes(g);
  const edges: number[] = [];
  const triCount = index.length / 3;
  let t = 0;
  for (let f = 0; t < triCount; f++) {
    const a = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]];
    if (sizes && sizes[f] === 4 && t + 1 < triCount) {
      const b = [index[t * 3 + 3], index[t * 3 + 4], index[t * 3 + 5]];
      // Each triangle's edges, minus the shared diagonal.
      for (const tri of [a, b]) {
        const other = tri === a ? b : a;
        for (let k = 0; k < 3; k++) {
          const [p, q] = [tri[k], tri[(k + 1) % 3]];
          if (!(other.includes(p) && other.includes(q))) edges.push(p, q);
        }
      }
      t += 2;
    } else {
      edges.push(a[0], a[1], a[1], a[2], a[2], a[0]);
      t += 1;
    }
  }
  return new Uint32Array(edges);
}

/** Zip with an OBJ (quads kept as quads), its MTL and the base colour texture as PNG. */
export async function remeshedOBJZip(prepared: PreparedMesh, name: string): Promise<Blob> {
  const { zipSync, strToU8 } = await import('three/examples/jsm/libs/fflate.module.js');
  const arrays = geometryToArrays(prepared.geometry);
  arrays.faceSizes = decodeFaceSizes(prepared.geometry) ?? undefined;
  const files: Record<string, Uint8Array> = {};
  const mat = prepared.materials[0] as MeshStandardMaterial;
  let mtl = `newmtl material0\nKd ${mat.color?.r ?? 1} ${mat.color?.g ?? 1} ${mat.color?.b ?? 1}\n`;
  const img = mat.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (img?.width) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    const png = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    files[`${name}.png`] = new Uint8Array(await png.arrayBuffer());
    mtl = `newmtl material0\nKd 1 1 1\nmap_Kd ${name}.png\n`;
  }
  // OBJ's v points up from the image bottom: glTF-style UVs (flipY = false) are flipped, three's default ones aren't.
  files[`${name}.obj`] = strToU8(toOBJ(arrays, `${name}.mtl`, mat.map ? mat.map.flipY === false : true));
  files[`${name}.mtl`] = strToU8(mtl);
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}
