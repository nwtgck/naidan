# Post-paint updates with an explicit online transition

## Contract and startup ownership

`main.ts`, `startApp`, `MainApp`, and the existing post-startup/onboarding gate
remain unchanged. Hosted `AppAuxiliaryUi` owns the lazy `PWAManager`. It waits for
Vue `nextTick` and the existing two-frame paint helper **before** importing the
update runtime. This deliberately gives the real Sidebar and routed chat surface
a paint opportunity first. Do not move registration to the lightweight startup
shell or `main.ts`, or add a static registration import to the manager.

This is a paint opportunity, not proof of physical frame presentation. Hidden
tabs may postpone animation callbacks. Normal startup, navigation and interaction
never await this optional task. The browser can independently check an existing
service worker on navigation; the gate controls Naidan's own registration work.

The product decision is: clicking the update button may temporarily give up
complete offline availability in exchange for trying the server's new release
without waiting for every precache resource. The button explains this. Doing
nothing retains the ordinary full-precache behavior.

## No resource partition or application-cache deletion

`build/pwa.ts` shares production options with the generated-worker integration
test. It switches Vite PWA from `generateSW` to `injectManifest` so `pwa/sw.ts` can
own routing. The **same automatically discovered all-assets manifest**, 100 MiB
limit, source-map/locale-ZIP exclusions, and universal standalone ZIP remain.
New file types remain included by the broad glob; there is no handwritten list
of essential or deferred application resources.

`PrecacheController.precache` retains Workbox's full install/activate handlers.
Installation is not truncated, cancelled, or declared complete early. An active
old worker simply offers a separate network route to an explicitly opted-in
client while installation proceeds. No `unregister`, CacheStorage-wide deletion,
IndexedDB deletion, model-store deletion, OPFS removal or localStorage clearing is
performed. Normal Workbox obsolete-precache cleanup still runs on activation.

A small scope-specific `naidan-pwa-update-coordination-v1:*` cache contains only
client-to-page links and page build identifiers, never application resources.
Only obsolete rows **in this bookkeeping cache** are explicitly deleted. Links
persist across worker suspension. Missing rows are not negatively cached because
another worker version may create them concurrently. Known ordinary window clients
are memoized to avoid per-chunk bookkeeping reads on the initial rendering path;
a deliberate update performs a full navigation with a new client identifier.
On storage errors routing
falls back to live client URLs and in-memory links and logs a warning once.

## Update sequence

1. Obtain and observe the existing registration **before** awaiting `register`.
   A browser-initiated installation may already be downloading, and registration
   jobs must not delay the early notification.
2. Inspect current installing/waiting slots and future state changes. Do not call
   initial offline installation an update. A ready waiting version remains usable
   even if another version is installing.
3. Ask the current controller whether it supports the versioned online-update
   protocol. Legacy workers retain a disabled preparing state until installation
   finishes; never pretend that an unsupported early reload will work.
4. A supported preparing update offers **Reload to Update** immediately. On click,
   probe just the entry HTML with a random `__naidan_update` query, `cache: no-store`,
   a bounded timeout and redirects rejected. The old worker recognizes this probe
   and must not answer it from its precache. Failed HTTP, non-HTML or connection
   responses leave the old usable page in place and restore the action.
5. Navigate to that explicit URL, preserving ordinary query parameters and the
   hash route. Its document and attributable in-scope GET requests go directly
   to the network instead of the old application cache, including unversioned
   worker/runtime files. Responses retain their original security headers.
6. The page reports its compiled build identity. Full installation continues.
   When the waiting worker has **that exact identity**, it may activate without
   a second click: this only restores offline support for the version the user
   already chose. After matching control is confirmed, remove the marker with
   `history.replaceState`, and announce offline readiness without reloading again.
7. A different later build still needs an explicit update action. Do not silently
   switch a running page to a different version's unversioned resources.

A new random build identity is shared between the page and worker in each build;
package version is unsuitable because deployments can share a development semver.
Keep the stable protocol backwards compatible when adding fields.

If installation was already complete, use the usual `SKIP_WAITING` path and
navigate to the canonical URL only after that worker becomes the controller.
This path does not require an HTML probe and can work offline. Failed full
precaching does not remove an already-detected online update action.

## Lifecycle, ownership and limits

The runtime is page-scoped after startup; remounting Sidebar or `PWAManager` does
not register twice or discard update state. The shared store publishes action
and availability together, blocks duplicate clicks and restores failures only
when no newer state has superseded them. Native listeners and message ports have
explicit cleanup; capability/activation/probe waits are bounded. State enum
handling is exhaustive. Unrelated tabs are not automatically reloaded by this
controller. Service-worker activation itself remains registration-wide.

A network probe cannot promise that connectivity will survive the subsequent
navigation, or that a server deployment is atomic. A connection loss after it
succeeds can leave the selected page unusable until online again. That is the
explicit trade-off; do not conceal it with fallback to old HTML plus new assets.
The old application cache is not destroyed, although ordinary later Workbox
activation cleanup and browser storage eviction can remove obsolete resources.
The server/CDN must deploy coherent HTML/assets and preserve the query parameter.

Worker attribution is imperfect: normal worker-script requests can associate a
resulting client with its initiating page, but a blob/shared worker may not expose
an attributable owner. While an unfinished online-update window is live, such
**unattributed worker** in-scope requests conservatively use the network instead
of old unversioned bytes. This may temporarily affect another tab's unattributed
worker too. Ordinary window clients stay cached; do not claim absolute per-tab
isolation. Test the real model workers and browser families before deployment.

An existing client running a pre-protocol release still uses its old update
logic for the first transition. To validate this feature, first load a release
containing it, and then deploy a distinct second build.

## Test structure

No test replaces App/router/settings/theme imports with a maintained stub map.

- `PWAManager.test.ts`: real paint helper, only the typed runtime boundary mocked.
- `update-controller.test.ts`: native registration/lifecycle boundaries and typed
  message-transport replacement; no application dependency-graph substitutions.
- `worker-request.test.ts`: real Node MessageChannel transport, bounded failures.
- `pwa-update-runtime.test.ts`, notification/store/developer tests: real shared
  state and UI behavior, including actionable preparation and legacy fallback.
- `build/pwa-network-policy.test.ts`: native cache/client boundaries, suspension,
  cross-worker state updates, storage failure, worker attribution and scope rules.
- `build/pwa.test.ts`: production `createPWABuild` options, actual compiled worker
  and actual Workbox code. Two independent versions are built. A slow changed ZIP
  holds full installation open while the new document and unversioned runtime are
  served online. Full installation then completes and offline reads are checked.
  The Node worker harness implements browser APIs, not Naidan application modules.
  This is **not a replacement for real-browser lifecycle/inference validation**.

Run with the repository's normal dependencies:

```bash
npm run test:only-failed -- --maxWorkers=2 \
  build/pwa.test.ts build/pwa-network-policy.test.ts \
  src/logic/pwa src/logic/startup \
  src/composables/pwa-update-runtime.test.ts src/composables/usePWAUpdate.test.ts \
  src/composables/useAppPresentation.test.ts \
  src/components/PWAManager.test.ts src/components/PWAUpdateNotification.test.ts \
  src/components/DeveloperTab.test.ts src/components/AppAuxiliaryUi.test.ts \
  src/components/AppAuxiliaryUi.print-teleport.test.ts \
  src/App.test.ts src/MainApp.test.ts src/App.print-ownership-contract.test.ts
npm run typecheck
npm run lint
npm run build:standalone
npm run build:hosted
```

Real-browser acceptance: install build A, serve build B while delaying a changed
large ZIP, verify the button is usable after app paint but before ZIP completion,
and verify the displayed app actually changes to B. Exercise in-page/HTTP/blob
model workers and two tabs. Finish the ZIP and test all offline functionality
without a second reload. Also test failed probes, failed full precaching, a third
build arriving, a scoped deployment path, and reload with a still-present marker.
