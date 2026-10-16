import React, { useEffect, useRef, useState } from 'react';
import { useColorMode } from '@docusaurus/theme-common';
import CodeBlock from '@theme/CodeBlock';
import './embeds.css';

/**
 * Rich previews for bare links in blog posts. The remark plugin
 * (plugins/remark-social-embeds.cjs) detects the provider and fetches
 * metadata at build time; this component renders a static card from that
 * data (so search engines and no-JS readers get real content) and, once the
 * card scrolls near the viewport, swaps in the platform's own widget where
 * one exists. If a widget script is blocked, the static card stays.
 */

type Data = Record<string, any>;
interface Props {
  url: string;
  provider: string;
  data?: string;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string, fresh = false): Promise<void> {
  if (fresh) {
    document.querySelectorAll(`script[src="${src}"]`).forEach((s) => s.remove());
    scripts.delete(src);
  }
  if (!scripts.has(src)) {
    scripts.set(src, new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error(`blocked: ${src}`));
      };
      document.body.appendChild(s);
    }));
  }
  return scripts.get(src)!;
}

function useNearViewport<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return undefined;
    if (!('IntersectionObserver' in window)) {
      setNear(true);
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/** Fires once a widget has rendered: its iframe loaded and sized itself (the platforms set style.height when content is ready), original blockquote gone. */
function whenRendered(el: HTMLElement, onReady: () => void): () => void {
  let tries = 0;
  const loaded = new WeakSet<EventTarget>();
  const onLoad = (e: Event) => loaded.add(e.target as EventTarget);
  el.addEventListener('load', onLoad, true);
  const stop = () => {
    window.clearInterval(timer);
    el.removeEventListener('load', onLoad, true);
  };
  const timer = window.setInterval(() => {
    tries += 1;
    const frame = el.querySelector('iframe');
    if (frame && loaded.has(frame) && parseFloat(frame.style.height) > 80 && !el.querySelector('blockquote')) {
      stop();
      onReady();
    } else if (tries > 80) {
      stop();
    }
  }, 250);
  return stop;
}

const compact = (n?: number) => (typeof n === 'number' ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '');
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

/* ── brand marks (inline so nothing loads until needed) ──────────────── */

const Icon = {
  x: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" /></svg>,
  github: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>,
  instagram: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.2c3.2 0 3.6 0 4.8.1 3.3.1 4.8 1.7 4.9 4.9.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 3.2-1.7 4.8-4.9 4.9-1.3.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-3.3-.1-4.8-1.7-4.9-4.9C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8C2.4 3.9 3.9 2.4 7.2 2.3 8.4 2.2 8.8 2.2 12 2.2Zm0 4.9a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8Zm0 8.1a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Zm5.1-9.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z" /></svg>,
  youtube: <svg viewBox="0 0 68 48" aria-hidden="true"><path fill="#f00" d="M66.5 7.7a8.5 8.5 0 0 0-6-6C55.3.3 34 .3 34 .3s-21.3 0-26.5 1.4a8.5 8.5 0 0 0-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6C12.7 47.7 34 47.7 34 47.7s21.3 0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3Z" /><path fill="#fff" d="m27 34.3 17.8-10.3L27 13.7v20.6Z" /></svg>,
  play: <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="rgba(0,0,0,.6)" /><path fill="#fff" d="m19 15 15 9-15 9z" /></svg>,
  bluesky: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5.2 3.5C7.9 5.5 10.8 9.6 12 12c1.2-2.4 4.1-6.5 6.8-8.5 2-1.4 5.2-2.6 5.2 1 0 .7-.4 6-.7 6.8-.9 3-4 3.8-6.8 3.3 4.9.8 6.1 3.6 3.4 6.3-5.1 5.2-7.3-1.3-7.9-3l-.1-.3-.1.3c-.6 1.7-2.8 8.2-7.9 3-2.7-2.7-1.5-5.5 3.4-6.3-2.8.5-5.9-.3-6.8-3.3C.4 10.5 0 5.2 0 4.5c0-3.6 3.2-2.4 5.2-1Z" /></svg>,
  link: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></svg>,
  star: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .67.42l1.88 3.8 4.2.61a.75.75 0 0 1 .41 1.28l-3.04 2.96.72 4.18a.75.75 0 0 1-1.09.79L8 12.32l-3.75 1.97a.75.75 0 0 1-1.09-.79l.72-4.18L.84 6.36a.75.75 0 0 1 .41-1.28l4.2-.61L7.33.67A.75.75 0 0 1 8 .25Z" /></svg>,
  fork: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 5.37v.25A2.25 2.25 0 0 0 7.25 7.9h1.5A2.25 2.25 0 0 0 11 5.62v-.25a2.25 2.25 0 1 1 1.5 0v.25a3.75 3.75 0 0 1-3.75 3.75h-.5v1.26a2.25 2.25 0 1 1-1.5 0V9.37h-.5A3.75 3.75 0 0 1 3.5 5.62v-.25a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM8.75 12.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" /></svg>,
  open: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" /><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" /></svg>,
  pr: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.12v5.26a2.25 2.25 0 1 1-1.5 0V5.37A2.25 2.25 0 0 1 1.5 3.25Zm5.68-1.03L9.25 0v1.5h1.5a2.75 2.75 0 0 1 2.75 2.75v6.38a2.25 2.25 0 1 1-1.5 0V4.25c0-.69-.56-1.25-1.25-1.25h-1.5v1.5L7.18 2.43a.25.25 0 0 1 0-.21ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" /></svg>,
  merged: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.45 5.15A2.25 2.25 0 1 0 4 5.37v5.26a2.25 2.25 0 1 0 1.5 0V8.05A4.48 4.48 0 0 0 9 9.75h1.13a2.25 2.25 0 1 0 0-1.5H9a3 3 0 0 1-2.95-2.47l-.6-.63ZM4.75 2.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 9.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm7.5-3a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" /></svg>,
  closed: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" /></svg>,
  tag: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 7.78V2.75C1 1.78 1.78 1 2.75 1h5.03c.46 0 .9.18 1.23.51l5.75 5.75a1.75 1.75 0 0 1 0 2.47l-5.03 5.03a1.75 1.75 0 0 1-2.47 0L1.5 9.01A1.73 1.73 0 0 1 1 7.78Zm1.5 0c0 .07.03.13.07.18l5.75 5.75a.25.25 0 0 0 .35 0l5.03-5.03a.25.25 0 0 0 0-.35L7.96 2.57a.25.25 0 0 0-.18-.07H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></svg>,
};

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584', Shell: '#89e051',
  Swift: '#F05138', Kotlin: '#A97BFF', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', Ruby: '#701516', HTML: '#e34c26', CSS: '#563d7c', MDX: '#fcb32c',
};

function Frame({ provider, url, children, label }: { provider: string; url: string; children: React.ReactNode; label?: string }) {
  return (
    <figure className={`mj-embed mj-embed--${provider}`} data-provider={provider}>
      {children}
      {label && (
        <figcaption>
          <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
        </figcaption>
      )}
    </figure>
  );
}

/* ── X / Twitter ─────────────────────────────────────────────────────── */

function XPost({ url, d }: { url: string; d: Data }) {
  const { colorMode } = useColorMode();
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const hostEl = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!near || !hostEl.current) return undefined;
    let cancelled = false;
    const el = hostEl.current;
    el.innerHTML = '';
    setLive(false);
    const stop = whenRendered(el, () => {
      if (!cancelled) setLive(true);
    });
    loadScript('https://platform.twitter.com/widgets.js')
      .then(() => (window as any).twttr?.widgets?.createTweet(d.id, el, { theme: colorMode, dnt: true, align: 'center', conversation: 'none' }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, [near, colorMode, d.id]);
  const handle = d.handle && d.handle !== 'i' ? `@${d.handle}` : '';
  return (
    <Frame provider="x" url={url}>
      <div ref={ref}>
        <div ref={hostEl} className={live ? 'mj-embed-live' : 'mj-embed-staging'} aria-hidden={!live} />
        {!live && (
          <a className="mj-ecard mj-social" href={url} target="_blank" rel="noopener noreferrer">
            <header>
              <span className="mj-social-who"><strong>{d.author || handle || 'Post on X'}</strong>{d.author && handle && <span>{handle}</span>}</span>
              <span className="mj-brand mj-brand--x">{Icon.x}</span>
            </header>
            {d.text ? <p className="mj-social-text">{d.text}</p> : <p className="mj-social-text is-dim">View this post on X</p>}
            <footer>{d.date || host(url)}</footer>
          </a>
        )}
      </div>
    </Frame>
  );
}

/* ── Instagram, Bluesky, TikTok: blockquote + official script ────────── */

function ScriptEmbed({ url, provider, d, markup, script, fresh, rescan, fallback }: {
  url: string; provider: string; d: Data; markup: string | null; script: string; fresh?: boolean; rescan?: () => void; fallback: React.ReactNode;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const opts = useRef({ markup, script, fresh, rescan });
  useEffect(() => {
    const el = hostRef.current;
    const { markup: html, script: src, fresh: reload, rescan: scan } = opts.current;
    if (!near || !el || !html) return undefined;
    el.innerHTML = html;
    const stop = whenRendered(el, () => setLive(true));
    loadScript(src, reload).then(() => scan?.()).catch(() => undefined);
    return stop;
  }, [near]);
  return (
    <Frame provider={provider} url={url}>
      <div ref={ref}>
        <div ref={hostRef} className={live ? 'mj-embed-live' : 'mj-embed-staging'} aria-hidden={!live} />
        {!live && fallback}
      </div>
    </Frame>
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function Instagram({ url, d }: { url: string; d: Data }) {
  const permalink = `https://www.instagram.com/${d.kind ?? 'p'}/${d.id}/`;
  const markup = `<blockquote class="instagram-media" data-instgrm-captioned data-instgrm-permalink="${esc(permalink)}?utm_source=ig_embed" data-instgrm-version="14" style="margin:0 auto;max-width:540px;min-width:280px;width:100%"><a href="${esc(permalink)}">View on Instagram</a></blockquote>`;
  return (
    <ScriptEmbed
      url={url} provider="instagram" d={d} markup={markup} script="https://www.instagram.com/embed.js"
      rescan={() => (window as any).instgrm?.Embeds?.process()}
      fallback={(
        <a className="mj-ecard mj-social mj-social--ig" href={url} target="_blank" rel="noopener noreferrer">
          <header><span className="mj-social-who"><strong>Instagram</strong><span>{d.kind === 'reel' ? 'Reel' : 'Post'}</span></span><span className="mj-brand mj-brand--ig">{Icon.instagram}</span></header>
          <p className="mj-social-text is-dim">View this {d.kind === 'reel' ? 'reel' : 'post'} on Instagram</p>
          <footer>instagram.com</footer>
        </a>
      )}
    />
  );
}

function Bluesky({ url, d }: { url: string; d: Data }) {
  const markup = d.uri && d.cid
    ? `<blockquote class="bluesky-embed" data-bluesky-uri="${esc(d.uri)}" data-bluesky-cid="${esc(d.cid)}"><p>${esc(d.text ?? '')}</p></blockquote>`
    : null;
  return (
    <ScriptEmbed
      url={url} provider="bluesky" d={d} markup={markup} script="https://embed.bsky.app/static/embed.js"
      rescan={() => (window as any).bluesky?.scan?.()}
      fallback={(
        <a className="mj-ecard mj-social" href={url} target="_blank" rel="noopener noreferrer">
          <header><span className="mj-social-who"><strong>{d.author || `@${d.handle}`}</strong><span>@{d.handle}</span></span><span className="mj-brand mj-brand--bsky">{Icon.bluesky}</span></header>
          <p className={`mj-social-text${d.text ? '' : ' is-dim'}`}>{d.text || 'View this post on Bluesky'}</p>
          <footer>bsky.app</footer>
        </a>
      )}
    />
  );
}

function TikTok({ url, d }: { url: string; d: Data }) {
  const markup = `<blockquote class="tiktok-embed" cite="${esc(url)}" data-video-id="${esc(d.id)}" style="max-width:605px;min-width:325px;margin:0 auto"><section><a href="${esc(url)}">TikTok</a></section></blockquote>`;
  return (
    <ScriptEmbed
      url={url} provider="tiktok" d={d} markup={markup} script="https://www.tiktok.com/embed.js" fresh
      fallback={<LinkCard url={url} d={{ title: d.title || 'Video on TikTok', description: d.author ? `@${d.handle} · ${d.author}` : `@${d.handle}`, image: d.thumbnail, siteName: 'TikTok' }} />}
    />
  );
}

/* ── video: click-to-play facades ─────────────────────────────────────── */

function VideoFacade({ url, provider, thumb, title, author, iframe, vertical }: {
  url: string; provider: string; thumb?: string; title?: string; author?: string; iframe: string; vertical?: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const site = provider === 'youtube' ? 'YouTube' : provider === 'vimeo' ? 'Vimeo' : host(url);
  const label = `${author ? `${author} · ` : ''}Watch on ${site}`;
  return (
    <Frame provider={provider} url={url} label={label}>
      <div className={`mj-video${vertical ? ' is-vertical' : ''}`}>
        {playing ? (
          <iframe src={iframe} title={title ?? 'Video'} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label={`Play: ${title ?? 'video'}`}>
            {thumb && <img src={thumb} alt="" loading="lazy" decoding="async" />}
            {title && <span className="mj-video-title">{title}</span>}
            <span className="mj-video-play">{provider === 'youtube' ? Icon.youtube : Icon.play}</span>
          </button>
        )}
      </div>
    </Frame>
  );
}

/* ── GitHub ──────────────────────────────────────────────────────────── */

function GitHub({ url, d }: { url: string; d: Data }) {
  const parts: string[] = d.parts ?? [];
  const repo = d.fullName ?? d.repo ?? parts.slice(0, 2).join('/');
  const [owner, name] = String(repo).split('/');

  if (d.kind === 'code') {
    const sha = String(d.sha ?? d.ref ?? '');
    const isSha = /^[0-9a-f]{7,40}$/i.test(sha);
    const lines = d.start === d.end ? `L${d.start}` : `L${d.start}–${d.end}`;
    return (
      <figure className="mj-embed mj-embed--github mj-gh-code" data-provider="github">
        <header className="mj-gh mj-gh-code-head">
          <span className="mj-gh-mark">{Icon.github}</span>
          <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer" className="mj-gh-code-repo">{repo}</a>
          <span className={`mj-gh-ref${isSha ? ' is-sha' : ''}`} title={isSha ? `Pinned to commit ${sha}` : `Branch or tag ${sha}`}>{isSha ? '@ ' : ''}{isSha ? sha.slice(0, 7) : sha}</span>
          <a className="mj-gh-code-link" href={url} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>
        </header>
        <CodeBlock language={d.language ?? 'text'} title={`${d.path}  ·  ${lines}`} showLineNumbers={d.start ?? 1}>{String(d.code ?? '')}</CodeBlock>
        {d.commitTitle && (
          <figcaption className="mj-gh-code-foot">
            At <a href={`https://github.com/${repo}/commit/${sha}`} target="_blank" rel="noopener noreferrer"><code>{sha.slice(0, 7)}</code></a> · {d.commitTitle}{d.commitDate ? ` · ${day(d.commitDate)}` : ''}
          </figcaption>
        )}
      </figure>
    );
  }

  if (d.kind === 'commit') {
    const max = Math.max(1, ...((d.files ?? []) as Array<{ additions: number; deletions: number }>).map((f) => f.additions + f.deletions));
    return (
      <Frame provider="github" url={url}>
        <a className="mj-ecard mj-gh mj-gh-commit" href={url} target="_blank" rel="noopener noreferrer">
          <div className="mj-gh-repo"><span className="mj-gh-mark">{Icon.github}</span>{repo}<span className="mj-gh-ref is-sha">{String(d.sha ?? '').slice(0, 7)}</span></div>
          <strong className="mj-gh-title mj-gh-commit-title">{d.title}</strong>
          {d.body && <p className="mj-gh-desc">{d.body}</p>}
          <div className="mj-gh-meta">
            {d.avatar && <img src={d.avatar} alt="" width={18} height={18} loading="lazy" />}
            {d.author && <span><b>{d.author}</b> committed {day(d.date)}</span>}
            {typeof d.fileCount === 'number' && <span>{d.fileCount} file{d.fileCount === 1 ? '' : 's'} changed</span>}
            {typeof d.additions === 'number' && <span className="mj-gh-diff"><ins>+{compact(d.additions)}</ins> <del>−{compact(d.deletions)}</del></span>}
          </div>
          {d.files?.length > 0 && (
            <ul className="mj-gh-files">
              {(d.files as Array<{ name: string; additions: number; deletions: number }>).map((f) => (
                <li key={f.name}>
                  <code>{f.name}</code>
                  <span className="mj-gh-bar" aria-label={`${f.additions} added, ${f.deletions} removed`}>
                    <i className="is-add" style={{ width: `${(f.additions / max) * 100}%` }} />
                    <i className="is-del" style={{ width: `${(f.deletions / max) * 100}%` }} />
                  </span>
                  <span className="mj-gh-diff"><ins>+{f.additions}</ins> <del>−{f.deletions}</del></span>
                </li>
              ))}
            </ul>
          )}
        </a>
      </Frame>
    );
  }

  if (d.kind === 'issue' || d.kind === 'pull') {
    const state = d.kind === 'pull' ? (d.merged ? 'merged' : d.draft ? 'draft' : d.state) : d.state === 'closed' && d.stateReason === 'not_planned' ? 'not-planned' : d.state;
    const icon = d.kind === 'pull' ? (d.merged ? Icon.merged : Icon.pr) : d.state === 'closed' ? Icon.closed : Icon.open;
    const stateLabel = { open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft', 'not-planned': 'Closed' }[state as string] ?? 'Open';
    return (
      <Frame provider="github" url={url}>
        <a className="mj-ecard mj-gh" href={url} target="_blank" rel="noopener noreferrer">
          <div className="mj-gh-repo"><span className="mj-gh-mark">{Icon.github}</span>{repo}<span className="mj-gh-num">#{d.number ?? parts[3]}</span></div>
          <div className="mj-gh-title-row">
            <span className={`mj-gh-state is-${state}`}>{icon}{stateLabel}</span>
            <strong className="mj-gh-title">{d.title ?? `${d.kind === 'pull' ? 'Pull request' : 'Issue'} #${parts[3]}`}</strong>
          </div>
          {d.labels?.length > 0 && (
            <div className="mj-gh-labels">
              {d.labels.map((l: { name: string; color: string }) => (
                <span key={l.name} style={{ ['--l' as string]: `#${l.color}` }}>{l.name}</span>
              ))}
            </div>
          )}
          <div className="mj-gh-meta">
            {d.avatar && <img src={d.avatar} alt="" width={18} height={18} loading="lazy" />}
            {d.author && <span><b>{d.author}</b> opened {day(d.created)}</span>}
            {typeof d.comments === 'number' && <span>{d.comments} comment{d.comments === 1 ? '' : 's'}</span>}
            {typeof d.additions === 'number' && <span className="mj-gh-diff"><ins>+{compact(d.additions)}</ins> <del>−{compact(d.deletions)}</del></span>}
          </div>
        </a>
      </Frame>
    );
  }

  if (d.kind === 'release') {
    return (
      <Frame provider="github" url={url}>
        <a className="mj-ecard mj-gh" href={url} target="_blank" rel="noopener noreferrer">
          <div className="mj-gh-repo"><span className="mj-gh-mark">{Icon.github}</span>{repo}</div>
          <div className="mj-gh-title-row">
            <span className="mj-gh-state is-release">{Icon.tag}{d.tag}</span>
            <strong className="mj-gh-title">{d.name}</strong>
            {d.prerelease && <span className="mj-gh-pill">Pre-release</span>}
          </div>
          {d.body && <p className="mj-gh-desc">{d.body}</p>}
          <div className="mj-gh-meta">{d.published && <span>Released {day(d.published)}</span>}</div>
        </a>
      </Frame>
    );
  }

  if (d.kind === 'user') {
    return (
      <Frame provider="github" url={url}>
        <a className="mj-ecard mj-gh mj-gh-user" href={url} target="_blank" rel="noopener noreferrer">
          {d.avatar && <img src={d.avatar} alt="" width={64} height={64} loading="lazy" className={d.type === 'Organization' ? 'is-org' : ''} />}
          <div>
            <div className="mj-gh-title-row"><strong className="mj-gh-title">{d.name || d.login}</strong><span className="mj-gh-dim">{d.login}</span></div>
            {d.bio && <p className="mj-gh-desc">{d.bio}</p>}
            <div className="mj-gh-meta">
              <span className="mj-gh-mark">{Icon.github}</span>
              {typeof d.followers === 'number' && <span><b>{compact(d.followers)}</b> followers</span>}
              {typeof d.repos === 'number' && <span><b>{compact(d.repos)}</b> repositories</span>}
            </div>
          </div>
        </a>
      </Frame>
    );
  }

  if (d.kind === 'repo') {
    return (
      <Frame provider="github" url={url}>
        <a className="mj-ecard mj-gh mj-gh-repo-card" href={url} target="_blank" rel="noopener noreferrer">
          <div className="mj-gh-body">
            <div className="mj-gh-repo is-big"><span className="mj-gh-mark">{Icon.github}</span><span className="mj-gh-dim">{owner}/</span><b>{name}</b></div>
            {d.description && <p className="mj-gh-desc">{d.description}</p>}
            {d.topics?.length > 0 && <div className="mj-gh-topics">{d.topics.map((t: string) => <span key={t}>{t}</span>)}</div>}
            <div className="mj-gh-meta">
              {d.language && <span><i style={{ background: LANG_COLORS[d.language] ?? '#8b949e' }} />{d.language}</span>}
              {typeof d.stars === 'number' && <span>{Icon.star}{compact(d.stars)}</span>}
              {typeof d.forks === 'number' && <span>{Icon.fork}{compact(d.forks)}</span>}
              {d.license && d.license !== 'NOASSERTION' && <span>{d.license}</span>}
            </div>
          </div>
          {d.avatar && <img className="mj-gh-owner" src={d.avatar} alt="" width={72} height={72} loading="lazy" />}
        </a>
      </Frame>
    );
  }

  // Any other GitHub page (commit, file, tree, discussion…): GitHub's own social card.
  const og = d.og ?? `https://opengraph.githubassets.com/mercury/${parts.slice(0, 4).join('/')}`;
  return <LinkCard url={url} d={{ title: d.title || repo, description: d.description, image: og, siteName: 'GitHub', icon: undefined }} brand={Icon.github} wide />;
}

function Gist({ url, d }: { url: string; d: Data }) {
  return (
    <Frame provider="github" url={url}>
      <a className="mj-ecard mj-gh mj-gh-gist" href={url} target="_blank" rel="noopener noreferrer">
        <div className="mj-gh-repo">
          <span className="mj-gh-mark">{Icon.github}</span>
          <span className="mj-gh-dim">{d.owner ?? 'gist'} /</span> <b>{d.filename ?? 'gist'}</b>
          {d.files > 1 && <span className="mj-gh-dim">+{d.files - 1} files</span>}
        </div>
        {d.description && <p className="mj-gh-desc">{d.description}</p>}
        {d.code && <pre><code>{d.code}</code></pre>}
      </a>
    </Frame>
  );
}

/* ── generic link preview ─────────────────────────────────────────────── */

function LinkCard({ url, d, brand, wide }: { url: string; d: Data; brand?: React.ReactNode; wide?: boolean }) {
  const [imgOk, setImgOk] = useState(true);
  const site = d.siteName || host(url);
  return (
    <Frame provider="link" url={url}>
      <a className={`mj-ecard mj-link${d.image && imgOk ? ' has-image' : ''}${wide ? ' is-wide' : ''}`} href={url} target="_blank" rel="noopener noreferrer">
        <div className="mj-link-body">
          <div className="mj-link-site">
            {brand ? <span className="mj-gh-mark">{brand}</span> : d.icon ? <img src={d.icon} alt="" width={16} height={16} loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <span className="mj-gh-mark">{Icon.link}</span>}
            <span>{site}</span>
          </div>
          <strong>{d.title || url}</strong>
          {d.description && <p>{d.description}</p>}
          <span className="mj-link-host">{host(url)}</span>
        </div>
        {d.image && imgOk && <img className="mj-link-img" src={d.image} alt="" loading="lazy" decoding="async" onError={() => setImgOk(false)} />}
      </a>
    </Frame>
  );
}

/* ── dispatcher ──────────────────────────────────────────────────────── */

export default function SocialEmbed({ url, provider, data }: Props): React.ReactElement {
  const { colorMode } = useColorMode();
  let d: Data = {};
  try {
    d = data ? JSON.parse(data) : {};
  } catch {
    d = {};
  }
  switch (provider) {
    case 'x':
      return <XPost url={url} d={d} />;
    case 'youtube':
      return (
        <VideoFacade
          url={url} provider="youtube" vertical={d.short} title={d.title} author={d.author}
          thumb={`https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`}
          iframe={`https://www.youtube-nocookie.com/embed/${d.id}?autoplay=1&rel=0&modestbranding=1${d.start ? `&start=${d.start}` : ''}`}
        />
      );
    case 'vimeo':
      return <VideoFacade url={url} provider="vimeo" title={d.title} author={d.author} thumb={d.thumbnail} iframe={`https://player.vimeo.com/video/${d.id}?autoplay=1&dnt=1`} />;
    case 'loom':
      return (
        <Frame provider="loom" url={url} label="Watch on Loom">
          <div className="mj-video"><iframe src={`https://www.loom.com/embed/${d.id}`} title="Loom video" loading="lazy" allowFullScreen /></div>
        </Frame>
      );
    case 'instagram':
      return <Instagram url={url} d={d} />;
    case 'bluesky':
      return <Bluesky url={url} d={d} />;
    case 'tiktok':
      return <TikTok url={url} d={d} />;
    case 'spotify': {
      const tall = !['track', 'episode'].includes(d.kind);
      return (
        <Frame provider="spotify" url={url}>
          <iframe className="mj-spotify" style={{ height: tall ? 352 : 152 }} src={`https://open.spotify.com/embed/${d.kind}/${d.id}?utm_source=mercury&theme=${colorMode === 'dark' ? 0 : 1}`} title="Spotify" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" />
        </Frame>
      );
    }
    case 'codepen':
      return (
        <Frame provider="codepen" url={url} label="Open on CodePen">
          <iframe className="mj-codepen" src={`https://codepen.io/${d.user}/embed/${d.id}?default-tab=result&theme-id=${colorMode}`} title="CodePen" loading="lazy" allowFullScreen />
        </Frame>
      );
    case 'mastodon':
      return (
        <Frame provider="mastodon" url={url} label={`Open on ${host(url)}`}>
          <iframe className="mj-mastodon" src={`${url}/embed`} title="Mastodon post" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
        </Frame>
      );
    case 'github':
      return <GitHub url={url} d={d} />;
    case 'gist':
      return <Gist url={url} d={d} />;
    default:
      return <LinkCard url={url} d={d} />;
  }
}
