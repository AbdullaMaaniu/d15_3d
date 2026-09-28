import { useState, type ReactNode } from 'react';

export function Section({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      {(title || right) && (
        <div className="row between">
          {title && <h3>{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)} aria-pressed={v === value}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function Busy({ text, progress }: { text: string; progress?: number }) {
  return (
    <div className="section">
      <div className="busy">
        <div className="spinner" />
        {text}
      </div>
      {progress !== undefined && progress > 0 && (
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export function Notes({ items, ok }: { items: string[]; ok?: boolean }) {
  if (!items.length) return null;
  return (
    <ul className={`notes${ok ? ' ok' : ''}`}>
      {items.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

export function FilePicker({ accept, multiple, onFiles, children, className }: { accept: string; multiple?: boolean; onFiles: (f: File[]) => void; children: ReactNode; className?: string }) {
  const [key, setKey] = useState(0);
  return (
    <label className={className ?? 'btn'} style={{ cursor: 'pointer' }}>
      {children}
      <input
        key={key}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          setKey((k) => k + 1);
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#f97316" />
      <path d="M16 6v9m0 0-6 5m6-5 6 5m-6-5v4m-5 7 5-3 5 3" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="6" r="2" fill="#fff" />
    </svg>
  );
}
