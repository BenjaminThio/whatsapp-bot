#!/usr/bin/env bash
#
# restore-db.sh - load a pg_dump backup into the current database.
#
# Run this in TERMUX, where the server lives.
#
# DESTRUCTIVE: the target database is dropped and recreated, so everything
# currently in it is lost. That is deliberate - restoring a dump on top of
# existing tables produces "already exists" errors on every object and leaves
# you with a half-merged mess that is worse than either version.
#
#   restore-db.sh                            /sdcard/lasma-backup/lasma.sql
#   restore-db.sh /path/to/other.sql
#   restore-db.sh --check                    inspect the dump, change nothing
#   restore-db.sh --yes                      skip the confirmation
#
# It takes a safety dump of the current contents first, so a bad restore is
# recoverable.

set -uo pipefail

if [ ! -d /data/data/com.termux/files/usr ]; then
    echo "Run this in Termux - that is where the database lives." >&2
    echo "Type 'exit' to leave Ubuntu first." >&2
    exit 1
fi

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
DISTRO="${LASMA_DISTRO:-ubuntu}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DUMP="/sdcard/lasma-backup/lasma.sql"
ASSUME_YES=0; CHECK_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y)  ASSUME_YES=1 ;;
        --check)   CHECK_ONLY=1 ;;
        --help|-h) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        -*) echo "unknown option: $1" >&2; exit 2 ;;
        *)  DUMP="$1" ;;
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

# Connection settings come from the project's shared/.env, so this always
# targets whatever the bots actually use
ENVFILE="$HERE/../shared/.env"
env_get() { [ -f "$ENVFILE" ] && sed -n "s/^$1=//p" "$ENVFILE" | head -1; }

PGHOST=$(env_get PGHOST);         : "${PGHOST:=127.0.0.1}"
PGPORT=$(env_get PGPORT);         : "${PGPORT:=5432}"
PGUSER=$(env_get PGUSER);         : "${PGUSER:=postgres}"
PGDATABASE=$(env_get PGDATABASE); : "${PGDATABASE:=lasma_bot}"
PGPASSWORD=$(env_get PGPASSWORD)
export PGPASSWORD

psql_run() { PGCONNECT_TIMEOUT=10 psql -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$@"; }

echo "${bold}Restore into $PGDATABASE${off}"

[ -f "$DUMP" ] || die "no dump at $DUMP"

# ── Look before leaping ───────────────────────────────────────────────────────

size=$(( $(wc -c < "$DUMP") / 1024 ))
rows=$(grep -c "^COPY\|^INSERT INTO" "$DUMP" 2>/dev/null) || rows=0
tables=$(grep -c "^CREATE TABLE" "$DUMP" 2>/dev/null) || tables=0

note "dump:    $DUMP"
note "size:    ${size} KB"
note "tables:  $tables"
note "data:    $rows COPY/INSERT statement(s)"

if tail -5 "$DUMP" | grep -q "PostgreSQL database dump complete"; then
    ok "dump is complete"
else
    warn "no completion marker at the end - this dump may be truncated"
fi

if [ "$tables" -eq 0 ] && [ "$rows" -eq 0 ]; then
    die "the dump contains no tables and no data - refusing to restore it"
fi

if ! pg_isready -q -h "$PGHOST" -p "$PGPORT" 2>/dev/null; then
    note "postgres is down - starting it"
    bash "$HERE/termux-postgres.sh" start || die "could not start postgres"
fi

current=$(psql_run -d "$PGDATABASE" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
    2>/dev/null | tr -d ' \r')
note "target:  $PGDATABASE at $PGHOST:$PGPORT, currently ${current:-0} table(s)"

[ "$CHECK_ONLY" -eq 1 ] && { echo; ok "--check only, nothing changed"; exit 0; }

# ── Confirm ───────────────────────────────────────────────────────────────────

if [ "${current:-0}" -gt 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    echo
    echo "  ${bold}${red}$PGDATABASE already has ${current} table(s).${off}"
    echo "  They will be DROPPED and replaced by the dump's contents."
    printf "  Type the database name to confirm: "
    IFS= read -r reply < /dev/tty
    [ "$reply" = "$PGDATABASE" ] || die "not confirmed - nothing changed"
fi

# ── Stop the bots, or they will hold connections open ─────────────────────────

stopped=0
if command -v tmux >/dev/null 2>&1; then
    if tmux has-session -t wa 2>/dev/null || tmux has-session -t tg 2>/dev/null; then
        note "stopping the bots so they release their connections"
        bash "$HERE/lasma.sh" both stop >/dev/null 2>&1
        stopped=1
    fi
fi

# ── Safety net ────────────────────────────────────────────────────────────────

if [ "${current:-0}" -gt 0 ]; then
    SAFETY="/sdcard/lasma-backup/pre-restore-$(date +%Y%m%d-%H%M%S).sql"
    mkdir -p "$(dirname "$SAFETY")"
    if pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE" > "$SAFETY" 2>/dev/null; then
        ok "saved the current contents to $SAFETY"
    else
        rm -f "$SAFETY"
        warn "could not take a safety dump - continuing anyway"
    fi
fi

# ── Replace ───────────────────────────────────────────────────────────────────

note "dropping and recreating $PGDATABASE"
psql_run -d postgres -qc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PGDATABASE' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1
psql_run -d postgres -qc "DROP DATABASE IF EXISTS $PGDATABASE;" >/dev/null 2>&1 \
    || die "could not drop $PGDATABASE"
psql_run -d postgres -qc "CREATE DATABASE $PGDATABASE OWNER $PGUSER ENCODING 'UTF8';" >/dev/null 2>&1 \
    || die "could not recreate $PGDATABASE"
ok "empty database ready"

note "restoring - this can take a while"
LOG=$PREFIX/tmp/lasma-restore.log
mkdir -p "$(dirname "$LOG")"
if psql_run -d "$PGDATABASE" -v ON_ERROR_STOP=0 -f "$DUMP" > "$LOG" 2>&1; then
    ok "restore finished"
else
    warn "psql reported errors - see below"
fi

errors=$(grep -c "^ERROR:" "$LOG" 2>/dev/null) || errors=0
if [ "$errors" -gt 0 ]; then
    warn "$errors error line(s) during restore:"
    grep "^ERROR:" "$LOG" | head -10 | sed 's/^/      /'
    note "full log: $LOG"
fi

# ── Verify ────────────────────────────────────────────────────────────────────

after=$(psql_run -d "$PGDATABASE" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
    2>/dev/null | tr -d ' \r')
ok "$PGDATABASE now has ${after:-0} table(s)"

if [ "${after:-0}" -eq 0 ]; then
    die "no tables after the restore - something went wrong, check $LOG"
fi

echo
psql_run -d "$PGDATABASE" -c "
SELECT relname AS table, n_live_tup AS approx_rows
FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 12;" 2>/dev/null

echo
ok "done"
if [ "$stopped" -eq 1 ]; then
    echo "  The bots were stopped for the restore. Start them again with:  w   and   t"
fi
