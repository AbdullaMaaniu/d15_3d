import { useStore } from '../store';
import { Section } from '../components/ui';
import { propBoneColor } from '../components/PropEditor';

export function PropRigPanel() {
  const rig = useStore((s) => s.propRig);
  const split = useStore((s) => s.propSplit);
  const selected = useStore((s) => s.selectedBone);
  const set = useStore((s) => s.set);
  const addPropBone = useStore((s) => s.addPropBone);
  const updatePropBone = useStore((s) => s.updatePropBone);
  const removePropBone = useStore((s) => s.removePropBone);
  const buildPropRig = useStore((s) => s.buildPropRig);
  const character = useStore((s) => s.character);
  const editParts = useStore((s) => s.editJoints);
  const goto = useStore((s) => s.goto);
  if (!rig || !split) return null;
  if (character) {
    return (
      <>
        <div>
          <h2>Prop rig ready</h2>
          <p>{rig.bones.length} bones. Your clips are re-applied if you change the parts or pivots.</p>
        </div>
        <div className="grid2">
          <button className="btn" onClick={editParts}>← Edit parts</button>
          <button className="btn primary" onClick={() => goto('animate')}>Animate →</button>
        </div>
      </>
    );
  }
  const counts = new Map<string, number>();
  for (const p of split.parts) {
    const b = rig.partBone[p.id] ?? 'root';
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const bone = rig.bones.find((b) => b.name === selected);
  return (
    <>
      <div>
        <h2>Parts &amp; pivots</h2>
        <p>
          Found {split.parts.length} separate part{split.parts.length === 1 ? '' : 's'}. Add a bone for each moving piece, click the parts it should carry, then drag its pivot to the hinge or axle.
        </p>
      </div>
      <Section title="Bones" right={<button className="btn small" onClick={addPropBone}>+ Bone</button>}>
        <div className="library">
          {rig.bones.map((b, i) => (
            <div
              key={b.name}
              className="lib-item"
              style={{ background: b.name === selected ? '#232833' : undefined, cursor: 'pointer' }}
              onClick={() => set('selectedBone', b.name)}
            >
              <div className="row" style={{ gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: `#${propBoneColor(i).getHexString()}`, display: 'inline-block' }} />
                <div>
                  <div className="name">{b.name}</div>
                  <div className="sub">
                    {counts.get(b.name) ?? 0} part{counts.get(b.name) === 1 ? '' : 's'}
                    {b.parent ? ` · child of ${b.parent}` : ' · root'}
                  </div>
                </div>
              </div>
              {b.name !== 'root' && (
                <button className="btn small ghost" aria-label={`Remove ${b.name}`} onClick={(e) => { e.stopPropagation(); removePropBone(b.name); }}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </Section>
      {bone && bone.name !== 'root' && (
        <Section title={`Selected: ${bone.name}`}>
          <div className="grid2">
            <label className="field">
              Name
              <input className="text" defaultValue={bone.name} key={bone.name} onBlur={(e) => updatePropBone(bone.name, { name: e.target.value })} />
            </label>
            <label className="field">
              Parent
              <select className="text" value={bone.parent ?? 'root'} onChange={(e) => updatePropBone(bone.name, { parent: e.target.value })}>
                {rig.bones.filter((b) => b.name !== bone.name).map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid3">
            {(['x', 'y', 'z'] as const).map((axis, k) => (
              <label key={axis} className="field">
                Pivot {axis}
                <input className="text" type="number" step={0.01} value={+bone.pivot[k].toFixed(3)} onChange={(e) => {
                  const p = [...bone.pivot] as [number, number, number];
                  p[k] = parseFloat(e.target.value) || 0;
                  updatePropBone(bone.name, { pivot: p });
                }} />
              </label>
            ))}
          </div>
          <p className="footer-note">Click parts in the view to give them to this bone (click again with “root” selected to take them back).</p>
        </Section>
      )}
      <button className="btn primary block" onClick={buildPropRig} disabled={rig.bones.length < 2}>
        Build rig →
      </button>
    </>
  );
}
