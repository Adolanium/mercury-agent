/**
 * Social cards for the Mercury Blog, rendered after every build.
 *
 * Every blog page gets its own 1200x630 JPEG at /img/og<permalink>.jpg:
 *
 *   /img/og/blog.jpg                    the blog home
 *   /img/og/blog/<slug>.jpg             each post
 *   /img/og/blog/tags/<tag>.jpg         each topic archive
 *   /img/og/blog/authors/<key>.jpg      each author archive
 *
 * The theme components point og:image / twitter:image at the same paths, so
 * a page and its card can never drift. A post can opt out with
 * `social_image: /img/whatever.jpg` in its front matter.
 *
 * Design: the site's light theme, text and the Mercury mark only. No author
 * names, photos or cover art, so the card reads the same in every feed.
 *
 * Why these choices:
 *   - 1200x630 (1.91:1) is the size X, Facebook, LinkedIn, WhatsApp, Slack,
 *     Discord and Telegram all render without cropping the long edge.
 *   - JPEG: WhatsApp drops preview images above roughly 300 KB.
 *   - Text stays inside a 72px safe margin and the title is large enough to
 *     read in a 500px-wide chat bubble.
 */
const fs = require('node:fs');
const path = require('node:path');

const W = 1200;
const H = 630;
const PAD = 72;
// Light theme tokens from src/css/custom.css.
const PAPER = '#fbfbf8';
const INK = '#111416';
const BODY = '#3c4347';
const DIM = '#6b7378';
const LINE = 'rgba(17, 20, 22, 0.10)';
const ACCENT = '#0b7285';

/** Minimal element factory for satori (it takes React-like objects). */
function h(type, style, ...children) {
  const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: { style: { display: 'flex', ...style }, children: kids.length === 1 ? kids[0] : kids } };
}
function img(src, style) {
  return { type: 'img', props: { src, style } };
}

function dataUri(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function titleSize(title) {
  const n = title.length;
  if (n <= 30) return 92;
  if (n <= 48) return 80;
  if (n <= 70) return 68;
  return 58;
}

module.exports = function blogSocialCardsPlugin(context) {
  const { siteDir } = context;
  const staticImg = (p) => path.join(siteDir, 'static', p.replace(/^\//, ''));

  return {
    name: 'mercury-blog-social-cards',
    async postBuild({ outDir, plugins }) {
      const blog = plugins?.find((p) => p.name === 'docusaurus-plugin-content-blog');
      const content = blog?.content;
      if (!content?.blogPosts) return;

      const { default: satori } = await import('satori');
      const { Resvg } = require('@resvg/resvg-js');
      const jpeg = require('jpeg-js');

      const fontDir = path.join(__dirname, 'og-fonts');
      const font = (name, file, weight) => ({ name, data: fs.readFileSync(path.join(fontDir, file)), weight, style: 'normal' });
      const fonts = [
        font('Serif', 'InstrumentSerif-Regular.ttf', 400),
        font('Sans', 'Geist-Regular.ttf', 400),
        font('Sans', 'Geist-Medium.ttf', 500),
        font('Sans', 'Geist-SemiBold.ttf', 600),
        font('Mono', 'GeistMono-Medium.ttf', 500),
      ];
      // The black Mercury mark used by the navbar in light mode.
      const logo = dataUri(staticImg('img/logo-mark-light.png'));

      async function render(tree, permalink) {
        const svg = await satori(tree, { width: W, height: H, fonts });
        const { pixels, width, height } = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render();
        const out = jpeg.encode({ data: pixels, width, height }, 90).data;
        const file = path.join(outDir, 'img', 'og', `${permalink.replace(/^\//, '')}.jpg`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, out);
        return out.length;
      }

      /** One light, text-only layout for every card. */
      function card({ eyebrow, title, dek, meta }) {
        return h(
          'div',
          { width: W, height: H, backgroundColor: PAPER, color: INK, fontFamily: 'Sans', flexDirection: 'column', justifyContent: 'space-between', padding: PAD, position: 'relative' },
          // brand row
          h(
            'div',
            { alignItems: 'center', justifyContent: 'space-between', width: '100%' },
            h('div', { alignItems: 'center', gap: 16 },
              img(logo, { width: 44, height: 59 }),
              h('div', { fontSize: 30, fontWeight: 600, letterSpacing: -0.4, color: INK }, 'Mercury Blog')),
            eyebrow
              ? h('div', {
                fontFamily: 'Mono', fontSize: 18, color: ACCENT, letterSpacing: 2.4, textTransform: 'uppercase',
                padding: '8px 16px', border: `1.5px solid rgba(11, 114, 133, 0.35)`, borderRadius: 999,
              }, eyebrow)
              : null,
          ),
          // title + dek
          h(
            'div',
            { flexDirection: 'column', gap: 22, maxWidth: W - PAD * 2 },
            h('div', { fontFamily: 'Serif', fontSize: titleSize(title), lineHeight: 1.04, letterSpacing: -1.4, color: INK, lineClamp: 3 }, title),
            dek ? h('div', { fontSize: 27, lineHeight: 1.42, color: BODY, lineClamp: 2 }, dek) : null,
          ),
          // footer
          h(
            'div',
            { alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingTop: 26, borderTop: `1.5px solid ${LINE}` },
            h('div', { fontSize: 21, color: DIM }, meta ?? ''),
            h('div', { fontFamily: 'Mono', fontSize: 20, color: DIM }, 'mercuryagent.sh/blog'),
          ),
        );
      }

      const written = [];
      const posts = content.blogPosts.filter((p) => !p.metadata.unlisted);

      for (const post of posts) {
        const m = post.metadata;
        if (m.frontMatter?.social_image) continue;
        const minutes = Math.max(1, Math.round(m.readingTime ?? 1));
        written.push([m.permalink, await render(card({
          eyebrow: m.tags[0]?.label,
          title: m.title,
          dek: m.description,
          meta: `${formatDate(m.date)} · ${minutes} min read`,
        }), m.permalink)]);
      }

      // Blog home.
      written.push(['/blog', await render(card({
        eyebrow: null,
        title: 'News, engineering notes and field reports',
        dek: 'From the people building Mercury, the open-source AI agent you can leave running.',
        meta: `${posts.length} posts`,
      }), '/blog')]);

      // Topic archives.
      for (const tag of Object.values(content.blogTags ?? {})) {
        if (tag.unlisted) continue;
        const count = tag.items?.length ?? 0;
        written.push([tag.permalink, await render(card({
          eyebrow: 'Topic',
          title: tag.label,
          dek: tag.description ?? null,
          meta: `${count} ${count === 1 ? 'post' : 'posts'}`,
        }), tag.permalink)]);
      }

      // Author archives: the archive is about a person, but the card stays text-only.
      const authors = new Map();
      for (const p of posts) for (const a of p.metadata.authors) if (a.page?.permalink) {
        const cur = authors.get(a.page.permalink) ?? { author: a, count: 0 };
        cur.count += 1;
        authors.set(a.page.permalink, cur);
      }
      for (const [permalink, { author, count }] of authors) {
        written.push([permalink, await render(card({
          eyebrow: 'Author',
          title: author.name,
          dek: author.description ?? author.title ?? null,
          meta: `${count} ${count === 1 ? 'post' : 'posts'}`,
        }), permalink)]);
      }

      const kb = written.map(([, n]) => n / 1024);
      console.log(`[mercury-blog-social-cards] ${written.length} cards, ${Math.round(Math.min(...kb))}-${Math.round(Math.max(...kb))} KB`);
    },
  };
};
