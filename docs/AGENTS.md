# Documentation authoring

Docs owns independent presentation replicas of Naidan. This duplication is
intentional. Do not share or import application UI components, stores, providers,
model runtimes or permission handlers into Docs. Maintain important visual and
interaction details by inspecting the current `src/` implementation and its
behavior tests. Use `components/demos/README.md` to locate the relevant counterparts.

Use one page structure for English and Japanese. Locally authored messages use
the English message object as their canonical TypeScript shape, with other
locales checked using `satisfies` against that derived type. Do not duplicate the
shape in a separate interface. Do not validate local dictionaries with Zod or
replace that validation with custom runtime checks. Read JSON island
props through the island-owned serialization boundary parser; do not duplicate
the local translation shape in a separate runtime schema.

Keep each article's English and Japanese copy in `pages/<id>/messages/en.tsx`
and `ja.tsx`, exporting `messages`. Use flat, natural English `snake_case` keys
for message meanings; keep routes, fixed step order, and demonstration state in
the page. `title` and `description` are fixed metadata fields in the same flat
object. Write plain text without arguments directly as a string literal or a
template literal without interpolation. When plain text needs named arguments,
write an inline arrow or function expression with an explicit `: string` return
type. Write each rich or list-producing value directly as an inline arrow or
function expression in the catalog; do not assign a helper, imported function,
or shared value to a message key. Prose with inline
links or names of visible controls is a JSX function returning a fresh VNode when
called, with a named-argument object when it needs page-owned values. Use
`components/RenderText.ts` in the static page to render that VNode. Check Japanese
copy with `satisfies typeof import('./en').messages` without a runtime import
of English copy. A language-dependent list may be a function returning a fresh
array; its length and order need not match between languages. Do not share
mutable arrays, objects, or VNodes from module scope or a function closure
between renders. Pass article messages as one explicit prop to static demos;
read the authored keys directly in the demo instead of manually mapping them
to same-typed aliases. Do not use `v-bind="messages"` to expand the entire
catalog into component attributes. Pass only JSON data required for an island;
keep article JSX and page-wide catalogs out of the browser.

Common UI messages use `messages/common/{en,ja}.ts`. Author the reusable
Chrome and search copy once in `messages/replica-chrome/{en,ja}.ts` and
`messages/search-ui/{en,ja}.ts`. Island loaders dynamically import only the
selected locale's small modules; they must not import the common catalog to
obtain those groups. Common imports the same-language groups as `chrome` and
`searchUi` and spreads their **same keys** into its flat `messages` object.
Use meaningful scoped `snake_case` keys such as `chrome_new_chat` and
`search_ui_open_search`, without a second string-to-string map or nested
`messages.chrome`/`messages.searchUi` copies. Other common UI messages also
use natural `snake_case`. The article file already gives its messages a
subject, so do not add a mechanical page or role prefix to every article key.
Route- and category-keyed navigation and search-purpose metadata remain
domain records.

Plain locale modules under `messages/` and plain island message directories
directly export `const messages = { ... }`; Japanese modules check that object
with `satisfies typeof import('./en').messages`. Their root message values are
string literals, template literals without interpolation, or inline functions
with an explicit `: string` return type. TypeScript checks the string result;
the source check limits the authoring syntax, not arbitrary function purity.
Common's
`navigation` and `search_purpose_descriptions` are domain-object exceptions;
common may spread only the same-language `chrome` and `searchUi` groups.

Write short JSX sentences and component props on one line when they fit. Avoid
breaking inline argument types across lines without a readability reason. For
example, `<>Open <AppEntryLink locale={locale} destination={destination} display="path" />.</>`
is clearer as one line than as a fragment spread over several lines.

When migrating prose, preserve its meaning, factual information, instructions,
and link destinations. The languages may use different word order and natural
connections between clauses. A comparison with prior rendered HTML helps find
omissions or unintended changes; it does not require verbatim old wording.

Interface labels, sample conversation content, diagrams and accessible text must
follow the page locale. Static demos read typed article messages during SSR.
Interactive islands load their own small messages for the selected locale;
the other locale's message module must not be an eager dependency. Pass locale
and any genuinely required plain data through the typed JSON island boundary.
Preserve genuine commands, paths, filenames and technical identifiers. Do not
load page-wide article dictionaries in the browser.

In English and Japanese guide prose and figure captions, render names of
visible controls through `components/UiLabel.vue` inside the localized JSX sentence.
An island-owned rich message may do the same when its server and client renders
use the prepared messages for the same locale. The label emits an inert span.
Do not treat commands, code, paths, technical identifiers, or metadata as
control names, and do not present labels as buttons or keyboard shortcuts.
Plain copy does not parse full-width brackets.

Keep complete per-language HTML at build time and shared development rendering.
Hydrate only explicitly registered demonstrations. Maintain the independent
`build:docs` output and the normal development server's `/docs/` entry.

Static Docs components use an inline `<script setup>` or no script. Their Vue
value imports must be named imports from `vue`: browser lifecycle hooks, the
`watch` family, and render-function APIs such as `h` are unsupported in static
authoring. Use `computed` for derived HTML, `onServerPrefetch` for async server
data, and a registered island for browser behavior. The only supported
`defineOptions` form is `{ inheritAttrs: false }`. Static modules do not import
browser client modules or private island helpers as values. These rules run in
both development and production builds; development keeps static pages
server-rendered instead of hydrating them as Vue applications.
Static Docs authoring also does not value-import executable `.vue`, `.ts`,
`.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, or `.cjs` files from elsewhere in
this repository. Type-only imports, assets such as SVG, and package imports
remain supported. The source check does not prove arbitrary function purity;
keep message functions free of shared mutable state.

Do not access browser persistence APIs directly in production Docs code except
through the private read/write code in `client/preferences.ts`, which
saves the existing theme and motion choices under `naidan_docs:settings`; its
individual storage calls have local lint exceptions. Do not add another storage
path or migrate, fall back to, or delete an older key. HTTP caching, prefetching,
and the browser back-forward cache are separate browser behavior. Tests and
test-support files are excluded. The rule catches ordinary direct and
destructured persistence access and bans all computed access through
`window[...]`, `globalThis[...]`, or `self[...]` in production Docs code; it
does not prove the absence of other dynamic, reflective, or third-party effects.

The small `components/RenderText.ts` VNode bridge and article locale TSX functions
are the supported exceptions for SSR-only rich copy. In article TSX, use JSX
fragments, text, inert inline elements, and approved typed Docs links and
`UiLabel`. Do not write native anchors, active elements, Teleport, event or
directive attributes, refs, HTML injection, attribute spreads, or arbitrary
component tags. Article locale modules must not enter the client value graph;
type-only imports are permitted. An island-owned locale TSX module may enter
only that island's client graph and must not import an article locale module
as a value.
Static templates do not use Teleport, template refs, or custom directives:
Teleport content is omitted from rendered pages, browser directive hooks do
not run, and template refs remain unset without hydration. Render Teleport
content inline; use supported Vue directives for static markup and a registered
island for browser behavior. Static Vue value imports and re-exports also
exclude Teleport and useTemplateRef.

For an interactive island, keep its `type`-alias `JsonObject` payload and
boundary parser in `islands/<id>/contracts.ts`. Register its spec there, and
directly import its concrete Vue component in `islands/<id>/definition.ts` for
`defineDocsIsland`. Give that definition a required `prepare({ payload })`
callback that loads only `payload.locale`'s island-owned messages. The shared
host waits for it before server-rendering the island. Client hydration waits
for the same locale while leaving the static HTML in place; the island component
then reads the prepared messages synchronously. Use the shared
`messages/loader.ts` helper for locale-keyed loading, and do not eagerly import
both languages.
Static pages import that factory and pass props once through
`<DocsIsland :entry="branchingIsland({ locale })" />`. The island may resolve
its own locale messages without a hand-authored mapping from article messages
into JSON props. Do not handwrite island data attributes, pass slots or extra
attributes to `DocsIsland`, or import a raw
island component into static Docs. Island components must not use `useId`,
`provide`, or `inject`, or depend on a parent page's scoped CSS or setup context.
Keep document IDs unique. `build:docs` runs `typecheck:docs` before the Vite build;
the type check is part of the authoring contract.

Treat the article ID and public URL slug as one stable identifier for the
article's subject. Do not rename it merely because a title, introduction, or
navigation label changes. Register each ID in `navigation/routes.ts` and place its
entry component at `pages/<id>/index.vue`, with article-owned messages and
assets under that directory. In Vue templates and article JSX use
`components/DocsLink.vue` with a `DocsPageId`; other code uses `docsHref`. Native
anchors belong only in the link components. Use `components/LocalAnchorLink.vue` for
the page's skip link,
`components/AppEntryLink.vue` for app entry, and `components/ExternalLink.vue` for absolute
HTTP(S) destinations. Add compatibility aliases when an
intentional public URL migration needs them; do not accumulate aliases from
intermediate feature branch revisions.

Page titles, headings, descriptions and navigation should explain the task and
its benefit to a reader who has never heard of Naidan. Use concise, specific
titles in the page language. Keep the approved homepage headline. Avoid keyword
lists, repeated boilerplate and promises about search rankings.

Before structuring a guide, write down what its reader wants to decide or do and
the concrete questions they need answered. Choose sections around those answers,
not around an inventory of features or published files found during source review.
For a new article or major restructure, settle an outline before writing prose:
the intended reader, reason for visiting, questions to answer, and purpose of
each section. Have another reviewer challenge the outline for missing questions,
author-centered categories, unnecessary detail or order, a title it cannot
fulfill, and claims beyond the evidence. Resolve that critique before drafting.
This is a planning check for substantial work, not a review ritual for typos.
Make the title's promise explicit in the body and connect each fact to a reader's
decision. Keep technical terms when the target reader needs them, such as GGUF
when choosing a browser model. Match the strength of a safety or provenance
claim to its evidence. Use current application source to verify the answers.
Start from the normal default state and introduce an exception only where it
changes the operation at hand; do not front-load warnings about unrelated
features. A first-time reader's review can reveal unclear prose; source review
still checks technical accuracy.

Assume a reader may arrive directly at any guide from search. Near the start,
show the first useful action and a route into the app when the task needs it.
Keep links for special editions tied to their actual published edition; do not
silently send a reader to a different build.

Motion starts automatically. Respect the shared pause control and reduced-motion
preference, and leave a readable completed view of the step. Streamed examples
append content in reading order. A replay may reset the whole scene together;
do not erase messages one by one from the bottom. Preserve user selection in
interactive demonstrations. Keep a compact, stable footprint across animation
phases. A settings walkthrough may use a fixed-height camera viewport with an
app-sized canvas that pans or zooms by transform. Intentional cropping of
surrounding UI is allowed; keep the current instruction, active label, control,
and resulting state readable. Do not shrink a whole settings screen just to fit
it into the viewport, accidentally cut off important text, change document
height between phases, or reserve a large arbitrary minimum height. Pause and
reduced motion should show each step's completed focus state.

Prefer visible sections in normal scrolling order for explanatory alternatives.
Use tabs when the task benefits from switching a shared working view; do not hide
independent guide content or the ways to use a feature behind tabs.

Docs tests must not execute external commands or child processes, directly or
through a helper. Exercise the compiler and renderer through their library APIs.
For Docs-only verification, run targeted tests with
`npm run test:only-failed -- --config docs/vitest.config.ts <docs paths>`, or run
the full Docs suite with `npm run test:only-failed -- --config docs/vitest.config.ts docs`.
The default root Vitest configuration excludes `docs/**`, so invoking the script
without the Docs config runs the application suite instead of verifying Docs.
The configured invocation fulfills the root `test:only-failed` requirement.

Keep external HTTP(S) links visibly marked with the shared external-link icon.
Typed `AppEntryLink` launch links are in-app actions: their static public-origin
fallback is rebased to the current Docs origin, and they do not use that icon.

For Docs-only changes, apply `eslint --fix` only to changed Docs code files,
then run `npm run lint:docs`. This scoped fix pass is sufficient in place of the
repository-wide `lint:fix`; still run the required root typecheck and
configured `test:only-failed` command above before committing.
