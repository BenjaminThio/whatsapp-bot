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

# Bun's installer appends its PATH line to ~/.bashrc, and Ubuntu's ~/.bashrc
# returns immediately when the shell is not interactive. We are launched as
# `proot-distro login ubuntu -- bash supervise.sh`, which is neither
# interactive nor a login shell, so that line never runs and bun is not found.
# Put the usual locations on PATH here instead of depending on a profile.
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

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

# The bot exits immediately when Postgres is unreachable, so wait for it rather
# than burning the whole backoff ladder on a database that is merely slow.
#
# The server runs natively in TERMUX, not in this proot - Postgres cannot be
# initialised in here, because proot cannot mount a tmpfs on /dev/shm and the
# POSIX shared-memory calls block forever on the ordinary directory it binds
# instead. Nothing in this process can start it; lasma.sh does that on the
# Termux side before it launches us. All we can do is wait.
wait_for_postgres() {
    command -v pg_isready >/dev/null 2>&1 || return 0

    local host=${PGHOST:-127.0.0.1} port=${PGPORT:-5432}
    pg_isready -q -h "$host" -p "$port" 2>/dev/null && return 0

    note "waiting for postgres at $host:$port (it runs in Termux)"
    local waited=0
    while ! pg_isready -q -h "$host" -p "$port" 2>/dev/null; do
        sleep 3
        waited=$((waited + 3))
        if [ "$waited" -ge 120 ]; then
            note "still down after ${waited}s - start it in Termux: termux-postgres.sh start"
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

# Fail loudly and immediately rather than restart-looping on something a retry
# cannot fix
if ! command -v bun >/dev/null 2>&1; then
    note "bun is not on PATH and was not found in ${BUN_INSTALL:-$HOME/.bun}/bin"
    note "install it inside the proot with:"
    note "  curl -fsSL https://bun.sh/install | bash"
    note "or, if it is installed somewhere else, set BUN_INSTALL to its parent"
    exit 1
fi

backoff=$MIN_BACKOFF
note "supervising $BOT (pid $$) using $(command -v bun)"

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
        127) # command not found - a missing binary is never fixed by waiting
             note "exit 127: something the bot runs is not installed"
             note "not restarting, because retrying cannot fix a missing command"
             exit 1 ;;
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
