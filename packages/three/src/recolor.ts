import { Color, type ColorRepresentation, type Material, type Mesh, type Object3D } from 'three';

/**
 * Runtime recolouring of RigForge body regions (hair, skin, top, ...).
 *
 * A RigForge export gives every region its own material, tagged in glTF extras
 * with the region's name and average colour. Recolouring swaps the hue and
 * saturation for the new colour and remaps lightness around the region's own
 * average, so the texture's folds, stripes and shading survive — dark hair can
 * go blond, a white shirt red.
 */

export interface RegionInfo {
  name: string;
  /** Average colour of the region in the texture (sRGB hex). */
  baseColor: string;
}

/** The region a material belongs to, if any. */
export function regionOf(material: Material): RegionInfo | null {
  const r = (material.userData?.rigforge as { region?: RegionInfo } | undefined)?.region;
  return r && typeof r.name === 'string' ? r : null;
}

interface Patch {
  target: { value: Color };
  base: { value: Color };
  amount: { value: number };
}
const patched = new WeakMap<Material, Patch>();

const GLSL = /* glsl */ `
uniform vec3 rfTarget;
uniform vec3 rfBase;
uniform float rfAmount;
vec3 rfToSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
vec3 rfToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 rfHSL(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float rfHue(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 rfRGB(vec3 hsl) {
  if (hsl.y < 1e-5) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y, p = 2.0 * hsl.z - q;
  return vec3(rfHue(p, q, hsl.x + 1.0 / 3.0), rfHue(p, q, hsl.x), rfHue(p, q, hsl.x - 1.0 / 3.0));
}
vec3 rfRecolor(vec3 linear) {
  if (rfAmount <= 0.0) return linear;
  vec3 c = rfHSL(rfToSRGB(linear)), t = rfHSL(rfTarget), b = rfHSL(rfBase);
  // Lightness: the region's average maps to the target's; darker and lighter texels keep their place.
  float l = c.z <= b.z ? c.z * t.z / max(b.z, 1e-3) : 1.0 - (1.0 - c.z) * (1.0 - t.z) / max(1.0 - b.z, 1e-3);
  vec3 outc = rfRGB(vec3(t.x, clamp(t.y + (c.y - b.y), 0.0, 1.0), clamp(l, 0.0, 1.0)));
  return mix(linear, rfToLinear(outc), rfAmount);
}
`;

/** Makes a material recolourable (idempotent). Colours are sRGB. */
export function enableRecolor(material: Material, baseColor: ColorRepresentation): Patch {
  const existing = patched.get(material);
  if (existing) return existing;
  // Uniforms hold sRGB components; the shader converts.
  const patch: Patch = { target: { value: srgb(baseColor) }, base: { value: srgb(baseColor) }, amount: { value: 0 } };
  const prevCompile = material.onBeforeCompile.bind(material);
  const prevKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prevCompile(shader, renderer);
    shader.uniforms.rfTarget = patch.target;
    shader.uniforms.rfBase = patch.base;
    shader.uniforms.rfAmount = patch.amount;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${GLSL}\nvoid main() {`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = rfRecolor( diffuseColor.rgb );');
  };
  material.customProgramCacheKey = () => `${prevKey()}|rfRecolor`;
  material.needsUpdate = true;
  patched.set(material, patch);
  return patch;
}

/** sRGB components of a colour (three.js Colors are linear). */
function srgb(c: ColorRepresentation): Color {
  const lin = new Color(c);
  return new Color().setRGB(...(lin.clone().convertLinearToSRGB().toArray() as [number, number, number]));
}

/** Sets a recolourable material's colour; `null` restores the original. */
export function setMaterialColor(material: Material, baseColor: ColorRepresentation, color: ColorRepresentation | null): void {
  const patch = enableRecolor(material, baseColor);
  if (color === null) {
    patch.amount.value = 0;
    return;
  }
  patch.target.value.copy(srgb(color));
  patch.amount.value = 1;
}

const owned = new WeakSet<Mesh>();

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

/** Region names in a loaded character, in file order. */
export function listRegions(root: Object3D): RegionInfo[] {
  const out = new Map<string, RegionInfo>();
  for (const mesh of meshes(root)) {
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const r = regionOf(m);
      if (r && !out.has(r.name)) out.set(r.name, r);
    }
  }
  return [...out.values()];
}

/**
 * Recolours a region (case-insensitive name) of a character; `null` restores it.
 * Materials are cloned per character on first use, so characters cloned from
 * the same file can wear different colours. Returns false if no such region.
 */
export function setRegionColor(root: Object3D, region: string, color: ColorRepresentation | null): boolean {
  const want = region.toLowerCase();
  let found = false;
  for (const mesh of meshes(root)) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!mats.some((m) => regionOf(m)?.name.toLowerCase() === want)) continue;
    if (!owned.has(mesh)) {
      const clones = mats.map((m) => m.clone());
      mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
      owned.add(mesh);
    }
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const r = regionOf(m);
      if (r?.name.toLowerCase() !== want) continue;
      setMaterialColor(m, r.baseColor, color);
      found = true;
    }
  }
  return found;
}
