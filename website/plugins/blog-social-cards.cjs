/**
 * Social cards for the Mercury Journal, rendered after every build.
 *
 * Every journal page gets its own 1200x630 JPEG at /img/og<permalink>.jpg:
 *
 *   /img/og/blog.jpg                    the journal home
 *   /img/og/blog/<slug>.jpg             each post: title, category, author,
 *                                       date, reading time and its cover art
 *   /img/og/blog/tags/<tag>.jpg         each topic archive
 *   /img/og/blog/authors/<key>.jpg      each author archive
 *
 * The theme components point og:image / twitter:image at the same paths, so
 * a page and its card can never drift. A post can opt out with
 * `social_image: /img/whatever.jpg` in its front matter.
 *
 * Why these choices:
 *   - 1200x630 (1.91:1) is the size X, Facebook, LinkedIn, WhatsApp, Slack,
 *     Discord and Telegram all render without cropping the long edge.
 *   - JPEG, not PNG: WhatsApp drops preview images above roughly 300 KB, and
 *     the gradient covers compress far better as JPEG. Cards land ~60-120 KB.
 *   - Text stays inside a 64px safe margin and the title is large enough to
 *     read in a 500px-wide chat bubble.
 */
const fs = require('node:fs');
const path = require('node:path');

const W = 1200;
const H = 630;
const INK = '#0b0e12';
const DIM = 'rgba(232, 238, 245, 0.62)';
const ACCENT = '#7dd3e0';

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

const remoteCache = new Map();
async function remoteDataUri(url) {
  if (remoteCache.has(url)) return remoteCache.get(url);
  let out = null;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? 'image/png';
      out = `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    }
  } catch {
    out = null;
  }
  remoteCache.set(url, out);
  return out;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function titleSize(title) {
  const n = title.length;
  if (n <= 32) return 76;
  if (n <= 52) return 66;
  if (n <= 72) return 58;
  return 50;
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
      const logo = dataUri(staticImg('img/logo-dark.png'));
      const houseAvatar = dataUri(staticImg('img/avatar-mercury.png'));

      async function avatarFor(author) {
        const url = author?.imageURL;
        if (!url) return houseAvatar;
        if (/^https?:/.test(url)) {
          const sized = /github\.com\/[^/]+\.png$/.test(url) ? `${url}?size=160` : url;
          return (await remoteDataUri(sized)) ?? houseAvatar;
        }
        const local = staticImg(url);
        return fs.existsSync(local) ? dataUri(local) : houseAvatar;
      }

      async function render(tree, permalink) {
        const svg = await satori(tree, { width: W, height: H, fonts });
        const { pixels, width, height } = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render();
        const out = jpeg.encode({ data: pixels, width, height }, 86).data;
        const file = path.join(outDir, 'img', 'og', `${permalink.replace(/^\//, '')}.jpg`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, out);
        return out.length;
      }

      /* Shared frame: brand row, body, footer row, optional right panel. */
      function frame({ eyebrow, title, dek, footer, panel }) {
        const size = titleSize(title);
        return h(
          'div',
          { width: W, height: H, backgroundColor: INK, color: '#f2f5f8', fontFamily: 'Sans', position: 'relative' },
          h('div', {
            position: 'absolute', left: -160, top: -220, width: 760, height: 760, borderRadius: 760,
            backgroundImage: 'radial-gradient(circle, rgba(64,170,200,0.20), rgba(11,14,18,0) 70%)',
          }),
          h(
            'div',
            { flexDirection: 'column', justifyContent: 'space-between', padding: '56px 0 56px 64px', width: panel ? 700 : W - 128, height: H },
            h(
              'div',
              { alignItems: 'center', gap: 14 },
              img(logo, { width: 40, height: 40 }),
              h('div', { fontSize: 24, fontWeight: 600, letterSpacing: -0.3 }, 'Mercury Journal'),
              eyebrow ? h('div', { fontFamily: 'Mono', fontSize: 17, color: ACCENT, letterSpacing: 2.4, textTransform: 'uppercase', marginLeft: 10, padding: '6px 14px', border: '1.5px solid rgba(125,211,224,0.45)', borderRadius: 999 }, eyebrow) : null,
            ),
            h(
              'div',
              { flexDirection: 'column', gap: 18 },
              h('div', { fontFamily: 'Serif', fontSize: size, lineHeight: 1.04, letterSpacing: -1.2, lineClamp: 3 }, title),
              dek ? h('div', { fontSize: 24, lineHeight: 1.4, color: DIM, lineClamp: 2 }, dek) : null,
            ),
            footer,
          ),
          panel
            ? h('div', { position: 'absolute', right: 56, top: 56, width: 380, height: H - 112, borderRadius: 28, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.10)' }, panel)
            : null,
        );
      }

      function byline(avatar, name, meta) {
        return h(
          'div',
          { alignItems: 'center', gap: 16 },
          img(avatar, { width: 52, height: 52, borderRadius: 52, border: '2px solid rgba(255,255,255,0.18)' }),
          h('div', { flexDirection: 'column', gap: 4 },
            h('div', { fontSize: 22, fontWeight: 600 }, name),
            h('div', { fontSize: 19, color: DIM }, meta)),
        );
      }

      const siteRow = (left) => h('div', { alignItems: 'center', justifyContent: 'space-between', width: '100%' },
        left, h('div', { fontFamily: 'Mono', fontSize: 18, color: DIM }, 'mercuryagent.sh/blog'));

      const coverPanel = (src) => img(src, { width: 380, height: H - 112, objectFit: 'cover' });
      const markPanel = (src, round) => h('div', {
        width: 380, height: H - 112, alignItems: 'center', justifyContent: 'center',
        backgroundImage: 'radial-gradient(circle at 50% 42%, rgba(64,170,200,0.45), rgba(20,26,34,1) 72%)',
      }, img(src, { width: round ? 200 : 230, height: round ? 200 : 230, borderRadius: round ? 200 : 0 }));

      const written = [];
      const posts = content.blogPosts.filter((p) => !p.metadata.unlisted || p.metadata.frontMatter?.social_card === true);

      for (const post of posts) {
        const m = post.metadata;
        if (m.frontMatter?.social_image) continue;
        const srcDir = path.dirname(path.join(siteDir, m.source.replace(/^@site\//, '')));
        const coverRel = m.frontMatter?.image;
        const coverFile = typeof coverRel === 'string' && !/^https?:/.test(coverRel)
          ? (coverRel.startsWith('/') ? staticImg(coverRel) : path.join(srcDir, coverRel))
          : null;
        const cover = coverFile && fs.existsSync(coverFile) ? dataUri(coverFile) : null;
        const lead = m.authors[0];
        const names = m.authors.map((a) => a.name).join(' & ');
        const minutes = Math.max(1, Math.round(m.readingTime ?? 1));
        const tree = frame({
          eyebrow: m.tags[0]?.label,
          title: m.title,
          dek: null,
          footer: siteRow(byline(await avatarFor(lead), names || 'Mercury', `${formatDate(m.date)} · ${minutes} min read`)),
          panel: cover ? coverPanel(cover) : markPanel(logo),
        });
        written.push([m.permalink, await render(tree, m.permalink)]);
      }

      // Journal home.
      const listed = posts.filter((p) => !p.metadata.unlisted);
      written.push(['/blog', await render(frame({
        eyebrow: null,
        title: 'News, engineering notes and field reports',
        dek: 'From the people building Mercury, the open-source AI agent you can leave running.',
        footer: siteRow(h('div', { fontSize: 20, color: DIM }, `${listed.length} posts · RSS · llms.txt`)),
        panel: markPanel(logo),
      }), '/blog')]);

      // Topic archives.
      for (const tag of Object.values(content.blogTags ?? {})) {
        if (tag.unlisted) continue;
        const count = tag.items?.length ?? 0;
        written.push([tag.permalink, await render(frame({
          eyebrow: 'Topic',
          title: tag.label,
          dek: tag.description ?? null,
          footer: siteRow(h('div', { fontSize: 20, color: DIM }, `${count} ${count === 1 ? 'post' : 'posts'}`)),
          panel: markPanel(logo),
        }), tag.permalink)]);
      }

      // Author archives.
      const authors = new Map();
      for (const p of listed) for (const a of p.metadata.authors) if (a.page?.permalink) {
        const cur = authors.get(a.page.permalink) ?? { author: a, count: 0 };
        cur.count += 1;
        authors.set(a.page.permalink, cur);
      }
      for (const [permalink, { author, count }] of authors) {
        const avatar = await avatarFor(author);
        written.push([permalink, await render(frame({
          eyebrow: 'Author',
          title: author.name,
          dek: author.description ?? author.title ?? null,
          footer: siteRow(h('div', { fontSize: 20, color: DIM }, `${author.title ? `${author.title} · ` : ''}${count} ${count === 1 ? 'post' : 'posts'}`)),
          panel: markPanel(avatar, true),
        }), permalink)]);
      }

      const kb = written.map(([, n]) => n / 1024);
      console.log(`[mercury-blog-social-cards] ${written.length} cards, ${Math.round(Math.min(...kb))}-${Math.round(Math.max(...kb))} KB`);
    },
  };
};
