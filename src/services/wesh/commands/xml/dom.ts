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

function escapeXPathLiteral({
  value,
}: {
  value: string;
}): string {
  return `'${value.replaceAll('\'', `', "'", '`)}'`;
}

function rewriteNamespacedXPath({
  expression,
  namespaces,
}: {
  expression: string;
  namespaces: Map<string, string>;
}): string {
  let rewritten = expression;

  for (const [prefix, uri] of namespaces.entries()) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rewritten = rewritten.replace(
      new RegExp(`@${escapedPrefix}:([A-Za-z_][A-Za-z0-9_.-]*)`, 'g'),
      `@*[local-name()='$1' and namespace-uri()=${escapeXPathLiteral({ value: uri })}]`,
    );
    rewritten = rewritten.replace(
      new RegExp(`(^|[/[(]|::)${escapedPrefix}:([A-Za-z_][A-Za-z0-9_.-]*)`, 'g'),
      `$1*[local-name()='$2' and namespace-uri()=${escapeXPathLiteral({ value: uri })}]`,
    );
  }

  return rewritten;
}

type SimpleXPathStep =
  | { kind: 'element'; prefix: string | undefined; localName: string; axis: 'child' | 'descendant' }
  | { kind: 'attribute'; prefix: string | undefined; localName: string }
  | { kind: 'text' };

function resolveNamespaceUri({
  namespaces,
  prefix,
}: {
  namespaces: Map<string, string>;
  prefix: string | undefined;
}): string | undefined {
  if (prefix === undefined) {
    return undefined;
  }
  return namespaces.get(prefix);
}

function parseSimpleXPath({
  expression,
}: {
  expression: string;
}): { ok: true; steps: SimpleXPathStep[] } | { ok: false } {
  let remaining = expression.trim();
  if (remaining.length === 0) {
    return { ok: false };
  }

  const steps: SimpleXPathStep[] = [];
  let firstAxis: 'child' | 'descendant' = 'child';
  if (remaining.startsWith('//')) {
    firstAxis = 'descendant';
    remaining = remaining.slice(2);
  } else if (remaining.startsWith('/')) {
    remaining = remaining.slice(1);
  }

  const rawSteps = remaining.split('/');
  for (let index = 0; index < rawSteps.length; index += 1) {
    const rawStep = rawSteps[index];
    if (rawStep === undefined || rawStep.length === 0) {
      return { ok: false };
    }

    if (rawStep === 'text()') {
      steps.push({ kind: 'text' });
      continue;
    }

    if (rawStep.startsWith('@')) {
      const name = rawStep.slice(1);
      const parts = name.split(':');
      if (parts.length === 1) {
        steps.push({
          kind: 'attribute',
          prefix: undefined,
          localName: parts[0] ?? '',
        });
        continue;
      }
      if (parts.length === 2) {
        steps.push({
          kind: 'attribute',
          prefix: parts[0],
          localName: parts[1] ?? '',
        });
        continue;
      }
      return { ok: false };
    }

    const parts = rawStep.split(':');
    if (parts.length === 1) {
      steps.push({
        kind: 'element',
        prefix: undefined,
        localName: parts[0] ?? '',
        axis: index === 0 ? firstAxis : 'child',
      });
      continue;
    }
    if (parts.length === 2) {
      steps.push({
        kind: 'element',
        prefix: parts[0],
        localName: parts[1] ?? '',
        axis: index === 0 ? firstAxis : 'child',
      });
      continue;
    }
    return { ok: false };
  }

  return { ok: true, steps };
}

function elementMatchesStep({
  element,
  step,
  namespaces,
}: {
  element: Element;
  step: Extract<SimpleXPathStep, { kind: 'element' }>;
  namespaces: Map<string, string>;
}): boolean {
  if (element.localName !== step.localName) {
    return false;
  }

  const expectedNamespaceUri = resolveNamespaceUri({
    namespaces,
    prefix: step.prefix,
  });
  return expectedNamespaceUri === undefined
    ? element.namespaceURI === null
    : element.namespaceURI === expectedNamespaceUri;
}

function isDocumentNode(node: Node): node is Document {
  return node.nodeType === Node.DOCUMENT_NODE;
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function attributeMatchesStep({
  attribute,
  step,
  namespaces,
}: {
  attribute: Attr;
  step: Extract<SimpleXPathStep, { kind: 'attribute' }>;
  namespaces: Map<string, string>;
}): boolean {
  if (attribute.localName !== step.localName) {
    return false;
  }

  const expectedNamespaceUri = resolveNamespaceUri({
    namespaces,
    prefix: step.prefix,
  });
  return expectedNamespaceUri === undefined
    ? attribute.namespaceURI === null
    : attribute.namespaceURI === expectedNamespaceUri;
}

function evaluateSimpleXPathNodes({
  document,
  expression,
  namespaces,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
}): Node[] | undefined {
  const parsed = parseSimpleXPath({ expression });
  if (!parsed.ok) {
    return undefined;
  }

  let currentNodes: Node[] = [document.documentElement ?? document];

  for (const step of parsed.steps) {
    switch (step.kind) {
    case 'element': {
      const nextNodes: Node[] = [];
      for (const currentNode of currentNodes) {
        if (!isElementNode(currentNode) && !isDocumentNode(currentNode)) {
          continue;
        }

        switch (step.axis) {
        case 'descendant': {
          const root = isDocumentNode(currentNode) ? currentNode.documentElement : currentNode;
          if (root === null) {
            continue;
          }
          const candidates = [root, ...Array.from(root.getElementsByTagName('*'))];
          for (const candidate of candidates) {
            if (elementMatchesStep({ element: candidate, step, namespaces })) {
              nextNodes.push(candidate);
            }
          }
          continue;
        }
        case 'child': {
          const children = isDocumentNode(currentNode)
            ? (currentNode.documentElement === null ? [] : [currentNode.documentElement])
            : Array.from(currentNode.children);
          for (const child of children) {
            if (elementMatchesStep({ element: child, step, namespaces })) {
              nextNodes.push(child);
            }
          }
          break;
        }
        default: {
          const _exhaustive: never = step.axis;
          throw new Error(`Unhandled XML axis: ${_exhaustive}`);
        }
        }
      }
      currentNodes = nextNodes;
      break;
    }
    case 'attribute': {
      const nextNodes: Node[] = [];
      for (const currentNode of currentNodes) {
        if (!isElementNode(currentNode)) {
          continue;
        }
        for (const attribute of Array.from(currentNode.attributes)) {
          if (attributeMatchesStep({ attribute, step, namespaces })) {
            nextNodes.push(attribute);
          }
        }
      }
      currentNodes = nextNodes;
      break;
    }
    case 'text': {
      const nextNodes: Node[] = [];
      for (const currentNode of currentNodes) {
        for (const childNode of Array.from(currentNode.childNodes)) {
          if (childNode.nodeType === Node.TEXT_NODE) {
            nextNodes.push(childNode);
          }
        }
      }
      currentNodes = nextNodes;
      break;
    }
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unhandled simple XPath step: ${_exhaustive}`);
    }
    }
  }

  return currentNodes;
}

function createNamespaceResolver({
  document,
  namespaces,
}: {
  document: Document;
  namespaces: Map<string, string>;
}): XPathNSResolver | null {
  const builtInResolver = document.createNSResolver?.(document.documentElement ?? document);

  if (namespaces.size === 0) {
    return builtInResolver;
  }

  return {
    lookupNamespaceURI(prefix) {
      const normalizedPrefix = prefix ?? '';
      const overridden = namespaces.get(normalizedPrefix);
      if (overridden !== undefined) {
        return overridden;
      }
      return builtInResolver?.lookupNamespaceURI(prefix) ?? null;
    },
  };
}

export function evaluateXPathNodes({
  document,
  expression,
  namespaces,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
}): Array<Node> {
  const result = document.evaluate(
    rewriteNamespacedXPath({ expression, namespaces }),
    document.documentElement ?? document,
    createNamespaceResolver({ document, namespaces }),
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
  if (nodes.length > 0 || namespaces.size === 0) {
    return nodes;
  }

  return evaluateSimpleXPathNodes({
    document,
    expression,
    namespaces,
  }) ?? [];
}

export function evaluateXPathString({
  document,
  expression,
  namespaces,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
}): string {
  const result = document.evaluate(
    rewriteNamespacedXPath({ expression, namespaces }),
    document.documentElement ?? document,
    createNamespaceResolver({ document, namespaces }),
    XPathResult.STRING_TYPE,
    null,
  );
  if (result.stringValue.length > 0 || namespaces.size === 0) {
    return result.stringValue;
  }

  const stringMatch = expression.match(/^string\((.*)\)$/);
  const pathExpression = stringMatch?.[1]?.trim() ?? expression;
  const nodes = evaluateSimpleXPathNodes({
    document,
    expression: pathExpression,
    namespaces,
  });
  const firstNode = nodes?.[0];
  if (firstNode === undefined) {
    return '';
  }

  switch (firstNode.nodeType) {
  case Node.ATTRIBUTE_NODE:
  case Node.TEXT_NODE:
    return firstNode.nodeValue ?? '';
  default:
    return firstNode.textContent ?? '';
  }
}
