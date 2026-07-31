# Rebuilding Lasma on a fresh Termux

Everything, Postgres included, lives **inside the Ubuntu proot**. Nothing is
mounted across from Termux, so there is one filesystem, one set of paths, and no
`/data/data/com.termux/...` links to keep straight.

Step 0 runs in your current install. After that, take **the fast path** just
below, or work through the manual steps it automates.

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

## The fast path

Four commands, start to finish. Each is explained in the manual steps below if
you would rather see what it does.

**In Termux**, after reinstalling it:

```bash
pkg update -y && pkg install -y proot-distro git tmux && termux-setup-storage
```

```bash
proot-distro install ubuntu && proot-distro login ubuntu
```

**Inside Ubuntu**, clone the project and run the installer:

```bash
mkdir -p ~/bots && cd ~/bots && git clone <your-repo-url> lasma-bot && bash lasma-bot/scripts/setup.sh
```

`setup.sh` does the other eleven steps: packages, locale, Bun, the Postgres
cluster and role, dependencies, the venv, the backup restore, the schema, the
dict binaries, the chess addon, then a verification pass. If `shared/.env` is
missing and there is no backup it stops and asks you for each secret, so have
your keys to hand.

Every step checks whether it is already done, so it is safe to re-run. If
something fails it says which step, and you fix it and re-run just that one:

```bash
bash scripts/setup.sh --only 3
```

```bash
bash scripts/setup.sh --list      # what the steps are
bash scripts/setup.sh --from 6    # resume from step 6
```

**Back in Termux**, install the shortcuts so you never have to log into Ubuntu
by hand again:

```bash
bash $PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu/root/bots/lasma-bot/scripts/termux-install.sh && source ~/.bashrc
```

Then `w` starts the WhatsApp bot and `t` starts the Telegram one, from the
Termux prompt.

### Secrets, without nano

```bash
bash ~/bots/lasma-bot/scripts/configure-env.sh
```

It walks every key both bots read, one prompt at a time, with a description of
what each is for. It shows any value that is already set and keeps it if you
just press Enter, so re-running it to change one key is safe. Blank keys are
written commented out, and the feature that needs them degrades rather than
crashing. It writes `shared/.env` and `telegram/.env`, chmod 600, backing up
whatever was there as `.bak`.

```bash
scripts/configure-env.sh --show       # what is set, secrets masked
scripts/configure-env.sh --postgres   # only the database block
```

The Postgres block is asked first because `setup.sh` reads `PGPASSWORD` back
out of `shared/.env` and creates the database role with it. Choose the password
here and nothing else needs to know it.

---

## Manual steps

Everything below is what `setup.sh` automates. Read it if a step fails, or if
you would rather drive it yourself.

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
downloads 1.2 GB, expands to 11 GB, and takes hours on a phone.

Decompress as it downloads, so the 1.2 GB archive is never stored, and put the
XML on `/sdcard` where there is room:

```bash
wget -O - https://dumps.wikimedia.org/enwiktionary/latest/enwiktionary-latest-pages-articles.xml.bz2 \
  | bunzip2 > /sdcard/enwiktionary.xml
```

`dict_indexer` takes an output directory as its second argument, so the 11 GB
input can stay on `/sdcard` while the index is written straight into the dict
folder. Nothing large ever has to sit inside the proot:

```bash
cd ~/bots/lasma-bot/shared/assets/dict
./dict_indexer /sdcard/enwiktionary.xml ~/bots/lasma-bot/shared/assets/dict
rm /sdcard/enwiktionary.xml
```

If the download drops partway, `wget -c` cannot resume this because the stream
is being decompressed on the fly. To resume, download the `.bz2` to a file
instead (`wget -c -O /sdcard/ew.xml.bz2 <url>`), then `bunzip2` it separately.

## 11. The chess renderer (optional)

```bash
cd ~/bots/lasma-bot/telegram
bun run build:chess
```

It detects ARM64 and builds with `-O3 -mcpu=native` plus LTO, writing
`src/pixelforge/build/Release/App.node`. If it fails, `/chess` is simply
unavailable; the bot probes the addon in a child process at startup, notices,
and keeps running. Nothing else is affected.

## 12. The w and t shortcuts

Install them **from Termux**, not from inside Ubuntu, so you can start a bot
without logging into the proot first:

```bash
bash $PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu/root/bots/lasma-bot/scripts/termux-install.sh
source ~/.bashrc
```

From then on, straight from the Termux prompt:

```bash
w          # start the WhatsApp bot if it is down, then watch it
t          # the same for Telegram
lasma      # both
ub         # drop into an Ubuntu shell, when you want one
```

The tmux server runs **in Termux** and each session enters the proot on its
own. That ordering matters: it means the bots keep running when you exit
Ubuntu, and `w status` works from a plain Termux prompt without starting a
proot just to answer the question.

Inside Ubuntu the same commands are available, and manage the same bots, if you
install them there too:

```bash
bash ~/bots/lasma-bot/scripts/lasma.sh install && source ~/.bashrc
```

`lasma.sh` detects which side it is on and does the right thing either way.

Each bot runs under `scripts/supervise.sh` in its own tmux session, so it keeps
running when you close Termux and **restarts itself whenever it dies**.

| | |
| --- | --- |
| `w` | start if needed, then attach. Detach with Ctrl-B then D |
| `w status` | running or not, and since when |
| `w log` | follow the log, including across restarts |
| `w restart` | |
| `w stop` | stop it *and* stop the supervisor restarting it |
| `lasma start` | both, without attaching |
| `lasma status` | both |

`w stop` is the only way to bring a bot down for good. Killing the bot process
alone just makes the supervisor start it again, which is the point.

Postgres is started by the supervisor itself if it is down. proot has no
systemd, and a bot launched from Termux gets a non-interactive shell where the
`~/.bashrc` hook never fires, so this is the only reliable place to do it.

**How the restarting behaves.** A crash is retried after 5s, then 10, 20, 40,
up to a 5 minute ceiling, so a bot that cannot start (bad token, missing env
var) will not spin the CPU retrying. Once a bot has stayed up for a minute the
delay resets to 5s, so a genuine one-off fault is recovered from quickly. A
clean exit or a Ctrl-C is treated as deliberate and is not restarted. The
supervisor also waits for Postgres before each start, since the bots exit
immediately when the database is unreachable and would otherwise burn the whole
backoff ladder on a reboot.

Logs go to `logs/whatsapp.log` and `logs/telegram.log`, trimmed at 20 MB.

If you did not restore `auth_info_baileys`, run `w` on the first start: the QR
code appears in the attached session, and you scan it from WhatsApp.

Keep Termux alive in the background with **Termux -> notification -> Acquire
wakelock**, and exclude it from Android battery optimisation. Without that,
Android kills both bots within minutes of the screen going off, and no amount
of supervising helps because the supervisor gets killed too.

**Without the shortcuts**, or to run in the foreground while editing code:

```bash
cd ~/bots/lasma-bot
bun run whatsapp        # no watcher
bun run dev:whatsapp    # restarts on save
```

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
bash scripts/lasma.sh both status             # both bots
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
