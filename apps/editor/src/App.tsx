import { Suspense, useEffect } from 'react';
import { STEPS, useStore, type Step } from './store';
import { Viewport } from './components/Viewport';
import { TestDrive } from './components/TestDrive';
import { RigPreview } from './components/RigPreview';
import { JointLegend } from './components/JointLegend';
import { Timeline } from './components/Timeline';
import { Busy, FilePicker, Logo } from './components/ui';
import { RestoreBanner } from './components/RestoreBanner';
import { DropZone, ImportPanel } from './panels/ImportPanel';
import { OrientPanel } from './panels/OrientPanel';
import { RigPanel, ShadingToolbar } from './panels/RigPanel';
import { PartsPanel } from './panels/PartsPanel';
import { BodyPanel } from './panels/BodyPanel';
import { AnimatePanel } from './panels/AnimatePanel';
import { ExportPanel } from './panels/ExportPanel';

const LABELS: Record<Step, string> = { import: 'Import', orient: 'Orient', rig: 'Rig', parts: 'Parts', body: 'Body', animate: 'Animate', export: 'Export' };

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
  const openProject = useStore((s) => s.openProject);
  const saveProjectFile = useStore((s) => s.saveProjectFile);
  const driving = useStore((s) => !!s.testDrive) && step === 'export';
  const hasJoints = useStore((s) => !!s.joints);
  const rigType = useStore((s) => s.rigType);

  // Leaving the export step ends a test drive.
  useEffect(() => {
    if (step !== 'export' && useStore.getState().testDrive) useStore.getState().set('testDrive', null);
  }, [step]);

  // Drop a file anywhere to (re)start.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.drop, .side')) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 1 && /\.rigforge$/i.test(files[0].name)) void useStore.getState().openProject(files[0]);
      else if (files.length && useStore.getState().step === 'import') void loadFromFiles(files);
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
        <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
          <FilePicker className="btn small" accept=".rigforge,application/gzip,application/json,.glb,.gltf,.fbx,.obj" onFiles={(f) => void openProject(f[0])}>
            Open
          </FilePicker>
          <button className="btn small" disabled={!hasModel} onClick={() => void saveProjectFile()} title="Download a .rigforge project file">
            Save
          </button>
        </div>
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
          {step === 'parts' && <PartsPanel />}
          {step === 'body' && <BodyPanel />}
          {step === 'animate' && <AnimatePanel />}
          {step === 'export' && <ExportPanel />}
        </aside>
        <section className="stage">
          {driving ? (
            <TestDrive />
          ) : (
            <Suspense fallback={null}>
              <Viewport />
            </Suspense>
          )}
          {!hasModel && step === 'import' && (
            <div className="empty">
              <div className="card">
                <h1>Rig &amp; animate Meshy models</h1>
                <p>Auto-rig with finger bones, add motion-capture animations and export an optimized GLB for three.js. Everything runs in your browser.</p>
                <RestoreBanner />
                <DropZone />
              </div>
            </div>
          )}
          {character && !driving && step !== 'import' && step !== 'orient' && step !== 'parts' && <ShadingToolbar />}
          {character && !driving && (step === 'animate' || step === 'export' || step === 'rig') && <Timeline />}
          {step === 'rig' && !character && hasJoints && (rigType === 'humanoid' || rigType === 'quadruped') && <RigPreview />}
          <div className="overlay" hidden={driving}>
            {step === 'rig' && !character && <span className="pill">Drag markers · Orbit: drag empty space · Zoom: scroll</span>}
            {step === 'rig' && !character && (rigType === 'humanoid' || rigType === 'quadruped') && <JointLegend />}
            {step === 'orient' && <span className="pill">Orange arrow = front (+Z)</span>}
            {step === 'parts' && <PartsHint />}
          </div>
        </section>
      </main>
    </div>
  );
}

function PartsHint() {
  const has = useStore((s) => !!s.parts);
  const mode = useStore((s) => s.partsTool.mode);
  const playing = useStore((s) => s.playing);
  if (!has) return null;
  if (playing) return <span className="pill">Previewing motion · pause to edit parts</span>;
  const how = mode === 'brush' ? 'Paint: drag on the model · Size: [ ]' : mode === 'fill' ? 'Click to fill a similar colour' : 'Click a piece to assign it';
  return <span className="pill">{how} · Orbit: drag empty space · Undo: Ctrl+Z</span>;
}
