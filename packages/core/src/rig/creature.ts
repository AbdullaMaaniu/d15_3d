import type { BoneDef, JointMap } from '../skeleton';

type V3 = [number, number, number];

export interface CreatureBone {
  name: string;
  parent: string | null;
}

/** Bone definitions for a free-form skeleton (parents first; the first child is the primary one). */
export function creatureDefs(bones: CreatureBone[]): BoneDef[] {
  const out: BoneDef[] = [];
  const done = new Set<string>();
  const byName = new Map(bones.map((b) => [b.name, b]));
  const visit = (b: CreatureBone, depth = 0) => {
    if (done.has(b.name) || depth > bones.length) return;
    if (b.parent && byName.has(b.parent)) visit(byName.get(b.parent)!, depth + 1);
    done.add(b.name);
    const firstChild = bones.find((c) => c.parent === b.name)?.name ?? null;
    const side = b.name.startsWith('left') ? 'left' : b.name.startsWith('right') ? 'right' : null;
    out.push({ name: b.name, parent: b.parent && byName.has(b.parent) ? b.parent : null, primaryChild: firstChild, side, isFinger: false });
  };
  bones.forEach((b) => visit(b));
  return out;
}

/** Tails for leaf bones: continue the parent → joint direction by half the parent bone's length. */
export function autoTails(defs: readonly BoneDef[], joints: Record<string, V3>, existing: Record<string, V3> = {}): Record<string, V3> {
  const tails: Record<string, V3> = {};
  for (const d of defs) {
    if (d.primaryChild) continue;
    if (existing[d.name]) {
      tails[d.name] = existing[d.name];
      continue;
    }
    const p = joints[d.name];
    const parent = d.parent ? joints[d.parent] : undefined;
    if (!p) continue;
    if (!parent) {
      tails[d.name] = [p[0], p[1] + 0.1, p[2]];
      continue;
    }
    const dir: V3 = [p[0] - parent[0], p[1] - parent[1], p[2] - parent[2]];
    tails[d.name] = [p[0] + dir[0] * 0.5, p[1] + dir[1] * 0.5, p[2] + dir[2] * 0.5];
  }
  return tails;
}

/** The chain starting at `start`, following first children, e.g. a tail or tentacle. */
export function boneChain(defs: readonly BoneDef[], start: string): string[] {
  const out: string[] = [];
  let cur: string | null = start;
  const byName = new Map(defs.map((d) => [d.name, d]));
  while (cur && byName.has(cur) && !out.includes(cur)) {
    out.push(cur);
    cur = byName.get(cur)!.primaryChild;
  }
  return out;
}

/** Mirrors a joint subtree across the x = centerX plane, returning new bones and positions. */
export function mirrorSubtree(bones: CreatureBone[], joints: Record<string, V3>, root: string, centerX = 0): { bones: CreatureBone[]; joints: Record<string, V3> } {
  const rename = (n: string) =>
    n.startsWith('left') ? 'right' + n.slice(4) : n.startsWith('right') ? 'left' + n.slice(5) : `${n}_mirror`;
  const subtree: string[] = [];
  const collect = (n: string) => {
    subtree.push(n);
    bones.filter((b) => b.parent === n).forEach((b) => collect(b.name));
  };
  collect(root);
  const names = new Set(bones.map((b) => b.name));
  const newBones: CreatureBone[] = [];
  const newJoints: Record<string, V3> = {};
  for (const n of subtree) {
    let m = rename(n);
    while (names.has(m)) m = `${m}_`;
    names.add(m);
    const b = bones.find((x) => x.name === n)!;
    const parent = n === root ? b.parent : rename(b.parent!);
    newBones.push({ name: m, parent });
    const p = joints[n];
    if (p) newJoints[m] = [2 * centerX - p[0], p[1], p[2]];
  }
  // Fix renamed parents that got de-duplicated.
  const map = new Map(subtree.map((n, i) => [rename(n), newBones[i].name]));
  for (const b of newBones) if (b.parent && map.has(b.parent) && b !== newBones[0]) b.parent = map.get(b.parent)!;
  return { bones: newBones, joints: newJoints };
}

export function isLeaf(defs: readonly BoneDef[], name: string): boolean {
  return !defs.some((d) => d.parent === name);
}

export type { JointMap };
