// Intentionally matches the native fetch signature so LM providers can use
// injected fetch implementations as drop-in replacements.
// eslint-disable-next-line local-rules-named-args/require-named-args -- this is a native fetch-compatible boundary.
export type LmFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// eslint-disable-next-line local-rules-named-args/require-named-args -- this is a native fetch-compatible boundary.
const defaultLmFetch: LmFetch = (input, init) => globalThis.fetch(input, init);

export function getDefaultLmFetch(): LmFetch {
  return defaultLmFetch;
}
