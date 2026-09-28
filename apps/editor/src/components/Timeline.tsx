import { useEffect } from 'react';
import { keyTimes } from '@rigforge/core';
import { useStore } from '../store';

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const activeClip = useStore((s) => s.activeClip);
  const testClip = useStore((s) => s.testClip);
  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.time);
  const keyEdit = useStore((s) => s.keyEdit);
  const set = useStore((s) => s.set);
  const keyCurrentPose = useStore((s) => s.keyCurrentPose);
  const deleteKeyAt = useStore((s) => s.deleteKeyAt);
  const entry = clips.find((c) => c.id === activeClip);
  const clip = testClip ?? entry?.baked;
  const editing = !!entry && keyEdit.clipId === entry.id;
  const all = editing ? keyTimes(entry!.keys) : [];
  const mine = editing && keyEdit.bone ? keyTimes(entry!.keys, keyEdit.bone) : [];
  const duration = clip?.duration ?? 0;
  const t = duration > 0 ? time % (duration + 1e-6) : 0;

  const seek = (v: number) => {
    set('playing', false);
    set('seek', v);
    set('time', v);
  };
  const near = (arr: number[]) => arr.find((k) => Math.abs(k - t) < 1 / 60);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const fps = 30;
      if (e.key === 'k' || e.key === 'K') keyCurrentPose();
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        const k = near(mine);
        if (k !== undefined) deleteKeyAt(k, keyEdit.bone ?? undefined);
      } else if (e.key === ',' || e.key === 'ArrowLeft') seek(Math.max(0, Math.round(t * fps - 1) / fps));
      else if (e.key === '.' || e.key === 'ArrowRight') seek(Math.min(duration, Math.round(t * fps + 1) / fps));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!clip) return null;
  const label = testClip ? testClip.name.replace(/^test:/, 'Test: ') : entry?.name;
  const prevKey = [...all].reverse().find((k) => k < t - 1e-3);
  const nextKey = all.find((k) => k > t + 1e-3);
  return (
    <div className="timeline">
      <button className="btn small iconbtn" onClick={() => set('playing', !playing)} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="label" title={label}>{label}</span>
      <div className="track">
        {editing && (
          <div className="keys" aria-hidden="true">
            {all.map((k) => (
              <span key={k} className={`key${mine.includes(k) ? ' mine' : ''}`} style={{ left: `${(k / (duration || 1)) * 100}%` }} />
            ))}
          </div>
        )}
        <input type="range" min={0} max={duration} step={1 / 120} value={Math.min(t, duration)} onChange={(e) => seek(parseFloat(e.target.value))} aria-label="Scrub" />
      </div>
      <span className="t">
        {t.toFixed(2)} / {duration.toFixed(2)}s
      </span>
      {editing && (
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <button className="btn small ghost" disabled={prevKey === undefined} onClick={() => prevKey !== undefined && seek(prevKey)} title="Previous key">◆◀</button>
          <button className="btn small primary" onClick={() => keyCurrentPose()} title="Key the selected bone (K)">Key</button>
          <button className="btn small ghost" disabled={near(mine) === undefined} onClick={() => deleteKeyAt(near(mine)!, keyEdit.bone ?? undefined)} title="Delete this bone's key (Del)">✕◆</button>
          <button className="btn small ghost" disabled={nextKey === undefined} onClick={() => nextKey !== undefined && seek(nextKey)} title="Next key">▶◆</button>
        </div>
      )}
    </div>
  );
}
