import { JSDOM } from 'jsdom';

/**
 * Vite can preserve a valid HTML fragment without serializing an explicit
 * <head>. Keep the normal Naidan output byte-stable when </head> exists, but
 * use the HTML parser as a fallback so standalone bootstrap injection does not
 * silently become a no-op for those valid fragment inputs.
 */
export function insertFileProtocolStandaloneBootstrap({ html, bootstrap }: Readonly<{
  html: string;
  bootstrap: string;
}>): string {
  const closingHeadPattern = /<\/head\s*>/iu;
  if (closingHeadPattern.test(html)) {
    return html.replace(
      closingHeadPattern,
      closingHead => `${bootstrap}${closingHead}`,
    );
  }

  const dom = new JSDOM(html);
  try {
    dom.window.document.head.insertAdjacentHTML('beforeend', bootstrap);
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}
