import { useEffect, useState } from 'react';
import type { ArmClearance } from '@rigforge/core';
import { useStore } from '../store';

const deg = (r: number) => Math.round((r * 180) / Math.PI);

/**
 * Moves hanging arms away from the body or closer to it, on top of the clearance
 * measured from the mesh. `measured` is that clearance when a rig exists.
 */
export function ArmSpacing({ measured, compact = false }: { measured?: ArmClearance | null; compact?: boolean }) {
  const spacing = useStore((s) => s.armSpacing);
  const setSpacing = useStore((s) => s.setArmSpacing);
  const [value, setValue] = useState(spacing);
  useEffect(() => setValue(spacing), [spacing]);
  // Rebaking every clip is too slow for every slider tick.
  useEffect(() => {
    if (value === spacing) return;
    const t = setTimeout(() => setSpacing(value), 120);
    return () => clearTimeout(t);
  }, [value, spacing, setSpacing]);
  const auto = measured ? Math.max(measured.left, measured.right) : null;
  return (
    <div className={`field arm-spacing${compact ? ' compact' : ''}`}>
      <span className="row between">
        <span>Arm spacing {value > 0 ? '+' : ''}{value}°</span>
        {auto !== null && <span className="muted">body needs {deg(auto)}°</span>}
      </span>
      <span className="row arm-spacing-slider">
        <small>Closer</small>
        <input type="range" min={-20} max={30} step={1} value={value} aria-label="Arm spacing" onChange={(e) => setValue(+e.target.value)} />
        <small>Wider</small>
        {value !== 0 && <button className="btn small ghost" title="Back to the measured spacing" onClick={() => setValue(0)}>↺</button>}
      </span>
      {!compact && (
        <p className="footer-note">
          {auto
            ? `Hanging arms are kept at least ${deg(auto)}° out, measured from your model so they clear the body. Widen if they still sink into clothing; bring them closer for a tighter look.`
            : 'Widen if hanging arms sink into the body or clothing; bring them closer for a tighter look.'}
        </p>
      )}
    </div>
  );
}
