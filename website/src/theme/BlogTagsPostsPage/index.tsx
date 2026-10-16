import React from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import { PageMetadata, HtmlClassNameProvider, ThemeClassNames } from '@docusaurus/theme-common';
import SearchMetadata from '@theme/SearchMetadata';
import type { Props } from '@theme/BlogTagsPostsPage';
import JournalIndex from '@site/src/components/Journal/JournalIndex';
import SocialMeta from '@site/src/components/Journal/SocialMeta';
import { toJournalPosts } from '@site/src/components/Journal/posts';

/** Category / tag archive in the blog layout. */
export default function BlogTagsPostsPage({ tag, items }: Props): React.ReactElement {
  const title = `${tag.label} · Mercury Blog`;
  const description = tag.description ?? `Posts about ${tag.label.toLowerCase()} from the Mercury team.`;
  return (
    <HtmlClassNameProvider className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogTagPostListPage, 'mj-root')}>
      <PageMetadata title={title} description={description} />
      <SearchMetadata tag="blog_tags_posts" />
      <SocialMeta permalink={tag.permalink} title={title} imageAlt={`${tag.label}: ${description}`} breadcrumbs={[{ name: 'Mercury', path: '/' }, { name: 'Blog', path: '/blog' }, { name: tag.label, path: tag.permalink }]} />
      <Layout>
        <JournalIndex
          posts={toJournalPosts(items)}
          eyebrow="Mercury Blog · Topic"
          heading={tag.label}
          intro={`${description} ${tag.count} post${tag.count === 1 ? '' : 's'}.`}
          archive
        />
      </Layout>
    </HtmlClassNameProvider>
  );
}
