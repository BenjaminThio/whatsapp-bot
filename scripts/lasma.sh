#!/usr/bin/env bash
#
# lasma.sh - start, watch and stop either bot.
#
# Works from Termux and from inside the Ubuntu proot, and behaves the same
# either way.
#
#   Termux:  tmux runs in Termux, and each session enters the proot itself.
#            The tmux server stays outside the proot, so sessions survive
#            logging out of Ubuntu.
#   Ubuntu:  tmux and the bot both run here.
#
#   lasma.sh whatsapp            start if needed, then attach
#   lasma.sh telegram status
#   lasma.sh whatsapp stop
#   lasma.sh both start
#   lasma.sh install             add the w / t / lasma shortcuts

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Termux is the only place this path exists; the proot cannot see it
if [ -d /data/data/com.termux/files/usr ]; then
    IN_TERMUX=1
    PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
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
    # Same tree seen from inside the proot: drop the rootfs prefix
    case "$ROOT" in
        "$ROOTFS"*) UROOT="${ROOT#"$ROOTFS"}" ;;
        *)          UROOT="${LASMA_DIR:-/root/lasma-bot}" ;;
    esac
else
    IN_TERMUX=0
    UROOT="$ROOT"
fi

session_for() { case "$1" in whatsapp) echo wa ;; telegram) echo tg ;; esac; }

# The command a tmux session runs to supervise one bot
runner_for() {
    local bot=$1
    if [ "$IN_TERMUX" -eq 1 ]; then
        echo "proot-distro login $DISTRO --bind /sdcard:/sdcard -- bash '$UROOT/scripts/supervise.sh' $bot"
    else
        echo "cd '$UROOT' && exec bash '$UROOT/scripts/supervise.sh' $bot"
    fi
}

need_tmux() {
    command -v tmux >/dev/null 2>&1 && return 0
    if [ "$IN_TERMUX" -eq 1 ]; then
        echo "tmux is not installed.  pkg install -y tmux" >&2
    else
        echo "tmux is not installed.  apt install -y tmux" >&2
    fi
    exit 1
}

need_distro() {
    [ "$IN_TERMUX" -eq 0 ] && return 0
    command -v proot-distro >/dev/null 2>&1 || {
        echo "proot-distro is not installed.  pkg install -y proot-distro" >&2; exit 1; }
    [ -d "$ROOTFS" ] || {
        echo "$DISTRO is not installed.  proot-distro install $DISTRO" >&2; exit 1; }
    [ -f "$ROOTFS$UROOT/scripts/supervise.sh" ] || {
        echo "Cannot find the project at $UROOT inside $DISTRO." >&2
        echo "Set LASMA_DIR to its path inside Ubuntu." >&2; exit 1; }
}

is_up() { tmux has-session -t "$(session_for "$1")" 2>/dev/null; }

# Android suspends Termux a few minutes after the screen goes off, which kills
# the tmux server, the supervisors and both bots. The wakelock is the only thing
# that stops it, and it is a plain command - no reason to make you tap it in the
# notification tray every time.
#
# It is reference-free: one acquire covers everything, and it stays until
# released or Termux exits. Battery optimisation still has to be turned off for
# Termux separately, in Android's settings - that part cannot be scripted.
acquire_wakelock() {
    [ "$IN_TERMUX" -eq 1 ] || return 0
    command -v termux-wake-lock >/dev/null 2>&1 || return 0
    termux-wake-lock 2>/dev/null && echo "wakelock acquired (Termux will not be suspended)"
}

# Only drop it once nothing is left running, or stopping one bot would let
# Android suspend the other.
release_wakelock_if_idle() {
    [ "$IN_TERMUX" -eq 1 ] || return 0
    command -v termux-wake-unlock >/dev/null 2>&1 || return 0
    is_up whatsapp && return 0
    is_up telegram && return 0
    termux-wake-unlock 2>/dev/null && echo "wakelock released (nothing left running)"
}

# The database runs natively in Termux and nothing starts it automatically -
# Termux has no init, and the proot cannot run Postgres at all. The bots refuse
# to start without it, so bring it up here, before the supervisor is launched.
ensure_postgres() {
    [ "$IN_TERMUX" -eq 1 ] || return 0
    command -v pg_isready >/dev/null 2>&1 || return 0
    pg_isready -q -h 127.0.0.1 -p "${PGPORT:-5432}" 2>/dev/null && return 0

    echo "postgres is down - starting it"
    bash "$HERE/termux-postgres.sh" start || echo "could not start postgres; the bot will wait for it"
}

start_bot() {
    local bot=$1 session
    session=$(session_for "$bot")

    if is_up "$bot"; then
        echo "$bot is already running (tmux: $session)"
        return 0
    fi

    need_tmux
    need_distro
    acquire_wakelock
    ensure_postgres
    tmux new-session -d -s "$session" "$(runner_for "$bot")"
    echo "started $bot (tmux: $session)"
}

stop_bot() {
    local bot=$1 session pid
    session=$(session_for "$bot")

    if ! is_up "$bot"; then
        echo "$bot is not running"
        return 0
    fi

    # Signal the supervisor so it exits its loop instead of restarting the bot
    pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | head -1)
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null

    for _ in $(seq 1 15); do
        if ! is_up "$bot"; then
            echo "stopped $bot"
            release_wakelock_if_idle
            return 0
        fi
        sleep 1
    done

    tmux kill-session -t "$session" 2>/dev/null
    echo "force-killed $bot"
    release_wakelock_if_idle
}

status_bot() {
    local bot=$1 since
    if is_up "$bot"; then
        since=$(tmux display-message -p -t "$(session_for "$bot")" \
                '#{session_created_string}' 2>/dev/null)
        echo "  $bot: running since ${since:-?}"
    else
        echo "  $bot: stopped"
    fi
}

attach_bot() {
    local bot=$1
    is_up "$bot" || { echo "$bot is not running"; return 1; }
    echo "attaching to $bot - detach with Ctrl-B then D"
    sleep 1
    tmux attach -t "$(session_for "$bot")"
}

log_bot() {
    local f="$ROOT/logs/$1.log"
    [ "$IN_TERMUX" -eq 1 ] && f="$ROOTFS$UROOT/logs/$1.log"
    [ -f "$f" ] || { echo "no log yet at $f"; return 1; }
    tail -n "${2:-80}" -f "$f"
}

install_shortcuts() {
    local rc="$HOME/.bashrc" self="$HERE/lasma.sh"
    if grep -q "lasma.sh" "$rc" 2>/dev/null; then
        echo "shortcuts already in $rc"
        return 0
    fi

    cat >> "$rc" <<EOF

# Lasma bot controls: w = whatsapp, t = telegram, lasma = both
w()     { bash "$self" whatsapp "\$@"; }
t()     { bash "$self" telegram "\$@"; }
lasma() { bash "$self" both     "\$@"; }
EOF
    echo "added w, t and lasma to $rc"
    # `w` is also a stock procps utility (it lists logged-in users). A shell
    # function wins over an external command, so ours takes over once sourced -
    # but before that, typing `w` silently runs the system one instead.
    command -v w >/dev/null 2>&1 &&         echo "note: w also exists as a system command; the function shadows it once loaded"
    echo "run:  source ~/.bashrc"
}

usage() {
    cat <<EOF
usage: lasma.sh <whatsapp|telegram|both> [start|stop|restart|status|log|attach]
       lasma.sh install

  w              start the WhatsApp bot if it is down, then attach
  w status       is it running?
  w log          follow its log
  w stop         stop it and stop restarting it
  w restart
  t ...          the same for Telegram
  lasma start    both
  lasma status   both

Running from: $([ "$IN_TERMUX" -eq 1 ] && echo "Termux (bots run in the $DISTRO proot)" || echo "inside the proot")
Project:      $UROOT
EOF
}

TARGET="${1:-}"
ACTION="${2:-up}"
shift 2 2>/dev/null || shift 1 2>/dev/null || true

case "$TARGET" in
    install) install_shortcuts; exit 0 ;;
    ""|-h|--help|help) usage; exit 0 ;;
esac

case "$TARGET" in
    whatsapp|telegram) BOTS=("$TARGET") ;;
    both|all)          BOTS=(whatsapp telegram) ;;
    *) echo "unknown target: $TARGET" >&2; usage; exit 2 ;;
esac

case "$ACTION" in
    up)
        # The bare `w` / `t`: bring it up if needed, then watch it
        for b in "${BOTS[@]}"; do start_bot "$b"; done
        if [ "${#BOTS[@]}" -eq 1 ]; then
            attach_bot "${BOTS[0]}"
        else
            echo; for b in "${BOTS[@]}"; do status_bot "$b"; done
        fi
        ;;
    start)   for b in "${BOTS[@]}"; do start_bot "$b"; done ;;
    stop)    for b in "${BOTS[@]}"; do stop_bot  "$b"; done ;;
    restart) for b in "${BOTS[@]}"; do stop_bot  "$b"; start_bot "$b"; done ;;
    status)
        echo "Lasma:"
        if [ "$IN_TERMUX" -eq 1 ] && command -v pg_isready >/dev/null 2>&1; then
            if pg_isready -q -h 127.0.0.1 -p "${PGPORT:-5432}" 2>/dev/null; then
                echo "  postgres: running (Termux, 127.0.0.1:${PGPORT:-5432})"
            else
                echo "  postgres: stopped - run 'pg start'"
            fi
        fi
        if [ "$IN_TERMUX" -eq 1 ] && command -v termux-wake-lock >/dev/null 2>&1; then
            if is_up whatsapp || is_up telegram; then
                echo "  wakelock: held while a bot is running"
            fi
        fi
        for b in "${BOTS[@]}"; do status_bot "$b"; done ;;
    attach)  attach_bot "${BOTS[0]}" ;;
    log)     log_bot "${BOTS[0]}" "${1:-80}" ;;
    *)       echo "unknown action: $ACTION" >&2; usage; exit 2 ;;
esac
