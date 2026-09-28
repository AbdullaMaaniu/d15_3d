/**
 * Preset clips cut from the CMU Graphics Lab Motion Capture Database
 * (http://mocap.cs.cmu.edu), BVH conversion by Bruce Hahne (cgspeed).
 *
 * window: seconds within the take. Loops search for the best cycle whose
 * length (seconds) lies within `period`.
 */
export interface ClipSpec {
  id: string;
  name: string;
  category: 'locomotion' | 'idle' | 'action' | 'emote' | 'combat';
  take: string;
  window: [number, number];
  loop?: { period: [number, number] };
  heading: 'travel' | 'facing' | 'start';
  description: string;
  /** Loops only: rebuild the other arm from this one (mirrored, half a cycle later) when the take has a lazy arm. */
  arms?: 'left' | 'right';
}

export const CLIPS: ClipSpec[] = [
  { id: 'idle', name: 'Idle', category: 'idle', take: '139_02', window: [0.2, 7.6], loop: { period: [3, 6] }, heading: 'facing', description: 'Standing, shifting weight' },
  // The actor's right arm barely swings in this take.
  { id: 'walk', name: 'Walk', category: 'locomotion', take: '143_32', window: [0.5, 2.1], loop: { period: [0.8, 1.4] }, heading: 'travel', description: 'Walk cycle', arms: 'left' },
  { id: 'run', name: 'Run', category: 'locomotion', take: '09_01', window: [0.1, 1.2], loop: { period: [0.55, 0.9] }, heading: 'travel', description: 'Run cycle' },
  { id: 'walk_backward', name: 'Walk Backward', category: 'locomotion', take: '143_39', window: [1.8, 4.1], loop: { period: [0.8, 1.6] }, heading: 'facing', description: 'Backward walk cycle' },
  { id: 'strafe', name: 'Strafe', category: 'locomotion', take: '143_40', window: [4.6, 7.2], loop: { period: [0.8, 1.6] }, heading: 'facing', description: 'Sideways walk cycle' },
  { id: 'sneak', name: 'Sneak', category: 'locomotion', take: '143_41', window: [0.6, 3.8], loop: { period: [0.9, 1.8] }, heading: 'travel', description: 'Crouched sneaking walk' },
  { id: 'crouch_walk', name: 'Crouch Walk', category: 'locomotion', take: '136_09', window: [2.6, 8.9], loop: { period: [0.9, 1.9] }, heading: 'travel', description: 'Low crouched walk' },
  { id: 'jump', name: 'Jump', category: 'action', take: '16_01', window: [0.4, 2.4], heading: 'start', description: 'Jump in place' },
  { id: 'wave', name: 'Wave', category: 'emote', take: '143_25', window: [2.7, 5.4], heading: 'start', description: 'Wave hello' },
  { id: 'bow', name: 'Bow', category: 'emote', take: '111_02', window: [0.2, 2.1], heading: 'start', description: 'Polite bow' },
  { id: 'shrug', name: 'Shrug', category: 'emote', take: '141_21', window: [0.2, 2.2], heading: 'start', description: 'Shrug' },
  { id: 'stretch', name: 'Stretch', category: 'emote', take: '143_30', window: [0.1, 3.0], heading: 'start', description: 'Stretch and yawn' },
  { id: 'dance', name: 'Dance', category: 'emote', take: '143_35', window: [0.5, 4.6], heading: 'start', description: 'Macarena dance' },
  { id: 'punch', name: 'Punch', category: 'combat', take: '143_23', window: [0.1, 1.6], heading: 'start', description: 'Punch combination' },
  { id: 'kick', name: 'Kick', category: 'combat', take: '74_03', window: [0.4, 2.2], heading: 'start', description: 'Front kick' },
  { id: 'throw', name: 'Throw', category: 'action', take: '111_33', window: [5.0, 7.3], heading: 'start', description: 'Overhand throw' },
  { id: 'pick_up', name: 'Pick Up', category: 'action', take: '111_17', window: [0.4, 3.4], heading: 'start', description: 'Bend down and pick something up' },
  { id: 'death', name: 'Death', category: 'combat', take: '90_16', window: [1.9, 5.4], heading: 'start', description: 'Fall forward onto the ground' },
];
