import { useMemo } from 'react';
import { suggestController, useStore } from '../store';
import { Section } from '../components/ui';
import type { ControllerSetup } from '@rigforge/three';

/** Which clip is idle / walk / run / jump / an action, saved into the GLB for autoStateMachine(). */
export function ControllerSection() {
  const clips = useStore((s) => s.clips);
  const stored = useStore((s) => s.controller);
  const set = useStore((s) => s.set);
  const suggested = useMemo(() => suggestController(), [clips]);
  const setup: ControllerSetup = stored && valid(stored, clips.map((c) => c.name)) ? stored : suggested;
  const names = clips.map((c) => c.name);
  const update = (next: ControllerSetup) => set('controller', next);
  const loco = setup.locomotion;
  const inLoco = new Set(loco.map((l) => l[1]));

  return (
    <Section title="Game controller" right={stored ? <button className="btn small ghost" onClick={() => set('controller', null)}>Reset</button> : undefined}>
      <p className="footer-note">Saved in the file: <code>character.autoStateMachine()</code> blends these by speed and fires jump/actions by trigger.</p>
      {loco.map(([speed, clip], i) => (
        <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
          <select className="text" style={{ flex: 1 }} value={clip} aria-label={`Locomotion clip ${i + 1}`} onChange={(e) => update({ ...setup, locomotion: loco.map((l, j) => (j === i ? [l[0], e.target.value] : l)) })}>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input className="text" type="number" min={0} step={0.1} value={speed} style={{ width: 64 }} aria-label={`Speed of ${clip}`} disabled={i === 0}
            onChange={(e) => update({ ...setup, locomotion: loco.map((l, j) => (j === i ? [Math.max(0, +e.target.value), l[1]] : l)) })} />
          <span className="src">m/s</span>
          {loco.length > 1 && <button className="btn small ghost" aria-label={`Remove ${clip} from locomotion`} onClick={() => update({ ...setup, locomotion: loco.filter((_, j) => j !== i) })}>✕</button>}
        </div>
      ))}
      {names.some((n) => !inLoco.has(n)) && (
        <select className="text" value="" aria-label="Add locomotion clip" onChange={(e) => e.target.value && update({ ...setup, locomotion: [...loco, [(loco[loco.length - 1]?.[0] ?? 0) + 1.5, e.target.value] as [number, string]].sort((a, b) => a[0] - b[0]) })}>
          <option value="">+ Add a speed step…</option>
          {names.filter((n) => !inLoco.has(n)).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      )}
      <label className="field">
        Jump
        <select className="text" value={setup.jump ?? ''} aria-label="Jump clip" onChange={(e) => update({ ...setup, jump: e.target.value || undefined })}>
          <option value="">None</option>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="field">
        Actions (trigger name → clip)
        {Object.entries(setup.actions ?? {}).map(([k, v]) => (
          <div key={k} className="row" style={{ flexWrap: 'nowrap' }}>
            <code style={{ flex: 1 }}>{k}</code>
            <span className="src">{v}</span>
            <button className="btn small ghost" aria-label={`Remove action ${k}`} onClick={() => { const a = { ...setup.actions }; delete a[k]; update({ ...setup, actions: a }); }}>✕</button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function valid(c: ControllerSetup, names: string[]) {
  const has = (n?: string) => !n || names.includes(n);
  return c.locomotion.every(([, n]) => names.includes(n)) && has(c.jump) && Object.values(c.actions ?? {}).every((n) => names.includes(n));
}
