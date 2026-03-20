import type { WeshCommandContext } from '@/services/wesh/types';
import { handleToStream, readFile } from '@/services/wesh/utils/fs';

function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

async function readTextStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function readXmlInputs({
  context,
  inputs,
}: {
  context: WeshCommandContext;
  inputs: string[];
}): Promise<Array<{ label: string; text: string }>> {
  const effectiveInputs = inputs.length === 0 ? ['-'] : inputs;
  const results: Array<{ label: string; text: string }> = [];
  let stdinText: string | undefined;

  for (const input of effectiveInputs) {
    if (input === '-') {
      if (stdinText === undefined) {
        stdinText = await readTextStream({
          stream: handleToStream({ handle: context.stdin }),
        });
      }
      results.push({
        label: '-',
        text: stdinText,
      });
      continue;
    }

    const path = resolvePath({
      cwd: context.cwd,
      path: input,
    });
    const bytes = await readFile({
      files: context.files,
      path,
    });
    results.push({
      label: input,
      text: new TextDecoder().decode(bytes),
    });
  }

  return results;
}

// wesh is intended to run in the browser, so XML support should prefer the
// platform DOM/XPath APIs instead of Node-specific XML libraries.
export function parseXmlDocument({
  xmlText,
}: {
  xmlText: string;
}): { ok: true; document: Document } | { ok: false; message: string } {
  const parser = new DOMParser();
  const document = parser.parseFromString(xmlText, 'application/xml');
  const parserErrors = document.getElementsByTagName('parsererror');
  if (parserErrors.length > 0) {
    const message = parserErrors[0]?.textContent?.trim() || 'XML parse error';
    return {
      ok: false,
      message,
    };
  }

  return {
    ok: true,
    document,
  };
}

export function serializeXmlNode({
  node,
}: {
  node: Node;
}): string {
  return new XMLSerializer().serializeToString(node);
}

export function evaluateXPathNodes({
  document,
  expression,
}: {
  document: Document;
  expression: string;
}): Array<Node> {
  const result = document.evaluate(
    expression,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const nodes: Node[] = [];
  for (let index = 0; index < result.snapshotLength; index += 1) {
    const node = result.snapshotItem(index);
    if (node !== null) {
      nodes.push(node);
    }
  }
  return nodes;
}

export function evaluateXPathString({
  document,
  expression,
}: {
  document: Document;
  expression: string;
}): string {
  const result = document.evaluate(
    expression,
    document,
    null,
    XPathResult.STRING_TYPE,
    null,
  );
  return result.stringValue;
}
