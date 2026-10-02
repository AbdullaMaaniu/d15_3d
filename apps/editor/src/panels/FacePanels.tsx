import { EXPRESSIONS } from '@rigforge/core';
import { useStore } from '../store';
import { Check, Section } from '../components/ui';

const LABELS: Record<string, string> = {
  happy: 'Happy', angry: 'Angry', sad: 'Sad', relaxed: 'Relaxed', surprised: 'Surprised',
  aa: 'Aa', ih: 'Ih', ou: 'Ou', ee: 'Ee', oh: 'Oh',
  blink: 'Blink', blinkLeft: 'Blink left', blinkRight: 'Blink right',
};

/** After building: the jaw, eyes and expressions, with sliders to preview each expression. */
export function FaceSection() {
  const face = useStore((s) => s.face);
  const faceRig = useStore((s) => s.faceRig);
  const setFaceRig = useStore((s) => s.setFaceRig);
  const preview = useStore((s) => s.expressionPreview);
  const setExpression = useStore((s) => s.setExpression);
  const busy = useStore((s) => !!s.busy);
  const humanoid = useStore((s) => s.rigType === 'humanoid' && !!s.character?.built);
  if (!humanoid) return null;
  return (
    <Section title="Face" right={<Check checked={faceRig} onChange={(v) => !busy && setFaceRig(v)}>Face rig</Check>}>
      {!faceRig && <p>No face bones. Turn on the face rig for a jaw, eye bones and expressions.</p>}
      {faceRig && !face && <p>No face was found on the head.</p>}
      {face && (
        <>
          <p className="footer-note">
            Jaw and eye bones{face.eyeMeshes ? ' (the eyes move the eyeballs)' : ''}, plus {EXPRESSIONS.length} expressions that export as VRM-named blendshapes.
            {!face.features && ' The head has no clear nose or chin, so the face is placed by proportion; check the expressions.'}
          </p>
          <div className="expr-grid">
            {EXPRESSIONS.map((name) => (
              <label key={name} className="field">
                {LABELS[name]}
                <input type="range" min={0} max={1} step={0.05} value={preview[name] ?? 0} onChange={(e) => setExpression(name, +e.target.value)} aria-label={`Expression ${LABELS[name]}`} />
              </label>
            ))}
          </div>
          {Object.keys(preview).length > 0 && (
            <button className="btn small ghost" onClick={() => Object.keys(preview).forEach((n) => setExpression(n, 0))}>Reset face</button>
          )}
        </>
      )}
    </Section>
  );
}

/** After building: find the hair and give whatever hangs free its own spring chains. */
export function HairSection() {
  const humanoid = useStore((s) => s.rigType === 'humanoid' && !!s.character?.built);
  const note = useStore((s) => s.hairNote);
  const hasHair = useStore((s) => s.extraBones.some((b) => /^hair[A-Z]/.test(b.name)));
  const busy = useStore((s) => !!s.busy);
  const add = useStore((s) => s.addHairSprings);
  const remove = useStore((s) => s.removeHairSprings);
  if (!humanoid) return null;
  return (
    <Section title="Hair">
      {!note && <p>Find the hair and give the parts that hang free (a ponytail, long hair) spring bones so they swing.</p>}
      {note && <p className="footer-note">{note}</p>}
      <div className="row">
        <button className="btn small" disabled={busy} onClick={() => void add()}>{hasHair ? 'Find hair again' : 'Find hair & add springs'}</button>
        {hasHair && <button className="btn small ghost" disabled={busy} onClick={() => void remove()}>Remove hair chains</button>}
      </div>
    </Section>
  );
}
