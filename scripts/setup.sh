#!/usr/bin/env bash
#
# setup.sh - build the whole install, inside the Ubuntu proot.
#
# Every step checks whether it is already done, so re-running after a failure
# picks up where it stopped rather than starting over.
#
#   bash scripts/setup.sh              everything
#   bash scripts/setup.sh --from 6     skip ahead to step 6
#   bash scripts/setup.sh --only 9     just one step
#   bash scripts/setup.sh --list
#
# Run scripts/termux-install.sh from Termux afterwards for the w/t shortcuts.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="${LASMA_BACKUP:-/sdcard/lasma-backup}"

# Bun installs to ~/.bun/bin and appends its PATH line to ~/.bashrc, which
# Ubuntu skips entirely for non-interactive shells. Set it here so every step
# can find bun - including when only one step is run and step 2 never executed.
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

bold=$(tput bold 2>/dev/null || echo); red=$(tput setaf 1 2>/dev/null || echo)
grn=$(tput setaf 2 2>/dev/null || echo); ylw=$(tput setaf 3 2>/dev/null || echo)
off=$(tput sgr0 2>/dev/null || echo)

STEP_NAMES=(
    "apt packages and locale"
    "Bun"
    "Postgres connection (server lives in Termux)"
    "environment files"
    "bun install"
    "Python venv"
    "restore backup"
    "database schema"
    "dict index"
    "emoji dataset"
    "chess renderer (optional)"
    "verify"
)

FAILED=()

say()  { echo; echo "${bold}[$1/${#STEP_NAMES[@]}] ${STEP_NAMES[$(($1 - 1))]}${off}"; }
ok()   { echo "  ${grn}ok${off}  $*"; }
skip() { echo "  ${ylw}--${off}  $* (already done)"; }
warn() { echo "  ${ylw}!!${off}  $*"; }
die()  { echo "  ${red}xx${off}  $*"; FAILED+=("$*"); }
note_plain() { echo "  --  $*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Read one key out of shared/.env without sourcing the whole file
env_get() {
    local k=$1 f="$ROOT/shared/.env"
    [ -f "$f" ] || return 1
    sed -n "s/^${k}=//p" "$f" | head -1
}

pg_bin() { echo /usr/lib/postgresql/*/bin; }

# The server runs natively in Termux, not in here.
#
# Postgres cannot be initialised inside proot-distro: /dev/shm is a bind to an
# ordinary directory rather than a tmpfs, because proot cannot mount one, and
# the POSIX shared-memory calls block forever on it - initdb hangs at
# "selecting default shared_buffers" and never returns.
#
# The proot shares Termux's network namespace, so 127.0.0.1 reaches the Termux
# server directly. Only the client tools are needed on this side.
pg_env() {
    PGHOST=$(env_get PGHOST || echo 127.0.0.1); [ -z "$PGHOST" ] && PGHOST=127.0.0.1
    PGPORT=$(env_get PGPORT || echo 5432);      [ -z "$PGPORT" ] && PGPORT=5432
    PGUSER=$(env_get PGUSER || echo postgres);  [ -z "$PGUSER" ] && PGUSER=postgres
    PGDATABASE=$(env_get PGDATABASE || echo lasma_bot); [ -z "$PGDATABASE" ] && PGDATABASE=lasma_bot
    PGPASSWORD=$(env_get PGPASSWORD || echo)
    export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
}

db_up() { pg_isready -q -h "$PGHOST" -p "$PGPORT" 2>/dev/null; }

# -w so it fails instead of prompting; a timeout so a wedged server cannot stall
db_psql() { PGCONNECT_TIMEOUT=10 psql -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$@"; }

step_1_packages() {
    if have gcc && have cmake && have psql && have ffmpeg && have python3 && have tmux; then
        skip "toolchain present"
    else
        apt update -y || { die "apt update failed"; return; }
        DEBIAN_FRONTEND=noninteractive apt install -y \
            curl wget git unzip nano tmux locales \
            build-essential cmake ninja-build pkg-config \
            python3 python3-pip python3-venv \
            ffmpeg postgresql-client libvips-dev \
            || { die "apt install failed"; return; }
        ok "packages installed"
    fi

    # initdb refuses to run without a locale, and says nothing useful about it
    if locale -a 2>/dev/null | grep -qi "en_US.utf8"; then
        skip "locale generated"
    else
        locale-gen en_US.UTF-8 >/dev/null 2>&1
        update-locale LANG=en_US.UTF-8 >/dev/null 2>&1
        ok "locale en_US.UTF-8"
    fi
    export LANG=en_US.UTF-8
}

step_2_bun() {
    if have bun; then
        skip "bun $(bun --version) at $(command -v bun)"
        link_bun
        return
    fi

    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
    export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"

    if have bun; then
        ok "bun $(bun --version)"
    else
        die "bun install failed - install nodejs instead and use node/npx"
        return
    fi

    link_bun
}

# Put bun somewhere every shell can find it.
#
# Bun's installer only appends a PATH line to ~/.bashrc, which Ubuntu skips
# entirely for non-interactive shells - and the bots are launched as
# `proot-distro login ubuntu -- bash supervise.sh`, which is neither
# interactive nor a login shell. The result is a bun that works when you type
# it and vanishes when anything scripts it.
#
# /usr/local/bin is on the default PATH for every shell, so a symlink there
# removes the dependency on shell profiles instead of working around it.
link_bun() {
    local real
    real=$(command -v bun) || return 0
    case "$real" in /usr/local/bin/*) return 0 ;; esac

    if ln -sf "$real" /usr/local/bin/bun 2>/dev/null; then
        ln -sf "$real" /usr/local/bin/bunx 2>/dev/null
        ok "linked bun into /usr/local/bin so every shell finds it"
    fi

    if ! grep -q "\.bun/bin" "$HOME/.profile" 2>/dev/null; then
        echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
        ok "added bun to ~/.profile"
    fi
}

step_3_postgres() {
    pg_env

    if ! have psql; then
        die "psql is missing - re-run step 1"
        return
    fi

    if ! db_up; then
        die "no Postgres at $PGHOST:$PGPORT"
        echo "      The database runs in Termux, not in here. Exit to Termux and run:"
        echo "        UB=\$(ls -d \$PREFIX/var/lib/proot-distro/containers/ubuntu/rootfs \\"
        echo "                 \$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu 2>/dev/null | head -1)"
        echo "        bash \$UB$ROOT/scripts/termux-postgres.sh"
        echo "      then come back and re-run:  bash scripts/setup.sh --from 3"
        return
    fi
    ok "reachable at $PGHOST:$PGPORT"

    if ! db_psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
        die "connected, but cannot authenticate as '$PGUSER'"
        echo "      Check PGUSER/PGPASSWORD in shared/.env against what"
        echo "      termux-postgres.sh created. To reset the password, in Termux:"
        echo "        bash .../scripts/termux-postgres.sh --password 'newpassword'"
        return
    fi
    ok "authenticated as $PGUSER"

    if db_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$PGDATABASE'" 2>/dev/null | grep -q 1; then
        skip "database $PGDATABASE exists"
    else
        db_psql -d postgres -qc "CREATE DATABASE $PGDATABASE OWNER $PGUSER;" >/dev/null 2>&1             && ok "database $PGDATABASE created" || die "could not create $PGDATABASE"
    fi

    # SQL_ASCII stores bytes with no validation - fine until the first emoji or
    # accented name meets upper(), ILIKE or ORDER BY. It cannot be changed in
    # place, so say so loudly rather than discovering it after a restore.
    local enc
    enc=$(db_psql -d "$PGDATABASE" -tAc "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname='$PGDATABASE'" 2>/dev/null | tr -d ' 
')
    case "$enc" in
        UTF8) ok "encoding UTF8" ;;
        "")   warn "could not read the database encoding" ;;
        *)    warn "encoding is $enc, not UTF8 - emoji and accented text will sort and compare wrongly"
              warn "rebuild it in Termux with:  termux-postgres.sh --reinit" ;;
    esac
}

step_4_env() {
    if [ -f "$ROOT/shared/.env" ] && [ -f "$ROOT/telegram/.env" ]; then
        skip "env files present - scripts/configure-env.sh to change them"
        return
    fi
    if [ -f "$BACKUP/shared.env" ]; then
        cp "$BACKUP/shared.env" "$ROOT/shared/.env"
        [ -f "$BACKUP/telegram.env" ] && cp "$BACKUP/telegram.env" "$ROOT/telegram/.env"
        chmod 600 "$ROOT/shared/.env" "$ROOT/telegram/.env" 2>/dev/null
        ok "restored from $BACKUP"
        return
    fi
    echo "  no env files and no backup - asking for them now"
    bash "$ROOT/scripts/configure-env.sh" || die "configuration cancelled"
}

step_5_deps() {
    cd "$ROOT" || return
    if [ -d node_modules ] && [ -d node_modules/grammy ]; then
        skip "node_modules present"
        return
    fi
    have bun || { die "bun missing"; return; }

    local log=/tmp/lasma-buninstall.log

    if bun install 2>&1 | tee "$log"; then
        ok "workspace dependencies installed"
        return
    fi

    # Bun hardlinks packages into node_modules by default. proot emulates the
    # filesystem and hardlinks across its layers can fail outright, which shows
    # up as an install error that has nothing to do with any package.
    warn "first attempt failed - retrying with --backend=copyfile"
    if bun install --backend=copyfile 2>&1 | tee -a "$log"; then
        ok "workspace dependencies installed (copyfile backend)"
        return
    fi

    if grep -qi "sharp" "$log"; then
        # sharp's actual binary ships as a platform-gated optional dependency
        # (@img/sharp-linux-arm64 and friends). If the platform is detected
        # wrongly under proot the right one is never fetched, and sharp then
        # fails at require() time complaining about a missing runtime. Naming
        # the platform explicitly gets the correct package.
        local cpu
        case "$(uname -m)" in
            aarch64|arm64) cpu=arm64 ;;
            x86_64|amd64)  cpu=x64 ;;
            *)             cpu="" ;;
        esac

        if [ -n "$cpu" ]; then
            warn "sharp looks like the culprit - retrying with --cpu=$cpu --os=linux"
            if bun install --backend=copyfile --cpu="$cpu" --os=linux 2>&1 | tee -a "$log"; then
                ok "workspace dependencies installed (platform forced to linux/$cpu)"
                return
            fi
        fi

        # sharp is the only dependency with a native component and it is used by
        # exactly one feature. Getting the other 300-odd packages in beats
        # failing the whole step for it.
        warn "still failing - installing everything except optional packages"
        if bun install --backend=copyfile --omit=optional 2>&1 | tee -a "$log"; then
            warn "installed without optional packages - the timetable image will not render"
            warn "everything else works; fix it later with: bun install --cpu=$cpu --os=linux"
            return
        fi
    fi

    die "bun install failed"
    echo "      Last lines of $log:"
    tail -25 "$log" 2>/dev/null | sed 's/^/      /'
}

step_6_venv() {
    cd "$ROOT" || return
    if [ -x .venv/bin/python ] && .venv/bin/python -c "import gtts" 2>/dev/null; then
        skip "venv ready"
        return
    fi
    [ -x .venv/bin/python ] || python3 -m venv .venv || { die "venv creation failed"; return; }
    .venv/bin/pip install --upgrade pip >/dev/null 2>&1
    if .venv/bin/pip install -r requirements.txt; then
        ok "python packages installed"
    else
        warn "some packages failed - retrying without rembg (onnxruntime often has no ARM wheel)"
        grep -v '^rembg' requirements.txt > /tmp/req-nombg.txt
        .venv/bin/pip install -r /tmp/req-nombg.txt \
            && warn "installed without rembg - only /removebg is unavailable" \
            || die "python packages failed"
    fi
}

step_7_restore() {
    if [ ! -d "$BACKUP" ]; then
        skip "no backup at $BACKUP"
        return
    fi
    cd "$ROOT" || return

    local pairs=(
        "$BACKUP/creds.json:shared/hi-hive/creds.json"
        "$BACKUP/legacy-creds.json:shared/hi-hive/legacy/creds.json"
        "$BACKUP/serviceAccountKey.json:whatsapp/serviceAccountKey.json"
        "$BACKUP/emoji.jsonl:shared/assets/data/emoji.jsonl"
        "$BACKUP/dict.dat:shared/assets/dict/dict.dat"
        "$BACKUP/dict.idx:shared/assets/dict/dict.idx"
    )
    local p src dst
    for p in "${pairs[@]}"; do
        src=${p%%:*}; dst=${p#*:}
        if [ -f "$dst" ]; then skip "$(basename "$dst")"
        elif [ -f "$src" ]; then mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; ok "$(basename "$dst")"
        else warn "$(basename "$src") not in backup"
        fi
    done

    if [ -d whatsapp/auth_info_baileys ]; then
        skip "whatsapp pairing state"
    elif [ -d "$BACKUP/auth_info_baileys" ]; then
        cp -r "$BACKUP/auth_info_baileys" whatsapp/ && ok "whatsapp pairing state"
    else
        warn "no pairing state - you will scan a QR on first start"
    fi
}

step_8_schema() {
    cd "$ROOT" || return
    pg_env
    db_up || { die "postgres unreachable - see step 3"; return; }

    local count
    count=$(db_psql -d "$PGDATABASE" -tAc         "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"         2>/dev/null | tr -d ' 
')

    if [ "${count:-0}" -gt 0 ]; then
        skip "$count table(s) already present"
        return
    fi

    if [ -f "$BACKUP/lasma.sql" ]; then
        if db_psql -d "$PGDATABASE" -f "$BACKUP/lasma.sql" >/tmp/lasma-restore.log 2>&1; then
            ok "restored dump from $BACKUP/lasma.sql"
            return
        fi
        warn "dump restore failed - last lines:"
        tail -10 /tmp/lasma-restore.log 2>/dev/null | sed 's/^/      /'
        warn "creating an empty schema instead"
    fi

    have bun || { die "bun missing"; return; }
    bun run schema && ok "schema created" || die "schema creation failed"
}

step_9_dict() {
    cd "$ROOT/shared/assets/dict/src" 2>/dev/null || { die "dict sources missing"; return; }
    if [ -x ../dict_lookup ] && [ -x ../dict_indexer ]; then
        skip "binaries built"
    else
        gcc -O2 -o ../dict_lookup  dict_lookup.c  || die "dict_lookup failed to build"
        gcc -O2 -o ../dict_indexer dict_indexer.c || die "dict_indexer failed to build"
        [ -x ../dict_lookup ] && ok "dict binaries built"
    fi

    if [ -f "$ROOT/shared/assets/dict/dict.dat" ]; then
        if DICT_DIR="$ROOT/shared/assets/dict" "$ROOT/shared/assets/dict/dict_lookup" water >/dev/null 2>&1; then
            ok "lookup works"
        else
            warn "binary built but the index did not open"
        fi
        return
    fi

    if [ "$SKIP_DICT" -eq 1 ]; then
        warn "no dict.dat and --skip-dict was passed - /dict stays unavailable"
        return
    fi

    echo
    echo "  ${bold}dict.dat is missing and no backup had it.${off}"
    echo "  Building it means downloading ~1.2 GB, expanding it to ~11 GB and"
    echo "  indexing for a few hours. Everything downloaded is deleted afterwards."
    echo "  Skip with:  bash scripts/setup.sh --skip-dict"
    echo

    if bash "$ROOT/scripts/build-dict.sh"; then
        ok "dict index built"
    else
        warn "dict build did not finish - re-run scripts/build-dict.sh to resume"
    fi
}

step_10_emoji() {
    local out="$ROOT/shared/assets/data/emoji.jsonl"

    if [ -f "$out" ]; then
        skip "emoji.jsonl present ($(( $(wc -c < "$out") / 1048576 )) MB)"
        return
    fi

    if [ "$SKIP_EMOJI" -eq 1 ]; then
        warn "no emoji.jsonl and --skip-emoji was passed - /emoji stays unavailable"
        return
    fi

    echo
    echo "  ${bold}emoji.jsonl is missing and no backup had it.${off}"
    echo "  Scraping it with the full design history means driving a real browser"
    echo "  over 5,225 pages - many hours. Without designs it is a few thousand"
    echo "  plain requests and a much smaller file."
    echo "  Skip entirely with:  bash scripts/setup.sh --skip-emoji"
    echo

    if bash "$ROOT/scripts/build-emoji.sh"; then
        ok "emoji dataset built"
        return
    fi

    # Playwright often has no browser build for ARM, which is exactly where this
    # runs. Falling back leaves a working /emoji minus the artwork history,
    # rather than leaving the command broken entirely.
    warn "full scrape unavailable - retrying without the design history"
    if bash "$ROOT/scripts/build-emoji.sh" --no-designs; then
        ok "emoji dataset built (no design history)"
    else
        warn "emoji scrape failed - re-run scripts/build-emoji.sh to resume"
    fi
}

step_11_chess() {
    cd "$ROOT/telegram" 2>/dev/null || return
    if [ -f src/pixelforge/build/Release/App.node ]; then
        skip "addon built"
        return
    fi
    if bun run build:chess >/dev/null 2>&1; then
        ok "chess renderer built"
    else
        warn "chess renderer did not build - /chess is skipped, nothing else is affected"
    fi
}

step_12_verify() {
    cd "$ROOT" || return
    pg_env

    if db_up; then
        ok "postgres reachable at $PGHOST:$PGPORT"
        local enc
        enc=$(db_psql -d "$PGDATABASE" -tAc             "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname='$PGDATABASE'"             2>/dev/null | tr -d ' 
')
        [ "$enc" = "UTF8" ] && ok "encoding UTF8"             || warn "encoding is ${enc:-unknown}, expected UTF8"
    else
        die "postgres unreachable - start it in Termux: termux-postgres.sh start"
    fi

    [ -d node_modules ] && ok "dependencies" || die "node_modules missing"
    .venv/bin/python -c "import gtts" 2>/dev/null && ok "python engines" || warn "python engines incomplete"
    [ -f shared/assets/data/emoji.jsonl ] && ok "emoji dataset" || warn "emoji dataset missing"
    [ -f shared/assets/dict/dict.dat ] && ok "dict index" || warn "dict index missing"
    [ -s shared/.env ] && ok "shared/.env" || die "shared/.env missing"
    grep -q "^BOT_TOKEN=." telegram/.env 2>/dev/null && ok "telegram token" || warn "BOT_TOKEN unset - Telegram will not start"
    [ -d whatsapp/auth_info_baileys ] && ok "whatsapp pairing" || warn "whatsapp will show a QR on first start"
}

FROM=1; TO=${#STEP_NAMES[@]}; SKIP_DICT=0; SKIP_EMOJI=0

while [ $# -gt 0 ]; do
    case "$1" in
        --list) for i in "${!STEP_NAMES[@]}"; do echo "$((i + 1)). ${STEP_NAMES[$i]}"; done; exit 0 ;;
        --from) FROM=${2:-1}; shift ;;
        --only) FROM=${2:-1}; TO=${2:-1}; shift ;;
        --skip-dict) SKIP_DICT=1 ;;
        --skip-emoji) SKIP_EMOJI=1 ;;
        --skip-assets) SKIP_DICT=1; SKIP_EMOJI=1 ;;
        --help|-h) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

echo "${bold}Lasma setup${off}  ->  $ROOT"
[ -d "$BACKUP" ] && echo "backup: $BACKUP" || echo "backup: none at $BACKUP (fresh install)"

for i in $(seq "$FROM" "$TO"); do
    say "$i"
    case "$i" in
        1) step_1_packages ;;  2) step_2_bun ;;      3) step_3_postgres ;;
        4) step_4_env ;;       5) step_5_deps ;;     6) step_6_venv ;;
        7) step_7_restore ;;   8) step_8_schema ;;   9) step_9_dict ;;
        10) step_10_emoji ;;  11) step_11_chess ;;  12) step_12_verify ;;
    esac
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then
    cat <<EOF
${grn}${bold}Setup complete.${off}

Start the bots from inside Ubuntu:

  bash scripts/lasma.sh install && source ~/.bashrc
  w        # whatsapp
  t        # telegram

Or, to run w and t straight from Termux without logging in first, exit to
Termux and run:

  UB=\$(ls -d \$PREFIX/var/lib/proot-distro/containers/ubuntu/rootfs \
           \$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu 2>/dev/null | head -1)
  bash \$UB$ROOT/scripts/termux-install.sh
EOF
else
    echo "${red}${bold}Finished with ${#FAILED[@]} problem(s):${off}"
    printf '  - %s\n' "${FAILED[@]}"
    echo
    echo "Fix, then re-run just that step:  bash scripts/setup.sh --only <n>"
    exit 1
fi
