import { exactObject } from '@/utils/exact-object';
import type { CspParseIssue, CspParseResult, ParsedCsp, ParsedCspDirective, ParsedCspPolicy, ParsedCspSourceExpression } from './types';

export type { CspParseIssue, CspParseResult, ParsedCsp, ParsedCspDirective, ParsedCspPolicy, ParsedCspSourceExpression } from './types';

const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_POLICIES = 128;
const MAX_DIRECTIVES = 1024;
const MAX_TOKENS = 8192;

const SOURCE_LIST_DIRECTIVES = new Set([
  'base-uri', 'child-src', 'connect-src', 'default-src', 'font-src', 'form-action', 'frame-ancestors', 'frame-src',
  'img-src', 'manifest-src', 'media-src', 'navigate-to', 'object-src', 'prefetch-src', 'script-src', 'script-src-attr',
  'script-src-elem', 'style-src', 'style-src-attr', 'style-src-elem', 'worker-src',
]);
const OTHER_DIRECTIVES = new Set([
  'block-all-mixed-content', 'plugin-types', 'report-to', 'report-uri', 'require-trusted-types-for', 'sandbox',
  'treat-as-public-address', 'trusted-types', 'upgrade-insecure-requests', 'webrtc',
]);
const KEYWORDS = new Set([
  'none', 'self', 'unsafe-inline', 'unsafe-eval', 'strict-dynamic', 'unsafe-hashes', 'report-sample',
  'unsafe-allow-redirects', 'wasm-unsafe-eval', 'trusted-types-eval', 'report-sha256', 'report-sha384',
  'report-sha512', 'unsafe-webtransport-hashes',
]);

type ParseFailure = Extract<CspParseResult, { kind: 'failed' }>;
type SourceOfKind<Kind extends ParsedCspSourceExpression['kind']> = Extract<ParsedCspSourceExpression, { kind: Kind }>;
type ParseBudget = { directives: number, tokens: number };

function asciiLowercase({ value }: { value: string }): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function isAsciiWhitespace({ code }: { code: number }): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function trimBounds({ serialized, start, end }: { serialized: string, start: number, end: number }): { start: number, end: number } {
  while (start < end && isAsciiWhitespace({ code: serialized.charCodeAt(start) })) {
    start++;
  }
  while (end > start && isAsciiWhitespace({ code: serialized.charCodeAt(end - 1) })) {
    end--;
  }
  return { start, end };
}

function parseFailure({ reason }: { reason: ParseFailure['reason'] }): ParseFailure {
  return Object.freeze(exactObject<ParseFailure>()({ kind: 'failed', reason }));
}

function issue({ kind, start, end }: { kind: CspParseIssue['kind'], start: number, end: number }): CspParseIssue {
  return Object.freeze(exactObject<CspParseIssue>()({ kind, start, end }));
}

function isPathPart({ value }: { value: string }): boolean {
  if (!value.startsWith('/') || (value.length > 1 && value[1] === '/')) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '%') {
      if (!/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
        return false;
      }
      index += 2;
    } else if (character === undefined || !/^[a-z0-9\-._~!$&'()*+=:@/]$/i.test(character)) {
      return false;
    }
  }
  return true;
}

function opaqueSource({ serialized, kind }: { serialized: string, kind: 'unknown' | 'invalid' }): SourceOfKind<'unknown'> | SourceOfKind<'invalid'> {
  switch (kind) {
  case 'unknown': return Object.freeze(exactObject<SourceOfKind<'unknown'>>()({ kind, serialized }));
  case 'invalid': return Object.freeze(exactObject<SourceOfKind<'invalid'>>()({ kind, serialized }));
  default: {
    const exhaustive: never = kind;
    return exhaustive;
  }
  }
}

function parseSourceExpression({ serialized }: { serialized: string }): ParsedCspSourceExpression {
  const lowercase = asciiLowercase({ value: serialized });
  if (serialized.startsWith("'")) {
    if (!serialized.endsWith("'") || serialized.length < 2) {
      return opaqueSource({ serialized, kind: 'invalid' });
    }
    const value = serialized.slice(1, -1);
    const lowercaseValue = lowercase.slice(1, -1);
    if (KEYWORDS.has(lowercaseValue)) {
      return Object.freeze(exactObject<SourceOfKind<'keyword'>>()({ kind: 'keyword', serialized, value: lowercaseValue }));
    }
    if (lowercaseValue.startsWith('nonce-')) {
      const nonce = value.slice(6);
      return /^[a-z0-9+/_-]+={0,2}$/i.test(nonce)
        ? Object.freeze(exactObject<SourceOfKind<'nonce'>>()({ kind: 'nonce', serialized, value: nonce }))
        : opaqueSource({ serialized, kind: 'invalid' });
    }
    const hash = /^(sha256|sha384|sha512)-(.*)$/i.exec(value);
    if (hash !== null) {
      const algorithm = asciiLowercase({ value: hash[1] ?? '' });
      const digest = hash[2] ?? '';
      if ((algorithm === 'sha256' || algorithm === 'sha384' || algorithm === 'sha512') && /^[a-z0-9+/_-]+={0,2}$/i.test(digest)) {
        return Object.freeze(exactObject<SourceOfKind<'hash'>>()({ kind: 'hash', serialized, algorithm, value: digest }));
      }
      return opaqueSource({ serialized, kind: 'invalid' });
    }
    return opaqueSource({ serialized, kind: 'unknown' });
  }
  if (/^[a-z][a-z0-9+.-]*:$/i.test(serialized)) {
    return Object.freeze(exactObject<SourceOfKind<'scheme'>>()({ kind: 'scheme', serialized, scheme: lowercase.slice(0, -1) }));
  }

  let authorityAndPath = serialized;
  let scheme: string | undefined;
  const schemeBoundary = serialized.indexOf('://');
  if (schemeBoundary !== -1) {
    const candidate = serialized.slice(0, schemeBoundary);
    if (!/^[a-z][a-z0-9+.-]*$/i.test(candidate)) {
      return opaqueSource({ serialized, kind: 'unknown' });
    }
    scheme = asciiLowercase({ value: candidate });
    authorityAndPath = serialized.slice(schemeBoundary + 3);
  }
  const pathBoundary = authorityAndPath.indexOf('/');
  const authority = pathBoundary === -1 ? authorityAndPath : authorityAndPath.slice(0, pathBoundary);
  const path = pathBoundary === -1 ? undefined : authorityAndPath.slice(pathBoundary);
  if (path !== undefined && !isPathPart({ value: path })) {
    return opaqueSource({ serialized, kind: 'unknown' });
  }
  const portBoundary = authority.indexOf(':');
  const serializedHost = portBoundary === -1 ? authority : authority.slice(0, portBoundary);
  const port = portBoundary === -1 ? undefined : authority.slice(portBoundary + 1);
  if (port !== undefined && port !== '*' && !/^[0-9]+$/.test(port)) {
    return opaqueSource({ serialized, kind: 'unknown' });
  }
  const wildcard = serializedHost === '*' ? 'any' : serializedHost.startsWith('*.') ? 'subdomains' : 'none';
  let host: string;
  switch (wildcard) {
  case 'any': host = '*';
    break;
  case 'subdomains': host = asciiLowercase({ value: serializedHost.slice(2) });
    break;
  case 'none': host = asciiLowercase({ value: serializedHost });
    break;
  default: {
    const exhaustive: never = wildcard;
    return exhaustive;
  }
  }
  if (host !== '*' && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/i.test(host)) {
    return opaqueSource({ serialized, kind: 'unknown' });
  }
  return Object.freeze(exactObject<SourceOfKind<'host'>>()({ kind: 'host', serialized, scheme, host, wildcard, port, path }));
}

function parseDirective({ serialized, start, end, firstByName, index, budget }: { serialized: string, start: number, end: number, firstByName: Map<string, number>, index: number, budget: ParseBudget }): ParsedCspDirective | ParseFailure {
  const bounds = trimBounds({ serialized, start, end });
  let nameEnd = bounds.start;
  while (nameEnd < bounds.end && !isAsciiWhitespace({ code: serialized.charCodeAt(nameEnd) })) {
    nameEnd++;
  }
  const originalName = serialized.slice(bounds.start, nameEnd);
  const name = asciiLowercase({ value: originalName });
  const valueBounds = trimBounds({ serialized, start: nameEnd, end: bounds.end });
  const value = serialized.slice(valueBounds.start, valueBounds.end);
  const issues: CspParseIssue[] = [];
  let ascii = true;
  for (let cursor = bounds.start; cursor < bounds.end; cursor++) {
    if (serialized.charCodeAt(cursor) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (!ascii) {
    issues.push(issue({ kind: 'non-ascii-directive', start: bounds.start, end: bounds.end }));
  }
  if (!/^[a-z0-9-]+$/i.test(originalName)) {
    issues.push(issue({ kind: 'invalid-directive-name', start: bounds.start, end: nameEnd }));
  }
  if (!SOURCE_LIST_DIRECTIVES.has(name) && !OTHER_DIRECTIVES.has(name)) {
    issues.push(issue({ kind: 'unknown-directive', start: bounds.start, end: nameEnd }));
  }
  for (let cursor = valueBounds.start; cursor < valueBounds.end; cursor++) {
    const code = serialized.charCodeAt(cursor);
    if ((code < 0x20 && !isAsciiWhitespace({ code })) || code > 0x7e) {
      issues.push(issue({ kind: 'invalid-directive-value', start: valueBounds.start, end: valueBounds.end }));
      break;
    }
  }
  const duplicateOf = ascii ? firstByName.get(name) : undefined;
  const occurrence = !ascii ? 'ignored-non-ascii' : duplicateOf === undefined ? 'first' : 'duplicate';
  switch (occurrence) {
  case 'first':
    firstByName.set(name, index);
    break;
  case 'duplicate':
    issues.push(issue({ kind: 'duplicate-directive', start: bounds.start, end: bounds.end }));
    break;
  case 'ignored-non-ascii': break;
  default: {
    const exhaustive: never = occurrence;
    return exhaustive;
  }
  }

  const tokens: string[] = [];
  const sourceExpressions: ParsedCspSourceExpression[] | undefined = SOURCE_LIST_DIRECTIVES.has(name) ? [] : undefined;
  let cursor = valueBounds.start;
  while (cursor < valueBounds.end) {
    if (isAsciiWhitespace({ code: serialized.charCodeAt(cursor) })) {
      cursor++;
      continue;
    }
    const tokenStart = cursor;
    while (cursor < valueBounds.end && !isAsciiWhitespace({ code: serialized.charCodeAt(cursor) })) {
      cursor++;
    }
    if (++budget.tokens > MAX_TOKENS) {
      return parseFailure({ reason: 'too-many-tokens' });
    }
    const token = serialized.slice(tokenStart, cursor);
    tokens.push(token);
    if (sourceExpressions !== undefined) {
      const source = parseSourceExpression({ serialized: token });
      sourceExpressions.push(source);
      switch (source.kind) {
      case 'unknown':
        issues.push(issue({ kind: 'unknown-source-expression', start: tokenStart, end: cursor }));
        break;
      case 'invalid':
        issues.push(issue({ kind: 'invalid-source-expression', start: tokenStart, end: cursor }));
        break;
      case 'keyword':
      case 'scheme':
      case 'host':
      case 'nonce':
      case 'hash': break;
      default: {
        const exhaustive: never = source;
        return exhaustive;
      }
      }
    }
  }
  return Object.freeze(exactObject<ParsedCspDirective>()({
    serialized: serialized.slice(start, end),
    name,
    originalName,
    value,
    tokens: Object.freeze(tokens),
    sourceExpressions: sourceExpressions === undefined ? undefined : Object.freeze(sourceExpressions),
    occurrence,
    duplicateOf,
    issues: Object.freeze(issues),
  }));
}

function parsePolicy({ serialized, start, end, budget }: { serialized: string, start: number, end: number, budget: ParseBudget }): ParsedCspPolicy | ParseFailure {
  const directives: ParsedCspDirective[] = [];
  const issues: CspParseIssue[] = [];
  const firstByName = new Map<string, number>();
  let directiveStart = start;
  for (let cursor = start; cursor <= end; cursor++) {
    if (cursor !== end && serialized[cursor] !== ';') {
      continue;
    }
    const bounds = trimBounds({ serialized, start: directiveStart, end: cursor });
    if (bounds.start < bounds.end) {
      if (++budget.directives > MAX_DIRECTIVES) {
        return parseFailure({ reason: 'too-many-directives' });
      }
      const directive = parseDirective({ serialized, start: directiveStart, end: cursor, firstByName, index: directives.length, budget });
      if ('kind' in directive) {
        return directive;
      }
      directives.push(directive);
      issues.push(...directive.issues);
    }
    directiveStart = cursor + 1;
  }
  return Object.freeze(exactObject<ParsedCspPolicy>()({ serialized: serialized.slice(start, end), directives: Object.freeze(directives), issues: Object.freeze(issues) }));
}

/** Parses syntax only. Unknown extensions remain opaque; no result is an execution permission. */
export function parseCsp({ serialized }: { serialized: string }): CspParseResult {
  if (serialized.length > MAX_INPUT_LENGTH) {
    return parseFailure({ reason: 'input-too-long' });
  }
  const policies: ParsedCspPolicy[] = [];
  const issues: CspParseIssue[] = [];
  const budget: ParseBudget = { directives: 0, tokens: 0 };
  let policyStart = 0;
  for (let cursor = 0; cursor <= serialized.length; cursor++) {
    if (cursor !== serialized.length && serialized[cursor] !== ',') {
      continue;
    }
    const bounds = trimBounds({ serialized, start: policyStart, end: cursor });
    if (bounds.start < bounds.end) {
      if (policies.length === MAX_POLICIES) {
        return parseFailure({ reason: 'too-many-policies' });
      }
      const policy = parsePolicy({ serialized, start: policyStart, end: cursor, budget });
      if ('kind' in policy) {
        return policy;
      }
      policies.push(policy);
      issues.push(...policy.issues);
    }
    policyStart = cursor + 1;
  }
  const value = Object.freeze(exactObject<ParsedCsp>()({ serialized, policies: Object.freeze(policies), issues: Object.freeze(issues) }));
  return Object.freeze(exactObject<Extract<CspParseResult, { kind: 'parsed' }>>()({ kind: 'parsed', value }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
