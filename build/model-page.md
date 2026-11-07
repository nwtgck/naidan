# Published browser-model entry pages

A model page identifies a repository:
`/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF`.
An optional `?quant=Q4_K_M` selects its initial quantization. Without it, the
existing catalog-based recommendation algorithm chooses an available variant.
The existing `/#/?llama-cpp-browser-model=hf.co/owner/repo:variant` links still work.

Published repositories receive static HTML with repository metadata and a small
semantic fallback. Unpublished repositories receive the common app shell. Both
load the **same application bundle and preview**, never a second model-page UI.
No Cloudflare Pages Functions or server-side rendering is required.

## Single sources of truth

- `src/features/llama-cpp-browser/hugging-face/model-repositories.ts` retains the
  published repository identities, independently of recommendations. One entry
  produces one page, regardless of its available quantizations. Recommendation
  hints and the upstream catalog are not a static publication allowlist.
- `model-launch/page-url.ts` validates the public path and optional quant query.
  Structure slashes and original spelling remain intact. It decodes once and
  rejects encoded separators, control characters and additional path segments.
- `model-launch/page-entries.ts` derives paths, labels, metadata and sitemap entries.
  Invalid or duplicate output paths fail generation instead of overwriting files.
- `model-launch/document-metadata.ts` owns labels, title and description. Its
  Node-compatible import also works in the real Node TypeScript configuration.
  Static titles do not pretend to know a runtime quantization. Explicit or
  catalog-confirmed selections use the same quantization-aware runtime copy.
- `SITE_METADATA.url` owns the canonical origin. Canonical and sitemap use `.org`,
  a trailing slash, and no quant query. Human-facing README/Docs links omit the
  slash and retain their existing origin handling. Hosting may add the slash.

## Routing, validation and metadata

Publication membership is not route validity. Any syntactically valid model path
selects the web-history presentation adapter and the existing model preview.
The initial physical path and search remain unchanged. The internal model query
is not added to the address bar. Starting a chat explicitly lets `router.replace`
write `/#/chat/<id>` without a document reload or a new preview history entry.
Guards, history positions, browser back/forward and caller state remain Vue Router's.

Only `quant` is read as a launch instruction. Outer `q`, `settings`, or another
model query never execute app actions. An empty, duplicate or malformed quant is
an invalid input, not permission to choose a different model. The existing repair
screen handles invalid paths/queries without metadata discovery. A valid but
nonexistent repository is handled by the existing Hugging Face error UI.
A pasted legacy `#/...` route takes precedence and returns to the root hash URL.

The preview picker edits a pending selection; it does not mutate the URL. Title
and description follow the inspected selection, while canonical remains the
repository URL. Reload re-applies quant or chooses the recommended available model.
Unknown/invalid model requests receive a centrally owned runtime `noindex` tag.
Leaving the preview removes only that tag, not a deployment's separate robots
policy. Unknown repositories are not in the sitemap. The shared initial response
cannot provide per-request robots/status decisions before JavaScript executes.

## Initial rendering and recovery

Only the static fallback node is hidden before first paint by inline
`@media (scripting: enabled)` CSS. Successful Vue mounting replaces that node.
JavaScript-disabled browsers can read the fallback immediately. If scripts are
enabled but never load, a CSS visibility switch restores it after eight seconds,
including an app link. This is not a second sidebar, startup implementation, or
moving animation. Existing startup error panels remain visible because the rule
never hides `#app` or arbitrary descendants. Unsupported scripting media queries
fall back to the readable initial text.

## Build, Cloudflare and distribution

After the ordinary hosted build, `npm run build:model-pages` generates
`dist/model-page-publication/` from the final `dist/hosted/index.html`. It contains
repository `index.html` pages, a sitemap and a root app `index.html` with
`<base href="/">`. Assets, inference binaries and UI bundles are not duplicated.
Generation uses staging, rejects overlapping input/output directories, and removes
obsolete output files. Physical paths contain no colon/quantization suffix, so
GitHub Artifact needs no special filename bypass or tar wrapper.

The root response uses a root-relative base even at an unknown deep URL, avoiding
relative `./assets` requests under the repository. Runtime asset base resolution
also respects `document.baseURI`. The shared Vite `base: './'` is unchanged.
Portable hosted ZIPs, embedded hosted assets and standalone ZIPs are not mutated.
Standalone retains its hash-history build facade and never needs these pages.

Each Cloudflare deployment copies the overlay only after release packaging.
There is **no root `404.html`**: Cloudflare Pages' standard SPA fallback serves the
root shell for paths with no static asset, including unlisted models. Existing
static model HTML has precedence. Do not add a wildcard `_redirects` rewrite
that would override those files. Docs keeps its nearer `docs/404.html`.
Unrelated unknown paths can return HTTP 200; this is an accepted tradeoff. The
browser cannot change that network status to 404 after discovering a bad model.

A newly built Service Worker precaches the deployed root response as its shell.
The publication must be assembled from the matching hosted build, not an older
worker/bundle. Model-path navigations (published, unlisted and invalid) bypass the
worker's cached root response and go to the network. Offline failures are not
masked by a fake successful home page. An already-installed older worker cannot
be retroactively changed; normal app-update/revisit behavior remains important.

## Development and Docs

`npm run dev` serves the same registered HTML through Vite middleware and
`transformIndexHtml`. Unlisted and invalid model paths receive the common shell
with HTTP 200, then use the same client preview/repair path. No on-disk static
pages are needed. Known noncanonical paths receive 308 with their query intact.
GET and HEAD are supported. Registry/model-copy changes use Vite's live module
graph and a page reload; Vue/CSS edits use normal hot updates. Per-model labels
travel with the registry projection, not a second copy in the Vite config graph.

The bilingual guide imports only the public model ID **type**, not app runtime
code. Its existing client enhancement rebases links to the current Docs origin.
The typed destination separates repository and quant. Tests cross-check that
minimal Docs URL formatting against the shared page URL generator. Generic
`model` destinations still support arbitrary legacy fragment references.

## Verification boundaries

`npm run test:only-failed -- --config build/vitest.model-pages.config.ts` runs the
related application, routing, metadata and generation tests with real Vue/Vite
modules, without requiring native inference assets. Run the scoped Docs and PWA
suites too. Node typechecks must not add an app alias merely to hide a shared
module import failure. Independent fixtures and browser CSS checks are not a
claim that real model inference, Cloudflare deployment or search indexing was
verified. Never use the test configuration as a substitute production build.
