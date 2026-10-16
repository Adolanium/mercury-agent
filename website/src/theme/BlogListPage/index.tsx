import React from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import { PageMetadata, HtmlClassNameProvider, ThemeClassNames } from '@docusaurus/theme-common';
import SearchMetadata from '@theme/SearchMetadata';
import BlogListPageStructuredData from '@theme/BlogListPage/StructuredData';
import type { Props } from '@theme/BlogListPage';
import JournalIndex from '@site/src/components/Journal/JournalIndex';
import SocialMeta from '@site/src/components/Journal/SocialMeta';
import { toJournalPosts } from '@site/src/components/Journal/posts';

/** Blog home: featured post, search, category/author filters, sorting. */
export default function BlogListPage(props: Props): React.ReactElement {
  const { metadata, items } = props;
  return (
    <HtmlClassNameProvider className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogListPage, 'mj-root')}>
      <PageMetadata title={metadata.blogTitle} description={metadata.blogDescription} />
      <SearchMetadata tag="blog_posts_list" />
      <BlogListPageStructuredData {...props} />
      <SocialMeta permalink={metadata.permalink} title={metadata.blogTitle} imageAlt="Mercury Blog: news, engineering notes and field reports from the people building Mercury." breadcrumbs={[{ name: 'Mercury', path: '/' }, { name: 'Blog', path: '/blog' }]} />
      <Layout>
        <JournalIndex posts={toJournalPosts(items)} />
      </Layout>
    </HtmlClassNameProvider>
  );
}
