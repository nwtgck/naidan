# PWA updates: one application update, independent offline preparation

PWA means Progressive Web App; a build ID is a build identifier, not an ordered
version number. The executing page's build is the source of truth for that page.

## Startup and build identity

`AppAuxiliaryUi` lazily mounts `PWAManager` behind the existing post-startup and
onboarding gate. The manager still waits for Vue's `nextTick` and the two-frame
paint helper before importing the runtime. Registration and offline preparation
must not block normal startup. Browser-initiated update checks are independent.

`createPWABuild()` generates one ID and supplies it to BOTH the application define
and the worker build. The runtime explicitly passes the compiled page ID to
`createPWAUpdateController`. Neither package version, controller identity nor a
previous button click stands in for the code that actually started.

The read-only `NAIDAN_PWA_BUILD_ID_V1` exchange works during installation. Unknown
identity is not a different build. Requests are bounded, validate replies and
close their ports on success, failure and cancellation. Legacy workers may not
understand the exchange; do not invent their identity.

## Application update classification

An identified worker with the same build as the page can NEVER become that
page's application-update candidate, including during installation or failure.
Its offline preparation is independent of a later C update. Do not hide C merely
because a same-page B worker is also present.

An ID mismatch alone does not establish a successor. The controller recognizes
successors of a known page lineage, and uses a registration update check to
resolve ambiguous startup slots. The unchanged old active worker does not become
an update simply because `update()` returned. IDs are only compared for equality;
observation sequence is used to distinguish a new observation from falling back
to an older slot after an installer fails.

A confirmed different failed candidate can remain an explicit network-update
choice. An unknown live replacement suppresses that choice until identified.
Late identity replies cannot restore removed workers. There is no persistent
"already updated" flag, historical build database or polling/reload timer.

## The explicit update transaction

Only the user-operation path has reload capability:

1. Re-read the candidate and registration at click time.
2. For a prepared candidate, send `SKIP_WAITING` and await `activated`. An already
   active candidate needs no message; an activating candidate uses the same wait.
3. Otherwise request `NAIDAN_PWA_USE_NETWORK_V1` from the current controller and
   await its durable acknowledgement. If controller or active changed during the
   exchange, reject rather than treating A's reply as a guarantee about B.
4. Request one full document reload. Concurrent callers share the transaction.

`activate-update.ts` bounds the explicit activation wait at 15 seconds. One-shot
worker requests are bounded at 5 seconds. These are not installation deadlines.
A timeout cannot undo work already delivered to the browser. Failure preserves
retry and original error details in the event log.

`reload-page.ts` preserves the full-document reload even at a hash route. Do not
replace it with same-document navigation. Availability and the user's in-flight
operation remain separate in `usePWAUpdate`; silent offline preparation does not
enter its applying state. The notification component needs no suppression flag.

## Automatic completion belongs to the active worker

When B is executing and the exact B worker has finished installation, the page
asks its current active controller to complete offline preparation. This path
cannot reload and cannot create a B update button. The acknowledgement means the
handoff was armed, not that activation or offline control has already completed.

The active worker owns the download session map for all its clients. It confirms
the requester is actually controlled by it, identifies the exact waiting worker,
then waits for every generated-file download session to finish. It does not infer
scope-wide idleness from a page's local flag. While sessions remain busy, more
sessions may be admitted. Once the map becomes empty, it closes admission and
sends a build-bound `NAIDAN_PWA_ACTIVATE_BUILD_V1` request in the same event turn.
The waiting worker accepts this command only from its current active worker and
only for its own build. Pages cannot bypass drainage through that command.

An identity reply for a replaced worker cannot activate its successor. Once a
handoff is sent, a timer must not reopen old-worker admission: delivery could be
late. A replaced/redundant target or synchronous send failure releases the gate;
a newly active worker starts with open admission. The old manual `SKIP_WAITING`
path remains an explicit user operation, not silent automatic completion.

This coordination is live worker state, not a durable transaction across engine
termination. Browser/process shutdown, lost worker execution, network failures
and storage eviction are not guaranteed recovery cases. In particular the Node
harness does not prove arbitrary termination/restart orderings. No infinite
worker-lifetime promise or new permanent coordination store is introduced.

## Precache lifecycle and other clients

Workbox still installs the full generated manifest. The large shared precache is
not copied per generation. There are two sides to protecting concurrent writes:

- If C is already installing when B activates, B skips obsolete-entry cleanup.
- If B is already activating when C starts, C waits for that activation to finish
  before calling Workbox's install/write path.

A later uncontended activation cleans up obsolete entries. Skipped cleanup may
leave old entries until that activation; it is not a promise of immediate storage
reclamation. The coordination requires participating workers. It cannot change
old deployed worker code or make partial server deployments atomic.

A worker transition affects the application registration, not just one tab. No
other tab is automatically reloaded and `clients.claim()` is not introduced.
Do not equate that with guaranteed compatibility for every old tab's delayed
resource request. On first installation, activation and claiming an already
uncontrolled document remain distinct.

## Network mode and generated downloads

The update worker installs the local stream-download handler before precache and
network routing. The reserved `__naidan_download__/` root, including invalid and
expired requests, stays local. Unrecognized message ports belong to their own
protocols and must not be closed by the update handler.

Network opt-in remains one record per application scope containing the current
worker's build ID. Persist it before acknowledgement. Same-origin, in-scope GET
requests then use `cache: 'no-store'`. All clients of that generation share this
network dependence; model responses and foreign origins are not wrapped. The new
worker starts cache-first. A mode-read failure logs the original error and uses
the network rather than presenting stale cached HTML as a successful update.

No conversation, settings, model, IndexedDB, OPFS or localStorage data is cleared.
No registration removal, all-tab reload or broad application-cache purge is used.

## One-time migration from workers without handoff support

After the first network update into this implementation, the SAME B notification
is suppressed even if the active old worker has no identity/handoff protocol.
However, that legacy worker cannot expose or drain its private download sessions.
The completion request therefore times out without blindly forcing activation.
B remains usable online; ordinary activation can occur after ALL clients using
the old registration close. No second B update button is created as a workaround.
Automatic no-second-action completion applies once the active worker also
supports the handoff. This is a compatibility limit, not a claim that the first
legacy transition already has the same completion behavior.

Still older workers lacking the network command itself retain their old explicit
prepared-update path; a network request timeout cannot retrofit that protocol.

## Automated checks

The dedicated PWA configuration runs Node/Vue tests and real generated Workbox
worker code, without a browser. Tiny A/B/C fixtures use the actual page build
constant replacement. Registration and caches survive simulated page reloads;
production page controllers are recreated, and fetches use their actual modeled
controller rather than directly choosing the convenient new worker.

The tests cover same-build notification history, A-to-B-to-C, legacy failure,
stream drainage including the consumed acknowledgement, stale responses,
controller replacement, first-install non-claiming and both cache-race orders.
Removing the drainage guard or either cache-order guard must fail a regression.
The harness models native boundaries only, not application decisions. It is not
proof of every real engine's scheduling, process death or navigation behavior.

Use path-filtered checks during local development. These changes do not require
or introduce browser setup, browser fixtures or browser automation in this repo.
