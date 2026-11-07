// Model pages are a publication overlay, not part of the offline app shell.
// Do not turn their HTTP 404 responses into a successful home page either.
export function isModelSeoNavigation({ url, scope, mode }: { url: URL, scope: URL, mode: RequestMode }): boolean {
  const root = new URL('llama-cpp-browser/', scope);
  return mode === 'navigate' && url.origin === root.origin
    && (url.pathname === root.pathname.slice(0, -1) || url.pathname.startsWith(root.pathname));
}
