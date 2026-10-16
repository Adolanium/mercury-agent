import React, { useEffect, useMemo, useState } from 'react';
import Link from '@docusaurus/Link';
import { searchText, type JournalPost } from './posts';
import './journal.css';

type Sort = 'newest' | 'oldest' | 'author';

function readQuery(): { q: string; c: string; a: string; s: Sort } {
  if (typeof window === 'undefined') return { q: '', c: '', a: '', s: 'newest' };
  const p = new URLSearchParams(window.location.search);
  const s = p.get('sort');
  return { q: p.get('q') ?? '', c: p.get('category') ?? '', a: p.get('author') ?? '', s: s === 'oldest' || s === 'author' ? s : 'newest' };
}

function writeQuery(q: string, c: string, a: string, s: Sort): void {
  if (typeof window === 'undefined') return;
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (c) p.set('category', c);
  if (a) p.set('author', a);
  if (s !== 'newest') p.set('sort', s);
  const qs = p.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}

export function PostMeta({ post, showAuthors = true }: { post: JournalPost; showAuthors?: boolean }): React.ReactElement {
  return (
    <div className="mj-meta">
      {post.category && <span className="mj-meta-cat">{post.category.label}</span>}
      <time dateTime={post.date}>{post.formattedDate}</time>
      <span aria-hidden="true">·</span>
      <span>{post.readingMinutes} min read</span>
      {showAuthors && post.authors.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span>{post.authors.map((a) => a.name).join(', ')}</span>
        </>
      )}
    </div>
  );
}

function Cover({ post, eager = false }: { post: JournalPost; eager?: boolean }): React.ReactElement {
  return post.image ? (
    <img className="mj-cover" src={post.image} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" />
  ) : (
    <div className="mj-cover mj-cover-fallback" aria-hidden="true" />
  );
}

function Card({ post }: { post: JournalPost }): React.ReactElement {
  return (
    <article className="mj-card">
      <Link to={post.permalink} className="mj-card-link">
        <div className="mj-card-media"><Cover post={post} /></div>
        <div className="mj-card-body">
          <PostMeta post={post} showAuthors={false} />
          <h3 className="mj-card-title">{post.title}</h3>
          <p className="mj-card-desc">{post.description}</p>
          {post.authors.length > 0 && (
            <div className="mj-byline">
              {post.authors.map((a) => (
                <span key={a.key ?? a.name} className="mj-byline-author">
                  {a.imageURL && <img src={a.imageURL} alt="" width={22} height={22} loading="lazy" />}
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </Link>
    </article>
  );
}

export interface JournalIndexProps {
  posts: JournalPost[];
  /** Eyebrow + heading for filtered archives (tag or author pages). */
  eyebrow?: string;
  heading?: string;
  intro?: string;
  /** Archives hide the featured slot and the category row. */
  archive?: boolean;
}

export default function JournalIndex({ posts, eyebrow = 'Mercury Blog', heading, intro, archive = false }: JournalIndexProps): React.ReactElement {
  const initial = useMemo(readQuery, []);
  const [query, setQuery] = useState(initial.q);
  const [category, setCategory] = useState(initial.c);
  const [author, setAuthor] = useState(initial.a);
  const [sort, setSort] = useState<Sort>(initial.s);

  useEffect(() => writeQuery(query, category, author, sort), [query, category, author, sort]);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of posts) if (p.category) seen.set(p.category.label, (seen.get(p.category.label) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  }, [posts]);

  const authors = useMemo(() => {
    const seen = new Map<string, { name: string; imageURL?: string; count: number }>();
    for (const p of posts) for (const a of p.authors) {
      const cur = seen.get(a.name) ?? { name: a.name, imageURL: a.imageURL, count: 0 };
      cur.count++;
      seen.set(a.name, cur);
    }
    return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [posts]);

  const filtering = query.trim() !== '' || category !== '' || author !== '';
  const featured = !archive && !filtering ? posts.find((p) => p.featured) ?? posts[0] : undefined;

  const visible = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = posts.filter((p) => {
      if (featured && p.permalink === featured.permalink) return false;
      if (category && p.category?.label !== category) return false;
      if (author && !p.authors.some((a) => a.name === author)) return false;
      if (terms.length === 0) return true;
      const hay = searchText(p);
      return terms.every((t) => hay.includes(t));
    });
    const byDate = (a: JournalPost, b: JournalPost) => b.date.localeCompare(a.date);
    if (sort === 'oldest') return list.sort((a, b) => a.date.localeCompare(b.date));
    if (sort === 'author') return list.sort((a, b) => (a.authors[0]?.name ?? '').localeCompare(b.authors[0]?.name ?? '') || byDate(a, b));
    return list.sort(byDate);
  }, [posts, featured, query, category, author, sort]);

  return (
    <main className="mj-page">
      <header className="mj-hero">
        <p className="mj-eyebrow">{eyebrow}</p>
        <h1 className="mj-hero-title">{heading ?? 'News, engineering notes and field reports from the people building Mercury.'}</h1>
        {intro && <p className="mj-hero-intro">{intro}</p>}
        <div className="mj-search" role="search">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 4a6 6 0 1 0 3.87 10.59l4.27 4.27 1.41-1.41-4.27-4.27A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" /></svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search posts, topics and authors"
            aria-label="Search the blog"
          />
        </div>
      </header>

      {featured && (
        <section className="mj-featured" aria-label="Featured">
          <Link to={featured.permalink} className="mj-featured-link">
            <Cover post={featured} eager />
            <div className="mj-featured-body">
              <PostMeta post={featured} />
              <h2 className="mj-featured-title">{featured.title}</h2>
              <p className="mj-featured-desc">{featured.description}</p>
              <span className="mj-readmore">Read the post <span aria-hidden="true">→</span></span>
            </div>
          </Link>
        </section>
      )}

      <section className="mj-controls" aria-label="Filter and sort">
        {!archive && categories.length > 1 && (
          <div className="mj-chips" role="tablist" aria-label="Category">
            <button type="button" role="tab" aria-selected={category === ''} className={category === '' ? 'is-on' : ''} onClick={() => setCategory('')}>All</button>
            {categories.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={category === c} className={category === c ? 'is-on' : ''} onClick={() => setCategory(category === c ? '' : c)}>{c}</button>
            ))}
          </div>
        )}
        <div className="mj-controls-right">
          {!archive && authors.length > 1 && (
            <label className="mj-select">
              <span>Author</span>
              <select value={author} onChange={(e) => setAuthor(e.target.value)}>
                <option value="">Everyone</option>
                {authors.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.count})</option>)}
              </select>
            </label>
          )}
          <label className="mj-select">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="author">By author</option>
            </select>
          </label>
        </div>
      </section>

      {visible.length > 0 ? (
        <section className="mj-grid" aria-label="Posts">
          {visible.map((p) => <Card key={p.permalink} post={p} />)}
        </section>
      ) : (
        <p className="mj-empty">
          Nothing matches {query ? <>“{query}”</> : 'those filters'}.{' '}
          <button type="button" onClick={() => { setQuery(''); setCategory(''); setAuthor(''); }}>Clear filters</button>
        </p>
      )}

      <footer className="mj-index-foot">
        <a href="/blog/rss.xml">RSS</a>
        <a href="/blog/atom.xml">Atom</a>
        <a href="/blog/feed.json">JSON Feed</a>
        <a href="/llms.txt">llms.txt</a>
      </footer>
    </main>
  );
}
