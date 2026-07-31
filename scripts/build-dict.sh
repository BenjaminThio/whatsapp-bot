#!/usr/bin/env bash
#
# build-dict.sh - fetch the Wiktionary dump and turn it into dict.dat/dict.idx.
#
# Downloads ~1.2 GB, expands it to ~11 GB, indexes it down to ~700 MB, then
# deletes everything it downloaded. Hours on phone hardware.
#
# Resumable: the download uses wget -c and every stage is skipped if its output
# already exists, so re-running after an interruption picks up where it stopped
# rather than starting the download again.
#
#   scripts/build-dict.sh              build if dict.dat is missing
#   scripts/build-dict.sh --force      rebuild even if it is present
#   scripts/build-dict.sh --keep       do not delete the XML afterwards
#   scripts/build-dict.sh --work DIR   stage the big files somewhere else

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DICT_DIR="$ROOT/shared/assets/dict"
SRC_DIR="$DICT_DIR/src"

URL="https://dumps.wikimedia.org/enwiktionary/latest/enwiktionary-latest-pages-articles.xml.bz2"
BZ2_NAME="enwiktionary-latest-pages-articles.xml.bz2"
XML_NAME="enwiktionary-latest-pages-articles.xml"

# Space needed, in MB, with margin
NEED_DOWNLOAD=1500
NEED_EXPAND=13000
NEED_OUTPUT=1000

FORCE=0; KEEP=0; WORK=""

while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        --keep)  KEEP=1 ;;
        --work)  WORK="${2:-}"; shift ;;
        --help|-h) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

bold=$(tput bold 2>/dev/null || echo); red=$(tput setaf 1 2>/dev/null || echo)
grn=$(tput setaf 2 2>/dev/null || echo); ylw=$(tput setaf 3 2>/dev/null || echo)
off=$(tput sgr0 2>/dev/null || echo)

ok()   { echo "  ${grn}ok${off}  $*"; }
warn() { echo "  ${ylw}!!${off}  $*"; }
die()  { echo "  ${red}xx${off}  $*"; exit 1; }
note() { echo "  --  $*"; }

free_mb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print int($4/1024)}'; }
size_mb() { [ -f "$1" ] && echo $(( $(wc -c < "$1") / 1048576 )) || echo 0; }

if [ -f "$DICT_DIR/dict.dat" ] && [ -f "$DICT_DIR/dict.idx" ] && [ "$FORCE" -eq 0 ]; then
    ok "dict.dat already present ($(size_mb "$DICT_DIR/dict.dat") MB) - nothing to do"
    exit 0
fi

echo "${bold}Building the Wiktionary index${off}"

# ── The indexer itself ────────────────────────────────────────────────────────

if [ ! -x "$DICT_DIR/dict_indexer" ]; then
    command -v gcc >/dev/null 2>&1 || die "gcc is not installed"
    ( cd "$SRC_DIR" && gcc -O2 -o ../dict_indexer dict_indexer.c ) || die "dict_indexer failed to build"
    ok "dict_indexer built"
fi
if [ ! -x "$DICT_DIR/dict_lookup" ]; then
    ( cd "$SRC_DIR" && gcc -O2 -o ../dict_lookup dict_lookup.c ) || warn "dict_lookup failed to build"
fi

# ── Where to stage 12 GB ──────────────────────────────────────────────────────

pick_work_dir() {
    [ -n "$WORK" ] && { echo "$WORK"; return; }
    local c parent
    for c in /sdcard/lasma-work /sdcard "$ROOT/.dictwork" /tmp; do
        parent=$(dirname "$c")
        [ -d "$c" ] || [ -d "$parent" ] || continue
        mkdir -p "$c" 2>/dev/null || continue
        [ -w "$c" ] || continue
        if [ "$(free_mb "$c")" -ge "$NEED_EXPAND" ]; then echo "$c"; return; fi
    done
    return 1
}

WORK=$(pick_work_dir) || die "No location with ${NEED_EXPAND} MB free. Free some space, or pass --work /path/with/room"
mkdir -p "$WORK" || die "cannot create $WORK"
[ -w "$WORK" ] || die "$WORK is not writable"

BZ2="$WORK/$BZ2_NAME"
XML="$WORK/$XML_NAME"

note "staging in $WORK ($(free_mb "$WORK") MB free)"
note "output to  $DICT_DIR ($(free_mb "$DICT_DIR") MB free)"

[ "$(free_mb "$DICT_DIR")" -ge "$NEED_OUTPUT" ] \
    || die "the dict folder needs ${NEED_OUTPUT} MB free, has $(free_mb "$DICT_DIR")"

# pick_work_dir only space-checks the candidates it chooses between, so a
# directory given with --work has not been checked at all. Do it here, before
# anything is downloaded, unless the XML is already sitting there.
if [ ! -f "$XML" ] && [ "$(free_mb "$WORK")" -lt "$NEED_EXPAND" ]; then
    die "$WORK has $(free_mb "$WORK") MB free, and expanding the dump needs ${NEED_EXPAND} MB"
fi

cleanup_partial() {
    echo
    warn "interrupted - the partial download is kept, re-run to resume"
    exit 130
}
trap cleanup_partial INT TERM

# ── 1. Download ───────────────────────────────────────────────────────────────

if [ -f "$XML" ]; then
    ok "XML already extracted ($(size_mb "$XML") MB) - skipping download"
else
    command -v wget >/dev/null 2>&1 || die "wget is not installed"
    [ "$(free_mb "$WORK")" -ge "$NEED_DOWNLOAD" ] || die "need ${NEED_DOWNLOAD} MB for the download"

    echo
    echo "${bold}1/3 downloading${off}  ~1.2 GB, resumable"
    # -c so an interrupted run continues instead of starting over
    wget -c -O "$BZ2" "$URL" || die "download failed - re-run to resume from $(size_mb "$BZ2") MB"
    ok "downloaded $(size_mb "$BZ2") MB"

    echo
    echo "${bold}2/3 verifying and expanding${off}  ~11 GB, this is the slow part"
    bunzip2 -t "$BZ2" 2>/dev/null || die "the archive is corrupt - rm $BZ2 and re-run"
    ok "archive intact"

    [ "$(free_mb "$WORK")" -ge "$NEED_EXPAND" ] \
        || die "need ${NEED_EXPAND} MB to expand, have $(free_mb "$WORK")"

    # -k keeps the archive until we know the XML is good
    bunzip2 -k -c "$BZ2" > "$XML" || { rm -f "$XML"; die "decompression failed"; }
    ok "expanded to $(size_mb "$XML") MB"

    rm -f "$BZ2"
    ok "archive deleted, $(free_mb "$WORK") MB free again"
fi

[ -s "$XML" ] || die "$XML is empty"

# ── 2. Index ──────────────────────────────────────────────────────────────────

echo
echo "${bold}3/3 indexing${off}  hours on a phone, no progress bar"
"$DICT_DIR/dict_indexer" "$XML" "$DICT_DIR" || die "indexing failed"

[ -f "$DICT_DIR/dict.dat" ] && [ -f "$DICT_DIR/dict.idx" ] \
    || die "the indexer finished but produced no dict.dat"
ok "built dict.dat ($(size_mb "$DICT_DIR/dict.dat") MB) and dict.idx ($(size_mb "$DICT_DIR/dict.idx") MB)"

# ── 3. Verify, then clean up ──────────────────────────────────────────────────

trap - INT TERM

if [ -x "$DICT_DIR/dict_lookup" ]; then
    if DICT_DIR="$DICT_DIR" "$DICT_DIR/dict_lookup" water 2>/dev/null | head -1 | grep -q .; then
        ok "lookup verified"
    else
        die "the index was built but 'dict_lookup water' returned nothing - keeping $XML so you can retry"
    fi
else
    warn "dict_lookup missing, skipping verification"
fi

if [ "$KEEP" -eq 1 ]; then
    note "keeping $XML as asked (--keep)"
else
    rm -f "$XML"
    ok "deleted the XML, $(free_mb "$WORK") MB free"
    rmdir "$WORK" 2>/dev/null
fi

echo
echo "${grn}${bold}Done.${off} /dict is ready."
