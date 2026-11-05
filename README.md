# Burrow

Burrow is a local-first personal data OS. It runs on your own machine and keeps your budget and transactions, todos, calendar, habits, journal, notes, bookmarks, countdowns, focus sessions, health data and weather in one place, with a built-in AI assistant named Javi. Everything is stored in a single SQLite file in your data directory, and you can export it all in open formats at any time.

## Modules

- One menu: Home, then Budget (budget and subscriptions), Productivity (todos, notes, focus, countdowns, bookmarks and folders) and Health (journal, habits, sleep and activity), then Calendar. Settings is the gear; every page is also in search (Ctrl+K).
- Budget and transactions
- Todos (kanban columns, with a Work / Home / All filter)
- Calendar (import `.ics` files)
- Habits
- Journal
- Notes
- Bookmarks
- Countdowns
- Focus (in Journal)
- Health (Oura, opt-in)
- Weather (opt-in, shown in the Javi card on Home)
- Folders: pick a folder on your computer and Burrow lists its files, counts, sizes and duplicates, writes short summaries with Javi and exports the list (Markdown, JSON or CSV). It only reads the folders you choose. PDF and Word files show as Not supported yet; support for them is coming in a later version.
- Data browser (Settings > Data & storage)
- Export / import
- Javi, the AI assistant (the Javi card on Home, and the bar at the bottom right of the other pages except Settings: one quick insight about each page on Free; Pro adds follow-up questions, ask Javi about your data, actions and the daily briefing, shown in the Javi card), running on a local Ollama model (see [AI (Javi) setup](#ai-javi-setup))

## Privacy

- Your data stays on your device, in open formats: SQLite on disk, and JSON, CSV and Markdown in exports.
- No cloud, no telemetry, no accounts.
- Nothing calls the internet unless you turn it on. Each outbound feature is off by default and is switched on in Settings > Network (or pre-enabled with `BURROW_NETWORK_OPTIN`). Until then the API answers `403 network_opt_in_required`.

| Opt-in feature (id) | Hosts it calls | What is sent |
| --- | --- | --- |
| Weather (`weather`) | `api.open-meteo.com` | Your latitude and longitude |
| Oura Ring (`oura`) | `api.ouraring.com` | Your Oura token (to read sleep, readiness, activity, and to test a saved token) |
| Google Sheets import (`sheets`) | `docs.google.com`, `*.googleusercontent.com` | A request for a published Sheets CSV, only when you paste a link and click import |
| Ollama on another computer (`aiLan`) | The Ollama address you set in Settings > AI | Prompts and the data Javi reads |
| Cloud AI provider (`cloudAi`) | The endpoint you set in Settings > AI | Prompts and the data Javi reads |
| Update check (`updates`) | `github.com` (GitHub serves the files from `release-assets.githubusercontent.com` and `objects.githubusercontent.com`) and `api.github.com` (the check in a copy that cannot install updates by itself). Burrow Dev makes no update request | Nothing about you or your data. GitHub sees your IP address. When you turn it on or click Check now in Settings > Updates, Burrow reads `latest.json` (or GitHub's public releases list) of the public `ChristianMunoz31/burrow-releases` repo and shows a notice when a newer version exists. An update is downloaded and installed only when you click Download and install; a copy that cannot install by itself shows the installer's checksum and your browser downloads it. Burrow saves a backup of your data first and verifies the update with Burrow's updater signature before installing. Burrow Dev never checks or installs updates |

**AI.** Javi runs on a local Ollama server and nothing leaves your machine by default. AI traffic goes to loopback (`http://127.0.0.1:11434`) only. Pointing Burrow at an Ollama host on another machine needs the `aiLan` opt-in, and the optional OpenAI-compatible cloud endpoint needs the `cloudAi` opt-in. See [AI (Javi) setup](#ai-javi-setup).

## AI (Javi) setup

Burrow's AI, Javi, runs locally through [Ollama](https://ollama.com). Nothing leaves the machine by default, and there is no cloud provider unless you opt in.

1. Install Ollama from https://ollama.com/download.
2. Start it: open the Ollama app, or run `ollama serve`.
3. Pull the model that fits your computer's memory. The desktop app recommends the same ones on first run (`server/ai/recommend.js`):

   | Total RAM | Pull | Download |
   | --- | --- | --- |
   | Under 6 GB | `llama3.2:1b` | about 1.3 GB |
   | 6 GB to under 10 GB | `llama3.2:3b` | about 2.0 GB |
   | 10 GB to under 14.5 GB | `llama3.2:3b`, plus optional `qwen2.5:7b` (smarter, slower) | about 2.0 GB, optional 4.7 GB |
   | 14.5 GB or more | `qwen2.5:7b` (Javi's tools) and `llama3.2:3b` (fast chat) | about 4.7 GB and 2.0 GB |

   ```powershell
   ollama pull llama3.2:3b   # a good default for most computers
   ```
4. Open Settings > AI to check the status.

**Which model is used.** For each purpose Burrow picks, in order: a model chosen in Settings > AI, then `BURROW_AI_CHAT_MODEL` / `BURROW_AI_TOOL_MODEL`, then an automatic choice.

- Tools (Javi reading and changing your data): the largest installed model that supports tool calling, up to `BURROW_AI_AUTO_MAX_PARAMS_B` billion parameters (default 14).
- Chat (Javi page advice, briefing): a faster installed model that is smaller than the tool model and at least 2.5B parameters (`llama3.2:3b` when it is installed). If there is none, the tool model is used.
- Embedding-only models are never chosen. A tool model you pick in Settings must support tools.

**Settings > AI.** Shows whether Ollama is running, its version and the models in use, and lets you:

- pick the chat and tool models ("Default" means automatic);
- change the Ollama address under Advanced (the default is `http://127.0.0.1:11434`; a host set here wins over `OLLAMA_HOST`);
- configure the cloud provider (base URL, model, token parameter, API key) and switch to it, once the cloud opt-in is on.

**Speed.** Expect slow first responses on a CPU-only laptop. Loading the model cold and evaluating the first prompt can take a minute or two; after a few seconds without a first word the page advice stream sends a `status` event and Javi shows "Javi is warming up". `OLLAMA_KEEP_ALIVE` (default `10m`) keeps the model loaded between requests, so later answers are faster. Requests are queued one at a time by default; when the queue is full the API answers `429 ai_busy`.

**When AI is unavailable.** AI routes answer before streaming starts:

| Status | `error` | Meaning |
| --- | --- | --- |
| 503 | `ai_not_configured` | AI is turned off (`BURROW_AI=0`) or no suitable model is installed |
| 503 | `ollama_unavailable` | Ollama cannot be reached (or a remote host lacks the `aiLan` opt-in) |
| 503 | `ai_warming_up` | Ollama is busy loading the model and did not answer in time. Wait a minute and try again |
| 429 | `ai_busy` | The AI queue is full or the wait timed out |

The status endpoint (`/api/jarvis/status`) reports `available`, `provider`, `model` and, when unavailable, a `reason` code: `ai_disabled`, `no_model`, `no_tool_model`, `network_opt_in_required` or `ollama_unavailable`.

### AI environment variables

All optional. Set in `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BURROW_AI` | `1` | Set to `0` to turn off every AI feature |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama address. No scheme means `http://` with port 11434; `0.0.0.0` means this machine. A host on another machine needs the `aiLan` opt-in |
| `OLLAMA_NUM_CTX` | `8192` | Context window sent to Ollama, capped at the model's own limit |
| `OLLAMA_KEEP_ALIVE` | `10m` | How long Ollama keeps the model loaded after a request |
| `BURROW_AI_CHAT_MODEL` | automatic | Chat model override (a choice saved in Settings > AI wins) |
| `BURROW_AI_TOOL_MODEL` | automatic | Tool model override (a choice saved in Settings > AI wins) |
| `BURROW_AI_AUTO_MAX_PARAMS_B` | `14` | Largest model, in billions of parameters, the automatic choice may pick |
| `BURROW_AI_FIRST_TOKEN_TIMEOUT_MS` | `300000` | Time to wait for the first token once a call starts. The timer starts when the call gets its turn in the queue |
| `BURROW_AI_TOTAL_TIMEOUT_MIN` | `5` | Maximum minutes for one model call |
| `BURROW_AI_CONCURRENCY` | `1` | Model calls running at once |
| `BURROW_AI_QUEUE_MAX` | `8` | Calls allowed to wait for a slot; more are refused with `429 ai_busy` |
| `BURROW_AI_QUEUE_TIMEOUT_MS` | `300000` | How long a call may wait in the queue before `429 ai_busy` |
| `BURROW_AI_HEALTH_TTL_MS` | `5000` | How long a successful Ollama health check is cached (a failed one is cached for 2000 ms) |
| `JARVIS_ROUND_TIMEOUT_MS` | `300000` | Time limit for each model round in the Jarvis tool loop |
| `JARVIS_MAX_ROUNDS` | `5` | Maximum tool-loop rounds per Jarvis request |
| `JARVIS_WRITE_CAP` | `3` | Maximum writes per Jarvis request |
| `JARVIS_TOOL_TIMEOUT_MS` | `12000` | Time limit for one tool call |
| `JARVIS_CONFIRM_WRITES` | `1` | Set to `0` to let Jarvis make changes without asking first |
| `AI_CLOUD_API_KEY` | none | API key for the optional OpenAI-compatible cloud provider (prefer saving it in Settings) |

### AI privacy

- Default AI traffic is loopback only (`127.0.0.1`). Nothing is contacted at startup; Ollama is probed lazily when an AI feature or Settings > AI needs it.
- A non-loopback Ollama host is refused until you turn on the "Ollama on another computer" switch in Settings > Network (`aiLan`). This is checked on every request, including a host set by `OLLAMA_HOST`.
- The OpenAI-compatible cloud endpoint is used only when you choose it in Settings > AI, save a base URL, model and key, and turn on "Use a cloud AI provider (sends data off your computer)" in Settings > Network (`cloudAi`). A non-loopback cloud base URL must be `https://`. If the cloud setup is incomplete or the opt-in is off, Burrow uses local Ollama, never the other way round.
- Jarvis writes (todos, notes, journal entries, habit completions, countdowns) wait for your confirmation. A confirmation token is single-use, kept in memory, expires after 10 minutes and is bound to its conversation. Set `JARVIS_CONFIRM_WRITES=0` to turn this off.
- The audit log records every AI request: feature, provider, model and redacted context.
- Model output is cleaned before display (dashes removed, dollar amounts formatted), including while streaming.
- **LAN mode.** The Ollama host override accepts any loopback port, so in LAN mode (a non-loopback `BURROW_HOST` with sign-in) an authenticated user can point Burrow at other services on this machine's loopback. Keep LAN access to trusted users.
- **Ollama's own listener.** Burrow only ever connects to Ollama over loopback by default, but the Ollama server decides where it listens. If `ollama serve` was started with `OLLAMA_HOST=0.0.0.0`, Ollama itself is reachable from your LAN. To keep it local, set the `OLLAMA_HOST` environment variable to `127.0.0.1` for the Ollama app or service and restart it.

### AI eval

```powershell
node pro/scripts/evalAi.js [--models qwen2.5:7b,qwen2.5:3b] [--out results.json] [--only id1,id2]
```

This script is part of the private Pro module (`pro/`), so it only exists in a checkout that has it. It runs a fixed set of Javi prompts against a real local Ollama with synthetic seed data in a throwaway data directory, checks each answer programmatically, and prints a pass table per model. It never pulls models, always exits 0, and is not part of `npm test` (tests mock Ollama). It uses longer timeouts than the app unless you set them.

## Desktop app

Burrow also ships as a one-click desktop app (Tauri) for people who do not use a terminal. It bundles the server and the UI, so there is nothing to install besides the app. Install steps, first-run setup and troubleshooting for end users are in [docs/INSTALL.md](docs/INSTALL.md). Builds are unsigned for now.

For developers, you need Rust (stable) and your platform's webview dependencies (see [CONTRIBUTING.md](CONTRIBUTING.md#desktop-app)):

```powershell
npm run desktop:dev     # runs the shell against a temp data dir, never your real data
npm run desktop:build   # web UI, sidecar, then the installer
```

How the shell and the server talk to each other is in [src-tauri/README.md](src-tauri/README.md).

## Requirements

Node.js `^22.13.0 || >=23.4.0` (Burrow uses the built-in `node:sqlite`).

## Quickstart (development)

```powershell
npm ci
npm start      # API server on http://127.0.0.1:4321
npm run dev    # Vite dev server on http://localhost:5174 (in a second terminal)
```

Open http://localhost:5174. The Vite dev server uses port 5174 with `strictPort`, so it must be free. Run `npm start` and `npm run dev` in separate terminals; `/api` calls from the dev UI are proxied to `http://127.0.0.1:4321`.

## Production-style (single process)

```powershell
npm run build
npm start
```

When `dist/` exists, the server serves the built UI itself, so Burrow runs as one process at http://127.0.0.1:4321.

## Configuration

Copy `.env.example` to `.env`. Every value is optional.

| Variable | Purpose | Default |
| --- | --- | --- |
| `BURROW_HOST` | Interface to listen on | `127.0.0.1` |
| `BURROW_PORT` | Port to listen on | `4321` |
| `BURROW_DATA_DIR` | Where `burrow.db` and `secrets.key` live | Per-OS folder, see below |
| `BURROW_NETWORK_OPTIN` | Comma-separated features to pre-enable: `weather`, `oura`, `sheets`, `cloudAi`, `aiLan`, `updates` | none (all off) |
| `BURROW_TRUST_PROXY` | Set to `1` only behind exactly one reverse proxy | off |
| `BURROW_SCHEDULER` | Set to `0` to disable the daily scheduler | on |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed cross-origin | localhost / 127.0.0.1 on the Burrow port and 5174 |
| `BURROW_ALLOWED_HOSTS` | Comma-separated `host[:port]` names accepted in the `Host` header, for example `burrow.lan,nas.local:4321` | loopback names only |
| `BURROW_ALLOW_INSECURE_LAN` | Set to `1` to allow a non-loopback bind without sign-in (not recommended) | off |
| `APP_PASSWORD`, `AUTH_SECRET` | Set both to require a password (signed 30-day session cookie). `AUTH_SECRET` must be at least 32 characters | off |
| `SECRETS_ENCRYPTION_KEY` | 32-byte base64 key that encrypts API keys saved in Settings; overrides the auto-created key file | unset (key file is used) |
| AI variables (`BURROW_AI`, `OLLAMA_HOST`, `JARVIS_*`, ...) | Local AI settings | See [AI environment variables](#ai-environment-variables) |
| `OURA_TOKEN` | Oura personal token (needs the Oura opt-in) | none |
| `WEATHER_LAT`, `WEATHER_LON` | Weather coordinates (needs the Weather opt-in) | none |

Generate an `AUTH_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Storage

Burrow stores everything in `burrow.db`, a SQLite database opened with Node's built-in `node:sqlite` in WAL mode. It is created in the data directory on first run.

Default data directory:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Burrow` |
| macOS | `~/Library/Application Support/Burrow` |
| Linux | `$XDG_DATA_HOME/burrow`, else `~/.local/share/burrow` |

Set `BURROW_DATA_DIR` to use a different folder.

- **Migrations.** The schema is created and upgraded automatically at startup from the SQL files in `server/db/migrations/`, tracked in a `schema_version` table. Before applying a migration to an existing database, Burrow writes a backup next to it (`burrow.db.pre-v<N>.bak`). A database created by a newer version of the app is refused.
- **Saved API keys.** Keys you save in Settings are encrypted. If `SECRETS_ENCRYPTION_KEY` is unset, Burrow creates a random key once as `secrets.key` in the data directory and reuses it. Back up `secrets.key` together with `burrow.db`: without the key, saved API keys cannot be decrypted. Exports never include secrets or the key file.

## Security

- Burrow binds to `127.0.0.1` by default. With no password set, the API is open to anyone who can reach the port.
- **Startup checks.** The server refuses to start if `APP_PASSWORD` is set and `AUTH_SECRET` is shorter than 32 characters. It also refuses to bind a non-loopback `BURROW_HOST` unless both `APP_PASSWORD` and `AUTH_SECRET` are set, or `BURROW_ALLOW_INSECURE_LAN=1` is set (a loud warning is logged). If you expose Burrow on a network, set a password and put it behind HTTPS.
- **Host allowlist.** As a defence against DNS rebinding, requests whose `Host` header is not allowed get `421`. Loopback names are always accepted; add any other name you use (a LAN name or reverse-proxy domain) to `BURROW_ALLOWED_HOSTS`.
- Without sign-in enabled, export and import accept only loopback clients.

## Scheduler

An in-process scheduler runs three daily jobs (`BURROW_SCHEDULER=0` disables all of them, for development and tests):

- The daily briefing at 07:00 local time, only when AI is enabled and a model is available. Otherwise it does nothing.
- An audit-log prune, shortly after startup and then daily.
- The automatic backup check (see Backups and restore): a backup when none was made in the last 24 hours, checked a minute after startup and then hourly. The in-app switch for automatic backups only affects this job; the briefing and the audit prune keep running.

## Backups and restore

Burrow backs up your data automatically. Backups never leave your computer.

- **Where:** the `backups` folder inside your data folder. Each backup is a copy of your data (`.db`), a JSON export of the same data (`.export.zip`) and a small details file (`.meta.json`). Backups are not part of an export.
- **When:** once a day while Burrow is running. If Burrow was closed, it catches up shortly after the next start. A day with no changes is skipped, so you do not collect identical copies. You can also click **Back up now** in Settings > Data & storage.
- **Checked:** every backup is checked right after it is made (integrity and a checksum). A backup that fails the check is marked as failed and never used for a restore.
- **How many are kept:** by default the newest backup of each of the last 7 days, 4 weeks and 6 months. You can change these numbers in Settings > Data & storage. The newest good backup is always kept.
- **Restore:** pick a backup from the list, or choose a backup file from your computer. Burrow first saves a **safety copy** of your current data (kept separately, newest three plus anything under 30 days old), then swaps in the restored data and reloads. If the restore is interrupted, for example by a crash or power cut, Burrow finishes it or puts your old data back the next time it starts.
- **If Burrow will not start after a restore:** Burrow prints "could not finish recovering an interrupted backup restore" and exits (exit code 3). Your previous data is in `restore-aside/burrow.db` inside your data folder and safety copies are in `backups`. First close programs that may be using these files (antivirus, sync tools) and start Burrow again. If it still refuses, fix it by hand: close Burrow, move `restore-aside/burrow.db` to `burrow.db` in your data folder (replace or move aside any `burrow.db` there, and move `burrow.db-wal` and `burrow.db-shm` from `restore-aside` too if present), delete `restore-journal.json`, then start Burrow.
- **Settings and keys:** Restoring keeps your current privacy, network and AI settings, your automatic backups switch and the keys saved on this computer. Saved keys are not included in backups for your safety. Re-enter them after moving to a new computer.
- **Older backups:** a backup from an older version of Burrow is upgraded while restoring. A backup from a newer version is refused with a message to update Burrow.
- **Turning it off:** use the **Automatic backups** switch in Settings > Data & storage (on by default). Turning it off asks you to confirm, because a problem with your computer could then lose your data, and Home reminds you at most once a week while it stays off and your newest backup is 7 or more days old. For development and tests, `BURROW_SCHEDULER=0` turns off the automatic daily backup together with the other scheduled jobs. Manual backup and restore always work, with the switch on or off.

The upgrade safety copy (`burrow.db.pre-vN.bak`) that Burrow writes before a schema change is separate and is not touched by any of this.

## Erase all my data

Settings > Data & storage > Danger zone > **Erase all my data** permanently deletes everything you saved in Burrow on this computer and returns Burrow to first-run. It asks you to type `ERASE`, then to confirm a list of what goes and what stays. It saves a final export first (on by default). Your license and Pro trial status are kept; the license is removed only if you tick **Also remove my license from this computer**, and your backups stay unless you tick **Also delete all backups on this computer**. It also deletes the upgrade safety copies (`burrow.db.pre-vN.bak`) and any unfinished or temporary files in the backups folder (your finished backups stay). Saved API keys are deleted; the license key and the local key file that protects the Pro trial record are kept. Under the hood: `POST /api/data/erase/request` returns a single-use token that lasts 2 minutes, then `POST /api/data/erase` needs the token, `{ "phrase": "ERASE" }` and, when a web sign-in password is set, `{ "password" }`; it only accepts a request that comes from Burrow's own window (same origin), allows 3 tries per 15 minutes and never answers a GET. The data is deleted in one transaction with secure delete on, then the file is compacted so freed space holds no old text.

## Export and import

**Export.** Settings > Data & storage exports one ZIP (`POST /api/export`) containing:

- `manifest.json` (`format: burrow-export`, `formatVersion: 2`, table list, row counts, whether the export is complete)
- `json/<table>.json` and `csv/<table>.csv`, one pair per table
- `markdown/journal/` and `markdown/notes/`, one Markdown file per journal entry and note

Saved API keys and the audit log are never exported, and sensitive settings values are replaced with `[redacted]`. Notes, journal and chat content is exported as-is.

**Import.** Restoring is idempotent: rows are upserted by primary key, existing rows with the same key are overwritten, and nothing is deleted. The whole archive is applied in one transaction. Rows that reference a missing parent, or that contain `[redacted]` settings values, are skipped. Current (`formatVersion: 2`) and legacy `formatVersion: 1` exports are accepted.

- **Settings > Data & storage > Import data:** choose a ZIP, review the result, then import.
- **CLI:**

  ```powershell
  npm run import -- [--dry-run] [--json] <export.zip>
  ```

  `--dry-run` reports what would change and writes nothing; `--json` prints machine-readable results. Exit code is 0 on success, 1 on failure, 2 on bad usage. The CLI uses the data directory from `BURROW_DATA_DIR` (or the default).
- **API:** `POST /api/import` with the raw ZIP as the body (`Content-Type: application/zip`, up to 16 MB). Add `?dryRun=1` to preview without writing. Without sign-in enabled, only loopback clients may call it.

## Source

The source of the Burrow core is public at https://github.com/ChristianMunoz31/burrow-core under AGPL-3.0-only. Pro features are a private module, so they are not part of that repository.

## Development

Contributing, the sandbox and branch previews, CI, releases and Docker are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

```powershell
npm test          # vitest (frontend in jsdom, backend in node)
npm run lint      # eslint
npm run build     # production build into dist/
```

Other scripts: `npm run test:watch`, `npm run preview`, `npm run eval:javi` (real-model speed and accuracy eval, needs Ollama).

Pro features (Javi's tools, briefings, Explain and the Folders question and report features) ship in a private module that sits next to the core as `pro/`. A checkout without it builds and runs as a Free build. Developers: the module boundary is described in [docs/OPEN_CORE.md](docs/OPEN_CORE.md).

Layout:

- `server.js` - Express app: host guard, auth gate, rate limits, routes, static UI
- `server/` - backend modules (config, hostGuard, paths, netPolicy, ai/, scheduler, export, import, secrets, audit, javi/, folders/, db/)
- `server/db/` - embedded SQLite layer and migrations
- `scripts/import.js` - CLI importer
- `src/` - React app (`pages/`, `components/`, `hooks/`, `services/`, `utils/`)
- `public/` - static assets

## Roadmap

- Docker packaging
- Desktop app
- Paid tier (AI features and device sync); Burrow is open-core: the core is open source and Pro features are a private module (see [docs/OPEN_CORE.md](docs/OPEN_CORE.md))

## License

The Burrow core is licensed under AGPL-3.0-only. See [LICENSE](LICENSE). Pro features are a private module and are not covered by that license.
