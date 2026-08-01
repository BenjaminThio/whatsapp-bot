# Rebuilding Lasma on a fresh Termux

The bots run **inside the Ubuntu proot**. The database runs **natively in
Termux**, and they talk over `127.0.0.1`.

That split is not a preference, it is a requirement. Postgres cannot be
initialised inside proot-distro: `/dev/shm` there is a bind to an ordinary
directory rather than a tmpfs, because proot cannot mount one, and the POSIX
shared-memory calls Postgres makes block forever on it - `initdb` hangs at
`selecting default shared_buffers` and never returns. Run natively in Termux it
skips proot's syscall emulation entirely.

Nothing is mounted across. The proot shares Termux's network namespace, so
`127.0.0.1:5432` reaches the Termux server from inside Ubuntu with no links or
bind mounts to keep straight.

Step 0 runs in your current install. After that, take **the fast path** just
below, or work through the manual steps it automates.

---

## 0. Before you wipe anything

Pull these off the phone first. They are not in the repo and cannot be
regenerated.

```bash
mkdir -p /sdcard/lasma-backup

# Database dump
pg_dump -h 127.0.0.1 -U postgres lasma_bot > /sdcard/lasma-backup/lasma.sql

# WhatsApp pairing state. Without it you re-scan the QR from the phone.
cp -r ~/lasma-bot/whatsapp/auth_info_baileys /sdcard/lasma-backup/

# Secrets
cp ~/lasma-bot/shared/.env               /sdcard/lasma-backup/shared.env
cp ~/lasma-bot/telegram/.env             /sdcard/lasma-backup/telegram.env
cp ~/lasma-bot/shared/hi-hive/creds.json /sdcard/lasma-backup/
cp ~/lasma-bot/shared/hi-hive/legacy/creds.json /sdcard/lasma-backup/legacy-creds.json
cp ~/lasma-bot/whatsapp/serviceAccountKey.json  /sdcard/lasma-backup/

# Large assets - 740 MB total, and the dict takes hours to rebuild
cp ~/lasma-bot/shared/assets/data/emoji.jsonl /sdcard/lasma-backup/
cp ~/lasma-bot/shared/assets/dict/dict.dat    /sdcard/lasma-backup/
cp ~/lasma-bot/shared/assets/dict/dict.idx    /sdcard/lasma-backup/
```

Copy `/sdcard/lasma-backup` to a computer as well. `/sdcard` survives a Termux
reinstall, but not a factory reset.

You need roughly **3 GB free** for the finished install: 740 MB of assets,
350 MB of `node_modules`, ~1 GB for Ubuntu and the toolchain, plus the venv.

---

## The fast path

This is the sequence as actually run on a phone, not a guess. Each block says
which prompt it belongs at - that distinction matters more than anything else
here.

### Termux

```bash
pkg update -y && pkg install -y proot-distro git tmux postgresql && termux-setup-storage
```

```bash
proot-distro install ubuntu && proot-distro login ubuntu -- bash -c 'cd ~ && git clone <your-repo-url> lasma-bot'
```

Resolve the Ubuntu filesystem path once - proot-distro moved it between
versions, so do not hardcode it:

```bash
export UB=$(ls -d $PREFIX/var/lib/proot-distro/containers/ubuntu/rootfs $PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu 2>/dev/null | head -1); echo "$UB"
```

Start the database. It runs **here in Termux**, natively - it cannot run in the
proot at all:

```bash
bash $UB/root/lasma-bot/scripts/termux-postgres.sh
```

It asks for a password for the `postgres` role. Write it down; the next step
asks again.

### Ubuntu

```bash
proot-distro login ubuntu
```

```bash
cd ~/lasma-bot && bash scripts/setup.sh
```

Twelve steps: packages, locale, Bun, the database connection, dependencies, the
venv, backup restore, schema, dict index, emoji dataset, chess addon, verify. It
asks for your secrets if `shared/.env` is missing and no backup supplied it.

Safe to re-run. On failure it names the step, and you re-run just that one with
`--only <n>`.

```bash
exit
```

### Termux again

```bash
bash $UB/root/lasma-bot/scripts/termux-install.sh && source ~/.bashrc
```

```bash
w
```

`w` is the WhatsApp bot, `t` is Telegram. Detach with Ctrl-B then D.

### Things that will confuse you otherwise

**`w` and `t` belong at the Termux prompt, not inside Ubuntu.** Inside Ubuntu,
`w` is the stock procps utility that lists logged-in users - you will get a load
average instead of a bot. That is the design working: tmux runs in Termux and
each session enters the proot itself, so the bots survive logging out of Ubuntu.

**After pulling script changes, restart the supervisor.** A running bash script
does not reload when the file changes:

```bash
w stop && w
```

**To update the project from Termux** without logging in:

```bash
proot-distro login ubuntu -- bash -c 'cd ~/lasma-bot && git pull'
```

**Acquire the Termux wakelock** from its notification, and exclude Termux from
Android battery optimisation. Without it Android kills both bots minutes after
the screen sleeps, supervisor included, and nothing else you do matters.

### Secrets, without nano

```bash
bash ~/lasma-bot/scripts/configure-env.sh
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

The Postgres block must match what `termux-postgres.sh` created: host
`127.0.0.1`, role `postgres`, database `lasma_bot`, and the password you gave
it. If the project was already cloned when you ran it, it wrote those values
into `shared/.env` for you and you can press Enter through them.

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
  postgresql-client \
  libvips-dev
```

Only the Postgres *client* goes in here - `psql` and `pg_dump`, to reach the
Termux server. Installing the server package in the proot is what leads to the
`initdb` hang.

Generate a locale anyway; some tooling expects one.

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
| `postgresql-client` | `psql`/`pg_dump` to reach the Termux server. The server itself is NOT installed here |
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

## 5. Postgres, in Termux

**This step runs in Termux, not in Ubuntu.** The server cannot run inside the
proot at all - see the note at the top.

```bash
bash $UB/root/lasma-bot/scripts/termux-postgres.sh
```

That does all of the following, and is safe to re-run:

```bash
pkg install -y postgresql
initdb -D $PREFIX/var/lib/postgresql --encoding=UTF8 --locale=C.UTF-8
pg_ctl -D $PREFIX/var/lib/postgresql -l $PREFIX/var/lib/postgresql/server.log start
createuser -s postgres          # the bootstrap superuser is your Termux user
createdb -O postgres lasma_bot
```

The encoding is set explicitly. Left to the ambient locale it comes out
`SQL_ASCII`, which stores bytes with no validation - fine until the first emoji
or accented name meets `upper()`, `ILIKE` or `ORDER BY`, and it cannot be
changed without rebuilding the cluster.

Day to day:

```bash
pg status      # or: termux-postgres.sh status
pg start
pg stop
```

Termux has no init, so nothing starts it on boot - but `w` and `t` start it
for you before launching a bot, so in practice you rarely type `pg start`.

Check it from **inside Ubuntu**, which is the connection that actually matters:

```bash
pg_isready -h 127.0.0.1 -p 5432 && psql -h 127.0.0.1 -U postgres -d lasma_bot -c 'SHOW server_encoding;'
```

If that works, the network path across the proot boundary is fine and
`setup.sh` step 3 will pass.

**Locked out?** The local socket is left on trust auth so you can always
administer it from Termux. To reset the password, or to drop TCP back to no
password:

```bash
termux-postgres.sh --password 'newpassword'
termux-postgres.sh --trust
```

## 6. The project

```bash
cd ~
git clone <your-repo-url> lasma-bot
cd lasma-bot
bun install
```

One `bun install` at the root installs all three workspaces into a single
hoisted `node_modules`. Do not run it inside `telegram/` or `whatsapp/`.

## 7. Python environment

One venv at the workspace root, shared by both bots.

```bash
cd ~/lasma-bot
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

`rembg` pulls in onnxruntime, which is large and slow on ARM and sometimes has
no wheel at all. If it fails, drop that one line from `requirements.txt` and
reinstall. Only `/removebg` stops working; every other engine is fine.

## 8. Restore the backup

```bash
cd ~/lasma-bot

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
psql -h 127.0.0.1 -U postgres -d lasma_bot < /sdcard/lasma-backup/lasma.sql
```

For a fresh database instead:

```bash
cd ~/lasma-bot
bun run schema
```

It prints every table it created. Both bots also run `ensureSchema()` on boot,
so this is only needed to set the machine up before the first run.

## 10. Build the dictionary binaries

The C sources are in the repo; the binaries are platform-specific and are not.

```bash
cd ~/lasma-bot/shared/assets/dict/src
gcc -O2 -o ../dict_lookup  dict_lookup.c
gcc -O2 -o ../dict_indexer dict_indexer.c
```

Check it against the data you restored:

```bash
cd ~/lasma-bot
DICT_DIR=$PWD/shared/assets/dict ./shared/assets/dict/dict_lookup water | head -5
```

`dict_lookup` reads `DICT_DIR` from the environment and falls back to the
current directory, which is why that variable is on the front of the command.
The bot sets it for you.

**No `dict.dat`?** `setup.sh` builds it for you. There is nothing to do by
hand - step 9 notices it is missing and runs `scripts/build-dict.sh`, which
downloads the Wiktionary dump, expands it, indexes it, verifies the result with
a real lookup, and then **deletes everything it downloaded**.

Be aware of what that costs before you let it run: ~1.2 GB downloaded, ~11 GB
of temporary disk, and a few hours of indexing on phone hardware. Skip it with:

```bash
bash scripts/setup.sh --skip-dict
```

and `/dict` is simply unavailable until you build it later. Everything else
works.

To run it on its own, or to resume after an interruption:

```bash
bash scripts/build-dict.sh
```

It is safe to re-run at any point. The download uses `wget -c`, and each stage
is skipped when its output already exists, so an interrupted build continues
instead of starting over. Ctrl-C keeps the partial download on purpose.

```bash
bash scripts/build-dict.sh --force        # rebuild even though dict.dat exists
bash scripts/build-dict.sh --keep         # keep the XML afterwards
bash scripts/build-dict.sh --work /path   # stage the big files elsewhere
```

It stages into `/sdcard/lasma-work` by default, falling back to somewhere with
room, and refuses to start at all unless the space is actually there - so a
half-finished build cannot fill the phone. The XML is only deleted once
`dict_lookup water` has returned a real definition; if verification fails the
XML is kept so you can retry the indexing without downloading again.

**`emoji.jsonl` now ships in the repo**, so a clone already has it and step 10
does nothing. If you ever need to regenerate it:

```bash
bash scripts/build-emoji.sh --verify       # check what you have
bash scripts/build-emoji.sh --repair       # re-scrape incomplete entries
bash scripts/build-emoji.sh --force        # from scratch, with design history
bash scripts/build-emoji.sh --no-designs   # ~2 MB instead of ~60 MB, far faster
```

The design history is what costs: a real browser over 5,225 pages, many hours.
On ARM, Playwright often has no Chromium build at all, so `setup.sh` falls back
to `--no-designs` rather than leaving you with nothing. It resumes
automatically, and re-running never duplicates an entry.

`emoji.index.json` is a cache keyed on the dataset's size and mtime. Git does
not preserve mtimes, so a fresh clone always rebuilds it on first use - a few
seconds, once.

## 11. The chess renderer (optional)

```bash
cd ~/lasma-bot/telegram
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
bash $UB/root/lasma-bot/scripts/termux-install.sh
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
bash ~/lasma-bot/scripts/lasma.sh install && source ~/.bashrc
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
cd ~/lasma-bot
bun run whatsapp        # no watcher
bun run dev:whatsapp    # restarts on save
```

---

## Checklist

```bash
cd ~/lasma-bot

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

**`pg_isready` fails.** The server lives in Termux, not the proot. Exit to
Termux and run `pg start` (or `termux-postgres.sh start`).

**`initdb` hangs at "selecting default shared_buffers".** You are trying to run
it inside the proot. It will never finish there. Kill it with
`pkill -9 -f initdb` and use `termux-postgres.sh` from Termux instead.

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
