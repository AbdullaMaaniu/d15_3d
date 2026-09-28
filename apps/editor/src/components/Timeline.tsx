import { useStore } from '../store';

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const activeClip = useStore((s) => s.activeClip);
  const testClip = useStore((s) => s.testClip);
  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.time);
  const set = useStore((s) => s.set);
  const entry = clips.find((c) => c.id === activeClip);
  const clip = testClip ?? entry?.baked;
  if (!clip) return null;
  const duration = clip.duration;
  const t = duration > 0 ? time % (duration + 1e-6) : 0;
  const label = testClip ? testClip.name.replace(/^test:/, 'Test: ') : entry?.name;
  return (
    <div className="timeline">
      <button className="btn small iconbtn" onClick={() => set('playing', !playing)} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="label" title={label}>{label}</span>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.001}
        value={Math.min(t, duration)}
        onChange={(e) => {
          set('playing', false);
          set('seek', parseFloat(e.target.value));
          set('time', parseFloat(e.target.value));
        }}
        aria-label="Scrub"
      />
      <span className="t">
        {t.toFixed(2)} / {duration.toFixed(2)}s
      </span>
    </div>
  );
}
