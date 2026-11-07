# Published browser-model entry pages

The public model URL is `/llama-cpp-browser/<modelId>/`, for example
`/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M/`.
The initial HTTP response contains model metadata and a small semantic fallback.
It loads the **same application bundle** as the root page, not a second UI.

## Single sources of truth

- `src/features/llama-cpp-browser/hugging-face/model-repositories.ts` defines
  `seoPageQuantizations`. Keep previously published entries when recommendations
  change. This does not limit the quantizations selectable inside the app.
- `model-launch/seo-url.ts` defines the public path syntax. Slash separators and
  the quantization colon are literal. Public entries use the safe repository /
  quantization subset; arbitrary file selectors retain the existing hash links.
- `model-launch/seo-entries.ts` projects that registry into HTML and sitemap entries.
  Invalid or duplicate paths fail generation instead of overwriting files.
- `model-launch/document-metadata.ts` generates the shared model title and
  description. Changes also affect legacy model-preview links and standalone.
- `SITE_METADATA.url` owns the canonical origin. Canonical and `og:url` use `.org`;
  app navigation and Docs links use the actual deployment origin.

## Routing and preview

Only a registered public model path selects the history adapter. It wraps Vue
Router's web history and maps the external path to the existing internal model
query. It does not add a model query to the browser's hash, redirect to the root,
replace the preview component, or start a model download automatically.

The existing explicit launch action is unchanged. When the app navigates to the
created chat with `router.replace`, the adapter writes `/#/chat/<id>` without a
reload. Normal app links, guards, history positions, back/forward and caller state
remain owned by Vue Router. The replacement does not add a separate preview
entry to browser history.

Physical URL query parameters are not treated as app instructions. A pasted
legacy `#/...` route takes precedence and is normalized to the root hash URL.
Changing the quantization in the existing picker edits the pending launch, not
the public URL. Its displayed metadata follows that selection; canonical remains
the original public entry until navigation leaves it. Reload resets the selection.

## Build and distribution

After an ordinary hosted build, run `npm run build:model-seo` to generate
`dist/model-seo-publication/` from the **final** `dist/hosted/index.html`.
This overlay contains model HTML, the public sitemap, and a root `404.html`.
No scripts, styles or inference binaries are duplicated. Generation uses staging,
rejects overlapping input/output directories, and removes obsolete output files.
The deployment job uses Linux; the literal-colon directory names are not intended
as a portable Windows ZIP layout.

The CI build creates the overlay after release packages. Each Cloudflare publish
job copies it into `dist/hosted/` only at deployment assembly, alongside Docs.
The normal hosted ZIP, embedded hosted server assets, and standalone ZIP remain
separate. Their basic sitemap does not advertise missing model pages.

A public page inserts `<base href="/">` before URL-bearing elements. Runtime asset
base resolution uses `document.baseURI`, while portable pages keep their original
base behavior. Standalone selects its existing hash history through a build facade;
it never needs model-path files or the hosted history adapter.

The root `404.html` intentionally disables Cloudflare Pages' generic SPA fallback:
unknown model paths must be HTTP 404, not a home-page HTTP 200. Ordinary application
routes use fragments and therefore still request `/`. Docs keeps its closer
`docs/404.html`.

## Development and Docs

`npm run dev` serves the same model pages through Vite middleware and
`transformIndexHtml`. No on-disk model pages are needed in development. Registry
and model-copy changes invalidate Vite's module graph and request a full reload;
Vue and CSS edits retain normal hot module replacement. The live sitemap uses
the same freshly loaded entries. Noncanonical registered paths receive 308;
unknown/invalid paths receive 404. GET and HEAD are supported.

The English/Japanese model shortlist uses the typed `model-page` destination.
Docs imports only the public ID **type**, not app runtime modules. Static fallback
links still use its existing public origin; the existing client enhancement
rebases them to the current Docs origin. Generic `model` destinations retain
fragment links for arbitrary models. Docs validates the public path shape, and
build tests cross-check generated links against the shared publication registry.

## Service Worker boundary and rollout

New workers leave public model navigations to the network, including 404/offline
failures. They never substitute cached root HTML. Public model pages are not
pre-cached; their first navigation requires a network connection. This does not
change the ordinary app's offline shell or model storage.

**A worker installed before this change can still intercept the first visit.**
New source cannot change an already-running old worker. For existing installations,
roll out the worker update before promoting the model links, or verify that users
can accept the normal app update and revisit the link. Do not claim that the new
network bypass fixes all older installed generations.

## Verification

`npm run test:only-failed -- --config build/vitest.model-seo.config.ts` runs broad
related unit/integration tests and real isolated Vite builds without requiring
native inference binaries. The actual preview component and Vue Router are used;
external model metadata is mocked in component tests. Run the independent Docs
and PWA suites as well. These tests do not establish actual GPU inference,
Cloudflare URL normalization, or search-engine indexing. Validate those separately
before deployment. The app's standard configuration still verifies native packages;
the test configuration must not be used as a substitute production build.
