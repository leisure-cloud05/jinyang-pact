/** Small accessible building blocks: dialog with focus trap, badge, tabs, empty state. */
import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Badge({ tone = 'muted', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** A person's initials in a round token (decorative: the name is always shown beside it). */
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  const initials = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return (
    <span className={`avatar ${small ? 'avatar-small' : ''}`} aria-hidden="true">
      {initials}
    </span>
  );
}

/** A vermilion seal impression; `fresh` stamps it down once, then it stays (decorative: the text beside it says what it means). */
export function Stamp({ glyph, fresh = false }: { glyph: string; fresh?: boolean }) {
  return (
    <span className={`stamp ${fresh ? 'stamp-fresh' : ''}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error-note" role="alert">
      {error}
    </p>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: labelled, focus trapped, Escape calls `onEscape` (if given). Focus returns to the opener. */
export function Dialog({
  title,
  onEscape,
  children,
  wide = false,
  tone,
}: {
  title: ReactNode;
  onEscape?: () => void;
  children: ReactNode;
  wide?: boolean;
  tone?: 'decision' | 'confirm';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const a = items[0] as HTMLElement;
      const b = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && document.activeElement === b) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onEscape]);
  return (
    <div className="backdrop">
      <div ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''} ${tone ? `dialog-${tone}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          className={`tab ${tab.id === value ? 'tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            if (next) {
              onChange(next.id);
              const el = (e.currentTarget.parentElement?.children[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length] ?? null) as HTMLElement | null;
              el?.focus();
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, actions, id }: { title: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section className="section" aria-labelledby={id ?? hid}>
      <div className="section-head">
        <h3 id={id ?? hid}>{title}</h3>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
