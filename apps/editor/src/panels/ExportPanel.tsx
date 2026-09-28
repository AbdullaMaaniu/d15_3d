import { useMemo, useState } from 'react';
import { exportCharacter, generateSnippet, type SnippetKind } from '@rigforge/core';
import { suggestController, useStore } from '../store';
import { ControllerSection } from './ControllerSection';
import { Section, Seg, formatBytes } from '../components/ui';

export function ExportPanel() {
  const character = useStore((s) => s.character);
  const clips = useStore((s) => s.clips);
  const name = useStore((s) => s.exportName);
  const preset = useStore((s) => s.exportPreset);
  const result = useStore((s) => s.exportResult);
  const set = useStore((s) => s.set);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<SnippetKind>('three');
  const [copied, setCopied] = useState(false);

  const fileName = `${name || 'character'}.glb`;
  const controllerSetting = useStore((s) => s.controller);
  const snippet = useMemo(
    () => generateSnippet(tab, { url: `/models/${fileName}`, clipNames: clips.map((c) => c.name), controller: controllerFor() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, fileName, clips, controllerSetting],
  );

  const run = async () => {
    if (!character) return;
    setBusy('Preparing…');
    set('error', null);
    const wasPlaying = useStore.getState().playing;
    try {
      // Export from the bind pose, with debug shading removed.
      set('playing', false);
      set('shading', 'textured');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      character.root.traverse((o: any) => {
        if (o.isSkinnedMesh) o.skeleton.pose();
      });
      character.root.updateMatrixWorld(true);
      // Spring bones ride along as node extras; @rigforge/three sets them up on load.
      const springs = useStore.getState().springs;
      character.root.userData.rigforge = {
        ...(character.root.userData.rigforge ?? {}),
        springs: springs.chains.length ? springs : undefined,
        controller: controllerFor(),
      };
      // Every clip at its chosen speed.
      const baked = clips.map((c) => {
        const clip = c.baked.clone();
        clip.name = c.name;
        if (c.speed !== 1) for (const t of clip.tracks) t.scale(1 / c.speed);
        clip.resetDuration();
        clip.userData = { rigforge: { loop: c.loop, inPlace: c.inPlace } };
        return clip;
      });
      const res = await exportCharacter(character.root, baked, { preset, onProgress: (s) => setBusy(s) });
      set('exportResult', res);
    } catch (e) {
      set('error', `Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      set('playing', wasPlaying);
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
        <p>One GLB with the skinned mesh, skeleton and {clips.length} named clip{clips.length === 1 ? '' : 's'}.</p>
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
        <p className="footer-note">
          {preset === 'web' && 'Meshopt compression, WebP textures up to 2K, keyframe reduction.'}
          {preset === 'mobile' && 'Meshopt compression, WebP textures up to 1K, keyframe reduction.'}
          {preset === 'lossless' && 'No compression; original textures and every keyframe.'}
        </p>
        <button className="btn primary block" onClick={() => void run()} disabled={!!busy || !character}>
          {busy ?? 'Build GLB'}
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

/** The controller roles to export: the user's edits if still valid, else the suggestion. */
function controllerFor() {
  const s = useStore.getState();
  const names = new Set(s.clips.map((c) => c.name));
  const c = s.controller;
  if (c && c.locomotion.every(([, n]) => names.has(n)) && (!c.jump || names.has(c.jump)) && Object.values(c.actions ?? {}).every((n) => names.has(n))) return c;
  return suggestController();
}
