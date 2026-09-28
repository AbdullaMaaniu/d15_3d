/**
 * Canonical RigForge humanoid skeleton.
 *
 * Bone names follow the VRM 1.0 humanoid specification so exported characters
 * interoperate with the wider three.js / VRM ecosystem. Conventions for the
 * normalized ("rig") space used throughout RigForge:
 *
 *  - Y is up, the character faces +Z, so the character's LEFT side is +X.
 *  - Units are meters, feet rest on y = 0.
 *  - Every bone's bind (rest) rotation is identity: bone frames are world-aligned.
 */

export type Side = 'left' | 'right';

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
export type Finger = (typeof FINGERS)[number];

export const FINGER_SEGMENTS: Record<Finger, readonly [string, string, string]> = {
  Thumb: ['Metacarpal', 'Proximal', 'Distal'],
  Index: ['Proximal', 'Intermediate', 'Distal'],
  Middle: ['Proximal', 'Intermediate', 'Distal'],
  Ring: ['Proximal', 'Intermediate', 'Distal'],
  Little: ['Proximal', 'Intermediate', 'Distal'],
};

export const BODY_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
] as const;

export function fingerBoneNames(side: Side): string[] {
  const out: string[] = [];
  for (const f of FINGERS) for (const s of FINGER_SEGMENTS[f]) out.push(`${side}${f}${s}`);
  return out;
}

export const FINGER_BONES: string[] = [...fingerBoneNames('left'), ...fingerBoneNames('right')];

export type BoneName = string;

export interface BoneDef {
  name: BoneName;
  parent: BoneName | null;
  /** The child whose joint defines this bone's direction, or null for leaves (which use a tail). */
  primaryChild: BoneName | null;
  side: Side | null;
  isFinger: boolean;
}

function buildDefs(includeFingers: boolean): BoneDef[] {
  const defs: BoneDef[] = [];
  const add = (name: string, parent: string | null, primaryChild: string | null, side: Side | null, isFinger = false) =>
    defs.push({ name, parent, primaryChild, side, isFinger });

  add('hips', null, 'spine', null);
  add('spine', 'hips', 'chest', null);
  add('chest', 'spine', 'upperChest', null);
  add('upperChest', 'chest', 'neck', null);
  add('neck', 'upperChest', 'head', null);
  add('head', 'neck', null, null);
  for (const side of ['left', 'right'] as const) {
    add(`${side}Shoulder`, 'upperChest', `${side}UpperArm`, side);
    add(`${side}UpperArm`, `${side}Shoulder`, `${side}LowerArm`, side);
    add(`${side}LowerArm`, `${side}UpperArm`, `${side}Hand`, side);
    add(`${side}Hand`, `${side}LowerArm`, includeFingers ? `${side}MiddleProximal` : null, side);
    if (includeFingers) {
      for (const f of FINGERS) {
        const [a, b, c] = FINGER_SEGMENTS[f];
        add(`${side}${f}${a}`, `${side}Hand`, `${side}${f}${b}`, side, true);
        add(`${side}${f}${b}`, `${side}${f}${a}`, `${side}${f}${c}`, side, true);
        add(`${side}${f}${c}`, `${side}${f}${b}`, null, side, true);
      }
    }
  }
  for (const side of ['left', 'right'] as const) {
    add(`${side}UpperLeg`, 'hips', `${side}LowerLeg`, side);
    add(`${side}LowerLeg`, `${side}UpperLeg`, `${side}Foot`, side);
    add(`${side}Foot`, `${side}LowerLeg`, `${side}Toes`, side);
    add(`${side}Toes`, `${side}Foot`, null, side);
  }
  return defs;
}

export const HUMANOID_WITH_FINGERS: readonly BoneDef[] = buildDefs(true);
export const HUMANOID_NO_FINGERS: readonly BoneDef[] = buildDefs(false);

export function humanoidDefs(fingers: boolean): readonly BoneDef[] {
  return fingers ? HUMANOID_WITH_FINGERS : HUMANOID_NO_FINGERS;
}

const DEF_INDEX = new Map(HUMANOID_WITH_FINGERS.map((d) => [d.name, d]));

export function boneDef(name: BoneName): BoneDef | undefined {
  return DEF_INDEX.get(name);
}

export function canonicalParent(name: BoneName): BoneName | null {
  return DEF_INDEX.get(name)?.parent ?? null;
}

export function mirrorBoneName(name: BoneName): BoneName {
  if (name.startsWith('left')) return 'right' + name.slice(4);
  if (name.startsWith('right')) return 'left' + name.slice(5);
  return name;
}

/**
 * Directions each bone points in the canonical T-pose (facing +Z, left = +X).
 * Only bones listed here are straightened when computing T-pose frames of
 * arbitrary skeletons; everything else (spine, feet, thumbs) keeps its rest direction.
 */
export function tposeDirection(name: BoneName): [number, number, number] | null {
  const def = DEF_INDEX.get(name);
  if (!def || !def.side) return null;
  const sx = def.side === 'left' ? 1 : -1;
  if (/(UpperArm|LowerArm|Hand)$/.test(name)) return [sx, 0, 0];
  if (def.isFinger && !name.includes('Thumb')) return [sx, 0, 0];
  if (/(UpperLeg|LowerLeg)$/.test(name)) return [0, -1, 0];
  return null;
}

/** Joint positions (and leaf tails) of a fitted skeleton in rig space. */
export interface JointMap {
  joints: Record<BoneName, [number, number, number]>;
  /** End points for leaf bones (head top, finger tips, toe tips, hand tip when fingerless). */
  tails: Record<BoneName, [number, number, number]>;
}
