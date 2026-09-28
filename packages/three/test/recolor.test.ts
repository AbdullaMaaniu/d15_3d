import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Material } from 'three';
import { Character, listRegions, setRegionColor } from '../src/index';

// Uniforms hold raw sRGB components (not a colour-managed Color), so compare those.
const hex = (c: any) => c.toArray().map((x: number) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');

function character() {
  const mat = (name: string, baseColor: string) => {
    const m = new MeshStandardMaterial({ name });
    m.userData = { rigforge: { region: { name, baseColor } } };
    return m;
  };
  const g = new BoxGeometry();
  g.addGroup(0, 18, 0);
  g.addGroup(18, 18, 1);
  const mesh = new Mesh(g, [mat('Hair', '#2a1a10'), mat('Top', '#f0f0f0')]);
  const root = new Group();
  root.add(mesh);
  return { root, mesh };
}

function compile(m: Material) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '', fragmentShader: 'void main() {\n#include <color_fragment>\n}' };
  m.onBeforeCompile(shader as any, null as any);
  return shader;
}

describe('region recolouring', () => {
  it('lists regions and recolours one, keeping the others', () => {
    const { root, mesh } = character();
    const originals = mesh.material as Material[];
    expect(listRegions(root).map((r) => r.name)).toEqual(['Hair', 'Top']);
    expect(setRegionColor(root, 'top', '#ff0000')).toBe(true);
    const mats = mesh.material as Material[];
    // This character got its own materials; the file's stay untouched.
    expect(mats[1]).not.toBe(originals[1]);
    const top = compile(mats[1]);
    expect(top.fragmentShader).toContain('diffuseColor.rgb = rfRecolor( diffuseColor.rgb );');
    expect(top.fragmentShader).toContain('uniform vec3 rfTarget;');
    expect((top.uniforms.rfAmount.value as number)).toBe(1);
    expect((top.uniforms.rfTarget.value as any).toArray().map((x: number) => +x.toFixed(3))).toEqual([1, 0, 0]);
    // Base colour is the region's own average, in sRGB components.
    expect(hex(top.uniforms.rfBase.value)).toBe('f0f0f0');
    // Hair untouched.
    expect(compile(mats[0]).fragmentShader).not.toContain('rfRecolor');
    // Reset.
    setRegionColor(root, 'Top', null);
    expect(compile(mats[1]).uniforms.rfAmount.value).toBe(0);
    expect(setRegionColor(root, 'Hat', '#00ff00')).toBe(false);
  });

  it('keeps colours separate between characters from the same file', () => {
    const { root } = character();
    const a = root.clone(true), b = root.clone(true);
    const Character_ = Character as any;
    const ca = new Character_(a, []), cb = new Character_(b, []);
    expect(ca.regions).toEqual(['Hair', 'Top']);
    ca.setColor('Hair', '#ffd700');
    cb.setColor('Hair', '#0000ff');
    const ha = ((a.children[0] as Mesh).material as Material[])[0], hb = ((b.children[0] as Mesh).material as Material[])[0];
    expect(ha).not.toBe(hb);
    expect(hex(compile(ha).uniforms.rfTarget.value)).toBe('ffd700');
    expect(hex(compile(hb).uniforms.rfTarget.value)).toBe('0000ff');
  });
});
