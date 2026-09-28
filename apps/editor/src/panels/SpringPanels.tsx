import { useMemo, useState } from 'react';
import { skeletonDefs, useStore } from '../store';
import { Check, Section } from '../components/ui';

/** Before building: add chains of joints for hair, capes, ears or tails by clicking the mesh. */
export function AccessorySection() {
  const extra = useStore((s) => s.extraBones);
  const mode = useStore((s) => s.accessoryMode);
  const selected = useStore((s) => s.selectedBone);
  const set = useStore((s) => s.set);
  const remove = useStore((s) => s.removeAccessoryChain);
  const roots = extra.filter((b) => !extra.some((x) => x.name === b.parent));
  const chainLength = (root: string) => {
    let n = 1;
    for (let cur = root; ; n++) {
      const next = extra.find((x) => x.parent === cur);
      if (!next) return n;
      cur = next.name;
    }
  };
  return (
    <Section
      title="Accessory bones"
      right={
        <button className={`btn small${mode ? ' active' : ''}`} onClick={() => set('accessoryMode', !mode)}>
          {mode ? 'Done adding' : '+ Add chain'}
        </button>
      }
    >
      {!mode && !roots.length && <p>Hair, capes, ears or tails that should swing? Give them their own bones and they'll get spring physics.</p>}
      {mode && (
        <p className="footer-note">
          Select the bone to attach to (e.g. <strong style={{ color: 'var(--text)' }}>head</strong> for hair), then click along the hair or cape from root to tip. Attaching to: <strong style={{ color: 'var(--text)' }}>{selected ?? 'nothing selected'}</strong>
        </p>
      )}
      {mode && (
        <select className="text" value={selected ?? ''} onChange={(e) => set('selectedBone', e.target.value)} aria-label="Attach to bone">
          <option value="" disabled>Attach to…</option>
          {skeletonDefs().map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
      )}
      {roots.map((r) => (
        <div key={r.name} className="lib-item">
          <div>
            <div className="name">{r.name.replace(/1$/, '')}</div>
            <div className="sub">{chainLength(r.name)} joints · on {r.parent}</div>
          </div>
          <button className="btn small ghost" aria-label={`Remove ${r.name}`} onClick={() => remove(r.name)}>✕</button>
        </div>
      ))}
    </Section>
  );
}

/** After building: tune spring chains and preview them. */
export function SpringSection() {
  const springs = useStore((s) => s.springs);
  const preview = useStore((s) => s.springPreview);
  const set = useStore((s) => s.set);
  const setChain = useStore((s) => s.setSpringChain);
  const addChain = useStore((s) => s.addSpringChain);
  const removeChain = useStore((s) => s.removeSpringChain);
  const built = useStore((s) => s.character?.built ?? null);
  const names = useMemo(() => built?.skeleton.bones.map((b) => b.name) ?? [], [built]);
  const [start, setStart] = useState('');
  if (!built) return null;
  return (
    <Section title="Secondary motion" right={<Check checked={preview} onChange={(v) => set('springPreview', v)}>Preview</Check>}>
      {!springs.chains.length && <p>No spring chains. Add one on any bone chain (a tail, hair, a cape) to make it swing.</p>}
      {springs.chains.map((c, i) => (
        <div key={`${c.name}-${i}`} className="clip">
          <div className="title">
            <strong style={{ flex: 1 }}>{c.name ?? c.bones[0]}</strong>
            <span className="src">{c.bones.length} bones</span>
            <button className="btn small ghost" aria-label={`Remove spring ${c.name}`} onClick={() => removeChain(i)}>✕</button>
          </div>
          {([['stiffness', 'Stiffness', 0, 4, 0.1], ['damping', 'Damping', 0, 1, 0.05], ['gravity', 'Gravity', 0, 3, 0.05]] as const).map(([k, label, min, max, step]) => (
            <label key={k} className="field">
              {label}: {(c[k] ?? 0).toFixed(2)}
              <input type="range" min={min} max={max} step={step} value={c[k] ?? 0} onChange={(e) => setChain(i, { [k]: +e.target.value })} aria-label={`${label} of ${c.name}`} />
            </label>
          ))}
        </div>
      ))}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <select className="text" style={{ flex: 1 }} value={start} onChange={(e) => setStart(e.target.value)} aria-label="Spring chain start">
          <option value="">Start a chain at…</option>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button className="btn small" disabled={!start} onClick={() => { addChain(start); setStart(''); }}>+ Spring</button>
      </div>
      {springs.colliders?.length ? <p className="footer-note">{springs.colliders.length} body colliders keep chains out of the torso and head.</p> : null}
    </Section>
  );
}
