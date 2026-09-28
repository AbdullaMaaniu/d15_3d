/** Display name and colour for each joint marker, so users can tell them apart. */

export interface JointInfo {
  /** e.g. "Left elbow" */
  label: string;
  /** e.g. "L Elbow" (tags next to markers) */
  short: string;
  color: string;
  side: 'left' | 'right' | null;
}

// Humanoid joints are named by the bone that starts there.
const HUMANOID: Record<string, [string, string]> = {
  hips: ['Pelvis', '#facc15'],
  spine: ['Spine', '#facc15'],
  chest: ['Chest', '#facc15'],
  upperChest: ['Upper chest', '#facc15'],
  neck: ['Neck', '#f472b6'],
  head: ['Head', '#f472b6'],
  Shoulder: ['Collarbone', '#a78bfa'],
  UpperArm: ['Shoulder', '#60a5fa'],
  LowerArm: ['Elbow', '#34d399'],
  Hand: ['Wrist', '#2dd4bf'],
  UpperLeg: ['Hip', '#fb923c'],
  LowerLeg: ['Knee', '#f87171'],
  Foot: ['Ankle', '#c084fc'],
  Toes: ['Toes', '#fbbf24'],
  // Quadrupeds.
  FrontUpperLeg: ['Front shoulder', '#60a5fa'],
  FrontLowerLeg: ['Front elbow', '#34d399'],
  FrontFoot: ['Front wrist', '#2dd4bf'],
  FrontToes: ['Front paw', '#fbbf24'],
  BackUpperLeg: ['Back hip', '#fb923c'],
  BackLowerLeg: ['Back knee', '#f87171'],
  BackFoot: ['Back hock', '#c084fc'],
  BackToes: ['Back paw', '#fbbf24'],
};

const FINGER_COLOR = '#94a3b8';
const OTHER_COLOR = '#e2e8f0';

function words(s: string): string {
  const w = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/(\D)(\d)/g, '$1 $2').toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function jointInfo(name: string): JointInfo {
  const side = name.startsWith('left') ? 'left' : name.startsWith('right') ? 'right' : null;
  const rest = side ? name.slice(side.length) : name;
  const known = HUMANOID[rest];
  const finger = /^(Thumb|Index|Middle|Ring|Little)/.exec(rest);
  let base: string, color: string;
  if (known) [base, color] = known;
  else if (finger) {
    base = words(rest.replace(/(Proximal|Intermediate|Distal|Metacarpal)$/, (m) => ` ${m === 'Proximal' ? '1' : m === 'Intermediate' ? '2' : m === 'Distal' ? '3' : 'base'}`));
    color = FINGER_COLOR;
  } else if (/^tail/i.test(rest)) {
    base = words(rest);
    color = '#fde68a';
  } else {
    base = words(rest);
    color = OTHER_COLOR;
  }
  const s = side === 'left' ? 'Left' : side === 'right' ? 'Right' : '';
  return {
    label: side ? `${s} ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base,
    short: side ? `${side === 'left' ? 'L' : 'R'} ${base}` : base,
    color,
    side,
  };
}
