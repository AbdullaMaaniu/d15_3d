import { useStore } from '../store';
import { Check, Section } from '../components/ui';

export function CreatureRigPanel() {
  const bones = useStore((s) => s.creatureBones);
  const selected = useStore((s) => s.selectedBone);
  const set = useStore((s) => s.set);
  const remove = useStore((s) => s.removeCreatureBone);
  const rename = useStore((s) => s.renameCreatureBone);
  const mirror = useStore((s) => s.mirrorCreatureBone);
  const symmetry = useStore((s) => s.symmetry);
  const setSymmetry = useStore((s) => s.setSymmetry);
  const buildRig = useStore((s) => s.buildRig);
  const busy = useStore((s) => s.busy);

  const depth = (name: string): number => {
    const b = bones.find((x) => x.name === name);
    return b?.parent ? 1 + depth(b.parent) : 0;
  };
  // Tree order: parents before their children.
  const ordered: string[] = [];
  const walk = (parent: string | null) => bones.filter((b) => b.parent === parent).forEach((b) => { ordered.push(b.name); walk(b.name); });
  walk(null);
  const sel = bones.find((b) => b.name === selected);

  return (
    <>
      <div>
        <h2>Build a skeleton</h2>
        <p>Select a joint, then click on the model to add a child joint inside the body. Keep clicking to extend a chain (a tail, a leg, a tentacle). Drag joints to adjust them.</p>
      </div>
      <Section title={`Joints (${bones.length})`}>
        <div className="library" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {ordered.map((n) => (
            <div key={n} className="lib-item" style={{ background: n === selected ? '#232833' : undefined, cursor: 'pointer', paddingLeft: 8 + depth(n) * 14 }} onClick={() => set('selectedBone', n)}>
              <span className="name">{n}</span>
              {n !== 'root' && (
                <button className="btn small ghost" aria-label={`Remove ${n}`} onClick={(e) => { e.stopPropagation(); remove(n); }}>✕</button>
              )}
            </div>
          ))}
        </div>
        <Check checked={symmetry} onChange={setSymmetry}>Mirror edits for left/right joints</Check>
      </Section>
      {sel && sel.name !== 'root' && (
        <Section title="Selected joint">
          <label className="field">
            Name (start with “left”/“right” to pair limbs)
            <input className="text" key={sel.name} defaultValue={sel.name} aria-label="Joint name" onBlur={(e) => rename(sel.name, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <button className="btn small" onClick={() => mirror(sel.name)}>Mirror this chain to the other side</button>
        </Section>
      )}
      <button className="btn primary block" disabled={bones.length < 2 || !!busy} onClick={() => void buildRig()}>
        Build rig
      </button>
    </>
  );
}
