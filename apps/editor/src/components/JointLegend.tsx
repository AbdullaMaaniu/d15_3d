import { useMemo } from 'react';
import { skeletonDefs, useStore } from '../store';
import { jointInfo } from '../lib/jointInfo';

/**
 * Colour key for the joint markers, in the corner of the 3D view. Columns follow the
 * screen as the character faces you: its right side on the left, its left on the right.
 */
export function JointLegend() {
  const joints = useStore((s) => s.joints);
  const selected = useStore((s) => s.selectedBone);
  const hover = useStore((s) => s.hoverJoint);
  const set = useStore((s) => s.set);
  const rigType = useStore((s) => s.rigType);
  const fingers = useStore((s) => s.fingers);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const defs = useMemo(() => skeletonDefs().filter((d) => !d.isFinger), [rigType, fingers]);
  if (!joints) return null;
  const present = defs.filter((d) => joints.joints[d.name]);
  const column = (side: 'right' | null | 'left', title: string) => {
    const items = present.filter((d) => jointInfo(d.name).side === side);
    if (!items.length) return null;
    return (
      <div className="col">
        <span className="title">{title}</span>
        {items.map((d) => {
          const info = jointInfo(d.name);
          const base = side ? info.short.slice(2) : info.short;
          return (
            <button
              key={d.name}
              className={`${selected === d.name ? 'on' : ''}${hover === d.name ? ' hover' : ''}`}
              title={info.label}
              onClick={() => set('selectedBone', selected === d.name ? null : d.name)}
              onMouseEnter={() => set('hoverJoint', d.name)}
              onMouseLeave={() => set('hoverJoint', null)}
            >
              <i style={{ background: info.color }} />
              {base}
            </button>
          );
        })}
      </div>
    );
  };
  return (
    <div className="joint-key" aria-label="Joint colours">
      {column('right', 'Right')}
      {column(null, 'Center')}
      {column('left', 'Left')}
    </div>
  );
}
