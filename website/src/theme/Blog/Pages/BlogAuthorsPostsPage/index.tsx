import React from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import { PageMetadata, HtmlClassNameProvider, ThemeClassNames } from '@docusaurus/theme-common';
import SearchMetadata from '@theme/SearchMetadata';
import type { Props } from '@theme/Blog/Pages/BlogAuthorsPostsPage';
import JournalIndex from '@site/src/components/Journal/JournalIndex';
import SocialMeta from '@site/src/components/Journal/SocialMeta';
import { toJournalPosts } from '@site/src/components/Journal/posts';

/** Everything one author has written, in the blog layout. */
export default function BlogAuthorsPostsPage({ author, items }: Props): React.ReactElement {
  const name = author.name ?? author.key;
  const title = `${name} · Mercury Blog`;
  const intro = [author.title, author.description].filter(Boolean).join('. ');
  return (
    <HtmlClassNameProvider className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogAuthorsPostsPage, 'mj-root')}>
      <PageMetadata title={title} description={intro || `Posts by ${name}.`} />
      <SearchMetadata tag="blog_authors_posts" />
      <SocialMeta permalink={author.page?.permalink ?? `/blog/authors/${author.key}`} title={title} imageAlt={`Posts by ${name} on the Mercury Blog`} breadcrumbs={[{ name: 'Mercury', path: '/' }, { name: 'Blog', path: '/blog' }, { name, path: author.page?.permalink ?? '/blog/authors' }]} />
      <Layout>
        <JournalIndex posts={toJournalPosts(items)} eyebrow="Mercury Blog · Author" heading={name} intro={intro || undefined} archive />
      </Layout>
    </HtmlClassNameProvider>
  );
}
