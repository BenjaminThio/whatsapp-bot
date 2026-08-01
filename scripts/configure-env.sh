#!/usr/bin/env bash
#
# configure-env.sh - write shared/.env and telegram/.env by asking for each key.
#
# Beats nano because it knows every key both bots read, shows what is already
# set, and never loses a value you do not retype. Re-run it any time to change
# one thing; press Enter on everything else.
#
#   scripts/configure-env.sh              ask for everything
#   scripts/configure-env.sh --postgres   only the database block
#   scripts/configure-env.sh --show       print what is set, secrets masked

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED_ENV="$ROOT/shared/.env"
TG_ENV="$ROOT/telegram/.env"

declare -A CUR VAL

bold=$(tput bold 2>/dev/null || echo); dim=$(tput dim 2>/dev/null || echo)
off=$(tput sgr0 2>/dev/null || echo)

load_existing() {
    local f=$1 line k v
    [ -f "$f" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%$'\r'}
        case "$line" in ''|\#*) continue ;; esac
        [[ "$line" != *=* ]] && continue
        k=${line%%=*}; v=${line#*=}
        k=${k// /}
        [ -n "$k" ] && CUR["$k"]=$v
    done < "$f"
}

mask() {
    local v=$1
    if [ ${#v} -le 8 ]; then echo "********"
    else echo "${v:0:4}...${v: -4} (${#v} chars)"; fi
}

# ask KEY "description" [default] [secret]
ask() {
    local key=$1 desc=$2 default=${3:-} secret=${4:-}
    local cur=${CUR[$key]:-$default} reply shown

    echo
    echo "  ${bold}$key${off}"
    echo "    ${dim}$desc${off}"

    if [ -n "$cur" ]; then
        if [ -n "$secret" ]; then shown=$(mask "$cur"); else shown=$cur; fi
        printf '    current: %s\n    new value (Enter keeps it): ' "$shown"
    else
        printf '    value (Enter leaves it unset): '
    fi

    IFS= read -r reply < /dev/tty
    if   [ -n "$reply" ]; then VAL["$key"]=$reply
    elif [ -n "$cur" ];   then VAL["$key"]=$cur
    else                       VAL["$key"]=""
    fi
}

emit() {
    local key=$1 v=${VAL[$1]:-}
    if [ -n "$v" ]; then echo "$key=$v"; else echo "# $key="; fi
}

section() { echo; echo "${bold}== $1 ==${off}"; [ -n "${2:-}" ] && echo "${dim}$2${off}"; }

show_only() {
    local f k v
    for f in "$SHARED_ENV" "$TG_ENV"; do
        echo "${bold}$f${off}"
        if [ ! -f "$f" ]; then echo "  (missing)"; continue; fi
        while IFS= read -r line || [ -n "$line" ]; do
            line=${line%$'\r'}
            case "$line" in ''|\#*) continue ;; esac
            [[ "$line" != *=* ]] && continue
            k=${line%%=*}; v=${line#*=}
            case "$k" in
                PGHOST|PGPORT|PGUSER|PGDATABASE|*URL*|*ENDPOINT*|*DOMAIN*|SMART_SCHEDULE_SKIP)
                    echo "  $k=$v" ;;
                *) [ -n "$v" ] && echo "  $k=$(mask "$v")" || echo "  $k=(unset)" ;;
            esac
        done < "$f"
        echo
    done
}

ask_postgres() {
    section "Postgres" "The server runs in Termux, reached over 127.0.0.1. Defaults are fine."
    ask PGHOST     "Host. 127.0.0.1 reaches the Termux server from inside the proot." "127.0.0.1"
    ask PGPORT     "Port." "5432"
    ask PGUSER     "Role the bots connect as - whatever termux-postgres.sh created." "postgres"
    ask PGPASSWORD "Password for that role, as given to termux-postgres.sh." "" secret
    ask PGDATABASE "Database name." "lasma_bot"
}

ask_shared() {
    section "AI providers" "All optional. Any one you fill in is used; the rest are fallbacks."
    ask AI_API_KEY         "Google Gemini key - the primary provider." "" secret
    ask GROQ_API_KEY       "Groq. Fast fallback." "" secret
    ask CEREBRAS_API_KEY   "Cerebras. Fallback." "" secret
    ask OPENROUTER_API_KEY "OpenRouter. Last-resort fallback." "" secret

    section "UTAR attendance (hi-hive)" "Leave blank to run without the attendance features."
    ask ATTENDANCE_QR_SCAN_API_DOMAIN "Base domain of the scan API."
    ask ATTENDANCE_ENDPOINT           "Attendance submit endpoint."
    ask UTAR_SCAN_URL                 "URL the QR scanner posts to."
    ask UTAR_REPORT_URL               "URL the attendance report is fetched from."
    ask AES_KEY     "AES key used to encrypt stored student credentials." "" secret
    ask AES_IV      "AES IV that goes with it." "" secret
    ask DEVICE_ID   "Device id the portal expects." "" secret
    ask SMART_SCHEDULE_SKIP "Comma-separated class codes the smart scheduler ignores."

    section "Other services"
    ask OPEN_WEATHER_API_KEY "OpenWeather key for /weather." "" secret
    ask VERCEL_WEBHOOK_URL   "Public base URL of the GitHub webhook relay. Blank disables /webhook."
}

ask_telegram() {
    section "Telegram"
    ask BOT_TOKEN "Bot token from @BotFather. The Telegram bot will not start without it." "" secret

    echo
    printf "  Set up the one-off Firestore import as well? Only needed if you are\n"
    printf "  migrating old cloud data. [y/N]: "
    local yn; IFS= read -r yn < /dev/tty
    case "$yn" in
        [Yy]*)
            ask FIREBASE_API_KEY             "Firebase web API key." "" secret
            ask FIREBASE_AUTH_DOMAIN         "authDomain."
            ask FIREBASE_PROJECT_ID          "projectId."
            ask FIREBASE_STORAGE_BUCKET      "storageBucket."
            ask FIREBASE_MESSAGING_SENDER_ID "messagingSenderId."
            ask FIREBASE_APP_ID              "appId."
            ask FIREBASE_MEASUREMENT_ID      "measurementId."
            WANT_FIREBASE=1 ;;
        *) WANT_FIREBASE=0 ;;
    esac
}

write_shared() {
    mkdir -p "$(dirname "$SHARED_ENV")"
    [ -f "$SHARED_ENV" ] && cp "$SHARED_ENV" "$SHARED_ENV.bak"
    {
        echo "# shared/.env - every key both bots read."
        echo "# Generated by scripts/configure-env.sh on $(date '+%Y-%m-%d %H:%M')."
        echo "# The real environment and each bot's own .env override these."
        echo
        echo "# AI providers"
        for k in AI_API_KEY GROQ_API_KEY CEREBRAS_API_KEY OPENROUTER_API_KEY; do emit "$k"; done
        echo
        echo "# UTAR attendance"
        for k in ATTENDANCE_QR_SCAN_API_DOMAIN ATTENDANCE_ENDPOINT UTAR_SCAN_URL \
                 UTAR_REPORT_URL AES_KEY AES_IV DEVICE_ID SMART_SCHEDULE_SKIP; do emit "$k"; done
        echo
        echo "# Other services"
        for k in OPEN_WEATHER_API_KEY VERCEL_WEBHOOK_URL; do emit "$k"; done
        echo
        echo "# Postgres - the server runs natively in Termux, not in the proot"
        for k in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do emit "$k"; done
    } > "$SHARED_ENV"
    chmod 600 "$SHARED_ENV"
}

write_telegram() {
    mkdir -p "$(dirname "$TG_ENV")"
    [ -f "$TG_ENV" ] && cp "$TG_ENV" "$TG_ENV.bak"
    {
        echo "# telegram/.env - Telegram-only keys. Everything else is in shared/.env."
        echo "# Generated by scripts/configure-env.sh on $(date '+%Y-%m-%d %H:%M')."
        echo
        emit BOT_TOKEN
        if [ "${WANT_FIREBASE:-0}" = "1" ]; then
            echo
            echo "# Only used by scripts/migrate-firestore.ts. Safe to delete once migrated."
            for k in FIREBASE_API_KEY FIREBASE_AUTH_DOMAIN FIREBASE_PROJECT_ID \
                     FIREBASE_STORAGE_BUCKET FIREBASE_MESSAGING_SENDER_ID \
                     FIREBASE_APP_ID FIREBASE_MEASUREMENT_ID; do emit "$k"; done
        fi
    } > "$TG_ENV"
    chmod 600 "$TG_ENV"
}

MODE=all
case "${1:-}" in
    --show)     load_existing "$SHARED_ENV"; load_existing "$TG_ENV"; show_only; exit 0 ;;
    --postgres) MODE=postgres ;;
    --help|-h)  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
esac

load_existing "$SHARED_ENV"
load_existing "$TG_ENV"

cat <<EOF
${bold}Lasma configuration${off}

Values you already have are shown and kept if you just press Enter.
Anything you leave blank is written as a comment, and the feature that
needs it degrades instead of crashing.
EOF

if [ "$MODE" = postgres ]; then
    ask_postgres
    # Keep everything else exactly as it was
    for k in "${!CUR[@]}"; do [ -z "${VAL[$k]+x}" ] && VAL["$k"]=${CUR[$k]}; done
    WANT_FIREBASE=$([ -n "${CUR[FIREBASE_API_KEY]:-}" ] && echo 1 || echo 0)
    write_shared
    echo; echo "Wrote $SHARED_ENV"
    exit 0
fi

ask_postgres
ask_shared
ask_telegram

write_shared
write_telegram

cat <<EOF

${bold}Done.${off}
  $SHARED_ENV
  $TG_ENV

Both are chmod 600 and ignored by git. The previous versions, if any, are
saved alongside as .bak.

  scripts/configure-env.sh --show     check what landed
EOF
