import { useStore } from '../store';
import { Notes, Section } from '../components/ui';

export function OrientPanel() {
  const rotate = useStore((s) => s.rotate);
  const autoOrient = useStore((s) => s.autoOrient);
  const height = useStore((s) => s.height);
  const setHeight = useStore((s) => s.setHeight);
  const notes = useStore((s) => s.orientNotes);
  const confirm = useStore((s) => s.confirmOrientation);
  const rigType = useStore((s) => s.rigType);
  const prop = rigType === 'prop';

  return (
    <>
      <div>
        <h2>Orient &amp; scale</h2>
        <p>
          {prop
            ? 'Stand the object upright on the grid; its front should face the orange arrow (+Z).'
            : rigType === 'quadruped'
              ? 'Stand the animal on the grid with its head toward the orange arrow (+Z).'
              : 'Stand the character upright on the grid, facing the orange arrow (+Z).'}
        </p>
      </div>
      <Section title="Rotate" right={<button className="btn small" onClick={autoOrient}>Auto</button>}>
        <div className="grid3">
          <button className="btn" onClick={() => rotate('x', -90)} title="Tip backward">X −90°</button>
          <button className="btn" onClick={() => rotate('y', 90)} title="Turn left">Y +90°</button>
          <button className="btn" onClick={() => rotate('z', -90)} title="Roll right">Z −90°</button>
          <button className="btn" onClick={() => rotate('x', 90)} title="Tip forward">X +90°</button>
          <button className="btn" onClick={() => rotate('y', 180)} title="Turn around">Face 180°</button>
          <button className="btn" onClick={() => rotate('z', 90)} title="Roll left">Z +90°</button>
        </div>
        <Notes items={notes} ok />
      </Section>
      <Section title={rigType === 'creature' || prop ? 'Size (largest dimension)' : 'Height'}>
        <div className="row">
          <input
            type="range"
            min={0.3}
            max={4}
            step={0.01}
            value={height}
            onChange={(e) => setHeight(parseFloat(e.target.value))}
            style={{ flex: 1 }}
          />
          <input className="text" type="number" min={0.1} max={20} step={0.01} value={height} onChange={(e) => setHeight(parseFloat(e.target.value) || 1.8)} style={{ width: 80 }} />
          <span>m</span>
        </div>
        <p className="footer-note">
          Real-world scale keeps physics and cameras sensible in three.js.
          {rigType === 'humanoid' ? ' An adult is about 1.7–1.8 m.' : rigType === 'quadruped' ? ' Height to the top of the head: a large dog is about 0.8 m.' : ''}
        </p>
      </Section>
      <button className="btn primary block" onClick={confirm}>
        {prop ? 'Looks right: set up parts →' : rigType === 'creature' ? 'Looks right: build the skeleton →' : 'Looks right: find the joints →'}
      </button>
    </>
  );
}
