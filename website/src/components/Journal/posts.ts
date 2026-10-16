/**
 * Normalises what the Docusaurus blog plugin hands a list page into the
 * flat shape the blog UI renders, sorts and searches.
 */
import type { ComponentType } from 'react';

export interface JournalAuthor {
  key?: string;
  name: string;
  title?: string;
  imageURL?: string;
  page?: { permalink: string } | null;
}

export interface JournalPost {
  permalink: string;
  title: string;
  description: string;
  date: string;
  formattedDate: string;
  readingMinutes: number;
  category: { label: string; permalink: string } | null;
  tags: { label: string; permalink: string }[];
  authors: JournalAuthor[];
  image?: string;
  featured: boolean;
}

type PostModule = ComponentType & {
  metadata: {
    permalink: string;
    title: string;
    description: string;
    date: string;
    readingTime?: number;
    tags: { label: string; permalink: string }[];
    authors: JournalAuthor[];
    frontMatter: Record<string, unknown>;
  };
  assets?: { image?: string };
  frontMatter?: Record<string, unknown>;
};

export function formatDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function toJournalPosts(items: readonly { readonly content: unknown }[]): JournalPost[] {
  return items.map(({ content }) => {
    const mod = content as PostModule;
    const m = mod.metadata;
    return {
      permalink: m.permalink,
      title: m.title,
      description: m.description,
      date: m.date,
      formattedDate: formatDate(m.date),
      readingMinutes: Math.max(1, Math.round(m.readingTime ?? 1)),
      category: m.tags[0] ?? null,
      tags: m.tags,
      authors: m.authors,
      image: mod.assets?.image ?? (m.frontMatter.image as string | undefined),
      featured: m.frontMatter.featured === true,
    };
  });
}

/** Lower-cased haystack for the client-side search box. */
export function searchText(p: JournalPost): string {
  return [p.title, p.description, p.category?.label, ...p.tags.map((t) => t.label), ...p.authors.map((a) => a.name)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
