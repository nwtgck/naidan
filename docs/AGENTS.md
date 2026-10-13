# Documentation authoring

Docs owns independent presentation replicas of Naidan. This duplication is
intentional. Do not share or import application UI components, stores, providers,
model runtimes or permission handlers into Docs. Maintain important visual and
interaction details by inspecting the current `src/` implementation and its
behavior tests. Use `site/demos/README.md` to locate the relevant counterparts.

Use one page structure for English and Japanese. Locally authored strings use
the English message object as their canonical TypeScript shape, with other
locales checked using `satisfies` against that derived type. Do not duplicate the
shape in a separate interface. Do not validate local dictionaries with Zod or
replace that validation with custom runtime checks. Read JSON island
props through the island-owned serialization boundary parser; do not duplicate
the local translation shape in a separate runtime schema.

Interface labels, sample conversation content, diagrams and accessible text must
follow the page locale. Pass the required localized copy as typed build-time
props. Preserve genuine commands, paths, filenames and technical identifiers.
Do not load page-wide translation dictionaries in the browser.

Keep complete per-language HTML at build time and shared development rendering.
Hydrate only explicitly registered demonstrations. Maintain the independent
`build:docs` output and the normal development server's `/docs/` entry.

Page titles, headings, descriptions and navigation should explain the task and
its benefit to a reader who has never heard of Naidan. Use concise, specific
titles in the page language. Keep the approved homepage headline. Avoid keyword
lists, repeated boilerplate and promises about search rankings.

Motion starts automatically. Respect the shared pause control and reduced-motion
preference, and leave a readable complete static view. Streamed examples append
content in reading order. A replay may reset the whole scene together; do not
erase messages one by one from the bottom. Preserve user selection in
interactive demonstrations. Keep a compact, stable footprint across animation
phases: animate opacity or transforms without changing document height, clipping
content or reserving a large arbitrary minimum height.

Prefer visible sections in normal scrolling order for explanatory alternatives.
Use tabs when the task benefits from switching a shared working view; do not hide
independent guide content or the ways to use a feature behind tabs.

Docs tests must not execute external commands or child processes, directly or
through a helper. Exercise the compiler and renderer through their library APIs.
Keep external HTTP(S) links visibly marked with the shared external-link icon.
