import { PRESETS, useStore } from '../store';
import { humanoidDefs, keyCount, type PropMotion } from '@rigforge/core';
import { useMemo, useState } from 'react';
import { Check, FilePicker, Section, Seg } from '../components/ui';

const CATEGORY_ORDER = ['idle', 'locomotion', 'action', 'combat', 'emote'];
const ESSENTIALS = ['idle', 'walk', 'run', 'jump'];

const AXES: Array<[string, [number, number, number]]> = [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]];

function PropMotionSection() {
  const built = useStore((s) => s.character?.built ?? null);
  const bones = useMemo(() => built?.skeleton.bones.map((b) => b.name) ?? [], [built]);
  const addPropMotion = useStore((s) => s.addPropMotion);
  const movable = bones.filter((b) => b !== 'root');
  const [bone, setBone] = useState(movable[0] ?? 'root');
  const [type, setType] = useState<PropMotion['type']>('swing');
  const [axis, setAxis] = useState('X');
  const [amount, setAmount] = useState(90);
  const [duration, setDuration] = useState(1.5);
  const [pingPong, setPingPong] = useState(false);
  const unit = type === 'spin' ? 'turns' : type === 'swing' ? 'degrees' : 'meters';
  const pick = (t: PropMotion['type']) => {
    setType(t);
    setAmount(t === 'spin' ? 1 : t === 'swing' ? 90 : t === 'slide' ? 0.3 : 0.05);
  };
  const add = () => {
    const a = AXES.find((x) => x[0] === axis)![1];
    const m: PropMotion =
      type === 'spin' ? { type, bone, axis: a, turns: amount, duration }
      : type === 'swing' ? { type, bone, axis: a, degrees: amount, duration, pingPong }
      : type === 'slide' ? { type, bone, offset: [a[0] * amount, a[1] * amount, a[2] * amount], duration, pingPong }
      : { type, bone, height: amount, duration };
    const label = { spin: 'Spin', swing: pingPong ? 'Swing' : 'Open', slide: 'Slide', bob: 'Bob' }[type];
    addPropMotion(m, `${label} ${bone}`);
  };
  return (
    <Section title="Add a motion">
      <div className="row">
        <select className="text" style={{ flex: 1 }} value={bone} onChange={(e) => setBone(e.target.value)} aria-label="Motion bone">
          {bones.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <Seg value={type} onChange={pick} options={[['swing', 'Swing'], ['spin', 'Spin'], ['slide', 'Slide'], ['bob', 'Bob']]} />
      </div>
      <div className="row">
        {type !== 'bob' && <Seg value={axis} onChange={setAxis} options={AXES.map(([n]) => [n, n] as [string, string])} />}
        <label className="check">
          <input className="text" type="number" step={type === 'swing' ? 5 : 0.05} value={amount} style={{ width: 70 }} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} aria-label="Amount" /> {unit}
        </label>
        <label className="check">
          <input className="text" type="number" step={0.1} min={0.1} value={duration} style={{ width: 60 }} onChange={(e) => setDuration(Math.max(0.1, parseFloat(e.target.value) || 1))} aria-label="Duration" /> s
        </label>
      </div>
      {(type === 'swing' || type === 'slide') && <Check checked={pingPong} onChange={setPingPong}>Go and come back (loop)</Check>}
      <button className="btn" onClick={add}>+ Add motion</button>
    </Section>
  );
}

function KeyEditSection() {
  const keyEdit = useStore((s) => s.keyEdit);
  const setKeyEdit = useStore((s) => s.setKeyEdit);
  const stop = useStore((s) => s.stopKeyEdit);
  const entry = useStore((s) => s.clips.find((c) => c.id === s.keyEdit.clipId));
  const setClipKeys = useStore((s) => s.setClipKeys);
  const fingers = useStore((s) => s.fingers);
  const hasBinding = useStore((s) => !!s.binding);
  const built = useStore((s) => s.character?.built ?? null);
  const propBones = useMemo(() => (hasBinding ? null : built?.skeleton.bones.map((b) => b.name) ?? null), [hasBinding, built]);
  if (!entry) return null;
  const count = entry.propKeys ? Object.values(entry.propKeys.bones).reduce((n, c) => n + c.times.length, 0) : keyCount(entry.keys);
  const boneNames = propBones ?? humanoidDefs(fingers).map((d) => d.name);
  return (
    <Section title={`Keyframing “${entry.name}”`} right={<button className="btn small active" onClick={stop}>Done</button>}>
      <p className="footer-note">
        Click a bone handle, rotate it with the gizmo and it's keyed at the playhead. <span className="kbd">K</span> key · <span className="kbd">Del</span> delete · <span className="kbd">,</span> <span className="kbd">.</span> step frames.
      </p>
      <div className="row">
        <select className="text" style={{ flex: 1 }} value={keyEdit.bone ?? ''} onChange={(e) => setKeyEdit({ bone: e.target.value || null })} aria-label="Bone">
          {boneNames.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        {(keyEdit.bone === 'hips' || propBones) && (
          <Seg value={keyEdit.mode} onChange={(mode) => setKeyEdit({ mode })} options={[['rotate', 'Rotate'], ['translate', 'Move']]} />
        )}
      </div>
      <div className="row between">
        <Check checked={keyEdit.autoKey} onChange={(autoKey) => setKeyEdit({ autoKey })}>Auto-key</Check>
        {!entry.propKeys && (
          <Seg
            value={entry.keys?.interpolation ?? 'linear'}
            onChange={(v) => setClipKeys(entry.id, { ...(entry.keys ?? { bones: {} }), interpolation: v })}
            options={[['linear', 'Linear'], ['smooth', 'Ease']]}
          />
        )}
      </div>
      <div className="row between">
        <span className="footer-note">{count} key{count === 1 ? '' : 's'}</span>
        {!entry.propKeys && <button className="btn small" disabled={!count} onClick={() => setClipKeys(entry.id, undefined)}>Clear keys</button>}
      </div>
    </Section>
  );
}

function TrimRow({ id }: { id: string }) {
  const c = useStore((s) => s.clips.find((x) => x.id === id))!;
  const active = useStore((s) => s.activeClip === id);
  const time = useStore((s) => s.time);
  const updateClip = useStore((s) => s.updateClip);
  const full = (c.normalized.frames - 1) / c.normalized.fps;
  const [a, b] = c.trim ?? [0, full];
  const set = (na: number, nb: number) => {
    na = Math.max(0, Math.min(na, full));
    nb = Math.max(0, Math.min(nb, full));
    if (nb - na < 0.1) return;
    updateClip(id, { trim: na <= 1e-3 && nb >= full - 1e-3 ? undefined : [na, nb] });
  };
  const playhead = a + (active ? time : 0);
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="src" style={{ width: 30 }}>Trim</span>
      <input className="text" type="number" step={0.05} min={0} max={full} value={+a.toFixed(2)} style={{ width: 62 }} aria-label="Trim start" onChange={(e) => set(parseFloat(e.target.value) || 0, b)} />
      <span className="src">→</span>
      <input className="text" type="number" step={0.05} min={0} max={full} value={+b.toFixed(2)} style={{ width: 62 }} aria-label="Trim end" onChange={(e) => set(a, parseFloat(e.target.value) || full)} />
      <button className="btn small ghost" disabled={!active} title="Start at playhead" onClick={() => set(playhead, b)}>[</button>
      <button className="btn small ghost" disabled={!active} title="End at playhead" onClick={() => set(a, playhead)}>]</button>
      {c.trim && <button className="btn small ghost" title="Reset trim" onClick={() => updateClip(id, { trim: undefined })}>↺</button>}
    </div>
  );
}

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
  const keyEdit = useStore((s) => s.keyEdit);
  const startKeyEdit = useStore((s) => s.startKeyEdit);
  const stopKeyEdit = useStore((s) => s.stopKeyEdit);
  const newClip = useStore((s) => s.newClip);

  const grouped = useMemo(() => {
    const g = new Map<string, typeof PRESETS>();
    for (const p of PRESETS) g.set(p.category, [...(g.get(p.category) ?? []), p]);
    return CATEGORY_ORDER.filter((c) => g.has(c)).map((c) => [c, g.get(c)!] as const);
  }, []);
  const added = new Set(clips.map((c) => c.source));
  const isProp = useStore((s) => s.rigType === 'prop');

  return (
    <>
      <div>
        <h2>Animations</h2>
        <p>{isProp ? 'Spin, swing, slide or bob any part, or keyframe your own motion.' : 'Add motion-captured presets or retarget your own Mixamo FBX, BVH or GLB clips.'}</p>
      </div>

      {keyEdit.clipId && <KeyEditSection />}
      <Section title={`Your clips (${clips.length})`}>
        {clips.length === 0 && <p>{isProp ? 'No clips yet. Add a motion below or keyframe one.' : 'No clips yet. Start with the essentials:'}</p>}
        {clips.length === 0 && !isProp && (
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
              <button className={`btn small ghost${keyEdit.clipId === c.id ? ' active' : ''}`} title="Edit keyframes" aria-label={`Edit keys of ${c.name}`} onClick={() => (keyEdit.clipId === c.id ? stopKeyEdit() : startKeyEdit(c.id))}>◆</button>
              {!c.propKeys && <button className="btn small ghost" title="Mirror left/right" onClick={() => mirror(c.id)}>⇋</button>}
              <button className="btn small ghost" title="Remove" onClick={() => removeClip(c.id)} aria-label={`Remove ${c.name}`}>✕</button>
            </div>
            <div className="row" style={{ gap: 14 }}>
              <Check checked={c.loop} onChange={(v) => updateClip(c.id, { loop: v })}>Loop</Check>
              {!c.propKeys && <Check checked={c.inPlace} onChange={(v) => updateClip(c.id, { inPlace: v })}>In place</Check>}
              <label className="check" title="Playback speed">
                Speed
                <input className="text" type="number" min={0.1} max={4} step={0.1} value={c.speed} style={{ width: 56 }} onChange={(e) => updateClip(c.id, { speed: Math.max(0.1, parseFloat(e.target.value) || 1) })} />
              </label>
            </div>
            {!c.propKeys && <TrimRow id={c.id} />}
            <div className="src">{c.source} · {((c.normalized.frames - 1) / c.normalized.fps).toFixed(1)} s source</div>
          </div>
        ))}
        <div className="grid2">
          {isProp ? <span /> : (
          <FilePicker className="btn" accept=".fbx,.bvh,.glb,.gltf" multiple onFiles={(f) => void addImported(f)}>
            Import clip…
          </FilePicker>
          )}
          <button className="btn" onClick={() => newClip(2)} title="Pose a new clip from scratch with keyframes">
            + Keyframe clip
          </button>
        </div>
        {!isProp && <p className="footer-note">Import Mixamo FBX, BVH or GLB animations; they're retargeted automatically.</p>}
      </Section>

      {isProp && <PropMotionSection />}
      {!isProp && (
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
      )}

      <button className="btn primary block" disabled={!clips.length} onClick={() => goto('export')}>
        Export →
      </button>
    </>
  );
}
