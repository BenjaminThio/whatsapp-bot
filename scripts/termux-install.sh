#!/usr/bin/env bash
#
# termux-install.sh - make w, t and lasma work from the Termux prompt.
#
# Run this in TERMUX, not inside Ubuntu. It installs tmux, then adds the three
# shortcuts to Termux's own ~/.bashrc so you can start either bot without
# logging into the proot first. The tmux server lives in Termux and each
# session enters Ubuntu on its own, so the bots survive Ubuntu logouts.
#
#   bash $PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu/root/bots/lasma-bot/scripts/termux-install.sh

set -uo pipefail

if [ ! -d /data/data/com.termux/files/usr ]; then
    echo "This runs in Termux, not inside the proot." >&2
    echo "Exit Ubuntu first, then run it from the Termux prompt." >&2
    exit 1
fi

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
DISTRO="${LASMA_DISTRO:-ubuntu}"
ROOTFS="$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
case "$ROOT" in
    "$ROOTFS"*) UROOT="${ROOT#"$ROOTFS"}" ;;
    *) echo "Expected this script to live inside $ROOTFS." >&2
       echo "Got $ROOT. Set LASMA_DISTRO if your distro is not '$DISTRO'." >&2
       exit 1 ;;
esac

echo "distro:  $DISTRO"
echo "project: $UROOT  (inside the proot)"

command -v proot-distro >/dev/null 2>&1 || { echo "installing proot-distro"; pkg install -y proot-distro; }
command -v tmux         >/dev/null 2>&1 || { echo "installing tmux";         pkg install -y tmux; }

RC="$HOME/.bashrc"
if grep -q "lasma.sh" "$RC" 2>/dev/null; then
    echo "shortcuts already in $RC"
else
    cat >> "$RC" <<EOF

# Lasma bot controls, usable straight from Termux.
# Each bot runs in its own tmux session that enters the $DISTRO proot itself.
w()     { bash "$HERE/lasma.sh" whatsapp "\$@"; }
t()     { bash "$HERE/lasma.sh" telegram "\$@"; }
lasma() { bash "$HERE/lasma.sh" both     "\$@"; }
ub()    { proot-distro login $DISTRO --bind /sdcard:/sdcard; }
EOF
    echo "added w, t, lasma and ub to $RC"
fi

cat <<EOF

Done. Reload your shell:

  source ~/.bashrc

Then, from the Termux prompt:

  w              start the WhatsApp bot and watch it
  t              the Telegram bot
  lasma status   both
  w stop         stop it for good
  ub             drop into an Ubuntu shell
EOF
