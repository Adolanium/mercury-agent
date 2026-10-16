import React from 'react';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

/**
 * Social and search metadata shared by every blog page. The card image is
 * generated at build time by plugins/blog-social-cards.cjs at
 * /img/og<permalink>.jpg, so the path here is derived the same way.
 */
/** Bump when the card design changes, so X, WhatsApp and LinkedIn refetch instead of showing a cached card. */
const CARD_VERSION = '2';

export function cardPath(permalink: string): string {
  return `/img/og${permalink.replace(/\/$/, '')}.jpg?v=${CARD_VERSION}`;
}

interface Props {
  permalink: string;
  title: string;
  imageAlt: string;
  /** Overrides the generated card (front matter `social_image`). */
  image?: string;
  /** Extra label/value pairs shown by Slack and some other unfurlers. */
  labels?: [string, string][];
  creators?: string[];
  section?: string;
  breadcrumbs?: { name: string; path: string }[];
}

export default function SocialMeta({ permalink, title, imageAlt, image, labels = [], creators = [], section, breadcrumbs }: Props): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const abs = (p: string) => (/^https?:/.test(p) ? p : `${siteConfig.url}${p}`);
  const card = abs(image ?? cardPath(permalink));
  const isJpeg = /\.jpe?g(\?|$)/i.test(card);
  const crumbs = breadcrumbs && {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name, item: abs(b.path) })),
  };
  return (
    <Head>
      <meta property="og:image" content={card} />
      <meta property="og:image:secure_url" content={card} />
      {!image && <meta property="og:image:type" content={isJpeg ? 'image/jpeg' : 'image/png'} />}
      {!image && <meta property="og:image:width" content="1200" />}
      {!image && <meta property="og:image:height" content="630" />}
      <meta property="og:image:alt" content={imageAlt} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content={card} />
      <meta name="twitter:image:alt" content={imageAlt} />
      <meta property="og:title" content={title} />
      <meta name="twitter:title" content={title} />
      {creators[0] && <meta name="twitter:creator" content={creators[0]} />}
      {section && <meta property="article:section" content={section} />}
      {labels.slice(0, 2).flatMap(([label, value], i) => [
        <meta key={`l${i}`} name={`twitter:label${i + 1}`} content={label} />,
        <meta key={`d${i}`} name={`twitter:data${i + 1}`} content={value} />,
      ])}
      {crumbs && <script type="application/ld+json">{JSON.stringify(crumbs)}</script>}
    </Head>
  );
}
