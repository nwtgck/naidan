export function updateAppEntryLinks({ document, locationHref }: { document: Document; locationHref: string }): void {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[data-docs-app-entry-path]')) {
    const path = anchor.dataset.docsAppEntryPath;
    if (!path) continue;
    const href = new URL(path, locationHref).href;
    anchor.href = href;
    const displayedUrl = anchor.querySelector<HTMLElement>('[data-docs-app-entry-url]');
    if (displayedUrl) displayedUrl.textContent = href;
  }
}
