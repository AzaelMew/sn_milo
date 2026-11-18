# sn_milo — ServiceNow Milo

One Chromium MV3 extension that will replace five separate ServiceNow extensions (critical alert, interaction
alert, Informatica button, KB dark mode, timecard overlay) with per-feature toggles. **Current state:** foundation
(Tasks 2–3 of the migration plan: manifest/generator, test harnesses, settings / router /
lifecycle) plus the migrated **Informatica button** (Task 4, content scripts only — it has no worker module),
**KB dark mode** (Task 5, attribute-gated declarative CSS) and both **alerts** (Task 6, worker module + MAIN bridge +
ISOLATED poller each) and the **timecard overlay** (Task 7, MAIN-world content scripts + an options-status worker module).

## Updates in 1.12.1

- **Informatica detection:** tickets now carry a monitoring-alarm header before the Informatica text
  (`Monitoring Alarm: <host> - AMS Informatica error: …`), so the button and the resolve precheck match
  `AMS Informatica` anywhere in the record title / short description (case-insensitive) instead of requiring it as a
  prefix. The old prefix format still matches; a title without the marker is still ignored.
- **Informatica note text:** descriptions now begin with a `Monitoring` label followed by a rule of dashes. That
  leading block is dropped before pasting into *External work notes*; everything after it is pasted verbatim. Only a
  bare `Monitoring` line (optionally followed by the dash rule) is removed, so a first line like
  `Monitoring Alarm: …` is kept, and a description that is only the header fails with "Description is empty".

## Updates in 1.12.0

- **Rule export/import:** the Critical alert rules editor exports its current validated list (including unsaved
  edits) as JSON. Import validates the entire file and asks before replacing the editor list; review it and click
  **Save rules** to apply. Known-ticket history, migration state and other settings are not imported or reset.
  Exported files contain account names: keep them private and do not commit them to this repository.
- **Timecard targeting:** supported nested Workspace record routes use the innermost record, so a case opened
  under an interaction targets the case rather than its parent. Unsupported or malformed child routes hide the
  launcher instead of billing a different record. Root-record `/params/` routes are supported too.
- **Timecard launcher recovery:** the launcher follows the visible native Record Time toolbar when Workspace
  retains an old hidden toolbar at the same URL, preserving button identity and focus on unchanged toolbars.
- **Inbox scope:** the embedded Inbox is excluded from agent workspaces; Classic and Platform Analytics remain
  supported to avoid embedding a competing agent workspace inside CSM.

## Floating native Inbox (1.8.0; red dot 1.9.0; frame fix 1.9.1; presence bubble 1.10.0)

The **Floating native Inbox** toggle enables a bottom-right, initially collapsed Inbox on both configured
instances, including Platform Analytics and Classic pages. When the feature starts on page load it eagerly preloads the current
instance's `/now/cwf/agent/inbox` in a same-origin iframe in the background; the first click reuses that frame. Collapse hides the panel but keeps that native workspace
mounted, retaining its session/subscription. Disable in options closes it and releases the frame and timers;
re-enable preloads again, still collapsed. Same-instance script reinjection retains the mounted workspace.
Native status and alert-settings popovers, which the page hoists to body-level panels, are raised above the embedded
Inbox only when they reference components inside it; other shell popups stay hidden.

Only the visible native `sn-agent-inbox` branch is shown, including its native presence/status and alert controls.
Open shadow roots are traversed; a visible native Inbox is preferred, and if none renders (narrow layouts report it 0x0/hidden) the last native candidate is forced visible in place (never cloned). Presentation changes stay inside the iframe;
native nodes are not moved and requests, assignment, availability and item handling are not reimplemented.
The launcher never changes availability or accepts work automatically. The native Inbox link opens separately
with `noopener`; it remains available when embedding, authentication or native rendering fails (30-second loading
fallback, with recovery if rendering finishes later). Loading another workspace consumes native workspace resources
from page load, before any expansion (the iframe may measure 0 wide while the panel is collapsed, so isolation uses its hidden fallback and recovers after opening); collapse is not an unload or a promise that the browser will never throttle its background work.

**Red dot (1.9.0).** When the selected native Inbox's own shadow root reports `N work item(s) in Inbox` in its
`.test-announce-work-items` live region (read-only; strict match), N > 0 shows a small red dot on the launcher's
upper-right and sets the button's accessible name to e.g. `Inbox, 2 work items`. 0, missing or malformed text, reload,
removal, failure and disable hide it. A MutationObserver on that shadow root (reconnected when native replaces the Inbox)
updates it immediately; the 1s scan is a backstop. The dot is out of flow, so the pill's bounds and visible text never
change. It adds no sound, notification, storage or requests, and does not touch audio settings; any incoming-work
sound is the native site's own and is not verified here.

**Presence bubble (1.10.0).** A separate 40px round button sits immediately left of the Inbox pill (also fixed; the pill is
unchanged). It mirrors the selected Inbox's own presence button (`sn-agent-presence-state` > `button#presenceBar`, label
`Agent presence state: X`, which must agree with its `.status` text): green Available/Online, red Offline, yellow
Busy/Away/WrapUp, grey for anything unknown, missing, contradictory, reloaded or removed (never red/green by default).
The tooltip and accessible name carry the native status name; observers on the native roots update it immediately, with
the 1s scan as a backstop. Clicking the bubble opens a compact menu above it with the real native choices, read from the
selected Inbox's own `sn-presence-popover-content` shadow list (`ul[role=listbox][aria-label="Status Options"]`, selected
`li` marked); foreign or other popups are ignored. Opening only reads (it does not open the native dropdown or the panel).
Only an explicit click on a menu entry calls `.click()` once on the matching native option (never for the current one);
the bubble does not change optimistically and shows whatever the native control reports afterwards. Escape, outside click
and the bubble close the menu without effect. No storage, requests, synthetic events, audio or cycling.

**Middle-click/navigation fix (1.9.1).** The native Inbox document carries an inline frame-buster that, for any embedded
frame whose id is not `testFrame`, calls the parent shell's route function and can send the whole top window to the Inbox
(symptom: opening a case in a new tab ended on the Inbox). The overlay frame therefore uses the native exemption
`id="testFrame"`, set before `src`; its identity is kept by `name="sn-milo-native-inbox"` and a `data-sn-milo-native-inbox`
attribute. Nothing in the parent page, its links or its routing is overridden or intercepted. A regression test executes a
markup-derived copy of the guard against the frame the script really creates (route function not called, top location
unchanged) with an ordinary frame as positive control.

`tests/inbox-overlay.test.mjs` runs the actual content script in a VM DOM fixture, covering eager preload,
collapse retention, shadow-root isolation/re-rendering, lifecycle and failure recovery. These local tests do not
verify live work-item acceptance, assignment or availability changes. Browser installation/reload is a separate,
explicit action; unit tests do not attach to a browser.

## Layout

```
manifest.template.json   committed manifest structure + authoritative version (host placeholders only)
package.json             version must equal the template version
config.example.json      sanitized example of the private config.json
background.js            ES-module service worker: registers all listeners synchronously, imports feature modules
options.html / options.js per-feature toggles, effective state, alert migration status + completion actions, storage-error banner
shared/options-view.mjs  pure options logic: snapshot parsing/validation, control messages, fallback wording, view model
shared/features.mjs      feature catalog, preferences, alert migration gate, effective state, migration storage API
shared/router.mjs        readiness/reconciliation queue, message router, alarm/notification ownership, hooks
shared/script-policy.mjs declarative content_scripts (the generator emits them; tests assert exact agreement)
shared/controller.js     ISOLATED settings controller (IIFE, all frames): effective state → subscribers + MAIN relay
shared/main-settings.js  MAIN receiver of the relay: window.__snMiloMainSettings
features/timecard/config.example.js   sanitized example of the generated timecard config
scripts/generate-config.mjs           template + config.json -> generated artifacts
tests/setup/no-network.mjs            throwing network stubs for the unit tests
tests/*.test.mjs                      unit tests (explicitly listed in package.json)
tests/browser/                        disposable-browser tests (explicit, never part of `npm test`)
```

## Commands

| Command | What it does |
|---|---|
| `npm run generate` | validate inputs, write `manifest.json`, `features/timecard/config.js`, `shared/origins.generated.mjs` |
| `npm run generate:check` | recompute expected artifacts; fail on missing/stale/different output; never writes |
| `npm run gate:kb` / `gate:kb:check` | regenerate / check `features/kb-dark/dark.css` from the original stylesheet (also asserted by `test:unit`) |
| `npm test` | `generate:check` (fails with "Run `npm run generate`" when artifacts are missing/stale), then `test:unit` (no browser, no network) |
| `npm run test:unit` | generator, no-network, settings, migration, router, lifecycle, content-lifecycle, manifest-policy, options tests, `features/informatica-button/test.cjs` (migrated original bridge tests + bridge lifecycle) and `tests/informatica.test.mjs` (real settings path + mocked workflow/cancellation), `tests/monitoring-routing.test.mjs`, `features/{critical,interaction}-alert/test.cjs`, `tests/critical-alert.test.mjs`, `tests/alerts.test.mjs` (see *Alerts*) |
| `npm run test:browser` | disposable Vivaldi: skeleton load check, settings foundation (options page, worker status, controller handshake on production + test fixtures, live toggles without reload, snapshot import + confirmed fallback via the options page), content isolation (storage denied to content scripts; extension reload → new isolated world, old controller retires by liveness), Informatica button on a production-origin fixture (mounts, removed on disable via options + storage, exactly one on re-enable, no reload; never clicked), KB baseline (7 checks), KB dark original-vs-Milo comparison (see *KB dark mode*; screenshots under `$TMPDIR/sn_milo-kb-dark-shots-*`) and the alerts (see *Alerts*). Ports: `SN_MILO_BROWSER_PORT` (default 9461), `SN_MILO_SETTINGS_PORT` (9463), `SN_MILO_ISOLATION_PORT` (9465), `SN_MILO_INFORMATICA_PORT` (9467), `SN_KB_PORT` (9462), `SN_MILO_KB_ORIG_PORT` (9469), `SN_MILO_KB_PORT` (9471), `SN_MILO_KB_RESTART_PORT` (9473), `SN_MILO_ALERTS_PORT` (9475), `SN_MILO_TIMECARD_PORT` (9477), `SN_MILO_APPLY_UPDATE_PORT` (9479, runs the real `scripts/apply-update.mjs`) |

## Local private packaging and module validation

`npm run package` runs `ensureGenerated()` (generation **then freshness check**) before any archive write.
It creates `dist/sn_milo-<version>-private.zip`, a deterministic, sorted runtime-only ZIP with fixed timestamps
and mode `0600`. `dist/` is gitignored. The reviewed allowlist lives in `scripts/package.mjs`; it includes the
generated manifest, timecard config, origin module, all runtime JS/CSS/modules and both notification icons.
It excludes private **source** `config.json`, examples, tests, scripts, dumps, credentials and runtime state.
Generation/check failures or missing runtime assets abort before creating/replacing the archive.

**LOCAL PRIVATE ARTIFACT — do not publish or publicly share it.** Necessary generated runtime files contain
the configured instance origins and submission policy, although they contain no credentials. This is a local
unpacked-extension transport package, not a sanitized public source release. Keep private configuration and
credentials out of runtime source; packaging is an allowlist, not a secret scanner.

`tests/package.test.mjs` independently opens the ZIP, checks CRCs/assets and local module dependencies,
asserts excluded secret canaries and deterministic bytes, and exercises generation/check failure gates.
`tests/module-loading.test.mjs` imports the actual worker graph with native Node ESM and browser-API fixtures;
deliberate missing-import, syntax and top-level evaluation failures in an imported feature prevent **all** worker
initialization (zero router listeners, no `snMilo` object). Handler exception guards cannot contain static module
failures. The normal browser suite separately verifies real Chromium module loading.

No company, client or person names and no real host names are committed: instance origins come from the gitignored
`config.json`, and the account names, rules and recipients the features use are entered on the options page (stored in
the browser profile only). Tests use `example.com` / "Acme Oy" style placeholders.

## Settings, lifecycle and routing

**Storage** (`chrome.storage.local`, per profile, never synced):

| Key | Meaning |
|---|---|
| `features` | `{<feature>: boolean}` preferences. Missing known keys default **on**; malformed values (or a non-object) hold the feature **off**; unknown keys are ignored. |
| `crit.migrationV1`, `ix.migrationV1` | alert migration records `{schema:1, state:'ready'\|'seeding', method:'import'\|'notify-current'\|'seed-silently', decidedAt, …}`. Missing/unrecognized ⇒ `pending-migration` (fail closed). |
| `seenMatchesV4`, `seenInteractionsV1` | alert dedupe sets, exact keys/formats of the source extensions. |
| `miloEffectiveV1` | derived content-facing **effective** state `{schema:1, epoch, rev, features:{<f>:{enabled, seedOnly, reason}}, origins:{<origin>:[features]}}`, written only by the worker. |

**Storage is closed to content scripts.** At every worker start (`install()`, synchronously at module evaluation)
the worker calls `chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})`; every reconciliation
awaits it before reading settings, and a failure fails closed (fresh worker: `settings-unavailable`, retried on
the next entry). Verified in the disposable Vivaldi 8.2 (`tests/browser/isolation.browser.test.mjs`): afterwards a
content script's `chrome.storage.local.get/set` rejects with *"Access to storage is not allowed from this
context."*, so a content script cannot write `features`, `crit.migrationV1`, … directly — settings change only
through the options-only control messages. Only this extension's own content scripts could ever reach its
storage (page scripts have no `chrome.storage`), so the restriction defends against a compromised/misbehaving
content-script context, not against the page. *Persistence* (one-off probe in the disposable Vivaldi 8.2,
`--load-extension`, same profile restarted; worker deliberately did NOT call `setAccessLevel` on the second run): the
`TRUSTED_CONTEXTS` level survived a full browser restart (content write still rejected), and a control extension
that never restricts got `WRITE-OK`. Not verified: extension reload/update/disable→enable, and other Chromium
builds. Residual window (stated conservatively): from install — and possibly each reload/update/enable — until
the worker's first evaluation, the default `TRUSTED_AND_UNTRUSTED_CONTEXTS` may apply. The worker is evaluated
promptly at install (`onInstalled`) and at browser start (an `onStartup` listener is registered), and re-asserts
the level on every evaluation; statically declared content scripts are not injected into already-open tabs on
install, so exposure is limited to a page navigated in that short gap. Settings are never *read* before the
level is confirmed. The options page and the worker are trusted contexts and unaffected.

**Minimum browser:** `minimum_chrome_version` is `111` (manifest `content_scripts` with `world: 'MAIN'` need 111;
`storage.local.setAccessLevel` needs 102).

**Effective-record persistence.** `state.effective` (enforced inside the worker) is the truth; content only ever
receives the last *persisted* `miloEffectiveV1` record. If writing it fails, the worker keeps enforcing the new
state (messages/alarms of a newly disabled feature are refused) while content keeps the last persisted record;
the next reconciliation rewrites with a fresh rev (`max(stored, persisted, attempted) + 1`, never reused) even when
the stored record already matches, so open pages converge.

Effective = preference AND (alerts only) a completed migration. Pending alerts receive no messages, alarms or
lifecycle hooks. A storage-read failure never resets anything: a warm worker keeps its last known state, a fresh
worker defers all activation (`settings-unavailable`) and exposes the error (`snMilo.status()`, options banner).

**Readiness gate.** Every entry point (module evaluation, messages, alarms, notification clicks, `onInstalled`,
`onStartup`, storage changes) goes through one serialized reconciliation queue; nothing depends on
`onInstalled(reason:'install')`. `onEffectiveChange` hooks run in that queue on **every** worker wake (with
`prev === undefined`) and every transition, so they must be idempotent; every hook is cut off after
`hookTimeoutMs` (5 s, recorded in `status().hookErrors`) so a hung hook cannot freeze messages or alarms. Features
must not depend on `onInstalled`/`onStartup` being delivered (Chrome does not deliver them to a worker that wakes
for a message or alarm). Feature hooks get a narrowed `ctx.store` (`serialize`, `completeSeed` only).

**Messages** `{feature, type, …}`: the router accepts only registered `{feature,type}` pairs, from this extension
(`sender.id`), from an allowed origin (frame and tab: production for alerts/Informatica/KB, production or test for
timecard; a sender whose `tab` has no `url` fails closed), and only while the feature is effective
(`allowSeedOnly` handlers may run during seeding). Feature messages are refused (`inactive-document`) when
`sender.documentLifecycle` is present and not `'active'` (prerender, bfcache, unloading); the field is absent
before Chrome 106 and then allowed. `get-effective` (read-only) is served to prerendering documents too. Control
messages use `feature:'milo'`: `get-effective` (content, production/test), `get-status`, `set-preference`,
`import-dedupe`, `choose-fallback` (options page only). Rejections: `invalid-message`, `unknown-message`,
`foreign-sender`, `wrong-origin`, `inactive-document`, `settings-unavailable`, `feature-disabled`. Notification
clicks go only to the feature owning the ID prefix, and only while it is enabled (a stale click for a
disabled/pending feature just clears that notification); alarms only to the feature owning the exact name, while
enabled.

**Content relay.** `shared/controller.js` (ISOLATED) never touches storage: it asks `get-effective` at start, on
`visibilitychange` → visible and every 30 s while the document is visible (backstop; skipped in hidden tabs), and receives worker pushes
`{feature:'milo', type:'effective', effective}` (the worker `chrome.tabs.sendMessage`s every newly persisted record
to all frames of production/test tabs; only pushes from this extension's worker — `sender.id`, no `sender.tab` —
are accepted). It accepts only newer records (same epoch, higher rev; a *different* epoch is always accepted —
epochs are random UUIDs minted only when no valid record is persisted, e.g. cleared storage, so they cannot be
ordered; a late old-epoch response after a reset self-heals on the next push/visibility/backstop request), scopes features to its frame origin, runs ISOLATED subscribers via
`globalThis.__snMiloController.subscribe(feature, {start, stop, update}, {allowSeedOnly})` — `start`/`stop` follow the
running mode; the optional `update(state)` reports the known `{enabled, seedOnly}` whenever it first becomes known or
changes (including unknown → disabled, which start/stop never report, and after a same-world handoff); never while
unknown — (`controller.ready` resolves `true` once a record is accepted, follows the successor's `ready` on a
same-world handoff, `false` if the controller otherwise retires first), and relays to MAIN with
`{source:'sn-milo-controller', protocol:'sn-milo-settings', version:1, type:'settings', controllerId, seq, epoch, rev, features}`;
MAIN scripts ask with `{source:'sn-milo-main', …, type:'request'}` and use
`window.__snMiloMainSettings.subscribe(feature, cb)`. Both sides check `event.source === window`, the exact origin
and the schema. **Not an auth boundary**: same-origin page scripts can observe/forge these messages; privileged
enforcement stays in the worker.

*Reload/takeover.* Observed in the disposable Vivaldi 8.2 (`tests/browser/isolation.browser.test.mjs`): after an
extension reload (`Extensions.loadUnpacked` of the same path), `chrome.scripting.executeScript` from the new worker
runs in a **new isolated world** — the old controller's `globalThis` is not visible to the reinjected one (the old
world keeps its globals and listeners; its `chrome.runtime.id` becomes `undefined`). The MAIN world is shared, so
the MAIN helper's takeover/adoption works across reloads; the ISOLATED `globalThis.__snMiloController` takeover
only applies to reinjection by the *same* instance. Therefore every controller also runs a liveness check every
5 s and on `visibilitychange` (plus at every entry point: window request, push, `subscribe`, `effective`): when
its context is invalidated it retires, calls `stop('invalidated')` on every running subscriber, and removes all
listeners and timers. Subscribers must make `stop()` fully tear down what `start()` created. It never answers with
stale state; the MAIN helper also ignores a record older (same epoch, lower rev) than the last one it accepted,
whichever controller sends it. (Note: `chrome.runtime.reload()` from the worker console left the unpacked
extension *disabled* in the headless disposable browser; tests reload via `Extensions.loadUnpacked`.)

*Same-world reinjection (handoff).* When `shared/controller.js` is injected again into the **same** isolated world
(same extension instance, e.g. a watchdog), the new controller retires the old one as `superseded` but does **not**
stop its subscribers: subscriptions and the last accepted record live in a world-level registry
(`globalThis.__snMiloWorld`), which every new controller adopts and drives per its own effective state. Features
that captured the old controller object and subscribed once (the Informatica button, the KB toggle) keep working
without resubscribing; the old object's `effective()`/`subscribe()` delegate to the live successor and its `ready`
follows the successor's. A handoff before the first record still reaches state-only subscribers: the KB toggle uses
`update()` (not `ready`) so a saved-off `/kb` page gets its off attribute once the successor learns the state. Invalidation
(dead extension context) still stops every subscriber in that world.

*After an extension reload/update* the old world's controller retires and stops its features, and the new
instance's static content scripts only run in **new** documents. ISOLATED features (Informatica button, KB dark
toggle) in already-open tabs therefore stop following settings until the tab is reloaded — unless the new
instance reinjects them (`scripts/apply-update.mjs` reinjects, see *Developer tools*).

**Frames.** Content scripts run in every frame whose URL is on a configured origin (`all_frames`). `about:blank`,
`about:srcdoc` and `blob:` frames get nothing (no `match_about_blank` / `match_origin_as_fallback`), and the router
would refuse their messages (`sender.url` has origin `null`). A feature that needs them must opt in explicitly
(see the note in `shared/script-policy.mjs`). Sandboxed/opaque-origin frames are always inert.

## Informatica button

**Resolve option (1.5.0, off by default).** Options page → *Informatica button: resolve the ticket* (`inf.resolveV1`
`{schema:1, enabled, notes}`; the notes text is user data, never in source). When on, after the note **Save is
confirmed** (the editor emptied after Post) the bridge resolves the open incident: GET precheck (the short description
must contain *AMS Informatica*, at any position — the current tickets prefix it with a monitoring-alarm header — and the state must be
Assigned/WIP/On hold) → **one** PATCH `{state:"6", close_code:"Solution provided", close_notes:<notes>}` → GET read-back
that must match. No retry (a timeout reports "outcome unknown"); a dry run never resolves; if the note did not post,
nothing is written to the ticket. The bridge's `resolve-record` is the only write it can make, limited to `incident`.

`features/informatica-button/` — `page.js` (MAIN bridge, `document_start`) and `content.js` (ISOLATED button,
`document_idle`); production **and test** origins (1.5.0: the test host was added so the resolve option can be tried safely), top frame only (asserted in
`tests/manifest-policy.test.mjs`). No worker module and no router messages. DOM lookup, placement, labels and the
workflow order are unchanged except the last step (1.5.0 reverts the 1.4.0 change): add the three people → verify the saved *External work notes list* with a read-only
GET through the bridge → **Save** (skipped when already persisted) → verify → open *External work notes* → paste the
Description → click the compose pane's **Post External work notes** once it has stayed enabled (a single click, never
retried: Post is not idempotent; success = the editor empties, otherwise the run fails and the note stays pasted; Post
never enabled ⇒ fails, nothing submitted). 1.4.0 relied on the record's Save submitting the pending note; the test
instance showed it does not. `localStorage.snInfDryRun = "1"` stops right before the Post click — **after** the list
Save, so dry run is *not* write-free; never use it on production as a test.

- **Origin.** The original hard-coded the production host. Milo scopes it through the generated
  manifest matches (production + test since 1.5.0) and the worker-scoped effective state (the controller reports the feature
  enabled only on the configured production origin); bridge messages use the exact `location.origin`. Opaque or
  non-https frames exit immediately.
- **Lifecycle.** Both scripts are inert until the settings controller (ISOLATED) / MAIN helper reports the feature
  enabled; without them they stay inert. Enable: one placement timer + one owned `#sn-inf-button`; the bridge adds
  one named `message` listener. Disable: timer and label timers cleared, button removed, bridge listener removed,
  in-flight bridge fetches aborted and their results dropped (generation check). Re-enable mounts exactly one
  button. `__snInfController` / `__snInfBridge` remain replaceable controllers: a re-injected script stops the
  previous one including its settings subscription. Clicks run only for the live session's own connected button
  while the feature is enabled.
- **Cancellation checkpoints.** A checkpoint runs synchronously immediately before every page write (typing a
  person, picking a suggestion, Save, opening the tab, pasting, the Post click) and after every await; a stopped
  session (disable, supersede, extension context invalidated) or a disabled effective state throws there, so no
  further write begins after disable and a cancelled run never retries (or repeats) the Post click. Completed or in-flight writes are not
  undone (Milo cannot revert a server save/post): `stop()` immediately reports what was already done — e.g.
  *"added 1 of 3 people … (not saved)"*, *"Save clicked (the record may have been saved)"*, *"Save clicked for the note (it
  may have been posted)"* — on the console (`[SN-INF]`), in a 12 s `#sn-inf-notice` status element and in
  `__snInfController.lastRun` `{status:'cancelled', reason, completed, message}`.
- **Names.** MAIN/ISOLATED globals, postMessage tags (`sn-inf-extension` / `sn-inf-page`), the button id and the
  `snInfDryRun` key are unchanged. They are shared with the original extension, which must not run on the same
  documents (non-coexistence is enforced at cutover), so renaming would add nothing.
- **Verification.** Workflow behaviour (Save/Post) is test-covered with mocks only, not live-verified. The browser
  test serves a fixture record for the production origin, never clicks the button and asserts that no API or
  non-GET request was made.

## Monitoring routing buttons

`features/monitoring-routing/content.js` — one MAIN-world script (`document_idle`, all frames, only
`/sn_customerservice_case.do*`, production and test origins), i.e. the classic case form inside the `gsft_main` frame.
Inert until `window.__snMiloMainSettings` reports `monitoring-routing` enabled; disable removes the buttons and cancels a
run at its next checkpoint.

When the form's Channel is `monitoring` it adds routing buttons (**Windows**, **Linux**, **MSSQL**, **Disk**) in the empty strip right
of the Channel row (absolutely positioned: no layout space; two per row). A click fills the form through `g_form`:
Type = Incident, Category/Subcategory per button (Server / Windows Operating system, Server / Non-Windows,
Application platform / Database), Assignment group = Monitoring, Assigned to = the signed-in user (`g_user`, so no person
is named in source), and last Contract Invoice Rate (`u_contract_invoice_rate`). Type and Category reload the dependent
choice lists, so the script waits for each list to change before choosing from it (and redoes the write once if the list
never reloaded).

**Contract Invoice Rate goes last, so there is normally no wait.** The system fills it ~0.25 s after the Subcategory
change when exactly one rate fits; the group/assignee writes take that time. If it is still empty, the script waits out
the rest of 0.5 s (counted from the Subcategory write) and then, for Windows and MSSQL, sets it to the active rate of that
name in the case's own `sys_domain` (rates are per customer; for MSSQL also under the "SQL Database Monitoring and
Management" contract; read-only GETs; never overwrites a filled value; without a configured contract name exactly one
match is required). Linux has no rate rule.

**A rate that cannot be set does not stop the run.** If the rate lookup finds nothing (or several), fails, or the button
has no rate rule, every other field is still filled and checked, the rate stays blank, and the form is **not saved**: the
button shows `Filled, not saved: Contract Invoice Rate left blank (<reason>)`. This is the only allowed gap; any other
mismatch or empty mandatory field still bails as below.

**Double check, then save.** After filling, it re-reads every field independently (what the form displays plus
`g_form`, twice with a pause, plus `g_form.getMissingFields()` and, for MSSQL, the derived Contract). Only if all are
correct (and the rate is set) does it click the form's own `#sysverb_update_and_stay` Save button, once, never retried; any mismatch bails
with `Failed: not saved, check the form: ...` on the button and saves nothing. `localStorage.snMrNoSave = "1"` fills and
verifies but skips the save (for testing on live records). `tests/monitoring-routing.test.mjs` covers it with a stubbed form.

## KB dark mode

`features/kb-dark/` — `dark.css` (declarative, `document_start`) + `content.js` (ISOLATED toggle, `document_start`,
after the settings controller), both on the production origin's exact `/kb` and `/kb?*` routes, top frame only — the
original's scope (`/kb*` would also hit `/kb-other` and `/kb_view.do`). Never on the test host.

- **CSS is generated**, never hand-edited: `npm run gate:kb` (`scripts/gate-kb-css.mjs`) rewrites the unmodified
  original (`features/kb-dark/source/dark.original.css`, 31 rules) by adding the zero-specificity gate
  `:where(:root:not([data-milo-kb-off]))` to every selector-list branch: conjoined with a root compound
  (`:root` → `:root:where(…)`, `html body …` → `html:where(…) body …`, before any pseudo-element), prepended as an
  ancestor for selectors whose first compound is a non-`html` type; anything that could match either (`.x`, `#id`,
  `*`, `[attr]`, `::selection` first) is refused rather than guessed. Declarations, comments and rule order are
  byte-identical; @media/@supports/@container/@layer are recursed into, @keyframes/@font-face copied, other block
  at-rules and CSS nesting rejected. `tests/kb-css-gate.test.mjs` asserts committed output == transformer output,
  that removing the gates gives back the original byte-for-byte, and an independently computed specificity per
  selector. In the actual file all 31 selectors start with `html`/`:root`, so all 31 are conjoined.
- **Toggle.** `content.js` owns `data-milo-kb-off` on `<html>`: absent (dark) until the effective state is known; set
  when KB dark mode is off, removed when on; live via the controller subscription, no reload. Unknown state (no
  controller, not ready yet) leaves it alone. `stop('invalidated')` (extension reloaded/removed) leaves the last value.
  No `document.styleSheets`, no `removeCSS` (declarative CSS cannot be removed by it).
- **First paint (tradeoff).** The CSS is applied before first paint; the off attribute only arrives with the
  asynchronous settings answer. A page whose saved state is *off* therefore renders **dark until the answer
  arrives**. Measured in the disposable browser: normally the attribute was set before first-contentful-paint
  (≈20–40 ms vs FCP ≈35–70 ms: fresh navigation, first page after a browser restart), but this is a race, not a
  guarantee; with the service worker paused (delayed settings) the saved-off page painted dark and switched ≈2.8 s
  later. A saved-on page never flashes.
- **Extension reload/update.** Open `/kb` tabs keep the old instance's CSS *and* their last attribute value; they no
  longer follow toggles until reloaded (observed: disabling via the new instance left an open tab dark). New
  documents are fine. A `/kb` tab opened before first installation stays unthemed until reloaded (same as the
  original: static CSS only reaches new documents).
- **Verification** (`tests/browser/kb-dark.browser.test.mjs`): the original extension in one disposable browser and
  Milo in another (never both on one document), same fixture (root/body styles, competing site rules of lower /
  equal / higher specificity with and without `!important`, the theme's selector-list targets, inline white
  surfaces, `::selection`, `::placeholder`, `::marker`, `::before`, forced `:hover` / `:focus-visible`), same window.
  Every computed property of every element (≈178k values): Milo enabled == original, Milo disabled (live toggle and
  fresh navigation) == unthemed; same injected rules matched per element/pseudo-element in the same order (CDP
  `CSS.getMatchedStylesForNode`) and none when disabled; top+bottom viewport screenshots with text selected and
  hover forced: 0 differing pixels in each comparison. Also route scope, delayed settings, browser restart (saved
  off survives), first installation and extension reload. Fixture-based: proves CSS gating/cascade equivalence, not
  the authenticated portal's real layout.

## Alerts

`features/critical-alert/` — `background.mjs` (worker feature module, `createCriticalAlert()`), `page.js` (MAIN
bridge, `document_start`), `content.js` (ISOLATED poller, `document_idle`), `icons/alert.png` (byte-identical copy),
`test.cjs` (migrated original suite); `features/interaction-alert/` has the same shape (`createInteractionAlert()`).
Production origin only, top frame only — exactly the original manifest entries (asserted in
`tests/manifest-policy.test.mjs`). The two modules are deliberately separate copies (no shared health refactor during
the migration); the table lists both. Critical alert: Matching, query, poll timing (first poll 5 s, every 120 s, retry
10 s, request timeout 30 s), notification texts/ids/click action, dedupe key/format and retention (`seenMatchesV4`,
uncapped, never pruned, saved after every notification), the diagnostic log (`diagnosticLogsV1`, last 200) and the
health rules (stale after 360 000 ms, monitored only while a production tab is open, one sticky notification per
outage, one quiet recovery notice) are unchanged. Interaction alert: same, with poll every 60 s (heartbeat window
45 s), stale after 240 000 ms, dedupe `seenInteractionsV1` (bare sys_id; every valid row is a list member),
`diagnosticLogsIxV1`, click → `/now/cwf/agent/record/interaction/<sys_id>`, one Table API query (`interaction`).

**Critical alert rules (1.2.0).** What the critical alert matches is no longer hard-coded: it is a list of user
rules (options page → "Critical alert rules", stored in `chrome.storage.local` as `crit.rulesV1`, so no account or
client name lives in source or config). Scope is fixed: SOC Jono queue, active, state New. A rule is `{id, name,
enabled, priority ('1'..'5' or any), account (name, case-insensitive, or any)}` and needs at least one condition;
a ticket alerts when ANY enabled rule matches, once per ticket (dedupe key unchanged), and the notification gets a
`Rule: <names>` line. No stored rules ⇒ one default rule, `Critical` (priority 1); malformed storage also falls back
to that default rather than going silent. Flow: before each poll the content script asks the worker (`get-rules`) for
the enabled rules' conditions and sends them to the page bridge, which makes one Table API query per rule and table
(`account` is the query dot-walk `account.name=`; the bridge re-validates the rules, `^` is refused) and merges
the rows by `sys_id`; the worker matches again with the full rules (names) before notifying. No enabled rules ⇒ an
empty successful poll, no request. The options page also has "Forget known tickets…" (empties `seenMatchesV4`).
Rule logic: `shared/rules.mjs`.

**Accounts and recipients (1.3.0).** Two more lists are user data on the options page (`shared/user-lists.mjs`),
stored per browser profile, so no client or person is named in the repository. *Interaction alert accounts*
(`ix.accountsV1`): the poller asks the worker (`get-accounts`) and the bridge builds the list query from the base
filter plus `account.name=<name>` per account (OR); nothing listed ⇒ an empty successful poll and no alerts.
*Informatica recipients* (`inf.recipientsV1`): returned with the run lease by `informatica-run-start`; with none
configured the worker refuses the run before taking the lease.

| Original | Milo | Why |
|---|---|---|
| `healthStateV1`, `lastSuccessfulPollAt` (both originals) | `crit.healthStateV1`, `crit.lastSuccessfulPollAt` / `ix.healthStateV1`, `ix.lastSuccessfulPollAt` | collided between the two alert extensions |
| content `lastPollAt` (content storage, both) | `crit.lastPollAt` / `ix.lastPollAt`, read/written only by the worker | content scripts cannot use storage (TRUSTED_CONTEXTS) |
| health notification `snHealth` (both) | `snCritHealth` / `snIxHealth` | collision |
| alarms `snTkHealthCheck` / `snIxHealthCheck`, row ids `snTk-` / `snIx-<sys_id>`, `seenMatchesV4` / `seenInteractionsV1`, `diagnosticLogsV1` / `diagnosticLogsIxV1` | unchanged (router-owned: exact alarm names, notification prefixes) | already distinct |
| `{type:'snTkRows'\|'snTkLog'}` / `snIxRows`, `snIxLog` | `{feature:'critical-alert'\|'interaction-alert', type:'rows'\|'log'\|'claim-poll'\|'release-poll'}` via the router | central sender/origin/enabled validation, async responses kept |
| `window.__snTkPageBridgeLoaded` / `__snIxPageBridgeLoaded` boolean guards, anonymous listeners | `window.__snTkBridge` / `__snIxBridge = {stop(), active}`, named listeners | replaceable, removable, abortable |
| `globalThis.__snTkContentLoaded` / `__snIxContentLoaded` | `globalThis.__snTkController` / `__snIxController = {version, retired, active, mode, stop()}` | lifecycle-driven pollers |
| `executeScript files ['page.js'], ['content.js']`, `getURL('icons/alert.png')` | `features/<alert>/…` (+ `shared/controller.js`, `shared/main-settings.js`) | feature-relative paths |
| top-level `alarms.create`, injection at evaluation + `onInstalled` | router hooks under the readiness gate, only while enabled/seeding | no feature-owned top-level side effects |
| `globalThis.snTkStatus` / `snIxStatus` | same names, defined by `background.js` | console/CDP helpers |

- **Heartbeat election in the worker.** The poller asks `claim-poll` → `{granted}`: refused while
  `0 <= now - crit.lastPollAt < 105 000 ms` (interaction: `ix.lastPollAt`, 45 000 ms) (original windows; a future stamp after a clock correction counts as
  stale), otherwise the stamp is written and granted. Claims are serialized in the worker (closes the original's
  simultaneous-claim race; across a worker restart a duplicate API call is still possible, never a duplicate
  notification). Every failure path (bridge error, request timeout, claim failure, worker failure, postMessage throw)
  clears the pending id, sends `release-poll`, logs, and retries after 10 s, as before.
- **Enable/disable.** The poller and bridge do nothing until the settings controller / MAIN helper report the
  feature enabled (or seeding); the bridge has no listener at all before that, so no fetch is possible. Disable:
  poller timers/interval/pending requests and its named listener are cleared, the bridge listener is removed and
  in-flight fetches aborted (results dropped); the worker clears `snTkHealthCheck` and the owned `snCritHealth`
  notification, resets `crit.healthStateV1` (grace restarts when monitoring resumes) and the heartbeat. Row
  notifications already shown stay. Queued or in-flight row handling re-checks `ctx.isCurrent()` + enabled before
  every notification (and after every await), so nothing notifies after a disable; what was delivered is already
  saved. Re-enable: fresh health grace (`startedAt = now`), alarm recreated, the same document polls again, dedupe
  untouched (no re-alert). A worker wake is not a re-enable (grace is not reset by restarts).
- **Recovery injection (watchdog).** On every worker start while enabled/seeding and on `onInstalled`, the worker
  scans production tabs (never the test host), probes this extension instance's ISOLATED world for a live
  `__snTkController`, and only where there is none injects `shared/controller.js`, `shared/main-settings.js`,
  `features/critical-alert/page.js`, `features/critical-alert/content.js` (in that order). After an extension
  reload/update this re-attaches a fresh poller in the new isolated world; the orphan retires via the settings
  controller's liveness check; the reinjected bridge replaces the old instance's MAIN bridge. Failures are logged
  (`dashboard-attach-failed`), never unhandled. Pending-migration ⇒ no probe, no injection, no alarm.
- **Seed-silently.** While `seedOnly`, the poller runs in seed mode; the worker commits the matching keys of one
  validated, *complete* (both tables answered — a partial result with a table failure is skipped) successful poll
  via `completeSeed()` (dedupe set + ready marker in one write, serialized with row handling), notifying nothing.
  An empty complete result seeds an empty set. Concurrent seed messages: the first commits, later ones are no-ops.
  Once ready, row handling is normal; updates, restarts and re-enables never reseed.
  A partial result is answered `{ok:true, seeded:0, reason:'partial-result'}` (not a worker failure): the poller keeps
  the normal interval (no heartbeat release, no 10 s retry, no health failure) and the last attempt + reason is in the
  feature status (`lastSeedAttempt`, storage `crit.lastSeedAttempt` / `ix.lastSeedAttempt`). Seeding-time failure text
  is cleared when the seed completes / the feature becomes ready.
- **Self-healing and quiet waits.** The health alarm is re-ensured on every granted `claim-poll` and on startup while
  enabled (a timed-out enable hook cannot leave it missing). A prerendered/inactive document (`inactive-document`) waits
  quietly (no failure log, no release, no 10 s retry) and polls on `visibilitychange`/`prerenderingchange` or the next
  interval; a claim granted to a session stopped meanwhile is released best-effort.
- **Instance label.** Health titles were "ServiceNow Critical Alert (<Instance>) …"; the label is now derived from the
  configured production host (first DNS label, capitalised), so no host name is committed.
- **Tests.** `features/critical-alert/test.cjs` (the 15 original cases) and `features/interaction-alert/test.cjs`
  (the 14 original cases), adapted to the module boundary, plus bridge / poller lifecycle each;
  `tests/critical-alert.test.mjs` (real router + module + content scripts in page-sim with a scripting fake that
  evaluates injected files: gating, multi-tab, wrong host, disable during queued/in-flight work, watchdog/reload,
  startup failures, worker restart, seed-silently) and `tests/alerts.test.mjs` (both modules through the real router:
  simultaneous polls on the same documents, independent keys/alarms/notifications/toggles/migration, interaction
  in-flight disable, interaction seed, combined watchdog, registry ownership). `tests/browser/alerts.browser.test.mjs`
  (disposable Vivaldi, fixture page + mocked Table API JSON via CDP Fetch, GET only): options import, one
  notification per new row, no duplicate across two tabs, synthetic outage → one health alert → recovery, disable
  stops polling and clears alarm/notification, re-enable without re-alert, test host has no alert scripts.
  `snMilo.runAlarm(name)` (worker console) dispatches an owned alarm immediately through the router.

## Alert migration

Alerts stay off until an explicit completion step; flipping the checkbox never completes it. While an alert is
pending (or seeding) the options page shows the reason and, below it, two separate actions. Both disappear once
the alert is `ready`.

1. **Import dedupe snapshot** (recommended): choose one or more snapshot files and/or paste JSON, then click
   *Import dedupe snapshot*. The page validates every snapshot (errors are shown, nothing is sent), the worker
   unions all entries into the existing set (never shrinks it) and marks the alert migrated (`method:'import'`) in
   one `storage.set`. The page reports the resulting entry count. Re-importing is idempotent.
2. **Fallback** (no old dedupe set available): pick one of two choices — there is no default — and confirm:
   - *Notify for currently matching items* (`notify-current`): everything matching on the first poll is notified —
     possible duplicate alerts.
   - *Seed the first successful poll silently* (`seed-silently`): the first successful poll is recorded as seen
     without notifications — can permanently suppress items never previously notified. Only a seed poll
     (`seedOnly`) runs until the alert feature calls `completeSeed()`.

**Snapshot JSON format** (one object, or an array of objects, per file/paste; several are merged):

```json
{"schema": 1, "feature": "critical-alert", "key": "seenMatchesV4", "entries": ["<sys_id>|<priority>|<state>|<account>", "…"], "exportedAt": "2026-10-20T10:00:00.000Z"}
{"schema": 1, "feature": "interaction-alert", "key": "seenInteractionsV1", "entries": ["<sys_id>", "…"], "exportedAt": "…"}
```

`key` must be the exact source dedupe key; every entry must match the source format (32-hex sys_id, plus the
`|priority|state|account` suffix for critical alerts); `exportedAt` is optional. An empty snapshot is rejected
(use a fallback instead). Caps (no `unlimitedStorage` permission; `chrome.storage.local` has a 10 MB quota): at
most 50 000 entries, 512 characters per entry, and 4 MiB (JSON) for the resulting set (existing ∪ imported), and 5 MiB for both dedupe sets combined (the
10 MB `storage.local` quota is shared by every key);
violations are rejected with a specific error and nothing is written. Real sets are far smaller (interaction
entries are 32 chars, critical entries ~60–150).

**Exporting from the ORIGINAL extension (read-only).** Open `chrome://extensions` → the old extension → *Inspect
views: service worker*, and run in that console (it only reads `chrome.storage.local`; `copy()` is the DevTools
console utility that puts the JSON on the clipboard — save it as a `.json` file or paste it into the options page):

```js
// old critical-alert extension: key seenMatchesV4
// old interaction-alert extension: use feature 'interaction-alert', key 'seenInteractionsV1'
(async (feature, key) => {
  const value = (await chrome.storage.local.get(key))[key];
  if (!Array.isArray(value)) throw new Error(`${key} is ${JSON.stringify(value)}; nothing to export (use a fallback)`);
  const snapshot = JSON.stringify({schema: 1, feature, key, entries: value, exportedAt: new Date().toISOString()});
  copy(snapshot);
  console.log(`copied ${value.length} ${key} entries (${snapshot.length} bytes)`);
})('critical-alert', 'seenMatchesV4');
```

The same operations are available from the sn_milo worker console (`chrome-extension://<id>/background.js`):
`snMilo.importDedupe('critical-alert', [snapshot, …])` and `snMilo.chooseFallback('interaction-alert',
'notify-current' | 'seed-silently')`. The options page sends the router control messages
`{feature:'milo', type:'import-dedupe', target, snapshots}` / `{feature:'milo', type:'choose-fallback', target, choice}`;
its logic lives in `shared/options-view.mjs` (unit-tested in `tests/options.test.mjs`).

## Timecard

Files in `features/timecard/` keep the original names and load order (`config.js` is generated from `config.json` and
gitignored; `config.example.js` is the sanitized example). Two static manifest entries, both MAIN world and on **both**
the production and the test origin (the original match order, test first):

| Entry | Matches | Timing / frames | Files |
|---|---|---|---|
| `timecard-overlay` | `<origin>/*` | `document_idle`, top frame | `config.js core.js quick-actions.js content.js` |
| `timecard-native` | `<origin>/task_time_worked.do*` | `document_start`, **all frames** | `config.js core.js quick-actions.js native-compat.js native-actions.js` |

- **Cutover and existing tabs.** Disable the original timecard extension **before enabling Milo**: both share
  `window.__snTimecardApp` in MAIN world, so they cannot safely coexist (an original open controller may be retained
  without Milo's settings subscription). Finish or save any draft before cutover. Tabs already open when Milo is
  installed or updated need a page reload, or the explicit **apply-update** developer tool below to reinject the
  overlay/settings scripts without reloading. An open Milo overlay keeps its controller and draft during reinjection;
  native-form `document_start` fixes are not retroactively applied to already-loaded forms.
- **The toggle controls the overlay/launch UI only.** Native Time Worked form compatibility (`native-compat.js`,
  `native-actions.js`) is a static, always-on entry with no settings dependency: directly opened native forms, overlay
  frames and forms reloaded/updated mid-session keep the early `document_start` fixes whether the toggle is on or off
  (and without any dynamic re-registration). The options label says so.
- **Deliberate delta from the originals:** only the `window === window.top` exclusion was removed from
  `native-compat.js` and `native-actions.js`. The exact configured-origin and `/task_time_worked.do` path guards
  remain. Direct top-level native forms now receive the same missing-placeholder API and authorized footer-action
  alias/quick-action UI as embedded forms. Existing native placeholder APIs and real header actions are preserved;
  initialization never sets form values or submits. Existing user-click quick-action fill/submit behavior,
  native invoice validation, business logic and configured production-use permissions are unchanged. The overlay
  toggle still does not disable native compatibility. Unit tests cover top-level initialization/reinjection with
  the overlay off; fixture-browser tests cover both origins and fresh native documents after page reload.
- **Settings handshake.** `content.js` has no extension API bindings. It subscribes to `window.__snMiloMainSettings`
  (`shared/main-settings.js`, loaded earlier in the same world) and stays inert — no polling, observers, launch button
  or overlay — until effective state reports `timecard` enabled. A missing helper also means inert.
- **Draft-preserving disable.** Disable removes the Add-timecard button and stops polling/observers, but an open overlay
  (clean or dirty) is **retained** until the user closes it (Close / Escape with the usual unsaved-draft confirm, or the
  native form navigating away after the user submits). `open()` is refused while disabled; closing a retained form
  does not bring the launch UI back; re-enable restores exactly one button and keeps the open form. `stop()` (full
  teardown, `close(true)`) is used only by reinjection of a controller that has no open form; reinjection while a
  form is open keeps the old controller (and its settings subscription) as before.
  `window.__snTimecardApp.status()` adds `enabled`, `retained` and `note` (`'disabled; current form retained until closed'`).
- **Options status line.** `features/timecard/background.mjs` implements `describeStatus(ctx)`: when the options page
  asks for status and the feature is disabled, the worker runs a read-only `func` probe (`scripting.executeScript`, MAIN,
  top frame, no files) in at most 20 open production/test tabs, with 10 concurrent waits and a 1500 ms timeout per tab.
  It reports retained forms with a tab count, plus uninspected/failed/timed-out tabs as "not checked"; if none of the
  checked tabs has a form but some remain unknown, it reports that uncertainty instead of implying none are open.
  Chrome calls cannot be cancelled on timeout; late answers are ignored. Pull-based on purpose: no per-tab state
  to go stale, no MAIN→worker channel.
- Tests: `tests/timecard/*.test.mjs` (the original eight files, 54 cases, plus `lifecycle`, `native-lifecycle`),
  `tests/timecard-status.test.mjs`, policy/origin agreement in `tests/manifest-policy.test.mjs`, and
  `tests/browser/timecard.browser.test.mjs` (disposable browser, fixtures only, non-GET fails the test, nothing is ever
  submitted).

## Developer tools (load / apply-update)

Both scripts target a running Chromium-family browser started with `--remote-debugging-port=<port>` and
`--enable-unsafe-extension-debugging`. Nothing is assumed: the endpoint comes from `--cdp http://127.0.0.1:<port>` or
`SN_MILO_CDP` (loopback only; 9333 is not special and may be your real browser).

```
SN_MILO_CDP=http://127.0.0.1:<port> node scripts/load-extension.mjs --yes     # load/reload only
SN_MILO_CDP=http://127.0.0.1:<port> node scripts/apply-update.mjs  --yes     # load/reload + reinject open tabs
```

Order: (1) generation gate (`ensureGenerated`: generate, then `--check`) — a failure exits 1 with **zero** CDP/network
calls; (2) endpoint; (3) `GET /json/version`, prints the browser product/version and **stops without `--yes`**;
(4) `Extensions.loadUnpacked` of this repo root (the generated combined `manifest.json`; the extension id is
discovered, never hard-coded) and `Extensions.getExtensions`: it must be enabled with a version equal to
`manifest.template.json`'s (the generator already enforces template == `package.json` == generated manifest). Equality
does **not** prove a bump: semver bumps are made by hand in the two committed version fields
(`manifest.template.json`, `package.json`); (5) apply-update only: evaluates `await snMilo.reinjectOpenTabs()` in the
extension's own service worker (`shared/reinject.mjs`).

`--root DIR` is an advanced/test override: it generates and loads **DIR**, not this checkout, and checks
that directory's template/package/config. Use only a reviewed complete extension tree; this is not a browser
sandbox or an authorization bypass. It is mainly used by tests with sanitized temporary inputs. Normal
updates should omit it. `--help` documents all flags.

Reinjection is derived from `shared/script-policy.mjs` (entries with `reinject: false` — the document_start
native-form patches — are skipped): per open tab whose URL origin *exactly* equals a configured origin, each policy
entry matching the **frame's own** origin + path becomes a `scripting.executeScript({files, world})` targeting
explicit document IDs. `allFrames` is used only for a read-only URL/origin inventory, never file/CSS injection;
blank, srcdoc, blob, opaque and foreign documents are excluded. All-frames entries may reach eligible subframes;
other entries are top-frame only. The test host gets shared settings, the timecard overlay and the Informatica button only; 
alerts and KB only reach production, KB only `/kb` and `/kb?*`. KB's gated CSS is installed even while disabled,
after setting its off attribute, so enabling later works without reload. A matching `removeCSS` before each
programmatic insertion prevents stacking across passes; it never removes declarative CSS.

Before **either load or update calls `Extensions.loadUnpacked`**, an explicit extension inventory finds the
existing install by path. Its still-live worker first acquires a **global, persisted maintenance gate**, serialized
with Informatica run-start authorization, **before querying any tabs**. Every new run requests one worker lease
before its first workflow step (no per-write round trip); the lease persists until its actual promise settles.
Existing leases refuse maintenance, never cancel a run. Once acquired, the gate denies starts from ALL tabs,
including newly opened tabs and replacement/navigation documents, not just inventoried worlds. The worker then
also reserves old ISOLATED controllers, preserving the same-world/late-document_idle interlock. Missing worker,
unsupported protocol, failed storage, busy or unknown controllers fail closed. A genuinely fresh installation
may load after inventory establishes absence. An older worker without this protocol cannot be safely updated by
these tools: finish workflows, close all matching documents, and only then explicitly reload via the browser UI.

The `miloInformaticaGateV1` storage record survives reload/worker restart. Old worlds remain locally locked and
new worlds cannot obtain a lease until the developer tool confirms loaded version and successful reinjection,
then releases the same owner. **Loading over an existing install therefore also reinjects, even via `npm run load`.**
A reload timeout, failed version check, failed/timed-out reinjection or unconfirmed cleanup retains exclusion;
there is no automatic expiry or unsafe retry. Ordinary pre-load failure releases after confirmed local cleanup.
Worker-only reinjection still reserves each old controller and pins document IDs; direct same-instance content
reinjection preserves a running controller.

**Inspected recovery (worker console only):** read `await snMilo.informaticaMaintenance.status()`. A stale run
lease may remain after navigation, a killed document, or lost release; that deliberately prevents update rather
than guessing that in-flight Save/Post completed. First stop all pending developer/CDP update work, inspect
possible completed writes, finish any active workflow, and close or explicitly refresh **every** production
Informatica document (including background tabs) so no orphan can resume. Then call
`await snMilo.informaticaMaintenance.recoverAfterInspection()` and perform a fresh explicit update pass.
Never call recovery merely because a timer elapsed; never clear storage while an old run/update can resume.
If only a completed update marker remains, verify there is no pending injection and reinjection succeeded before
`await snMilo.informaticaMaintenance.release('<owner from status>')`. These APIs are not runtime-message routes.
Ordinary failures release reservations; unconfirmed reloads retain the interlock, and timed-out reinjection holds
it until pending browser work actually settles. An indefinitely pending operation requires inspection rather than
an automatic retry. This is exclusion, not rollback: no completed or in-flight writes are undone.
A dirty timecard overlay remains preserved by `content.js`'s reinjection semantics.
No tab is reloaded or navigated, nothing is clicked or submitted. The tab and each document URL are re-checked
before each step; document IDs prevent injecting into a replacement document during a navigation race.

Browser operations have a 5-second step timeout and a 30-second per-tab budget. A timeout stops that tab and
continues other tabs, recording an error; the worker's one-pass singleton clears after success, failure or timeout.
**Chromium cannot cancel pending `executeScript`/CSS work**: it may still finish later. There is no automatic retry;
inspect the affected tab before requesting another pass. CDP connection establishment is bounded to 5 seconds,
calls to 20 seconds (the reinjection evaluation to 60 seconds); socket close/error rejects pending calls immediately.
CLI failures exit 1 with an explanation rather than an uncaught stack trace. These limits do not turn form edits
into transactions or undo any work already performed.

Not ported from the old timecard `scripts/`: `restart-inspection-browser.mjs` (closes/relaunches your browser),
`invoice-flow-test.mjs` / `live-check.mjs` (real submissions), `repair-existing-native-actions.mjs`,
`verify-incident-ui.mjs`, and the ad-hoc inspection probes.

## Private config convention

`config.json` (gitignored) holds the instance policy: exactly one `production` and one `test` instance,
`{origin, mode, enableSubmission}` each, origins exact `https://<name>.service-now.com`. Copy
`config.example.json` and edit. The template uses `{{PRODUCTION_ORIGIN}}` / `{{TEST_ORIGIN}}`; literal hosts in
the template are rejected. Generated artifacts are gitignored and never hand-edited. Generation validates the
whole output set (versions equal, host grants exactly the configured origins, every match pattern on a configured
origin) before replacing any file via temp-file + rename; if a rename fails mid-set the already-replaced files are
restored and the error propagates (the gate stays closed). Load/update/package code must call
`ensureGenerated()` / `withGeneratedArtifacts()` from `scripts/generate-config.mjs` before any browser call; a
failure throws first. Version bumps are made in `manifest.template.json` **and** `package.json` together.

## Test safety rules

- Unit tests run with `--import ./tests/setup/no-network.mjs`: `fetch`, `http(s).request/get`,
  `net`/`tls` connects, `dgram` and `WebSocket` throw.
- Browser tests launch only their own `/usr/bin/vivaldi` (`--headless=new --mute-audio --disable-vivaldi
  --enable-unsafe-extension-debugging`, fresh profile under `$TMPDIR`), refuse ports 9333/9222 and any port that
  already has a listener, intercept every request of every resource type and fulfil or fail all
  `*.service-now.com` traffic (plus a `--host-resolver-rules` DNS backstop), and kill only their own PID.
  Extension IDs are discovered from `Extensions.loadUnpacked` / `Extensions.getExtensions`, never hardcoded.
- Never touch production state from tests; no live probes are part of any npm script.
