import { useState } from 'react';
import { useStore } from '../store';
import { FilePicker, Notes, Section, Seg } from '../components/ui';
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
