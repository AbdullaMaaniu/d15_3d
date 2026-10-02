import { useEffect, useState } from 'react';
import { BODY_CONTROLS, CLOTH_MATERIALS, type BodyControl, type BodyControlDef, type ClothMaterialId } from '@rigforge/core';
import { useStore } from '../store';
import { Check, Notes, Section } from '../components/ui';
import { fabricOf } from '../lib/cloth';

const GROUPS = [...new Set(BODY_CONTROLS.map((c) => c.group))];

/**
 * Body step: an average adult body on the rig, the base for clothing physics.
 * The clothes are cut from the character's mesh; they're shown see-through so
 * both are visible.
 */
export function BodyPanel() {
  const character = useStore((s) => s.character);
  const rigType = useStore((s) => s.rigType);
  const goto = useStore((s) => s.goto);
  const playing = useStore((s) => s.playing);
  const shading = useStore((s) => s.shading);
  const info = useStore((s) => s.bodyInfo);
  const garments = useStore((s) => s.garments);
  const garmentInfo = useStore((s) => s.garmentInfo);
  const hasParts = useStore((s) => !!s.parts);
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
          An average adult body at your character's height that moves with its rig: the base for clothing physics. Shape it with the sliders.
          The clothes are cut from the mesh along its parts, and the bare skin is replaced by the body.
        </p>
      </div>
      <Section title="Clothes">
        <Check checked={garments.separate} onChange={(v) => s().setGarments({ separate: v })}>
          Cut the clothes from the body
        </Check>
        {garments.separate && (
          <>
            {garmentInfo && (
              <ul className="garment-list" aria-label="Garments">
                {garmentInfo.pieces.map((p) => (
                  <li key={p.name} className="row between">
                    <span>{p.name}</span>
                    <span className="muted">
                      {p.triangles.toLocaleString()} triangles · {p.openings} opening{p.openings === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Check checked={garments.keepHead} onChange={(v) => s().setGarments({ keepHead: v })}>
              Keep the character's own head
            </Check>
            <Check checked={garments.hideCovered} onChange={(v) => s().setGarments({ hideCovered: v })}>
              Leave out the body under the clothes
            </Check>
            {garmentInfo && <Notes items={garmentInfo.notes} />}
            {garmentInfo?.auto && (
              <p className="footer-note">
                Clothes and skin were found automatically.{' '}
                <button
                  className="btn small ghost"
                  onClick={() => {
                    if (!hasParts) s().detectParts('body');
                    goto('parts');
                  }}
                >
                  Fix them in Parts
                </button>
              </p>
            )}
          </>
        )}
      </Section>
      {GROUPS.map((g, i) => (
        <ShapeGroup key={g} group={g} open={i === 0} />
      ))}
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
        {info && (
          <p className="footer-note">
            Body: {info.triangles.toLocaleString()} triangles, generated in {Math.round(info.ms)} ms
            {garmentInfo && garments.hideCovered ? `, ${garmentInfo.hiddenBody.toLocaleString()} hidden under the clothes` : ''}. Exported with the character.
          </p>
        )}
      </Section>
      <button className="btn primary block" onClick={() => goto('animate')}>Add animations →</button>
    </>
  );
}

/** One group of sliders; folds away, showing how many of its controls are changed. */
function ShapeGroup({ group, open }: { group: BodyControlDef['group']; open: boolean }) {
  const controls = BODY_CONTROLS.filter((c) => c.group === group);
  const shape = useStore((s) => s.bodyShape);
  const setShape = useStore((s) => s.setBodyShape);
  const changed = controls.filter((c) => shape[c.id] !== undefined);
  const [shown, setShown] = useState(open);
  return (
    <Section
      title={group}
      right={
        <span className="row" style={{ gap: 4 }}>
          {changed.length > 0 && (
            <button className="btn small ghost" aria-label={`Reset ${group}`} onClick={() => setShape(Object.fromEntries(changed.map((c) => [c.id, 1])))}>
              Reset {changed.length}
            </button>
          )}
          <button className="btn small ghost" aria-expanded={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${group}`} onClick={() => setShown(!shown)}>
            {shown ? '▾' : '▸'}
          </button>
        </span>
      }
    >
      {shown && controls.map((c) => <ShapeSlider key={c.id} def={c} />)}
    </Section>
  );
}

function ShapeSlider({ def }: { def: BodyControlDef }) {
  const { id, label, range } = def;
  const value = useStore((s) => s.bodyShape[id] ?? 1);
  const info = useStore((s) => s.bodyInfo);
  const setShape = useStore((s) => s.setBodyShape);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (Math.abs(v - value) < 1e-6) return;
    const t = setTimeout(() => setShape({ [id]: v } as Partial<Record<BodyControl, number>>), 40);
    return () => clearTimeout(t);
  }, [v, value, id, setShape]);
  const pct = Math.round((v - 1) * 100);
  // Height reads in centimetres, from the body as last built.
  const cm = id === 'height' && info?.height ? Math.round((info.height / (info.heightScale || 1)) * v * 100) : null;
  const text = cm !== null ? `${cm} cm` : pct === 0 ? 'default' : `${pct > 0 ? '+' : ''}${pct}%`;
  return (
    <div className="field">
      <span className="row between">
        <span>{label}</span>
        <span className="row" style={{ gap: 4 }}>
          <span className="muted">{text}</span>
          {pct !== 0 && <button className="btn small ghost iconbtn" style={{ width: 22, height: 22 }} aria-label={`Reset ${label}`} onClick={() => setV(1)}>↺</button>}
        </span>
      </span>
      <input type="range" min={range[0]} max={range[1]} step={0.01} value={v} aria-label={label} onChange={(e) => setV(+e.target.value)} />
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
