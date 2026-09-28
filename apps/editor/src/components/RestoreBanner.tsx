import { useEffect, useState } from 'react';
import { clearAutosave, readAutosave, type AutosaveInfo } from '../lib/project';
import { useStore } from '../store';

/** Offers to reopen the last autosaved session. */
export function RestoreBanner() {
  const [info, setInfo] = useState<AutosaveInfo | null>(null);
  const openProject = useStore((s) => s.openProject);
  useEffect(() => {
    void readAutosave().then(setInfo);
  }, []);
  if (!info) return null;
  const when = new Date(info.savedAt);
  return (
    <div className="section" style={{ width: '100%' }}>
      <div className="row between">
        <div style={{ textAlign: 'left' }}>
          <strong>Continue “{info.name}”?</strong>
          <p className="footer-note">Autosaved {when.toLocaleString()}</p>
        </div>
        <div className="row">
          <button className="btn small ghost" onClick={() => { void clearAutosave(); setInfo(null); }}>Discard</button>
          <button className="btn small primary" onClick={() => void openProject(info.blob)}>Restore</button>
        </div>
      </div>
    </div>
  );
}
