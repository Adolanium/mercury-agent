import MDXComponents from '@theme-original/MDXComponents';
import SocialEmbed from '@site/src/components/Journal/SocialEmbed';
import { BarChart, Compare, Stats, Td } from '@site/src/components/Journal/Charts';

/**
 * Global MDX components:
 * - SocialEmbed is emitted by plugins/remark-social-embeds.cjs for bare links.
 * - Compare / BarChart / Stats are usable in any post without an import.
 * - td turns a leading ✓ ◐ ✕ ? into a yes / partial / no / unknown badge.
 */
export default {
  ...MDXComponents,
  td: Td,
  SocialEmbed,
  Compare,
  BarChart,
  Stats,
};
