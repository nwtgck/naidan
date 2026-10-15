# Naidan Docs

Docs live beside the application source but have an independent build. The
production output is complete static HTML, not a second single-page application.
The homepage follows the documentation prototype: an explanation of the design
intent, implementation details, and links to concrete features. Its demonstrations
reproduce the current application’s layout, colors and important interactions.
Docs owns these independent presentation replicas: intentional duplication keeps
them separate from application UI components, stores and inference runtimes.
Their interface labels and sample content follow the page language.
See `components/demos/README.md` for their source counterparts and maintenance rules.

## Commands and ownership

Run these commands from the repository root.

```sh
npm run dev
npm run build:docs
npm run typecheck:docs
npm run test:docs
npm run lint:docs
```

`build:docs` runs `typecheck:docs` before compiling the static output.

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

Production Docs code does not access browser persistence APIs directly except
for the existing theme and motion preferences' private read/write code in
`client/preferences.ts`, stored as `naidan_docs:settings`; its two storage calls
have local lint exceptions. There is no migration, fallback, or deletion for an
older key. HTTP cache, prefetch, and the browser back-forward cache are separate
from explicit JavaScript storage. Tests and test-support files are excluded.
The lint rule catches ordinary direct and destructured persistence access and
bans all computed access through `window[...]`, `globalThis[...]`, or
`self[...]` in production Docs code; it does not prove the absence of other
dynamic, reflective, or third-party effects.

## Shared development and production rendering

The following files own the pipeline.

| File | Responsibility |
| --- | --- |
| `navigation/routes.ts` | Supported languages, registered article IDs and derived paths and sources |
| `build/seo.ts` | Public Docs URLs, language alternates and sitemap XML |
| `messages/types.ts` | TypeScript aliases derived from canonical English messages |
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
language's locally authored messages during a render. An error in another guide
does not stop the current page in development; the static build renders every
page and still fails if any page is broken. The registry is server-only; importing
it from a client entry fails the build. English objects define the TypeScript
copy shapes; other locales use `satisfies` against those derived types. Local
messages do not need runtime Zod validation. Each render gets a shallow copy of
the article and common message dictionaries, with no fallback to another
language. Nested domain data in the common dictionary is read-only. Rich article
functions create fresh VNodes or arrays when called; they do not share mutable
return values between renders.

`virtual:naidan-docs/styles/<page-id>` uses ordinary imports and exports to keep
that page's layout, nested Vue dependencies, and approved rich-copy components
in Vite's native client graph. Article locale TSX modules stay server-only;
island-owned rich message modules can enter only their own island's client graph.
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

Use one Vue component for both languages. Add the article ID to
`navigation/routes.ts`; the ID determines its public URL and source directory.
Place the component in `pages/<page-id>/index.vue` and the canonical English
messages in `pages/<page-id>/messages/en.tsx`. Export `messages`, derive its type
in `messages/types.ts`, and check `ja.tsx` with
`satisfies typeof import('./en').messages`. Keep message keys flat and use
natural English `snake_case` names. `title` and `description` are fixed
metadata fields in that object. Plain text without arguments is a string literal
or template literal without interpolation; parameterized plain text uses an
inline function with an explicit `: string` return type. Rich messages and
language-dependent lists are inline functions that return fresh values. Prose
with inline links or control names returns fresh JSX VNodes. Render those
through `components/RenderText.ts` in the page. Static diagrams read the article's message
keys directly through one explicit prop, without a hand-written map of
same-typed strings. Keep article-specific assets and components in the same
article directory, and shared UI in `components/`.
Add typed messages and locale props to the page component and link it from the
relevant navigation or feature list through `docsHref`.

Reusable Chrome and search UI copy are authored once in
`messages/replica-chrome/{en,ja}.ts` and `messages/search-ui/{en,ja}.ts`.
The island loaders dynamically import only the selected locale's small modules.
`messages/common/{en,ja}.ts` imports its same-language groups as `chrome` and
`searchUi` and spreads their same scoped keys into the flat common `messages`
object for static pages. For example, `chrome_new_chat` and
`search_ui_open_search` appear unchanged in both places; there is no
string-to-string alias map. Article keys need no mechanical page prefix because
their file already supplies the subject. Navigation pages/groups and
search-purpose descriptions stay keyed by route or category as domain metadata.
Plain locale modules directly export a `messages` object with literal text or
inline functions with an explicit `: string` return type. TypeScript checks the
return type, while the source check limits syntax rather than proving purity.
Static Docs authoring does not import executable files as values from
elsewhere in this repository; type-only imports, assets and packages remain
available.

The existing examples exercise different delivery requirements.

| Page ID | Behavior in production |
| --- | --- |
| `index` | Static homepage, native checkbox-based theme choice |
| `file-access` | Static text and CSS |
| `browser-boundaries` | Nested OS/browser/Naidan boundaries and permitted localhost API path |
| `chat-branching` | Static text plus one hydrated Vue demonstration |
| `tool-browser-shell` | Source-derived shell demonstration and permission guide |
| `standalone` | Explorer double-click to browser walkthrough, download and setup guide |

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
The language-neutral home permits only the registered Docs search island inside
each inert language template. Its classic locale bootstrap mounts one template
before the search module hydrates at `DOMContentLoaded`. Build validation still
rejects every other island there. If scripts fail, the manual language links
remain visible and lead to the pre-rendered localized guides.

## Guide search

The header's search icon opens a native dialog; Ctrl+K and Cmd+K use the same
control. The dialog provides Escape, focus containment and background inertness.
The island restores the previous focus and scroll state on close. The trigger is
disabled in the static HTML until its client entry starts; the normal Guides menu
remains available without JavaScript.

Build and development derive a separate JSON index for each language from the
rendered title, description, headings and article prose of every registered
route. Demonstration content, navigation and mock controls are excluded. The
static build renders all
pages before writing the indexes; development generates an index only when it is
requested, so an unrelated page failure does not stop another page from rendering.
With an empty query, the dialog immediately shows five task-oriented starting
guides from the selected page's server-rendered `purpose` data. The JSON index
and Docs-specific module Worker are loaded only after the visitor enters a
nonempty query. The Worker parses and caches that language's index, searches
titles, headings and prose with Japanese substrings and normalized English
words, and ranks title and heading matches above body matches. Results contain
ordinary guide links and short text snippets. The island
ignores responses for superseded queries or a closed dialog. Clearing the query
restores the initial five guides without a Worker request.

The JSON fetched by the Worker and island HTML props are distinct serialization
boundaries with small parsers beside their consumers. Locally authored English
and Japanese dictionaries remain statically type-checked. Islands may import
their own small locale messages; there is no external locale or search service.

## Search metadata

Each generated page includes a static, absolute self-canonical URL and absolute
English/Japanese `hreflang` links. The language-neutral `/docs/` entrance has its
own canonical URL and is the `x-default` alternate for the localized homepages.
Guide pages link only their English and Japanese equivalents. The generated
`/docs/sitemap.xml` lists the entrance and every localized page with the same
language links. Development serves the same XML at that path. The Docs 404 page
has a `noindex` directive and no canonical URL. Public URLs use the single origin
in `build/seo.ts`; adding a route in `navigation/routes.ts` also adds it to the sitemap.
The public `robots.txt` advertises both the application and Docs sitemaps.

Guide prose and figure captions render visible app control names with
`components/UiLabel.vue` inside the localized JSX sentence. It emits an inert SSR
span. Keep commands, code, paths, technical identifiers and document metadata
as ordinary text; a control name is not a button or keyboard shortcut. Write
short JSX sentences and component props on one line when they fit naturally.

## Interactive demonstrations

Put interactive components under `islands/`. Keep a typed JSON payload and its
island-owned boundary parser in `contracts.ts`, define its ID and startup policy
with `defineDocsIslandSpec`, and bind the spec to a directly imported Vue
component in `definition.ts` with `defineDocsIsland`. The definition also has
a required `prepare({ payload })` callback that loads the selected locale's
island messages through `messages/loader.ts`. The shared host awaits it before
rendering the island on the server; client hydration awaits the same locale and
keeps the static HTML in place while loading. The island component reads the
prepared messages synchronously. In a static page, import
`components/DocsIsland.vue` and that factory, then pass the locale and any
required plain data once:

```vue
<DocsIsland :entry="branchingIsland({ locale })" />
```

The shared host renders the component and its serialized props from that entry.
The build creates a client entry for each registered island and attaches only
those found in the page HTML. Do not write `data-docs-island` or
`data-docs-props` by hand, add children or extra attributes to `DocsIsland`, or
import the raw interactive component into a static page. The HTML compositor
discovers and validates island markers with jsdom. Island components may use
shared Docs styles but cannot rely on parent Vue context or scoped CSS.

A component can be pre-rendered without making the whole page interactive.
Only discovered island entries and their transitive styles are attached. The
browser loads only the selected locale's small island message modules at startup,
not every article's translations. JSON props contain only the locale and data
the island cannot derive locally. Initially disabled demonstration controls
become available after successful hydration. With scripts disabled or startup
failure, the explanation and initial demonstration remain readable.

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
When editing localized prose, compare rendered output with earlier pages to
catch missing information, changed instructions, and incorrect links. Wording
and sentence order may improve independently in each language; exact old text
is not a correctness requirement.
Tests create disposable site fixtures; production code uses ordinary explicit
resource cleanup. Tests call library APIs directly and must not execute external
commands or start child processes, including through helpers. There are no
resource-management polyfills.

These initial pages are a base for adding features, not a complete guide catalog.
Real app screenshots and offline Docs support are not implemented here. Inspect
current application source and tests to maintain the replicas;
screenshot capture is not a prerequisite for Docs work or builds.

## Link and motion contracts

Use `components/DocsLink.vue` with a registered page ID for article links in Vue
templates. The build rejects native `<a>` tags outside the link components.
The shared DOM compositor marks every external HTTP(S) link with an inline SVG
external-link icon and a localized accessible suffix. Same-site links keep normal
navigation styling. An interactive island must use `components/ExternalLink.vue` for
external links so server composition does not add children that hydration removes.
No CSS-generated text, remote icon font or hover-only indicator is involved.

Guides with explanatory motion start it automatically. Users can pause animated
demonstrations with the page control, and reduced-motion preferences yield
stationary, complete diagrams. Animation does not initiate a model download,
permission request or shell command. Search, browser-AI availability, and the
branching demonstration are the three registered Vue-hydrated islands; the
other demonstrations render as static HTML. Branching animation follows the
selected branch without changing the user's selection or announcing a stream
of automated updates.
