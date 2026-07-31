# Rebuilding Lasma on a fresh Termux

Everything, Postgres included, lives **inside the Ubuntu proot**. Nothing is
mounted across from Termux, so there is one filesystem, one set of paths, and no
`/data/data/com.termux/...` links to keep straight.

Steps 0 to 2 run in Termux. Everything from step 3 runs inside Ubuntu.

---

## 0. Before you wipe anything

Pull these off the phone first. They are not in the repo and cannot be
regenerated.

```bash
mkdir -p /sdcard/lasma-backup

# Database dump
pg_dump -h 127.0.0.1 -U lasma lasma_bot > /sdcard/lasma-backup/lasma.sql

# WhatsApp pairing state. Without it you re-scan the QR from the phone.
cp -r ~/bots/lasma-bot/whatsapp/auth_info_baileys /sdcard/lasma-backup/

# Secrets
cp ~/bots/lasma-bot/shared/.env               /sdcard/lasma-backup/shared.env
cp ~/bots/lasma-bot/telegram/.env             /sdcard/lasma-backup/telegram.env
cp ~/bots/lasma-bot/shared/hi-hive/creds.json /sdcard/lasma-backup/
cp ~/bots/lasma-bot/shared/hi-hive/legacy/creds.json /sdcard/lasma-backup/legacy-creds.json
cp ~/bots/lasma-bot/whatsapp/serviceAccountKey.json  /sdcard/lasma-backup/

# Large assets - 740 MB total, and the dict takes hours to rebuild
cp ~/bots/lasma-bot/shared/assets/data/emoji.jsonl /sdcard/lasma-backup/
cp ~/bots/lasma-bot/shared/assets/dict/dict.dat    /sdcard/lasma-backup/
cp ~/bots/lasma-bot/shared/assets/dict/dict.idx    /sdcard/lasma-backup/
```

Copy `/sdcard/lasma-backup` to a computer as well. `/sdcard` survives a Termux
reinstall, but not a factory reset.

You need roughly **3 GB free** for the finished install: 740 MB of assets,
350 MB of `node_modules`, ~1 GB for Ubuntu and the toolchain, plus the venv.

---

## 1. Termux, from scratch

Uninstall Termux, reinstall it from **F-Droid or GitHub** (not the Play Store
build, it is years out of date), then:

```bash
pkg update -y && pkg upgrade -y
pkg install -y proot-distro git openssh
termux-setup-storage
```

`termux-setup-storage` raises an Android permission dialog. Accept it, otherwise
`/sdcard` stays unreadable and step 8 has nothing to copy from.

## 2. Install Ubuntu

```bash
proot-distro install ubuntu
proot-distro login ubuntu
```

From here on you are **inside Ubuntu**. After closing Termux, get back in with:

```bash
proot-distro login ubuntu
```

Your backup is visible inside the proot at `/sdcard` once Termux has storage
permission. If it is not, log in with an explicit bind instead:

```bash
proot-distro login ubuntu --bind /sdcard:/sdcard
```

---

## 3. Base packages (inside Ubuntu)

```bash
apt update && apt upgrade -y

apt install -y \
  curl wget git unzip nano tmux locales \
  build-essential cmake ninja-build pkg-config \
  python3 python3-pip python3-venv \
  ffmpeg \
  postgresql postgresql-contrib \
  libvips-dev
```

Generate a locale before touching Postgres. `initdb` fails on a system with no
locales, and the error it gives does not say so.

```bash
locale-gen en_US.UTF-8
update-locale LANG=en_US.UTF-8
export LANG=en_US.UTF-8
```

| Package group | Needed for |
| --- | --- |
| `build-essential cmake ninja-build` | the chess renderer and `dict_lookup` |
| `python3-venv` | the media engines (gTTS, rembg, denoise, yt-dlp) |
| `ffmpeg` | `/convert` and `/denoise` |
| `postgresql` | the shared database |
| `libvips-dev` | `sharp`, used by the timetable renderer |
| `tmux` | keeping both bots alive after you close Termux |

## 4. Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

If Bun's prebuilt binary will not run on your device, install Node 20+
(`apt install -y nodejs npm`) and substitute `node`/`npx` for `bun` throughout.
The code is plain ESM TypeScript.

## 5. Postgres, inside Ubuntu

proot has no systemd, so `service postgresql start` usually fails. Start the
server directly.

```bash
mkdir -p /var/lib/postgresql/data /var/run/postgresql
chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
chmod 775 /var/run/postgresql

su postgres -c "/usr/lib/postgresql/*/bin/initdb -D /var/lib/postgresql/data"
su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/log start"
```

Create the role and database:

```bash
su postgres -c "psql -c \"CREATE USER lasma WITH PASSWORD 'choose-a-password' SUPERUSER;\""
su postgres -c "psql -c 'CREATE DATABASE lasma_bot OWNER lasma;'"
```

Check it:

```bash
psql -h 127.0.0.1 -U lasma -d lasma_bot -c 'SELECT version();'
```

**Bringing it up after a reboot.** proot starts nothing on its own, so put this
in `~/.bashrc` and it comes up with your shell:

```bash
cat >> ~/.bashrc <<'EOF'
pg_isready -q 2>/dev/null || su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/log start"
EOF
```

## 6. The project

```bash
mkdir -p ~/bots && cd ~/bots
git clone <your-repo-url> lasma-bot
cd lasma-bot
bun install
```

One `bun install` at the root installs all three workspaces into a single
hoisted `node_modules`. Do not run it inside `telegram/` or `whatsapp/`.

## 7. Python environment

One venv at the workspace root, shared by both bots.

```bash
cd ~/bots/lasma-bot
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

`rembg` pulls in onnxruntime, which is large and slow on ARM and sometimes has
no wheel at all. If it fails, drop that one line from `requirements.txt` and
reinstall. Only `/removebg` stops working; every other engine is fine.

## 8. Restore the backup

```bash
cd ~/bots/lasma-bot

cp /sdcard/lasma-backup/shared.env   shared/.env
cp /sdcard/lasma-backup/telegram.env telegram/.env
cp /sdcard/lasma-backup/creds.json        shared/hi-hive/
cp /sdcard/lasma-backup/legacy-creds.json shared/hi-hive/legacy/creds.json
cp /sdcard/lasma-backup/serviceAccountKey.json whatsapp/

cp -r /sdcard/lasma-backup/auth_info_baileys whatsapp/

cp /sdcard/lasma-backup/emoji.jsonl shared/assets/data/
cp /sdcard/lasma-backup/dict.dat shared/assets/dict/
cp /sdcard/lasma-backup/dict.idx shared/assets/dict/
```

Then point `PGHOST` at the local server. Postgres is inside this proot now, so
if the old `shared/.env` had it pointing anywhere else, fix it:

```bash
nano shared/.env
```

```
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=lasma
PGPASSWORD=choose-a-password
PGDATABASE=lasma_bot
```

**Starting without a backup?** Write `shared/.env` by hand with these keys:

```
AI_API_KEY=            GROQ_API_KEY=         CEREBRAS_API_KEY=
OPENROUTER_API_KEY=    OPEN_WEATHER_API_KEY= VERCEL_WEBHOOK_URL=
ATTENDANCE_QR_SCAN_API_DOMAIN=  ATTENDANCE_ENDPOINT=
UTAR_SCAN_URL=         UTAR_REPORT_URL=      SMART_SCHEDULE_SKIP=
AES_KEY=               AES_IV=               DEVICE_ID=
PGHOST=127.0.0.1       PGPORT=5432           PGUSER=lasma
PGPASSWORD=            PGDATABASE=lasma_bot
```

and `telegram/.env` with just `BOT_TOKEN=`. The WhatsApp bot needs no `.env` of
its own; everything it reads is shared.

## 9. Database schema

Restoring a dump gives you the schema and the data in one go:

```bash
psql -h 127.0.0.1 -U lasma -d lasma_bot < /sdcard/lasma-backup/lasma.sql
```

For a fresh database instead:

```bash
cd ~/bots/lasma-bot
bun run schema
```

It prints every table it created. Both bots also run `ensureSchema()` on boot,
so this is only needed to set the machine up before the first run.

## 10. Build the dictionary binaries

The C sources are in the repo; the binaries are platform-specific and are not.

```bash
cd ~/bots/lasma-bot/shared/assets/dict/src
gcc -O2 -o ../dict_lookup  dict_lookup.c
gcc -O2 -o ../dict_indexer dict_indexer.c
```

Check it against the data you restored:

```bash
cd ~/bots/lasma-bot
DICT_DIR=$PWD/shared/assets/dict ./shared/assets/dict/dict_lookup water | head -5
```

`dict_lookup` reads `DICT_DIR` from the environment and falls back to the
current directory, which is why that variable is on the front of the command.
The bot sets it for you.

**Rebuilding the index from scratch**, only if you have no `dict.dat`. This
downloads 1.2 GB, expands to 11 GB, and takes hours on a phone:

```bash
cd ~/bots/lasma-bot/shared/assets/dict
wget https://dumps.wikimedia.org/enwiktionary/latest/enwiktionary-latest-pages-articles.xml.bz2
bunzip2 enwiktionary-latest-pages-articles.xml.bz2
./dict_indexer enwiktionary-latest-pages-articles.xml
rm enwiktionary-latest-pages-articles.xml
```

## 11. The chess renderer (optional)

```bash
cd ~/bots/lasma-bot/telegram
bun run build:chess
```

It detects ARM64 and builds with `-O3 -mcpu=native` plus LTO, writing
`src/pixelforge/build/Release/App.node`. If it fails, `/chess` is simply
unavailable; the bot probes the addon in a child process at startup, notices,
and keeps running. Nothing else is affected.

## 12. Start them

```bash
cd ~/bots/lasma-bot

tmux new -d -s wa 'cd ~/bots/lasma-bot && bun run whatsapp'
tmux new -d -s tg 'cd ~/bots/lasma-bot && bun run telegram'
```

```bash
tmux attach -t wa     # watch the WhatsApp bot; detach again with Ctrl-B then D
tmux attach -t tg
tmux ls               # what is running
```

If you did not restore `auth_info_baileys`, attach to the `wa` session on the
first run: it prints a QR code that you scan from WhatsApp on the phone.

Keep Termux alive in the background with **Termux -> notification -> Acquire
wakelock**, and exclude it from Android battery optimisation. Without that,
Android kills both bots within minutes of the screen going off.

`bun run whatsapp` and `bun run telegram` run the bots without file watching.
Use `bun run dev:whatsapp` / `bun run dev:telegram` when you are editing code
and want a restart on save.

---

## Checklist

```bash
cd ~/bots/lasma-bot

pg_isready                                   # database up
bun run schema                               # tables present
bun run typecheck                            # both projects compile
.venv/bin/python -c "import gtts; print('py ok')"
ffmpeg -version | head -1
DICT_DIR=$PWD/shared/assets/dict ./shared/assets/dict/dict_lookup test | head -2
ls -la shared/assets/data/emoji.jsonl        # 60 MB
ls -la shared/assets/dict/dict.dat           # ~680 MB
```

## If something breaks

**`initdb` fails on locale.** Run the `locale-gen` block in step 3 first.

**`pg_isready` fails.** proot has no systemd. Start it by hand:
`su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data start"`

**`Postgres is unreachable` at boot.** The bot refuses to start rather than
half-running. Check `PGHOST` and `PGPASSWORD` in `shared/.env` match the role
you created in step 5.

**`bun install` fails on `sharp`.** `apt install -y libvips-dev` and retry.

**`/say` or `/removebg` fails.** The venv is missing a package. `resolvePython`
falls back to system `python3`, so either `pip install` into the venv or set
`PYTHON_BIN` to an interpreter that has them.

**`/chess` says the renderer is not built.** Step 11. Everything else keeps
working without it.

**Emoji or dict commands fail.** The large assets are missing. Step 8, or
rebuild per step 10. `/debug` reports which.

**Both bots die when the screen turns off.** Wakelock and battery optimisation,
step 12.
