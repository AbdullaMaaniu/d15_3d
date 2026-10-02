import { useMemo, useState } from 'react';
import { generateSnippet, type SnippetKind } from '@rigforge/core';
import { useStore } from '../store';
import { buildGlb, exportController } from '../lib/build';
import { ControllerSection } from './ControllerSection';
import { Check, Section, Seg, formatBytes } from '../components/ui';

export function ExportPanel() {
  const character = useStore((s) => s.character);
  const clips = useStore((s) => s.clips);
  const name = useStore((s) => s.exportName);
  const preset = useStore((s) => s.exportPreset);
  const result = useStore((s) => s.exportResult);
  const hasBody = useStore((s) => !!s.character?.built && s.rigType === 'humanoid');
  const exportBody = useStore((s) => s.exportBody);
  const separate = useStore((s) => s.garments.separate);
  const set = useStore((s) => s.set);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<SnippetKind>('three');
  const [copied, setCopied] = useState(false);

  const fileName = `${name || 'character'}.glb`;
  const controllerSetting = useStore((s) => s.controller);
  const snippet = useMemo(
    () => generateSnippet(tab, { url: `/models/${fileName}`, clipNames: clips.map((c) => c.name), controller: exportController() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, fileName, clips, controllerSetting],
  );

  const run = async () => {
    if (!character) return;
    setBusy('Preparing…');
    set('error', null);
    try {
      await buildGlb((stage) => setBusy(stage));
    } catch (e) {
      set('error', `Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const testDrive = async () => {
    if (!character) return;
    setBusy('Building for the test drive…');
    set('error', null);
    try {
      const res = await buildGlb((stage) => setBusy(stage));
      set('testDrive', res.glb);
    } catch (e) {
      set('error', `Could not start the test drive: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.glb as BlobPart], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <>
      <div>
        <h2>Export</h2>
        <p>One GLB with the {hasBody && exportBody ? (separate ? 'clothes as separate meshes, the body under them' : 'skinned mesh, the body under the clothes') : 'skinned mesh'}, skeleton and {clips.length} named clip{clips.length === 1 ? '' : 's'}.</p>
      </div>
      <Section title="File">
        <div className="row">
          <input className="text" style={{ flex: 1 }} value={name} onChange={(e) => set('exportName', e.target.value.replace(/[^a-z0-9_-]/gi, '-'))} aria-label="File name" />
          <span>.glb</span>
        </div>
        <Seg
          value={preset}
          onChange={(v) => { set('exportPreset', v); set('exportResult', null); }}
          options={[
            ['web', 'Web'],
            ['mobile', 'Mobile'],
            ['lossless', 'Lossless'],
          ]}
        />
        {hasBody && (
          <Check checked={exportBody} onChange={(v) => set('exportBody', v)}>
            Body under the clothes
          </Check>
        )}
        <p className="footer-note">
          {preset === 'web' && 'Meshopt compression, WebP textures up to 2K, keyframe reduction.'}
          {preset === 'mobile' && 'Meshopt compression, WebP textures up to 1K, keyframe reduction.'}
          {preset === 'lossless' && 'No compression; original textures and every keyframe.'}
        </p>
        <button className="btn primary block" onClick={() => void run()} disabled={!!busy || !character}>
          {busy ?? 'Build GLB'}
        </button>
        <button className="btn block" onClick={() => void testDrive()} disabled={!!busy || !character || !clips.length} title="Drive the exported file with @rigforge/three: keyboard, camera, bumpy ground">
          ▶ Test drive
        </button>
      </Section>

      <ControllerSection />

      {result && (
        <Section title="Result">
          <div className="sizes">
            <span className="h" />
            <span className="h">Before</span>
            <span className="h">After</span>
            <span>Geometry</span><span>{formatBytes(result.before.geometry)}</span><span>{formatBytes(result.after.geometry)}</span>
            <span>Textures</span><span>{formatBytes(result.before.textures)}</span><span>{formatBytes(result.after.textures)}</span>
            <span>Animation</span><span>{formatBytes(result.before.animation)}</span><span>{formatBytes(result.after.animation)}</span>
            <strong>Total</strong><strong>{formatBytes(result.before.total)}</strong><strong className="good">{formatBytes(result.after.total)}</strong>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="footer-note">{w}</p>
          ))}
          <button className="btn primary block" onClick={download}>Download {fileName}</button>
        </Section>
      )}

      <Section title="Use it in three.js">
        <div className="tabs">
          {([['three', 'Runtime'], ['state-machine', 'State machine'], ['r3f', 'R3F'], ['vanilla', 'Plain']] as const).map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <pre className="code">{snippet}</pre>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard.writeText(snippet).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
      </Section>
    </>
  );
}
