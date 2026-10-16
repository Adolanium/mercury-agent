import React, { isValidElement } from 'react';
import './charts.css';

/**
 * Data components for blog posts, usable in any post without imports
 * (registered in src/theme/MDXComponents.tsx).
 *
 *   <Compare highlight={2} caption="…">  wraps an ordinary Markdown table
 *   <BarChart title="…" data={[…]} />    horizontal bars, one series
 *   <Stats items={[…]} source="…" />     headline numbers
 *
 * Table cells that start with ✓ ◐ ✕ or ? render as yes / partial / no /
 * unknown badges (glyph + text, never colour alone) via the Td override.
 */

/* ── comparison tables ────────────────────────────────────────────────── */

const MARKS: Record<string, string> = { '✓': 'yes', '◐': 'partial', '✕': 'no', '?': 'unknown' };

function leadingText(children: React.ReactNode): string {
  const first = React.Children.toArray(children)[0];
  if (typeof first === 'string') return first;
  if (isValidElement<{ children?: React.ReactNode }>(first)) return leadingText(first.props.children);
  return '';
}

/** MDX `td` override: a leading ✓ ◐ ✕ ? becomes a badge class on the cell. */
export function Td(props: React.TdHTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  const glyph = leadingText(props.children).trimStart().charAt(0);
  const kind = MARKS[glyph];
  if (!kind) return <td {...props} />;
  const kids = React.Children.toArray(props.children);
  if (typeof kids[0] === 'string') kids[0] = (kids[0] as string).trimStart().slice(1).trimStart();
  return (
    <td {...props} className={`mj-cell is-${kind}${props.className ? ` ${props.className}` : ''}`}>
      <span className="mj-mark" aria-hidden="true">{glyph}</span>
      <span className="mj-cell-text">{kids}</span>
    </td>
  );
}

export function Compare({ children, caption, highlight }: { children: React.ReactNode; caption?: string; highlight?: number }): React.ReactElement {
  return (
    <figure className={`mj-compare${highlight ? ` hl-${highlight}` : ''}`}>
      <div className="mj-compare-scroll" tabIndex={0} role="region" aria-label={caption ?? 'Comparison table'}>{children}</div>
      <div className="mj-compare-legend" aria-hidden="true">
        <span className="is-yes"><b>✓</b> Yes</span>
        <span className="is-partial"><b>◐</b> Partly or opt-in</span>
        <span className="is-no"><b>✕</b> No</span>
        <span className="is-unknown"><b>?</b> Not documented</span>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/* ── bar chart ───────────────────────────────────────────────────────── */

interface Bar {
  label: string;
  value: number;
  note?: string;
  tone?: 'base' | 'muted' | 'warm';
}

const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function BarChart({ title, subtitle, data, unit = '', reference, source, max }: {
  title: string;
  subtitle?: string;
  data: Bar[];
  unit?: string;
  reference?: { value: number; label: string };
  source?: string;
  max?: number;
}): React.ReactElement {
  const top = max ?? Math.max(...data.map((d) => d.value), reference?.value ?? 0) * 1.04;
  const pct = (v: number) => `${Math.max(0.6, (v / top) * 100)}%`;
  const fmt = (v: number) => `${compact(v)}${unit ? ` ${unit}` : ''}`;
  const summary = `${title}. ${data.map((d) => `${d.label}: ${fmt(d.value)}`).join('; ')}${reference ? `; ${reference.label}: ${fmt(reference.value)}` : ''}.`;
  return (
    <figure className="mj-chart">
      <header>
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </header>
      <div className="mj-bars" role="img" aria-label={summary}>
        {reference && (
          <div className="mj-ref" style={{ left: `calc(var(--mj-label-w) + (100% - var(--mj-label-w) - var(--mj-value-w)) * ${reference.value / top})` }}>
            <span>{reference.label} · {fmt(reference.value)}</span>
          </div>
        )}
        {data.map((d) => (
          <div className={`mj-bar-row tone-${d.tone ?? 'base'}`} key={d.label} tabIndex={0}>
            <span className="mj-bar-label">{d.label}</span>
            <span className="mj-bar-track"><i style={{ width: pct(d.value) }} /></span>
            <span className="mj-bar-value">{fmt(d.value)}</span>
            {d.note && <span className="mj-bar-tip" role="tooltip">{d.label}: {fmt(d.value)}. {d.note}</span>}
          </div>
        ))}
      </div>
      <details className="mj-chart-table">
        <summary>View as table</summary>
        <table>
          <thead><tr><th>Measure</th><th>Value</th><th>Note</th></tr></thead>
          <tbody>
            {data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{d.value.toLocaleString('en-US')}{unit ? ` ${unit}` : ''}</td><td>{d.note ?? ''}</td></tr>)}
            {reference && <tr><td>{reference.label}</td><td>{reference.value.toLocaleString('en-US')}{unit ? ` ${unit}` : ''}</td><td>Reference line</td></tr>}
          </tbody>
        </table>
      </details>
      {source && <figcaption>{source}</figcaption>}
    </figure>
  );
}

/* ── stat tiles ──────────────────────────────────────────────────────── */

export function Stats({ items, source }: { items: { value: string; label: string }[]; source?: string }): React.ReactElement {
  return (
    <figure className="mj-stats">
      <dl>
        {items.map((s) => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
      </dl>
      {source && <figcaption>{source}</figcaption>}
    </figure>
  );
}
