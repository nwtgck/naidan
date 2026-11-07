// Model entry navigations require the online response, even when the HTML
// is in the automatic asset precache. For published and unknown models, never
// substitute the cached root shell or mask a network failure.
export function isModelPageNavigation({ url, scope, mode }: { url: URL, scope: URL, mode: RequestMode }): boolean {
  const root = new URL('llama-cpp-browser/', scope);
  return mode === 'navigate' && url.origin === root.origin
    && (url.pathname === root.pathname.slice(0, -1) || url.pathname.startsWith(root.pathname));
}
