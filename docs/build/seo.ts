import { DOCS_BASE, DOCS_LOCALES, DOCS_PAGES, docsHref } from '../navigation/routes';
import type { DocsLocale, DocsPageId } from '../navigation/routes';

export const DOCS_PUBLIC_ORIGIN = 'https://naidan.nwtgck.org' as const;

export type DocsSeoRoute =
  | { kind: 'root' }
  | { kind: 'page'; locale: DocsLocale; page: DocsPageId };

export function docsPublicUrl({ route }: { route: DocsSeoRoute }): string {
  switch (route.kind) {
  case 'root': return `${DOCS_PUBLIC_ORIGIN}${DOCS_BASE}`;
  case 'page': return `${DOCS_PUBLIC_ORIGIN}${docsHref({ locale: route.locale, page: route.page })}`;
  default: {
    const unreachable: never = route;
    throw new Error(`Unknown Docs SEO route: ${String(unreachable)}`);
  }
  }
}

export function docsSeoLinks({ route }: { route: DocsSeoRoute }): {
  canonical: string;
  alternates: Array<{ language: DocsLocale | 'x-default'; href: string }>;
} {
  let page: DocsPageId;
  switch (route.kind) {
  case 'root': page = 'index';
    break;
  case 'page': page = route.page;
    break;
  default: {
    const unreachable: never = route;
    throw new Error(`Unknown Docs SEO route: ${String(unreachable)}`);
  }
  }
  const alternates: Array<{ language: DocsLocale | 'x-default'; href: string }> = DOCS_LOCALES.map(locale => ({
    language: locale,
    href: docsPublicUrl({ route: { kind: 'page', locale, page } }),
  }));
  switch (route.kind) {
  case 'root': alternates.push({ language: 'x-default', href: docsPublicUrl({ route: { kind: 'root' } }) });
    break;
  case 'page': {
    switch (route.page) {
    case 'index': alternates.push({ language: 'x-default', href: docsPublicUrl({ route: { kind: 'root' } }) });
      break;
    default: break;
    }
    break;
  }
  default: {
    const unreachable: never = route;
    throw new Error(`Unknown Docs SEO route: ${String(unreachable)}`);
  }
  }
  return { canonical: docsPublicUrl({ route }), alternates };
}

function escapeXml({ value }: { value: string }): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function createDocsSitemap(): string {
  const routes: DocsSeoRoute[] = [{ kind: 'root' }];
  for (const locale of DOCS_LOCALES) {
    for (const page of DOCS_PAGES) {
      routes.push({ kind: 'page', locale, page: page.id });
    }
  }
  const entries = routes.map(route => {
    const { canonical, alternates } = docsSeoLinks({ route });
    const links = alternates.map(({ language, href }) => `    <xhtml:link rel="alternate" hreflang="${language}" href="${escapeXml({ value: href })}"/>`).join('\n');
    return `  <url>\n    <loc>${escapeXml({ value: canonical })}</loc>\n${links}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries}\n</urlset>\n`;
}
