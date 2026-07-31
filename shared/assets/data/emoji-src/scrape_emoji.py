#!/usr/bin/env python3
"""
scrape_emoji.py - rebuild shared/assets/data/emoji.jsonl from Emojipedia.

One JSON object per line, matching the EmojiEntry interface in
shared/lib/emoji-db.ts. Seeded from raw_emoji.json (5,225 emoji, their
shortcodes, render-quality status and Unicode version) and enriched with the
name, descriptions, category and per-platform design history scraped from
emojipedia.org.

  scrape_emoji.py                  resume, or start if there is nothing yet
  scrape_emoji.py --no-designs     skip the design history - much faster, and
                                   the output drops from ~60 MB to ~2 MB
  scrape_emoji.py --verify         check the existing file, scrape nothing
  scrape_emoji.py --repair         re-scrape only the entries that came out
                                   incomplete last time
  scrape_emoji.py --categories     rebuild category.json, then exit
  scrape_emoji.py --limit 20       stop after 20, for a smoke test

Resuming is automatic: whatever is already in emoji.jsonl is skipped, so an
interrupted run continues rather than starting over, and re-running never
duplicates an entry. Ctrl-C finishes the current emoji and exits cleanly.

This makes thousands of requests to one site. It sleeps between them by
default; --delay controls that, and lowering it to zero is not polite.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import signal
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterator

import requests
from bs4 import BeautifulSoup, Tag
from requests import Response, Session
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE.parent

RAW_FILE = HERE / "raw_emoji.json"
CATEGORY_FILE = HERE / "category.json"
OUT_FILE = DATA_DIR / "emoji.jsonl"

BASE_URL = "https://emojipedia.org/"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"

CATEGORIES: dict[str, str] = {
    "Smileys": "smileys",
    "People": "people",
    "Animals & Nature": "nature",
    "Food & Drink": "food-drink",
    "Activity": "activity",
    "Travel & Places": "travel-places",
    "Objects": "objects",
    "Symbols": "symbols",
    "Flags": "flags",
}

# Chromium leaks across thousands of navigations; recycle the page periodically
PAGE_RECYCLE_EVERY = 200

STOP = False


def _on_signal(_sig: int, _frm: Any) -> None:
    global STOP
    if STOP:
        print("\nSecond interrupt - exiting now.", file=sys.stderr)
        sys.exit(130)
    STOP = True
    print("\nFinishing the current emoji, then stopping. Ctrl-C again to force.", file=sys.stderr)


signal.signal(signal.SIGINT, _on_signal)
signal.signal(signal.SIGTERM, _on_signal)


def log(msg: str) -> None:
    print(msg, flush=True)


# ── Slugs ─────────────────────────────────────────────────────────────────────

# Emojipedia's own irregularities, not something a general rule can derive
_SLUG_FIXES = {"flag_for": "flag-"}


def code_to_slug(code: str) -> str:
    """
    Turn a shortcode like ':1st_place_medal:' into an Emojipedia slug.

    The original did this with a chain of twenty .replace() calls, one per
    accented character it happened to hit. Normalising to NFKD and dropping the
    combining marks handles every accent, including the ones not encountered
    yet.
    """
    s = code.strip(":")
    for old, new in _SLUG_FIXES.items():
        s = s.replace(old, new)

    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))

    s = s.replace("_", "-")
    s = re.sub(r"[^a-zA-Z0-9-]", "", s)
    s = re.sub(r"-{2,}", "-", s)
    return s.strip("-").lower()


def slug_candidates(code: str) -> list[str]:
    """
    Every spelling worth trying, in order, before giving up on an emoji.

    Deduplicated while preserving order: several of these collapse to the same
    string for many codes, and each duplicate would otherwise cost another
    round trip and another delay on exactly the emoji that are already failing.
    """
    base = code_to_slug(code)
    bare = code.replace(":", "")
    ordered = [
        base,
        f"flag-{base}",
        base.replace("-", "_"),
        bare,
        # Emojipedia misspells some skin-tone pages
        bare.replace("tone", "tonet"),
    ]
    return list(dict.fromkeys(s for s in ordered if s))


# ── JSONL ─────────────────────────────────────────────────────────────────────


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """Yield every parseable record, warning about (and skipping) damaged lines."""
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as e:
                log(f"  ! line {n} is not valid JSON ({e}) - skipping it")


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    """
    Append one record durably.

    A half-written line breaks the byte-offset index the bots build over this
    file, and the failure shows up later as a JSON parse error in the middle of
    a word. Serialise first so a formatting error cannot truncate the file, then
    flush and fsync so a crash cannot leave the line partly on disk.
    """
    payload = json.dumps(record, ensure_ascii=False)
    if "\n" in payload:
        raise ValueError("record serialised with an embedded newline")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(payload + "\n")
        f.flush()
        os.fsync(f.fileno())


def done_characters(path: Path) -> set[str]:
    return {r["character"] for r in read_jsonl(path) if "character" in r}


# ── Designs, over one long-lived browser ──────────────────────────────────────


class DesignScraper:
    """
    Scrapes the 'Emoji Designs' tab.

    The original launched a fresh Chromium for every emoji. At 5,225 emoji and
    roughly a second of startup each, that alone was over an hour of pure
    browser launches. One browser is reused for the whole run here.

    It also looped `while True` waiting for the tab to activate, with nothing
    bounding the retries, so a page that never rendered the tab hung the whole
    scrape indefinitely. The retries are bounded now and a failure returns no
    designs instead of stopping everything.
    """

    MAX_TAB_ATTEMPTS = 8

    def __init__(self, headless: bool = True) -> None:
        self._headless = headless
        self._pw = None
        self._browser = None
        self._page = None
        self._pages_used = 0

    def __enter__(self) -> "DesignScraper":
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self._headless)
        self._new_page()
        return self

    def __exit__(self, *_exc: Any) -> None:
        for closer in (
            lambda: self._page and self._page.close(),
            lambda: self._browser and self._browser.close(),
            lambda: self._pw and self._pw.stop(),
        ):
            try:
                closer()
            except Exception:
                pass

    def _new_page(self) -> None:
        if self._page is not None:
            try:
                self._page.close()
            except Exception:
                pass
        self._page = self._browser.new_page(user_agent=USER_AGENT)
        self._page.set_default_timeout(30000)
        self._pages_used = 0

    def scrape(self, url: str) -> list[dict[str, Any]]:
        if self._pages_used >= PAGE_RECYCLE_EVERY:
            self._new_page()
        self._pages_used += 1

        try:
            return self._scrape_inner(url)
        except Exception as e:
            log(f"  ! designs failed for {url}: {type(e).__name__}: {e}")
            # A page can be left wedged after a timeout; start a clean one
            try:
                self._new_page()
            except Exception:
                pass
            return []

    def _scrape_inner(self, url: str) -> list[dict[str, Any]]:
        page = self._page
        page.goto(url, wait_until="domcontentloaded")

        tab = page.locator('a[role="tab"]', has_text="Emoji Designs")
        active = page.locator('a[role="tab"][data-active="true"]', has_text="Emoji Designs")

        try:
            tab.wait_for(state="visible", timeout=20000)
        except Exception:
            return []  # this emoji simply has no designs tab

        for attempt in range(1, self.MAX_TAB_ATTEMPTS + 1):
            if STOP:
                return []
            try:
                tab.evaluate("node => node.click()")
                active.wait_for(state="attached", timeout=1500)
                break
            except Exception:
                if attempt == self.MAX_TAB_ATTEMPTS:
                    log(f"  ! designs tab never activated after {attempt} tries")
                    return []
                # Next.js has not hydrated yet; give it a moment
                time.sleep(0.3 * attempt)

        try:
            page.wait_for_selector("div.mb-6", state="visible", timeout=10000)
        except Exception:
            return []

        return self._parse(page.content())

    @staticmethod
    def _parse(html: str) -> list[dict[str, Any]]:
        soup = BeautifulSoup(html, "html.parser")
        designs: list[dict[str, Any]] = []

        for block in soup.select('div[class="mb-6"]'):
            title_tag = block.select_one('h3[class="text-left mb-2"]')
            desc_tag = block.select_one('div[class="mb-2 text-left text-typography-secondary"]')
            wrapper = block.select_one('div[class^="EmojiTimeline_emoji-timeline-pins-list"]')

            timelines: list[dict[str, Any]] = []
            if wrapper is not None:
                for pin in wrapper.select('div[class^="EmojiTimeline_emoji-timeline-pin-container"]'):
                    date_tag = pin.select_one('p[class^="text-left EmojiTimeline_emoji-timeline-pin-date"]')
                    ver_tag = pin.select_one('p[class^="text-left EmojiTimeline_emoji-timeline-pin-title"]')
                    img = pin.select_one("img")
                    timelines.append(
                        {
                            "date": date_tag.get_text(strip=True) if date_tag else None,
                            "image_url": str(img.get("src")) if img is not None else None,
                            "version": ver_tag.get_text(strip=True) if ver_tag else None,
                        }
                    )

            designs.append(
                {
                    "title": title_tag.get_text(strip=True) if title_tag else None,
                    "description": desc_tag.get_text(strip=True) if desc_tag else None,
                    "timelines": timelines,
                }
            )

        return designs


def fetch_rendered_html(url: str, wait_for: str, headless: bool = True) -> str:
    """Load a page far enough for lazy-loaded content to appear. Used for categories."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        try:
            page = browser.new_page(user_agent=USER_AGENT)
            page.goto(url, wait_until="domcontentloaded")
            # Category pages lazy-load as you scroll; keep going until the page
            # stops growing rather than guessing a fixed number of wheel events
            last_height, stable = 0, 0
            for _ in range(40):
                page.mouse.wheel(0, 1600)
                page.wait_for_timeout(250)
                height = page.evaluate("document.body.scrollHeight")
                stable = stable + 1 if height == last_height else 0
                last_height = height
                if stable >= 3:
                    break
            page.wait_for_selector(wait_for, state="attached", timeout=30000)
            return page.content()
        finally:
            browser.close()


# ── Categories ────────────────────────────────────────────────────────────────


def build_categories(headless: bool = True) -> dict[str, dict[str, str | None]]:
    out: dict[str, dict[str, str | None]] = {}

    for main, slug in CATEGORIES.items():
        if STOP:
            break
        log(f"  category: {main}")
        html = fetch_rendered_html(f"{BASE_URL}{slug}", 'a[class*="Emoji_emoji"]', headless)
        soup = BeautifulSoup(html, "html.parser")
        section = soup.select_one('div[class^="MainSection_main-section"]')
        if section is None:
            log(f"  ! no section found for {main}")
            continue

        for group in section.select(r"div.mb-4.scroll-mt-\[140px\].md\:scroll-mt-\[180px\]"):
            header = group.select_one(r"h2.text-left.mb-3.heading-2xl-mobile.md\:heading-xl")
            sub = header.get_text(strip=True) if header else None
            grid = group.select_one(
                r"div.flex.flex-row.flex-wrap.justify-center.md\:justify-start.items-center"
            )
            if grid is None:
                continue
            for link in grid.find_all(
                "a",
                class_=lambda c: c is not None
                and any(x.startswith("Link_link-wrapper") for x in c)
                and any(x.startswith("Emoji_emoji") for x in c),
            ):
                char = link.get_text(strip=True)
                if char:
                    out[char] = {"main": main, "sub": sub}

        log(f"    {len(out)} emoji mapped so far")

    return out


SKIN_TONES = {"\U0001f3fb", "\U0001f3fc", "\U0001f3fd", "\U0001f3fe", "\U0001f3ff"}

NO_CATEGORY: dict[str, str | None] = {"main": None, "sub": None}


def base_form(char: str) -> str:
    """The emoji with skin-tone modifiers and variation selectors removed."""
    return "".join(c for c in char if c not in SKIN_TONES and c != "️")


def category_for(char: str, categories: dict[str, dict[str, str | None]]) -> dict[str, str | None]:
    """
    The category for one emoji, falling back to its unmodified base form.

    Emojipedia's category pages list base emoji only, so every skin-tone variant
    came out uncategorised - 2,910 of the 5,225, which is why 63% of the shipped
    dataset has a null category. A tone variant belongs in the same category as
    the emoji it is a variant of, so inherit it rather than leaving it empty.
    """
    hit = categories.get(char)
    if hit is not None:
        return hit

    base = base_form(char)
    for candidate in (base, base + "️"):
        hit = categories.get(candidate)
        if hit is not None:
            return hit

    return dict(NO_CATEGORY)


def load_categories(rebuild: bool = False, headless: bool = True) -> dict[str, dict[str, str | None]]:
    if not rebuild and CATEGORY_FILE.exists():
        try:
            data = json.loads(CATEGORY_FILE.read_text(encoding="utf-8"))
            if data:
                log(f"categories: {len(data)} from {CATEGORY_FILE.name}")
                return data
        except json.JSONDecodeError:
            log("categories: cache is corrupt, rebuilding")

    log("categories: scraping (this needs a browser)")
    data = build_categories(headless)
    tmp = CATEGORY_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CATEGORY_FILE)
    log(f"categories: wrote {len(data)} to {CATEGORY_FILE.name}")
    return data


# ── The per-emoji page ────────────────────────────────────────────────────────


def make_session() -> Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    s.mount(
        "https://",
        HTTPAdapter(
            max_retries=Retry(
                total=5,
                backoff_factor=1.0,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=["GET"],
                respect_retry_after_header=True,
            )
        ),
    )
    return s


def fetch_content(session: Session, slug: str) -> dict[str, Any] | None:
    """Name, descriptions and alert for one emoji, or None if the slug is wrong."""
    try:
        resp: Response = session.get(f"{BASE_URL}{slug}", timeout=30)
    except requests.RequestException as e:
        log(f"  ! {slug}: {type(e).__name__}")
        return None

    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        log(f"  ! {slug}: HTTP {resp.status_code}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    wrapper = soup.select_one('div[class^="EmojiContent_emoji-content-wrapper"]')
    if wrapper is None:
        return None

    header = wrapper.select_one("h1")
    name = header.get_text(strip=True).replace(" Emoji Meaning", "").strip() if header else None

    alert: str | None = None
    descs: list[str] = []
    block = wrapper.select_one("div.flex.flex-col.gap-3.text-left")
    if block is not None:
        alert_box = block.select_one('div[class^="EmojiContent_emoji-content-alerts"]')
        if alert_box is not None:
            alert = alert_box.get_text(strip=True)
            alert_box.decompose()
        for d in block.select("div"):
            text = d.get_text(" ", strip=True).replace("\xa0", " ")
            if text and text not in descs:
                descs.append(text)

    if name is None and not descs:
        return None

    return {"name": name, "descs": descs or None, "alert": alert, "slug": slug}


def resolve(session: Session, code: str, delay: float) -> dict[str, Any] | None:
    """
    Try each slug spelling until one resolves.

    The original recursed once per attempt with a sleep inside; this is the same
    order of attempts as a flat loop, so a run of failures cannot build a deep
    stack.
    """
    candidates = slug_candidates(code)
    for i, slug in enumerate(candidates):
        if STOP:
            return None
        found = fetch_content(session, slug)
        if found is not None:
            return found
        if i + 1 < len(candidates):
            time.sleep(delay + random.uniform(0, 0.4))
    return None


def is_incomplete(rec: dict[str, Any], want_designs: bool) -> bool:
    if not rec.get("name") or not rec.get("description"):
        return True
    if want_designs and not rec.get("designs"):
        return True
    return False


# ── Driver ────────────────────────────────────────────────────────────────────


def scrape(args: argparse.Namespace) -> int:
    if not RAW_FILE.exists():
        log(f"error: {RAW_FILE} is missing - it is the seed list and cannot be derived")
        return 1

    raw: dict[str, dict[str, Any]] = json.loads(RAW_FILE.read_text(encoding="utf-8"))
    log(f"seed: {len(raw)} emoji from {RAW_FILE.name}")

    categories = load_categories(rebuild=False, headless=not args.headed)

    if args.repair:
        keep: list[dict[str, Any]] = []
        redo: set[str] = set()
        for rec in read_jsonl(OUT_FILE):
            if is_incomplete(rec, not args.no_designs):
                redo.add(rec["character"])
            else:
                keep.append(rec)
        if not redo:
            log("nothing to repair - every entry looks complete")
            return 0
        log(f"repairing {len(redo)} incomplete entr(ies); keeping {len(keep)}")
        tmp = OUT_FILE.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for rec in keep:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        tmp.replace(OUT_FILE)
        todo = [c for c in raw if c in redo]
    else:
        already = done_characters(OUT_FILE)
        if already:
            log(f"resuming: {len(already)} already done, {len(raw) - len(already)} to go")
        todo = [c for c in raw if c not in already]

    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        log("nothing to do - emoji.jsonl is complete")
        return 0

    session = make_session()
    designer: DesignScraper | None = None
    started = time.time()
    written = failed = 0

    try:
        if not args.no_designs:
            designer = DesignScraper(headless=not args.headed).__enter__()

        for i, char in enumerate(todo, 1):
            if STOP:
                break

            data = raw[char]
            code = data["en"]
            found = resolve(session, code, args.delay)

            if found is None:
                log(f"[{i}/{len(todo)}] {code}  NOT FOUND")
                failed += 1
                record: dict[str, Any] = {
                    "character": char,
                    "name": None,
                    "description": None,
                    "code": code,
                    "render_quality": data["status"],
                    "version": data["E"],
                    "category": category_for(char, categories),
                    "designs": None,
                }
            else:
                designs = None
                if designer is not None:
                    designs = designer.scrape(f"{BASE_URL}{found['slug']}")
                record = {
                    "character": char,
                    "name": found["name"],
                    "description": found["descs"],
                    "code": code,
                    "render_quality": data["status"],
                    "version": data["E"],
                    "category": category_for(char, categories),
                    "designs": designs,
                }
                if found["alert"]:
                    record["alert"] = found["alert"]
                n_designs = len(designs) if designs else 0
                log(f"[{i}/{len(todo)}] {code}  {found['name']}  ({n_designs} design set(s))")

            if "variant" in data:
                record["variant"] = data["variant"]
            if "alias" in data:
                record["alias"] = data["alias"]

            append_jsonl(OUT_FILE, record)
            written += 1

            if i % 25 == 0:
                rate = i / max(time.time() - started, 1)
                left = (len(todo) - i) / rate if rate else 0
                log(f"  -- {i}/{len(todo)}, {rate * 60:.1f}/min, ~{left / 60:.0f} min left")

            time.sleep(args.delay + random.uniform(0, 0.5))
    finally:
        if designer is not None:
            designer.__exit__()

    log("")
    log(f"wrote {written} entr(ies), {failed} without a page")
    if STOP:
        log("stopped early - re-run to continue where it left off")
    return 0


def verify(_args: argparse.Namespace) -> int:
    if not OUT_FILE.exists():
        log(f"{OUT_FILE} does not exist")
        return 1

    raw = json.loads(RAW_FILE.read_text(encoding="utf-8")) if RAW_FILE.exists() else {}
    required = {"character", "name", "description", "code", "render_quality", "version", "category"}

    seen: dict[str, int] = {}
    bad_schema = incomplete = no_designs = 0
    total = 0

    for rec in read_jsonl(OUT_FILE):
        total += 1
        char = rec.get("character", "")
        seen[char] = seen.get(char, 0) + 1
        if not required.issubset(rec):
            bad_schema += 1
        if not rec.get("name") or not rec.get("description"):
            incomplete += 1
        if not rec.get("designs"):
            no_designs += 1

    dupes = {c: n for c, n in seen.items() if n > 1}
    missing = [c for c in raw if c not in seen] if raw else []

    size_mb = OUT_FILE.stat().st_size / 1048576
    log(f"{OUT_FILE.name}: {total} line(s), {size_mb:.1f} MB")
    log(f"  unique characters : {len(seen)}")
    log(f"  duplicates        : {len(dupes)}")
    log(f"  missing vs seed   : {len(missing)}")
    log(f"  schema problems   : {bad_schema}")
    log(f"  no name/descs     : {incomplete}")
    log(f"  no designs        : {no_designs}")

    if dupes:
        log("  duplicated: " + " ".join(list(dupes)[:20]))
    if missing:
        log("  missing:    " + " ".join(missing[:20]))

    ok = not dupes and not missing and not bad_schema
    log("  " + ("OK" if ok else "PROBLEMS FOUND - scrape_emoji.py --repair"))
    return 0 if ok else 1


def main() -> int:
    p = argparse.ArgumentParser(description="Rebuild emoji.jsonl from Emojipedia.")
    p.add_argument("--no-designs", action="store_true", help="skip design history (no browser needed)")
    p.add_argument("--verify", action="store_true", help="check the existing file and exit")
    p.add_argument("--repair", action="store_true", help="re-scrape incomplete entries")
    p.add_argument("--categories", action="store_true", help="rebuild category.json and exit")
    p.add_argument("--limit", type=int, default=0, help="stop after N emoji")
    p.add_argument("--delay", type=float, default=1.0, help="seconds between requests (default 1.0)")
    p.add_argument("--headed", action="store_true", help="show the browser, for debugging")
    args = p.parse_args()

    if args.verify:
        return verify(args)
    if args.categories:
        load_categories(rebuild=True, headless=not args.headed)
        return 0
    return scrape(args)


if __name__ == "__main__":
    sys.exit(main())
