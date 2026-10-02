import {
  AdditiveAnimationBlendMode,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  AnimationUtils,
  Bone,
  LoopOnce,
  LoopRepeat,
  Matrix3,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { AnimationStateMachine, controllerStateMachine, guessController, type ControllerSetup, type StateMachineDef } from './stateMachine';
import { FootIK, type FootIKOptions } from './ik';
import { SpringBones, type SpringConfig } from './springs';
import { listRegions, setRegionColor } from './recolor';

export { SpringBones, type SpringConfig, type SpringChainDef, type SpringColliderDef } from './springs';

export * from './stateMachine';
export { listRegions, setRegionColor, setMaterialColor, enableRecolor, regionOf, type RegionInfo } from './recolor';
export { FootIK, solveTwoBoneIK, raycastGround, rotateBoneWorld, type FootIKOptions, type GroundQuery, type Leg } from './ik';
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

/** Named bone subsets for layers. Custom masks are lists of bone names (each includes its descendants). */
export type LayerMask = 'fullBody' | 'upperBody' | 'lowerBody' | 'leftArm' | 'rightArm' | 'head' | string[];

const MASKS: Record<Exclude<LayerMask, string[]>, string[]> = {
  fullBody: ['hips'],
  upperBody: ['spine'],
  lowerBody: ['leftUpperLeg', 'rightUpperLeg'],
  leftArm: ['leftShoulder'],
  rightArm: ['rightShoulder'],
  head: ['neck'],
};

export interface LayerOptions {
  mask?: LayerMask;
  /** 0..1 (default 1). */
  weight?: number;
  fade?: number;
  loop?: boolean;
  speed?: number;
  /** Add on top of the base motion instead of replacing it (clip made relative to its first frame). */
  additive?: boolean;
}

interface Layer {
  name: string;
  mixer: AnimationMixer | null;
  action: AnimationAction;
  bones: Object3D[];
  weight: number;
  target: number;
  fadeRate: number;
  additive: boolean;
}

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
  private machine: AnimationStateMachine | null = null;
  private layers = new Map<string, Layer>();
  private footIK: FootIK | null = null;
  private rootMotionOn = false;
  private rootRest: Vector3 | null = null;
  private rootLast: Vector3 | null = null;
  private rootLastDelta = new Vector3();
  private rootLooped = false;
  /** Secondary motion (hair, tails, capes); set up from the file automatically when present. */
  springs: SpringBones | null = null;
  /** Bones of a second skeleton (RigForge's body) that copy the character's pose after IK, look-at and springs. */
  private followers: Array<{ bone: Object3D; source: Object3D; rest: Vector3; sourceRest: Vector3; stride: number }> = [];

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
    this.mixer.addEventListener('loop', () => (this.rootLooped = true));
    this.rootRest = this.bone('hips')?.position.clone() ?? null;
    // Spring bones exported by RigForge live in node extras (userData after loading).
    let springConfig: SpringConfig | undefined;
    object.traverse((o) => {
      springConfig ??= (o.userData?.rigforge as { springs?: SpringConfig } | undefined)?.springs;
    });
    if (springConfig?.chains?.length) this.springs = new SpringBones(object, springConfig, (n) => this.bone(n) ?? object.getObjectByName(n));
    // Follower skeletons (the body under the clothes) exported by RigForge, captured at rest.
    object.traverse((o) => {
      const stride = (o.userData?.rigforge as { follower?: { stride: number } } | undefined)?.follower?.stride;
      if (stride === undefined) return;
      o.traverse((b) => {
        const follows = (b.userData?.rigforge as { follows?: string } | undefined)?.follows;
        const source = follows ? this.bone(follows) : undefined;
        if (source) this.followers.push({ bone: b, source, rest: b.position.clone(), sourceRest: source.position.clone(), stride });
      });
    });
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

  /** Recolourable body regions set up in RigForge's Parts step (e.g. "Hair", "Skin", "Top"). */
  get regions(): string[] {
    return listRegions(this.object).map((r) => r.name);
  }

  /**
   * Recolours a region, keeping the texture's shading and detail
   * (`character.setColor('Top', '#c0392b')`); `null` restores the original.
   * Returns false if the character has no such region.
   */
  setColor(region: string, color: import('three').ColorRepresentation | null): boolean {
    return setRegionColor(this.object, region, color);
  }

  /** Plays (crossfading into) the named clip. Returns the action, or null if missing. Stops any state machine. */
  play(name: string, options: PlayOptions = {}): AnimationAction | null {
    this.machine = null;
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
    this.machine?.update();
    this.mixer.update(delta);
    if (this.rootMotionOn) this.applyRootMotion();
    if (this.layers.size) this.applyLayers(delta);
    this.footIK?.apply();
    if (this.lookTarget) this.applyLookAt();
    this.springs?.update(delta);
    for (const f of this.followers) {
      f.bone.quaternion.copy(f.source.quaternion);
      f.bone.scale.copy(f.source.scale);
      f.bone.position.copy(f.source.position).sub(f.sourceRest).multiplyScalar(f.stride).add(f.rest);
    }
  }

  /** Replaces the spring bone setup (null removes it). */
  setSprings(config: SpringConfig | null): SpringBones | null {
    this.springs = config?.chains.length ? new SpringBones(this.object, config, (n) => this.bone(n) ?? this.object.getObjectByName(n)) : null;
    return this.springs;
  }

  // --- State machine --------------------------------------------------------------

  /** Drives playback from a state machine (replaces manual play() calls). */
  stateMachine(def: StateMachineDef): AnimationStateMachine {
    this.current?.fadeOut(0.2);
    this.current = null;
    this.machine = new AnimationStateMachine((name) => this.actions.get(name) ?? this.findAction(name), def);
    return this.machine;
  }

  /**
   * A ready-made controller: idle/walk/run blended by the \`speed\` parameter (m/s),
   * plus \`trigger('jump')\` and one trigger per action. Uses the setup exported by
   * RigForge when present, otherwise guesses from clip names.
   */
  autoStateMachine(setup?: ControllerSetup): AnimationStateMachine {
    let found: ControllerSetup | undefined = setup;
    if (!found) this.object.traverse((o) => { found ??= (o.userData?.rigforge as { controller?: ControllerSetup } | undefined)?.controller; });
    const valid = (c: ControllerSetup | undefined) => c && c.locomotion?.every(([, n]) => this.actions.has(n));
    return this.stateMachine(controllerStateMachine(valid(found) ? found! : guessController(this.clipNames)));
  }

  /** The controller setup this character would use (exported or guessed). */
  get controllerSetup(): ControllerSetup {
    let found: ControllerSetup | undefined;
    this.object.traverse((o) => { found ??= (o.userData?.rigforge as { controller?: ControllerSetup } | undefined)?.controller; });
    return found ?? guessController(this.clipNames);
  }

  get machineState(): AnimationStateMachine | null {
    return this.machine;
  }

  // --- Layers ---------------------------------------------------------------------

  /**
   * Plays a clip on part of the body over the base animation, e.g.
   * `playLayer('attack', 'Punch', { mask: 'upperBody' })` while walking.
   */
  playLayer(name: string, clipName: string, options: LayerOptions = {}): AnimationAction | null {
    const src = this.actions.get(clipName)?.getClip() ?? this.findAction(clipName)?.getClip();
    if (!src) {
      console.warn(`[rigforge] No clip named "${clipName}" for layer "${name}".`);
      return null;
    }
    this.stopLayer(name, 0);
    const bones = this.maskBones(options.mask ?? 'upperBody');
    const names = new Set(bones.map((b) => b.name));
    const tracks = src.tracks.filter((t) => names.has(t.name.slice(0, t.name.lastIndexOf('.'))));
    let clip = new AnimationClip(`${src.name}:${name}`, src.duration, tracks.map((t) => t.clone()));
    const additive = !!options.additive;
    const loop = options.loop ?? true;
    let mixer: AnimationMixer | null = null;
    let action: AnimationAction;
    if (additive) {
      clip = AnimationUtils.makeClipAdditive(clip);
      action = this.mixer.clipAction(clip);
      action.blendMode = AdditiveAnimationBlendMode;
    } else {
      mixer = new AnimationMixer(this.object);
      action = mixer.clipAction(clip);
    }
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.setEffectiveTimeScale(options.speed ?? 1);
    action.play();
    const fade = options.fade ?? 0.2;
    const target = options.weight ?? 1;
    const layer: Layer = { name, mixer, action, bones, weight: fade > 0 ? 0 : target, target, fadeRate: fade > 0 ? 1 / fade : Infinity, additive };
    if (additive) action.setEffectiveWeight(layer.weight);
    this.layers.set(name, layer);
    if (!loop && mixer) {
      mixer.addEventListener('finished', () => this.stopLayer(name, fade));
    }
    return action;
  }

  /** Fades a layer out and removes it. */
  stopLayer(name: string, fade = 0.2): void {
    const layer = this.layers.get(name);
    if (!layer) return;
    if (fade <= 0) {
      this.removeLayer(layer);
      return;
    }
    layer.target = 0;
    layer.fadeRate = 1 / fade;
  }

  setLayerWeight(name: string, weight: number): void {
    const layer = this.layers.get(name);
    if (layer) layer.target = weight;
  }

  private removeLayer(layer: Layer): void {
    layer.action.stop();
    if (layer.mixer) layer.mixer.uncacheRoot(this.object);
    else this.mixer.uncacheAction(layer.action.getClip());
    this.layers.delete(layer.name);
  }

  private maskBones(mask: LayerMask): Object3D[] {
    const roots = (Array.isArray(mask) ? mask : MASKS[mask]).map((n) => this.bone(n)).filter((b): b is Bone => !!b);
    const out = new Set<Object3D>();
    for (const r of roots) r.traverse((o) => { if ((o as Bone).isBone) out.add(o); });
    return [...out];
  }

  private applyLayers(delta: number): void {
    const saved = new Map<Object3D, [Quaternion, Vector3]>();
    for (const layer of [...this.layers.values()]) {
      // Fade toward the target weight.
      const step = delta * layer.fadeRate;
      layer.weight = layer.weight < layer.target ? Math.min(layer.target, layer.weight + step) : Math.max(layer.target, layer.weight - step);
      if (layer.target === 0 && layer.weight === 0) {
        this.removeLayer(layer);
        continue;
      }
      if (layer.additive) {
        layer.action.setEffectiveWeight(layer.weight);
        continue;
      }
      // Override layer: pose from its own mixer, blended over the base pose per bone.
      for (const b of layer.bones) saved.set(b, [b.quaternion.clone(), b.position.clone()]);
      layer.mixer!.update(delta);
      for (const b of layer.bones) {
        const [q, p] = saved.get(b)!;
        b.quaternion.copy(q.slerp(b.quaternion, layer.weight));
        b.position.copy(p.lerp(b.position, layer.weight));
      }
    }
  }

  // --- Root motion ----------------------------------------------------------------

  /**
   * When on, horizontal hips travel in the clips moves `object` instead, so
   * clips exported with root motion (not "in place") drive the character.
   */
  set rootMotion(on: boolean) {
    this.rootMotionOn = on;
    this.rootLast = null;
  }

  get rootMotion(): boolean {
    return this.rootMotionOn;
  }

  private applyRootMotion(): void {
    const hips = this.bone('hips');
    if (!hips || !hips.parent) return;
    this.rootRest ??= hips.position.clone();
    const cur = hips.position.clone();
    let d: Vector3;
    if (!this.rootLast || this.rootLooped) d = this.rootLooped ? this.rootLastDelta.clone() : new Vector3();
    else d = cur.clone().sub(this.rootLast);
    d.y = 0;
    this.rootLooped = false;
    this.rootLast = cur;
    this.rootLastDelta.copy(d);
    // Hips-parent space -> world -> object's parent space (as a direction with scale, no translation).
    hips.parent.updateWorldMatrix(true, false);
    const world = d.clone().applyMatrix3(new Matrix3().setFromMatrix4(hips.parent.matrixWorld));
    if (this.object.parent) {
      const inv = new Matrix4().copy(this.object.parent.matrixWorld).invert();
      world.applyMatrix3(new Matrix3().setFromMatrix4(inv));
    }
    if (d.lengthSq() > 0) this.object.position.add(world);
    hips.position.x = this.rootRest.x;
    hips.position.z = this.rootRest.z;
  }

  // --- Foot IK --------------------------------------------------------------------

  /** Plants the feet on uneven ground. Pass `null` to disable. */
  enableFootIK(options: FootIKOptions | null): FootIK | null {
    if (!options) {
      this.footIK = null;
      return null;
    }
    const need = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].map((n) => this.bone(n));
    if (need.some((b) => !b)) {
      console.warn('[rigforge] Foot IK needs hips and both leg chains.');
      return null;
    }
    const [hips, lu, ll, lf, ru, rl, rf] = need as Bone[];
    this.footIK = new FootIK(this.object, hips, [
      { upper: lu, lower: ll, foot: lf },
      { upper: ru, lower: rl, foot: rf },
    ], options);
    return this.footIK;
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
