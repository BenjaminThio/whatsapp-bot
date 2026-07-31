# Rebuilding emoji.jsonl

`scrape_emoji.py` regenerates `../emoji.jsonl`, the dataset behind `/emoji` on
both bots. One JSON object per line, matching the `EmojiEntry` interface in
`shared/lib/emoji-db.ts`.

Normally you restore this file from a backup. This exists for when you cannot.

## Inputs

| File | Role |
| --- | --- |
| `raw_emoji.json` | The seed list: 5,225 emoji with shortcode, render-quality status and Unicode version. **Cannot be derived** - keep it. |
| `category.json` | Which category each emoji belongs to. A cache; rebuild it with `--categories`. |

Both live here in the repo. `raw_emoji.json` is the one that matters: nothing
regenerates it, so losing it means the scraper has no list of what to scrape.

`category.json` covers 1,907 emoji, because Emojipedia's category pages list
base emoji only. The remaining 3,318 are mostly skin-tone variants, and a
variant is inherited from its base form rather than left empty - that fills
2,450 of the gap. The ~870 still uncategorised are genuinely absent from
Emojipedia's category listings; `/emoji` shows them with no category, which is
what the current shipped dataset does too.

## Running it

Through the wrapper, which handles the venv and the browser:

```bash
bash scripts/build-emoji.sh
```

Or directly:

```bash
../../../../.venv/bin/python scrape_emoji.py --no-designs
```

| Flag | Effect |
| --- | --- |
| *(none)* | Resume, or start. Full scrape including design history. |
| `--no-designs` | Skip the per-platform artwork history. ~2 MB instead of ~60 MB, and no browser needed. |
| `--verify` | Check the existing file. Scrapes nothing. |
| `--repair` | Re-scrape only the entries that came out incomplete. |
| `--categories` | Rebuild `category.json`, then exit. |
| `--limit N` | Stop after N. For a smoke test. |
| `--delay S` | Seconds between requests. Default 1.0. |
| `--headed` | Show the browser, for debugging selectors. |

**Resuming is automatic.** Whatever is already in `emoji.jsonl` is skipped, so
an interrupted run continues instead of starting over, and re-running never
duplicates an entry. Ctrl-C finishes the current emoji and exits cleanly; a
second Ctrl-C forces the issue.

## Cost

The design history is what makes this expensive: it is a real browser visiting
5,225 pages, so it takes many hours. `--no-designs` is a few thousand plain
HTTP requests and finishes far sooner, at the cost of `/emoji` not showing the
per-platform artwork timeline.

On ARM, Playwright often has no Chromium build at all, which is why
`setup.sh` falls back to `--no-designs` rather than failing.

This hammers one site. The default one-second delay is there on purpose.

## After a rebuild

The bots cache a byte-offset index at `../emoji.index.json`. It is keyed on the
dataset's size and mtime, so it invalidates itself - but `build-emoji.sh`
deletes it anyway, because a stale index means every lookup reads from the
wrong offset and fails in a way that looks nothing like the real cause.

## Notes on the scrape

Emojipedia's slugs do not follow directly from the shortcodes, so each emoji is
tried against several spellings in turn: the normalised slug, a `flag-` prefix,
underscores instead of hyphens, the bare shortcode, and `tonet` for the
skin-tone pages Emojipedia misspells. Accents are handled by NFKD normalisation
rather than a list of character replacements, so an accent nobody has hit yet
still works.

Design scraping clicks the "Emoji Designs" tab, which only responds once
Next.js has hydrated, so the click is retried - a bounded number of times. A
page that never activates the tab yields no designs and the scrape moves on.
