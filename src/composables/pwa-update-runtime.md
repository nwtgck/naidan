# PWA updates: two paths, one explicit reload

## Startup contract

`AppAuxiliaryUi` lazily mounts `PWAManager` behind the existing post-startup and
onboarding gate. The manager waits for Vue's `nextTick` and the existing two-frame
paint helper **before** importing the runtime. This gives Sidebar and the routed
chat screen a paint opportunity, not a physical-display guarantee. Hidden tabs
can defer it. Do not move registration to `main.ts` or the startup shell.
The browser's own update checks are independent of this application timing.

The runtime lives for the page, not the Sidebar. Register only once. Neither
registration nor offline preparation blocks normal startup or interaction.

## The complete update decision

`src/logic/pwa/update-controller.ts` has one `apply()` transaction:

1. Re-read the registration at click time, using `preparedWorker()` for the same
   decision as the button. Initial offline installation is NOT an app update.
2. If a prepared update exists, send `SKIP_WAITING` and await **activated**.
   A worker another tab already moved to active/activating uses the same wait.
   An already activated worker needs no message.
3. Otherwise, ask the **current controller** to use the network. Wait for its
   acknowledgement that the opt-in was saved.
4. Request a full document reload using `location.reload()` in either path.

`activate-update.ts` bounds activation at 15 seconds; `worker-request.ts` bounds
network acknowledgement at 5 seconds. Errors/abort close listeners/ports and
permit retry. These limits do NOT assume installation finishes within that time,
and cannot undo browser work already requested (such as a late mode write).
Update errors retain their original details in the application's event log.

`reload-page.ts` must never use `location.replace(currentHref)`, which can be a
same-document navigation at a hash route. Optional removal of the old
`__naidan_update` parameter must not prevent the actual reload if history editing
fails. All other query parameters, routes and history state are preserved.

The shared store holds availability and in-flight state separately. New
candidates are retained during a click; `finally` clears in-flight state even if
navigation is cancelled. There is no automatic activation, page-version
negotiation or timer-based reload. A stopped installer is not a synthetic Error;
normal supersession is not reported as a preparation failure.

## The worker and its effect on other tabs

`pwa/sw.ts` contains the complete custom worker. Workbox installs the **full
automatically generated manifest** from `build/pwa.ts`, retaining the original
ZIP/map exclusions and size limit. No minimum-resource list is maintained.

The only custom command is `NAIDAN_PWA_USE_NETWORK_V1`. A same-origin, in-scope
window must supply a reply port. The worker stores its own private build ID in
ONE record in `naidan-pwa-network-mode:<scope>`, then acknowledges success.
Afterwards, in-scope, same-origin GET requests use `fetch` with `cache: 'no-store'`.
Foreign origins, sibling scopes and non-GET requests are not intercepted. This
avoids wrapping model/API responses and streams. Installation fetches are native
Workbox fetches and still prepare the full application.

This mode belongs to a **worker generation and application scope**, not a tab.
All tabs/workers controlled by that generation become temporarily network-dependent.
There is no worker-parent inference or per-client map. A new worker has a different
private ID, so it starts cache-first after its FULL installation and activation.
The page does not receive or compare build IDs.

A failed mode write is not acknowledged; the page stays put. If the stored mode
cannot be read, log the original failure and use the network, rather than showing
stale HTML as a successful update or blocking a usable online application. There
is no old-cache fallback in that exceptional state.

No model/conversation/settings storage, IndexedDB, OPFS, localStorage or other
application's cache is cleared. No unregister or explicit app-cache deletion is
performed. Workbox's ordinary obsolete-precache cleanup remains. Old coordination
metadata is left untouched, not broadly deleted.

## Offline restoration and migration

After an early network update, press the button **again when preparation is
complete** to activate the prepared worker and restore offline operation. Closing
the old clients can also allow normal browser activation. No inferred page version
silently authorizes activation. Another full reload is an intentional tradeoff.

There is no HTML probe or promise of uninterrupted access after an early click.
Connection loss or a partially deployed release may prevent the page from loading.
If offline preparation fails, the detected update remains an explicit online option;
original resource errors remain in the service worker console. The short existing
warning is kept below the button, but does not control update correctness.

Workers from the earlier per-client implementation do not understand the new
network command. The command times out during that one-time transition; the
prepared update path remains available. Already-open old pages keep their old
code and may need a normal browser reload to leave the old "applying" bug.

## Automated checks

`npm run test:pwa` runs only Node/Vue unit tests and generated-worker tests using
the production Workbox configuration. The dedicated config uses the real strings
and Tailwind transforms without model build initialization. No App/router/settings
replacement list is maintained. The generated-worker fixture consists of static
files, not a miniature browser application. Tests hold a new resource fetch,
validate opt-in acknowledgement, restart the worker, finish installation and
verify offline reads and unrelated-cache preservation.

Browser automation, browser fixtures and browser setup commands are deliberately
not part of this repository's PWA changes. The Node execution harness implements
native boundaries and cannot prove browser navigation/lifecycle behavior. The
normal full-app build and real-browser integration need separate verification.
