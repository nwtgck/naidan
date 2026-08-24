import type { WeshCommandContext } from '@/features/wesh/types';
import { openHandleReadStream, readAllFileBytes } from '@/features/wesh/utils/fs';

const nonXmlXPathWhitespacePattern = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;

function trimXPathWhitespace({
  value,
}: {
  value: string;
}): string {
  return value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/gu, '');
}

function unwrapXPathStringLiteral({
  expression,
}: {
  expression: string;
}): string | undefined {
  const quote = expression[0];
  if ((quote !== '"' && quote !== "'") || expression.at(-1) !== quote) return undefined;
  return expression.indexOf(quote, 1) === expression.length - 1
    ? expression.slice(1, -1)
    : undefined;
}

function assertXPathWhitespaceIsValid({
  expression,
}: {
  expression: string;
}): void {
  let quote: '"' | "'" | undefined;
  for (const character of expression) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (nonXmlXPathWhitespacePattern.test(character)) {
      throw new Error('invalid XPath expression');
    }
  }
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

async function readTextStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
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

export type XmlInputReadResult =
  | { ok: true; label: string; text: string }
  | { ok: false; label: string; message: string };

function formatXmlInputError({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

export async function* readXmlInputs({
  context,
  inputs,
}: {
  context: WeshCommandContext;
  inputs: string[];
}): AsyncGenerator<XmlInputReadResult> {
  const effectiveInputs = inputs.length === 0 ? ['-'] : inputs;
  for (const input of effectiveInputs) {
    if (input === '-') {
      try {
        yield {
          ok: true,
          label: '-',
          text: await readTextStream({
            stream: openHandleReadStream({ handle: context.stdin }),
          }),
        };
      } catch (error: unknown) {
        yield {
          ok: false,
          label: '-',
          message: formatXmlInputError({ error }),
        };
      }
      continue;
    }

    const path = resolvePath({
      cwd: context.cwd,
      path: input,
    });
    try {
      const bytes = await readAllFileBytes({
        files: context.files,
        path,
      });
      yield {
        ok: true,
        label: input,
        text: new TextDecoder().decode(bytes),
      };
    } catch (error: unknown) {
      yield {
        ok: false,
        label: input,
        message: formatXmlInputError({ error }),
      };
    }
  }
}

// wesh is intended to run in the browser, so XML support should prefer the
// platform DOM/XPath APIs instead of Node-specific XML libraries.
export function parseXmlDocument({
  xmlText,
}: {
  xmlText: string,
}): { ok: true, document: Document } | { ok: false, message: string } {
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

  indexXmlDocumentIds({ document, xmlText });

  return {
    ok: true,
    document,
  };
}

export class XmlRuntimeEvaluationError extends Error {
}

const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';
const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';


type XmlIdAttributeDefinition = {
  readonly elementName: string;
  readonly attributeName: string;
  readonly defaultValue: string | undefined;
};

type XmlDocumentMetadata = {
  readonly elementsById: ReadonlyMap<string, Element>;
};

const xmlDocumentMetadata = new WeakMap<Document, XmlDocumentMetadata>();

function tokenizeDtdDeclaration({ value }: { value: string }): readonly string[] {
  const tokens: string[] = [];
  let tokenStart: number | undefined;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStart ??= index;
      continue;
    }
    if (/[\t\n\r ]/u.test(character)) {
      if (tokenStart !== undefined) {
        tokens.push(value.slice(tokenStart, index));
        tokenStart = undefined;
      }
      continue;
    }
    tokenStart ??= index;
  }
  if (tokenStart !== undefined) tokens.push(value.slice(tokenStart));
  return tokens;
}

function decodeDtdDefaultValue({ token }: { token: string }): string | undefined {
  const quote = token[0];
  if ((quote !== '"' && quote !== "'") || token.at(-1) !== quote) return undefined;
  return token.slice(1, -1).replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|apos|gt|lt|quot));/giu,
    (_match, hexadecimal: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
      switch (named) {
      case 'amp': return '&';
      case 'apos': return "'";
      case 'gt': return '>';
      case 'lt': return '<';
      case 'quot': return '"';
      default: return _match;
      }
    },
  );
}

function parseDtdIdAttributeDefinitions({ xmlText }: { xmlText: string }): readonly XmlIdAttributeDefinition[] {
  const definitions: XmlIdAttributeDefinition[] = [];
  let searchIndex = 0;
  while (true) {
    const declarationStart = xmlText.indexOf('<!ATTLIST', searchIndex);
    if (declarationStart < 0) break;
    const previousCommentStart = xmlText.lastIndexOf('<!--', declarationStart);
    const previousCommentEnd = xmlText.lastIndexOf('-->', declarationStart);
    if (previousCommentStart > previousCommentEnd) {
      searchIndex = declarationStart + '<!ATTLIST'.length;
      continue;
    }
    let quote: '"' | "'" | undefined;
    let declarationEnd: number | undefined;
    for (let index = declarationStart + '<!ATTLIST'.length; index < xmlText.length; index += 1) {
      const character = xmlText[index] ?? '';
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        declarationEnd = index;
        break;
      }
    }
    if (declarationEnd === undefined) break;
    searchIndex = declarationEnd + 1;
    const tokens = tokenizeDtdDeclaration({
      value: xmlText.slice(declarationStart + '<!ATTLIST'.length, declarationEnd),
    });
    const elementName = tokens[0];
    if (elementName === undefined) continue;
    let index = 1;
    while (index < tokens.length) {
      const attributeName = tokens[index];
      let attributeType = tokens[index + 1];
      if (attributeName === undefined || attributeType === undefined) break;
      index += 2;
      if (attributeType === 'NOTATION') {
        attributeType += tokens[index] ?? '';
        index += 1;
      } else if (attributeType.startsWith('(') && !attributeType.endsWith(')')) {
        while (index < tokens.length && !attributeType.endsWith(')')) {
          attributeType += tokens[index] ?? '';
          index += 1;
        }
      }
      let defaultToken = tokens[index];
      if (defaultToken === undefined) break;
      index += 1;
      if (defaultToken === '#FIXED') {
        defaultToken = tokens[index];
        if (defaultToken === undefined) break;
        index += 1;
      }
      if (attributeType !== 'ID') continue;
      definitions.push({
        elementName,
        attributeName,
        defaultValue: decodeDtdDefaultValue({ token: defaultToken }),
      });
    }
  }
  return definitions;
}

function isXmlIdToken({
  value,
  allowColon,
}: {
  value: string;
  allowColon: boolean;
}): boolean {
  return allowColon
    ? /^[:\p{L}_][:\p{L}\p{N}\p{M}_.\-\u00b7\u203f-\u2040]*$/u.test(value)
    : /^[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00b7\u203f-\u2040]*$/u.test(value);
}

function indexXmlDocumentIds({
  document,
  xmlText,
}: {
  document: Document;
  xmlText: string;
}): void {
  const definitionsByElementName = new Map<string, XmlIdAttributeDefinition[]>();
  for (const definition of parseDtdIdAttributeDefinitions({ xmlText })) {
    const definitions = definitionsByElementName.get(definition.elementName) ?? [];
    definitions.push(definition);
    definitionsByElementName.set(definition.elementName, definitions);
  }

  const elementsById = new Map<string, Element>();
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    const definitions = definitionsByElementName.get(element.nodeName) ?? [];
    for (const definition of definitions) {
      let value = element.getAttribute(definition.attributeName);
      if (value === null && definition.defaultValue !== undefined) {
        element.setAttribute(definition.attributeName, definition.defaultValue);
        value = definition.defaultValue;
      }
      if (value === null) continue;
      if (value.length > 0 && !elementsById.has(value)) {
        elementsById.set(value, element);
      }
    }

    const xmlId = element.getAttributeNS(XML_NAMESPACE_URI, 'id');
    if (xmlId !== null) {
      if (isXmlIdToken({ value: xmlId, allowColon: false }) && !elementsById.has(xmlId)) {
        elementsById.set(xmlId, element);
      }
    }
  }
  xmlDocumentMetadata.set(document, { elementsById });
}

function isNamespaceDeclaration({ attribute }: { attribute: Attr }): boolean {
  return attribute.namespaceURI === XMLNS_NAMESPACE_URI
    || attribute.name === 'xmlns'
    || attribute.name.startsWith('xmlns:');
}

function cloneElementWithInScopeNamespaces({ element }: { element: Element }): Element {
  const ancestors: Element[] = [];
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    ancestors.push(current);
  }
  ancestors.reverse();

  const namespaceDeclarations = new Map<string, { name: string; value: string }>();
  for (const ancestor of ancestors) {
    for (const attribute of Array.from(ancestor.attributes)) {
      if (!isNamespaceDeclaration({ attribute })) continue;
      const key = attribute.name === 'xmlns' ? '' : attribute.localName;
      namespaceDeclarations.set(key, { name: attribute.name, value: attribute.value });
    }
  }

  const clone = element.cloneNode(true) as Element;
  const ordinaryAttributes = Array.from(clone.attributes).filter((attribute) => (
    !isNamespaceDeclaration({ attribute })
  ));
  for (const attribute of Array.from(clone.attributes)) {
    clone.removeAttributeNode(attribute);
  }
  for (const declaration of namespaceDeclarations.values()) {
    clone.setAttributeNS(XMLNS_NAMESPACE_URI, declaration.name, declaration.value);
  }
  for (const attribute of ordinaryAttributes) {
    clone.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
  return clone;
}

export function serializeXmlNode({
  node,
}: {
  node: Node,
}): string {
  if (node.nodeType === Node.CDATA_SECTION_NODE) {
    const ownerDocument = node.ownerDocument;
    if (ownerDocument === null) return node.nodeValue ?? '';
    return new XMLSerializer().serializeToString(
      ownerDocument.createTextNode(node.nodeValue ?? ''),
    );
  }
  const serializableNode = node.nodeType === Node.ELEMENT_NODE
    ? cloneElementWithInScopeNamespaces({ element: node as Element })
    : node;
  return new XMLSerializer().serializeToString(serializableNode);
}

function escapeXPathLiteral({
  value,
}: {
  value: string,
}): string {
  if (!value.includes('\'')) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;

  const parts = value.split('\'');
  const argumentsList: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) argumentsList.push(`"'"`);
    argumentsList.push(`'${part}'`);
  }
  return `concat(${argumentsList.join(', ')})`;
}

function rewriteNamespacedXPath({
  expression,
  namespaces,
}: {
  expression: string,
  namespaces: Map<string, string>,
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

type SimpleXPathPredicate =
  | { kind: 'position'; position: number }
  | { kind: 'attribute-equals'; prefix: string | undefined; localName: string; value: string }
  | { kind: 'expression'; expression: string };

type SimpleXPathElementAxis =
  | 'child'
  | 'descendant'
  | 'following-sibling'
  | 'preceding-sibling';

type SimpleXPathExplicitAxis =
  | 'ancestor'
  | 'ancestor-or-self'
  | 'attribute'
  | 'child'
  | 'descendant'
  | 'descendant-or-self'
  | 'following'
  | 'following-sibling'
  | 'parent'
  | 'preceding'
  | 'preceding-sibling'
  | 'self';

type SimpleXPathAxisNodeTest =
  | { kind: 'name'; prefix: string | undefined; localName: string }
  | { kind: 'wildcard'; prefix: string | undefined }
  | { kind: 'node' }
  | { kind: 'comment' }
  | { kind: 'processing-instruction'; target: string | undefined }
  | { kind: 'text' };

type SimpleXPathStep =
  | {
      kind: 'element';
      prefix: string | undefined;
      localName: string;
      axis: SimpleXPathElementAxis;
      predicates: readonly SimpleXPathPredicate[];
    }
  | { kind: 'attribute'; prefix: string | undefined; localName: string }
  | {
      kind: 'attribute-wildcard';
      prefix: string | undefined;
      predicates: readonly SimpleXPathPredicate[];
    }
  | {
      kind: 'wildcard-element';
      prefix: string | undefined;
      axis: SimpleXPathElementAxis;
      predicates: readonly SimpleXPathPredicate[];
    }
  | { kind: 'node'; axis: 'child' | 'descendant'; predicates: readonly SimpleXPathPredicate[] }
  | { kind: 'comment'; axis: 'child' | 'descendant'; predicates: readonly SimpleXPathPredicate[] }
  | { kind: 'processing-instruction'; axis: 'child' | 'descendant'; target: string | undefined; predicates: readonly SimpleXPathPredicate[] }
  | { kind: 'text'; axis: 'child' | 'descendant'; predicates: readonly SimpleXPathPredicate[] }
  | {
      kind: 'explicit-axis';
      axis: SimpleXPathExplicitAxis;
      nodeTest: SimpleXPathAxisNodeTest;
      predicates: readonly SimpleXPathPredicate[];
    }
  | { kind: 'self' }
  | { kind: 'parent' };

type ParsedSimpleXPath = {
  readonly absolute: boolean;
  readonly steps: readonly SimpleXPathStep[];
};

function resolveNamespaceUri({
  namespaces,
  prefix,
  document,
}: {
  namespaces: Map<string, string>;
  prefix: string | undefined;
  document: Document;
}): string | null | undefined {
  if (prefix === undefined) return undefined;
  if (prefix === 'xml') return XML_NAMESPACE_URI;

  const overridden = namespaces.get(prefix);
  if (overridden !== undefined) return overridden;
  return document.documentElement?.lookupNamespaceURI(prefix) ?? null;
}

function isSimpleXPathName({ value }: { value: string }): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value);
}

function parseSimpleQualifiedName({
  value,
}: {
  value: string;
}): { prefix: string | undefined; localName: string } | undefined {
  const parts = value.split(':');
  if (parts.length === 1) {
    const localName = parts[0] ?? '';
    return isSimpleXPathName({ value: localName })
      ? { prefix: undefined, localName }
      : undefined;
  }
  if (parts.length === 2) {
    const prefix = parts[0] ?? '';
    const localName = parts[1] ?? '';
    return isSimpleXPathName({ value: prefix }) && isSimpleXPathName({ value: localName })
      ? { prefix, localName }
      : undefined;
  }
  return undefined;
}

function parseSimplePredicate({
  value,
}: {
  value: string;
}): SimpleXPathPredicate | false {
  const trimmed = trimXPathWhitespace({ value });
  if (trimmed.length === 0) return false;
  if (/^[1-9]\d*$/u.test(trimmed)) {
    return { kind: 'position', position: Number.parseInt(trimmed, 10) };
  }

  const attributeMatch = trimmed.match(/^@([^= \t\n\r]+)[ \t\n\r]*=[ \t\n\r]*(?:"([^"]*)"|'([^']*)')$/u);
  if (attributeMatch !== null) {
    const name = parseSimpleQualifiedName({ value: attributeMatch[1] ?? '' });
    if (name !== undefined) {
      return {
        kind: 'attribute-equals',
        prefix: name.prefix,
        localName: name.localName,
        value: attributeMatch[2] ?? attributeMatch[3] ?? '',
      };
    }
  }

  return { kind: 'expression', expression: trimmed };
}

function splitSimpleXPathStepPredicates({
  value,
}: {
  value: string;
}): { selector: string; predicateValues: readonly string[] } | undefined {
  let firstPredicateIndex: number | undefined;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      firstPredicateIndex = index;
      break;
    }
  }

  if (firstPredicateIndex === undefined) {
    const selector = trimXPathWhitespace({ value });
    return selector.length === 0 ? undefined : { selector, predicateValues: [] };
  }

  const selector = trimXPathWhitespace({ value: value.slice(0, firstPredicateIndex) });
  if (selector.length === 0) return undefined;
  const predicateValues: string[] = [];
  let cursor = firstPredicateIndex;
  while (cursor < value.length) {
    while (/[\t\n\r ]/u.test(value[cursor] ?? '')) cursor += 1;
    if (cursor >= value.length) break;
    if (value[cursor] !== '[') return undefined;

    const openingIndex = cursor;
    let depth = 1;
    quote = undefined;
    cursor += 1;
    for (; cursor < value.length; cursor += 1) {
      const character = value[cursor] ?? '';
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '[') depth += 1;
      else if (character === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0 || quote !== undefined) return undefined;
    predicateValues.push(value.slice(openingIndex + 1, cursor));
    cursor += 1;
  }
  return { selector, predicateValues };
}

function parseSimplePredicates({
  values,
}: {
  values: readonly string[];
}): readonly SimpleXPathPredicate[] | undefined {
  const predicates: SimpleXPathPredicate[] = [];
  for (const value of values) {
    const predicate = parseSimplePredicate({ value });
    if (predicate === false) return undefined;
    predicates.push(predicate);
  }
  return predicates;
}

type RawSimpleXPathStep = {
  readonly axis: 'child' | 'descendant';
  readonly value: string;
};

function splitSimpleXPathSteps({
  expression,
}: {
  expression: string;
}): { absolute: boolean; steps: readonly RawSimpleXPathStep[] } | undefined {
  const value = trimXPathWhitespace({ value: expression });
  if (value.length === 0) return undefined;

  let absolute = false;
  let axis: RawSimpleXPathStep['axis'] = 'child';
  let start = 0;
  if (value.startsWith('//')) {
    absolute = true;
    axis = 'descendant';
    start = 2;
  } else if (value.startsWith('/')) {
    absolute = true;
    start = 1;
  }

  const steps: RawSimpleXPathStep[] = [];
  let bracketDepth = 0;
  let quote: '"' | "'" | undefined;
  let segmentStart = start;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth -= 1;
      if (bracketDepth < 0) return undefined;
      continue;
    }
    if (character !== '/' || bracketDepth !== 0) continue;

    const stepValue = value.slice(segmentStart, index);
    if (stepValue.length === 0) return undefined;
    steps.push({ axis, value: stepValue });

    if (value[index + 1] === '/') {
      axis = 'descendant';
      index += 1;
    } else {
      axis = 'child';
    }
    segmentStart = index + 1;
  }

  if (quote !== undefined || bracketDepth !== 0) return undefined;
  const finalValue = value.slice(segmentStart);
  if (finalValue.length === 0) return undefined;
  steps.push({ axis, value: finalValue });
  return { absolute, steps };
}

function parseSimpleXPathAxisNodeTest({
  selector,
}: {
  selector: string;
}): SimpleXPathAxisNodeTest | undefined {
  if (selector === '*') return { kind: 'wildcard', prefix: undefined };
  const namespaceWildcard = selector.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\*$/u);
  if (namespaceWildcard !== null) {
    return { kind: 'wildcard', prefix: namespaceWildcard[1] };
  }
  if (selector === 'node()') return { kind: 'node' };
  if (selector === 'comment()') return { kind: 'comment' };
  if (selector === 'text()') return { kind: 'text' };

  const processingInstructionInner = unwrapXPathFunction({
    expression: selector,
    name: 'processing-instruction',
  });
  if (processingInstructionInner !== undefined) {
    if (processingInstructionInner.length === 0) {
      return { kind: 'processing-instruction', target: undefined };
    }
    const first = processingInstructionInner[0];
    const last = processingInstructionInner.at(-1);
    if ((first !== '"' && first !== "'") || last !== first) return undefined;
    return {
      kind: 'processing-instruction',
      target: processingInstructionInner.slice(1, -1),
    };
  }

  const name = parseSimpleQualifiedName({ value: selector });
  return name === undefined ? undefined : { kind: 'name', ...name };
}

function parseSimpleXPath({
  expression,
}: {
  expression: string;
}): ParsedSimpleXPath | undefined {
  const split = splitSimpleXPathSteps({ expression });
  if (split === undefined) return undefined;

  const steps: SimpleXPathStep[] = [];
  for (const rawStep of split.steps) {
    let stepValue = rawStep.value;
    const elementAxis: SimpleXPathElementAxis = rawStep.axis;
    const explicitAxis = stepValue.match(
      /^(ancestor-or-self|descendant-or-self|following-sibling|preceding-sibling|ancestor|attribute|child|descendant|following|parent|preceding|self)::(.+)$/u,
    );
    if (explicitAxis !== null) {
      switch (rawStep.axis) {
      case 'child':
        break;
      case 'descendant':
        return undefined;
      default: {
        const _exhaustive: never = rawStep.axis;
        throw new Error(`Unhandled raw XPath axis: ${String(_exhaustive)}`);
      }
      }
      const axis = explicitAxis[1] as SimpleXPathExplicitAxis;
      stepValue = explicitAxis[2] ?? '';
      const explicitSplitStep = splitSimpleXPathStepPredicates({ value: stepValue });
      if (explicitSplitStep === undefined) return undefined;
      const explicitPredicates = parseSimplePredicates({
        values: explicitSplitStep.predicateValues,
      });
      if (explicitPredicates === undefined) return undefined;
      const nodeTest = parseSimpleXPathAxisNodeTest({ selector: explicitSplitStep.selector });
      if (nodeTest === undefined) return undefined;
      steps.push({
        kind: 'explicit-axis',
        axis,
        nodeTest,
        predicates: explicitPredicates,
      });
      continue;
    }

    const splitStep = splitSimpleXPathStepPredicates({ value: stepValue });
    if (splitStep === undefined) return undefined;
    const predicates = parseSimplePredicates({ values: splitStep.predicateValues });
    if (predicates === undefined) return undefined;
    const selector = splitStep.selector;

    if (selector === '.' || selector === '..') {
      if (predicates.length > 0) return undefined;
      switch (rawStep.axis) {
      case 'child':
        switch (selector) {
        case '.':
          steps.push({ kind: 'self' });
          continue;
        case '..':
          steps.push({ kind: 'parent' });
          continue;
        default: {
          const _exhaustive: never = selector;
          throw new Error(`Unhandled simple XPath context selector: ${String(_exhaustive)}`);
        }
        }
      case 'descendant':
        return undefined;
      default: {
        const _exhaustive: never = rawStep.axis;
        throw new Error(`Unhandled simple XPath context axis: ${String(_exhaustive)}`);
      }
      }
    }

    if (selector === 'text()') {
      steps.push({ kind: 'text', axis: rawStep.axis, predicates });
      continue;
    }

    if (selector === '*') {
      steps.push({
        kind: 'wildcard-element',
        prefix: undefined,
        axis: elementAxis,
        predicates,
      });
      continue;
    }

    const elementNamespaceWildcard = selector.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\*$/u);
    if (elementNamespaceWildcard !== null) {
      steps.push({
        kind: 'wildcard-element',
        prefix: elementNamespaceWildcard[1],
        axis: elementAxis,
        predicates,
      });
      continue;
    }

    if (selector === 'node()') {
      steps.push({ kind: 'node', axis: rawStep.axis, predicates });
      continue;
    }

    if (selector === 'comment()') {
      steps.push({ kind: 'comment', axis: rawStep.axis, predicates });
      continue;
    }

    const processingInstructionInner = unwrapXPathFunction({
      expression: selector,
      name: 'processing-instruction',
    });
    if (processingInstructionInner !== undefined) {
      const target = processingInstructionInner.length === 0
        ? undefined
        : (() => {
          const first = processingInstructionInner[0];
          const last = processingInstructionInner.at(-1);
          return (first === '"' || first === "'") && last === first
            ? processingInstructionInner.slice(1, -1)
            : undefined;
        })();
      if (processingInstructionInner.length > 0 && target === undefined) return undefined;
      steps.push({
        kind: 'processing-instruction',
        axis: rawStep.axis,
        target,
        predicates,
      });
      continue;
    }

    if (selector === '@*') {
      steps.push({ kind: 'attribute-wildcard', prefix: undefined, predicates });
      continue;
    }

    const attributeNamespaceWildcard = selector.match(
      /^@([A-Za-z_][A-Za-z0-9_.-]*):\*$/u,
    );
    if (attributeNamespaceWildcard !== null) {
      steps.push({
        kind: 'attribute-wildcard',
        prefix: attributeNamespaceWildcard[1],
        predicates,
      });
      continue;
    }

    if (selector.startsWith('@')) {
      if (predicates.length > 0) return undefined;
      const name = parseSimpleQualifiedName({ value: selector.slice(1) });
      if (name === undefined) return undefined;
      steps.push({ kind: 'attribute', ...name });
      continue;
    }

    const name = parseSimpleQualifiedName({ value: selector });
    if (name === undefined) return undefined;
    steps.push({
      kind: 'element',
      ...name,
      axis: elementAxis,
      predicates,
    });
  }

  return { absolute: split.absolute, steps };
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
  if (element.localName !== step.localName) return false;
  const expectedNamespaceUri = resolveNamespaceUri({
    namespaces,
    prefix: step.prefix,
    document: element.ownerDocument,
  });
  if (expectedNamespaceUri === null) {
    throw new XmlRuntimeEvaluationError(`Undefined namespace prefix: ${step.prefix ?? ''}`);
  }
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

function compareXPathDocumentOrder({ left, right }: { left: Node; right: Node }): number {
  if (left === right) return 0;

  const leftAttribute = left.nodeType === Node.ATTRIBUTE_NODE ? left as Attr : undefined;
  const rightAttribute = right.nodeType === Node.ATTRIBUTE_NODE ? right as Attr : undefined;
  const leftAnchor = leftAttribute?.ownerElement ?? left;
  const rightAnchor = rightAttribute?.ownerElement ?? right;

  if (leftAnchor === rightAnchor) {
    if (leftAttribute !== undefined && rightAttribute !== undefined) {
      const attributes = leftAttribute.ownerElement === null
        ? []
        : Array.from(leftAttribute.ownerElement.attributes);
      return attributes.indexOf(leftAttribute) - attributes.indexOf(rightAttribute);
    }
    if (leftAttribute !== undefined) return 1;
    if (rightAttribute !== undefined) return -1;
    return 0;
  }

  const position = leftAnchor.compareDocumentPosition(rightAnchor);
  if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
  if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
  return 0;
}

function sortNodesInDocumentOrder({ nodes }: { nodes: Node[] }): void {
  nodes.sort((left, right) => compareXPathDocumentOrder({ left, right }));
}

function forEachDescendantNode({
  parent,
  visit,
}: {
  parent: Node;
  visit: ({ node }: { node: Node }) => void;
}): void {
  const pending: Node[] = [];
  for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
    const child = parent.childNodes[index];
    if (child !== undefined) pending.push(child);
  }
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    visit({ node });
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (child !== undefined) pending.push(child);
    }
  }
}

function nodeMatchesNamespaceWildcard({
  node,
  prefix,
  namespaces,
}: {
  node: Element | Attr;
  prefix: string | undefined;
  namespaces: Map<string, string>;
}): boolean {
  if (prefix === undefined) return true;
  const expectedNamespaceUri = resolveNamespaceUri({
    namespaces,
    prefix,
    document: node.ownerDocument,
  });
  if (expectedNamespaceUri === null) {
    throw new XmlRuntimeEvaluationError(`Undefined namespace prefix: ${prefix}`);
  }
  return node.namespaceURI === expectedNamespaceUri;
}

function isXPathAttribute({ attribute }: { attribute: Attr }): boolean {
  return attribute.namespaceURI !== XMLNS_NAMESPACE_URI;
}

function attributeMatchesName({
  attribute,
  prefix,
  localName,
  namespaces,
}: {
  attribute: Attr;
  prefix: string | undefined;
  localName: string;
  namespaces: Map<string, string>;
}): boolean {
  if (!isXPathAttribute({ attribute })) return false;
  if (attribute.localName !== localName) return false;
  const expectedNamespaceUri = resolveNamespaceUri({
    namespaces,
    prefix,
    document: attribute.ownerDocument,
  });
  if (expectedNamespaceUri === null) {
    throw new XmlRuntimeEvaluationError(`Undefined namespace prefix: ${prefix ?? ''}`);
  }
  return expectedNamespaceUri === undefined
    ? attribute.namespaceURI === null
    : attribute.namespaceURI === expectedNamespaceUri;
}

function elementMatchesPredicate({
  element,
  predicate,
  namespaces,
}: {
  element: Element;
  predicate: Extract<SimpleXPathPredicate, { kind: 'attribute-equals' }>;
  namespaces: Map<string, string>;
}): boolean {
  return Array.from(element.attributes).some((attribute) => (
    attributeMatchesName({
      attribute,
      prefix: predicate.prefix,
      localName: predicate.localName,
      namespaces,
    }) && attribute.value === predicate.value
  ));
}

function evaluateXPathPredicate({
  document,
  expression,
  namespaces,
  contextNode,
  contextPosition,
  contextSize,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode: Node;
  contextPosition: number;
  contextSize: number;
}): boolean {
  const contextualExpression = rewriteXPathContextFunctions({
    expression,
    contextPosition,
    contextSize,
  });
  const trimmed = trimXPathWhitespace({ value: contextualExpression });
  const unwrapped = unwrapXPathParentheses({ expression: trimmed });
  const booleanExpression = unwrapped === undefined
    ? trimmed
    : trimXPathWhitespace({ value: unwrapped });
  const hasLogicalOperator = splitTopLevelXPathLogicalOperator({
    expression: booleanExpression,
    operator: 'or',
  }) !== undefined || splitTopLevelXPathLogicalOperator({
    expression: booleanExpression,
    operator: 'and',
  }) !== undefined;

  if (hasLogicalOperator || parseTopLevelXPathComparison({ expression: booleanExpression }) !== undefined) {
    return evaluateXPathBoolean({ document, expression: booleanExpression, namespaces, contextNode });
  }
  const simpleBoolean = evaluateSimpleXPathBooleanValue({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (simpleBoolean !== undefined) return simpleBoolean;
  if (unwrapXPathFunction({ expression: trimmed, name: 'not' }) !== undefined) {
    return evaluateXPathBoolean({ document, expression: trimmed, namespaces, contextNode });
  }

  const nodes = evaluateSimpleXPathNodes({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (nodes !== undefined) return nodes.length > 0;

  const scalar = evaluateSimpleXPathScalarValue({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (scalar !== undefined) {
    switch (scalar.kind) {
    case 'number':
      return scalar.value === contextPosition;
    case 'boolean':
    case 'string':
      return xpathScalarToBoolean({ value: scalar });
    default: {
      const _exhaustive: never = scalar;
      throw new Error(`Unhandled XPath predicate scalar: ${String(_exhaustive)}`);
    }
    }
  }

  return evaluateXPathBoolean({ document, expression: trimmed, namespaces, contextNode });
}

function applyXPathPredicates<TNode extends Node>({
  nodes,
  predicates,
  namespaces,
}: {
  nodes: readonly TNode[];
  predicates: readonly SimpleXPathPredicate[];
  namespaces: Map<string, string>;
}): readonly TNode[] {
  let selected = [...nodes];
  for (const predicate of predicates) {
    switch (predicate.kind) {
    case 'position': {
      const node = selected[predicate.position - 1];
      selected = node === undefined ? [] : [node];
      break;
    }
    case 'attribute-equals':
      selected = selected.filter((node): boolean => (
        isElementNode(node) && elementMatchesPredicate({ element: node, predicate, namespaces })
      ));
      break;
    case 'expression': {
      const contextSize = selected.length;
      selected = selected.filter((node, index) => {
        const document = isDocumentNode(node) ? node : node.ownerDocument;
        if (document === null) throw new Error('XPath predicate node has no owner document');
        return evaluateXPathPredicate({
          document,
          expression: predicate.expression,
          namespaces,
          contextNode: node,
          contextPosition: index + 1,
          contextSize,
        });
      });
      break;
    }
    default: {
      const _exhaustive: never = predicate;
      throw new Error(`Unhandled simple XPath predicate: ${String(_exhaustive)}`);
    }
    }
  }
  return selected;
}

function getXPathDescendantStepParents({ node }: { node: Node }): readonly Node[] {
  const parents: Node[] = [node];
  forEachDescendantNode({
    parent: node,
    visit: ({ node: descendant }) => parents.push(descendant),
  });
  return parents;
}

function getXPathParentNode({ node }: { node: Node }): Node | null {
  return node.nodeType === Node.ATTRIBUTE_NODE
    ? (node as Attr).ownerElement
    : node.parentNode;
}

function getXPathDocument({ node }: { node: Node }): Document {
  if (isDocumentNode(node)) return node;
  if (node.ownerDocument === null) throw new Error('XPath node has no owner document');
  return node.ownerDocument;
}

function getXPathDocumentOrderNodes({ document }: { document: Document }): readonly Node[] {
  const nodes: Node[] = [];
  forEachDescendantNode({
    parent: document,
    visit: ({ node }) => nodes.push(node),
  });
  return nodes;
}

function getXPathAncestors({ node, includeSelf }: { node: Node; includeSelf: boolean }): Node[] {
  const nodes: Node[] = includeSelf ? [node] : [];
  let current = getXPathParentNode({ node });
  while (current !== null) {
    nodes.push(current);
    current = getXPathParentNode({ node: current });
  }
  return nodes;
}

function isDomDescendantOf({ node, ancestor }: { node: Node; ancestor: Node }): boolean {
  let current = node.parentNode;
  while (current !== null) {
    if (current === ancestor) return true;
    current = current.parentNode;
  }
  return false;
}

function getXPathExplicitAxisCandidates({
  node,
  axis,
  documentOrderCache,
}: {
  node: Node;
  axis: SimpleXPathExplicitAxis;
  documentOrderCache: WeakMap<Document, readonly Node[]>;
}): Node[] {
  switch (axis) {
  case 'self':
    return [node];
  case 'parent': {
    const parent = getXPathParentNode({ node });
    return parent === null ? [] : [parent];
  }
  case 'ancestor':
    return getXPathAncestors({ node, includeSelf: false });
  case 'ancestor-or-self':
    return getXPathAncestors({ node, includeSelf: true });
  case 'child':
    return Array.from(node.childNodes);
  case 'attribute':
    return isElementNode(node)
      ? Array.from(node.attributes).filter((attribute) => isXPathAttribute({ attribute }))
      : [];
  case 'descendant': {
    const descendants: Node[] = [];
    forEachDescendantNode({ parent: node, visit: ({ node: child }) => descendants.push(child) });
    return descendants;
  }
  case 'descendant-or-self': {
    const descendants: Node[] = [node];
    forEachDescendantNode({ parent: node, visit: ({ node: child }) => descendants.push(child) });
    return descendants;
  }
  case 'following-sibling':
  case 'preceding-sibling': {
    if (node.nodeType === Node.ATTRIBUTE_NODE || node.parentNode === null) return [];
    const siblings = Array.from(node.parentNode.childNodes);
    const index = siblings.findIndex((sibling) => sibling === node);
    switch (axis) {
    case 'following-sibling':
      return siblings.slice(index + 1);
    case 'preceding-sibling':
      return siblings.slice(0, index).reverse();
    default: {
      const _exhaustive: never = axis;
      throw new Error(`Unhandled sibling XPath axis: ${String(_exhaustive)}`);
    }
    }
  }
  case 'following':
  case 'preceding': {
    const document = getXPathDocument({ node });
    const anchor = node.nodeType === Node.ATTRIBUTE_NODE
      ? (node as Attr).ownerElement
      : node;
    if (anchor === null || isDocumentNode(anchor)) return [];
    const cachedDocumentNodes = documentOrderCache.get(document);
    const documentNodes = cachedDocumentNodes ?? getXPathDocumentOrderNodes({ document });
    if (cachedDocumentNodes === undefined) documentOrderCache.set(document, documentNodes);
    const anchorIndex = documentNodes.indexOf(anchor);
    if (anchorIndex < 0) return [];
    switch (axis) {
    case 'following':
      return documentNodes.slice(anchorIndex + 1).filter((candidate) => (
        !isDomDescendantOf({ node: candidate, ancestor: anchor })
      ));
    case 'preceding': {
      const ancestors = new Set(getXPathAncestors({ node: anchor, includeSelf: false }));
      return documentNodes.slice(0, anchorIndex).filter((candidate) => (
        !ancestors.has(candidate)
      )).reverse();
    }
    default: {
      const _exhaustive: never = axis;
      throw new Error(`Unhandled document-order XPath axis: ${String(_exhaustive)}`);
    }
    }
  }
  default: {
    const _exhaustive: never = axis;
    throw new Error(`Unhandled explicit XPath axis: ${String(_exhaustive)}`);
  }
  }
}

function xpathAxisHasAttributePrincipalNodeType({
  axis,
}: {
  axis: SimpleXPathExplicitAxis;
}): boolean {
  switch (axis) {
  case 'attribute':
    return true;
  case 'ancestor':
  case 'ancestor-or-self':
  case 'child':
  case 'descendant':
  case 'descendant-or-self':
  case 'following':
  case 'following-sibling':
  case 'parent':
  case 'preceding':
  case 'preceding-sibling':
  case 'self':
    return false;
  default: {
    const _exhaustive: never = axis;
    throw new Error(`Unhandled XPath principal-node axis: ${String(_exhaustive)}`);
  }
  }
}

function xpathAxisNodeMatchesTest({
  node,
  axis,
  nodeTest,
  namespaces,
}: {
  node: Node;
  axis: SimpleXPathExplicitAxis;
  nodeTest: SimpleXPathAxisNodeTest;
  namespaces: Map<string, string>;
}): boolean {
  switch (nodeTest.kind) {
  case 'node':
    return true;
  case 'comment':
    return node.nodeType === Node.COMMENT_NODE;
  case 'text':
    return node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE;
  case 'processing-instruction':
    return node.nodeType === Node.PROCESSING_INSTRUCTION_NODE
      && (nodeTest.target === undefined
        || (node as ProcessingInstruction).target === nodeTest.target);
  case 'wildcard': {
    if (xpathAxisHasAttributePrincipalNodeType({ axis })) {
      return node.nodeType === Node.ATTRIBUTE_NODE
        && isXPathAttribute({ attribute: node as Attr })
        && nodeMatchesNamespaceWildcard({
          node: node as Attr,
          prefix: nodeTest.prefix,
          namespaces,
        });
    }
    return node.nodeType === Node.ELEMENT_NODE && nodeMatchesNamespaceWildcard({
      node: node as Element,
      prefix: nodeTest.prefix,
      namespaces,
    });
  }
  case 'name':
    if (xpathAxisHasAttributePrincipalNodeType({ axis })) {
      return node.nodeType === Node.ATTRIBUTE_NODE && attributeMatchesName({
        attribute: node as Attr,
        prefix: nodeTest.prefix,
        localName: nodeTest.localName,
        namespaces,
      });
    }
    return node.nodeType === Node.ELEMENT_NODE && elementMatchesStep({
      element: node as Element,
      step: {
        kind: 'element',
        prefix: nodeTest.prefix,
        localName: nodeTest.localName,
        axis: 'child',
        predicates: [],
      },
      namespaces,
    });
  default: {
    const _exhaustive: never = nodeTest;
    throw new Error(`Unhandled explicit XPath node test: ${String(_exhaustive)}`);
  }
  }
}

function getSimpleXPathStepParents({
  node,
  axis,
}: {
  node: Node;
  axis: 'child' | 'descendant';
}): readonly Node[] {
  switch (axis) {
  case 'child':
    return [node];
  case 'descendant':
    return getXPathDescendantStepParents({ node });
  default: {
    const _exhaustive: never = axis;
    throw new Error(`Unhandled simple XPath descendant axis: ${String(_exhaustive)}`);
  }
  }
}

function evaluateSimpleXPathNodes({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode?: Node;
}): Node[] | undefined {
  const idNodes = evaluateXPathIdNodes({ document, expression, namespaces, contextNode });
  if (idNodes !== undefined) return idNodes;

  const parsed = parseSimpleXPath({ expression });
  if (parsed === undefined) return undefined;

  let currentNodes: Node[] = [
    parsed.absolute ? document : (contextNode ?? document),
  ];
  const documentOrderCache = new WeakMap<Document, readonly Node[]>();

  for (const step of parsed.steps) {
    switch (step.kind) {
    case 'element': {
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        if (!isElementNode(currentNode) && !isDocumentNode(currentNode)) continue;
        const parents: Array<Document | Element> = [];
        const axis = step.axis;
        switch (axis) {
        case 'descendant': {
          parents.push(currentNode);
          const root = isDocumentNode(currentNode) ? currentNode.documentElement : currentNode;
          if (root !== null) {
            if (isDocumentNode(currentNode)) parents.push(root);
            for (const descendant of root.getElementsByTagName('*')) parents.push(descendant);
          }
          break;
        }
        case 'child':
          parents.push(currentNode);
          break;
        case 'following-sibling':
        case 'preceding-sibling': {
          if (!isElementNode(currentNode) || currentNode.parentElement === null) break;
          const siblings = Array.from(currentNode.parentElement.children);
          const currentIndex = siblings.indexOf(currentNode);
          const axisCandidates = (() => {
            switch (axis) {
            case 'following-sibling':
              return siblings.slice(currentIndex + 1);
            case 'preceding-sibling':
              return siblings.slice(0, currentIndex).reverse();
            default: {
              const exhaustiveAxis: never = axis;
              throw new Error(
                `Unhandled XML sibling axis: ${String(exhaustiveAxis)}`,
              );
            }
            }
          })();
          const matching = axisCandidates.filter((candidate) => elementMatchesStep({
            element: candidate,
            step,
            namespaces,
          }));
          for (const selected of applyXPathPredicates({
            nodes: matching,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
          break;
        }
        default: {
          const exhaustiveAxis: never = axis;
          throw new Error(`Unhandled XML axis: ${String(exhaustiveAxis)}`);
        }
        }

        for (const parent of parents) {
          const candidates = isDocumentNode(parent)
            ? (parent.documentElement === null ? [] : [parent.documentElement])
            : Array.from(parent.children);
          const matching = candidates.filter((candidate) => elementMatchesStep({
            element: candidate,
            step,
            namespaces,
          }));
          for (const selected of applyXPathPredicates({
            nodes: matching,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
        }
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'attribute': {
      const nextNodes: Node[] = [];
      for (const currentNode of currentNodes) {
        if (!isElementNode(currentNode)) continue;
        for (const attribute of Array.from(currentNode.attributes)) {
          if (attributeMatchesName({
            attribute,
            prefix: step.prefix,
            localName: step.localName,
            namespaces,
          })) {
            nextNodes.push(attribute);
          }
        }
      }
      currentNodes = nextNodes;
      break;
    }
    case 'attribute-wildcard': {
      const nextNodes: Node[] = [];
      for (const currentNode of currentNodes) {
        if (!isElementNode(currentNode)) continue;
        const attributes = Array.from(currentNode.attributes).filter((attribute) => (
          isXPathAttribute({ attribute }) && nodeMatchesNamespaceWildcard({
            node: attribute,
            prefix: step.prefix,
            namespaces,
          })
        ));
        const selectedAttributes = applyXPathPredicates({
          nodes: attributes,
          predicates: step.predicates,
          namespaces,
        });
        for (const attribute of selectedAttributes) nextNodes.push(attribute);
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'wildcard-element': {
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        if (!isElementNode(currentNode) && !isDocumentNode(currentNode)) continue;
        const parents: Array<Document | Element> = [];
        const axis = step.axis;
        switch (axis) {
        case 'descendant': {
          parents.push(currentNode);
          const root = isDocumentNode(currentNode) ? currentNode.documentElement : currentNode;
          if (root !== null) {
            if (isDocumentNode(currentNode)) parents.push(root);
            for (const descendant of root.getElementsByTagName('*')) parents.push(descendant);
          }
          break;
        }
        case 'child':
          parents.push(currentNode);
          break;
        case 'following-sibling':
        case 'preceding-sibling': {
          if (!isElementNode(currentNode) || currentNode.parentElement === null) break;
          const siblings = Array.from(currentNode.parentElement.children);
          const currentIndex = siblings.indexOf(currentNode);
          const axisCandidates = (() => {
            switch (axis) {
            case 'following-sibling':
              return siblings.slice(currentIndex + 1);
            case 'preceding-sibling':
              return siblings.slice(0, currentIndex).reverse();
            default: {
              const exhaustiveAxis: never = axis;
              throw new Error(
                `Unhandled XML wildcard sibling axis: ${String(exhaustiveAxis)}`,
              );
            }
            }
          })();
          const matching = axisCandidates.filter((candidate) => nodeMatchesNamespaceWildcard({
            node: candidate,
            prefix: step.prefix,
            namespaces,
          }));
          for (const selected of applyXPathPredicates({
            nodes: matching,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
          break;
        }
        default: {
          const exhaustiveAxis: never = axis;
          throw new Error(`Unhandled XML wildcard axis: ${String(exhaustiveAxis)}`);
        }
        }

        for (const parent of parents) {
          const candidates = (isDocumentNode(parent)
            ? (parent.documentElement === null ? [] : [parent.documentElement])
            : Array.from(parent.children)).filter((candidate) => nodeMatchesNamespaceWildcard({
            node: candidate,
            prefix: step.prefix,
            namespaces,
          }));
          for (const selected of applyXPathPredicates({
            nodes: candidates,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
        }
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'node': {
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        const parents = getSimpleXPathStepParents({
          node: currentNode,
          axis: step.axis,
        });
        for (const parent of parents) {
          const candidates = Array.from(parent.childNodes);
          for (const selected of applyXPathPredicates({
            nodes: candidates,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
        }
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'comment':
    case 'processing-instruction': {
      const nodeType = (() => {
        switch (step.kind) {
        case 'comment':
          return Node.COMMENT_NODE;
        case 'processing-instruction':
          return Node.PROCESSING_INSTRUCTION_NODE;
        default: {
          const _exhaustive: never = step;
          throw new Error(`Unhandled XML typed-node kind: ${String(
            ((_exhaustive satisfies never) as { readonly kind: string }).kind,
          )}`);
        }
        }
      })();
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        const parents = getSimpleXPathStepParents({
          node: currentNode,
          axis: step.axis,
        });
        for (const parent of parents) {
          const candidates = Array.from(parent.childNodes).filter((node) => {
            if (node.nodeType !== nodeType) return false;
            return step.kind !== 'processing-instruction'
              || step.target === undefined
              || (node as ProcessingInstruction).target === step.target;
          });
          for (const selected of applyXPathPredicates({
            nodes: candidates,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
        }
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'text': {
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        const parents = getSimpleXPathStepParents({
          node: currentNode,
          axis: step.axis,
        });
        for (const parent of parents) {
          const candidates = Array.from(parent.childNodes).filter((node) => (
            node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE
          ));
          for (const selected of applyXPathPredicates({
            nodes: candidates,
            predicates: step.predicates,
            namespaces,
          })) {
            if (seen.has(selected)) continue;
            seen.add(selected);
            nextNodes.push(selected);
          }
        }
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'explicit-axis': {
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        const matching = getXPathExplicitAxisCandidates({
          node: currentNode,
          axis: step.axis,
          documentOrderCache,
        }).filter((candidate) => xpathAxisNodeMatchesTest({
          node: candidate,
          axis: step.axis,
          nodeTest: step.nodeTest,
          namespaces,
        }));
        for (const selected of applyXPathPredicates({
          nodes: matching,
          predicates: step.predicates,
          namespaces,
        })) {
          if (seen.has(selected)) continue;
          seen.add(selected);
          nextNodes.push(selected);
        }
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    case 'self':
      break;
    case 'parent': {
      const nextNodes: Node[] = [];
      const seen = new Set<Node>();
      for (const currentNode of currentNodes) {
        const parent = getXPathParentNode({ node: currentNode });
        if (parent === null || seen.has(parent)) continue;
        seen.add(parent);
        nextNodes.push(parent);
      }
      sortNodesInDocumentOrder({ nodes: nextNodes });
      currentNodes = nextNodes;
      break;
    }
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unhandled simple XPath step: ${String(_exhaustive)}`);
    }
    }
  }

  return currentNodes;
}

function getXPathNodeStringValue({ node }: { node: Node }): string {
  switch (node.nodeType) {
  case Node.DOCUMENT_NODE:
    return (node as Document).documentElement?.textContent ?? '';
  case Node.ATTRIBUTE_NODE:
  case Node.TEXT_NODE:
  case Node.CDATA_SECTION_NODE:
  case Node.COMMENT_NODE:
  case Node.PROCESSING_INSTRUCTION_NODE:
    return node.nodeValue ?? '';
  default:
    return node.textContent ?? '';
  }
}

function getXPathNodeLocalName({ node }: { node: Node }): string {
  if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
    return (node as ProcessingInstruction).target;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.ATTRIBUTE_NODE) return '';
  return (node as Element | Attr).localName;
}

function getXPathNodeNamespaceUri({ node }: { node: Node }): string {
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.ATTRIBUTE_NODE) return '';
  return (node as Element | Attr).namespaceURI ?? '';
}

function unwrapXPathFunction({
  expression,
  name,
}: {
  expression: string;
  name: string;
}): string | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (!trimmed.startsWith(name)) return undefined;

  let openingIndex = name.length;
  while (/[\t\n\r ]/u.test(trimmed[openingIndex] ?? '')) openingIndex += 1;
  if (trimmed[openingIndex] !== '(') return undefined;

  let depth = 1;
  let quote: '"' | "'" | undefined;
  for (let index = openingIndex + 1; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index === trimmed.length - 1
          ? trimmed.slice(openingIndex + 1, index)
          : undefined;
      }
    }
  }
  return undefined;
}

function rewriteXPathContextFunctions({
  expression,
  contextPosition,
  contextSize,
}: {
  expression: string,
  contextPosition: number,
  contextSize: number,
}): string {
  let result = '';
  let quote: '"' | "'" | undefined;
  let predicateDepth = 0;
  for (let index = 0; index < expression.length;) {
    const character = expression[index];
    if (quote !== undefined) {
      result += character;
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      index += 1;
      continue;
    }
    if (character === '[') {
      predicateDepth += 1;
      result += character;
      index += 1;
      continue;
    }
    if (character === ']') {
      predicateDepth = Math.max(0, predicateDepth - 1);
      result += character;
      index += 1;
      continue;
    }

    const positionToken = 'position()';
    const lastToken = 'last()';
    if (predicateDepth === 0 && expression.startsWith(positionToken, index)) {
      result += String(contextPosition);
      index += positionToken.length;
      continue;
    }
    if (predicateDepth === 0 && expression.startsWith(lastToken, index)) {
      result += String(contextSize);
      index += lastToken.length;
      continue;
    }

    result += character;
    index += 1;
  }
  return result;
}

function unwrapXPathParentheses({ expression }: { expression: string }): string | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (!trimmed.startsWith('(')) return undefined;

  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character !== ')') continue;
    depth -= 1;
    if (depth < 0) return undefined;
    if (depth === 0) {
      return index === trimmed.length - 1
        ? trimmed.slice(1, index)
        : undefined;
    }
  }
  return undefined;
}

function trimXPathWhitespaceRange({
  expression,
  start,
  end,
}: {
  expression: string;
  start: number;
  end: number;
}): { readonly start: number, readonly end: number } {
  while (start < end && /[ \t\n\r]/u.test(expression[start]!)) start += 1;
  while (end > start && /[ \t\n\r]/u.test(expression[end - 1]!)) end -= 1;
  return { start, end };
}

function unwrapAllXPathParentheses({ expression }: { expression: string }): string {
  let { start, end } = trimXPathWhitespaceRange({
    expression,
    start: 0,
    end: expression.length,
  });
  if (start >= end || expression[start] !== '(') return expression.slice(start, end);

  const matchingClosingIndexes = new Map<number, number>();
  const openingIndexes: number[] = [];
  let quote: '"' | "'" | undefined;
  for (let index = start; index < end; index += 1) {
    const character = expression[index]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      openingIndexes.push(index);
      continue;
    }
    if (character !== ')') continue;
    const openingIndex = openingIndexes.pop();
    if (openingIndex === undefined) return expression.slice(start, end);
    matchingClosingIndexes.set(openingIndex, index);
  }

  while (start < end && matchingClosingIndexes.get(start) === end - 1) {
    ({ start, end } = trimXPathWhitespaceRange({
      expression,
      start: start + 1,
      end: end - 1,
    }));
  }
  return expression.slice(start, end);
}


type XPathLogicalOperator = 'and' | 'or';

function xpathTokenBeforeCanEndOperand({
  expression,
  index,
}: {
  expression: string;
  index: number;
}): boolean {
  const prefix = trimXPathWhitespace({ value: expression.slice(0, index) });
  if (isXPathNumberLiteral({ value: prefix })) return true;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = expression[cursor] ?? '';
    if (/[\t\n\r ]/u.test(value)) continue;
    return !'([,|+-*/=<>!@:'.includes(value);
  }
  return false;
}

function xpathOperatorNameIsEmbedded({
  expression,
  index,
  operatorLength,
}: {
  expression: string;
  index: number;
  operatorLength: number;
}): boolean {
  let tokenStart = index;
  while (tokenStart > 0 && /[A-Za-z0-9_.:-]/u.test(expression[tokenStart - 1] ?? '')) {
    tokenStart -= 1;
  }
  const precedingToken = expression.slice(tokenStart, index);
  const next = expression[index + operatorLength] ?? '';
  return /^[A-Za-z_]/u.test(precedingToken) || /[A-Za-z_:]/u.test(next);
}

function xpathSignFollowsWordArithmeticOperator({
  expression,
  index,
}: {
  expression: string;
  index: number;
}): boolean {
  let operatorEnd = index;
  while (operatorEnd > 0 && /[\t\n\r ]/u.test(expression[operatorEnd - 1] ?? '')) {
    operatorEnd -= 1;
  }
  for (const operator of ['div', 'mod'] as const) {
    const operatorIndex = operatorEnd - operator.length;
    if (operatorIndex < 0 || expression.slice(operatorIndex, operatorEnd) !== operator) continue;
    if (!xpathTokenBeforeCanEndOperand({ expression, index: operatorIndex })) continue;
    if (xpathOperatorNameIsEmbedded({
      expression,
      index: operatorIndex,
      operatorLength: operator.length,
    })) continue;
    return true;
  }
  return false;
}

function xpathSignIsPartOfExponent({
  expression,
  index,
}: {
  expression: string;
  index: number;
}): boolean {
  if (expression[index - 1] !== 'e' && expression[index - 1] !== 'E') return false;
  let tokenStart = index - 2;
  while (tokenStart >= 0 && /[0-9.]/u.test(expression[tokenStart] ?? '')) {
    tokenStart -= 1;
  }
  if (expression[tokenStart] === '-') tokenStart -= 1;
  const mantissa = expression.slice(tokenStart + 1, index - 1);
  return /-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(mantissa);
}

function splitTopLevelXPathLogicalOperator({
  expression,
  operator,
}: {
  expression: string;
  operator: XPathLogicalOperator;
}): readonly string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let predicateDepth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) return undefined;
      continue;
    }
    if (character === '[') {
      predicateDepth += 1;
      continue;
    }
    if (character === ']') {
      predicateDepth -= 1;
      if (predicateDepth < 0) return undefined;
      continue;
    }
    if (parenthesisDepth !== 0 || predicateDepth !== 0) continue;
    if (!expression.startsWith(operator, index)) continue;
    if (!xpathTokenBeforeCanEndOperand({ expression, index })) continue;

    if (xpathOperatorNameIsEmbedded({
      expression,
      index,
      operatorLength: operator.length,
    })) continue;

    const part = trimXPathWhitespace({ value: expression.slice(start, index) });
    if (part.length === 0) return undefined;
    parts.push(part);
    index += operator.length - 1;
    start = index + 1;
  }

  if (quote !== undefined || parenthesisDepth !== 0 || predicateDepth !== 0) return undefined;
  if (parts.length === 0) return undefined;
  const finalPart = trimXPathWhitespace({ value: expression.slice(start) });
  if (finalPart.length === 0) return undefined;
  parts.push(finalPart);
  return parts;
}

function splitTopLevelXPathUnion({ expression }: { expression: string }): readonly string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let predicateDepth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) return undefined;
      continue;
    }
    if (character === '[') {
      predicateDepth += 1;
      continue;
    }
    if (character === ']') {
      predicateDepth -= 1;
      if (predicateDepth < 0) return undefined;
      continue;
    }
    if (character !== '|' || parenthesisDepth !== 0 || predicateDepth !== 0) continue;
    const part = trimXPathWhitespace({ value: expression.slice(start, index) });
    if (part.length === 0) return undefined;
    parts.push(part);
    start = index + 1;
  }
  if (quote !== undefined || parenthesisDepth !== 0 || predicateDepth !== 0 || parts.length === 0) {
    return undefined;
  }
  const finalPart = trimXPathWhitespace({ value: expression.slice(start) });
  if (finalPart.length === 0) return undefined;
  parts.push(finalPart);
  return parts;
}

function splitXPathArguments({ value }: { value: string }): string[] | undefined {
  const argumentsList: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      argumentsList.push(trimXPathWhitespace({ value: value.slice(start, index) }));
      start = index + 1;
    }
    if (depth < 0) return undefined;
  }
  if (quote !== undefined || depth !== 0) return undefined;
  argumentsList.push(trimXPathWhitespace({ value: value.slice(start) }));
  return argumentsList;
}

function evaluateSimpleXPathString({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode?: Node;
}): string | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (trimmed === '.') return getXPathNodeStringValue({ node: contextNode ?? document });
  const stringLiteral = unwrapXPathStringLiteral({ expression: trimmed });
  if (stringLiteral !== undefined) return stringLiteral;
  if (isXPathNumberLiteral({ value: trimmed })) {
    return formatXPathNumberValue({ value: xpathStringToNumber({ value: trimmed }) });
  }
  if (trimmed === 'true()') return 'true';
  if (trimmed === 'false()') return 'false';

  const evaluateString = ({ value }: { value: string }): string | undefined => evaluateSimpleXPathString({
    document,
    expression: value,
    namespaces,
    contextNode,
  });
  const evaluateNodes = ({ value }: { value: string }): Node[] | undefined => {
    const simpleNodes = evaluateSimpleXPathNodes({
      document,
      expression: value,
      namespaces,
      contextNode,
    });
    if (simpleNodes !== undefined) return simpleNodes;
    const groupedNodes = evaluateGroupedXPathNodes({
      document,
      expression: value,
      namespaces,
      contextNode,
    });
    if (groupedNodes !== undefined) return groupedNodes;
    return splitTopLevelXPathUnion({ expression: value }) === undefined
      ? undefined
      : evaluateXPathNodes({ document, expression: value, namespaces, contextNode });
  };

  for (const name of ['number', 'sum'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name });
    if (inner === undefined) continue;
    const value = evaluateSimpleXPathNumericFunction({
      document,
      expression: inner,
      functionName: name,
      namespaces,
      contextNode,
    });
    return value === undefined ? undefined : formatXPathNumberValue({ value });
  }

  for (const name of ['string', 'normalize-space', 'string-length'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name });
    if (inner === undefined) continue;
    const value = evaluateString({ value: inner });
    if (value === undefined) return undefined;
    switch (name) {
    case 'string':
      return value;
    case 'normalize-space':
      return trimXPathWhitespace({ value }).replace(/[\t\n\r ]+/gu, ' ');
    case 'string-length':
      return String(Array.from(value).length);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled simple XPath string function: ${String(_exhaustive)}`);
    }
    }
  }

  for (const name of ['count', 'boolean'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name });
    if (inner === undefined) continue;
    const nodes = evaluateNodes({ value: inner });
    if (nodes === undefined) return undefined;
    switch (name) {
    case 'count':
      return String(nodes.length);
    case 'boolean':
      return nodes.length > 0 ? 'true' : 'false';
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled simple XPath node-set function: ${String(_exhaustive)}`);
    }
    }
  }

  for (const name of ['name', 'local-name', 'namespace-uri'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name });
    if (inner === undefined) continue;
    const node = inner.length === 0
      ? (contextNode ?? document)
      : evaluateNodes({ value: inner })?.[0];
    if (node === undefined) return '';
    switch (name) {
    case 'name':
      if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
        return getXPathNodeLocalName({ node });
      }
      return node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.ATTRIBUTE_NODE
        ? node.nodeName
        : '';
    case 'local-name':
      return getXPathNodeLocalName({ node });
    case 'namespace-uri':
      return getXPathNodeNamespaceUri({ node });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled simple XPath name function: ${String(_exhaustive)}`);
    }
    }
  }

  const concatInner = unwrapXPathFunction({ expression: trimmed, name: 'concat' });
  if (concatInner !== undefined) {
    const argumentsList = splitXPathArguments({ value: concatInner });
    if (argumentsList === undefined || argumentsList.length < 2) return undefined;
    const values = argumentsList.map((argument) => evaluateString({ value: argument }));
    return values.some((value) => value === undefined) ? undefined : values.join('');
  }

  for (const name of ['starts-with', 'contains', 'substring-before', 'substring-after'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name });
    if (inner === undefined) continue;
    const argumentsList = splitXPathArguments({ value: inner });
    if (argumentsList === undefined || argumentsList.length !== 2) return undefined;
    const left = evaluateString({ value: argumentsList[0] ?? '' });
    const right = evaluateString({ value: argumentsList[1] ?? '' });
    if (left === undefined || right === undefined) return undefined;
    switch (name) {
    case 'starts-with':
      return left.startsWith(right) ? 'true' : 'false';
    case 'contains':
      return left.includes(right) ? 'true' : 'false';
    case 'substring-before': {
      const index = left.indexOf(right);
      return index < 0 ? '' : left.slice(0, index);
    }
    case 'substring-after': {
      const index = left.indexOf(right);
      return index < 0 ? '' : left.slice(index + right.length);
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled simple XPath binary function: ${String(_exhaustive)}`);
    }
    }
  }

  const substringInner = unwrapXPathFunction({ expression: trimmed, name: 'substring' });
  if (substringInner !== undefined) {
    const argumentsList = splitXPathArguments({ value: substringInner });
    if (argumentsList === undefined || (argumentsList.length !== 2 && argumentsList.length !== 3)) {
      return undefined;
    }
    const source = evaluateString({ value: argumentsList[0] ?? '' });
    const startValue = evaluateSimpleXPathScalarValue({
      document,
      expression: argumentsList[1] ?? '',
      namespaces,
      contextNode,
    });
    const lengthValue = argumentsList.length === 3
      ? evaluateSimpleXPathScalarValue({
        document,
        expression: argumentsList[2] ?? '',
        namespaces,
        contextNode,
      })
      : undefined;
    if (source === undefined || startValue === undefined || (argumentsList.length === 3 && lengthValue === undefined)) {
      return undefined;
    }
    const roundedStart = Math.round(xpathScalarToNumber({ value: startValue }));
    const roundedEnd = lengthValue === undefined
      ? Number.POSITIVE_INFINITY
      : roundedStart + Math.round(xpathScalarToNumber({ value: lengthValue }));
    if (Number.isNaN(roundedStart) || Number.isNaN(roundedEnd)) return '';
    return Array.from(source).filter((_, index) => {
      const xpathPosition = index + 1;
      return xpathPosition >= roundedStart && xpathPosition < roundedEnd;
    }).join('');
  }

  const translateInner = unwrapXPathFunction({ expression: trimmed, name: 'translate' });
  if (translateInner !== undefined) {
    const argumentsList = splitXPathArguments({ value: translateInner });
    if (argumentsList === undefined || argumentsList.length !== 3) return undefined;
    const source = evaluateString({ value: argumentsList[0] ?? '' });
    const from = evaluateString({ value: argumentsList[1] ?? '' });
    const to = evaluateString({ value: argumentsList[2] ?? '' });
    if (source === undefined || from === undefined || to === undefined) return undefined;
    const fromCharacters = Array.from(from);
    const toCharacters = Array.from(to);
    return Array.from(source).map((character) => {
      const index = fromCharacters.indexOf(character);
      return index < 0 ? character : (toCharacters[index] ?? '');
    }).join('');
  }

  const nodes = evaluateNodes({ value: trimmed });
  if (nodes === undefined) return undefined;
  return nodes[0] === undefined ? '' : getXPathNodeStringValue({ node: nodes[0] });
}

type XPathComparisonOperator = '=' | '!=' | '<' | '<=' | '>' | '>=';

type XPathComparison = {
  readonly left: string;
  readonly operator: XPathComparisonOperator;
  readonly right: string;
};

function parseTopLevelXPathComparison({ expression }: { expression: string }): XPathComparison | undefined {
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']') {
      depth -= 1;
      if (depth < 0) return undefined;
      continue;
    }
    if (depth !== 0) continue;

    const twoCharacters = expression.slice(index, index + 2);
    const operator: XPathComparisonOperator | undefined = (
      twoCharacters === '!=' || twoCharacters === '<=' || twoCharacters === '>='
    ) ? twoCharacters : (
        character === '=' || character === '<' || character === '>' ? character : undefined
      );
    if (operator === undefined) continue;
    const operatorLength = operator.length;
    const left = trimXPathWhitespace({ value: expression.slice(0, index) });
    const right = trimXPathWhitespace({ value: expression.slice(index + operatorLength) });
    return left.length === 0 || right.length === 0 ? undefined : { left, operator, right };
  }
  return undefined;
}

function evaluateXPathLanguage({
  contextNode,
  language,
}: {
  contextNode: Node | undefined;
  language: string;
}): boolean {
  if (contextNode === undefined) return false;

  let currentElement: Element | null = (() => {
    if (contextNode.nodeType === Node.ELEMENT_NODE) return contextNode as Element;
    if (contextNode.nodeType === Node.ATTRIBUTE_NODE) return (contextNode as Attr).ownerElement;
    return contextNode.parentElement;
  })();
  const normalizedLanguage = language.toLowerCase();

  while (currentElement !== null) {
    const declaredLanguage = currentElement.getAttributeNS(XML_NAMESPACE_URI, 'lang');
    if (declaredLanguage !== null) {
      const normalizedDeclaredLanguage = declaredLanguage.toLowerCase();
      return normalizedDeclaredLanguage === normalizedLanguage
        || normalizedDeclaredLanguage.startsWith(`${normalizedLanguage}-`);
    }
    currentElement = currentElement.parentElement;
  }

  return false;
}

function evaluateSimpleXPathBooleanValue({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode?: Node;
}): boolean | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (trimmed === 'true()') return true;
  if (trimmed === 'false()') return false;
  if (trimmed === 'self::text()') {
    return contextNode?.nodeType === Node.TEXT_NODE
      || contextNode?.nodeType === Node.CDATA_SECTION_NODE;
  }

  const booleanInner = unwrapXPathFunction({ expression: trimmed, name: 'boolean' });
  if (booleanInner !== undefined) {
    const nodes = evaluateSimpleXPathNodes({
      document,
      expression: booleanInner,
      namespaces,
      contextNode,
    });
    if (nodes !== undefined) return nodes.length > 0;
    const scalar = evaluateSimpleXPathScalarValue({
      document,
      expression: booleanInner,
      namespaces,
      contextNode,
    });
    return scalar === undefined ? undefined : xpathScalarToBoolean({ value: scalar });
  }

  const langInner = unwrapXPathFunction({ expression: trimmed, name: 'lang' });
  if (langInner !== undefined) {
    const argumentsList = splitXPathArguments({ value: langInner });
    if (argumentsList === undefined || argumentsList.length !== 1) return undefined;
    const language = evaluateSimpleXPathString({
      document,
      expression: argumentsList[0] ?? '',
      namespaces,
      contextNode,
    });
    return language === undefined
      ? undefined
      : evaluateXPathLanguage({ contextNode, language });
  }

  for (const name of ['starts-with', 'contains'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name });
    if (inner === undefined) continue;
    const argumentsList = splitXPathArguments({ value: inner });
    if (argumentsList === undefined || argumentsList.length !== 2) return undefined;
    const left = evaluateSimpleXPathString({
      document,
      expression: argumentsList[0] ?? '',
      namespaces,
      contextNode,
    });
    const right = evaluateSimpleXPathString({
      document,
      expression: argumentsList[1] ?? '',
      namespaces,
      contextNode,
    });
    if (left === undefined || right === undefined) return undefined;
    switch (name) {
    case 'starts-with':
      return left.startsWith(right);
    case 'contains':
      return left.includes(right);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled simple XPath boolean function: ${String(_exhaustive)}`);
    }
    }
  }

  return undefined;
}

function isXPathNumberLiteral({ value }: { value: string }): boolean {
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d*)?$/u.test(value);
}

function isSimpleXPathNumberExpression({ expression }: { expression: string }): boolean {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (isXPathNumberLiteral({ value: trimmed })) return true;
  return unwrapXPathFunction({ expression: trimmed, name: 'count' }) !== undefined
    || unwrapXPathFunction({ expression: trimmed, name: 'number' }) !== undefined
    || unwrapXPathFunction({ expression: trimmed, name: 'string-length' }) !== undefined
    || unwrapXPathFunction({ expression: trimmed, name: 'sum' }) !== undefined;
}

type SimpleXPathScalarValue =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string };

function xpathStringToNumber({ value }: { value: string }): number {
  const trimmed = trimXPathWhitespace({ value });
  if (trimmed === '-') return -0;
  if (!isXPathNumberLiteral({ value: trimmed })) return Number.NaN;

  let index = 0;
  let isNegative = false;
  if (trimmed[index] === '-') {
    isNegative = true;
    index += 1;
  }

  let number = 0;
  while (/\d/u.test(trimmed[index] ?? '')) {
    number = number * 10 + Number.parseInt(trimmed[index] ?? '0', 10);
    index += 1;
  }

  if (trimmed[index] === '.') {
    index += 1;
    let fractionalDigits = 0;
    while (trimmed[index] === '0') {
      fractionalDigits += 1;
      index += 1;
    }

    const maximumFractionalDigits = fractionalDigits + 20;
    let fraction = 0;
    while (
      /\d/u.test(trimmed[index] ?? '')
      && fractionalDigits < maximumFractionalDigits
    ) {
      fraction = fraction * 10 + Number.parseInt(trimmed[index] ?? '0', 10);
      fractionalDigits += 1;
      index += 1;
    }
    fraction /= Number(`1e${fractionalDigits}`);
    number += fraction;

    while (/\d/u.test(trimmed[index] ?? '')) index += 1;
  }

  let exponent = 0;
  let isExponentNegative = false;
  if (trimmed[index] === 'e' || trimmed[index] === 'E') {
    index += 1;
    if (trimmed[index] === '-' || trimmed[index] === '+') {
      isExponentNegative = trimmed[index] === '-';
      index += 1;
    }
    while (/\d/u.test(trimmed[index] ?? '')) {
      if (exponent < 1_000_000) {
        exponent = exponent * 10 + Number.parseInt(trimmed[index] ?? '0', 10);
      }
      index += 1;
    }
  }

  if (isNegative) number = -number;
  if (isExponentNegative) exponent = -exponent;
  return number * Number(`1e${exponent}`);
}

const XPATH_DOUBLE_SIGNIFICANT_DIGITS = 15;
const XPATH_REGULAR_NOTATION_UPPER_BOUND = 1e9;
const XPATH_REGULAR_NOTATION_LOWER_BOUND = 1e-5;
const XPATH_INT32_MIN = -2_147_483_648;
const XPATH_INT32_MAX = 2_147_483_647;

function trimXPathFormattedFraction({ value }: { value: string }): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/u, '').replace(/\.$/u, '');
}

function formatXPathScientificNumber({ value }: { value: number }): string {
  const [rawMantissa = '', rawExponent = '0'] = value
    .toExponential(XPATH_DOUBLE_SIGNIFICANT_DIGITS - 1)
    .split('e');
  const mantissa = trimXPathFormattedFraction({ value: rawMantissa });
  const numericExponent = Number.parseInt(rawExponent, 10);
  const exponentSign = numericExponent < 0 ? '-' : '+';
  const exponentDigits = String(Math.abs(numericExponent)).padStart(2, '0');
  return `${mantissa}e${exponentSign}${exponentDigits}`;
}

function formatXPathNumberValue({ value }: { value: number }): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (value === 0) return '0';

  if (
    value > XPATH_INT32_MIN
    && value < XPATH_INT32_MAX
    && value === Math.trunc(value)
  ) {
    return String(value);
  }

  const absoluteValue = Math.abs(value);
  if (
    absoluteValue > XPATH_REGULAR_NOTATION_UPPER_BOUND
    || absoluteValue < XPATH_REGULAR_NOTATION_LOWER_BOUND
  ) {
    return formatXPathScientificNumber({ value });
  }

  const integerPlace = Math.trunc(Math.log10(absoluteValue));
  const fractionPlace = integerPlace > 0
    ? XPATH_DOUBLE_SIGNIFICANT_DIGITS - integerPlace - 1
    : XPATH_DOUBLE_SIGNIFICANT_DIGITS - integerPlace;
  return trimXPathFormattedFraction({ value: value.toFixed(fractionPlace) });
}

function expandXPathFiniteNumberLiteral({ value }: { value: number }): string {
  const stringValue = String(value);
  const match = stringValue.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u);
  if (match === null) return stringValue;

  const sign = match[1] ?? '';
  const integerDigits = match[2] ?? '';
  const fractionalDigits = match[3] ?? '';
  const exponent = Number.parseInt(match[4] ?? '0', 10);
  const digits = `${integerDigits}${fractionalDigits}`;
  const decimalPosition = integerDigits.length + exponent;
  if (decimalPosition <= 0) {
    return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function formatXPathNumberLiteral({ value }: { value: number }): string {
  if (Number.isNaN(value)) return '(0 div 0)';
  if (value === Number.POSITIVE_INFINITY) return '(1 div 0)';
  if (value === Number.NEGATIVE_INFINITY) return '(-1 div 0)';
  return Object.is(value, -0) ? '0' : expandXPathFiniteNumberLiteral({ value });
}

function evaluateSimpleXPathNumericFunction({
  document,
  expression,
  functionName,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  functionName: 'number' | 'sum';
  namespaces: Map<string, string>;
  contextNode: Node | undefined;
}): number | undefined {
  switch (functionName) {
  case 'number': {
    const unionParts = splitTopLevelXPathUnion({ expression });
    const nodes = unionParts === undefined
      ? evaluateSimpleXPathNodes({ document, expression, namespaces, contextNode })
      : evaluateXPathNodes({ document, expression, namespaces, contextNode });
    if (nodes !== undefined) {
      const firstNode = nodes[0];
      return firstNode === undefined
        ? Number.NaN
        : xpathStringToNumber({ value: getXPathNodeStringValue({ node: firstNode }) });
    }
    const value = evaluateSimpleXPathString({
      document,
      expression,
      namespaces,
      contextNode,
    });
    return value === undefined ? undefined : xpathStringToNumber({ value });
  }
  case 'sum': {
    const nodes = evaluateXPathNodes({
      document,
      expression,
      namespaces,
      contextNode,
    });
    let total = 0;
    for (const node of nodes) {
      total += xpathStringToNumber({ value: getXPathNodeStringValue({ node }) });
    }
    return total;
  }
  default: {
    const _exhaustive: never = functionName;
    throw new Error(`Unhandled XPath numeric function: ${String(_exhaustive)}`);
  }
  }
}

function rewriteSimpleXPathNumericFunctions({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode: Node | undefined;
}): string {
  let result = '';
  let index = 0;
  let quote: '"' | "'" | undefined;

  while (index < expression.length) {
    const character = expression[index] ?? '';
    if (quote !== undefined) {
      result += character;
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      index += 1;
      continue;
    }

    const previous = index === 0 ? '' : (expression[index - 1] ?? '');
    const functionName = (['number', 'sum'] as const).find((candidate) => {
      if (!expression.startsWith(candidate, index)) return false;
      const next = expression[index + candidate.length] ?? '';
      return !/[A-Za-z0-9_.:-]/u.test(next) || /[\t\n\r (]/u.test(next);
    });
    let openingIndex = index + (functionName?.length ?? 0);
    while (/[\t\n\r ]/u.test(expression[openingIndex] ?? '')) openingIndex += 1;
    if (
      functionName !== undefined
      && expression[openingIndex] === '('
      && !/[A-Za-z0-9_.:-]/u.test(previous)
    ) {
      let depth = 1;
      let innerQuote: '"' | "'" | undefined;
      let closingIndex = openingIndex + 1;
      for (; closingIndex < expression.length; closingIndex += 1) {
        const innerCharacter = expression[closingIndex] ?? '';
        if (innerQuote !== undefined) {
          if (innerCharacter === innerQuote) innerQuote = undefined;
          continue;
        }
        if (innerCharacter === '"' || innerCharacter === "'") {
          innerQuote = innerCharacter;
          continue;
        }
        if (innerCharacter === '(') depth += 1;
        else if (innerCharacter === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }

      if (depth === 0) {
        const inner = expression.slice(openingIndex + 1, closingIndex);
        const numericValue = evaluateSimpleXPathNumericFunction({
          document,
          expression: inner,
          functionName,
          namespaces,
          contextNode,
        });
        if (numericValue !== undefined) {
          result += formatXPathNumberLiteral({ value: numericValue });
          index = closingIndex + 1;
          continue;
        }
      }
    }

    result += character;
    index += 1;
  }

  return result;
}

type XPathArithmeticOperator = '+' | '-' | '*' | 'div' | 'mod';

type XPathArithmeticOperation = {
  readonly index: number;
  readonly operator: XPathArithmeticOperator;
};

type XPathArithmeticChain = {
  readonly operands: readonly string[];
  readonly operators: readonly XPathArithmeticOperator[];
};

function parseTopLevelXPathArithmeticChain({
  expression,
}: {
  expression: string;
}): XPathArithmeticChain | undefined {
  let parenthesisDepth = 0;
  let predicateDepth = 0;
  let quote: '"' | "'" | undefined;
  let previousNonWhitespace = '';
  let operandHasContent = false;
  const operations: XPathArithmeticOperation[] = [];
  const arithmeticOperators = ['div', 'mod', '+', '-', '*'] as const;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        previousNonWhitespace = character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      operandHasContent = true;
      continue;
    }
    if (character === '(') {
      operandHasContent = true;
      parenthesisDepth += 1;
      previousNonWhitespace = character;
      continue;
    }
    if (character === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) return undefined;
      previousNonWhitespace = character;
      continue;
    }
    if (character === '[') {
      operandHasContent = true;
      predicateDepth += 1;
      previousNonWhitespace = character;
      continue;
    }
    if (character === ']') {
      predicateDepth -= 1;
      if (predicateDepth < 0) return undefined;
      previousNonWhitespace = character;
      continue;
    }
    if (parenthesisDepth !== 0 || predicateDepth !== 0) {
      if (!/[\t\n\r ]/u.test(character)) previousNonWhitespace = character;
      continue;
    }

    let matchedOperator: XPathArithmeticOperator | undefined;
    for (const operator of arithmeticOperators) {
      if (!expression.startsWith(operator, index) || !operandHasContent) continue;
      if (operator === 'div' || operator === 'mod') {
        if ('([,|+-*/=<>!@:'.includes(previousNonWhitespace)) continue;
        if (xpathOperatorNameIsEmbedded({
          expression,
          index,
          operatorLength: operator.length,
        })) continue;
      } else if (operator === '+' || operator === '-') {
        if (
          '([,+-*/=<>!'.includes(previousNonWhitespace)
          && !isXPathNumberLiteral({
            value: trimXPathWhitespace({ value: expression.slice(0, index) }),
          })
        ) continue;
        if (xpathSignFollowsWordArithmeticOperator({ expression, index })) continue;
        if (operator === '-' && xpathOperatorNameIsEmbedded({
          expression,
          index,
          operatorLength: operator.length,
        })) continue;
        if (xpathSignIsPartOfExponent({ expression, index })) continue;
      } else if (operator === '*') {
        if (previousNonWhitespace === '/' || previousNonWhitespace === ':') continue;
      } else {
        const _exhaustive: never = operator;
        throw new Error(`Unhandled XPath arithmetic operator: ${String(_exhaustive)}`);
      }
      matchedOperator = operator;
      break;
    }

    if (matchedOperator !== undefined) {
      operations.push({ index, operator: matchedOperator });
      index += matchedOperator.length - 1;
      previousNonWhitespace = matchedOperator.at(-1) ?? '';
      operandHasContent = false;
      continue;
    }
    if (!/[\t\n\r ]/u.test(character)) {
      previousNonWhitespace = character;
      operandHasContent = true;
    }
  }

  if (
    quote !== undefined
    || parenthesisDepth !== 0
    || predicateDepth !== 0
    || operations.length === 0
  ) return undefined;

  const operands: string[] = [];
  const operators: XPathArithmeticOperator[] = [];
  let operandStart = 0;
  for (const operation of operations) {
    const operand = trimXPathWhitespace({
      value: expression.slice(operandStart, operation.index),
    });
    if (operand.length === 0) return undefined;
    operands.push(operand);
    operators.push(operation.operator);
    operandStart = operation.index + operation.operator.length;
  }
  const finalOperand = trimXPathWhitespace({ value: expression.slice(operandStart) });
  if (finalOperand.length === 0) return undefined;
  operands.push(finalOperand);
  return { operands, operators };
}

function xpathArithmeticPrecedence({
  operator,
}: {
  operator: XPathArithmeticOperator;
}): number {
  switch (operator) {
  case '+':
  case '-':
    return 1;
  case '*':
  case 'div':
  case 'mod':
    return 2;
  default: {
    const _exhaustive: never = operator;
    throw new Error(`Unhandled XPath arithmetic operator: ${String(_exhaustive)}`);
  }
  }
}

function applyXPathArithmeticOperator({
  left,
  operator,
  right,
}: {
  left: number;
  operator: XPathArithmeticOperator;
  right: number;
}): number {
  switch (operator) {
  case '+':
    return left + right;
  case '-':
    return left - right;
  case '*':
    return left * right;
  case 'div':
    return left / right;
  case 'mod':
    return left % right;
  default: {
    const _exhaustive: never = operator;
    throw new Error(`Unhandled XPath arithmetic operator: ${String(_exhaustive)}`);
  }
  }
}

function evaluateSimpleXPathArithmeticValue({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode: Node | undefined;
}): number | undefined {
  const parsed = parseTopLevelXPathArithmeticChain({
    expression: trimXPathWhitespace({ value: expression }),
  });
  if (parsed === undefined) return undefined;

  const values: number[] = [];
  const operators: XPathArithmeticOperator[] = [];
  const reduceTopOperator = (): boolean => {
    const operator = operators.pop();
    const right = values.pop();
    const left = values.pop();
    if (operator === undefined || right === undefined || left === undefined) return false;
    values.push(applyXPathArithmeticOperator({ left, operator, right }));
    return true;
  };

  for (let index = 0; index < parsed.operands.length; index += 1) {
    const operand = parsed.operands[index];
    if (operand === undefined) return undefined;
    const value = evaluateSimpleXPathScalarValue({
      document,
      expression: operand,
      namespaces,
      contextNode,
    });
    if (value === undefined) return undefined;
    values.push(xpathScalarToNumber({ value }));

    const operator = parsed.operators[index];
    if (operator === undefined) continue;
    while (
      operators.length > 0
      && xpathArithmeticPrecedence({ operator: operators.at(-1)! })
        >= xpathArithmeticPrecedence({ operator })
    ) {
      if (!reduceTopOperator()) return undefined;
    }
    operators.push(operator);
  }

  while (operators.length > 0) {
    if (!reduceTopOperator()) return undefined;
  }
  return values.length === 1 ? values[0] : undefined;
}

function evaluateSimpleXPathScalarValue({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode: Node | undefined;
}): SimpleXPathScalarValue | undefined {
  const trimmed = unwrapAllXPathParentheses({ expression });
  if (trimmed === 'true()') return { kind: 'boolean', value: true };
  if (trimmed === 'false()') return { kind: 'boolean', value: false };
  if (isXPathNumberLiteral({ value: trimmed })) {
    return { kind: 'number', value: xpathStringToNumber({ value: trimmed }) };
  }
  const arithmeticValue = evaluateSimpleXPathArithmeticValue({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (arithmeticValue !== undefined) return { kind: 'number', value: arithmeticValue };
  if (trimmed.startsWith('-')) {
    const operand = evaluateSimpleXPathScalarValue({
      document,
      expression: trimmed.slice(1),
      namespaces,
      contextNode,
    });
    if (operand !== undefined) {
      return { kind: 'number', value: -xpathScalarToNumber({ value: operand }) };
    }
  }

  for (const functionName of ['number', 'sum'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name: functionName });
    if (inner === undefined) continue;
    const value = evaluateSimpleXPathNumericFunction({
      document,
      expression: inner,
      functionName,
      namespaces,
      contextNode,
    });
    return value === undefined ? undefined : { kind: 'number', value };
  }

  for (const functionName of ['round', 'floor', 'ceiling'] as const) {
    const inner = unwrapXPathFunction({ expression: trimmed, name: functionName });
    if (inner === undefined) continue;
    const operand = evaluateSimpleXPathScalarValue({
      document,
      expression: inner,
      namespaces,
      contextNode,
    });
    if (operand === undefined) return undefined;
    const numeric = xpathScalarToNumber({ value: operand });
    switch (functionName) {
    case 'round':
      return { kind: 'number', value: Math.round(numeric) };
    case 'floor':
      return { kind: 'number', value: Math.floor(numeric) };
    case 'ceiling':
      return { kind: 'number', value: Math.ceil(numeric) };
    default: {
      const _exhaustive: never = functionName;
      throw new Error(`Unhandled XPath rounding function: ${String(_exhaustive)}`);
    }
    }
  }

  const booleanInner = unwrapXPathFunction({ expression: trimmed, name: 'boolean' });
  if (booleanInner !== undefined) {
    const nodes = evaluateSimpleXPathNodes({
      document,
      expression: booleanInner,
      namespaces,
      contextNode,
    });
    if (nodes !== undefined) return { kind: 'boolean', value: nodes.length > 0 };
    const scalar = evaluateSimpleXPathScalarValue({
      document,
      expression: booleanInner,
      namespaces,
      contextNode,
    });
    return scalar === undefined
      ? undefined
      : { kind: 'boolean', value: xpathScalarToBoolean({ value: scalar }) };
  }

  for (const name of ['starts-with', 'contains', 'lang'] as const) {
    if (unwrapXPathFunction({ expression: trimmed, name }) === undefined) continue;
    const value = evaluateSimpleXPathBooleanValue({
      document,
      expression: trimmed,
      namespaces,
      contextNode,
    });
    return value === undefined ? undefined : { kind: 'boolean', value };
  }

  const value = evaluateSimpleXPathString({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (value !== undefined) {
    return isSimpleXPathNumberExpression({ expression: trimmed })
      ? { kind: 'number', value: xpathStringToNumber({ value }) }
      : { kind: 'string', value };
  }

  const result = document.evaluate(
    rewriteNamespacedXPath({
      expression: rewriteSimpleXPathNumericFunctions({
        document,
        expression: trimmed,
        namespaces,
        contextNode,
      }),
      namespaces,
    }),
    contextNode ?? document,
    createNamespaceResolver({ document, namespaces }),
    XPathResult.ANY_TYPE,
    null,
  );
  switch (result.resultType) {
  case XPathResult.BOOLEAN_TYPE:
    return { kind: 'boolean', value: result.booleanValue };
  case XPathResult.NUMBER_TYPE:
    return { kind: 'number', value: result.numberValue };
  case XPathResult.STRING_TYPE:
    return { kind: 'string', value: result.stringValue };
  case XPathResult.UNORDERED_NODE_ITERATOR_TYPE:
  case XPathResult.ORDERED_NODE_ITERATOR_TYPE:
  case XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE:
  case XPathResult.ORDERED_NODE_SNAPSHOT_TYPE:
  case XPathResult.ANY_UNORDERED_NODE_TYPE:
  case XPathResult.FIRST_ORDERED_NODE_TYPE:
    return undefined;
  default: {
    const _exhaustive: never = result.resultType as never;
    throw new Error(`Unhandled XPath scalar result type: ${String(_exhaustive)}`);
  }
  }
}

function xpathScalarToString({ value }: { value: SimpleXPathScalarValue }): string {
  switch (value.kind) {
  case 'boolean':
    return value.value ? 'true' : 'false';
  case 'number':
    return formatXPathNumberValue({ value: value.value });
  case 'string':
    return value.value;
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled XPath scalar type: ${String(_exhaustive)}`);
  }
  }
}

function xpathScalarToBoolean({ value }: { value: SimpleXPathScalarValue }): boolean {
  switch (value.kind) {
  case 'boolean':
    return value.value;
  case 'number':
    return !Number.isNaN(value.value) && value.value !== 0;
  case 'string':
    return value.value.length > 0;
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled XPath scalar type: ${String(_exhaustive)}`);
  }
  }
}

function xpathScalarToNumber({ value }: { value: SimpleXPathScalarValue }): number {
  switch (value.kind) {
  case 'boolean':
    return value.value ? 1 : 0;
  case 'number':
    return value.value;
  case 'string':
    return xpathStringToNumber({ value: value.value });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled XPath scalar type: ${String(_exhaustive)}`);
  }
  }
}

function compareXPathValues({
  left,
  operator,
  right,
}: {
  left: SimpleXPathScalarValue;
  operator: XPathComparisonOperator;
  right: SimpleXPathScalarValue;
}): boolean {
  if (operator === '=' || operator === '!=') {
    const equal = left.kind === 'boolean' || right.kind === 'boolean'
      ? xpathScalarToBoolean({ value: left }) === xpathScalarToBoolean({ value: right })
      : left.kind === 'number' || right.kind === 'number'
        ? xpathScalarToNumber({ value: left }) === xpathScalarToNumber({ value: right })
        : left.value === right.value;
    switch (operator) {
    case '=':
      return equal;
    case '!=':
      return !equal;
    default: {
      const _exhaustive: never = operator;
      throw new Error(`Unhandled XPath equality operator: ${String(_exhaustive)}`);
    }
    }
  }

  const leftNumber = xpathScalarToNumber({ value: left });
  const rightNumber = xpathScalarToNumber({ value: right });
  switch (operator) {
  case '<':
    return leftNumber < rightNumber;
  case '<=':
    return leftNumber <= rightNumber;
  case '>':
    return leftNumber > rightNumber;
  case '>=':
    return leftNumber >= rightNumber;
  default: {
    const _exhaustive: never = operator;
    throw new Error(`Unhandled XPath comparison operator: ${String(_exhaustive)}`);
  }
  }
}

function compareXPathNodeSets({
  leftNodes,
  operator,
  rightNodes,
}: {
  leftNodes: readonly Node[];
  operator: XPathComparisonOperator;
  rightNodes: readonly Node[];
}): boolean {
  const useNumbers = operator !== '=' && operator !== '!=';
  for (const leftNode of leftNodes) {
    const leftString = getXPathNodeStringValue({ node: leftNode });
    const left: SimpleXPathScalarValue = useNumbers
      ? { kind: 'number', value: xpathStringToNumber({ value: leftString }) }
      : { kind: 'string', value: leftString };
    for (const rightNode of rightNodes) {
      const rightString = getXPathNodeStringValue({ node: rightNode });
      const right: SimpleXPathScalarValue = useNumbers
        ? { kind: 'number', value: xpathStringToNumber({ value: rightString }) }
        : { kind: 'string', value: rightString };
      if (compareXPathValues({ left, operator, right })) return true;
    }
  }
  return false;
}

function compareXPathNodeSetToScalar({
  nodes,
  operator,
  scalar,
  nodesAreLeft,
}: {
  nodes: readonly Node[];
  operator: XPathComparisonOperator;
  scalar: SimpleXPathScalarValue;
  nodesAreLeft: boolean;
}): boolean {
  if ((operator === '=' || operator === '!=') && scalar.kind === 'boolean') {
    const nodeSetValue: SimpleXPathScalarValue = { kind: 'boolean', value: nodes.length > 0 };
    return nodesAreLeft
      ? compareXPathValues({ left: nodeSetValue, operator, right: scalar })
      : compareXPathValues({ left: scalar, operator, right: nodeSetValue });
  }

  const useNumbers = operator !== '=' && operator !== '!=' || scalar.kind === 'number';
  for (const node of nodes) {
    const stringValue = getXPathNodeStringValue({ node });
    const nodeValue: SimpleXPathScalarValue = useNumbers
      ? { kind: 'number', value: xpathStringToNumber({ value: stringValue }) }
      : { kind: 'string', value: stringValue };
    const matches = nodesAreLeft
      ? compareXPathValues({ left: nodeValue, operator, right: scalar })
      : compareXPathValues({ left: scalar, operator, right: nodeValue });
    if (matches) return true;
  }
  return false;
}

export function evaluateXPathBooleanWithContext({
  document,
  expression,
  namespaces,
  contextNode,
  contextPosition,
  contextSize,
}: {
  document: Document,
  expression: string,
  namespaces: Map<string, string>,
  contextNode: Node | undefined,
  contextPosition: number,
  contextSize: number,
}): boolean {
  return evaluateXPathBoolean({
    document,
    expression: rewriteXPathContextFunctions({
      expression,
      contextPosition,
      contextSize,
    }),
    namespaces,
    contextNode,
  });
}

export function evaluateXPathBoolean({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode?: Node;
}): boolean {
  assertXPathWhitespaceIsValid({ expression });
  const trimmed = unwrapAllXPathParentheses({ expression });
  if (trimmed === 'true()') return true;
  if (trimmed === 'false()') return false;
  if (trimmed === 'self::text()') {
    return contextNode?.nodeType === Node.TEXT_NODE
      || contextNode?.nodeType === Node.CDATA_SECTION_NODE;
  }

  const orParts = splitTopLevelXPathLogicalOperator({ expression: trimmed, operator: 'or' });
  if (orParts !== undefined) {
    return orParts.some((part) => evaluateXPathBoolean({
      document,
      expression: part,
      namespaces,
      contextNode,
    }));
  }
  const andParts = splitTopLevelXPathLogicalOperator({ expression: trimmed, operator: 'and' });
  if (andParts !== undefined) {
    return andParts.every((part) => evaluateXPathBoolean({
      document,
      expression: part,
      namespaces,
      contextNode,
    }));
  }

  const notInner = unwrapXPathFunction({ expression: trimmed, name: 'not' });
  if (notInner !== undefined) {
    return !evaluateXPathBoolean({ document, expression: notInner, namespaces, contextNode });
  }

  const comparison = parseTopLevelXPathComparison({ expression: trimmed });
  if (comparison !== undefined) {
    const leftNodes = evaluateSimpleXPathNodes({
      document,
      expression: comparison.left,
      namespaces,
      contextNode,
    });
    const rightNodes = evaluateSimpleXPathNodes({
      document,
      expression: comparison.right,
      namespaces,
      contextNode,
    });
    if (leftNodes !== undefined && rightNodes !== undefined) {
      return compareXPathNodeSets({
        leftNodes,
        operator: comparison.operator,
        rightNodes,
      });
    }
    if (leftNodes !== undefined) {
      const right = evaluateSimpleXPathScalarValue({
        document,
        expression: comparison.right,
        namespaces,
        contextNode,
      });
      if (right !== undefined) {
        return compareXPathNodeSetToScalar({
          nodes: leftNodes,
          operator: comparison.operator,
          scalar: right,
          nodesAreLeft: true,
        });
      }
    }
    if (rightNodes !== undefined) {
      const left = evaluateSimpleXPathScalarValue({
        document,
        expression: comparison.left,
        namespaces,
        contextNode,
      });
      if (left !== undefined) {
        return compareXPathNodeSetToScalar({
          nodes: rightNodes,
          operator: comparison.operator,
          scalar: left,
          nodesAreLeft: false,
        });
      }
    }
    if (leftNodes === undefined && rightNodes === undefined) {
      const left = evaluateSimpleXPathScalarValue({
        document,
        expression: comparison.left,
        namespaces,
        contextNode,
      });
      const right = evaluateSimpleXPathScalarValue({
        document,
        expression: comparison.right,
        namespaces,
        contextNode,
      });
      if (left !== undefined && right !== undefined) {
        return compareXPathValues({ left, operator: comparison.operator, right });
      }
    }
  }

  const booleanValue = evaluateSimpleXPathBooleanValue({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (booleanValue !== undefined) return booleanValue;

  const nodes = evaluateSimpleXPathNodes({ document, expression: trimmed, namespaces, contextNode });
  if (nodes !== undefined) return nodes.length > 0;

  const simpleValue = evaluateSimpleXPathString({ document, expression: trimmed, namespaces, contextNode });
  if (simpleValue !== undefined) {
    if (!isSimpleXPathNumberExpression({ expression: trimmed })) return simpleValue.length > 0;
    const numeric = xpathStringToNumber({ value: simpleValue });
    return !Number.isNaN(numeric) && numeric !== 0;
  }

  const result = document.evaluate(
    rewriteNamespacedXPath({
      expression: rewriteSimpleXPathNumericFunctions({
        document,
        expression,
        namespaces,
        contextNode,
      }),
      namespaces,
    }),
    contextNode ?? document,
    createNamespaceResolver({ document, namespaces }),
    XPathResult.BOOLEAN_TYPE,
    null,
  );
  return result.booleanValue;
}

function createNamespaceResolver({
  document,
  namespaces,
}: {
  document: Document,
  namespaces: Map<string, string>,
}): XPathNSResolver | null {
  const builtInResolver = document.createNSResolver?.(document.documentElement ?? document);

  if (namespaces.size === 0) {
    return builtInResolver;
  }

  return {
    lookupNamespaceURI(prefix) {
      const normalizedPrefix = prefix ?? '';
      if (normalizedPrefix === 'xml') return XML_NAMESPACE_URI;
      const overridden = namespaces.get(normalizedPrefix);
      if (overridden !== undefined) {
        return overridden;
      }
      return builtInResolver?.lookupNamespaceURI(prefix) ?? null;
    },
  };
}

function parseLeadingXPathFunction({
  expression,
  name,
}: {
  expression: string;
  name: string;
}): { readonly inner: string; readonly closingIndex: number } | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (!trimmed.startsWith(name)) return undefined;
  let openingIndex = name.length;
  while (/[\t\n\r ]/u.test(trimmed[openingIndex] ?? '')) openingIndex += 1;
  if (trimmed[openingIndex] !== '(') return undefined;

  let quote: '"' | "'" | undefined;
  let depth = 1;
  for (let index = openingIndex + 1; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: trimXPathWhitespace({ value: trimmed.slice(openingIndex + 1, index) }),
          closingIndex: index,
        };
      }
    }
  }
  return undefined;
}

function evaluateXPathIdNodes({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode: Node | undefined;
}): Node[] | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  const parsedFunction = parseLeadingXPathFunction({ expression: trimmed, name: 'id' });
  if (parsedFunction === undefined) return undefined;

  const predicateValues: string[] = [];
  let cursor = parsedFunction.closingIndex + 1;
  let quote: '"' | "'" | undefined;
  while (cursor < trimmed.length) {
    while (/[\t\n\r ]/u.test(trimmed[cursor] ?? '')) cursor += 1;
    if (trimmed[cursor] !== '[') break;
    const openingIndex = cursor;
    let predicateDepth = 1;
    cursor += 1;
    for (; cursor < trimmed.length; cursor += 1) {
      const character = trimmed[cursor] ?? '';
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '[') predicateDepth += 1;
      else if (character === ']') {
        predicateDepth -= 1;
        if (predicateDepth === 0) break;
      }
    }
    if (predicateDepth !== 0 || quote !== undefined) return undefined;
    predicateValues.push(trimmed.slice(openingIndex + 1, cursor));
    cursor += 1;
  }

  const remainder = trimXPathWhitespace({ value: trimmed.slice(cursor) });
  if (remainder.length > 0 && !remainder.startsWith('/')) return undefined;
  const predicates = parseSimplePredicates({ values: predicateValues });
  if (predicates === undefined) return undefined;

  const argumentNodes = evaluateSimpleXPathNodes({
    document,
    expression: parsedFunction.inner,
    namespaces,
    contextNode,
  }) ?? evaluateGroupedXPathNodes({
    document,
    expression: parsedFunction.inner,
    namespaces,
    contextNode,
  }) ?? (splitTopLevelXPathUnion({ expression: parsedFunction.inner }) === undefined
    ? undefined
    : evaluateXPathNodes({
      document,
      expression: parsedFunction.inner,
      namespaces,
      contextNode,
    }));
  const argumentValues = argumentNodes === undefined
    ? (() => {
      const scalar = evaluateSimpleXPathScalarValue({
        document,
        expression: parsedFunction.inner,
        namespaces,
        contextNode,
      });
      return scalar === undefined ? undefined : [xpathScalarToString({ value: scalar })];
    })()
    : argumentNodes.map((node) => getXPathNodeStringValue({ node }));
  if (argumentValues === undefined) return undefined;

  const metadata = xmlDocumentMetadata.get(document);
  const elementsById = metadata?.elementsById ?? new Map<string, Element>();
  const nodes: Node[] = [];
  const seen = new Set<Node>();
  for (const value of argumentValues) {
    for (const token of value.split(/[ \t\n\r]+/u)) {
      if (token.length === 0) continue;
      const element = elementsById.get(token);
      if (element === undefined || seen.has(element)) continue;
      seen.add(element);
      nodes.push(element);
    }
  }

  let selected = [...applyXPathPredicates({ nodes, predicates, namespaces })];
  if (remainder.length === 0) return selected;
  const relativeExpression = remainder.startsWith('//') ? `.${remainder}` : remainder.slice(1);
  const result: Node[] = [];
  const selectedSeen = new Set<Node>();
  for (const node of selected) {
    for (const relativeNode of evaluateXPathNodes({
      document,
      expression: relativeExpression,
      namespaces,
      contextNode: node,
    })) {
      if (selectedSeen.has(relativeNode)) continue;
      selectedSeen.add(relativeNode);
      result.push(relativeNode);
    }
  }
  selected = result;
  return selected;
}

function evaluateGroupedXPathNodes({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document;
  expression: string;
  namespaces: Map<string, string>;
  contextNode: Node | undefined;
}): Node[] | undefined {
  const trimmed = trimXPathWhitespace({ value: expression });
  if (!trimmed.startsWith('(')) return undefined;

  let quote: '"' | "'" | undefined;
  let depth = 0;
  let closingIndex: number | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character !== ')') continue;
    depth -= 1;
    if (depth < 0) return undefined;
    if (depth === 0) {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === undefined || quote !== undefined) return undefined;

  const inner = trimXPathWhitespace({ value: trimmed.slice(1, closingIndex) });
  if (inner.length === 0) return undefined;
  const innerUnionParts = splitTopLevelXPathUnion({ expression: inner });
  const innerSimpleNodes = innerUnionParts === undefined
    ? evaluateSimpleXPathNodes({ document, expression: inner, namespaces, contextNode })
    : undefined;
  const innerGroupedNodes = innerUnionParts === undefined
    && innerSimpleNodes === undefined
    && inner.startsWith('(')
    ? evaluateGroupedXPathNodes({ document, expression: inner, namespaces, contextNode })
    : undefined;
  if (
    innerUnionParts === undefined
    && innerSimpleNodes === undefined
    && innerGroupedNodes === undefined
  ) return undefined;
  const predicateValues: string[] = [];
  let cursor = closingIndex + 1;
  while (cursor < trimmed.length) {
    while (/[\t\n\r ]/u.test(trimmed[cursor] ?? '')) cursor += 1;
    if (trimmed[cursor] !== '[') break;
    const openingIndex = cursor;
    let predicateDepth = 1;
    quote = undefined;
    cursor += 1;
    for (; cursor < trimmed.length; cursor += 1) {
      const character = trimmed[cursor] ?? '';
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '[') predicateDepth += 1;
      else if (character === ']') {
        predicateDepth -= 1;
        if (predicateDepth === 0) break;
      }
    }
    if (predicateDepth !== 0 || quote !== undefined) return undefined;
    predicateValues.push(trimmed.slice(openingIndex + 1, cursor));
    cursor += 1;
  }

  const remainder = trimXPathWhitespace({ value: trimmed.slice(cursor) });
  if (remainder.length > 0 && !remainder.startsWith('/')) return undefined;
  const predicates = parseSimplePredicates({ values: predicateValues });
  if (predicates === undefined) return undefined;
  let nodes = [...(
    innerSimpleNodes
    ?? innerGroupedNodes
    ?? evaluateXPathNodes({ document, expression: inner, namespaces, contextNode })
  )];
  nodes = [...applyXPathPredicates({ nodes, predicates, namespaces })];
  if (remainder.length === 0) return nodes;

  const relativeExpression = remainder.startsWith('//')
    ? `.${remainder}`
    : remainder.slice(1);
  const result: Node[] = [];
  const seen = new Set<Node>();
  for (const node of nodes) {
    for (const selected of evaluateXPathNodes({
      document,
      expression: relativeExpression,
      namespaces,
      contextNode: node,
    })) {
      if (seen.has(selected)) continue;
      seen.add(selected);
      result.push(selected);
    }
  }
  sortNodesInDocumentOrder({ nodes: result });
  return result;
}

export function evaluateXPathNodes({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document,
  expression: string,
  namespaces: Map<string, string>,
  contextNode?: Node,
}): Array<Node> {
  assertXPathWhitespaceIsValid({ expression });
  const normalizedExpression = unwrapAllXPathParentheses({ expression });
  const groupedNodes = evaluateGroupedXPathNodes({
    document,
    expression: normalizedExpression,
    namespaces,
    contextNode,
  });
  if (groupedNodes !== undefined) return groupedNodes;
  const unionParts = splitTopLevelXPathUnion({ expression: normalizedExpression });
  if (unionParts !== undefined) {
    const nodes: Node[] = [];
    const seen = new Set<Node>();
    for (const part of unionParts) {
      for (const node of evaluateXPathNodes({ document, expression: part, namespaces, contextNode })) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }
    sortNodesInDocumentOrder({ nodes });
    return nodes;
  }
  const simpleNodes = evaluateSimpleXPathNodes({
    document,
    expression: normalizedExpression,
    namespaces,
    contextNode,
  });
  if (simpleNodes !== undefined) {
    return simpleNodes;
  }

  const result = document.evaluate(
    rewriteNamespacedXPath({ expression: normalizedExpression, namespaces }),
    contextNode ?? document,
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
  return nodes;
}


export function evaluateXPathValueStrings({
  document,
  expression,
  namespaces,
  contextNode,
  contextPosition,
  contextSize,
}: {
  document: Document,
  expression: string,
  namespaces: Map<string, string>,
  contextNode: Node | undefined,
  contextPosition: number,
  contextSize: number,
}): readonly string[] {
  assertXPathWhitespaceIsValid({ expression });
  const contextualExpression = rewriteXPathContextFunctions({
    expression,
    contextPosition,
    contextSize,
  });
  const trimmed = unwrapAllXPathParentheses({ expression: contextualExpression });
  if (trimmed === '/') return [getXPathNodeStringValue({ node: document })];
  const booleanExpression = trimmed;
  const hasLogicalOperator = splitTopLevelXPathLogicalOperator({
    expression: booleanExpression,
    operator: 'or',
  }) !== undefined || splitTopLevelXPathLogicalOperator({
    expression: booleanExpression,
    operator: 'and',
  }) !== undefined;
  if (
    hasLogicalOperator
    || parseTopLevelXPathComparison({ expression: booleanExpression }) !== undefined
    || unwrapXPathFunction({ expression: booleanExpression, name: 'not' }) !== undefined
  ) {
    return [evaluateXPathBoolean({
      document,
      expression: booleanExpression,
      namespaces,
      contextNode,
    }) ? 'true' : 'false'];
  }

  const simpleNodes = evaluateSimpleXPathNodes({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (simpleNodes !== undefined) {
    return simpleNodes.map((node) => getXPathNodeStringValue({ node }));
  }
  const groupedNodes = evaluateGroupedXPathNodes({ document, expression: trimmed, namespaces, contextNode });
  if (groupedNodes !== undefined) {
    return groupedNodes.map((node) => getXPathNodeStringValue({ node }));
  }
  if (splitTopLevelXPathUnion({ expression: trimmed }) !== undefined) {
    return evaluateXPathNodes({ document, expression: trimmed, namespaces, contextNode })
      .map((node) => getXPathNodeStringValue({ node }));
  }

  const simpleValue = evaluateSimpleXPathString({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (simpleValue !== undefined) return [simpleValue];

  const scalarValue = evaluateSimpleXPathScalarValue({
    document,
    expression: trimmed,
    namespaces,
    contextNode,
  });
  if (scalarValue !== undefined) {
    switch (scalarValue.kind) {
    case 'number':
      return [formatXPathNumberValue({ value: scalarValue.value })];
    case 'boolean':
      return [scalarValue.value ? 'true' : 'false'];
    case 'string':
      return [scalarValue.value];
    default: {
      const _exhaustive: never = scalarValue;
      throw new Error(`Unhandled XPath scalar kind: ${String(_exhaustive)}`);
    }
    }
  }

  const result = document.evaluate(
    rewriteNamespacedXPath({
      expression: rewriteSimpleXPathNumericFunctions({
        document,
        expression: trimmed,
        namespaces,
        contextNode,
      }),
      namespaces,
    }),
    contextNode ?? document,
    createNamespaceResolver({ document, namespaces }),
    XPathResult.ANY_TYPE,
    null,
  );
  switch (result.resultType) {
  case XPathResult.NUMBER_TYPE:
    return [formatXPathNumberValue({ value: result.numberValue })];
  case XPathResult.STRING_TYPE:
    return [result.stringValue];
  case XPathResult.BOOLEAN_TYPE:
    return [result.booleanValue ? 'true' : 'false'];
  case XPathResult.UNORDERED_NODE_ITERATOR_TYPE:
  case XPathResult.ORDERED_NODE_ITERATOR_TYPE: {
    const values: string[] = [];
    for (let node = result.iterateNext(); node !== null; node = result.iterateNext()) {
      values.push(getXPathNodeStringValue({ node }));
    }
    return values;
  }
  case XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE:
  case XPathResult.ORDERED_NODE_SNAPSHOT_TYPE: {
    const values: string[] = [];
    for (let index = 0; index < result.snapshotLength; index += 1) {
      const node = result.snapshotItem(index);
      if (node !== null) values.push(getXPathNodeStringValue({ node }));
    }
    return values;
  }
  case XPathResult.ANY_UNORDERED_NODE_TYPE:
  case XPathResult.FIRST_ORDERED_NODE_TYPE:
    return result.singleNodeValue === null
      ? []
      : [getXPathNodeStringValue({ node: result.singleNodeValue })];
  default: {
    const _exhaustive: never = result.resultType as never;
    throw new Error(`Unhandled XPath result type: ${String(_exhaustive)}`);
  }
  }
}

export function evaluateXPathString({
  document,
  expression,
  namespaces,
  contextNode,
}: {
  document: Document,
  expression: string,
  namespaces: Map<string, string>,
  contextNode?: Node,
}): string {
  assertXPathWhitespaceIsValid({ expression });
  const simpleValue = evaluateSimpleXPathString({
    document,
    expression,
    namespaces,
    contextNode,
  });
  if (simpleValue !== undefined) {
    return simpleValue;
  }

  const result = document.evaluate(
    rewriteNamespacedXPath({
      expression: rewriteSimpleXPathNumericFunctions({
        document,
        expression,
        namespaces,
        contextNode,
      }),
      namespaces,
    }),
    contextNode ?? document,
    createNamespaceResolver({ document, namespaces }),
    XPathResult.STRING_TYPE,
    null,
  );
  return result.stringValue;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
