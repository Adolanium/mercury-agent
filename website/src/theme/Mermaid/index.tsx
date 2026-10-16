import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import { useColorMode } from '@docusaurus/theme-common';
import { MermaidContainerClassName, useMermaidRenderResult } from '@docusaurus/theme-mermaid/client';
import type { MermaidConfig, RenderResult } from 'mermaid';
import './diagram.css';

/**
 * Mermaid, rendered for mercuryagent.sh instead of with the stock theme.
 *
 *   %% title: Fleet runtime            ← optional header line
 *   %% caption: One process, many bots ← optional caption under the figure
 *   flowchart LR
 *     A[Lead]:::lead --> B[Crew]
 *
 * Node classes `lead`, `accent`, `warm`, `violet`, `muted`, `ok`, `danger`
 * are styled by diagram.css with theme-aware colours, so the same source
 * reads well in light and dark mode. Wide diagrams keep a readable minimum
 * width and scroll sideways on phones; Expand opens a zoomable full view.
 */

const FONT = "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const PALETTE = {
  dark: {
    background: 'transparent', primaryColor: '#121c23', primaryTextColor: '#e8eef3', primaryBorderColor: '#2f5966',
    secondaryColor: '#1a1628', secondaryTextColor: '#e8eef3', secondaryBorderColor: '#4a3f73',
    tertiaryColor: '#1f1810', tertiaryTextColor: '#e8eef3', tertiaryBorderColor: '#6b4f2e',
    lineColor: '#5e7a86', textColor: '#c9d3d9', mainBkg: '#121c23', nodeBorder: '#2f5966',
    clusterBkg: 'rgba(125, 211, 224, 0.04)', clusterBorder: '#21404a', titleColor: '#e8eef3',
    edgeLabelBackground: '#0d1216', noteBkgColor: '#1f1810', noteTextColor: '#f3e6d2', noteBorderColor: '#6b4f2e',
    actorBkg: '#121c23', actorBorder: '#2f5966', actorTextColor: '#e8eef3', actorLineColor: '#3a4d55',
    signalColor: '#9fb2bb', signalTextColor: '#d6dee3', labelBoxBkgColor: '#121c23', labelBoxBorderColor: '#2f5966',
    labelTextColor: '#e8eef3', loopTextColor: '#c9d3d9', activationBkgColor: '#1a2a33', activationBorderColor: '#3f7584',
    sequenceNumberColor: '#0b0e12',
  },
  light: {
    background: 'transparent', primaryColor: '#eef6f8', primaryTextColor: '#111416', primaryBorderColor: '#93c4cf',
    secondaryColor: '#f3effb', secondaryTextColor: '#111416', secondaryBorderColor: '#bcaee6',
    tertiaryColor: '#fbf2e6', tertiaryTextColor: '#111416', tertiaryBorderColor: '#e3c193',
    lineColor: '#7f9199', textColor: '#2b3236', mainBkg: '#eef6f8', nodeBorder: '#93c4cf',
    clusterBkg: 'rgba(11, 114, 133, 0.035)', clusterBorder: '#d3e2e6', titleColor: '#111416',
    edgeLabelBackground: '#fbfbf8', noteBkgColor: '#fbf2e6', noteTextColor: '#4a3418', noteBorderColor: '#e3c193',
    actorBkg: '#eef6f8', actorBorder: '#93c4cf', actorTextColor: '#111416', actorLineColor: '#c4d3d8',
    signalColor: '#5d6c73', signalTextColor: '#2b3236', labelBoxBkgColor: '#eef6f8', labelBoxBorderColor: '#93c4cf',
    labelTextColor: '#111416', loopTextColor: '#2b3236', activationBkgColor: '#dcedf1', activationBorderColor: '#6aaab8',
    sequenceNumberColor: '#ffffff',
  },
} as const;

function configFor(mode: 'light' | 'dark'): MermaidConfig {
  return {
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'strict',
    fontFamily: FONT,
    themeVariables: { ...PALETTE[mode], fontFamily: FONT, fontSize: '16px' },
    flowchart: { curve: 'basis', padding: 16, nodeSpacing: 44, rankSpacing: 52, htmlLabels: true, useMaxWidth: false, diagramPadding: 12, wrappingWidth: 280 },
    sequence: { useMaxWidth: false, mirrorActors: false, width: 112, actorMargin: 18, wrap: true, boxMargin: 12, messageMargin: 40, noteMargin: 12, rightAngles: false, showSequenceNumbers: false },
    state: { useMaxWidth: false },
    class: { useMaxWidth: false },
    er: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
  } as MermaidConfig;
}

const TYPES: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, 'Flowchart'], [/^sequenceDiagram/, 'Sequence'], [/^stateDiagram/, 'State machine'],
  [/^classDiagram/, 'Class diagram'], [/^erDiagram/, 'Data model'], [/^gantt/, 'Timeline'], [/^timeline/, 'Timeline'],
  [/^journey/, 'Journey'], [/^mindmap/, 'Mind map'], [/^pie/, 'Chart'], [/^xychart/, 'Chart'], [/^quadrantChart/, 'Quadrant'],
  [/^architecture/, 'Architecture'], [/^block/, 'Block diagram'], [/^gitGraph/, 'Git graph'],
];

function parse(value: string): { source: string; title?: string; caption?: string; kind: string } {
  let title: string | undefined;
  let caption: string | undefined;
  const lines = value.split('\n').filter((line) => {
    const m = line.match(/^\s*%%\s*(title|caption)\s*:\s*(.+)$/i);
    if (!m) return true;
    if (m[1].toLowerCase() === 'title') title = m[2].trim();
    else caption = m[2].trim();
    return false;
  });
  const source = lines.join('\n').trim();
  const first = source.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? '';
  const kind = TYPES.find(([re]) => re.test(first))?.[1] ?? 'Diagram';
  return { source, title, caption, kind };
}

function naturalWidth(svg: SVGSVGElement | null): number {
  const vb = svg?.viewBox?.baseVal;
  return vb && vb.width ? vb.width : svg?.getBoundingClientRect().width ?? 0;
}

function Svg({ result, onReady }: { result: RenderResult; onReady?: (svg: SVGSVGElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    result.bindFunctions?.(el);
    const svg = el.querySelector('svg');
    if (svg) {
      const w = naturalWidth(svg);
      svg.removeAttribute('height');
      svg.style.maxWidth = `${w}px`;
      // Never shrink below ~75% of natural size: below that, labels get too small to read; scroll instead.
      svg.style.minWidth = `${Math.round(Math.min(w, Math.max(460, w * 0.66)))}px`;
      svg.style.width = '100%';
      svg.style.height = 'auto';
    }
    onReady?.(svg);
  }, [result, onReady]);
  // eslint-disable-next-line react/no-danger
  return <div ref={ref} className={`${MermaidContainerClassName} mj-diagram-svg`} dangerouslySetInnerHTML={{ __html: result.svg }} />;
}

function Viewer({ svg, title, onClose }: { svg: string; title?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z + 0.25));
      if (e.key === '-') setZoom((z) => Math.max(0.5, z - 0.25));
    };
    window.addEventListener('keydown', onKey);
    box.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="mj-diagram-viewer" role="dialog" aria-modal="true" aria-label={title ?? 'Diagram'} onClick={onClose}>
      <div className="mj-diagram-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <strong>{title ?? 'Diagram'}</strong>
        <div>
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label="Zoom in">+</button>
          <button type="button" onClick={onClose} aria-label="Close">Close</button>
        </div>
      </div>
      <div className="mj-diagram-viewer-stage" ref={box} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line react/no-danger */}
        <div className="mj-diagram-viewer-svg" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  );
}

function Diagram({ value }: { value: string }) {
  const { colorMode } = useColorMode();
  const { source, title, caption, kind } = useMemo(() => parse(value), [value]);
  const config = useMemo(() => configFor(colorMode === 'dark' ? 'dark' : 'light'), [colorMode]);
  const result = useMermaidRenderResult({ text: source, config });
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scrolls, setScrolls] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);

  const onReady = useCallback(() => {
    const el = canvas.current;
    if (el) setScrolls(el.scrollWidth > el.clientWidth + 4);
  }, []);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(() => setScrolls(el.scrollWidth > el.clientWidth + 4));
    ro.observe(el);
    return () => ro.disconnect();
  }, [result]);

  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };

  return (
    <figure className="mj-diagram">
      <header className="mj-diagram-head">
        <span className="mj-diagram-kind">{kind}</span>
        {title && <strong className="mj-diagram-title">{title}</strong>}
        <span className="mj-diagram-actions">
          <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy source'}</button>
          <button type="button" onClick={() => setOpen(true)} disabled={!result}>Expand</button>
        </span>
      </header>
      <div className={`mj-diagram-canvas${scrolls ? ' is-scrolling' : ''}`} ref={canvas}>
        {result ? <Svg result={result} onReady={onReady} /> : <div className="mj-diagram-loading" aria-hidden="true" />}
      </div>
      {scrolls && <div className="mj-diagram-hint">Scroll sideways or tap Expand to see the whole diagram</div>}
      {caption && <figcaption>{caption}</figcaption>}
      {open && result && <Viewer svg={result.svg} title={title} onClose={() => setOpen(false)} />}
    </figure>
  );
}

export default function Mermaid({ value }: { value: string }): React.ReactElement {
  return (
    <ErrorBoundary
      fallback={({ error }) => (
        <figure className="mj-diagram is-error">
          <header className="mj-diagram-head"><span className="mj-diagram-kind">Diagram error</span><strong className="mj-diagram-title">{String(error?.message ?? error).split('\n')[0]}</strong></header>
          <pre className="mj-diagram-source">{value}</pre>
        </figure>
      )}
    >
      <Diagram value={value} />
    </ErrorBoundary>
  );
}
