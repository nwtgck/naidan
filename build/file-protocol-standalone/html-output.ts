import { JSDOM } from 'jsdom';

function hasStartOffset(value: unknown): value is Readonly<{startOffset: number}> {
  return value !== null
    && typeof value === 'object'
    && 'startOffset' in value
    && typeof value.startOffset === 'number';
}

/**
 * Insert generated standalone bootstrap markup at the parsed end of <head>.
 *
 * Do not search for a literal </head> token: valid comments, inline script
 * strings, or style text can contain that sequence before the real head end.
 * Using JSDOM source locations keeps normal explicit-head output byte-stable
 * while still falling back to serialization when the parser created <head>
 * implicitly and there is no source end-tag location to splice against.
 */
export function insertFileProtocolStandaloneBootstrap({ html, bootstrap }: Readonly<{
  html: string;
  bootstrap: string;
}>): string {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  try {
    const head = dom.window.document.head;
    const location = dom.nodeLocation(head);
    const endTagLocation = location !== null
      && location !== undefined
      && 'endTag' in location
      ? location.endTag
      : undefined;
    if (hasStartOffset(endTagLocation)) {
      const insertionOffset = endTagLocation.startOffset;
      return `${html.slice(0, insertionOffset)}${bootstrap}${html.slice(insertionOffset)}`;
    }

    head.insertAdjacentHTML('beforeend', bootstrap);
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}
