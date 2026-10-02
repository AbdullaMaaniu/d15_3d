import { useEffect, useState } from 'react';
import { CLOTH_MATERIALS, type BodyControl, type ClothMaterialId } from '@rigforge/core';
import { useStore } from '../store';
import { Section } from '../components/ui';
import { fabricOf } from '../lib/cloth';

// The first controls; the full head-to-toe set follows.
const CONTROLS: Array<{ id: BodyControl; label: string; hint: string }> = [
  { id: 'biceps', label: 'Biceps', hint: 'Front of the upper arms' },
  { id: 'waist', label: 'Waist', hint: 'Sides, front and back at the waist' },
  { id: 'calves', label: 'Calves', hint: 'Back of the lower legs' },
];

/**
 * Body step: a realistic body fitted inside the clothes from the rig, the base
 * for clothing physics. The clothes are shown see-through so the fit is visible.
 */
export function BodyPanel() {
  const character = useStore((s) => s.character);
  const rigType = useStore((s) => s.rigType);
  const goto = useStore((s) => s.goto);
  const playing = useStore((s) => s.playing);
  const shading = useStore((s) => s.shading);
  const info = useStore((s) => s.bodyInfo);
  const s = useStore.getState;

  if (!character?.built || rigType !== 'humanoid') {
    return (
      <>
        <div>
          <h2>Body</h2>
          <p>The generated body is for humanoid characters rigged in RigForge.</p>
        </div>
        <button className="btn primary block" onClick={() => goto('animate')}>Add animations →</button>
      </>
    );
  }
  return (
    <>
      <div>
        <h2>Body</h2>
        <p>
          A realistic human body fitted to your rig and slimmed to sit inside the clothes: the base for clothing physics. Shape it so it sits just inside them.
        </p>
      </div>
      <Section title="Shape">
        {CONTROLS.map((c) => (
          <ShapeSlider key={c.id} id={c.id} label={c.label} hint={c.hint} />
        ))}
        <p className="footer-note">More controls, head to toe, are coming next.</p>
      </Section>
      <ClothSection />
      <Section title="Preview">
        <div className="row between">
          <button className="btn small" onClick={() => s().set('shading', shading === 'xray' ? 'textured' : 'xray')} aria-pressed={shading === 'xray'}>
            {shading === 'xray' ? 'Clothes: see-through' : 'Clothes: solid'}
          </button>
          <button className="btn small" onClick={() => s().previewPartsMotion(!playing)} aria-pressed={playing}>
            {playing ? '❚❚ Pause' : '▶ Walk'}
          </button>
        </div>
        {info && <p className="footer-note">Body: {info.triangles.toLocaleString()} triangles, generated in {Math.round(info.ms)} ms. Not exported yet.</p>}
      </Section>
      <button className="btn primary block" onClick={() => goto('animate')}>Add animations →</button>
    </>
  );
}

function ShapeSlider({ id, label, hint }: { id: BodyControl; label: string; hint: string }) {
  const value = useStore((s) => s.bodyShape[id] ?? 1);
  const setShape = useStore((s) => s.setBodyShape);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (Math.abs(v - value) < 1e-6) return;
    const t = setTimeout(() => setShape({ [id]: v }), 40);
    return () => clearTimeout(t);
  }, [v, value, id, setShape]);
  const pct = Math.round((v - 1) * 100);
  return (
    <div className="field" title={hint}>
      <span className="row between">
        <span>{label}</span>
        <span className="row" style={{ gap: 4 }}>
          <span className="muted">{pct === 0 ? 'default' : `${pct > 0 ? '+' : ''}${pct}%`}</span>
          {pct !== 0 && <button className="btn small ghost iconbtn" style={{ width: 22, height: 22 }} aria-label={`Reset ${label}`} onClick={() => setV(1)}>↺</button>}
        </span>
      </span>
      <input type="range" min={0.5} max={1.8} step={0.01} value={v} aria-label={label} onChange={(e) => setV(+e.target.value)} />
    </div>
  );
}

/** Fabric per part: the cloth simulation runs on these parts while a clip plays (here and in Animate). */
function ClothSection() {
  const parts = useStore((s) => s.parts);
  const cloth = useStore((s) => s.cloth);
  const info = useStore((s) => s.clothInfo);
  const setCloth = useStore((s) => s.setCloth);
  const goto = useStore((s) => s.goto);
  return (
    <Section title="Cloth">
      {!parts ? (
        <>
          <p className="footer-note">Split the character into parts first, so the clothes can move on their own.</p>
          <button className="btn small" onClick={() => goto('parts')}>Go to Parts</button>
        </>
      ) : (
        <>
          <label className="row between">
            <span>Simulate cloth during playback</span>
            <input type="checkbox" checked={cloth.enabled} aria-label="Simulate cloth" onChange={(e) => setCloth({ enabled: e.target.checked })} />
          </label>
          {parts.defs.map((d) => {
            const fabric = fabricOf(cloth.fabrics, d.name);
            const m = CLOTH_MATERIALS.find((x) => x.id === fabric);
            return (
              <div className="field" key={d.name} title={m ? `${m.hint}. ${Math.round(m.density * 1000)} g/m².` : 'Moves with the skin'}>
                <span className="row between">
                  <span className="row" style={{ gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, display: 'inline-block' }} />
                    {d.name}
                  </span>
                  <select
                    aria-label={`${d.name} fabric`}
                    value={fabric ?? 'none'}
                    disabled={!cloth.enabled}
                    onChange={(e) => setCloth({ fabrics: { [d.name]: e.target.value === 'none' ? null : (e.target.value as ClothMaterialId) } })}
                  >
                    <option value="none">Not cloth</option>
                    {CLOTH_MATERIALS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label} · {Math.round(x.density * 1000)} g/m²
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
          <p className="footer-note">
            Heavier fabric hangs and swings more, stiffer fabric holds its shape, light fabric floats.
            {info && ` ${info.particles.toLocaleString()} cloth points${info.ms ? `, ${info.ms.toFixed(1)} ms a frame` : ''}.`} Not exported yet.
          </p>
        </>
      )}
    </Section>
  );
}
