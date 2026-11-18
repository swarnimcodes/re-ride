import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ThemeName } from "./theme";

type IconProps = { size?: number };
const svg = (path: ReactNode) =>
  function Icon({ size = 24 }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {path}
      </svg>
    );
  };

export const IconScan = svg(
  <>
    <circle cx="12" cy="12" r="2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
  </>,
);
export const IconLive = svg(<path d="M3 12h4l3-8 4 16 3-8h4" />);
export const IconHistory = svg(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </>,
);
export const IconBack = svg(<path d="M15 18l-6-6 6-6" />);
export const IconShare = svg(
  <>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </>,
);
export const IconBike = svg(
  <>
    <circle cx="5.5" cy="17" r="3.5" />
    <circle cx="18.5" cy="17" r="3.5" />
    <path d="M5.5 17L9 8h5l4.5 9M9 8L7.5 5H5M14 8l1-3h3" />
  </>,
);
export const IconBle = svg(<path d="M7 7l10 10-5 4V3l5 4L7 17" />);
export const IconClose = svg(<path d="M6 6l12 12M18 6L6 18" />);
export const IconPalette = svg(
  <>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" />
    <circle cx="7.5" cy="11" r="1" />
    <circle cx="10.5" cy="7" r="1" />
    <circle cx="15" cy="7.5" r="1" />
  </>,
);
export const IconCheck = svg(<path d="M5 12.5l4.5 4.5L19 7.5" />);

export function TopAppBar(props: { title: string; subtitle?: string; onBack?: () => void; actions?: ReactNode }) {
  return (
    <header className="top-app-bar">
      {props.onBack && (
        <button className="icon-btn" onClick={props.onBack} aria-label="Back">
          <IconBack />
        </button>
      )}
      <div className="titles">
        <h1>{props.title}</h1>
        {props.subtitle && <p>{props.subtitle}</p>}
      </div>
      <div className="actions">{props.actions}</div>
    </header>
  );
}

export type Dest = { id: string; label: string; icon: ReactNode; badge?: number };
export function NavigationBar(props: { items: Dest[]; active: string; onSelect: (id: string) => void }) {
  return (
    <nav className="nav-bar" aria-label="Primary">
      {props.items.map((d) => (
        <button key={d.id} className={`nav-item ${props.active === d.id ? "active" : ""}`} onClick={() => props.onSelect(d.id)} aria-current={props.active === d.id}>
          <span className="indicator">
            {d.icon}
            {d.badge ? <span className="badge-dot">{d.badge > 99 ? "99+" : d.badge}</span> : null}
          </span>
          <span className="label">{d.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Snackbar(props: { message: string | null; onClose: () => void }) {
  if (!props.message) return null;
  return (
    <div className="snackbar" role="alert">
      <span>{props.message}</span>
      <button onClick={props.onClose} aria-label="Dismiss">
        <IconClose size={20} />
      </button>
    </div>
  );
}

export function Chip(props: { children: ReactNode; tone?: "primary" | "ok" | "warn" | "error" | "neutral" }) {
  return <span className={`chip ${props.tone ?? "neutral"}`}>{props.children}</span>;
}

export function EmptyState(props: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{props.icon}</div>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      {props.action}
    </div>
  );
}

const THEMES: { id: ThemeName; label: string; swatch: string[] }[] = [
  { id: "catppuccin", label: "Catppuccin", swatch: ["#cba6f7", "#94e2d5", "#a6e3a1", "#f38ba8"] },
  { id: "kanagawa", label: "Kanagawa", swatch: ["#7e9cd8", "#e6c384", "#98bb6c", "#e46876"] },
];

/** Palette button + small menu to choose the colour theme. */
export function ThemeMenu(props: { theme: ThemeName; onChange: (t: ThemeName) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-label="Colour theme" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconPalette />
      </button>
      {open && (
        <div className="menu" role="menu">
          <h3>Colour theme</h3>
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="menuitemradio"
              aria-checked={props.theme === t.id}
              onClick={() => {
                props.onChange(t.id);
                setOpen(false);
              }}
            >
              <span className="check">{props.theme === t.id && <IconCheck size={20} />}</span>
              <span>{t.label}</span>
              <span className="swatches">
                {t.swatch.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
