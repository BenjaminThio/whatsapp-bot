#!/usr/bin/env bash
#
# termux-postgres.sh - the database, running natively in Termux.
#
# Run this in TERMUX, not inside the proot.
#
# Postgres does not work inside proot-distro: /dev/shm there is a bind to an
# ordinary directory rather than a tmpfs, because proot cannot mount one, and
# the POSIX shared-memory calls Postgres makes block forever on it. initdb
# hangs at "selecting default shared_buffers" and never returns. Running the
# server natively skips proot's syscall emulation entirely.
#
# The proot shares Termux's network namespace, so the bots inside Ubuntu reach
# this server on 127.0.0.1:5432 with nothing mounted across.
#
#   termux-postgres.sh                 install, initialise, start, create role+db
#   termux-postgres.sh start|stop|status|restart
#   termux-postgres.sh --password PW   set the role password non-interactively
#   termux-postgres.sh --trust         allow TCP without a password (recovery)
#   termux-postgres.sh --reinit        destroy the cluster and start over

set -uo pipefail

if [ ! -d /data/data/com.termux/files/usr ]; then
    echo "This runs in Termux, not inside the proot." >&2
    echo "Type 'exit' to leave Ubuntu, then run it again." >&2
    exit 1
fi

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
PGDATA="${PGDATA:-$PREFIX/var/lib/postgresql}"
LOGFILE="$PGDATA/server.log"
DISTRO="${LASMA_DISTRO:-ubuntu}"
# proot-distro moved the rootfs at some point: newer versions keep it under
# containers/<distro>/rootfs, older ones under installed-rootfs/<distro>.
# Detect rather than assume, and fall back to the newer layout for messages.
find_rootfs() {
    local d
    for d in "$PREFIX/var/lib/proot-distro/containers/$DISTRO/rootfs"              "$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"; do
        [ -d "$d" ] && { echo "$d"; return 0; }
    done
    echo "$PREFIX/var/lib/proot-distro/containers/$DISTRO/rootfs"
    return 1
}
ROOTFS=$(find_rootfs)

DB_USER="${PGUSER:-postgres}"
DB_NAME="${PGDATABASE:-lasma_bot}"
DB_PORT="${PGPORT:-5432}"

bold=$(tput bold 2>/dev/null || echo); red=$(tput setaf 1 2>/dev/null || echo)
grn=$(tput setaf 2 2>/dev/null || echo); ylw=$(tput setaf 3 2>/dev/null || echo)
off=$(tput sgr0 2>/dev/null || echo)

ok()   { echo "  ${grn}ok${off}  $*"; }
warn() { echo "  ${ylw}!!${off}  $*"; }
die()  { echo "  ${red}xx${off}  $*"; exit 1; }
note() { echo "  --  $*"; }

PASSWORD=""; TRUST=0; REINIT=0; ACTION=setup

while [ $# -gt 0 ]; do
    case "$1" in
        start|stop|status|restart) ACTION=$1 ;;
        --password) PASSWORD="${2:-}"; shift ;;
        --trust)    TRUST=1 ;;
        --reinit)   REINIT=1 ;;
        --help|-h)  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

is_running() { pg_isready -q -h 127.0.0.1 -p "$DB_PORT" 2>/dev/null; }

start_server() {
    is_running && { ok "already running on port $DB_PORT"; return 0; }
    [ -s "$PGDATA/global/pg_control" ] || die "no cluster at $PGDATA - run: termux-postgres.sh"

    # Termux has no init system, so nothing else is going to do this
    rm -f "$PGDATA/postmaster.pid" 2>/dev/null
    pg_ctl -D "$PGDATA" -l "$LOGFILE" -o "-p $DB_PORT" start >/dev/null 2>&1

    for _ in $(seq 1 25); do
        is_running && { ok "started on port $DB_PORT"; return 0; }
        sleep 1
    done

    warn "server did not come up; last lines of $LOGFILE:"
    tail -20 "$LOGFILE" 2>/dev/null | sed 's/^/      /'
    return 1
}

stop_server() {
    is_running || { ok "not running"; return 0; }
    pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1
    for _ in $(seq 1 15); do is_running || { ok "stopped"; return 0; }; sleep 1; done
    warn "did not stop cleanly"
    return 1
}

case "$ACTION" in
    start)   start_server; exit $? ;;
    stop)    stop_server;  exit $? ;;
    restart) stop_server; start_server; exit $? ;;
    status)
        if is_running; then
            ok "running on 127.0.0.1:$DB_PORT"
            psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
                 "SELECT 'database ' || current_database() || ', encoding ' || pg_encoding_to_char(encoding) FROM pg_database WHERE datname=current_database()" \
                 2>/dev/null | sed 's/^/      /'
        else
            warn "not running - start it with: termux-postgres.sh start"
        fi
        exit 0 ;;
esac

# ── Full setup ────────────────────────────────────────────────────────────────

echo "${bold}Postgres for Lasma, in Termux${off}"

command -v pg_ctl >/dev/null 2>&1 || {
    note "installing postgresql"
    pkg install -y postgresql || die "pkg install postgresql failed"
}
ok "postgresql $(pg_ctl --version | awk '{print $NF}')"

if [ "$REINIT" -eq 1 ] && [ -d "$PGDATA" ]; then
    warn "destroying the cluster at $PGDATA (--reinit)"
    stop_server >/dev/null 2>&1
    rm -rf "$PGDATA"
fi

# pg_control is written at the end of initdb, so it is the honest "finished" test
if [ -s "$PGDATA/global/pg_control" ]; then
    ok "cluster exists at $PGDATA"
elif [ -e "$PGDATA/PG_VERSION" ] || [ -d "$PGDATA/base" ]; then
    die "half-initialised cluster at $PGDATA - clear it with: termux-postgres.sh --reinit"
else
    mkdir -p "$PGDATA"
    note "running initdb (encoding UTF8, locale C.UTF-8)"
    # Encoding is explicit: inherited from LANG it would come out SQL_ASCII,
    # which does no validation and breaks upper()/ILIKE/ORDER BY on the emoji
    # and accented text these bots are full of.
    initdb -D "$PGDATA" --encoding=UTF8 --locale=C.UTF-8 || die "initdb failed"
    [ -s "$PGDATA/global/pg_control" ] || die "initdb produced no pg_control"
    ok "cluster initialised"
fi

start_server || die "could not start the server"

# ── Role and database ─────────────────────────────────────────────────────────

BOOTSTRAP=$(whoami)

if [ -z "$PASSWORD" ] && [ "$TRUST" -eq 0 ]; then
    printf "  password for the '%s' role (Enter to keep any existing one): " "$DB_USER"
    IFS= read -rs PASSWORD < /dev/tty
    echo
fi

# The bootstrap superuser is the Termux user, not "postgres"
if psql -h 127.0.0.1 -p "$DB_PORT" -U "$BOOTSTRAP" -d postgres -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1; then
    ok "role $DB_USER exists"
    [ -n "$PASSWORD" ] && psql -h 127.0.0.1 -p "$DB_PORT" -U "$BOOTSTRAP" -d postgres -qc \
        "ALTER ROLE $DB_USER WITH PASSWORD '$PASSWORD';" >/dev/null 2>&1 && ok "password set"
elif [ "$DB_USER" = "$BOOTSTRAP" ]; then
    ok "role $DB_USER is the bootstrap superuser"
else
    if [ -n "$PASSWORD" ]; then
        psql -h 127.0.0.1 -p "$DB_PORT" -U "$BOOTSTRAP" -d postgres -qc \
            "CREATE ROLE $DB_USER WITH LOGIN SUPERUSER PASSWORD '$PASSWORD';" >/dev/null 2>&1 \
            && ok "role $DB_USER created" || die "could not create role $DB_USER"
    else
        psql -h 127.0.0.1 -p "$DB_PORT" -U "$BOOTSTRAP" -d postgres -qc \
            "CREATE ROLE $DB_USER WITH LOGIN SUPERUSER;" >/dev/null 2>&1 \
            && ok "role $DB_USER created (no password)" || die "could not create role $DB_USER"
    fi
fi

if psql -h 127.0.0.1 -p "$DB_PORT" -U "$BOOTSTRAP" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
    ok "database $DB_NAME exists"
else
    createdb -h 127.0.0.1 -p "$DB_PORT" -U "$BOOTSTRAP" -O "$DB_USER" "$DB_NAME" \
        && ok "database $DB_NAME created" || die "could not create database $DB_NAME"
fi

# ── Who may connect over TCP ──────────────────────────────────────────────────

HBA="$PGDATA/pg_hba.conf"
if [ "$TRUST" -eq 1 ]; then
    sed -i -E 's|^(host.*127\.0\.0\.1/32[[:space:]]+).*$|\1trust|; s|^(host.*::1/128[[:space:]]+).*$|\1trust|' "$HBA"
    warn "TCP set to trust - any app on this phone can connect without a password"
elif [ -n "$PASSWORD" ]; then
    sed -i -E 's|^(host.*127\.0\.0\.1/32[[:space:]]+).*$|\1scram-sha-256|; s|^(host.*::1/128[[:space:]]+).*$|\1scram-sha-256|' "$HBA"
    ok "TCP requires a password (scram-sha-256)"
fi
# Local socket auth is left alone, so you can always administer it from Termux
pg_ctl -D "$PGDATA" reload >/dev/null 2>&1

# ── Tell the bots where it is ─────────────────────────────────────────────────

# Derived from where this script lives, not hardcoded, so moving the checkout
# does not need a code change. This file sits at <project>/scripts/.
ENVFILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/shared/.env"
if [ -f "$ENVFILE" ]; then
    cp "$ENVFILE" "$ENVFILE.bak"
    for kv in "PGHOST=127.0.0.1" "PGPORT=$DB_PORT" "PGUSER=$DB_USER" "PGDATABASE=$DB_NAME"; do
        k=${kv%%=*}
        if grep -q "^$k=" "$ENVFILE"; then sed -i "s|^$k=.*|$kv|" "$ENVFILE"
        else echo "$kv" >> "$ENVFILE"; fi
    done
    if [ -n "$PASSWORD" ]; then
        if grep -q "^PGPASSWORD=" "$ENVFILE"; then sed -i "s|^PGPASSWORD=.*|PGPASSWORD=$PASSWORD|" "$ENVFILE"
        else echo "PGPASSWORD=$PASSWORD" >> "$ENVFILE"; fi
    fi
    ok "updated $ENVFILE"
else
    note "no shared/.env yet - put these in it when setup.sh asks:"
    echo "        PGHOST=127.0.0.1"
    echo "        PGPORT=$DB_PORT"
    echo "        PGUSER=$DB_USER"
    echo "        PGDATABASE=$DB_NAME"
    echo "        PGPASSWORD=(the password you just chose)"
fi

echo
ok "reachable at 127.0.0.1:$DB_PORT from Termux and from inside the proot"
echo
echo "Next, inside Ubuntu:"
echo "  proot-distro login $DISTRO"
echo "  cd ~/lasma-bot && bash scripts/setup.sh"
