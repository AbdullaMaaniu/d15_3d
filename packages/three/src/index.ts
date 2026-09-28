import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Bone,
  LoopOnce,
  LoopRepeat,
  Object3D,
  Quaternion,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** VRM / RigForge canonical humanoid bone names. */
export type HumanoidBone =
  | 'hips' | 'spine' | 'chest' | 'upperChest' | 'neck' | 'head'
  | `${'left' | 'right'}${'Shoulder' | 'UpperArm' | 'LowerArm' | 'Hand' | 'UpperLeg' | 'LowerLeg' | 'Foot' | 'Toes'}`
  | `${'left' | 'right'}${'Thumb'}${'Metacarpal' | 'Proximal' | 'Distal'}`
  | `${'left' | 'right'}${'Index' | 'Middle' | 'Ring' | 'Little'}${'Proximal' | 'Intermediate' | 'Distal'}`;

/** Alternative names so bone() also works on Mixamo / UE / CMU rigs. */
const ALIASES: Record<string, string[]> = {
  hips: ['hips', 'pelvis'],
  spine: ['spine', 'spine01', 'lowerback'],
  chest: ['chest', 'spine1', 'spine02'],
  upperChest: ['upperchest', 'spine2', 'spine03'],
  neck: ['neck', 'neck01'],
  head: ['head'],
};
for (const [s, x] of [['left', 'l'], ['right', 'r']] as const) {
  Object.assign(ALIASES, {
    [`${s}Shoulder`]: [`${s}shoulder`, `clavicle${x}`],
    [`${s}UpperArm`]: [`${s}upperarm`, `${s}arm`, `upperarm${x}`],
    [`${s}LowerArm`]: [`${s}lowerarm`, `${s}forearm`, `lowerarm${x}`],
    [`${s}Hand`]: [`${s}hand`, `hand${x}`],
    [`${s}UpperLeg`]: [`${s}upperleg`, `${s}upleg`, `thigh${x}`],
    [`${s}LowerLeg`]: [`${s}lowerleg`, `${s}leg`, `calf${x}`],
    [`${s}Foot`]: [`${s}foot`, `foot${x}`],
    [`${s}Toes`]: [`${s}toes`, `${s}toebase`, `ball${x}`],
  });
}

function normalizeName(name: string): string {
  const n = name.slice(Math.max(name.lastIndexOf(':'), name.lastIndexOf('|')) + 1);
  return n.toLowerCase().replace(/^mixamorig\d*/, '').replace(/[^a-z0-9]/g, '');
}

export interface PlayOptions {
  /** Crossfade duration in seconds (default 0.2). */
  fade?: number;
  /** Loop the clip. Defaults to the exported clip setting, else true for locomotion/idle names. */
  loop?: boolean;
  /** Playback speed (default 1). */
  speed?: number;
  /** Restart even if the clip is already playing. */
  restart?: boolean;
}

export interface LookAtOptions {
  /** 0..1 blend (default 1). */
  weight?: number;
  /** Max head turn in radians (default ~70°). */
  maxAngle?: number;
  /** Share of the turn done by the neck (default 0.4). */
  neckShare?: number;
}

type EventName = 'finished' | 'loop';

/**
 * A rigged, animated character: wraps an AnimationMixer with name-based playback,
 * crossfades, bone lookup/attachment and a procedural look-at.
 */
export class Character {
  readonly object: Object3D;
  readonly mixer: AnimationMixer;
  readonly clips: AnimationClip[];
  readonly actions = new Map<string, AnimationAction>();
  current: AnimationAction | null = null;

  private boneCache = new Map<string, Object3D | null>();
  private lookTarget: Vector3 | Object3D | null = null;
  private lookOptions: Required<LookAtOptions> = { weight: 1, maxAngle: 1.2, neckShare: 0.4 };
  private listeners: Record<EventName, Set<(e: { action: AnimationAction; name: string }) => void>> = {
    finished: new Set(),
    loop: new Set(),
  };

  constructor(object: Object3D, clips: AnimationClip[]) {
    this.object = object;
    this.clips = clips;
    this.mixer = new AnimationMixer(object);
    for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
    const emit = (type: EventName) => (e: { action: AnimationAction }) => {
      for (const cb of this.listeners[type]) cb({ action: e.action, name: e.action.getClip().name });
    };
    this.mixer.addEventListener('finished', emit('finished') as any);
    this.mixer.addEventListener('loop', emit('loop') as any);
    // Capture rest orientations used by lookAt before any animation runs.
    for (const name of ['head', 'neck']) {
      const b = this.bone(name);
      if (b) this.restRelative(b);
    }
  }

  static fromGLTF(gltf: GLTF): Character {
    return new Character(gltf.scene, gltf.animations);
  }

  get clipNames(): string[] {
    return this.clips.map((c) => c.name);
  }

  /** Plays (crossfading into) the named clip. Returns the action, or null if missing. */
  play(name: string, options: PlayOptions = {}): AnimationAction | null {
    const action = this.actions.get(name) ?? this.findAction(name);
    if (!action) {
      console.warn(`[rigforge] No clip named "${name}". Available: ${this.clipNames.join(', ')}`);
      return null;
    }
    const fade = options.fade ?? 0.2;
    const clip = action.getClip();
    const exported = (clip.userData as any)?.rigforge;
    const loop = options.loop ?? exported?.loop ?? /idle|walk|run|jog|sneak|strafe|crouch|swim|fly/i.test(clip.name);
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.setEffectiveTimeScale(options.speed ?? 1);
    if (this.current === action && !options.restart) return action;
    action.reset().setEffectiveWeight(1).play();
    if (this.current && this.current !== action && fade > 0) this.current.crossFadeTo(action, fade, false);
    else if (this.current && this.current !== action) this.current.stop();
    this.current = action;
    return action;
  }

  /** Alias of play() for readability. */
  crossFadeTo(name: string, fade = 0.25, options: Omit<PlayOptions, 'fade'> = {}): AnimationAction | null {
    return this.play(name, { ...options, fade });
  }

  stop(fade = 0.2): void {
    if (!this.current) return;
    if (fade > 0) this.current.fadeOut(fade);
    else this.current.stop();
    this.current = null;
  }

  /** Subscribe to 'finished' (one-shot ended) or 'loop' events. Returns an unsubscribe function. */
  on(type: EventName, cb: (e: { action: AnimationAction; name: string }) => void): () => void {
    this.listeners[type].add(cb);
    return () => this.listeners[type].delete(cb);
  }

  /** Finds a bone by canonical name (e.g. 'leftHand'), with Mixamo/UE aliases. */
  bone(name: HumanoidBone | string): Bone | undefined {
    if (!this.boneCache.has(name)) {
      let found: Object3D | undefined = this.object.getObjectByName(name);
      if (!found) {
        const wanted = new Set([normalizeName(name), ...(ALIASES[name] ?? [])]);
        this.object.traverse((o) => {
          if (!found && (o as Bone).isBone && wanted.has(normalizeName(o.name))) found = o;
        });
      }
      this.boneCache.set(name, found ?? null);
    }
    return (this.boneCache.get(name) as Bone | null) ?? undefined;
  }

  /** Parents an object (weapon, hat...) to a bone. */
  attach(boneName: HumanoidBone | string, object: Object3D): boolean {
    const bone = this.bone(boneName);
    if (!bone) return false;
    bone.add(object);
    return true;
  }

  /** Makes the head (and partly the neck) track a point or object. Pass null to stop. */
  lookAt(target: Vector3 | Object3D | null, options: LookAtOptions = {}): void {
    this.lookTarget = target;
    this.lookOptions = { ...this.lookOptions, ...options };
  }

  /** Advances animation. Call once per frame. */
  update(delta: number): void {
    this.mixer.update(delta);
    if (this.lookTarget) this.applyLookAt();
  }

  /** Independent copy sharing geometry, materials and clips (for crowds). */
  clone(): Character {
    return new Character(cloneSkinned(this.object), this.clips);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
  }

  private findAction(name: string): AnimationAction | undefined {
    const n = name.toLowerCase();
    for (const [k, v] of this.actions) if (k.toLowerCase() === n || k.toLowerCase().endsWith(`|${n}`)) return v;
    return undefined;
  }

  private _v = new Vector3();
  private _v2 = new Vector3();
  private _q = new Quaternion();
  private _q2 = new Quaternion();

  private restRel = new Map<Object3D, Quaternion>();

  /** Rotation of a bone relative to the character root in the rest pose (captured once). */
  private restRelative(bone: Object3D): Quaternion {
    let q = this.restRel.get(bone);
    if (!q) {
      // Temporarily evaluate the rest pose: bones keep their bind transforms until the mixer runs.
      this.object.updateMatrixWorld(true);
      q = this.object.getWorldQuaternion(new Quaternion()).invert().multiply(bone.getWorldQuaternion(new Quaternion()));
      this.restRel.set(bone, q);
    }
    return q;
  }

  private applyLookAt(): void {
    const head = this.bone('head');
    if (!head) return;
    const neck = this.bone('neck');
    const target = this.lookTarget instanceof Object3D ? this.lookTarget.getWorldPosition(this._v2) : (this.lookTarget as Vector3);
    this.object.updateMatrixWorld(true);
    const { weight, maxAngle, neckShare } = this.lookOptions;
    const turn = (bone: Object3D, share: number) => {
      const origin = bone.getWorldPosition(this._v);
      const toTarget = target.clone().sub(origin).normalize();
      // The bone's current forward: character forward (+Z) carried by the bone's deviation from rest.
      const boneWorld = bone.getWorldQuaternion(this._q);
      const deviation = boneWorld.clone().multiply(this.restRelative(bone).clone().invert());
      const forward = new Vector3(0, 0, 1).applyQuaternion(deviation);
      const q = new Quaternion().setFromUnitVectors(forward, toTarget);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (angle > maxAngle) q.slerp(new Quaternion(), 1 - maxAngle / angle);
      const partial = new Quaternion().slerp(q, weight * share);
      const parentWorld = bone.parent!.getWorldQuaternion(this._q2);
      const world = boneWorld.clone().premultiply(partial);
      bone.quaternion.copy(parentWorld.invert().multiply(world));
      bone.updateMatrixWorld(true);
    };
    if (neck) turn(neck, neckShare);
    turn(head, neck ? 1 - neckShare : 1);
  }
}

export interface LoadOptions {
  /** Supply your own configured GLTFLoader (e.g. with DRACO/KTX2 loaders). */
  loader?: GLTFLoader;
  /** Needed only when using KTX2 textures with a custom loader setup. */
  renderer?: WebGLRenderer;
  onProgress?: (event: ProgressEvent) => void;
}

let defaultLoader: GLTFLoader | null = null;

/** Loads a RigForge (or any skinned, animated) GLB and wraps it in a Character. */
export async function loadCharacter(url: string, options: LoadOptions = {}): Promise<Character> {
  const loader = options.loader ?? (defaultLoader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));
  const gltf = await loader.loadAsync(url, options.onProgress);
  gltf.scene.traverse((o) => {
    if ((o as any).isSkinnedMesh) o.frustumCulled = false;
  });
  return Character.fromGLTF(gltf);
}
