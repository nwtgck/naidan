// Docs are independently published. Leave their navigation and assets to the
// browser rather than serving the application shell or app precache entries.
export function isDocsUrl({ url, scope }: { url: URL; scope: URL }): boolean {
  const root = new URL('docs/', scope);
  return url.origin === root.origin && (url.pathname === root.pathname.slice(0, -1) || url.pathname.startsWith(root.pathname));
}
