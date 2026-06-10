# Privacy Fetch

Privacy fetch is a browser-side request path used by Naidan to avoid sending Naidan's application origin as the HTTP `Origin` header to selected external sources.

The first use case is Wikipedia API access.

This is not anonymization. The remote server can still receive information such as the user's IP address, User-Agent, Accept-Language, request URL, query parameters, and access timing. The purpose is narrower: avoid exposing Naidan's web origin through the HTTP `Origin` header.

## Goal

A normal browser `fetch()` from the main application may send an origin such as:

* `Origin: https://naidan.example`

Privacy fetch sends the external request from a sandboxed iframe whose origin is opaque. In this context, browser CORS requests can use:

* `Origin: null`

## Architecture

Privacy fetch uses a broker iframe.

The main application does not directly perform the external request. Instead:

1. The main application creates a hidden iframe.
2. The iframe loads the privacy fetch broker HTML.
3. The iframe is sandboxed with `allow-scripts`.
4. The iframe intentionally does not use `allow-same-origin`.
5. The main application sends a request to the broker with `postMessage`.
6. The broker validates the requested URL against an allowlist.
7. The broker performs the external `fetch()`.
8. The broker returns the result to the parent.

The absence of `allow-same-origin` is essential. It makes the iframe an opaque-origin context. Adding `allow-same-origin` would break the `Origin: null` behavior.

## Why an iframe is used

JavaScript cannot manually remove or rewrite the browser-controlled `Origin` header for normal `fetch()` calls.

A sandboxed iframe without `allow-same-origin` gives the browser a distinct opaque-origin execution context. Requests sent from that context can carry `Origin: null`.

The iframe is not used to provide anonymity. It is used to change the browser origin context of the request.

## Security model

Privacy fetch must not become an open browser-side proxy.

The broker accepts URL-shaped requests for ergonomic use, but it must validate them before fetching. The allowlist policy decides which external URLs are permitted.

A rejected URL must not be fetched.

Important constraints:

* Only explicitly supported external sources should be allowed.
* URL parsing and validation must happen inside the broker path before `fetch()`.
* The iframe must not use `allow-same-origin`.
* The broker should not send credentials.
* The broker should not send a referrer.
* The parent must not trust `event.origin === "null"` as an identity check.
* Message validation should rely on the expected source window, protocol discriminator, request id, and schema validation.

## Browser validation findings

This design was validated in real browsers before implementation.

### Origin null behavior

Chrome, Firefox, and Safari were able to send Wikipedia API requests with:

* `Origin: null`

when the request was executed inside an iframe with:

* `sandbox="allow-scripts"`
* no `allow-same-origin`

### CORP and COEP

When the application is served with:

* `Cross-Origin-Embedder-Policy: require-corp`

the broker resources require explicit resource policy headers.

The broker HTML needs:

* `Cross-Origin-Resource-Policy: cross-origin`

The broker JavaScript and module chunks need:

* `Cross-Origin-Resource-Policy: cross-origin`
* `Access-Control-Allow-Origin: *`

Without these headers, browsers can block the broker document or its module scripts before the privacy fetch path runs.

### Module scripts

Classic scripts and module scripts behave differently in this setup.

In the sandboxed iframe, module scripts are CORS-loaded. The broker JavaScript assets therefore need `Access-Control-Allow-Origin: *`.

This was validated with a module import chain before moving to the Vite-built broker bundle.

### Safari CSP behavior

Safari did not accept `script-src 'self'` alone for loading same-origin broker assets from inside the sandboxed iframe.

For CSP configurations that include the broker path, the application origin may need to be listed explicitly in `script-src`.

This is a CSP deployment concern and should be handled with the deployment-specific header configuration.

### Vite development server

In development, Vite, Vue DevTools, and Vue Inspector may inject scripts into HTML.

Those injected scripts can access APIs such as `localStorage`, which fail inside a sandboxed iframe without `allow-same-origin`.

Do not fix this by adding `allow-same-origin`.

For the broker HTML only, development-injected scripts should be removed in the Vite dev server path. This should be a dev-only cleanup. It exists to preserve the same sandbox constraints used by the real broker.
