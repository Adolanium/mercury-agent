# Instructions for AI agents writing Mercury Blog posts

You are writing for the engineering blog at https://mercuryagent.sh/blog. Its readers are developers who run Mercury, an open-source AI agent, or are evaluating it. They notice vague claims and AI-sounding prose, and either one costs us their trust.

[README.md](./README.md) is the full reference for formatting, embeds, images and code. This file holds the rules. When the two disagree, this file wins.

## Where things go

- **One folder per post.** Create `website/blog/YYYY-MM-DD-<slug>/index.md`, starting from `_template/`: `cp -r website/blog/_template website/blog/2026-11-03-<slug>`.
- **Images live in the post's folder.** Reference them relatively, as `./name.png`. Never put post images in `static/`.
- **Generate a cover** with `python3 website/blog/_tools/make-cover.py <slug> website/blog/<folder>/cover.jpg`. It needs Pillow. Pick a `--style` that suits the topic.
- **Don't create posts anywhere else.** Not under `docs/` (the deployed site, overwritten by builds) and not under `website/docs/` (product documentation).
- **Drafts.** Set `draft: true` while working, or keep notes in a folder whose name starts with `_`, which the build ignores.

## Files you may change

| Change | Allowed? |
|---|---|
| Your post's folder | Yes |
| `authors.yml` | Only to add an author the user named, with their real GitHub avatar |
| `tags.yml` | Only to add a topic the user asked for |
| `README.md`, `AGENTS.md` | Only when asked to update the guides |
| `src/`, `plugins/`, `docusaurus.config.ts`, other posts | No, unless the task is explicitly about the blog's code |

## Front matter

Required fields are `slug`, `title`, `description`, `authors` and `tags`. Add `image: ./cover.jpg` and `keywords` too.

- **Slug.** It matches the folder name without the date: lowercase words joined by hyphens.
- **Title.** Under about 60 characters. It's a statement, not clickbait.
- **Description.** 120 to 160 characters saying concretely what the reader will learn. It's used for search and every share preview.
- **Authors.** Use only keys that exist in `authors.yml`. Use `mercury-eng` unless the user tells you who the author is. Never invent a person.
- **Tags.** Use only keys from `tags.yml`. The first tag is the category: `news`, `engineering`, `product`, `releases`, `security`, `postmortem`, `runtime` or `cloud`. An unknown tag fails the build.
- **Featured.** Don't set `featured: true` unless asked. Only one post holds it.

## Accuracy comes first

- **Check every claim against the source.** Before you write a version number, default value, flag, command, file path, limit or behaviour, find it in the Mercury code (`src/`), the release notes (`website/docs/releases/`), `CHANGELOG.md` or `DECISIONS.md`. If you can't confirm something, leave it out or ask.
- **Don't invent numbers.** Benchmarks, user counts, stars, quotes and dates must come from a real source the user gave you or that you checked. Leave out what you can't check.
- **Don't fabricate embeds.** Every embedded tweet, video or issue must be a real URL you were given or verified. Never guess a post ID.
- **Link to the evidence.** Link the pull request, the docs page or the release notes for each important claim.

## Voice

Write like a senior engineer explaining something to a colleague who's sharp but busy.

- **Lead with the point.** The first paragraph says what happened or what changed.
- **Be specific and concrete.** Use real error messages, real numbers and the real code path.
- **Use the first person, and admit mistakes plainly.**
- **Keep sentences short.** Use plain words and active voice.

Never use any of these:

- **Em dashes.** Use a full stop, a comma or a colon instead.
- **Stock openers and closers.** "In today's world", "Let's dive in", "In conclusion", "It's worth noting", "At the end of the day".
- **Contrast clichés.** "It's not just X, it's Y", or "X isn't about Y. It's about Z."
- **Marketing words.** "seamless", "robust", "revolutionary", "game-changer", "unlock", "empower", "leverage", "cutting-edge", "supercharge".
- **Filler structure.** A closing paragraph that summarises the post, a row of three adjectives, or a rhetorical question used as a heading.
- **Decoration.** Emoji in headings or body text.

Length: news posts run 500 to 900 words, and engineering posts and postmortems 900 to 1,800. Use `##` headings for real sections, at least three in a long post, because they build the table of contents.

## Markdown rules that break the build if ignored

The file is compiled as MDX:

- Put `{/* truncate */}` on its own line after the opening paragraph or two. Never use `<!-- -->` comments.
- Wrap `{`, `}` and `<` in backticks when they're used in prose, or escape them.
- Always give fenced code blocks a language: `ts`, `bash`, `json`, `yaml`, `diff`, or `text` for output. Add `title="path/to/file.ts"` when the code comes from a real file.

## Links and previews

- **Ordinary link.** Use `[descriptive text](url)`. For pages on this site, use a relative path such as `/docs/...` or `/blog/<slug>`.
- **Rich preview.** Put the bare URL alone on its own line, with blank lines around it. This works for X, YouTube, Instagram, GitHub, Bluesky, TikTok, Vimeo, Spotify, Loom, CodePen, Mastodon, and any site with Open Graph tags. Use previews only where seeing the thing adds something, such as the issue that started a fix, a demo video, or the repo at the end of a release post. Two or three per post at most.
- **No preview.** If a URL must appear without a preview, give it link text.

## Check your work

Run these from `website/`:

```bash
npx docusaurus build          # must print [SUCCESS], with no broken links
npx docusaurus serve          # open http://localhost:3000/blog/<slug>
```

Then confirm:

- [ ] The post appears on `/blog` under the right category, and the search box finds it.
- [ ] `build/img/og/blog/<slug>.jpg` exists, and the title fits in three lines or fewer.
- [ ] `build/blog/<slug>.md` exists and reads cleanly.
- [ ] `grep -n "—" index.md` finds nothing.
- [ ] Every embed renders as a card, not as a plain URL.

**Never run `npm run build:prod`.** It overwrites the deployed site in `docs/`.

## Git

- Work on a branch and leave the push to the user. Don't push, publish or release unless the user says so for this specific post.
- Commit with the user's own git identity. End the commit message with exactly this trailer and no other attribution:

  ```
  Co-Authored-By: Mercury <mercury@cosmicstack.org>
  ```

- Remove any unlisted test posts before the branch is merged.
