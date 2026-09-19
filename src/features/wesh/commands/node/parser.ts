import { parse, type ParseError } from '@babel/parser';
import type { LVal, Node as BabelNode, PatternLike } from '@babel/types';
import type { NodeSyntaxInput, NodeSyntaxMode } from './input';

export interface NodeParserDiagnostic {
  readonly reasonCode: string,
  readonly line: number,
  readonly column: number,
  readonly offset: number,
  readonly details: Readonly<Record<string, unknown>>,
}

export type NodeParserResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error', readonly diagnostic: NodeParserDiagnostic };

type ParsedSyntax =
  | { readonly kind: 'ok', readonly ast: ReturnType<typeof parse> }
  | { readonly kind: 'error', readonly diagnostic: NodeParserDiagnostic };

const commonJsWrapperBindings = new Set([
  'exports',
  'require',
  'module',
  '__filename',
  '__dirname',
]);

function isParseError(error: unknown): error is ParseError {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  const candidate = error as Partial<ParseError>;
  return typeof candidate.reasonCode === 'string'
    && typeof candidate.pos === 'number'
    && typeof candidate.loc?.line === 'number'
    && typeof candidate.loc.column === 'number';
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeParseErrorDetails({
  error,
}: {
  error: ParseError,
}): Readonly<Record<string, unknown>> {
  const rawDetails = error.details as Readonly<Record<string, unknown>>;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawDetails)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      normalized[key] = Object.freeze([...value]);
    }
  }

  if (error.reasonCode === 'InvalidLhs') {
    const ancestor = rawDetails.ancestor;
    if (isUnknownRecord(ancestor)) {
      if (ancestor.type === 'AssignmentExpression') {
        normalized.operation = 'assignment';
        const target = ancestor.left;
        if (isUnknownRecord(target) && typeof target.start === 'number' && typeof target.end === 'number') {
          normalized.targetStart = target.start;
          normalized.targetEnd = target.end;
        }
      } else if (ancestor.type === 'UpdateExpression' && typeof ancestor.prefix === 'boolean') {
        normalized.operation = ancestor.prefix ? 'prefix-update' : 'postfix-update';
        const target = ancestor.argument;
        if (isUnknownRecord(target) && typeof target.start === 'number' && typeof target.end === 'number') {
          normalized.targetStart = target.start;
          normalized.targetEnd = target.end;
        }
      }
    }
  }

  return Object.freeze(normalized);
}

function normalizeParseError({ error }: { error: ParseError }): NodeParserDiagnostic {
  return {
    reasonCode: error.reasonCode,
    line: error.loc.line,
    column: error.loc.column,
    offset: error.pos,
    details: normalizeParseErrorDetails({ error }),
  };
}

function babelSourceType({
  mode,
}: {
  mode: Exclude<NodeSyntaxMode, 'ambiguous'>,
}): 'commonjs' | 'module' {
  switch (mode) {
  case 'commonjs':
    return 'commonjs';
  case 'module':
    return 'module';
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled concrete Node syntax mode: ${_ex}`);
  }
  }
}

function isBabelNode(value: unknown): value is BabelNode {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && typeof value.type === 'string';
}

function babelChildNodes({ node }: { node: BabelNode }): BabelNode[] {
  const children: BabelNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc'
      || key === 'extra'
      || key === 'comments'
      || key === 'leadingComments'
      || key === 'innerComments'
      || key === 'trailingComments'
      || key === 'tokens'
      || key === 'errors'
    ) {
      continue;
    }
    if (isBabelNode(value)) {
      children.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (isBabelNode(item)) {
        children.push(item);
      }
    }
  }
  return children;
}

function unsupportedUsingDiagnostic({
  node,
}: {
  node: Extract<BabelNode, { readonly type: 'VariableDeclaration' }>,
}): NodeParserDiagnostic | undefined {
  const declaration = node.declarations[0];
  const identifier = declaration?.id;
  if (identifier === undefined || identifier.start === null || identifier.start === undefined || identifier.loc === null || identifier.loc === undefined) {
    return undefined;
  }
  return {
    reasonCode: 'UnsupportedUsingDeclaration',
    line: identifier.loc.start.line,
    column: identifier.loc.start.column,
    offset: identifier.start,
    details: Object.freeze({}),
  };
}

function invalidRegExpDiagnostic({
  node,
}: {
  node: Extract<BabelNode, { readonly type: 'RegExpLiteral' }>,
}): NodeParserDiagnostic | undefined {
  try {
    // Compiling a RegExp validates the regular-expression grammar only. It does not
    // execute the checked JavaScript or match the expression against any input.
    new RegExp(node.pattern, node.flags);
    return undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    if (node.start === null || node.start === undefined || node.end === null || node.end === undefined || node.loc === null || node.loc === undefined) {
      return undefined;
    }
    return {
      reasonCode: 'InvalidRegExpLiteral',
      line: node.loc.start.line,
      column: node.loc.start.column,
      offset: node.start,
      details: Object.freeze({
        message: error.message,
        span: Math.max(1, node.end - node.start),
      }),
    };
  }
}

function findPostParseCompatibilityDiagnostic({
  ast,
}: {
  ast: ReturnType<typeof parse>,
}): NodeParserDiagnostic | undefined {
  const stack: BabelNode[] = [ast.program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;

    switch (node.type) {
    case 'VariableDeclaration': {
      const kind = node.kind;
      switch (kind) {
      case 'using':
      case 'await using': {
        const diagnostic = unsupportedUsingDiagnostic({ node });
        if (diagnostic !== undefined) return diagnostic;
        break;
      }
      case 'var':
      case 'let':
      case 'const':
        break;
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled Babel variable kind: ${_ex}`);
      }
      }
      break;
    }
    case 'RegExpLiteral': {
      const diagnostic = invalidRegExpDiagnostic({ node });
      if (diagnostic !== undefined) return diagnostic;
      break;
    }
    default:
      break;
    }

    stack.push(...babelChildNodes({ node }));
  }
  return undefined;
}

function parseOnce({
  source,
  mode,
  relaxedModule,
}: {
  source: string,
  mode: Exclude<NodeSyntaxMode, 'ambiguous'>,
  relaxedModule: boolean,
}): ParsedSyntax {
  try {
    const ast = parse(source, {
      sourceType: babelSourceType({ mode }),
      attachComment: false,
      ...(relaxedModule
        ? { strictMode: false, allowReturnOutsideFunction: true }
        : {}),
    });
    const compatibilityDiagnostic = findPostParseCompatibilityDiagnostic({ ast });
    return compatibilityDiagnostic === undefined
      ? { kind: 'ok', ast }
      : { kind: 'error', diagnostic: compatibilityDiagnostic };
  } catch (error) {
    if (!isParseError(error)) {
      throw error;
    }
    return { kind: 'error', diagnostic: normalizeParseError({ error }) };
  }
}

interface WrapperBindingMatch {
  readonly name: string,
  readonly offset: number,
  readonly line: number,
  readonly column: number,
}

function identifierWrapperBinding({
  name,
  start,
  loc,
}: {
  name: string,
  start: number | null | undefined,
  loc: { readonly start: { readonly line: number, readonly column: number } } | null | undefined,
}): WrapperBindingMatch | undefined {
  if (!commonJsWrapperBindings.has(name) || start === null || start === undefined || loc === null || loc === undefined) {
    return undefined;
  }
  return {
    name,
    offset: start,
    line: loc.start.line,
    column: loc.start.column,
  };
}

function findWrapperBindingInPattern({
  pattern,
}: {
  pattern: LVal | PatternLike,
}): WrapperBindingMatch | undefined {
  switch (pattern.type) {
  case 'Identifier':
    return identifierWrapperBinding({ name: pattern.name, start: pattern.start, loc: pattern.loc });
  case 'AssignmentPattern':
    return findWrapperBindingInPattern({ pattern: pattern.left });
  case 'RestElement':
    return findWrapperBindingInPattern({ pattern: pattern.argument });
  case 'ArrayPattern':
    for (const element of pattern.elements) {
      if (element === null) continue;
      const match = findWrapperBindingInPattern({ pattern: element });
      if (match !== undefined) return match;
    }
    return undefined;
  case 'ObjectPattern':
    for (const property of pattern.properties) {
      switch (property.type) {
      case 'RestElement': {
        const match = findWrapperBindingInPattern({ pattern: property.argument });
        if (match !== undefined) return match;
        break;
      }
      case 'ObjectProperty': {
        const match = findWrapperBindingInPattern({ pattern: property.value as LVal | PatternLike });
        if (match !== undefined) return match;
        break;
      }
      default: {
        const _ex: never = property;
        throw new Error(`Unhandled object binding property: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    }
    return undefined;
  case 'MemberExpression':
  case 'TSParameterProperty':
  case 'TSAsExpression':
  case 'TSSatisfiesExpression':
  case 'TSTypeAssertion':
  case 'TSNonNullExpression':
  case 'VoidPattern':
    return undefined;
  default: {
    const _ex: never = pattern;
    throw new Error(`Unhandled binding pattern: ${((_ex satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function wrapperRedeclarationDiagnostic({
  match,
}: {
  match: WrapperBindingMatch,
}): NodeParserDiagnostic {
  return {
    reasonCode: 'VarRedeclaration',
    line: match.line,
    column: match.column,
    offset: match.offset,
    details: Object.freeze({ identifierName: match.name }),
  };
}

function findCommonJsWrapperRedeclaration({
  ast,
}: {
  ast: ReturnType<typeof parse>,
}): NodeParserDiagnostic | undefined {
  for (const statement of ast.program.body) {
    switch (statement.type) {
    case 'VariableDeclaration': {
      const declarationKind = statement.kind;
      switch (declarationKind) {
      case 'var':
        continue;
      case 'let':
      case 'const':
      case 'using':
      case 'await using':
        break;
      default: {
        const _ex: never = declarationKind;
        throw new Error(`Unhandled variable declaration kind: ${_ex}`);
      }
      }
      for (const declaration of statement.declarations) {
        const match = findWrapperBindingInPattern({ pattern: declaration.id });
        if (match !== undefined) {
          return wrapperRedeclarationDiagnostic({ match });
        }
      }
      break;
    }
    case 'ClassDeclaration':
      if (statement.id !== null && statement.id !== undefined) {
        const match = identifierWrapperBinding({
          name: statement.id.name,
          start: statement.id.start,
          loc: statement.id.loc,
        });
        if (match !== undefined) {
          return wrapperRedeclarationDiagnostic({ match });
        }
      }
      break;
    default:
      break;
    }
  }
  return undefined;
}

function checkCommonJs({ source }: { source: string }): NodeParserResult {
  const parsed = parseOnce({ source, mode: 'commonjs', relaxedModule: false });
  switch (parsed.kind) {
  case 'error':
    return parsed;
  case 'ok': {
    const wrapperRedeclaration = findCommonJsWrapperRedeclaration({ ast: parsed.ast });
    return wrapperRedeclaration === undefined
      ? { kind: 'ok' }
      : { kind: 'error', diagnostic: wrapperRedeclaration };
  }
  default: {
    const _ex: never = parsed;
    throw new Error(`Unhandled parser result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

function checkModule({ source }: { source: string }): NodeParserResult {
  const parsed = parseOnce({ source, mode: 'module', relaxedModule: false });
  switch (parsed.kind) {
  case 'ok':
    return { kind: 'ok' };
  case 'error':
    return parsed;
  default: {
    const _ex: never = parsed;
    throw new Error(`Unhandled parser result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

function checkAmbiguous({ source }: { source: string }): NodeParserResult {
  const commonJs = checkCommonJs({ source });
  switch (commonJs.kind) {
  case 'ok':
    return commonJs;
  case 'error':
    break;
  default: {
    const _ex: never = commonJs;
    throw new Error(`Unhandled parser result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }

  const relaxedModule = parseOnce({ source, mode: 'module', relaxedModule: true });
  switch (relaxedModule.kind) {
  case 'ok':
    return { kind: 'ok' };
  case 'error':
    switch (commonJs.diagnostic.reasonCode) {
    case 'ImportOutsideModule':
    case 'ImportMetaOutsideModule':
    case 'AwaitNotInAsyncContext':
      return { kind: 'error', diagnostic: relaxedModule.diagnostic };
    default:
      return commonJs;
    }
  default: {
    const _ex: never = relaxedModule;
    throw new Error(`Unhandled parser result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

export function checkNodeSyntax({ input }: { input: NodeSyntaxInput }): NodeParserResult {
  switch (input.mode) {
  case 'commonjs':
    return checkCommonJs({ source: input.source });
  case 'module':
    return checkModule({ source: input.source });
  case 'ambiguous':
    return checkAmbiguous({ source: input.source });
  default: {
    const _ex: never = input.mode;
    throw new Error(`Unhandled Node syntax mode: ${_ex}`);
  }
  }
}

export const TEST_ONLY = {
  isParseError,
  normalizeParseError,
  findPostParseCompatibilityDiagnostic,
  findCommonJsWrapperRedeclaration,
  checkAmbiguous,
};
