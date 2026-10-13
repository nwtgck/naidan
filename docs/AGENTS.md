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

In English and Japanese guide prose and figure captions, mark names of visible
controls with full-width brackets (`［Save］`). Render those strings through
`site/UiText.vue`, which emits an inert, localized SSR span for each marked name.
Do not pass commands, code, paths, technical identifiers or metadata through
`UiText`, and do not present these labels as buttons or keyboard shortcuts.

Keep complete per-language HTML at build time and shared development rendering.
Hydrate only explicitly registered demonstrations. Maintain the independent
`build:docs` output and the normal development server's `/docs/` entry.

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
Keep external HTTP(S) links visibly marked with the shared external-link icon.
Typed `AppEntryLink` launch links are in-app actions: their static public-origin
fallback is rebased to the current Docs origin, and they do not use that icon.

For Docs-only changes, apply `eslint --fix` only to changed Docs code files,
then run `npm run lint:docs`. This scoped fix pass is sufficient in place of the
repository-wide `lint:fix`; still run the required root typecheck and
`test:only-failed` before committing.
