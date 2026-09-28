import { useState } from 'react';
import { MeshyClient, type MeshyTask } from '@rigforge/core';
import { useStore } from '../store';
import { Section } from './ui';

const KEY = 'rigforge.meshyKey';

function readKey(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** Browse your Meshy.ai generations and import one straight into the editor. */
export function MeshyImport() {
  const loadFromFiles = useStore((s) => s.loadFromFiles);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(readKey);
  const [remember, setRemember] = useState(() => !!readKey());
  const [models, setModels] = useState<MeshyTask[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');

  const client = () => new MeshyClient(key);

  const list = async () => {
    setError(null);
    setStatus('Loading your models…');
    try {
      try {
        if (remember) localStorage.setItem(KEY, key.trim());
        else localStorage.removeItem(KEY);
      } catch {
        /* storage unavailable */
      }
      setModels(await client().listModels({ pageSize: 30 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStatus(null);
    }
  };

  const importBytes = async (bytes: ArrayBuffer, name: string) => {
    await loadFromFiles([new File([bytes], name, { type: 'model/gltf-binary' })]);
  };

  const pick = async (m: MeshyTask) => {
    setError(null);
    setStatus(`Downloading ${m.prompt ?? m.id}…`);
    try {
      await importBytes(await client().downloadGlb(m), `${slug(m.prompt ?? m.id)}.glb`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStatus(null);
    }
  };

  const fromUrl = async () => {
    setError(null);
    setStatus('Downloading…');
    try {
      const res = await fetch(url.trim());
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const name = decodeURIComponent(new URL(url.trim()).pathname.split('/').pop() || 'model.glb');
      await importBytes(await res.arrayBuffer(), /\.gl(b|tf)$/i.test(name) ? name : `${name}.glb`);
    } catch (e) {
      setError(`${(e as Error).message}. If your browser blocks the download, save the file and drop it here instead.`);
    } finally {
      setStatus(null);
    }
  };

  if (!open) {
    return (
      <button className="btn block" onClick={() => setOpen(true)}>
        Import from Meshy.ai…
      </button>
    );
  }
  return (
    <Section title="From Meshy.ai" right={<button className="btn small ghost" onClick={() => setOpen(false)} aria-label="Close Meshy import">✕</button>}>
      <label className="field">
        API key (meshy.ai → API settings)
        <input className="text" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="msy_…" aria-label="Meshy API key" />
      </label>
      <div className="row between">
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device
        </label>
        <button className="btn small primary" disabled={!key.trim() || !!status} onClick={() => void list()}>
          Show my models
        </button>
      </div>
      <p className="footer-note">The key is sent only to api.meshy.ai from your browser.</p>
      {status && <div className="busy"><div className="spinner" />{status}</div>}
      {error && <div className="error" role="alert"><span>{error}</span></div>}
      {models && models.length === 0 && <p>No finished models yet.</p>}
      {models && models.length > 0 && (
        <div className="meshy-grid">
          {models.map((m) => (
            <button key={m.id} className="meshy-item" onClick={() => void pick(m)} title={m.prompt ?? m.id} disabled={!!status}>
              {m.thumbnailUrl ? <img src={m.thumbnailUrl} alt="" loading="lazy" /> : <span className="meshy-ph">GLB</span>}
              <span className="meshy-name">{m.prompt ?? m.id}</span>
            </button>
          ))}
        </div>
      )}
      <label className="field">
        Or paste a model URL
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="text" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/model.glb" aria-label="Model URL" />
          <button className="btn small" disabled={!/^https?:\/\//.test(url.trim()) || !!status} onClick={() => void fromUrl()}>Load</button>
        </div>
      </label>
    </Section>
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'meshy-model';
}
