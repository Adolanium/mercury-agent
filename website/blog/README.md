# Writing for the Mercury Blog

This is the guide for anyone writing a post for [mercuryagent.sh/blog](https://mercuryagent.sh/blog), whether you're a person or an AI agent. Agents should also read [AGENTS.md](./AGENTS.md).

Every post is one folder in this directory, holding one Markdown file and its images. You don't need to touch any code. Social cards, search metadata, feeds and the Markdown copies for AI tools are all generated when the site builds.

## Contents

1. [Quick start](#quick-start)
2. [Front matter](#front-matter)
3. [Authors and tags](#authors-and-tags)
4. [Writing the post](#writing-the-post)
5. [Links and rich previews](#links-and-rich-previews)
6. [Images](#images)
7. [Code](#code)
8. [Callouts, tables and other formatting](#callouts-tables-and-other-formatting)
9. [Previewing locally](#previewing-locally)
10. [Before you open a pull request](#before-you-open-a-pull-request)
11. [What the build generates](#what-the-build-generates)

## Quick start

```bash
cd website/blog
cp -r _template 2026-11-03-your-post-name     # date first, then a short name
```

Then:

1. Edit `2026-11-03-your-post-name/index.md`.
2. Replace `cover.jpg` with your cover image, or delete the `image:` line.
3. Preview the post locally (see [Previewing locally](#previewing-locally)).
4. Open a pull request.

The folder layout looks like this:

```text
website/blog/
├── 2026-11-03-your-post-name/
│   ├── index.md          ← the post
│   ├── cover.jpg         ← banner and social card art
│   └── diagram.png       ← any other images the post uses
├── authors.yml           ← who can be listed as an author
├── tags.yml              ← the allowed topics
├── _template/            ← copy this to start a post (never published)
├── README.md             ← this guide (never published)
└── AGENTS.md             ← rules for AI agents (never published)
```

The date in the folder name is the publish date. Anything whose name starts with `_` is ignored by the build, so `_drafts/` or `_notes.md` are safe places for work in progress.

## Front matter

Every post starts with a YAML block:

```yaml
---
slug: your-post-name
title: "What happened, said plainly"
description: "One or two sentences, 120 to 160 characters. This is the text people see in Google, on X, in Slack and on WhatsApp, so make it say why the post is worth reading."
authors: [salman]
tags: [engineering, runtime]
image: ./cover.jpg
keywords: [node.js event loop, ai agent architecture, postmortem]
---
```

| Field | Required | What it does |
|---|---|---|
| `slug` | yes | The URL becomes `/blog/<slug>`. Use lowercase words joined by hyphens, and never change it after publishing. |
| `title` | yes | The page title and headline. Under about 60 characters fits search results and previews without being cut off. |
| `description` | yes | The search snippet, the line under the headline, and every share preview. |
| `authors` | yes | Keys from `authors.yml`. List more than one as `[salman, mercury-eng]`. |
| `tags` | yes | Keys from `tags.yml`. **The first tag is the category** shown on cards and in the post header. |
| `image` | recommended | The cover. It's shown as the banner on the post and drawn onto the generated social card. |
| `keywords` | recommended | Three to seven phrases people would actually search for. |
| `featured` | no | `true` pins the post to the large slot at the top of the blog home. Only one post should have it. |
| `social_image` | no | A path like `/img/og/custom.jpg` that replaces the generated social card. Use it only for a hand-designed card. |
| `hide_table_of_contents` | no | `true` hides the sidebar contents. It's hidden automatically when a post has fewer than three headings. |
| `draft` | no | `true` shows the post only in local development, never in the built site. |
| `unlisted` | no | `true` builds the page but keeps it out of the blog list, search engines, feeds and the sitemap. Use it to share a link for review. |

## Authors and tags

**Authors** are defined once in `authors.yml`:

```yaml
jane:
  name: Jane Doe
  title: Engineer, Cosmic Stack
  description: One line about what Jane writes about.
  url: https://github.com/janedoe
  image_url: https://github.com/janedoe.png   # GitHub avatar, always current
  page: true                                   # gives Jane an archive page
  socials:
    github: janedoe
    x: janedoe                                 # fills twitter:creator on her posts
```

Use the GitHub avatar URL for `image_url`, so a new profile picture shows up without any change here. Posts from the team as a whole use `mercury-eng`.

**Tags** must already exist in `tags.yml`, or the build fails on purpose. These are the current ones:

| Key | Use it for |
|---|---|
| `news` | Announcements and release stories |
| `engineering` | How something works or was built |
| `product` | Features and design decisions, from the user's side |
| `releases` | Version-specific notes |
| `security` | Permissions, sandboxing, vulnerabilities |
| `postmortem` | Something broke, and here is why |
| `runtime` | The daemon, attach, performance |
| `cloud` | Mercury Cloud |

To add a topic, add it to `tags.yml` with a `label`, `permalink` and `description`. The description appears on the topic's page and its social card.

## Writing the post

Readers are developers who run Mercury or are deciding whether to. Write the way a good engineer explains something to a colleague.

- **Open with what happened or what changed.** Put the thesis in the first paragraph, not after a warm-up.
- **Be specific.** Prefer measured numbers, real error messages, the actual code path and the actual fix. "About 3 ms per keystroke" beats "fast".
- **Say what went wrong.** Postmortems that admit the mistake are the posts people trust and share.
- **Keep it plain.** Use short sentences and the first person ("I", "we"). Avoid marketing words like "seamless", "revolutionary" or "game-changer".
- **Skip the AI tells.** No em dashes, no "In today's fast-paced world", no "Let's dive in", no "It's not just X, it's Y", and no closing paragraph that repeats the post.
- **Use headings for real sections.** Use `##` for sections and `###` sparingly. They build the table of contents and the reading-progress tracker.

Put the excerpt marker after the first paragraph or two. Everything above it appears on the blog home and in feeds:

```md
The opening paragraph that makes someone want to read the rest.

{/* truncate */}

## The first section
```

Posts are compiled as MDX, so a few characters behave differently from plain Markdown:

| Instead of | Write | Why |
|---|---|---|
| `<!-- comment -->` | `{/* comment */}` | HTML comments break the build. |
| A bare `{` or `}` in text | `` `{}` `` in backticks, or `\{` | Braces start JavaScript expressions. |
| A bare `<` in text, like `a <b` | `&lt;` or backticks | `<` starts a component. |

Code inside backticks and fenced blocks is always safe.

## Links and rich previews

There are three ways to link. Choose by what you want the reader to see.

### 1. An ordinary link

Write a Markdown link, with text, anywhere in a sentence:

```md
The fix landed in [pull request #189](https://github.com/cosmicstack-labs/mercury-agent/pull/189).
```

Use relative paths for pages on our own site:

```md
See the [permissions reference](/docs/reference/permissions) or [our last postmortem](/blog/we-were-running-mercury-twice).
```

A bare URL inside a sentence also stays an ordinary link: `Install it from https://mercuryagent.sh today.`

### 2. A rich preview (embed)

Paste the URL **on its own line**, with a blank line above and below and nothing else in the paragraph:

```md
Here's the report that started it:

https://x.com/someone/status/1234567890

The second paragraph continues here.
```

That URL becomes a native preview. The build fetches the title, text and stats ahead of time, so the preview works for search engines and without JavaScript. In the browser, it upgrades to the platform's own widget where one exists.

| Platform | URLs that work | What readers see |
|---|---|---|
| **X / Twitter** | `x.com/<user>/status/<id>`, `twitter.com/...` | The real post widget, matching light or dark theme |
| **YouTube** | `youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/shorts/<id>`, `?t=90` for a start time | A thumbnail with a play button. The player loads on click, from YouTube's privacy-enhanced domain. Shorts are shown vertical. |
| **Instagram** | `instagram.com/p/<id>/`, `/reel/<id>/` | Instagram's own embed, with caption |
| **GitHub repository** | `github.com/<owner>/<repo>` | A repo card with description, topics, language, stars, forks and license |
| **GitHub issue or PR** | `github.com/<owner>/<repo>/issues/<n>`, `/pull/<n>` | Title, open, closed or merged state, labels, author, comments, and lines changed for PRs |
| **GitHub release** | `github.com/<owner>/<repo>/releases/tag/<tag>` | Tag, release name, date and the start of the notes |
| **GitHub profile** | `github.com/<user>` | Avatar, name, bio, followers and repositories |
| **GitHub gist** | `gist.github.com/<user>/<id>` | File name, description and the first lines of code |
| **Other GitHub pages** | commits, files, discussions | GitHub's own social card image |
| **Bluesky** | `bsky.app/profile/<handle>/post/<id>` | Bluesky's own post widget |
| **TikTok** | `tiktok.com/@<user>/video/<id>` | TikTok's own player |
| **Vimeo** | `vimeo.com/<id>` | A thumbnail, then the player on click |
| **Spotify** | `open.spotify.com/` followed by `track`, `album`, `playlist`, `episode` or `show`, then `/<id>` | Spotify's player |
| **Loom** | `loom.com/share/<id>` | The Loom player |
| **CodePen** | `codepen.io/<user>/pen/<id>` | A live pen, matching the theme |
| **Mastodon** | `https://<server>/@<user>/<id>` | The post from its own server |
| **Anything else** | any `https://` page | A link card with the page's title, description, image and site icon |

A few things to know:

- **Leave the link text empty.** A Markdown link with its own text, like `[text](url)`, is always an ordinary link. To show a link without a preview, give it text.
- **Previews are cached.** The build keeps fetched data for a week. To refresh one sooner, delete `website/node_modules/.cache/mercury-embeds.json` and rebuild.
- **A failed fetch never breaks the build.** If a site can't be reached, the post gets a plainer card and the build log names the URL.
- **Embeds can go anywhere.** They work inside lists and block quotes as well as at the top level.
- **Many GitHub links?** Build with a `GITHUB_TOKEN` environment variable set to lift GitHub's anonymous rate limit.

### 3. A call-to-action link

Write an ordinary link and bold it:

```md
**[Read the release notes →](/docs/releases/1.3.1)**
```

## Images

Put images in the post's folder and reference them relatively:

```md
![The attach handshake: the terminal asks the daemon for its PID before opening a session](./attach-flow.png)
```

- **Always write alt text** that says what the image shows. It helps screen readers and search engines.
- **Keep the size down.** Use PNG for screenshots and diagrams and JPEG for photos, each under about 300 KB. The build fingerprints and caches them automatically.
- **Add a caption** by putting an italic line directly under the image: `*Median keystroke latency, before and after.*`
- **Prefer dark screenshots.** Most readers use the dark theme, and one well-cropped dark screenshot reads fine in both themes.

**The cover** (`cover.jpg`) should be 1600×900 pixels, under 150 KB, and work cropped into a wide banner and into a tall panel. Abstract art works better than text, because the post title is drawn onto the social card for you. The existing covers are soft gradients with thin rings or grids in the site's teal, amber and violet.

## Code

Use fenced blocks with a language. The language appears as a label on the block:

````md
```ts
const health = await fetch(`http://127.0.0.1:${port}/api/health`);
```
````

**Add a file name** with `title`, which replaces the language label:

````md
```ts title="src/core/attach.ts"
export async function attach(port: number) { /* ... */ }
```
````

**Highlight lines** with a range after the language, or with a `highlight-next-line` comment inside the code:

````md
```ts {2}
autoDaemonize();
await runAgent();
```

```ts
autoDaemonize();
// highlight-next-line
await runAgent();
```
````

**Add line numbers** with `showLineNumbers` after the language.

These languages are coloured: `ts`, `tsx`, `js`, `jsx`, `json`, `bash` (also `sh` and `shell`), `yaml`, `toml`, `ini`, `diff`, `python`, `go`, `rust`, `powershell`, `docker`, `sql`, `graphql`, `markdown`, `css` and `html`. Use `text` for terminal output. It's labelled "Output" and isn't coloured.

Every block gets a copy button on hover. Keep lines under about 90 characters, because longer ones scroll sideways on phones. Use single backticks for commands, file names, flags and identifiers in a sentence, like `` `mercury upgrade` ``.

## Callouts, tables and other formatting

**Callouts** for the occasional warning or aside:

```md
:::note
The npm package needs Node.js 22. The standalone binary carries its own runtime.
:::

:::warning[Breaking change]
`--legacy-attach` was removed in 1.3.
:::
```

The available types are `note`, `tip`, `info`, `warning` and `danger`. Use them rarely, because a post full of boxes reads like documentation.

**Tables** use standard Markdown pipes with a header row. **Pull quotes** use `>` and appear in the large serif face. Save them for one sentence worth repeating.

**Footnotes** are written as `Text with a note.[^1]` in the body and `[^1]: The note.` at the end of the post.

## Previewing locally

```bash
cd website
npm install                        # first time only, needs Node.js 22
npx docusaurus start               # live preview at http://localhost:3000/blog
```

`start` reloads as you type and shows drafts. Social cards, `llms.txt` and the Markdown copies only exist in a production build:

```bash
npx docusaurus build && npx docusaurus serve   # http://localhost:3000/blog
```

**Never run `npm run build:prod` locally.** It replaces the deployed site in `docs/`.

## Before you open a pull request

- [ ] The folder is named `YYYY-MM-DD-short-name`, and `slug` matches the short name.
- [ ] `title`, `description`, `authors` and `tags` are filled in, and the first tag is the right category.
- [ ] `{/* truncate */}` comes after the opening.
- [ ] Every claim about Mercury matches the code or the release notes. Version numbers, defaults, flags and file paths have been checked.
- [ ] Every image has alt text and is under about 300 KB.
- [ ] `npx docusaurus build` finishes with `[SUCCESS]` and no broken-link warnings.
- [ ] You read the post once in light mode and once in dark mode, in a phone-width window.
- [ ] Any unlisted test or draft post you don't intend to publish is removed.

## What the build generates

You don't create any of these. They're listed so you know they exist:

| Output | Where | Used by |
|---|---|---|
| Social card, 1200×630 JPEG | `/img/og/blog/<slug>.jpg`, plus topic, author and home cards | X, LinkedIn, Facebook, WhatsApp, Slack, Discord and Telegram previews |
| Markdown copy | `/blog/<slug>.md` | The "Copy as Markdown" button, AI tools, readers who prefer plain text |
| `llms.txt`, `llms-full.txt` | site root | AI assistants and crawlers following the llmstxt.org convention |
| RSS, Atom, JSON Feed | `/blog/rss.xml`, `/blog/atom.xml`, `/blog/feed.json` | Feed readers |
| Sitemap entries and structured data | `/sitemap.xml`, inside each page | Search engines |
| Search index | built in | The site search box and the blog search |
