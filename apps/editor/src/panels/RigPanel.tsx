import { useEffect } from 'react';
import { humanoidDefs } from '@rigforge/core';
import { PRESETS, useStore } from '../store';
import { Check, Notes, Section, Seg } from '../components/ui';

export function RigPanel() {
  const detection = useStore((s) => s.detection);
  const joints = useStore((s) => s.joints);
  const busy = useStore((s) => s.busy);
  const fingers = useStore((s) => s.fingers);
  const setFingers = useStore((s) => s.setFingers);
  const symmetry = useStore((s) => s.symmetry);
  const setSymmetry = useStore((s) => s.setSymmetry);
  const symmetrize = useStore((s) => s.symmetrize);
  const runDetection = useStore((s) => s.runDetection);
  const showFingerMarkers = useStore((s) => s.showFingerMarkers);
  const settings = useStore((s) => s.weightSettings);
  const setSettings = useStore((s) => s.setWeightSettings);
  const buildRig = useStore((s) => s.buildRig);
  const character = useStore((s) => s.character);
  const editJoints = useStore((s) => s.editJoints);
  const testClip = useStore((s) => s.testClip);
  const setTestClip = useStore((s) => s.setTestClip);
  const timings = useStore((s) => s.rigTimings);
  const kernel = useStore((s) => s.kernel);
  const selectedBone = useStore((s) => s.selectedBone);
  const goto = useStore((s) => s.goto);
  const set = useStore((s) => s.set);

  if (character) {
    const testId = testClip ? PRESETS.find((p) => testClip.name === `test:${p.name}`)?.id ?? '' : '';
    return (
      <>
        <div>
          <h2>Rig ready</h2>
          <p>Check how the mesh deforms. Switch to the weights view to inspect each bone's influence.</p>
        </div>
        <Section title="Pose test">
          <select className="text" value={testId} onChange={(e) => { useStore.getState().setPaint({ active: false }); setTestClip(e.target.value || null); }}>
            <option value="">Bind pose</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Section>
        <PaintSection />
        <Section title="Inspect weights">
          <select
            className="text"
            value={selectedBone ?? ''}
            onChange={(e) => {
              set('selectedBone', e.target.value || null);
              set('shading', 'weights');
            }}
          >
            <option value="">All bones (colored regions)</option>
            {humanoidDefs(fingers).map((d) => (
              <option key={d.name} value={d.name}>{d.name}</option>
            ))}
          </select>
          {timings && (
            <p className="footer-note">
              Rigged in {(timings.total / 1000).toFixed(1)} s using the {kernel === 'wasm' ? 'Rust/WASM' : 'TypeScript'} kernel.
            </p>
          )}
        </Section>
        <div className="grid2">
          <button className="btn" onClick={editJoints}>← Edit joints</button>
          <button className="btn primary" onClick={() => goto('animate')}>Add animations →</button>
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        <h2>Joints</h2>
        <p>Drag the markers so each sits inside the body at the joint. Blue is the character's left, orange its right.</p>
      </div>
      {detection && !busy && (
        <Section title={`Detected (${detection.pose}-pose)`} right={<span className="tag">{Math.round(detection.confidence * 100)}% confident</span>}>
          <Notes items={detection.notes.length ? detection.notes : ['All joints found. Give them a quick check.']} ok={!detection.notes.length} />
          {detection.fingers && (
            <p className="footer-note">
              Fingers: left {detection.fingers.left.method === 'detected' ? 'detected' : 'estimated'}, right {detection.fingers.right.method === 'detected' ? 'detected' : 'estimated'}.
            </p>
          )}
        </Section>
      )}
      <Section title="Markers">
        <Check checked={symmetry} onChange={setSymmetry}>Mirror edits to the other side</Check>
        <Check checked={fingers} onChange={setFingers}>Finger bones (15 per hand)</Check>
        {fingers && (
          <Check checked={showFingerMarkers} onChange={(v) => set('showFingerMarkers', v)}>Show finger markers</Check>
        )}
        <div className="grid3">
          <button className="btn small" onClick={() => symmetrize('left')} disabled={!joints}>Left → right</button>
          <button className="btn small" onClick={() => symmetrize('right')} disabled={!joints}>Right → left</button>
          <button className="btn small" onClick={() => void runDetection()} disabled={!!busy}>Re-detect</button>
        </div>
      </Section>
      <details className="section">
        <summary style={{ cursor: 'pointer' }}><h3 style={{ display: 'inline' }}>Skinning settings</h3></summary>
        <div className="field">
          Voxel resolution: {settings.resolution}
          <input type="range" min={96} max={320} step={16} value={settings.resolution} onChange={(e) => setSettings({ resolution: +e.target.value })} />
        </div>
        <div className="field">
          Joint falloff: {settings.falloff} (higher = tighter)
          <input type="range" min={2} max={8} step={0.5} value={settings.falloff} onChange={(e) => setSettings({ falloff: +e.target.value })} />
        </div>
        <div className="field">
          Smoothing passes: {settings.smoothIterations}
          <input type="range" min={0} max={6} step={1} value={settings.smoothIterations} onChange={(e) => setSettings({ smoothIterations: +e.target.value })} />
        </div>
      </details>
      <button className="btn primary block" disabled={!joints || !!busy} onClick={() => void buildRig()}>
        Build rig
      </button>
    </>
  );
}

function PaintSection() {
  const paint = useStore((s) => s.paint);
  const setPaint = useStore((s) => s.setPaint);
  const undo = useStore((s) => s.undoPaint);
  const canUndo = useStore((s) => s.paintUndo > 0);
  const selectedBone = useStore((s) => s.selectedBone);

  useEffect(() => {
    if (!paint.active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === '[') setPaint({ radius: Math.max(0.01, paint.radius / 1.2) });
      else if (e.key === ']') setPaint({ radius: Math.min(0.5, paint.radius * 1.2) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paint.active, paint.radius, setPaint, undo]);

  return (
    <Section
      title="Paint weights"
      right={
        <button className={`btn small${paint.active ? ' active' : ''}`} onClick={() => setPaint({ active: !paint.active })}>
          {paint.active ? 'Done' : 'Start painting'}
        </button>
      }
    >
      {!paint.active && <p>Fix spots that deform badly: paint a bone's influence directly on the mesh.</p>}
      {paint.active && (
        <>
          <p className="footer-note">
            Painting <strong style={{ color: 'var(--text)' }}>{selectedBone ?? 'no bone'}</strong>. Drag on the mesh to paint; Alt-click or right-click picks the bone under the cursor. <span className="kbd">[</span> <span className="kbd">]</span> size, <span className="kbd">Ctrl Z</span> undo.
          </p>
          <Seg value={paint.mode} onChange={(mode) => setPaint({ mode })} options={[['add', 'Add'], ['subtract', 'Subtract'], ['smooth', 'Smooth']]} />
          <div className="field">
            Radius: {(paint.radius * 100).toFixed(0)} cm
            <input type="range" min={0.01} max={0.3} step={0.005} value={paint.radius} onChange={(e) => setPaint({ radius: +e.target.value })} />
          </div>
          <div className="field">
            Strength: {Math.round(paint.strength * 100)}%
            <input type="range" min={0.02} max={1} step={0.02} value={paint.strength} onChange={(e) => setPaint({ strength: +e.target.value })} />
          </div>
          <div className="row between">
            <Check checked={paint.mirror} onChange={(mirror) => setPaint({ mirror })}>Mirror to other side</Check>
            <button className="btn small" disabled={!canUndo} onClick={undo}>Undo</button>
          </div>
        </>
      )}
    </Section>
  );
}

export function ShadingToolbar() {
  const shading = useStore((s) => s.shading);
  const set = useStore((s) => s.set);
  const showSkeleton = useStore((s) => s.showSkeleton);
  return (
    <div className="toolbar">
      <Seg
        value={shading}
        onChange={(v) => set('shading', v)}
        options={[
          ['textured', 'Textured'],
          ['clay', 'Clay'],
          ['xray', 'X-ray'],
          ['weights', 'Weights'],
        ]}
      />
      <button className={`btn small${showSkeleton ? ' active' : ''}`} onClick={() => set('showSkeleton', !showSkeleton)}>
        Skeleton
      </button>
    </div>
  );
}
