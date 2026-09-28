import { useMemo } from 'react';
import { PRESETS, useStore } from '../store';
import { Check, FilePicker, Section } from '../components/ui';

const CATEGORY_ORDER = ['idle', 'locomotion', 'action', 'combat', 'emote'];
const ESSENTIALS = ['idle', 'walk', 'run', 'jump'];

export function AnimatePanel() {
  const clips = useStore((s) => s.clips);
  const activeClip = useStore((s) => s.activeClip);
  const addPreset = useStore((s) => s.addPreset);
  const addImported = useStore((s) => s.addImportedClips);
  const updateClip = useStore((s) => s.updateClip);
  const removeClip = useStore((s) => s.removeClip);
  const mirror = useStore((s) => s.mirror);
  const play = useStore((s) => s.play);
  const goto = useStore((s) => s.goto);

  const grouped = useMemo(() => {
    const g = new Map<string, typeof PRESETS>();
    for (const p of PRESETS) g.set(p.category, [...(g.get(p.category) ?? []), p]);
    return CATEGORY_ORDER.filter((c) => g.has(c)).map((c) => [c, g.get(c)!] as const);
  }, []);
  const added = new Set(clips.map((c) => c.source));

  return (
    <>
      <div>
        <h2>Animations</h2>
        <p>Add motion-captured presets or retarget your own Mixamo FBX, BVH or GLB clips.</p>
      </div>

      <Section title={`Your clips (${clips.length})`}>
        {clips.length === 0 && <p>No clips yet. Start with the essentials:</p>}
        {clips.length === 0 && (
          <button className="btn" onClick={() => ESSENTIALS.forEach((id) => addPreset(id))}>
            + Idle, Walk, Run, Jump
          </button>
        )}
        {clips.map((c) => (
          <div key={c.id} className={`clip${c.id === activeClip ? ' active' : ''}`}>
            <div className="title">
              <button className="btn small iconbtn" title="Play" onClick={() => play(c.id)} aria-label={`Play ${c.name}`}>
                ▶
              </button>
              <input className="name" value={c.name} aria-label="Clip name" onChange={(e) => updateClip(c.id, { name: e.target.value })} />
              <button className="btn small ghost" title="Mirror left/right" onClick={() => mirror(c.id)}>⇋</button>
              <button className="btn small ghost" title="Remove" onClick={() => removeClip(c.id)} aria-label={`Remove ${c.name}`}>✕</button>
            </div>
            <div className="row" style={{ gap: 14 }}>
              <Check checked={c.loop} onChange={(v) => updateClip(c.id, { loop: v })}>Loop</Check>
              <Check checked={c.inPlace} onChange={(v) => updateClip(c.id, { inPlace: v })}>In place</Check>
              <label className="check" title="Playback speed">
                Speed
                <input className="text" type="number" min={0.1} max={4} step={0.1} value={c.speed} style={{ width: 56 }} onChange={(e) => updateClip(c.id, { speed: Math.max(0.1, parseFloat(e.target.value) || 1) })} />
              </label>
            </div>
            <div className="src">{c.source} · {(c.normalized.frames / c.normalized.fps).toFixed(1)} s</div>
          </div>
        ))}
        <FilePicker className="btn" accept=".fbx,.bvh,.glb,.gltf" multiple onFiles={(f) => void addImported(f)}>
          Import clip (Mixamo FBX, BVH, GLB)…
        </FilePicker>
      </Section>

      <Section title="Preset library">
        <div className="library">
          {grouped.map(([cat, items]) => (
            <div key={cat}>
              <div className="tag" style={{ display: 'inline-block', margin: '6px 0 2px' }}>{cat}</div>
              {items.map((p) => (
                <div key={p.id} className="lib-item">
                  <div>
                    <div className="name">{p.name} {p.loop && <span className="tag">loop</span>}</div>
                    <div className="sub">{p.description}</div>
                  </div>
                  <button className="btn small" onClick={() => addPreset(p.id)}>
                    {added.has(p.source ?? '') ? '+ again' : '+ Add'}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="footer-note">
          Motion data from the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), free for commercial use.
        </p>
      </Section>

      <button className="btn primary block" disabled={!clips.length} onClick={() => goto('export')}>
        Export →
      </button>
    </>
  );
}
