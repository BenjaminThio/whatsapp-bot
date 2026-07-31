#!/usr/bin/env bash
#
# build-emoji.sh - rebuild shared/assets/data/emoji.jsonl by scraping Emojipedia.
#
# Wraps shared/assets/data/emoji-src/scrape_emoji.py: makes sure the venv has
# what it needs, installs the Chromium that Playwright drives, and runs the
# scrape. Resumable - re-run it and it continues from wherever it stopped.
#
#   scripts/build-emoji.sh                build if emoji.jsonl is missing
#   scripts/build-emoji.sh --force        rebuild from scratch
#   scripts/build-emoji.sh --no-designs   skip design history: ~2 MB, minutes
#   scripts/build-emoji.sh --verify       check the existing file
#   scripts/build-emoji.sh --repair       re-scrape incomplete entries
#
# With designs this is 5,225 pages through a real browser - many hours, and
# roughly 60 MB of output. Without them it is a few thousand plain HTTP
# requests and finishes far sooner, at the cost of /emoji not showing the
# per-platform artwork history.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/shared/assets/data/emoji-src"
OUT="$ROOT/shared/assets/data/emoji.jsonl"
PY="$ROOT/.venv/bin/python"

bold=$(tput bold 2>/dev/null || echo); red=$(tput setaf 1 2>/dev/null || echo)
grn=$(tput setaf 2 2>/dev/null || echo); ylw=$(tput setaf 3 2>/dev/null || echo)
off=$(tput sgr0 2>/dev/null || echo)

ok()   { echo "  ${grn}ok${off}  $*"; }
warn() { echo "  ${ylw}!!${off}  $*"; }
die()  { echo "  ${red}xx${off}  $*"; exit 1; }
note() { echo "  --  $*"; }

FORCE=0; PASS=()
for a in "$@"; do
    case "$a" in
        --force) FORCE=1 ;;
        --help|-h) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        *) PASS+=("$a") ;;
    esac
done

[ -f "$SRC/scrape_emoji.py" ] || die "scraper missing at $SRC"
[ -f "$SRC/raw_emoji.json" ] || die "raw_emoji.json missing - it is the seed list and cannot be derived"

[ -x "$PY" ] || PY=$(command -v python3) || die "no python3"

# --verify and --repair are meaningful on an existing file; a plain run is not
case " ${PASS[*]:-} " in
    *" --verify "*|*" --repair "*|*" --categories "*) : ;;
    *)
        if [ -f "$OUT" ] && [ "$FORCE" -eq 0 ]; then
            local_size=$(( $(wc -c < "$OUT") / 1048576 ))
            ok "emoji.jsonl already present (${local_size} MB) - nothing to do"
            note "re-check it with:  scripts/build-emoji.sh --verify"
            exit 0
        fi
        [ "$FORCE" -eq 1 ] && [ -f "$OUT" ] && { rm -f "$OUT"; note "removed the old file (--force)"; }
        ;;
esac

echo "${bold}Rebuilding the emoji dataset${off}"

# ── Python dependencies ───────────────────────────────────────────────────────

need_designs=1
case " ${PASS[*]:-} " in *" --no-designs "*) need_designs=0 ;; esac
case " ${PASS[*]:-} " in *" --verify "*) need_designs=0 ;; esac

"$PY" -c "import bs4, requests" 2>/dev/null || {
    note "installing beautifulsoup4 and requests"
    "$PY" -m pip install --quiet beautifulsoup4 requests || die "pip install failed"
}

if [ "$need_designs" -eq 1 ]; then
    if ! "$PY" -c "import playwright" 2>/dev/null; then
        note "installing playwright"
        "$PY" -m pip install --quiet playwright || die "pip install playwright failed"
    fi
    # The browser is a separate ~150 MB download from the Python package
    if ! "$PY" -m playwright install --dry-run chromium >/dev/null 2>&1; then
        note "installing the chromium Playwright drives (~150 MB)"
    fi
    "$PY" -m playwright install chromium || {
        warn "chromium install failed"
        warn "on ARM/Termux Playwright often has no browser build - use --no-designs"
        die "cannot scrape designs without a browser"
    }
    ok "browser ready"
fi

# ── Run ───────────────────────────────────────────────────────────────────────

echo
cd "$SRC" || die "cannot enter $SRC"
"$PY" scrape_emoji.py ${PASS[@]+"${PASS[@]}"}
rc=$?

echo
if [ "$rc" -ne 0 ]; then
    warn "scraper exited $rc - re-run to resume where it stopped"
    exit "$rc"
fi

case " ${PASS[*]:-} " in
    *" --verify "*|*" --categories "*) exit 0 ;;
esac

if [ -f "$OUT" ]; then
    ok "emoji.jsonl is $(( $(wc -c < "$OUT") / 1048576 )) MB"
    # The bots cache a byte-offset index next to the data; a changed dataset
    # must invalidate it or every lookup reads from the wrong offset
    rm -f "$ROOT/shared/assets/data/emoji.index.json" && note "cleared the cached index"
    "$PY" scrape_emoji.py --verify
else
    die "no emoji.jsonl was produced"
fi
