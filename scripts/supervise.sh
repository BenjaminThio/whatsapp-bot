#!/usr/bin/env bash
#
# supervise.sh - keep one bot running.
#
# Restarts it when it dies, backing off so a bot that cannot start (bad token,
# missing env var) does not spin the CPU retrying forever. A clean exit or a
# Ctrl-C stops the loop rather than restarting.
#
#   scripts/supervise.sh whatsapp
#   scripts/supervise.sh telegram
#
# Normally launched by scripts/lasma.sh inside tmux, not run by hand.

set -uo pipefail

BOT="${1:-}"
case "$BOT" in
    whatsapp|telegram) ;;
    *) echo "usage: $0 whatsapp|telegram" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/$BOT.log"

mkdir -p "$LOG_DIR"

MIN_BACKOFF=5
MAX_BACKOFF=300
# A run shorter than this counts as a failed start, so the backoff keeps growing
HEALTHY_AFTER=60
# Trim the log once it passes this, keeping the tail
MAX_LOG_BYTES=$((20 * 1024 * 1024))

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

note() {
    local line="[$(stamp)] [supervise] $*"
    echo "$line"
    echo "$line" >> "$LOG"
}

trim_log() {
    [ -f "$LOG" ] || return 0
    local size
    size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
        tail -c $((MAX_LOG_BYTES / 2)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
        note "log trimmed at ${size} bytes"
    fi
}

# The bot exits immediately when Postgres is unreachable, so bring the database
# up first rather than burning the whole backoff ladder waiting for it.
#
# proot has no systemd and no init, so nothing else is going to start it. When
# the bots are launched from Termux the login shell is non-interactive too, so
# the ~/.bashrc hook does not fire either. This is the only reliable place.
wait_for_postgres() {
    command -v pg_isready >/dev/null 2>&1 || return 0
    pg_isready -q 2>/dev/null && return 0

    note "postgres is down - starting it"
    local bindir
    bindir=$(echo /usr/lib/postgresql/*/bin)
    if [ -x "$bindir/pg_ctl" ]; then
        su postgres -c "$bindir/pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/log start" \
            >/dev/null 2>&1
    fi

    local waited=0
    while ! pg_isready -q 2>/dev/null; do
        sleep 3
        waited=$((waited + 3))
        if [ "$waited" -ge 120 ]; then
            note "postgres still down after ${waited}s - starting the bot anyway"
            return 0
        fi
    done
    note "postgres up after ${waited}s"
}

stopping=0
on_signal() {
    stopping=1
    note "stop requested"
    # The bot is the foreground child; it gets the signal too and shuts down
}
trap on_signal INT TERM

cd "$ROOT" || exit 1

backoff=$MIN_BACKOFF
note "supervising $BOT (pid $$)"

while :; do
    wait_for_postgres
    trim_log

    started=$(date +%s)
    note "starting $BOT"

    bun run "$BOT" 2>&1 | tee -a "$LOG"
    code=${PIPESTATUS[0]}

    ran=$(( $(date +%s) - started ))
    [ "$stopping" -eq 1 ] && { note "stopped"; exit 0; }

    # 0 is a deliberate shutdown; 130 is Ctrl-C; 143 is SIGTERM
    case "$code" in
        0)   note "$BOT exited cleanly after ${ran}s - not restarting"; exit 0 ;;
        130|143) note "$BOT interrupted after ${ran}s - not restarting";  exit 0 ;;
    esac

    if [ "$ran" -ge "$HEALTHY_AFTER" ]; then
        # It was up and healthy, so this is a fresh fault - retry promptly
        backoff=$MIN_BACKOFF
        note "$BOT died (exit $code) after ${ran}s"
    else
        note "$BOT failed to stay up (exit $code, ${ran}s)"
    fi

    note "restarting in ${backoff}s"
    sleep "$backoff"

    backoff=$((backoff * 2))
    [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
done
