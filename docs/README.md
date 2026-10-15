# Naidan Docs

Docs has a separate, static-site-style build. The shared Vue server renderer produces complete English and Japanese HTML both for `npm run build:docs` (`docs/dist/`) and for requests to `/docs/` during `npm run dev`. An explicit language URL is readable without JavaScript. Static pages are **not** hydrated as Vue applications; only registered interactive islands hydrate.

## Choose the right implementation

| Reader needs | Start with | Example from the current guides |
| --- | --- | --- |
| Explanation, links, figures, or a demonstration that plays without input | `pages/<id>/index.vue` and a static component; use CSS for explanatory motion | `<BrowserBoundaryDiagram :messages="s" />` in `pages/browser-boundaries/index.vue` |
| Interaction or browser-only state, such as reader input or API availability | An island with `contracts.ts` and `definition.ts`, embedded through `components/DocsIsland.vue` | `<DocsIsland :entry="branchingIsland({ locale })" />` in `pages/chat-branching/index.vue` |

A static component renders on the server in development and production. Browser lifecycle hooks such as `onMounted`, DOM access, event handlers, and Vue watchers do not make it interactive. Keep the explanation and initial demonstration readable in its HTML. Use a registered island for new page-specific browser behavior; use CSS animation and the shared pause/reduced-motion behavior for motion that merely illustrates a step. Shared site controls such as theme and motion already have their own client entry. An island entry owns its typed JSON payload and parser in `contracts.ts`, component and locale preparation in `definition.ts`, and one `:entry` prop at the page. Do not handwrite its serialized HTML attributes or pass the article catalog as island props.

## Work on a guide

1. Start with the reader's task. Check current app source and behavior tests for factual claims and illustrated UI. Docs owns independent presentation replicas, not app UI, stores, or model runtime imports; `components/demos/README.md` identifies their current counterparts and motion rules.
2. Register a stable ID in `navigation/routes.ts`. Add `pages/<id>/index.vue`, `messages/en.tsx` and `ja.tsx` under that page, and local assets nearby. Put `title` and `description` metadata in the same flat catalog. Use one page structure with flat, natural English `snake_case` message keys. English defines the message type; Japanese checks it with `satisfies typeof import('./en').messages`. Follow a nearby guide for rich JSX. Ordinary text renders with `{{ s.key }}`; rich text from a message function renders through `components/RenderText.ts`, using `components/UiLabel.vue` for visible control names in prose.
3. Static demonstrations read the selected article messages through one typed prop, as the `BrowserBoundaryDiagram` example does. Article messages stay server-only. Islands load only their own small messages for the selected locale on the server and in the browser, and receive only plain data they cannot derive themselves. Keep prose, labels, examples, captions, diagrams, and accessible text in the page language.
4. Use typed links: `DocsLink` for guides, `AppEntryLink` for app screens or model launch, `SkipToContentLink` for the page's skip target, and `ExternalLink` for external HTTP(S) destinations. The static `AppEntryLink` fallback points to the public site origin; when scripts run, Docs rebases that link to the current Docs origin. Keep external destinations visibly identified. Compare rendered English and Japanese pages after prose changes to catch missing facts, altered instructions, and broken links; natural wording can differ.

`/docs/` selects a homepage language; explicit language URLs are pre-rendered. The app's ordinary build and test commands exclude Docs. Hosted deployment adds the separate Docs output.

## Where to look

| Task | Owner |
| --- | --- |
| Routes, public URLs, SEO | `navigation/routes.ts`, `build/seo.ts` |
| Pages, message types | `pages/`, `messages/types.ts` |
| Static rendering and authoring checks | `server.ts`, `build/source-policy.ts`, `build/authoring-policy.ts`, `build/tsx-policy.ts`, `build/html.ts` |
| Development and production output | `build/dev.ts`, `build/production.ts`, `build/compiler.ts` |
| Interactive behavior and locale loading | `islands/`, `components/DocsIsland.vue`, `messages/loader.ts` |
| App UI replicas | `components/demos/README.md` |

The authoring checks reject unsupported syntax; they do not prove that arbitrary message functions are pure or that translated prose is accurate. Consult the nearby source and tests when changing rendering, search, metadata, or publication behavior.

## Verify from the repository root

| When | Command |
| --- | --- |
| Before commit: root types | `npm run typecheck` |
| Before commit: Docs types | `npm run typecheck:docs` |
| Before commit: changed Docs code only | `./node_modules/.bin/eslint --fix <changed Docs code files>` |
| Before commit: Docs lint | `npm run lint:docs` |
| Before commit: Docs tests | `npm run test:only-failed -- --config docs/vitest.config.ts docs` |

For focused tests, replace the final `docs` with relevant Docs paths; keep the Docs config because the root Vitest config excludes Docs. The scoped ESLint fix replaces repository-wide `lint:fix` for Docs-only changes; skip it when no Docs code file changed. Run `npm run build:docs` when changing static output or build behavior; it includes the Docs type check. Docs tests must use library APIs instead of external commands or child processes.
