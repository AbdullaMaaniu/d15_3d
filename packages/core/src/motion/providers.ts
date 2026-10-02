import type { NormalizedClip } from '../anim/retarget';
import { compileMotionPlan, type CompileOptions, type LibraryClip, type MotionLibrary } from './compile';
import { motionPlanSchema, sanitizeMotionPlan, type BodyPart, type MotionPlan, type MotionStep } from './plan';
import { POSE_CONTROLS } from './pose';

/** What a provider sees of the library: ids and descriptions, no motion data. */
export type CatalogEntry = Pick<LibraryClip, 'id' | 'name' | 'description' | 'kind' | 'category' | 'seconds' | 'side'>;

export interface MotionRequest {
  prompt: string;
  catalog: CatalogEntry[];
  signal?: AbortSignal;
}

/**
 * A text-to-motion backend. It turns a prompt into a MotionPlan (untrusted:
 * the caller sanitizes it), which RigForge compiles into a clip that retargets
 * onto any humanoid rig. Plug in a new model by implementing `generate`.
 */
export interface MotionProvider {
  id: string;
  label: string;
  generate(request: MotionRequest): Promise<unknown>;
}

export class MotionProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'refused' | 'format' | 'unrecognized' | 'http',
  ) {
    super(message);
    this.name = 'MotionProviderError';
  }
}

export function describeLibrary(lib: MotionLibrary): CatalogEntry[] {
  return [...lib.clips.values()].map(({ id, name, description, kind, category, seconds, side }) => ({ id, name, description, kind, category, seconds, side }));
}

export interface GeneratedMotion {
  plan: MotionPlan;
  clip: NormalizedClip;
}

/** Prompt in, retargetable clip out. */
export async function generateMotion(
  prompt: string,
  provider: MotionProvider,
  lib: MotionLibrary,
  options: CompileOptions & { signal?: AbortSignal } = {},
): Promise<GeneratedMotion> {
  if (!prompt.trim()) throw new MotionProviderError('Describe a motion first, e.g. "walk, then wave with the left hand".', 'unrecognized');
  const raw = await provider.generate({ prompt: prompt.trim(), catalog: describeLibrary(lib), signal: options.signal });
  const plan = sanitizeMotionPlan(raw, lib.clips.keys());
  return { plan, clip: compileMotionPlan(plan, lib, options) };
}

// ---------------------------------------------------------------------------
// Mock provider (tests, demos).

export function createMockMotionProvider(respond: unknown | ((request: MotionRequest) => unknown)): MotionProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'mock',
    label: 'Mock',
    calls,
    async generate(request) {
      calls.push(request.prompt);
      return typeof respond === 'function' ? (respond as (r: MotionRequest) => unknown)(request) : respond;
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in provider: understands a fixed vocabulary, runs offline, no key.

const VOCAB: Array<[string, RegExp]> = [
  ['walk_backward', /\b(walk(s|ing)? backwards?|backs? up|backing up|backpedal\w*|moonwalk\w*)\b/],
  ['strafe', /\b(strafe\w*|side ?steps?|side ?stepping|walk(s|ing)? sideways)\b/],
  ['crouch_walk', /\b(crouch(es|ed|ing)? walk\w*|walk(s|ing)? crouch\w*|crawl\w*)\b/],
  ['sneak', /\b(sneak\w*|tip ?toe\w*|creep\w*|stealth\w*|prowl\w*)\b/],
  ['run', /\b(run|runs|running|jog|jogs|jogging|sprint\w*|dash\w*|race|races)\b/],
  ['walk', /\b(walk|walks|walking|stroll\w*|march\w*|pace|pacing|step forward)\b/],
  ['idle', /\b(idle|idling|stand(s|ing)? (still|around|idle)|wait(s|ing)?|breath(e|es|ing)|rest(s|ing)?)\b/],
  ['jump', /\b(jump\w*|hop|hops|hopping|leap\w*)\b/],
  ['pick_up', /\b(pick(s|ing)? (\w+ ){0,2}up|pickup|bend(s|ing)? down)\b/],
  ['death', /\b(die|dies|dying|death|dead|collapse\w*|falls? (down|over)|falling down|faint\w*)\b/],
  ['cross_arms', /\b(cross(es|ed|ing)? (\w+ )?arms|arms (are )?crossed|fold(s|ed|ing)? (\w+ )?arms)\b/],
  ['hands_on_hips', /\b(hands? on (\w+ )?hips|akimbo)\b/],
  ['raise_hand', /\b(raise[sd]? (a |one |his |her |their |your |the )?hand|hand up|asks? a question)\b/],
  ['shake_head', /\b(shak\w* (\w+ )?head|head ?shake|says? no|disagree\w*)\b/],
  ['look_around', /\b(look(s|ing)? around|search\w*|scan(s|ning)?)\b/],
  ['fist_pump', /\b(fist ?pump\w*|pumps? (\w+ )?fist|victory|triumph\w*)\b/],
  ['facepalm', /\b(face ?palm\w*|dismay\w*|embarrass\w*|cringe\w*)\b/],
  ['cheer', /\b(cheer\w*|celebrat\w*|hooray|hurray|arms up|hands up|raise[sd]? both)\b/],
  ['wave', /\b(wave|waves|waving|hello|hi|greet\w*|goodbye|bye)\b/],
  ['wave_hand', /\b(one[- ]handed wave)\b/],
  ['bow', /\b(theatrical bow|curtain call)\b/],
  ['bow_polite', /\b(bow|bows|bowing|bowed)\b/],
  ['shrug', /\b(shrug\w*|dunno|don'?t know)\b/],
  ['stretch', /\b(stretch\w*|yawn\w*)\b/],
  ['dance', /\b(danc\w*|macarena|groov\w*|boogie)\b/],
  ['punch', /\b(punch\w*|box|boxing|jab\w*|hits?|strikes?|fight\w*)\b/],
  ['kick', /\b(kick\w*)\b/],
  ['throw', /\b(throw\w*|toss\w*|pitch\w*)\b/],
  ['clap', /\b(clap\w*|applau\w*)\b/],
  ['point', /\b(point\w*)\b/],
  ['salute', /\b(salut\w*)\b/],
  ['nod', /\b(nod|nods|nodding|nodded|agree\w*)\b/],
  ['think', /\b(think\w*|ponder\w*|wonder\w*|hmm+|thought\w*)\b/],
  ['squat', /\b(squat\w*|duck|ducks|ducking)\b/],
  ['kneel', /\b(kneel\w*|knelt|propos\w*)\b/],
];

/** Gestures that can play on part of the body during locomotion. */
const OVERLAY_PART: Record<string, BodyPart> = {
  wave: 'rightArm', wave_hand: 'rightArm', point: 'rightArm', salute: 'rightArm', raise_hand: 'rightArm', fist_pump: 'rightArm', think: 'arms', facepalm: 'rightArm',
  clap: 'arms', cheer: 'arms', cross_arms: 'arms', hands_on_hips: 'arms',
  nod: 'head', shake_head: 'head', look_around: 'head', shrug: 'upperBody',
};

const NUMBERS: Record<string, number> = { once: 1, one: 1, twice: 2, two: 2, thrice: 3, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1 };

function clauseModifiers(text: string): Pick<MotionStep, 'speed' | 'repeat' | 'seconds' | 'side'> {
  const out: Pick<MotionStep, 'speed' | 'repeat' | 'seconds' | 'side'> = {};
  const very = /\b(very|really|super|extremely)\b/.test(text);
  if (/\b(slow(ly)?|leisurely|gentl[ey]|lazy|lazily|tired(ly)?|calm(ly)?|casual(ly)?)\b/.test(text)) out.speed = very ? 0.6 : 0.78;
  if (/\b(fast|quick(ly)?|rapid(ly)?|brisk(ly)?|hurried(ly)?|energetic(ally)?|excited(ly)?|hurry)\b/.test(text)) out.speed = very ? 1.6 : 1.3;
  const times = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:x|times?)\b|\b(once|twice|thrice)\b/.exec(text);
  if (times) out.repeat = Math.min(10, +(NUMBERS[times[1] ?? times[2]] ?? times[1]) || 1);
  const secs = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a)\s*(s|secs?|seconds?)\b/.exec(text);
  if (secs) out.seconds = +(NUMBERS[secs[1]] ?? secs[1]);
  else if (/\b(a while|a bit|for long|a long time)\b/.test(text)) out.seconds = 6;
  if (/\bleft\b/.test(text)) out.side = 'left';
  else if (/\bright (hand|arm|leg|foot)\b|\bwith (the |his |her |their |your )?right\b/.test(text)) out.side = 'right';
  return out;
}

function findMotions(text: string): Array<{ id: string; at: number }> {
  const taken: Array<[number, number]> = [];
  const found: Array<{ id: string; at: number }> = [];
  for (const [id, re] of VOCAB) {
    const g = new RegExp(re.source, 'g');
    for (let m = g.exec(text); m; m = g.exec(text)) {
      const a = m.index, b = a + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      taken.push([a, b]);
      if (!found.some((f) => f.id === id)) found.push({ id, at: a });
    }
  }
  return found.sort((x, y) => x.at - y.at);
}

function titleCase(prompt: string): string {
  const words = prompt.replace(/[^a-z0-9' ]/gi, ' ').split(/\s+/).filter((w) => w && !/^(a|an|the|and|then|with|while|for|to|of|in|on|his|her|their|your|my|it|is|character)$/i.test(w));
  return words.slice(0, 4).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Generated';
}

/** Parses a prompt into a plan with the built-in vocabulary (exported for tests). */
export function planFromText(prompt: string, catalog: CatalogEntry[]): MotionPlan {
  const text = prompt.toLowerCase().replace(/[’`]/g, "'");
  const known = new Map(catalog.map((c) => [c.id, c]));
  const clauses = text.split(/\b(?:and then|then|after that|afterwards|followed by|next|finally|before that)\b|[,;.!?]+/);
  const steps: MotionStep[] = [];
  for (const clause of clauses) {
    const motions = findMotions(clause).filter((m) => known.has(m.id));
    if (!motions.length) continue;
    const mods = clauseModifiers(clause);
    // The Wave preset uses both hands; a named hand or a wave on the move uses the one-handed gesture.
    for (const m of motions) if (m.id === 'wave' && known.has('wave_hand') && (mods.side || motions.some((o) => known.get(o.id)?.kind === 'loop'))) m.id = 'wave_hand';
    const isLoop = (id: string) => known.get(id)!.kind === 'loop';
    const base = motions.find((m) => isLoop(m.id));
    const overlays = base ? motions.filter((m) => m !== base && OVERLAY_PART[m.id]) : [];
    if (base && overlays.length) {
      // "wave while walking": the gesture plays on the arms during the walk.
      const o = overlays[0];
      const part = OVERLAY_PART[o.id];
      const side = mods.side;
      const partFor: BodyPart = part === 'rightArm' && side === 'left' ? 'leftArm' : part;
      steps.push({ clip: base.id, ...(mods.speed ? { speed: mods.speed } : {}), seconds: mods.seconds ?? Math.max(4, known.get(o.id)!.seconds + 1), overlay: { clip: o.id, part: partFor, ...(side ? { side } : {}), ...(mods.repeat ? { repeat: mods.repeat } : {}) } });
      for (const m of motions) if (m !== base && m !== o) steps.push({ clip: m.id });
      continue;
    }
    for (const [i, m] of motions.entries()) {
      // Modifiers in a clause apply to its first motion ("jump twice and wave").
      const step: MotionStep = { clip: m.id };
      if (i === 0 || motions.length === 1) Object.assign(step, mods);
      if (isLoop(m.id)) delete step.repeat;
      else if (step.seconds && step.seconds < known.get(m.id)!.seconds) delete step.seconds;
      steps.push(step);
    }
  }
  if (!steps.length) {
    throw new MotionProviderError(
      `No motion recognised in "${prompt.trim()}". The built-in generator knows words like walk, run, sneak, jump, wave, clap, bow, dance, kneel and nod; add a Claude API key for free-form prompts.`,
      'unrecognized',
    );
  }
  const wantsLoop = /\b(loop\w*|cycle|forever|repeatedly|continuous(ly)?|on repeat)\b/.test(text);
  const single = steps.length === 1 && !steps[0].overlay && known.get(steps[0].clip!)?.kind === 'loop' && !steps[0].seconds;
  return { name: titleCase(prompt), loop: wantsLoop || single, steps };
}

export const builtinMotionProvider: MotionProvider = {
  id: 'builtin',
  label: 'Built-in',
  async generate({ prompt, catalog }) {
    return planFromText(prompt, catalog);
  },
};

// ---------------------------------------------------------------------------
// Claude provider: free-form prompts, composing library clips and new gestures.

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

export interface ClaudeProviderOptions {
  apiKey: string;
  model?: string;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  baseURL?: string;
}

export function motionSystemPrompt(catalog: CatalogEntry[]): string {
  const clips = catalog
    .map((c) => `- ${c.id}: ${c.description} (${c.kind === 'loop' ? `loop, ${c.seconds}s cycle` : `${c.seconds}s`}${c.side !== 'both' ? `, ${c.side} side` : ''})`)
    .join('\n');
  const controls = Object.entries(POSE_CONTROLS).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `You turn a description of a character's motion into a motion plan for RigForge, a tool that animates rigged humanoid characters.

A plan is a list of steps played one after another and blended together. Each step plays one clip from the library below, or, only when nothing in the library fits, custom pose keys. A step can also overlay a second motion on part of the body (for example, waving with the right arm while walking).

Library clips. Loops play for "seconds" (cycles are repeated); one-shots play once, or "repeat" times. Clips marked "right side" or "left side" do the action with that hand or leg; set "side" to mirror them.
${clips}

Custom pose keys: each key has a time "t" in seconds and joint angles in degrees. The character faces forward, "left" means the character's own left. At t = 0 every joint is in a relaxed standing pose (arms hanging, all angles 0) and a joint keeps its last value until a later key changes it. Joints:
${controls}

Guidelines:
- Prefer library clips; they are motion capture and look natural. Use keys for gestures the library lacks.
- Never make the character walk or step with keys; the feet would slide. Use the locomotion clips for travel.
- Write keys like an animator: a short anticipation, overshoot slightly and settle, and keep each move between 0.25 and 0.8 seconds. Start and end near the relaxed pose so steps blend.
- Keys only move what you name, the rest of the body keeps a natural idle.
- Set "loop" to true only for motions meant to cycle forever, like an idle or a walk cycle.
- Keep the whole plan under 15 seconds unless asked otherwise.

Example: "walk forward waving, then bow" ->
{"name":"Wave And Bow","loop":false,"steps":[{"clip":"walk","seconds":4,"overlay":{"clip":"wave","part":"rightArm"}},{"clip":"bow"}]}

Example: "shield your eyes from the sun and look into the distance" ->
{"name":"Look Far","loop":false,"steps":[{"keys":[{"t":0.5,"pose":[{"control":"rightArmLift","degrees":105},{"control":"rightArmForward","degrees":60},{"control":"rightElbow","degrees":125},{"control":"rightForearmRoll","degrees":0},{"control":"headNod","degrees":-8}]},{"t":1.5,"pose":[{"control":"headTurn","degrees":25},{"control":"spineTwist","degrees":10}]},{"t":2.6,"pose":[{"control":"headTurn","degrees":-15},{"control":"spineTwist","degrees":-5}]},{"t":3.3,"pose":[{"control":"rightArmLift","degrees":4},{"control":"rightArmForward","degrees":0},{"control":"rightElbow","degrees":10},{"control":"rightForearmRoll","degrees":0},{"control":"headNod","degrees":0},{"control":"headTurn","degrees":0},{"control":"spineTwist","degrees":0}]}]}]}`;
}

export function claudeMotionProvider(options: ClaudeProviderOptions): MotionProvider {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  return {
    id: 'claude',
    label: 'Claude',
    async generate({ prompt, catalog, signal }) {
      if (!options.apiKey?.trim()) throw new MotionProviderError('A Claude API key is required (create one at console.anthropic.com).', 'auth');
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      // The key is the user's own, typed into their browser; RigForge has no server.
      const client = new Anthropic({ apiKey: options.apiKey.trim(), dangerouslyAllowBrowser: true, fetch: options.fetch, baseURL: options.baseURL, maxRetries: 1 });
      let response;
      try {
        response = await client.beta.messages.create(
          {
            model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'medium', format: { type: 'json_schema', schema: motionPlanSchema(catalog.map((c) => c.id)) } },
            system: motionSystemPrompt(catalog),
            messages: [{ role: 'user', content: prompt }],
          },
          { signal },
        );
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new MotionProviderError('Claude rejected the API key.', 'auth');
        if (e instanceof Anthropic.RateLimitError) throw new MotionProviderError('Claude is rate limiting this key. Try again in a moment.', 'http');
        if (e instanceof Anthropic.APIConnectionError) throw new MotionProviderError(`Could not reach the Claude API (${(e as Error).message}).`, 'network');
        if (e instanceof Anthropic.APIError) throw new MotionProviderError(`Claude API error ${e.status ?? ''}: ${e.message}`.trim(), 'http');
        throw e;
      }
      if (response.stop_reason === 'refusal') throw new MotionProviderError('Claude declined this prompt. Try describing the motion differently.', 'refused');
      if (response.stop_reason === 'max_tokens') throw new MotionProviderError('The motion was too long to generate. Try a shorter description.', 'format');
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      try {
        return JSON.parse(text);
      } catch {
        throw new MotionProviderError('Claude returned a motion plan that could not be read.', 'format');
      }
    },
  };
}
