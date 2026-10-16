/**
 * Bare links become rich previews.
 *
 * A URL pasted on its own line in a blog post, with no link text:
 *
 *     https://x.com/someone/status/1234567890
 *
 * is replaced at build time with <SocialEmbed url=… provider=… data=…/>,
 * rendered by src/components/Journal/SocialEmbed.tsx. A Markdown link with
 * its own text ([like this](https://…)) or a URL inside a sentence is left
 * alone.
 *
 * Supported: X/Twitter, YouTube (incl. Shorts), Instagram, GitHub (repos,
 * issues, pull requests, releases, users, gists, any other page), Bluesky,
 * TikTok, Vimeo, Spotify, Loom, CodePen, Mastodon, and any other site
 * through its Open Graph tags.
 *
 * Metadata (titles, tweet text, repo stats…) is fetched once at build time
 * and cached for a week in node_modules/.cache/mercury-embeds.json, so the
 * HTML carries a readable preview for search engines, feed readers and
 * no-JS visitors; the browser upgrades it to the platform's own widget where
 * one exists. Set GITHUB_TOKEN to lift GitHub's anonymous rate limit. A
 * failed fetch never fails the build: the post just gets a plainer card.
 */
const fs = require('node:fs');
const path = require('node:path');

const CACHE_FILE = path.join(__dirname, '..', 'node_modules', '.cache', 'mercury-embeds.json');
const TTL = 7 * 24 * 3600 * 1000;
const UA = 'MercuryBlogBot/1.0 (+https://mercuryagent.sh/blog)';

let cache = null;
function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  } catch {
    /* cache is an optimisation */
  }
}

/* ── provider detection ──────────────────────────────────────────────── */

function detect(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|mobile)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'x.com' || host === 'twitter.com') {
    const i = parts.indexOf('status');
    if (i > 0 && /^\d+$/.test(parts[i + 1] ?? '')) return { provider: 'x', id: parts[i + 1], handle: parts[0] };
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    let id = null;
    let short = false;
    if (host === 'youtu.be') id = parts[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
      id = parts[1];
      short = parts[0] === 'shorts';
    }
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    const start = t ? (/^\d+$/.test(t) ? Number(t) : toSeconds(t)) : 0;
    if (id && /^[\w-]{11}$/.test(id)) return { provider: 'youtube', id, short, start };
  }
  if (host === 'instagram.com' && ['p', 'reel', 'tv'].includes(parts[0]) && /^[\w-]+$/.test(parts[1] ?? '')) {
    return { provider: 'instagram', id: parts[1], kind: parts[0] };
  }
  if (host === 'github.com' && parts.length >= 1) return { provider: 'github', parts, hash: u.hash };
  if (host === 'gist.github.com' && parts.length >= 2 && /^[0-9a-f]+$/i.test(parts[1])) return { provider: 'gist', id: parts[1], owner: parts[0] };
  if (host === 'bsky.app' && parts[0] === 'profile' && parts[2] === 'post') return { provider: 'bluesky', handle: parts[1], rkey: parts[3] };
  if (host === 'tiktok.com' && parts[1] === 'video' && /^\d+$/.test(parts[2] ?? '')) return { provider: 'tiktok', id: parts[2], handle: parts[0] };
  if (host === 'vimeo.com' && /^\d+$/.test(parts[0] ?? '')) return { provider: 'vimeo', id: parts[0] };
  if (host === 'open.spotify.com' && ['track', 'album', 'playlist', 'episode', 'show', 'artist'].includes(parts[0]) && parts[1]) {
    return { provider: 'spotify', kind: parts[0], id: parts[1] };
  }
  if (host === 'loom.com' && ['share', 'embed'].includes(parts[0]) && /^[\w]+$/.test(parts[1] ?? '')) return { provider: 'loom', id: parts[1] };
  if (host === 'codepen.io' && parts[1] === 'pen' && parts[2]) return { provider: 'codepen', user: parts[0], id: parts[2] };
  if (/^@[\w.]+$/.test(parts[0] ?? '') && /^\d{6,}$/.test(parts[1] ?? '') && parts.length === 2) {
    return { provider: 'mastodon', origin: u.origin };
  }
  return { provider: 'link' };
}

function toSeconds(t) {
  const m = String(t).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/* ── fetching ────────────────────────────────────────────────────────── */

async function get(url, { json = true, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  if (json) return res.json();
  const text = await res.text();
  return { text: text.slice(0, 1_000_000), finalUrl: res.url };
}

function gh(pathname) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return get(`https://api.github.com${pathname}`, { headers });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
function decode(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function stripTags(html) {
  return decode(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
}
function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}
function safeUrl(s, base) {
  try {
    const u = new URL(s, base);
    return /^https?:$/.test(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function metaTags(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) ?? [])[1];
    const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) ?? [])[1];
    if (key && val !== undefined && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decode(val);
  }
  return out;
}

async function unfurl(url) {
  const { text, finalUrl } = await get(url, { json: false, headers: { accept: 'text/html' } });
  const m = metaTags(text);
  const title = m['og:title'] ?? m['twitter:title'] ?? stripTags((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '');
  const icon = (text.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i) ?? [])[0];
  const iconHref = icon && (icon.match(/href=["']([^"']+)["']/i) ?? [])[1];
  return {
    title: clip(title, 140),
    description: clip(m['og:description'] ?? m['twitter:description'] ?? m.description, 260),
    image: safeUrl(m['og:image'] ?? m['twitter:image'] ?? m['twitter:image:src'], finalUrl),
    siteName: clip(m['og:site_name'], 60),
    icon: safeUrl(iconHref ?? '/favicon.ico', finalUrl),
  };
}

async function fetchData(url, d) {
  switch (d.provider) {
    case 'x': {
      const o = await get(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=true`);
      const html = String(o.html ?? '');
      const text = stripTags((html.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ?? [])[1] ?? '');
      const links = [...html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)];
      return { author: clip(o.author_name, 80), authorUrl: safeUrl(o.author_url), text: clip(text, 600), date: stripTags(links.at(-1)?.[1] ?? '') };
    }
    case 'youtube': {
      const o = await get(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      return { title: clip(o.title, 160), author: clip(o.author_name, 80) };
    }
    case 'vimeo': {
      const o = await get(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
      return { title: clip(o.title, 160), author: clip(o.author_name, 80), thumbnail: safeUrl(o.thumbnail_url) };
    }
    case 'tiktok': {
      const o = await get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
      return { title: clip(o.title, 200), author: clip(o.author_name, 80), thumbnail: safeUrl(o.thumbnail_url) };
    }
    case 'bluesky': {
      const o = await get(`https://embed.bsky.app/oembed?url=${encodeURIComponent(url)}`);
      const html = String(o.html ?? '');
      const uri = (html.match(/data-bluesky-uri="(at:\/\/[^"]+)"/) ?? [])[1];
      const cid = (html.match(/data-bluesky-cid="([a-z0-9]+)"/) ?? [])[1];
      const text = stripTags((html.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ?? [])[1] ?? '');
      return { uri, cid, author: clip(o.author_name, 80), text: clip(text, 600) };
    }
    case 'gist': {
      const g = await gh(`/gists/${d.id}`);
      const file = Object.values(g.files ?? {})[0] ?? {};
      return {
        description: clip(g.description, 200),
        owner: g.owner?.login,
        avatar: safeUrl(g.owner?.avatar_url),
        filename: file.filename,
        language: file.language,
        files: Object.keys(g.files ?? {}).length,
        code: String(file.content ?? '').split('\n').slice(0, 14).join('\n'),
      };
    }
    case 'github':
      return fetchGitHub(url, d.parts, d.hash);
    case 'link':
      return unfurl(url);
    default:
      return {};
  }
}

const EXT_LANG = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go',
  rs: 'rust', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', mdx: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', html: 'markup', toml: 'toml', sql: 'sql', diff: 'diff', ps1: 'powershell', dockerfile: 'docker',
};

/** A file permalink becomes the real code: ...blob/<ref>/<path>#L10-L40 → those lines at that ref. */
async function fetchCode(owner, repo, ref, filePath, hash) {
  const raw = await get(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`, { json: false });
  const lines = raw.text.replace(/\r\n/g, '\n').split('\n');
  const m = String(hash ?? '').match(/^#L(\d+)(?:-L(\d+))?/);
  let start = m ? Number(m[1]) : 1;
  let end = m ? Number(m[2] ?? m[1]) : Math.min(lines.length, 30);
  if (end < start) [start, end] = [end, start];
  end = Math.min(end, start + 79, lines.length);
  const slice = lines.slice(start - 1, end);
  // Remove the common indentation so a method body does not start 4 levels deep.
  const indent = Math.min(...slice.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  const code = slice.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
  const base = filePath.split('/').pop().toLowerCase();
  const ext = base === 'dockerfile' ? 'dockerfile' : base.split('.').pop();
  const out = { kind: 'code', repo: `${owner}/${repo}`, ref, path: filePath, start, end, total: lines.length, language: EXT_LANG[ext] ?? 'text', code };
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    const c = await gh(`/repos/${owner}/${repo}/commits/${ref}`).catch(() => null);
    if (c) Object.assign(out, { sha: c.sha, commitTitle: clip(String(c.commit?.message ?? '').split('\n')[0], 120), commitDate: c.commit?.committer?.date });
  }
  return out;
}

async function fetchCommit(owner, repo, sha) {
  const c = await gh(`/repos/${owner}/${repo}/commits/${sha}`);
  const [title, ...body] = String(c.commit?.message ?? '').split('\n');
  const files = (c.files ?? []).slice().sort((a, b) => (b.changes ?? 0) - (a.changes ?? 0));
  return {
    kind: 'commit', repo: `${owner}/${repo}`, sha: c.sha, title: clip(title, 200),
    body: clip(body.join(' ').replace(/Co-Authored-By:.*$/gim, '').replace(/\s+/g, ' ').trim(), 280),
    author: c.author?.login ?? c.commit?.author?.name, avatar: safeUrl(c.author?.avatar_url), date: c.commit?.author?.date,
    additions: c.stats?.additions, deletions: c.stats?.deletions, fileCount: (c.files ?? []).length,
    files: files.slice(0, 5).map((f) => ({ name: f.filename, additions: f.additions, deletions: f.deletions })),
  };
}

async function fetchGitHub(url, parts, hash) {
  const [owner, repo, kind, ...rest] = parts;
  if (kind === 'blob' && rest.length >= 2) return fetchCode(owner, repo, rest[0], rest.slice(1).join('/'), hash);
  if (kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(rest[0] ?? '')) return fetchCommit(owner, repo, rest[0]);
  const og = `https://opengraph.githubassets.com/mercury/${parts.slice(0, 4).join('/')}`;
  if (!repo) {
    const u = await gh(`/users/${owner}`);
    return { kind: 'user', login: u.login, name: u.name, bio: clip(u.bio, 200), avatar: safeUrl(u.avatar_url), followers: u.followers, repos: u.public_repos, type: u.type };
  }
  if (!kind) {
    const r = await gh(`/repos/${owner}/${repo}`);
    return {
      kind: 'repo', fullName: r.full_name, description: clip(r.description, 240), stars: r.stargazers_count, forks: r.forks_count,
      language: r.language, topics: (r.topics ?? []).slice(0, 5), avatar: safeUrl(r.owner?.avatar_url), license: r.license?.spdx_id, og,
    };
  }
  if ((kind === 'issues' || kind === 'pull') && /^\d+$/.test(rest[0] ?? '')) {
    const n = rest[0];
    const i = await gh(`/repos/${owner}/${repo}/issues/${n}`);
    const out = {
      kind: i.pull_request ? 'pull' : 'issue', repo: `${owner}/${repo}`, number: Number(n), title: clip(i.title, 200),
      state: i.state, stateReason: i.state_reason, author: i.user?.login, avatar: safeUrl(i.user?.avatar_url),
      comments: i.comments, created: i.created_at, labels: (i.labels ?? []).slice(0, 4).map((l) => ({ name: l.name, color: /^[0-9a-f]{6}$/i.test(l.color) ? l.color : '8b949e' })),
    };
    if (i.pull_request) {
      const p = await gh(`/repos/${owner}/${repo}/pulls/${n}`);
      Object.assign(out, { merged: Boolean(p.merged_at), draft: p.draft, additions: p.additions, deletions: p.deletions, files: p.changed_files });
    }
    return out;
  }
  if (kind === 'releases' && rest[0] === 'tag' && rest[1]) {
    const r = await gh(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(rest.slice(1).join('/'))}`);
    const body = String(r.body ?? '').replace(/[#*_`>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ');
    return { kind: 'release', repo: `${owner}/${repo}`, tag: r.tag_name, name: clip(r.name || r.tag_name, 160), published: r.published_at, body: clip(body, 260), prerelease: r.prerelease, avatar: safeUrl(r.author?.avatar_url) };
  }
  const meta = await unfurl(url).catch(() => ({}));
  return { kind: 'page', repo: `${owner}/${repo}`, og, title: meta.title, description: meta.description };
}

async function resolve(url, d) {
  const c = loadCache();
  const hit = c[url];
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  try {
    const data = await fetchData(url, d);
    c[url] = { at: Date.now(), data };
    saveCache();
    return data;
  } catch (err) {
    if (hit) return hit.data;
    console.warn(`[social-embeds] no preview data for ${url}: ${err.message}`);
    return {};
  }
}

/* ── remark transform ────────────────────────────────────────────────── */

function textOf(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

/** The URL if this paragraph is nothing but one bare link, else null. */
function bareLink(node) {
  if (node.type !== 'paragraph') return null;
  const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
  if (kids.length !== 1 || kids[0].type !== 'link') return null;
  const link = kids[0];
  const label = textOf(link).trim();
  const norm = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(link.url) || norm(label) !== norm(link.url)) return null;
  return link.url;
}

module.exports = function remarkSocialEmbeds() {
  return async (tree) => {
    const jobs = [];
    const walk = (parent) => {
      (parent.children ?? []).forEach((node, index) => {
        const url = bareLink(node);
        if (url) {
          const d = detect(url);
          if (d) jobs.push({ parent, index, url, d });
          return;
        }
        if (['blockquote', 'listItem', 'list', 'mdxJsxFlowElement'].includes(node.type)) walk(node);
      });
    };
    walk(tree);
    await Promise.all(jobs.map(async (job) => {
      job.data = await resolve(job.url, job.d);
    }));
    for (const { parent, index, url, d, data } of jobs) {
      const { provider, ...params } = d;
      parent.children[index] = {
        type: 'mdxJsxFlowElement',
        name: 'SocialEmbed',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'url', value: url },
          { type: 'mdxJsxAttribute', name: 'provider', value: provider },
          { type: 'mdxJsxAttribute', name: 'data', value: JSON.stringify({ ...params, ...data }) },
        ],
        children: [],
      };
    }
  };
};

module.exports.detect = detect;
module.exports.bareLink = bareLink;
