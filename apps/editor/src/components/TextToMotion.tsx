import { useState } from 'react';
import { builtinMotionProvider, claudeMotionProvider, type MotionPlan } from '@rigforge/core';
import { getMotionLibrary, useStore } from '../store';
import { Check, Section, Seg } from './ui';

const KEY = 'rigforge.claudeKey';
const ENGINE = 'rigforge.motionEngine';

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

const EXAMPLES = ['Walk for 4 seconds, then wave with the left hand', 'Wave while walking', 'Squat, then cheer', 'Sneak slowly, then look around'];

/** "Walk 4 s → Wave (One Hand), left → Jump ×2" */
function summarize(plan: MotionPlan): string {
  const lib = getMotionLibrary();
  return plan.steps
    .map((s) => {
      const name = s.clip ? lib.clips.get(s.clip)?.name ?? s.clip : `Custom pose (${s.keys?.length ?? 0} keys)`;
      const bits = [name];
      if (s.side) bits.push(s.side);
      if (s.repeat && s.repeat > 1) bits.push(`×${s.repeat}`);
      if (s.seconds) bits.push(`${+s.seconds.toFixed(1)} s`);
      if (s.speed && s.speed !== 1) bits.push(`${s.speed < 1 ? 'slow' : 'fast'}`);
      const over = s.overlay ? ` + ${s.overlay.clip ? lib.clips.get(s.overlay.clip)?.name ?? s.overlay.clip : 'custom'} on ${s.overlay.part.replace(/([A-Z])/g, ' $1').toLowerCase()}` : '';
      return bits.join(' ') + over;
    })
    .join(' → ');
}

/** Type a prompt, get a clip: the built-in vocabulary offline, or Claude for anything. */
export function TextToMotion() {
  const generate = useStore((s) => s.generateMotion);
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState<'builtin' | 'claude'>(() => (read(ENGINE) === 'claude' ? 'claude' : 'builtin'));
  const [key, setKey] = useState(() => read(KEY));
  const [remember, setRemember] = useState(() => !!read(KEY));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const pickEngine = (e: 'builtin' | 'claude') => {
    setEngine(e);
    write(ENGINE, e);
    setError(null);
  };

  const run = async () => {
    setError(null);
    setLast(null);
    setStatus(engine === 'claude' ? 'Asking Claude for a motion…' : 'Composing motion…');
    try {
      if (engine === 'claude') write(KEY, remember ? key.trim() : null);
      const provider = engine === 'claude' ? claudeMotionProvider({ apiKey: key }) : builtinMotionProvider;
      const plan = await generate(prompt, provider);
      setLast(summarize(plan));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStatus(null);
    }
  };

  return (
    <Section title="Generate from text">
      <textarea
        className="text"
        rows={2}
        value={prompt}
        placeholder="Describe a motion, e.g. walk forward, then bow"
        aria-label="Motion prompt"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim() && !status) void run();
          e.stopPropagation();
        }}
        style={{ width: '100%', resize: 'vertical' }}
      />
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        {EXAMPLES.map((x) => (
          <button key={x} className="btn small ghost" onClick={() => setPrompt(x)}>{x}</button>
        ))}
      </div>
      <div className="row between">
        <Seg value={engine} onChange={pickEngine} options={[['builtin', 'Built-in'], ['claude', 'Claude']]} />
        <button className="btn" disabled={!prompt.trim() || !!status || (engine === 'claude' && !key.trim())} onClick={() => void run()}>
          Generate
        </button>
      </div>
      {engine === 'claude' && (
        <>
          <input
            className="text"
            type="password"
            value={key}
            placeholder="Claude API key (sk-ant-…)"
            aria-label="Claude API key"
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <Check checked={remember} onChange={setRemember}>Remember the key in this browser</Check>
          <p className="footer-note">Claude reads any description and composes the presets with new gestures. Your key goes only to the Claude API, from this browser.</p>
        </>
      )}
      {engine === 'builtin' && (
        <p className="footer-note">Works offline with words like walk, run, sneak, jump, wave, clap, bow, dance, kneel, nod, "then" and "while".</p>
      )}
      {status && <div className="busy"><div className="spinner" />{status}</div>}
      {error && <p className="error" role="alert">{error}</p>}
      {last && <p className="footer-note" data-testid="motion-plan">Added: {last}</p>}
    </Section>
  );
}
