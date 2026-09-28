import { useEffect, useMemo, useState } from 'react';
import { MAX_REGIONS } from '@rigforge/core';
import { partsSummary, useStore } from '../store';
import { Check, Section, Seg } from '../components/ui';

/**
 * Parts step: split the character into recolourable regions (hair, skin,
 * clothes). Detect automatically, then fix with the brush / fill / piece tools.
 */
export function PartsPanel() {
  const character = useStore((s) => s.character);
  const parts = useStore((s) => s.parts);
  const rigType = useStore((s) => s.rigType);
  const goto = useStore((s) => s.goto);

  if (!character?.built) {
    return (
      <>
        <div>
          <h2>Parts</h2>
          <p>Parts need a rig built by RigForge. Models that keep their own skeleton export with their original materials.</p>
        </div>
        <button className="btn primary block" onClick={() => goto('animate')}>Add animations →</button>
      </>
    );
  }
  return (
    <>
      <div>
        <h2>Parts</h2>
        <p>
          Split the character into parts games can recolour: hair, skin, clothes. Optional; skip it to keep one material.
        </p>
      </div>
      {parts ? <PartsEditor /> : <DetectSection humanoid={rigType === 'humanoid'} />}
      {parts ? (
        <button className="btn primary block" onClick={() => goto('animate')}>Add animations →</button>
      ) : (
        <button className="btn block" onClick={() => goto('animate')}>Skip to animations →</button>
      )}
    </>
  );
}

function DetectSection({ humanoid }: { humanoid: boolean }) {
  const detect = useStore((s) => s.detectParts);
  const start = useStore((s) => s.startParts);
  const [count, setCount] = useState(humanoid ? 5 : 4);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => void) => {
    setBusy(true);
    // Let the button show its busy state before the (synchronous) work.
    setTimeout(() => {
      try {
        fn();
      } finally {
        setBusy(false);
      }
    }, 30);
  };
  return (
    <Section title="Find parts">
      {humanoid && (
        <>
          <button className="btn primary block" disabled={busy} onClick={() => run(() => detect('body'))}>
            {busy ? 'Detecting…' : 'Detect hair, skin & clothes'}
          </button>
          <p className="footer-note">Uses the texture's colours and the rig's body parts. You can fix anything afterwards.</p>
        </>
      )}
      <div className="row">
        <button className={`btn${humanoid ? '' : ' primary'}`} disabled={busy} onClick={() => run(() => detect('colour', count))}>
          Split by colour
        </button>
        <label className="check" title="How many parts">
          into
          <select className="text" value={count} onChange={(e) => setCount(+e.target.value)} aria-label="Number of parts" style={{ width: 'auto' }}>
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          parts
        </label>
      </div>
      <button className="btn ghost small" disabled={busy} onClick={start}>Start with one part and paint the rest</button>
    </Section>
  );
}

function PartsEditor() {
  const parts = useStore((s) => s.parts)!;
  const tool = useStore((s) => s.partsTool);
  const setTool = useStore((s) => s.setPartsTool);
  const history = useStore((s) => s.partsHistory);
  const hover = useStore((s) => s.hoverPart);
  const version = useStore((s) => s.partsVersion);
  const playing = useStore((s) => s.playing);
  const rigType = useStore((s) => s.rigType);
  const s = useStore.getState;
  const summary = useMemo(() => partsSummary(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const duplicate = new Set(parts.defs.map((d) => d.name.trim().toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i));
  const empty = parts.defs.some((d) => !d.name.trim());

  // Shortcuts: B/F/P tools, [ ] brush size, 1-9 pick a part, Ctrl+Z / Ctrl+Shift+Z.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      const st = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redoParts();
        else st.undoParts();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redoParts();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') st.setPartsTool({ mode: 'brush' });
      else if (k === 'f') st.setPartsTool({ mode: 'fill' });
      else if (k === 'p') st.setPartsTool({ mode: 'piece' });
      else if (k === '[') st.setPartsTool({ radius: Math.max(0.01, st.partsTool.radius / 1.25) });
      else if (k === ']') st.setPartsTool({ radius: Math.min(0.3, st.partsTool.radius * 1.25) });
      else if (/^[1-9]$/.test(k) && +k <= (st.parts?.defs.length ?? 0)) st.setPartsTool({ region: +k - 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <Section
        title={`Parts (${parts.defs.length})`}
        right={
          <button className="btn small ghost" onClick={s().addPart} disabled={parts.defs.length >= MAX_REGIONS} title="Add a part to paint">
            + Add
          </button>
        }
      >
        <p className="footer-note">Pick a part, then paint it on the model.</p>
        <div className="part-list" role="listbox" aria-label="Parts">
          {parts.defs.map((d, i) => {
            const tint = parts.tints[i];
            const base = summary?.baseColors[i] ?? '#808080';
            const share = summary?.shares[i] ?? 0;
            return (
              <div
                key={i}
                role="option"
                aria-selected={tool.region === i}
                className={`part-row${tool.region === i ? ' on' : ''}${hover === i ? ' hover' : ''}`}
                onClick={() => setTool({ region: i })}
                onMouseEnter={() => useStore.setState({ hoverPart: i })}
                onMouseLeave={() => useStore.setState({ hoverPart: null })}
              >
                <span className="part-dot" style={{ background: d.color }} title={i < 9 ? `Key ${i + 1}` : undefined} />
                <input
                  className="part-name"
                  value={d.name}
                  aria-label={`Part ${i + 1} name`}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={() => setTool({ region: i })}
                  onChange={(e) => s().renamePart(i, e.target.value)}
                />
                <span className="part-share">{share < 0.001 ? '—' : `${Math.max(1, Math.round(share * 100))}%`}</span>
                <input
                  type="color"
                  className="part-color"
                  value={tint ?? base}
                  aria-label={`${d.name} preview colour`}
                  title="Preview a recolour (not exported: games set colours at runtime)"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => s().setPartTint(i, e.target.value)}
                />
                {tint ? (
                  <button className="btn small ghost iconbtn" title="Back to the texture's colour" aria-label={`Reset ${d.name} colour`} onClick={(e) => { e.stopPropagation(); s().setPartTint(i, null); }}>↺</button>
                ) : (
                  <span className="iconbtn-space" />
                )}
                <button
                  className="btn small ghost iconbtn"
                  title="Remove (its area joins the part above)"
                  aria-label={`Remove ${d.name}`}
                  disabled={parts.defs.length < 2}
                  onClick={(e) => { e.stopPropagation(); s().removePart(i); }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        {(duplicate.size > 0 || empty) && <p className="warn">Give every part a different name, so games can find it.</p>}
      </Section>

      <Section title="Tools">
        <Seg
          value={tool.mode}
          onChange={(mode) => setTool({ mode })}
          options={[['brush', 'Brush (B)'], ['fill', 'Fill colour (F)'], ['piece', 'Piece (P)']]}
        />
        {tool.mode === 'brush' && (
          <div className="field">
            Brush size: {Math.round(tool.radius * 100)} cm
            <input type="range" min={0.01} max={0.3} step={0.005} value={tool.radius} aria-label="Brush size" onChange={(e) => setTool({ radius: +e.target.value })} />
          </div>
        )}
        {tool.mode === 'fill' && (
          <div className="field">
            Colour match: {tool.tolerance < 9 ? 'strict' : tool.tolerance > 18 ? 'loose' : 'normal'}
            <input type="range" min={4} max={30} step={1} value={tool.tolerance} aria-label="Colour match" onChange={(e) => setTool({ tolerance: +e.target.value })} />
          </div>
        )}
        {tool.mode === 'piece' && <p className="footer-note">Click a separate piece of the model (glasses, a cap, buttons) to give all of it to the part.</p>}
        <div className="row between">
          <Check checked={tool.mirror} onChange={(mirror) => setTool({ mirror })}>Mirror left/right</Check>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn small ghost" disabled={!history.undo} onClick={s().undoParts} title="Undo (Ctrl+Z)">↶ Undo</button>
            <button className="btn small ghost" disabled={!history.redo} onClick={s().redoParts} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
          </div>
        </div>
      </Section>

      <Section title="Preview">
        <div className="row between">
          <Seg value={tool.view} onChange={(view) => setTool({ view })} options={[['parts', 'Parts'], ['colours', 'Colours']]} />
          <button className="btn small" onClick={() => s().previewPartsMotion(!playing)} aria-pressed={playing}>
            {playing ? '❚❚ Pause' : rigType === 'humanoid' || rigType === 'quadruped' ? '▶ Walk' : '▶ Play'}
          </button>
        </div>
        <p className="footer-note">
          {tool.view === 'parts' ? 'Each part in its own colour.' : 'Recolours as your game will show them. Pick colours with the swatches above.'}
        </p>
      </Section>

      <Section title="In your game">
        <p className="footer-note">Exports {parts.defs.length} named material{parts.defs.length === 1 ? '' : 's'}. With @rigforge/three:</p>
        <pre className="code">{`character.setColor('${parts.defs[Math.min(tool.region, parts.defs.length - 1)]?.name ?? 'Top'}', '#c0392b');`}</pre>
        <div className="row" style={{ gap: 6 }}>
          <RedetectButton />
          <button className="btn small ghost" onClick={s().clearParts} title="Back to one material (undo restores the parts)">Clear parts</button>
        </div>
      </Section>
    </>
  );
}

function RedetectButton() {
  const rigType = useStore((s) => s.rigType);
  const count = useStore((s) => s.parts?.defs.length ?? 5);
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <button className="btn small ghost" onClick={() => setConfirm(true)}>Detect again…</button>;
  return (
    <span className="row" style={{ gap: 4 }}>
      {rigType === 'humanoid' && <button className="btn small" onClick={() => { useStore.getState().detectParts('body'); setConfirm(false); }}>Hair, skin &amp; clothes</button>}
      <button className="btn small" onClick={() => { useStore.getState().detectParts('colour', Math.max(2, Math.min(8, count))); setConfirm(false); }}>By colour</button>
      <button className="btn small ghost" onClick={() => setConfirm(false)}>Cancel</button>
    </span>
  );
}
