# Architecture

English | [中文](architecture.zh-CN.md)

Codex Remote is a single-user, self-hosted PWA for controlling the Codex CLI on a host from a phone or
computer. It addresses how things feel over high latency: messages are written locally in the browser and
sent whole, and replies stream back.

It is not a general-purpose terminal, nor a thin wrapper that exposes the Codex App Server directly; the
browser only sees a small protocol designed for this application. The backend listens only on `127.0.0.1`,
with the HTTPS entry point as a separate layer.

```text
Browser PWA → HTTPS entry point → 127.0.0.1:<CODEX_REMOTE_PORT>
                                    ├→ ai-remote-upload on a Unix socket (attachments only)
                                    ├→ one shared codex app-server --stdio: session list and account quota
                                    └→ one codex app-server --stdio child process per active session
```

## Modules

| Directory | Responsibility |
| --- | --- |
| `src/server` | HTTP and WebSocket entry, cookie authentication, origin checks, static assets, project locks, file viewing |
| `src/app-server` | JSONL communication with the Codex App Server, the directory service, tool display |
| `src/workers` | One worker per session: start, queue, exit, state persistence |
| `src/sessions` | Session list, history paging, archive and trash |
| `src/approvals` | Receives approval requests from the App Server and forwards them to the browser |
| `src/commands` | Slash command catalog and execution |
| `src/projects` | Project allowlist resolution |
| `src/settings` | Global backend app settings (developer instructions, new-session default model, reasoning effort and permissions) |
| `src/shared` | Shared helpers, including interface text the backend sends as keys |
| `src/shared-upload` | Thin client for the separate `ai-remote-upload` project |
| `src/platform` | Platform differences (reading available memory and the like) |
| `src/generated` | Types generated from the Codex CLI protocol, tied to a specific Codex version |
| `public/` | The frontend PWA: sign-in, project and session navigation, app settings, composing and sending, streaming, Markdown, slash menu |

In the app settings at the top of the sidebar, appearance (light, dark or follow the system) and interface
language (Chinese, English or follow the browser) are kept only in this browser and apply immediately.
Interface text lives in `public/strings.js`; notices, errors and command results the backend sends to the page
carry only a text key and parameters, which the page shows in its current language, while logs are always in
English. Conversation content already on screen is not redrawn on a switch; new content and sessions opened
again use the new language. The platform note sent to Codex is always in English.

The display time zone is likewise kept only in this browser (Shanghai by default, or follow the device). It
converts the last reply times, quota reset times and times in command receipts shown on the page, and does
not change server timestamps. Changing the time zone in the dialog previews first and takes effect with
"Save"; cancel, close or Escape restores the previous zone. Additional developer instructions and the
new-session default model, reasoning effort and permissions are written by the backend to `settings.json`
and shared by signed-in devices on the same Codex Remote backend; separate backend instances do not sync. The
settings window reads the backend each time it opens and does not pick up settings other devices save while
it stays open; when several places save in turn, the last save wins.

The default model and reasoning effort apply only to sessions created afterwards; reopening an old session
does not overwrite its own choices, and switching inside a session does not write back to the global settings.
"Follow Codex default" does not pin whatever Codex currently selects. Only after choosing a specific model can
you pick one of the reasoning efforts it supports, or let the effort follow that model's own default.

Default permissions likewise apply only to new sessions, with options from Codex's list of permission
profiles. As in the Codex desktop app, the permission profile and approval policy are set as a pair: full
access runs outside the sandbox and never asks for approval, while other profiles ask before out-of-bounds or
sensitive actions. "Follow Codex default" sets neither and uses the host's Codex configuration. When Codex
rejects the saved permission profile, that new session uses Codex's default permissions and the page shows a
notice; the saved setting is unchanged. Additional developer instructions are injected through the App
Server's `developerInstructions` when a session is created or reloaded, and do not change tasks already
running.

Codex itself is the authoritative store for native sessions and full history. The Node side additionally keeps
accepted messages, task states, redacted browser events, permission mode, interruption reasons and a
per-session attachment display index, to support "the task keeps running after the page closes" and to replace
known attachment paths with original names in the page's copy.

The browser keeps unsent text and attachment drafts per project and session, and keeps drafts, message sends
not yet confirmed and `/rewind` records in one local recovery state. A send or rewind starts only after this
record is written successfully; when local storage is unavailable, the current page content is kept and the
operation is refused explicitly, and corrupted data is never overwritten as if it were an empty queue. When the
backend finally rejects a message, the text and any still-recognizable attachments return to the original
session's draft without overwriting another session that is currently open. Display time zone, appearance,
language and sidebar collapse are appearance preferences that are allowed to fail and do not use this recovery
promise.

## Sessions and tasks

Once a message is accepted, the page can be closed; the task continues in its own worker until it completes,
is stopped, meets an approval no one answers, or the worker fails. When a session is reopened, completed
history is restored from Codex and partial output of the running part is replayed from the event log.

Only one unfinished task is allowed per project at a time; another message is rejected immediately rather than
queued. Task control belongs to the signed-in session, not to a particular WebSocket: any online device can
watch output, handle approvals and user input in the global pending area, and stop the task. The pending area
is independent of the current timeline, so switching or redrawing a session does not remove requests that are
still valid for other sessions. At most two workers run at once by default; when the project is idle but global
capacity or memory is short, that one accepted task may stay queued. Stopping an ordinary message covers four
stages: queued, starting the worker, waiting for the native turn ID, and running. Compaction can be cancelled
only in the first two: once the compaction instruction reaches Codex, stopping is no longer accepted and the
page says so plainly, because Codex gives no guarantee about what interrupting a compaction leaves in the
session context. A stop request waits at most 10 seconds for Codex to confirm; past that the backend stops
waiting for the worker, records the task as interrupted and closes the worker forcibly, and the page's stop
request returns as usual. Offline handling and service shutdown use the same limit, so one unresponsive worker
cannot hold up other sessions.

Creating the worker process, initializing the App Server and resuming the session wait at most two minutes;
if things are still not ready by then, the backend terminates the half-started process, records the task as a
start failure, and releases the project lock and the worker slot. This limit only supervises startup; it does
not limit normal conversation time and does not depend on the user pressing stop.

On shutdown, temporary workers used for new sessions, history restores and short commands are also closed and
awaited by the manager; workers still closing because a task just ended or an idle session was just reclaimed
must likewise exit for real before the manager counts as closed. After shutdown begins, no new idle sessions are
published and no late operation crosses the state store's closing boundary. A task still starting that has not
yet submitted its turn to Codex stays `queued` as is and is scheduled again after restart; one already submitted
is recorded as interrupted by backend stop (`backend_stopping`), not as a user stop.

If an accepted message fails before a native turn ID exists, the turn is not in Codex history yet. The backend
keeps, within limits, the last such failure of the session; on reopening, it replays the user message and the
failure reason until the same session accepts its next task. Tasks that already have a native turn rely on Codex
history and keep no separate history of terminal events.

When a browser reconnects and a task has been accepted but its worker has not yet restored trustworthy history,
the backend reports only `queued` or `starting`, and the page shows the loading state for waiting on a worker
or starting Codex, keeping the stop button. Once the worker is ready, the page requests the session again and
draws the conversation from Codex history and the current task events; the backend does not fill the gap with
an old copy of the session.

As soon as a WebSocket closes, the backend withdraws that browser's online registration and session
attachments without waiting for business requests still pending on the connection. Requests already received
may finish in the background, but a late resume result cannot attach a dead connection to a session again; a
new idle worker that never attached successfully is reclaimed automatically after the grace period.

Sessions can be searched, archived, moved to the trash and restored; after 30 days in the trash they are
deleted on the Codex side as well. Permanent deletion first writes a `deleting` stage into the trash state, then
deletes the Codex thread, worker records, attachment display index and pin record in turn, and removes the
trash entry last. Service startup and the daily cleanup continue leftover `deleting` entries, so exiting
halfway does not lose the cleanup. When another device has the session open at the same time, an
attachment-index sync in progress does not write the index back after deletion completes. A running session
cannot be archived or deleted.

Moving a session from the active list to the trash, and restoring such a session, likewise first writes a
`trashing` / `restoring` stage into the trash state and then calls Codex's archive or unarchive. Once written,
the stage only moves forward: when a request fails, the session stays in the trash and can be restored again,
and retrying the same operation, service startup and the daily cleanup all finish it; Codex's exact error saying
the session is already in the target state counts as earlier success.

Pinned sessions in "Recent" are first confirmed not to be archived. When a project has more archived sessions
than one request's paging limit, pinned sessions not yet confirmed are checked against the active list within
limits, and those that still cannot be confirmed are kept out of "Recent" for now.

## Permissions and approvals

Only "allow once" and "decline" are supported; no long-term authorization rules are created. Every pending card
shows its source session; command approvals show a command summary with paths and assigned values hidden, and
permission approvals project the network and file system scope into descriptions without absolute host paths.
When the scope cannot be shown completely and safely, the page only allows declining. When a task ends, a worker
fails, Codex withdraws the request, or any device answers, the backend broadcasts the final state of that
request to every online page.

After the last client disconnects there is a 10-second grace period: with ordinary permissions, an approval
still waiting when it ends is declined first and the whole turn is then interrupted; with full access, execution
and file permissions can be handled automatically, but inputs that need a person — choices, verification codes,
sign-in authorization — are never answered automatically and are interrupted likewise when no one is online.
When the grace period ends, requests are handled one by one, and before each one the backend checks again that
no device has come back; handling one takes an interrupt round trip, and a device that reconnects meanwhile
should take over the remaining approvals.

## Slash commands

The command catalog comes from the backend rather than being hard-coded in device caches: `/compact`, `/model`,
`/permissions`, `/rename`, `/rewind`. Below the composer there is also a `+` menu and two dropdowns for model
and permissions; `/model` and `/permissions` are handled by those dropdowns and do not appear in the slash menu.

`/model` and `/permissions` change only the current session's later settings and never write Codex's global
configuration. They apply immediately when the session is idle; they can also be chosen while a reply is in
progress, in which case the current turn is unaffected, the backend records the choice, and hands it to Codex
with the next message's turn. Switching permissions inside a session uses the same pairing as the global default
permissions: switching to full access also sets approval to never ask, and switching to another profile sets it
to ask when needed.

`/rewind` rewinds the specific turn the user saw when confirming; it never re-picks "the current last turn" at
execution time. The browser first writes the target turn ID, the original message and attachments into a local
pending record; if the connection drops during the request or the history reload after it, the same ID is used
to confirm after reconnecting or even reopening the PWA. The rewind runs only if the target is still the last
turn; if the target is gone, earlier success is assumed and nothing more is done; if the target still exists
but newer turns follow it, the rewind is refused. After the backend finishes the change it returns only a
receipt, and the page loads history through the normal session-resume path, so a destructive change is never
bundled with a whole page of history in one response.

## Security boundaries

- Listens only on loopback, so even if the entry point fails nothing binds to a public interface; the App Server never binds a port.
- Origin and sign-in cookie are checked before the WebSocket upgrade; the token is compared in constant time, and changing it invalidates every cookie at once.
- Every allowlisted root and every scanned project has exactly one canonical physical identity; resume, queueing,
  attaching and worker promotion always check the project ID against the `cwd` Codex reports, and projects with
  the same name are told apart only by the public root ID.
- Internal storage paths of known attachments are replaced with attachment names in the browser's display copy;
  other host paths in commands, tool output and conversation stay as they are. Raw text of unknown errors from the
  operating system, the App Server and other downstream services goes only to the service log, and the page shows
  a stable explanation.
- The file viewer reads only Markdown and images inside the allowlisted roots and offers no download or directory browsing.
