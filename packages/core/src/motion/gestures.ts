import type { PoseKey } from './pose';

/**
 * Built-in gestures written as pose keys. Each is a short one-shot that starts
 * and ends near a relaxed standing pose, so they chain with presets. Gestures
 * that use one hand use the right one; the compiler mirrors them for the left.
 */
export interface Gesture {
  id: string;
  name: string;
  description: string;
  /** Which side does the main action (for mirroring), or 'both'. */
  side: 'left' | 'right' | 'both';
  keys: PoseKey[];
}

const rep = (n: number, period: number, start: number, a: PoseKey['pose'], b: PoseKey['pose']): PoseKey[] => {
  const out: PoseKey[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: start + i * period, pose: a });
    out.push({ t: start + i * period + period / 2, pose: b });
  }
  return out;
};

const REST: PoseKey['pose'] = {
  leftArmLift: 4, rightArmLift: 4, leftArmForward: 0, rightArmForward: 0, leftElbow: 10, rightElbow: 10,
  leftForearmRoll: 0, rightForearmRoll: 0, leftWrist: 0, rightWrist: 0, leftShrug: 0, rightShrug: 0,
  spineBend: 0, spineSide: 0, spineTwist: 0, headNod: 0, headTurn: 0, headTilt: 0,
  leftHip: 0, rightHip: 0, leftKnee: 0, rightKnee: 0, leftHipOut: 0, rightHipOut: 0, leftAnkle: 0, rightAnkle: 0,
};

const end = (t: number): PoseKey => ({ t, pose: REST });

// Hands together in front of the chest, and a little apart.
const CLAP_SHUT: PoseKey['pose'] = { leftArmLift: 35, leftArmForward: 60, leftForearmRoll: -50, leftElbow: 95, rightArmLift: 35, rightArmForward: 60, rightForearmRoll: -50, rightElbow: 95 };
const CLAP_OPEN: PoseKey['pose'] = { leftArmLift: 25, leftArmForward: 35, leftForearmRoll: -20, leftElbow: 105, rightArmLift: 25, rightArmForward: 35, rightForearmRoll: -20, rightElbow: 105 };

export const GESTURES: Gesture[] = [
  {
    id: 'bow_polite', name: 'Polite Bow', description: 'Bow from the waist, arms at the sides, both feet planted', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.7, pose: { spineBend: 50, headNod: 12, leftKnee: 4, rightKnee: 4 } },
      { t: 1.4, pose: { spineBend: 52 } },
      end(2.2),
    ],
  },
  {
    id: 'wave_hand', name: 'Wave (One Hand)', description: 'Wave hello with one hand', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.4, pose: { rightArmLift: 105, rightArmForward: 25, rightElbow: 75, rightForearmRoll: 85, spineSide: 3, headTilt: -4 } },
      ...rep(3, 0.52, 0.55, { rightElbow: 35, rightWrist: -10 }, { rightElbow: 85, rightWrist: 12 }),
      { t: 2.2, pose: { rightElbow: 60, rightWrist: 0 } },
      end(2.75),
    ],
  },
  {
    id: 'clap', name: 'Clap', description: 'Clap hands in front of the chest a few times', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.45, pose: { leftArmLift: 25, leftArmForward: 35, leftForearmRoll: -20, leftElbow: 105, rightArmLift: 25, rightArmForward: 35, rightForearmRoll: -20, rightElbow: 105 } },
      ...rep(4, 0.36, 0.6, CLAP_SHUT, CLAP_OPEN),
      { t: 2.2, pose: CLAP_SHUT },
      end(2.75),
    ],
  },
  {
    id: 'cheer', name: 'Cheer', description: 'Throw both arms up in celebration', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.25, pose: { leftKnee: 18, rightKnee: 18, leftHip: 10, rightHip: 10, spineBend: 8, leftArmLift: 30, rightArmLift: 30, leftElbow: 60, rightElbow: 60 } },
      { t: 0.6, pose: { leftKnee: 0, rightKnee: 0, leftHip: 0, rightHip: 0, spineBend: -8, headNod: -15, leftArmLift: 165, rightArmLift: 165, leftArmForward: 20, rightArmForward: 20, leftElbow: 15, rightElbow: 15 } },
      ...rep(2, 0.5, 0.9, { leftArmLift: 150, rightArmLift: 150, leftElbow: 30, rightElbow: 30 }, { leftArmLift: 168, rightArmLift: 168, leftElbow: 12, rightElbow: 12 }),
      { t: 2.0, pose: { headNod: 0, spineBend: 0 } },
      end(2.6),
    ],
  },
  {
    id: 'raise_hand', name: 'Raise Hand', description: 'Raise one hand straight up, like asking a question', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.6, pose: { rightArmLift: 170, rightArmForward: 40, rightElbow: 15, spineSide: 4, headNod: -5 } },
      { t: 2.0, pose: { rightArmLift: 172, rightElbow: 10 } },
      end(2.6),
    ],
  },
  {
    id: 'point', name: 'Point', description: 'Point forward with one arm', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.45, pose: { rightArmLift: 88, rightArmForward: 92, rightElbow: 5, spineTwist: -6, headTurn: -4 } },
      { t: 1.8, pose: { rightArmLift: 88 } },
      end(2.4),
    ],
  },
  {
    id: 'salute', name: 'Salute', description: 'Military salute, hand to the brow', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.45, pose: { rightArmLift: 110, rightArmForward: 45, rightElbow: 125, rightForearmRoll: 10, headNod: -4 } },
      { t: 1.6, pose: { rightArmLift: 108 } },
      end(2.1),
    ],
  },
  {
    id: 'nod', name: 'Nod', description: 'Nod yes', side: 'both',
    keys: [{ t: 0, pose: REST }, ...rep(3, 0.5, 0.15, { headNod: 18 }, { headNod: -4 }), end(1.8)],
  },
  {
    id: 'shake_head', name: 'Shake Head', description: 'Shake the head no', side: 'both',
    keys: [{ t: 0, pose: REST }, ...rep(3, 0.5, 0.1, { headTurn: 28 }, { headTurn: -28 }), end(1.9)],
  },
  {
    id: 'look_around', name: 'Look Around', description: 'Look left, then right, searching', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.8, pose: { headTurn: 60, spineTwist: 20, headNod: -5 } },
      { t: 1.6, pose: { headTurn: 60, spineTwist: 20 } },
      { t: 2.6, pose: { headTurn: -60, spineTwist: -20 } },
      { t: 3.4, pose: { headTurn: -60, spineTwist: -20 } },
      end(4.1),
    ],
  },
  {
    id: 'think', name: 'Think', description: 'Hand to the chin, pondering', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.7, pose: { rightArmLift: 40, rightArmForward: 110, rightElbow: 135, rightForearmRoll: -50, leftArmLift: 10, leftArmForward: 85, leftElbow: 80, leftForearmRoll: -70, headNod: 8, headTilt: -8 } },
      { t: 2.6, pose: { headNod: 10, headTilt: -12 } },
      end(3.3),
    ],
  },
  {
    id: 'cross_arms', name: 'Cross Arms', description: 'Fold the arms across the chest', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.7, pose: { leftArmLift: 20, leftArmForward: 95, leftElbow: 85, leftForearmRoll: -80, rightArmLift: 30, rightArmForward: 95, rightElbow: 85, rightForearmRoll: -80, spineBend: -3 } },
      { t: 2.6, pose: { headTilt: 5 } },
      end(3.3),
    ],
  },
  {
    id: 'hands_on_hips', name: 'Hands on Hips', description: 'Hands on the hips, elbows out', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.6, pose: { leftArmLift: 45, leftArmForward: -5, leftElbow: 85, leftForearmRoll: -80, rightArmLift: 45, rightArmForward: -5, rightElbow: 85, rightForearmRoll: -80, spineBend: -4 } },
      { t: 2.4, pose: { headTurn: 8 } },
      end(3.0),
    ],
  },
  {
    id: 'facepalm', name: 'Facepalm', description: 'Hand over the face in dismay', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.5, pose: { rightArmLift: 65, rightArmForward: 100, rightElbow: 125, rightForearmRoll: -40, headNod: 25, spineBend: 10 } },
      { t: 1.9, pose: { headNod: 30, headTurn: 8 } },
      end(2.6),
    ],
  },
  {
    id: 'fist_pump', name: 'Fist Pump', description: 'Pump a fist in victory', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.3, pose: { rightArmLift: 60, rightArmForward: 40, rightElbow: 120, rightForearmRoll: 70 } },
      ...rep(3, 0.4, 0.45, { rightArmLift: 115, rightElbow: 60, headNod: -10 }, { rightArmLift: 70, rightElbow: 125, headNod: 0 }),
      end(2.2),
    ],
  },
  {
    id: 'squat', name: 'Squat', description: 'Squat down and stand back up', side: 'both',
    keys: [
      { t: 0, pose: REST },
      { t: 0.9, pose: { leftHip: 95, rightHip: 95, leftKnee: 115, rightKnee: 115, leftHipOut: 10, rightHipOut: 10, spineBend: 25, leftArmLift: 85, rightArmLift: 85, leftArmForward: 90, rightArmForward: 90, leftElbow: 10, rightElbow: 10 } },
      { t: 1.4, pose: { spineBend: 28 } },
      end(2.3),
    ],
  },
  {
    id: 'kneel', name: 'Kneel', description: 'Go down on one knee', side: 'right',
    keys: [
      { t: 0, pose: REST },
      { t: 0.6, pose: { leftHip: 50, leftKnee: 55, rightHip: -5, rightKnee: 40, spineBend: 8 } },
      { t: 1.3, pose: { leftHip: 88, leftKnee: 92, rightHip: -12, rightKnee: 98, rightAnkle: -35, spineBend: 4, leftArmLift: 25, leftArmForward: 80, leftElbow: 70 } },
      { t: 2.8, pose: { headNod: 10 } },
    ],
  },
];

export function findGesture(id: string): Gesture | undefined {
  return GESTURES.find((g) => g.id === id);
}
