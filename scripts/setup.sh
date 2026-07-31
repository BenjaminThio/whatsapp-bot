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

bold=$(tput bold 2>/dev/null || echo); red=$(tput setaf 1 2>/dev/null || echo)
grn=$(tput setaf 2 2>/dev/null || echo); ylw=$(tput setaf 3 2>/dev/null || echo)
off=$(tput sgr0 2>/dev/null || echo)

STEP_NAMES=(
    "apt packages and locale"
    "Bun"
    "Postgres server, role and database"
    "environment files"
    "bun install"
    "Python venv"
    "restore backup"
    "database schema"
    "dict binaries"
    "chess renderer (optional)"
    "verify"
)

FAILED=()

say()  { echo; echo "${bold}[$1/${#STEP_NAMES[@]}] ${STEP_NAMES[$(($1 - 1))]}${off}"; }
ok()   { echo "  ${grn}ok${off}  $*"; }
skip() { echo "  ${ylw}--${off}  $* (already done)"; }
warn() { echo "  ${ylw}!!${off}  $*"; }
die()  { echo "  ${red}xx${off}  $*"; FAILED+=("$*"); }

have() { command -v "$1" >/dev/null 2>&1; }

# Read one key out of shared/.env without sourcing the whole file
env_get() {
    local k=$1 f="$ROOT/shared/.env"
    [ -f "$f" ] || return 1
    sed -n "s/^${k}=//p" "$f" | head -1
}

pg_bin() { echo /usr/lib/postgresql/*/bin; }

start_postgres() {
    pg_isready -q 2>/dev/null && return 0
    su postgres -c "$(pg_bin)/pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/log start" \
        >/dev/null 2>&1
    for _ in $(seq 1 20); do pg_isready -q 2>/dev/null && return 0; sleep 1; done
    return 1
}

step_1_packages() {
    if have gcc && have cmake && have psql && have ffmpeg && have python3 && have tmux; then
        skip "toolchain present"
    else
        apt update -y || { die "apt update failed"; return; }
        DEBIAN_FRONTEND=noninteractive apt install -y \
            curl wget git unzip nano tmux locales \
            build-essential cmake ninja-build pkg-config \
            python3 python3-pip python3-venv \
            ffmpeg postgresql postgresql-contrib libvips-dev \
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
    if have bun; then skip "bun $(bun --version)"; return; fi
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
    export PATH="$HOME/.bun/bin:$PATH"
    if have bun; then ok "bun $(bun --version)"
    else die "bun install failed - install nodejs instead and use node/npx"; fi
}

step_3_postgres() {
    local user pass db
    user=$(env_get PGUSER || echo lasma)
    pass=$(env_get PGPASSWORD || echo)
    db=$(env_get PGDATABASE || echo lasma_bot)
    [ -z "$user" ] && user=lasma
    [ -z "$db" ] && db=lasma_bot

    if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then
        mkdir -p /var/lib/postgresql/data /var/run/postgresql
        chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
        chmod 775 /var/run/postgresql
        su postgres -c "$(pg_bin)/initdb -D /var/lib/postgresql/data" >/dev/null 2>&1 \
            || { die "initdb failed - check the locale from step 1"; return; }
        ok "cluster initialised"
    else
        skip "cluster exists"
    fi

    start_postgres || { die "postgres will not start"; return; }
    ok "server up"

    if [ -z "$pass" ]; then
        warn "no PGPASSWORD in shared/.env - run step 4 then re-run step 3"
        return
    fi

    if su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$user'\"" 2>/dev/null | grep -q 1; then
        su postgres -c "psql -c \"ALTER USER $user WITH PASSWORD '$pass';\"" >/dev/null 2>&1
        skip "role $user exists (password synced)"
    else
        su postgres -c "psql -c \"CREATE USER $user WITH PASSWORD '$pass' SUPERUSER;\"" >/dev/null 2>&1 \
            && ok "role $user created" || die "could not create role $user"
    fi

    if su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" 2>/dev/null | grep -q 1; then
        skip "database $db exists"
    else
        su postgres -c "psql -c 'CREATE DATABASE $db OWNER $user;'" >/dev/null 2>&1 \
            && ok "database $db created" || die "could not create database $db"
    fi
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
    bun install || { die "bun install failed - libvips-dev missing?"; return; }
    ok "workspace dependencies installed"
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
    start_postgres || { die "postgres down"; return; }

    local db user
    db=$(env_get PGDATABASE || echo lasma_bot); [ -z "$db" ] && db=lasma_bot
    user=$(env_get PGUSER || echo lasma);       [ -z "$user" ] && user=lasma

    local count
    count=$(su postgres -c "psql -tAd $db -c \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\"" 2>/dev/null | tr -d ' ')

    if [ "${count:-0}" -gt 0 ]; then
        skip "$count table(s) already present"
        return
    fi

    if [ -f "$BACKUP/lasma.sql" ]; then
        if PGPASSWORD=$(env_get PGPASSWORD) psql -h "$(env_get PGHOST)" -U "$user" -d "$db" \
             -f "$BACKUP/lasma.sql" >/dev/null 2>&1; then
            ok "restored dump from $BACKUP/lasma.sql"
            return
        fi
        warn "dump restore failed - creating an empty schema instead"
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
    else
        warn "no dict.dat - /dict is unavailable until you restore or rebuild it"
    fi
}

step_10_chess() {
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

step_11_verify() {
    cd "$ROOT" || return
    pg_isready -q 2>/dev/null && ok "postgres reachable" || die "postgres unreachable"
    [ -d node_modules ] && ok "dependencies" || die "node_modules missing"
    .venv/bin/python -c "import gtts" 2>/dev/null && ok "python engines" || warn "python engines incomplete"
    [ -f shared/assets/data/emoji.jsonl ] && ok "emoji dataset" || warn "emoji dataset missing"
    [ -f shared/assets/dict/dict.dat ] && ok "dict index" || warn "dict index missing"
    [ -s shared/.env ] && ok "shared/.env" || die "shared/.env missing"
    grep -q "^BOT_TOKEN=." telegram/.env 2>/dev/null && ok "telegram token" || warn "BOT_TOKEN unset - Telegram will not start"
    [ -d whatsapp/auth_info_baileys ] && ok "whatsapp pairing" || warn "whatsapp will show a QR on first start"
}

FROM=1; TO=${#STEP_NAMES[@]}
case "${1:-}" in
    --list) for i in "${!STEP_NAMES[@]}"; do echo "$((i + 1)). ${STEP_NAMES[$i]}"; done; exit 0 ;;
    --from) FROM=${2:-1} ;;
    --only) FROM=${2:-1}; TO=${2:-1} ;;
    --help|-h) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
esac

echo "${bold}Lasma setup${off}  ->  $ROOT"
[ -d "$BACKUP" ] && echo "backup: $BACKUP" || echo "backup: none at $BACKUP (fresh install)"

for i in $(seq "$FROM" "$TO"); do
    say "$i"
    case "$i" in
        1) step_1_packages ;;  2) step_2_bun ;;      3) step_3_postgres ;;
        4) step_4_env ;;       5) step_5_deps ;;     6) step_6_venv ;;
        7) step_7_restore ;;   8) step_8_schema ;;   9) step_9_dict ;;
        10) step_10_chess ;;  11) step_11_verify ;;
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

  bash \$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu$ROOT/scripts/termux-install.sh
EOF
else
    echo "${red}${bold}Finished with ${#FAILED[@]} problem(s):${off}"
    printf '  - %s\n' "${FAILED[@]}"
    echo
    echo "Fix, then re-run just that step:  bash scripts/setup.sh --only <n>"
    exit 1
fi
