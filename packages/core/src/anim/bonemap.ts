import type { Object3D } from 'three';
import { FINGERS, FINGER_SEGMENTS, HUMANOID_WITH_FINGERS } from '../skeleton';

/** Canonical bone name -> source node name. */
export type BoneMap = Record<string, string>;

export interface BoneMapResult {
  map: BoneMap;
  family: 'rigforge' | 'mixamo' | 'cmu' | 'unreal' | 'vroid' | 'generic';
  missing: string[];
}

const REQUIRED = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/** Lowercases, strips namespaces (mixamorig:, Armature|) and punctuation. */
export function normalizeBoneName(name: string): string {
  let n = name;
  const colon = n.lastIndexOf(':');
  if (colon >= 0) n = n.slice(colon + 1);
  const bar = n.lastIndexOf('|');
  if (bar >= 0) n = n.slice(bar + 1);
  n = n.toLowerCase().replace(/^mixamorig\d*/, '').replace(/[^a-z0-9]/g, '');
  n = n.replace(/^(bip0*1|def|character1|armature)/, '');
  return n;
}

type Dict = Record<string, string[]>;

const MIXAMO: Dict = (() => {
  const d: Dict = { hips: ['hips'], spine: ['spine'], chest: ['spine1'], upperChest: ['spine2'], neck: ['neck'], head: ['head'] };
  for (const [side, s] of [['left', 'left'], ['right', 'right']] as const) {
    d[`${side}Shoulder`] = [`${s}shoulder`];
    d[`${side}UpperArm`] = [`${s}arm`];
    d[`${side}LowerArm`] = [`${s}forearm`];
    d[`${side}Hand`] = [`${s}hand`];
    d[`${side}UpperLeg`] = [`${s}upleg`];
    d[`${side}LowerLeg`] = [`${s}leg`];
    d[`${side}Foot`] = [`${s}foot`];
    d[`${side}Toes`] = [`${s}toebase`];
    const names: Record<string, string> = { Thumb: 'thumb', Index: 'index', Middle: 'middle', Ring: 'ring', Little: 'pinky' };
    for (const f of FINGERS) FINGER_SEGMENTS[f].forEach((seg, i) => (d[`${side}${f}${seg}`] = [`${s}hand${names[f]}${i + 1}`]));
  }
  return d;
})();

const CMU: Dict = (() => {
  const d: Dict = { hips: ['hips'], spine: ['lowerback'], chest: ['spine'], upperChest: ['spine1'], neck: ['neck'], head: ['head'] };
  for (const s of ['left', 'right'] as const) {
    d[`${s}Shoulder`] = [`${s}shoulder`];
    d[`${s}UpperArm`] = [`${s}arm`];
    d[`${s}LowerArm`] = [`${s}forearm`];
    d[`${s}Hand`] = [`${s}hand`];
    d[`${s}UpperLeg`] = [`${s}upleg`];
    d[`${s}LowerLeg`] = [`${s}leg`];
    d[`${s}Foot`] = [`${s}foot`];
    d[`${s}Toes`] = [`${s}toebase`];
  }
  return d;
})();

const UNREAL: Dict = (() => {
  const d: Dict = {
    hips: ['pelvis'], spine: ['spine01'], chest: ['spine02'], upperChest: ['spine03'], neck: ['neck01'], head: ['head'],
  };
  for (const [s, x] of [['left', 'l'], ['right', 'r']] as const) {
    d[`${s}Shoulder`] = [`clavicle${x}`];
    d[`${s}UpperArm`] = [`upperarm${x}`];
    d[`${s}LowerArm`] = [`lowerarm${x}`];
    d[`${s}Hand`] = [`hand${x}`];
    d[`${s}UpperLeg`] = [`thigh${x}`];
    d[`${s}LowerLeg`] = [`calf${x}`];
    d[`${s}Foot`] = [`foot${x}`];
    d[`${s}Toes`] = [`ball${x}`];
    const names: Record<string, string> = { Thumb: 'thumb', Index: 'index', Middle: 'middle', Ring: 'ring', Little: 'pinky' };
    for (const f of FINGERS) FINGER_SEGMENTS[f].forEach((seg, i) => (d[`${s}${f}${seg}`] = [`${names[f]}0${i + 1}${x}`]));
  }
  return d;
})();

const CANONICAL: Dict = Object.fromEntries(HUMANOID_WITH_FINGERS.map((b) => [b.name, [b.name.toLowerCase()]]));

const VROID: Dict = (() => {
  // J_Bip_C_Hips, J_Bip_L_UpperArm, J_Bip_L_Index1 ... -> normalized "jbipchips", "jbiplupperarm"
  const d: Dict = {
    hips: ['jbipchips'], spine: ['jbipcspine'], chest: ['jbipcchest'], upperChest: ['jbipcupperchest'],
    neck: ['jbipcneck'], head: ['jbipchead'],
  };
  for (const [s, x] of [['left', 'l'], ['right', 'r']] as const) {
    d[`${s}Shoulder`] = [`jbip${x}shoulder`];
    d[`${s}UpperArm`] = [`jbip${x}upperarm`];
    d[`${s}LowerArm`] = [`jbip${x}lowerarm`];
    d[`${s}Hand`] = [`jbip${x}hand`];
    d[`${s}UpperLeg`] = [`jbip${x}upperleg`];
    d[`${s}LowerLeg`] = [`jbip${x}lowerleg`];
    d[`${s}Foot`] = [`jbip${x}foot`];
    d[`${s}Toes`] = [`jbip${x}toebase`];
    for (const f of FINGERS) FINGER_SEGMENTS[f].forEach((seg, i) => (d[`${s}${f}${seg}`] = [`jbip${x}${f.toLowerCase()}${i + 1}`]));
  }
  return d;
})();

/** Generic keyword rules for unknown naming schemes: [canonical suffix, regex on the side-stripped name]. */
const GENERIC: Array<[string, RegExp]> = [
  ['Shoulder', /(shoulder|clavicle|collar)/],
  ['UpperArm', /(upperarm|uparm|humerus|^arm$|arm1$|armupper)/],
  ['LowerArm', /(forearm|lowerarm|elbow|arm2$|armlower)/],
  ['Hand', /(hand$|wrist|^hand)/],
  ['UpperLeg', /(thigh|upleg|upperleg|femur|^leg1$|legupper)/],
  ['LowerLeg', /(calf|shin|lowerleg|knee|^leg$|^leg2$|leglower)/],
  ['Foot', /(foot$|ankle|^foot)/],
  ['Toes', /(toe|ball)/],
];

function sideOf(raw: string): { side: 'left' | 'right' | null; rest: string } {
  const n = raw.toLowerCase();
  const tests: Array<[RegExp, 'left' | 'right']> = [
    [/(^|[^a-z])left|left($|[^a-z])|^left/, 'left'],
    [/(^|[^a-z])right|right($|[^a-z])|^right/, 'right'],
    [/(^|[_.\s-])l([_.\s-]|$)|^l[A-Z_.]|[_.]l$/, 'left'],
    [/(^|[_.\s-])r([_.\s-]|$)|^r[A-Z_.]|[_.]r$/, 'right'],
  ];
  for (const [re, side] of tests) if (re.test(n) || re.test(raw)) {
    const rest = normalizeBoneName(raw).replace(/left|right/, '').replace(/^l(?=[a-z])|l$/, '').replace(/^r(?=[a-z])|r$/, '');
    return { side, rest };
  }
  return { side: null, rest: normalizeBoneName(raw) };
}

/**
 * Maps a skeleton's bones to the canonical humanoid. Tries known naming schemes
 * first, then keyword heuristics, and finally resolves the spine chain from the
 * hierarchy between hips and neck.
 */
export function autoMapBones(root: Object3D): BoneMapResult {
  const nodes: Object3D[] = [];
  root.traverse((o) => {
    if ((o as any).isBone || o.type === 'Bone' || o.type === 'Object3D' || o.type === 'Group') nodes.push(o);
  });
  const byNorm = new Map<string, Object3D>();
  for (const o of nodes) if (o.name && !byNorm.has(normalizeBoneName(o.name))) byNorm.set(normalizeBoneName(o.name), o);

  const families: Array<[BoneMapResult['family'], Dict]> = [
    ['rigforge', CANONICAL],
    ['vroid', VROID],
    ['unreal', UNREAL],
    ['cmu', CMU],
    ['mixamo', MIXAMO],
  ];
  let bestFamily: BoneMapResult['family'] = 'generic';
  let best: BoneMap = {};
  for (const [family, dict] of families) {
    const map: BoneMap = {};
    for (const [canon, names] of Object.entries(dict)) {
      for (const n of names) {
        const node = byNorm.get(n);
        if (node) { map[canon] = node.name; break; }
      }
    }
    // CMU and Mixamo share most names; LowerBack is the CMU tell.
    if (family === 'cmu' && !byNorm.has('lowerback')) continue;
    if (Object.keys(map).length > Object.keys(best).length) { best = map; bestFamily = family; }
  }

  const map: BoneMap = { ...best };
  const used = new Set(Object.values(map));

  // Keyword heuristics for anything still missing.
  if (!map.hips) {
    const h = nodes.find((o) => /hip|pelvis/.test(normalizeBoneName(o.name)) && !/(left|right|thigh)/i.test(o.name));
    if (h) { map.hips = h.name; used.add(h.name); }
  }
  for (const key of ['head', 'neck'] as const) {
    if (map[key]) continue;
    const node = nodes.find((o) => !used.has(o.name) && normalizeBoneName(o.name).startsWith(key) && !/end|top|nub/.test(normalizeBoneName(o.name)));
    if (node) { map[key] = node.name; used.add(node.name); }
  }
  for (const o of nodes) {
    if (used.has(o.name) || !o.name) continue;
    const { side, rest } = sideOf(o.name);
    if (!side) continue;
    if (/end|nub|tip|twist|roll|ik|pole|target/.test(rest)) continue;
    for (const [suffix, re] of GENERIC) {
      const canon = `${side}${suffix}`;
      if (map[canon]) continue;
      if (re.test(rest)) {
        map[canon] = o.name;
        used.add(o.name);
        break;
      }
    }
  }

  // Spine chain from the hierarchy: bones strictly between hips and neck (or head).
  const hips = map.hips ? root.getObjectByName(map.hips) : undefined;
  const top = map.neck ? root.getObjectByName(map.neck) : map.head ? root.getObjectByName(map.head) : undefined;
  if (hips && top && (!map.spine || (bestFamily === 'generic'))) {
    const chain: Object3D[] = [];
    let p = top.parent;
    while (p && p !== hips) {
      chain.unshift(p);
      p = p.parent;
    }
    if (p === hips && chain.length) {
      delete map.spine; delete map.chest; delete map.upperChest;
      map.spine = chain[0].name;
      if (chain.length >= 2) map.upperChest = chain[chain.length - 1].name;
      if (chain.length >= 3) map.chest = chain[Math.floor(chain.length / 2)].name;
    }
  }

  const missing = REQUIRED.filter((r) => !map[r]);
  return { map, family: bestFamily, missing };
}
