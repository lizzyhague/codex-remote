# Operations

English | [中文](operations.zh-CN.md)

Replace every `3000` below with the actual `CODEX_REMOTE_PORT` from the environment file.

## Updates

Backend and frontend switch as one version: before it starts listening, the service reads the whole frontend,
and later changes in the working tree are not picked up by the running process; only a restart switches
everything. So you can pull and verify in the working tree of a running service, but restart only once the
checks pass. Update when no task is active:

```bash
previous=$(git rev-parse HEAD)
git pull --ff-only
npm ci --include=dev
npm run typecheck && npm test
```

If the checks fail, do not restart; first move the working tree back to the previous version, so a process
started unexpectedly does not load half-upgraded code:

```bash
git reset --hard "$previous"
npm ci --include=dev
```

Restart once the checks pass. Linux:

```bash
sudo systemctl restart codex-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

macOS: `sudo launchctl kickstart -k system/<your label>`, then the same health check.

When updating or stopping this service, do not also update, stop or restart `ai-remote-upload`. Backing up and
restoring attachment storage is covered by the separate upload service's operations notes.

When the upload service hangs, a single attachment upload fails after 30 seconds without any progress or 10
minutes in total, and the page reports that the shared upload service timed out. When this service stops,
uploads in flight are cancelled with a prompt to retry later and do not hold up the stop. The upload service's
raw error text goes only to this service's log; the page shows only this service's own explanation.

Node runs TypeScript directly; there is no build step. A restart drops browser connections: `running` and
`waiting_for_permission` are marked `interrupted`, `queued` tasks keep being scheduled, and tasks still starting at
shutdown that have not yet submitted their turn to Codex also stay `queued`.

## Codex CLI and App Server protocol upgrades

[`codex-protocol.json`](../codex-protocol.json) records the Codex CLI version the project last verified in full,
the output directory `src/generated/` that the application actually imports, and whether the generator includes
the full experimental surface. The version is a verified fact, not a runtime restriction: users may update the
Codex CLI themselves, and Codex Remote does not refuse to start or check the protocol because of a different
version. The current generation choice is true, matching the `experimentalApi: true` the runtime sets for the
methods it has adopted; they are still two switches, reviewed separately on each upgrade. Do not maintain another
copy of the verified version in the README, operations commands or generated files.

Upgrade in an isolated working tree or branch that the running service does not read:

1. Install the CLI to verify; if the candidate executable is not on the default `PATH`, point to it temporarily
   with `CODEX_BIN=/absolute/path/to/codex`. The entry points use the currently installed Codex CLI; do not
   downgrade the user's CLI just to pass a version check.
2. Run `npm run codex:types -- --write`. It records `codex --version`, then uses an empty temporary `CODEX_HOME`
   and passes `--experimental` according to the manifest's `experimental` value; it replaces `src/generated/`
   exactly, never writes to another directory that is not imported, and does not overwrite unknown changes
   already in that directory.
3. Review additions, removals and field changes with `git diff -- src/generated`. In particular, recheck the
   methods this project calls, the server request / notification unions, experimental methods, and whether host
   capabilities not adopted before have become reachable; do not trim the complete generated output by hand.
4. Run `npm run codex:types`, `npm run typecheck` and `npm test` again. The first regenerates in an isolated
   directory and compares byte for byte; the other two only verify the repository's types and the fake transport
   and cannot prove real protocol compatibility on their own.
5. Run `npm run codex:protocol`. It connects to the real App Server of the installed version, initializes with
   Remote's actual `experimentalApi`, and queries `model/list` and `permissionProfile/list`; it creates no thread,
   starts no turn and does not call a model.
6. Once all of the above pass, change the manifest's `verifiedCodexCliVersion` to the version just verified and
   commit it together with the reviewed `src/generated/`.

The end-to-end smoke test that calls a model (currently `npm run smoke:attachments`) is separate: run it only when
a test instance, the shared upload service, the project config and the sign-in are ready and real model calls are
explicitly allowed. It must not be slipped in with the model-free protocol checks above, and not running it must
not be reported as passing. After the protocol change is done, switch frontend and backend as one version through
the ordinary update procedure.

## Status and logs

Linux:

```bash
systemctl status codex-remote.service
journalctl -u codex-remote.service -n 100 --no-pager
journalctl -u codex-remote.service -f
```

macOS: see `codex-remote.log` and `codex-remote.error.log` in the runtime user's log directory.

When the directory App Server ends, the web backend exits on its own and is brought back by
`Restart=on-failure`. If start-up (initializing the directory App Server and the trash cleanup at start) does not
begin listening within two minutes, it also exits with a failure, logging "Startup was not ready after 120
seconds"; unfinished permanent deletions are continued at the next start. `SIGINT`/`SIGTERM` during start-up or
while running is a planned stop, and the exit code stays 0 even if the directory App Server is ended by the same
signal. A single session worker exiting abnormally only marks that task `failed` and affects neither the HTTP
service nor other workers. When the service restarts repeatedly, look at App Server / worker errors in the log
first rather than only at the web entry point.

## Sign-in

The browser hands the token to `/auth/login`, and the service issues an `HttpOnly`, `Secure`, `SameSite=Strict`
signed cookie shared by the WebSocket, attachment uploads and file viewing. The cookie does not depend on an
in-memory session table, so restarting the service does not sign devices out; changing `CODEX_REMOTE_TOKEN`
invalidates every old cookie at once.

## Project allowlist

`config/projects.json` is ignored by Git; the public repository has only the `.example`. Each entry configures a
project root, and the page lists the ordinary folders directly below it. Root IDs, and roots after `realpath`
resolution, must all be unique, or the service refuses to start; projects with the same name under different
roots show the root ID on the page to tell them apart. Restart the service after changing it.

Project roots limit the cwd the browser can choose, the sessions it can resume and the file viewing scope, but
which files Codex can finally touch also depends on the service account's permissions and the current Codex
permission profile.

## Viewing project files

A session can hand over `/view?path=<URL-encoded absolute path>` links. `/raw` reads only inside project roots
resolved with `realpath` at start-up and accepts only `.md` and common image extensions; relative paths,
directories, source files and symlink escapes all return 404, and there is no download or directory browsing. It
requires the sign-in cookie, and responses forbid caching and carry `nosniff` and a sandboxed CSP.

## Codex Remote auxiliary state and backups

This section covers only the auxiliary state Codex Remote keeps for the web page, queue, trash and attachment
display. Codex itself remains the authority for native threads and full history; the files below do not contain
those native threads, and this project does not completely back up or restore Codex native threads. Without an
official Codex guarantee and a verified restore procedure, do not describe copying its internal data directory as
a complete session backup. The project allowlist, service environment, sign-in credentials and the separate upload
service are not in the table either and must be restored from their own sources.

| Variable or path | Contents | Sensitivity |
| --- | --- | --- |
| `CODEX_REMOTE_STATE_FILE` | Trash registry: thread ID, project ID, deletion time, restore target, move / restore / permanent-delete stage | Low |
| `CODEX_REMOTE_MARKS_FILE` | Pinned-session records; defaults to `marks.json` next to the trash file | Low |
| `CODEX_REMOTE_SETTINGS_FILE` | App settings JSON: additional developer instructions, new-session default model, reasoning effort and permissions; defaults to `settings.json` next to the trash file | Medium; treat like user instructions |
| `CODEX_REMOTE_WORK_STATE_FILE` | Worker SQLite: accepted messages, task states, redacted events, tool output | High; treat like conversation data |
| `attachment-index/` in the worker state directory | Per-session attachment display index: attachment ID, original name and real local path | High; treat like local paths and attachment metadata |

After every write, the JSON files and the attachment index sync both the file and its directory, and the save
counts as done only when the sync succeeds; keep the state directory on a local file system that supports
directory `fsync`. When any step fails, the operation reports failure and leaves no temporary files; if the
deletion credential of a permanent delete was not saved, the Codex session is not deleted. Once the trash registry
contains a `trashing` or `restoring` stage, older versions that do not know these stages cannot read the file;
before rolling back, make sure the registry no longer contains them (successful start-up and daily cleanup move
them forward).

SQLite uses WAL, so do not copy only the main database file while the service runs and miss `-wal`. The reliable
way is to stop the service when no task is active and then copy. When backing up Remote's auxiliary state, keep the
JSON files in the table, the worker SQLite and the whole `attachment-index/` directory together. Attachment
contents are not in this repository's data directory; back up the separate upload service following its own
operations notes. After restoring, check file owners and permissions, the project allowlist and a compatible CLI
version in the environment before starting, then check the log and `/healthz`; this still restores only Remote's
auxiliary state and does not change the boundary for Codex native threads above.

## Adding frontend files

`public/` is not a directory listing but an allowlist. When adding or renaming a frontend file, register its URL,
file name and Content-Type in `STATIC_FILES` in `src/server/http-server.ts`, and check it returns 200 in
`http-server.test.ts`. The server generates `/assets/<hash>/` addresses for scripts and styles from their content
and stores them in `public/.web-assets/`; editing an existing file no longer needs an HTML version bump or a new
service worker cache name. Any frontend or backend change takes effect only after a restart.

The service manages `.web-assets/` itself: each start keeps the current version and the old versions of the last
two starts, deletes older ones automatically, and pages already open on an old version can still fetch assets
through the next two releases. Do not empty this directory by hand when deploying. The browser's offline cache
likewise keeps only the assets of the current offline page and the previous one.

Interface text lives in `public/strings.js`, with Chinese and English side by side for each key. Text the backend
sends to the page uses keys from the same file; a test checks that every key used in the frontend and backend
exists there.

## Origin and reverse proxies

By default, only requests from the same origin as `Host` or `X-Forwarded-Host` are accepted. Tailscale Serve,
Caddy and Nginx preserving Host need no extra configuration. Only when the log shows "Rejected a WebSocket upgrade
from a mismatched origin" should you add the full origin to `CODEX_REMOTE_ALLOWED_ORIGINS`, comma separated and
without wildcards.

## Troubleshooting

If the page does not open, check from the inside out: loopback `/healthz` → whether both services are `active` →
whether the HTTPS entry point forwards to the right loopback port → firewall, DNS or tailnet ACLs.

If it opens but sign-in fails: for a wrong token, check the environment file; if the WebSocket is rejected, look
at the origin and Host in the log; if the page script did not start, check that `boot.js` and `app.js` both return
200.

When online and fully deployed, an ordinary refresh loads the current page and its matching scripts and styles;
there is no need to close an installed PWA. On a phone, pull down at the top of the chat list or session list, or
on a blank part of the title bar, to refresh. The page never reloads itself because of a service worker update.
Offline, only the most recently fully cached shell opens, and session features still need a connection.
