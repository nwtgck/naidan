# Naidan Docs

Docs live beside the application source but have an independent build. The
production output is complete static HTML, not a second single-page application.
The homepage follows the documentation prototype: an explanation of the design
intent, implementation details, and links to concrete features. Its demonstrations
reproduce the current application’s layout, colors and important interactions.
Docs owns these independent presentation replicas: intentional duplication keeps
them separate from application UI components, stores and inference runtimes.
Their interface labels and sample content follow the page language.
See `site/demos/README.md` for their source counterparts and maintenance rules.

## Commands and ownership

Run these commands from the repository root.

```sh
npm run dev
npm run build:docs
npm run typecheck:docs
npm run test:docs
npm run lint:docs
```

The normal development server serves the app at `/` and Docs at `/docs/` on the
same port. Docs initialize lazily on the first Docs request. The normal application
`build`, `build:all`, Hosted ZIP and Standalone builds do not build or package Docs.
The dedicated Docs build writes to `docs/dist/`, not the application's `dist/`.

The normal test run excludes the Docs suite. `test:docs` runs plain `vitest run` with a small independent Vitest config.
It exercises actual Vite builds and development requests without loading model
artifacts or building the application. Docs are included by the normal `eslint .` invocation, with the independent Docs
TypeScript project. `lint:docs` runs the same rules for Docs and the development
bridge only. CI runs the same `npm run lint` command with a 6 GiB Node heap
limit. Docs, string catalogs and the development bridge remain part of the normal
lint target.

## Shared development and production rendering

The following files own the pipeline.

| File | Responsibility |
| --- | --- |
| `site/routes.ts` | Supported languages and explicit page IDs, paths and sources |
| `site/messages.ts` | TypeScript contracts for locally authored page and demo copy |
| `build/virtual-modules.ts` | Server-only page registry and native style collection entries |
| `build/compiler.ts` | Shared Vue/Vite compiler configuration |
| `server.ts` | Fresh Vue application and isolated language data for each render |
| `build/html.ts` | Shared jsdom document composition and validation |
| `build/dev.ts` | Request-time rendering and native development asset URLs |
| `build/production.ts` | Native client/server builds, manifest assets and static output |
| `../build/docs-dev-bridge.ts` | Serve-only bridge into the existing app development server |

Both environments compile the same Vue sources and use the same `renderPage` and
`renderDocument`. The asset adapters intentionally differ: development has native
source URLs and the Vite reload client; production has hashed assets. HTML byte
identity is not promised. Integration tests compare document bodies and scoped
style IDs while accounting for hashed image URLs, and request each development
stylesheet through Vite's middleware in memory to verify that it is served as
CSS rather than JavaScript. They do not open an HTTP port.

The bridge has a separate middleware-mode Vite module graph but uses the existing
HTTP server. It does not reuse the app's inference or Tailwind plugins. A missing
Docs page or asset returns a Docs error, not the app's HTML fallback. The bridge
recreates its child after Docs compiler or route edits; an edit to the bridge
plugin itself requires restarting the app development server.

## Why there are virtual modules

`virtual:naidan-docs/registry` loads only the requested page component and
language's locally authored strings during a render. An error in another guide
does not stop the current page in development; the static build renders every
page and still fails if any page is broken. The registry is server-only; importing
it from a client entry fails the build. English objects define the TypeScript
copy shapes; other locales use `satisfies` against those derived types. Local
strings do not need runtime Zod validation. Each render gets its own copy of the
messages, with no fallback to another language.

`virtual:naidan-docs/styles/<page-id>` uses ordinary imports and exports to keep
that page's layout and nested Vue dependencies in Vite's native client graph.
Vue and Vite own scoped IDs, CSS extraction, CSS imports and `url()` assets.
There is no custom scoped-ID algorithm or regular-expression CSS/HTML rewriting.
The documented plugin-vue `componentIdGenerator: 'filepath'` option keeps IDs
consistent across the three compiler environments.

The style entries intentionally re-export components, and the client build keeps
entry export signatures. Removing either can make tree-shaking discard styles
used only in static HTML. These collection entry scripts are build plumbing and
are not loaded by static pages. The output can contain unused collection scripts;
only explicitly discovered runtime entries are attached to a document.

## Adding a page

Use one Vue component for both languages. Add a route in `site/routes.ts`, a
canonical English copy object in `strings/<page-id>/en.ts`, derive its type in
`site/messages.ts`, and check `ja.ts` with `satisfies` against that type. Add matching
copy props to the page component and link it from the relevant navigation or
feature list.

The existing examples exercise different delivery requirements.

| Page ID | Behavior in production |
| --- | --- |
| `index` | Static homepage, native checkbox-based theme choice |
| `files/privacy` | Static text and CSS |
| `work/boundary` | Nested OS/browser/Naidan boundaries and permitted localhost API path |
| `chat/branching` | Static text plus one hydrated Vue demonstration |
| `work/browser-shell` | Source-derived shell demonstration and permission guide |
| `run/standalone` | Explorer double-click to browser walkthrough, download and setup guide |

Use normal CSS classes in Docs; do not copy app Tailwind class names into this
isolated compiler. Page-specific `<style scoped>`, imported styles and local
asset imports go through Vite. Keep reusable Docs components inside `docs/`.

The dictionaries are build inputs. A static page does not fetch a runtime locale
catalog. The language switch is an ordinary link to the corresponding page.
Only `/docs/` selects the browser language at runtime. It contains two inert,
pre-rendered home templates, not client-side translation catalogs. A small classic
head script mounts one template in place; there is no second navigation or
pre-redirect language screen. Development and production use the same compiled
bootstrap and the same templates. Explicit language URLs remain plain static HTML.

When JavaScript is disabled or blocked, the root shows explicit language links.
The bootstrap marks startup before the body is parsed, and clears that marker on
completion or failure. A watchdog restores the fallback on unexpected failure.
This avoids a wrong-language flash; loading the stylesheet or bootstrap can still
involve a short wait. It is not a guarantee of instant content on a slow network.
Only static components are allowed in the language-neutral home; build validation
rejects islands there until a deliberate activation contract is implemented.

## Interactive demonstrations

Put interactive components under `islands/`, give the data passed to the browser
an island-owned parser at its serialization boundary, and register the client
entry in `build/ids.ts`. The current
branching example uses `data-docs-island` and escaped `data-docs-props` attributes.
The HTML compositor discovers and validates these with jsdom. Extend that
registry and validation together when adding a new demonstration type.

A component can be pre-rendered without making the whole page interactive.
Only discovered island entries and their transitive styles are attached. The
browser receives the selected language's required props, not every page's
translations. Initially disabled demonstration controls become available after
successful hydration. With scripts disabled or startup failure, the explanation
and initial demonstration remain readable.

Static components reject event directives, model bindings, inline handlers,
`v-html`, and active embedded documents through Vue's parser. Generated documents
are also parsed and validated with jsdom. This is an authoring guard, not an
execution sandbox for untrusted Vue or TypeScript. Build inputs are reviewed
repository code and can execute during a build.

## Publication and the app service worker

GitHub Actions builds the app and Docs independently. Only the three Cloudflare
Pages deployment jobs require both successful builds and copy the Docs-only
artifact into `dist/hosted/docs/`. No combined Hosted ZIP or GitHub artifact is
created. A nested `docs/404.html` provides a Docs-specific missing-page response
without adding a root 404 that changes app routing. Existing Content Security
Policy rules are not broadened for Docs.

The application service worker leaves same-origin `/docs` and `/docs/` requests
to the browser, including queries and assets, before app fallback/cache logic.
It does not make Docs an offline app. An already installed older app worker may
need its ordinary update lifecycle before the new exclusion takes effect.

## Verification boundaries

The integration suite covers localized rendering, language isolation, native
nested/scoped CSS and image assets, hydration, navigation, malformed island
payloads, server-only imports, stale outputs and lifecycle cleanup.
Tests create disposable site fixtures; production code uses ordinary explicit
resource cleanup. Tests call library APIs directly and must not execute external
commands or start child processes, including through helpers. There are no
resource-management polyfills.

These initial pages are a base for adding features, not a complete guide catalog.
Site search, real app screenshots and offline Docs support are not implemented
here. Inspect current application source and tests to maintain the replicas;
screenshot capture is not a prerequisite for Docs work or builds.

## Link and motion contracts

The shared DOM compositor marks every external HTTP(S) link with an inline SVG
external-link icon and a localized accessible suffix. Same-site links keep normal
navigation styling. An interactive island must use `site/ExternalLink.vue` for
external links so server composition does not add children that hydration removes.
No CSS-generated text, remote icon font or hover-only indicator is involved.

Every guide has automatically running, explanatory CSS motion. Users can pause
all demonstrations with the page control, and reduced-motion preferences yield
stationary, complete diagrams. Animation does not initiate a model download,
permission request or shell command. The branching demonstration is the only
Vue-hydrated example; its animation follows the selected branch without changing
the user's selection or announcing a stream of automated updates.
