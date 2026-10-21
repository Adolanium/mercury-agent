import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { guardedFetch } from '../../utils/ssrf.js';

/**
 * web_search: free, keyless search for the model.
 *
 *   web  → Bing's RSS results feed (falls back to Google News)
 *   news → Google News RSS, recent first (falls back to Bing)
 *
 * Read-only and through the same SSRF guard as fetch_url. Returns titles,
 * links, snippets and dates; the model follows up with fetch_url to read a
 * page. (DuckDuckGo's HTML endpoint answers automated requests with a 202
 * challenge, which is why the old search skill often came back empty.)
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 12_000;

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function decode(s: string): string {
  // Feeds often carry escaped HTML inside a field (Google News descriptions):
  // unescape, strip tags, then unescape what was inside the markup.
  return unescape(unescape(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' '))
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(item: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item);
  return m ? decode(m[1]) : '';
}

export function parseRss(xml: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const url = tag(item, 'link');
    const title = tag(item, 'title');
    if (!url || !title || /bing\.com(:\d+)?\/search\?/.test(url)) continue;
    const source = tag(item, 'source');
    out.push({
      title: source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title,
      url,
      snippet: tag(item, 'description').slice(0, 300),
      source: source || undefined,
      date: tag(item, 'pubDate') || undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await guardedFetch(url, ac.signal, { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function bing(query: string, max: number): Promise<SearchResult[]> {
  return parseRss(await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${Math.min(20, max + 2)}`), max);
}

async function googleNews(query: string, max: number): Promise<SearchResult[]> {
  const url = query.trim()
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  return parseRss(await fetchText(url), max);
}

export async function webSearch(query: string, opts: { kind?: 'web' | 'news'; max?: number } = {}): Promise<{ results: SearchResult[]; engine: string }> {
  const max = Math.max(1, Math.min(opts.max ?? 8, 15));
  const engines: Array<[string, (q: string, n: number) => Promise<SearchResult[]>]> = opts.kind === 'news'
    ? [['Google News', googleNews], ['Bing', bing]]
    : [['Bing', bing], ['Google News', googleNews]];
  const errors: string[] = [];
  for (const [name, run] of engines) {
    try {
      const results = await run(query, max);
      if (results.length) return { results, engine: name };
      errors.push(`${name}: no results`);
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  throw new Error(`search failed (${errors.join('; ')})`);
}

export function createWebSearchTool() {
  return tool({
    description:
      'Search the web for current information: news, facts, prices, people, products, anything recent. ' +
      'kind "news" for headlines and recent events (query can be empty for top stories). ' +
      'Returns titles, links, snippets and dates; use fetch_url on a link to read the full page. ' +
      'Use this instead of guessing about anything that may have changed.',
    inputSchema: zodSchema(z.object({
      query: z.string().max(300).describe('What to search for. For top news, use kind "news" and an empty query.'),
      kind: z.enum(['web', 'news']).default('web').optional(),
      max: z.number().int().min(1).max(15).default(8).optional(),
    })),
    execute: async ({ query, kind, max }) => {
      try {
        const { results, engine } = await webSearch(query, { kind: kind ?? 'web', max: max ?? 8 });
        const lines = results.map((r, i) => {
          const meta = [r.source, r.date ? new Date(r.date).toUTCString().slice(0, 16) : ''].filter(Boolean).join(' · ');
          return `${i + 1}. ${r.title}${meta ? ` (${meta})` : ''}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`;
        });
        return `${kind === 'news' ? 'News' : 'Web'} results from ${engine} for "${query || 'top stories'}":\n\n${lines.join('\n')}`;
      } catch (err) {
        return `Error: web search is unavailable right now: ${(err as Error).message}`;
      }
    },
  });
}
