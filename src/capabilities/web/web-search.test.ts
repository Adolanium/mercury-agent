import { afterEach, describe, expect, it, vi } from 'vitest';

const GOOGLE_NEWS = `<?xml version="1.0"?><rss><channel><title>Google News</title>
<item><title>Envoy meets leader in Moscow - BBC</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Wed, 21 Oct 2026 08:00:00 GMT</pubDate><description>&lt;a href="x"&gt;Envoy meets leader&lt;/a&gt;&amp;nbsp;BBC</description><source url="https://www.bbc.co.uk">BBC</source></item>
<item><title>Markets rally - Reuters</title><link>https://news.google.com/rss/articles/def</link><pubDate>Wed, 21 Oct 2026 07:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
</channel></rss>`;

const BING = `<?xml version="1.0"?><rss><channel>
<item><title>what is the capital of australia - Bing</title><link>http://www.bing.com:80/search?q=x</link></item>
<item><title>Canberra - Wikipedia</title><link>https://en.wikipedia.org/wiki/Canberra</link><description>Canberra is the capital city of Australia.</description></item>
</channel></rss>`;

vi.mock('../../utils/ssrf.js', () => ({
  guardedFetch: vi.fn(async (url: string) => {
    if (url.includes('news.google.com')) return new Response(GOOGLE_NEWS, { status: 200 });
    if (url.includes('bing.com')) return new Response(BING, { status: 200 });
    return new Response('', { status: 404 });
  }),
}));

import { createWebSearchTool, parseRss, webSearch } from './web-search.js';
import { guardedFetch } from '../../utils/ssrf.js';

afterEach(() => vi.mocked(guardedFetch).mockClear());

describe('web_search', () => {
  it('parses Google News items, strips the source suffix, keeps the date', () => {
    const r = parseRss(GOOGLE_NEWS, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Envoy meets leader in Moscow', source: 'BBC', date: 'Wed, 21 Oct 2026 08:00:00 GMT' });
    expect(r[0].snippet).toBe('Envoy meets leader BBC');
  });

  it('drops Bing\'s self-link item', () => {
    expect(parseRss(BING, 5).map((x) => x.url)).toEqual(['https://en.wikipedia.org/wiki/Canberra']);
  });

  it('news uses Google News; web uses Bing; both through the SSRF guard', async () => {
    expect((await webSearch('', { kind: 'news' })).engine).toBe('Google News');
    expect(vi.mocked(guardedFetch).mock.calls[0][0]).toBe('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en');
    expect((await webSearch('capital of australia')).engine).toBe('Bing');
  });

  it('falls back to the other engine when one fails', async () => {
    vi.mocked(guardedFetch).mockImplementationOnce(async () => new Response('', { status: 503 }));
    expect((await webSearch('capital of australia')).engine).toBe('Google News');
  });

  it('the tool returns a readable list, or a clear error', async () => {
    const t = createWebSearchTool() as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
    const out = await t.execute({ query: '', kind: 'news' }, {});
    expect(out).toMatch(/News results from Google News[\s\S]*1\. Envoy meets leader in Moscow \(BBC · Wed, 21 Oct 2026\)/);
    vi.mocked(guardedFetch).mockImplementation(async () => new Response('', { status: 500 }));
    expect(await t.execute({ query: 'x' }, {})).toMatch(/^Error: web search is unavailable/);
  });
});
