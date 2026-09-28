import { LoopOnce, LoopRepeat, type AnimationAction } from 'three';

export type ParamValue = number | boolean;

export type Condition =
  | { param: string; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: ParamValue }
  | { trigger: string };

/** A state plays one clip, or blends clips along a numeric parameter (e.g. speed). */
export interface StateDef {
  clip?: string;
  /** 1D blend: [threshold, clip] pairs sorted by threshold, driven by `param`. */
  blend?: { param: string; clips: Array<[number, string]> };
  loop?: boolean;
  /** Fixed speed, or the name of a numeric parameter. */
  speed?: number | string;
}

export interface TransitionDef {
  /** Source state, or '*' for any state. */
  from: string;
  to: string;
  /** All conditions must hold. Omit to transition when the source clip finishes. */
  when?: Condition[];
  /** Crossfade seconds (default 0.2). */
  fade?: number;
  /** Only allow leaving after this fraction (0..1) of the source clip has played. */
  exitTime?: number;
}

export interface StateMachineDef {
  initial: string;
  states: Record<string, StateDef>;
  transitions: TransitionDef[];
  parameters?: Record<string, ParamValue>;
}

interface ActiveState {
  name: string;
  def: StateDef;
  actions: AnimationAction[];
  /** For blends: index pairs + weights of the clips. */
  weights: number[];
}

/**
 * JSON-definable animation state machine on top of an AnimationMixer.
 *
 * ```ts
 * const sm = character.stateMachine({
 *   initial: 'locomotion',
 *   parameters: { speed: 0 },
 *   states: {
 *     locomotion: { blend: { param: 'speed', clips: [[0, 'Idle'], [1.4, 'Walk'], [4, 'Run']] } },
 *     jump: { clip: 'Jump', loop: false },
 *   },
 *   transitions: [
 *     { from: 'locomotion', to: 'jump', when: [{ trigger: 'jump' }] },
 *     { from: 'jump', to: 'locomotion', exitTime: 0.9 },
 *   ],
 * });
 * sm.set('speed', 2.5); sm.trigger('jump');
 * ```
 */
export class AnimationStateMachine {
  readonly params: Record<string, ParamValue>;
  private triggers = new Set<string>();
  private current: ActiveState | null = null;
  private listeners = new Set<(to: string, from: string | null) => void>();

  constructor(
    private resolve: (clip: string) => AnimationAction | undefined,
    readonly def: StateMachineDef,
  ) {
    this.params = { ...(def.parameters ?? {}) };
    for (const [name, s] of Object.entries(def.states)) {
      const clips = s.blend ? s.blend.clips.map((c) => c[1]) : s.clip ? [s.clip] : [];
      for (const c of clips) if (!resolve(c)) console.warn(`[rigforge] state "${name}" uses missing clip "${c}"`);
    }
    this.enter(def.initial, 0);
  }

  get state(): string {
    return this.current?.name ?? '';
  }

  set(param: string, value: ParamValue): this {
    this.params[param] = value;
    return this;
  }

  trigger(name: string): this {
    this.triggers.add(name);
    return this;
  }

  /** Forces a state change regardless of transitions. */
  go(state: string, fade = 0.2): void {
    this.enter(state, fade);
  }

  onEnter(cb: (to: string, from: string | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Normalized time (0..1) of the current state's main clip. */
  progress(): number {
    const a = this.mainAction();
    if (!a) return 0;
    const d = a.getClip().duration || 1;
    return a.loop === LoopOnce ? Math.min(1, a.time / d) : (a.time % d) / d;
  }

  /** Evaluates transitions and blend weights. Call before mixer.update(). */
  update(): void {
    if (!this.current) return;
    this.updateBlend();
    const finished = this.isFinished();
    for (const t of this.def.transitions) {
      if (t.from !== '*' && t.from !== this.current.name) continue;
      if (t.to === this.current.name && t.from === '*') continue;
      if (t.exitTime !== undefined && this.progress() < t.exitTime && !finished) continue;
      const ok = t.when?.length ? t.when.every((c) => this.test(c)) : t.exitTime !== undefined || finished;
      if (!ok) continue;
      for (const c of t.when ?? []) if ('trigger' in c) this.triggers.delete(c.trigger);
      this.enter(t.to, t.fade ?? 0.2);
      break;
    }
    // Triggers only live for one update.
    this.triggers.clear();
  }

  private test(c: Condition): boolean {
    if ('trigger' in c) return this.triggers.has(c.trigger);
    const v = this.params[c.param];
    switch (c.op) {
      case '>': return (v as number) > (c.value as number);
      case '<': return (v as number) < (c.value as number);
      case '>=': return (v as number) >= (c.value as number);
      case '<=': return (v as number) <= (c.value as number);
      case '==': return v === c.value;
      case '!=': return v !== c.value;
    }
  }

  private mainAction(): AnimationAction | undefined {
    if (!this.current) return undefined;
    const { actions, weights } = this.current;
    let best = 0;
    for (let i = 1; i < actions.length; i++) if (weights[i] > weights[best]) best = i;
    return actions[best];
  }

  private isFinished(): boolean {
    const a = this.mainAction();
    if (!a || a.loop !== LoopOnce) return false;
    return a.time >= a.getClip().duration - 1e-3 || !a.isRunning();
  }

  private speedOf(def: StateDef): number {
    if (typeof def.speed === 'string') return Number(this.params[def.speed] ?? 1);
    return def.speed ?? 1;
  }

  private enter(name: string, fade: number): void {
    const def = this.def.states[name];
    if (!def) {
      console.warn(`[rigforge] unknown state "${name}"`);
      return;
    }
    const from = this.current;
    const clips = def.blend ? def.blend.clips.map((c) => c[1]) : def.clip ? [def.clip] : [];
    const actions = clips.map((c) => this.resolve(c)).filter((a): a is AnimationAction => !!a);
    const loop = def.loop ?? true;
    const next: ActiveState = { name, def, actions, weights: actions.map((_, i) => (i === 0 ? 1 : 0)) };
    for (const a of actions) {
      a.enabled = true;
      a.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      a.reset().play();
    }
    this.current = next;
    this.updateBlend(true);
    // Fade out actions that aren't part of the new state.
    if (from) {
      for (const a of from.actions) {
        if (actions.includes(a)) continue;
        if (fade > 0) a.fadeOut(fade);
        else a.stop();
      }
      if (fade > 0) for (const a of actions) a.fadeIn(fade);
    }
    for (const cb of this.listeners) cb(name, from?.name ?? null);
  }

  /** Sets blend weights from the parameter and keeps blended cycles in phase. */
  private updateBlend(entering = false): void {
    const cur = this.current!;
    const speed = this.speedOf(cur.def);
    if (!cur.def.blend) {
      for (const a of cur.actions) {
        a.setEffectiveTimeScale(speed);
        if (entering) a.weight = 1;
      }
      return;
    }
    const clips = cur.def.blend.clips;
    const x = Number(this.params[cur.def.blend.param] ?? 0);
    const w = clips.map(() => 0);
    if (x <= clips[0][0]) w[0] = 1;
    else if (x >= clips[clips.length - 1][0]) w[clips.length - 1] = 1;
    else {
      for (let i = 0; i < clips.length - 1; i++) {
        const [x0] = clips[i], [x1] = clips[i + 1];
        if (x >= x0 && x <= x1) {
          const f = (x - x0) / (x1 - x0 || 1);
          w[i] = 1 - f;
          w[i + 1] = f;
          break;
        }
      }
    }
    cur.weights = w;
    // Phase sync: blended cycles share a normalized time, and the blended
    // duration drives the playback rate so feet stay in step.
    let dur = 0;
    cur.actions.forEach((a, i) => (dur += w[i] * a.getClip().duration));
    const lead = this.mainAction()!;
    const phase = lead.getClip().duration ? (lead.time % lead.getClip().duration) / lead.getClip().duration : 0;
    cur.actions.forEach((a, i) => {
      // Plain weight assignment: setEffectiveWeight() would cancel crossfades in progress.
      a.weight = w[i];
      const d = a.getClip().duration || 1;
      a.setEffectiveTimeScale(dur > 0 ? (d / dur) * speed : speed);
      if (a !== lead) a.time = phase * d;
    });
  }
}
