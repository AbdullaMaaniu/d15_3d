import { Suspense, useEffect } from 'react';
import { STEPS, useStore, type Step } from './store';
import { Viewport } from './components/Viewport';
import { Timeline } from './components/Timeline';
import { Busy, Logo } from './components/ui';
import { DropZone, ImportPanel } from './panels/ImportPanel';
import { OrientPanel } from './panels/OrientPanel';
import { RigPanel, ShadingToolbar } from './panels/RigPanel';
import { AnimatePanel } from './panels/AnimatePanel';
import { ExportPanel } from './panels/ExportPanel';

const LABELS: Record<Step, string> = { import: 'Import', orient: 'Orient', rig: 'Rig', animate: 'Animate', export: 'Export' };

export function App() {
  const step = useStore((s) => s.step);
  const unlocked = useStore((s) => s.unlocked);
  const goto = useStore((s) => s.goto);
  const busy = useStore((s) => s.busy);
  const progress = useStore((s) => s.progress);
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const hasModel = useStore((s) => !!s.prepared);
  const character = useStore((s) => s.character);
  const loadFromFiles = useStore((s) => s.loadFromFiles);
  const report = useStore((s) => s.report);

  // Drop a file anywhere to (re)start.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.drop, .side')) return;
      e.preventDefault();
      if (e.dataTransfer?.files.length && useStore.getState().step === 'import') void loadFromFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [loadFromFiles]);

  const current = STEPS.indexOf(step);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          RigForge <small>Meshy → three.js</small>
        </div>
        <nav className="steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button key={s} className={`${s === step ? 'active' : ''}${i < current ? ' done' : ''}`} disabled={i > unlocked} onClick={() => goto(s)}>
              <span className="n">{i < current ? '✓' : i + 1}</span>
              {LABELS[s]}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {report && <span className="meta">{report.triangles.toLocaleString()} tris</span>}
      </header>
      <main className="main">
        <aside className="side">
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button className="btn small ghost" onClick={() => setError(null)} aria-label="Dismiss">✕</button>
            </div>
          )}
          {busy && <Busy text={busy} progress={progress} />}
          {step === 'import' && <ImportPanel />}
          {step === 'orient' && <OrientPanel />}
          {step === 'rig' && <RigPanel />}
          {step === 'animate' && <AnimatePanel />}
          {step === 'export' && <ExportPanel />}
        </aside>
        <section className="stage">
          <Suspense fallback={null}>
            <Viewport />
          </Suspense>
          {!hasModel && step === 'import' && (
            <div className="empty">
              <div className="card">
                <h1>Rig &amp; animate Meshy models</h1>
                <p>Auto-rig with finger bones, add motion-capture animations and export an optimized GLB for three.js. Everything runs in your browser.</p>
                <DropZone />
              </div>
            </div>
          )}
          {character && step !== 'import' && step !== 'orient' && <ShadingToolbar />}
          {character && (step === 'animate' || step === 'export' || step === 'rig') && <Timeline />}
          <div className="overlay">
            {step === 'rig' && !character && <span className="pill">Drag markers · Orbit: drag empty space · Zoom: scroll</span>}
            {step === 'orient' && <span className="pill">Orange arrow = front (+Z)</span>}
          </div>
        </section>
      </main>
    </div>
  );
}
