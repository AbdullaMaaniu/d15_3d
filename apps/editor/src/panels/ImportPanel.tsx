import { useState } from 'react';
import { REMESH_TARGETS } from '@rigforge/core';
import { useStore } from '../store';
import { Check, FilePicker, Notes, Section, Seg } from '../components/ui';
import { remeshedOBJZip } from '../lib/remesh';
import { MeshyImport } from '../components/MeshyImport';

export function DropZone() {
  const loadFromFiles = useStore((s) => s.loadFromFiles);
  const loadSample = useStore((s) => s.loadSampleModel);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void loadFromFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <strong>Drop your Meshy model here</strong>
      <p>GLB, glTF, FBX or OBJ. Include textures, .bin or .mtl files alongside.</p>
      <div className="row">
        <FilePicker className="btn primary" accept=".glb,.gltf,.fbx,.obj,.mtl,.bin,.png,.jpg,.jpeg,.webp" multiple onFiles={(f) => void loadFromFiles(f)}>
          Choose files
        </FilePicker>
        <button className="btn" onClick={() => void loadSample('A')}>
          Try a sample
        </button>
        <button className="btn ghost" onClick={() => void loadSample('quadruped')} title="A dog, to try animal rigging">
          Sample animal
        </button>
        <button className="btn ghost" onClick={() => void loadSample('creature')} title="A snake, to try building a custom skeleton">
          Sample creature
        </button>
        <button className="btn ghost" onClick={() => void loadSample('prop')} title="A treasure chest, to try prop rigging">
          Sample prop
        </button>
      </div>
      <p className="footer-note">Files never leave your browser.</p>
    </div>
  );
}

export function ImportPanel() {
  const report = useStore((s) => s.report);
  const file = useStore((s) => s.file);
  const existingRig = useStore((s) => s.existingRig);
  const goto = useStore((s) => s.goto);
  const useExisting = useStore((s) => s.useExistingRig);
  const rigType = useStore((s) => s.rigType);
  const setRigType = useStore((s) => s.setRigType);

  return (
    <>
      <div>
        <h2>Import</h2>
        <p>Bring in a static model from Meshy.ai (or any humanoid mesh).</p>
      </div>
      <DropZone />
      <MeshyImport />
      {report && file && (
        <>
          <Section title="What is it?">
            <Seg
              value={rigType}
              onChange={setRigType}
              options={[
                ['humanoid', 'Humanoid'],
                ['quadruped', 'Animal (4 legs)'],
                ['creature', 'Creature (custom)'],
                ['prop', 'Prop / object'],
              ]}
            />
            <p className="footer-note">
              {rigType === 'humanoid'
                ? 'Auto-rigged with a full humanoid skeleton, including fingers.'
                : rigType === 'quadruped'
                  ? 'Dogs, cats, horses… Legs, spine, neck, head and tail are found automatically, with walk, trot and gallop cycles.'
                  : rigType === 'creature'
                    ? 'Dragons, spiders, fish, snakes, tentacles… Click on the model to build any skeleton you like.'
                  : 'Doors, chests, wheels, turrets… Each separate part gets a pivot you can spin, swing or slide.'}
            </p>
          </Section>
          <Section title={file.name}>
            <div className="stats">
              <div><span>Triangles</span><span>{report.triangles.toLocaleString()}</span></div>
              <div><span>Vertices</span><span>{report.vertices.toLocaleString()}</span></div>
              <div><span>Materials</span><span>{report.materials}</span></div>
              <div><span>Textures</span><span>{report.textures.length}</span></div>
              <div><span>Parts</span><span>{report.islands}</span></div>
              <div><span>Open edges</span><span>{report.boundaryEdges.toLocaleString()}</span></div>
            </div>
            {report.textures.length > 0 && (
              <p className="footer-note">
                {report.textures.map((t) => `${t.slot} ${t.width}×${t.height}`).join(' · ')}
              </p>
            )}
          </Section>
          <RemeshSection />
          {report.issues.length > 0 && (
            <Section title="Mesh check">
              <Notes items={report.issues} />
            </Section>
          )}
          {existingRig && (
            <Section title="Existing rig found">
              <p>This file already has a skeleton{file.animations.length ? ` and ${file.animations.length} animation(s)` : ''}. You can keep it and go straight to animation, or re-rig from scratch.</p>
              <button className="btn" onClick={useExisting}>Keep existing rig</button>
            </Section>
          )}
          <button className="btn primary block" onClick={() => goto('orient')}>
            Continue to orientation →
          </button>
        </>
      )}
    </>
  );
}

const short = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));

/** Retopology to a chosen face count, as clean quads (new UVs, baked textures) or triangles (original UVs). */
function RemeshSection() {
  const settings = useStore((s) => s.remeshSettings);
  const info = useStore((s) => s.remeshInfo);
  const busy = useStore((s) => s.busy);
  const wireframe = useStore((s) => s.wireframe);
  const original = useStore((s) => s.originalPrepared);
  const prepared = useStore((s) => s.prepared);
  const name = useStore((s) => s.exportName);
  const set = useStore((s) => s.set);
  const remesh = useStore((s) => s.remesh);
  const revert = useStore((s) => s.revertRemesh);
  const [zipping, setZipping] = useState(false);
  const update = (patch: Partial<typeof settings>) => set('remeshSettings', { ...settings, ...patch });
  const quads = settings.topology === 'quads';

  const downloadOBJ = async () => {
    if (!prepared) return;
    setZipping(true);
    try {
      const blob = await remeshedOBJZip(prepared, name || 'model');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || 'model'}-${info?.topology ?? 'mesh'}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
      setZipping(false);
    }
  };

  return (
    <Section title="Remesh" right={<Check checked={wireframe} onChange={(v) => set('wireframe', v)}>Wireframe</Check>}>
      <div className="seg wrap" role="group" aria-label="Target faces">
        <button className={settings.target === null ? 'on' : ''} aria-pressed={settings.target === null} onClick={() => update({ target: null })}>Original</button>
        {REMESH_TARGETS.map((n) => (
          <button key={n} className={settings.target === n ? 'on' : ''} aria-pressed={settings.target === n} onClick={() => update({ target: n })}>
            {short(n)}
          </button>
        ))}
      </div>
      <div className="row">
        <Seg value={settings.topology} onChange={(topology) => update({ topology })} options={[['quads', 'Quads'], ['triangles', 'Triangles']]} />
        {quads && (
          <Seg
            value={String(settings.textureSize) as '1024' | '2048' | '4096'}
            onChange={(v) => update({ textureSize: Number(v) as 1024 | 2048 | 4096 })}
            options={[['1024', '1K'], ['2048', '2K'], ['4096', '4K']]}
          />
        )}
      </div>
      <p className="footer-note">
        {quads
          ? 'Quad flow that follows the shape, like hand-made topology. New UVs, with the textures baked onto them.'
          : 'Evenly sized triangles that keep the original UVs and textures exactly.'}
      </p>
      <button className="btn block" disabled={!!busy || settings.target === null} onClick={() => void remesh()}>
        {settings.target === null ? 'Pick a face count' : `Remesh to ${short(settings.target)} ${quads ? 'quads' : 'triangles'}`}
      </button>
      {info && (
        <p className="footer-note" data-testid="remesh-result">
          {info.topology === 'quads'
            ? `${info.faces.toLocaleString()} faces (${Math.round((100 * info.quads) / Math.max(1, info.faces))}% quads) · ${info.charts} UV charts${info.textureSize ? ` · ${info.textureSize / 1024}K texture` : ''}`
            : `${info.triangles.toLocaleString()} triangles`}
          {` · ${info.seconds.toFixed(1)} s`}
        </p>
      )}
      {info && info.topology === 'quads' && info.quads < 0.9 * info.faces && (
        <p className="footer-note">Parts too small or thin to hold quads at this density (eyes, lenses, straps) keep triangles.</p>
      )}
      {info && info.dropped.length > 0 && <p className="footer-note">Not carried over with the new UVs: {info.dropped.join(', ')}.</p>}
      {original && (
        <div className="row">
          <button className="btn small" onClick={revert}>Revert to original</button>
          <button className="btn small" onClick={() => void downloadOBJ()} disabled={zipping} title="OBJ with quads kept as quads, plus its material and texture">
            {zipping ? 'Zipping…' : 'Download OBJ'}
          </button>
        </div>
      )}
    </Section>
  );
}
