# Codex Remote

English | [中文](README.zh-CN.md)

Codex Remote is a single-user, self-hosted PWA for driving the Codex CLI on a remote Linux or macOS host
from a phone or computer. Messages are edited locally in the browser and cross the network only when sent
in full, so typing is not slowed down by per-keystroke SSH latency.

The backend is a thin adapter: the browser speaks Codex Remote's own restricted WebSocket protocol, and the
Node.js service drives `codex app-server` over stdio/JSONL. The browser can neither connect to the App
Server directly nor submit an arbitrary working directory.

> This project is not an official OpenAI product, and it is not a multi-user account system. It assumes the
> person who deploys it is the only trusted user. Do not offer an instance to strangers as a public sign-up
> service.

## Features

- Pick a project from the configured project roots;
- List only sessions created by Codex Remote, with search, new, resume, archive and delete;
- Stream replies, command status and approval requests;
- Keep new messages, approvals and user-input requests of the current session in sync across phone and computer;
- Messages are persisted and confirmed by the backend, keep running after the page closes, and use
  `clientMessageId` to avoid duplicates when a send is retried after a disconnect;
- Pick several screenshots or ordinary files on a phone or computer, drag files onto the composer,
  or paste files and screenshots into the message box; they are uploaded to the host's shared
  upload service first and sent along once the message is confirmed. The backend gives Codex the real
  attachment paths, and Codex reads them with its available tools as the user asks; the page never shows
  storage paths;
- Each active session uses its own App Server worker; one project still runs only one task at a time;
- A worker exits as soon as its queue is done and releases the session's writer, independent of browser connections;
- With ordinary permissions, a turn waiting for approval is cancelled after 10 seconds with no one online;
  with full access, execution approvals can still be handled;
- Long sessions load page by page, and completed messages render a safe subset of Markdown;
- After signing in, view Markdown and images inside the project roots; there is no source viewing, download
  or directory browsing;
- Slash commands for compact, rename and rewind; model and permissions live in dropdowns next to the
  composer, and usage sits in a bar at the top;
- Interface in Chinese or English, following the browser by default; the choice is kept in the browser;
- Installable as a PWA; when online, an ordinary refresh loads a new version of the shell.

Not implemented yet: diff display, multi-user accounts, arbitrary path access, exposing the App Server
directly to the network, running Codex and Claude Code in the same project at the same time.

## Data path

```text
Phone or computer browser
  -> HTTPS entry point (Tailscale Serve or a public reverse proxy)
  -> Codex Remote on 127.0.0.1:<CODEX_REMOTE_PORT>
  -> shared upload service on a Unix socket (attachment paths)
  -> backend queue and SQLite event log
  -> one stdio / JSONL codex app-server worker per active session
```

The application always listens on `127.0.0.1` only. Tailscale and public HTTPS are two ways to deploy an
entry point, not two code bases.

## Requirements

- A Linux or macOS host;
- Node.js 24 or later;
- npm;
- The Codex CLI, installed and signed in;
- `codex app-server --stdio` available;
- For attachments, the separate [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload)
  service running under the same Unix account as this service.

Run the long-lived service as a non-root Unix user that has Codex installed and signed in and can access the
allowed projects. You can use an existing user or prepare a dedicated one; the repository assumes no fixed
account, HOME or install path.

The Codex CLI version the project last verified in full, the type output directory, and the choice of
experimental surface are recorded only in [`codex-protocol.json`](codex-protocol.json). This is maintenance
information for the project and does not restrict which Codex CLI version users install or run. Some session
settings in the App Server are still experimental; when maintainers confirm a new version, they regenerate
and verify through the entry points below, then update the verified version.

Official Codex App Server documentation: https://developers.openai.com/codex/app-server

## Quick start

These commands are for a local trial run; they do not amount to a finished remote HTTPS and long-lived
service deployment.

Install dependencies:

```bash
npm ci
```

Create the project allowlist:

```bash
cp config/projects.example.json config/projects.json
```

Edit `config/projects.json` and set `path` to a real absolute path. Ordinary folders directly below each
root become selectable projects on the page. Every root ID, and every root after `realpath` resolution, must
be unique; when different roots contain projects with the same name, the page tells them apart by the public
root ID and never shows host paths:

```json
{
  "roots": [
    {
      "id": "projects",
      "path": "/srv/projects"
    }
  ]
}
```

Generate an access token:

```bash
openssl rand -hex 32
```

For attachments, start the separate upload service as described in
[`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload) first, then start Codex Remote:

```bash
CODEX_REMOTE_TOKEN="paste the token you just generated" \
CODEX_REMOTE_PROJECTS_CONFIG="$PWD/config/projects.json" \
npm start
```

Local health check:

```bash
curl http://127.0.0.1:3000/healthz
```

`3000` is the local development default. A real deployment should set the loopback port explicitly; the
HTTPS entry port is chosen separately by Tailscale Serve or another reverse proxy, and the two need not match.

Then choose an HTTPS entry point; both are described in [`docs/deployment.md`](docs/deployment.md):

- Tailscale Serve (section 4a): devices must join the tailnet; recommended by default;
- Public HTTPS (section 4b): reachable from any browser, at the cost of a larger public attack surface.

For running as a service on Linux / macOS, updates and logs, see [Operations](docs/operations.md); for
several hosts, see section 6 of `docs/deployment.md`.

## Permission defaults

Codex Remote does not override Codex's default permission configuration. When a session is created or
resumed, permissions come from the Codex configuration on the host; after signing in, the permission
dropdown next to the composer shows and switches the permission profiles the App Server offers.

Whether the current session has full access is decided by the sandbox policy the App Server reports, not
inferred from the profile name. Turning full access off switches to an available restricted profile; if the
host has no restricted profile at all, Remote reports an error instead of pretending it is off.

Choosing full access widens the impact of a leaked token. Public deployments in particular should keep
restricted permissions and run Codex as a non-root Unix user with clear permission boundaries.

## Configuration

| Environment variable | Description |
| --- | --- |
| `CODEX_REMOTE_TOKEN` | Browser sign-in credential, at least 32 characters |
| `CODEX_REMOTE_PORT` | Loopback listening port; defaults to `3000` when unset; set it explicitly in a real deployment |
| `CODEX_REMOTE_ALLOWED_ORIGINS` | Extra allowed browser origins, comma separated; usually empty |
| `CODEX_REMOTE_PROJECTS_CONFIG` | Project roots config file; defaults to `config/projects.json` |
| `CODEX_REMOTE_STATE_FILE` | Path of the trash registry |
| `CODEX_REMOTE_MARKS_FILE` | Path of pinned-session records; defaults to `marks.json` next to the trash file |
| `CODEX_REMOTE_SETTINGS_FILE` | Path of the app settings JSON; defaults to `settings.json` in the state directory |
| `CODEX_REMOTE_WORK_STATE_FILE` | SQLite path for accepted tasks and the event log |
| `AI_REMOTE_UPLOAD_SOCKET` | Unix socket of the shared upload service; defaults to `~/.local/share/ai-remote/upload.sock` |
| `CODEX_REMOTE_MAX_WORKERS` | Maximum active workers; defaults to `2` |
| `CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB` | Conservative available-memory budget needed to start a worker; defaults to `1024` MiB. Readings mean the same on Linux and macOS, so one value fits both; `0` turns the pre-start guard off |
| `CODEX_REMOTE_OFFLINE_GRACE_MS` | Approval grace period after the last client goes offline; defaults to `10000` ms. An integer from `0` to `2147483647` (about 24.8 days); the service refuses to start when it is out of range |
| `CODEX_BIN` | Codex executable; found on `PATH` by default |

The real token and `config/projects.json` are ignored by Git. The repository keeps only example files.

Attachment contents are stored by the separate `ai-remote-upload` service. See that project's deployment
notes to install it; this repository only configures `AI_REMOTE_UPLOAD_SOCKET`.

## Data and browser storage

Codex still stores the native sessions and full history. To support background execution, Codex Remote also
keeps accepted messages, task states, redacted stream events and interruption reasons in the worker state
store; this log may contain conversation text, public attachment metadata and tool output, so protect it at
the same level as Codex session data. Attachment bytes are stored by the separate upload service and kept for
30 days by default. The trash registry is stored separately and kept for 30 days by default. Pin records live
in `marks.json` next to the trash file by default. App settings (additional developer instructions and
new-session defaults) live in `settings.json` in the same private state directory; the backend writes them,
and they stay out of the repository. An empty string adds no user content. `attachment-index/`, next to the
worker state store, keeps original attachment names and real local paths for restoring the page display; it
holds no attachment bytes but is still sensitive state to protect and back up.

At sign-in the browser hands the access token to the HTTP sign-in endpoint and afterwards keeps only the
`HttpOnly` signed cookie the service issues; the token itself is never written to browser storage. The cookie
does not depend on an in-memory session table, so it stays valid across service restarts; changing the
server token invalidates every old cookie at once.

Appearance, interface language and display time zone are kept only in the browser and are not sent to the
server.

For the full trust boundaries, see [Architecture](docs/architecture.md) and the [Security policy](SECURITY.md).

## Development and checks

```bash
npm run typecheck
npm test
npm run codex:types
npm run codex:protocol
```

`npm run codex:types` uses the currently installed Codex CLI to regenerate, in an isolated `CODEX_HOME` and
with the experimental choice recorded in the manifest, the `src/generated/` that the application actually
imports, and compares it byte for byte. The current output includes the generator's full experimental
surface, matching the `experimentalApi: true` the runtime sets for the methods it has adopted; they remain two
separate boundaries. `npm run codex:protocol` connects to the real App Server of the installed version and
only performs the experimental initialize and read-only protocol queries; it creates no thread and calls no
model. Together with `npm run typecheck && npm test`, these two form the model-free protocol upgrade check.

End-to-end checks that create real sessions and call a model (currently `npm run smoke:attachments`) are not
unit tests. Run them only when a test instance, the attachment service, the project config and the Codex
sign-in are ready and model calls are explicitly allowed. `npm run smoke:server` starts a temporary web
backend and reads the real project and session directories, so it is not part of ordinary unit tests either.

`src/generated/` is the generator's complete output; do not trim or edit it by hand. Upgrade steps, `--write`
usage and the diff review checklist are in
[Operations](docs/operations.md#codex-cli-and-app-server-protocol-upgrades). Type checks and fake-transport
unit tests do not replace the real App Server protocol check.

## License and trademarks

The code is released under the [Apache License 2.0](LICENSE). Copyright (c) 2026 lizzyhague.

The project name "Codex Remote", the logo and other brand assets are **not** covered by the Apache License 2.0;
the copyright holder reserves all rights to them (see section 6 of the license: it grants no trademark
rights). You are free to use, modify and redistribute the code, but please give derived versions your own
name and marks.

This project is not an official OpenAI product, is not affiliated with OpenAI, and is not endorsed or
sponsored by it. "OpenAI", "Codex" and other trademarks belong to their respective owners and are used here
only to describe what this software connects to.

See [NOTICE](NOTICE) for other notices.
