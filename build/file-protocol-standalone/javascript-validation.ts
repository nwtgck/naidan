import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  parseSync,
  Visitor,
  type ESTree,
} from 'vite';

const pluginName = 'file-protocol-standalone';

function computeSha256Hex({ source }: { source: string | Uint8Array }): string {
  return createHash('sha256').update(source).digest('hex');
}

function isWindowsAbsolutePath({ value }: { value: string }): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

/** @internal Exported for focused plugin tests. */
export function debugSanitizeFileProtocolStandaloneModuleId({ root, moduleId }: {
  root: string,
  moduleId: string,
}): string {
  if (moduleId.startsWith('\0')) {
    return moduleId.slice(1);
  }

  const normalized = moduleId.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  const windowsPath = isWindowsAbsolutePath({ value: moduleId });
  const windowsRoot = isWindowsAbsolutePath({ value: root });
  const comparableModuleId = windowsPath ? normalized.toLowerCase() : normalized;
  const comparableRoot = windowsRoot ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (
    windowsPath === windowsRoot
    && comparableModuleId.startsWith(`${comparableRoot}/`)
  ) {
    return `/${normalized.slice(normalizedRoot.length + 1)}`;
  }
  if (normalized.includes('/node_modules/')) {
    return `/node_modules/${normalized.split('/node_modules/')[1]}`;
  }
  if (path.posix.isAbsolute(normalized) || windowsPath) {
    // Root-external modules are legitimate in monorepos, but exposing the host
    // filesystem path makes diagnostic reports machine-specific and may leak a
    // developer's home directory. Keep a deterministic, useful basename while
    // replacing the private prefix with a short digest.
    return `/outside-root/${computeSha256Hex({ source: normalized }).slice(0, 12)}-${path.posix.basename(normalized)}`;
  }
  return normalized;
}


type FileProtocolStandaloneScriptRole = 'application-chunk' | 'support-script' | 'worker';

type IdentifierCandidateNode = ESTree.Expression | ESTree.IdentifierName | ESTree.PrivateIdentifier;

type IdentifierNode = Extract<IdentifierCandidateNode, { readonly type: 'Identifier' }>;

type MemberExpressionNode = Extract<ESTree.Expression, { readonly type: 'MemberExpression' }>;

type NewExpressionNode = Extract<ESTree.Expression, { readonly type: 'NewExpression' }>;

type StringLiteralNode = Extract<ESTree.Expression, {
  readonly type: 'Literal',
  readonly value: string,
}>;

type TemplateLiteralNode = Extract<ESTree.Expression, { readonly type: 'TemplateLiteral' }>;

export type FileProtocolStandaloneRuntimeDynamicImportOccurrence = Readonly<{
  kind: 'static-specifier' | 'dynamic-specifier',
  line: number,
  column: number,
  specifier: string | undefined,
}>;

type FileProtocolStandaloneScriptValidation = Readonly<{
  runtimeDynamicImports: readonly FileProtocolStandaloneRuntimeDynamicImportOccurrence[],
  systemRegisterCallCount: number,
  hostedWorkerUrlCount: number,
}>;

function isIdentifierNode(node: IdentifierCandidateNode | undefined): node is IdentifierNode {
  return node?.type === 'Identifier';
}

function isMemberExpressionNode(node: ESTree.Expression): node is MemberExpressionNode {
  return node.type === 'MemberExpression';
}

function isNewExpressionNode(node: ESTree.Argument | undefined): node is NewExpressionNode {
  return node?.type === 'NewExpression';
}

function isStringLiteralNode(node: ESTree.Expression): node is StringLiteralNode {
  return node.type === 'Literal' && typeof node.value === 'string';
}

function isTemplateLiteralNode(node: ESTree.Expression): node is TemplateLiteralNode {
  return node.type === 'TemplateLiteral';
}

function isIdentifierNamed({ node, name }: {
  node: IdentifierCandidateNode | undefined,
  name: string,
}): boolean {
  return isIdentifierNode(node) && node.name === name;
}

function isSystemRegisterCall({ node }: { node: ESTree.CallExpression }): boolean {
  const { callee } = node;
  if (!isMemberExpressionNode(callee)) {
    return false;
  }
  if (!isIdentifierNamed({ node: callee.object, name: 'System' })) {
    return false;
  }
  if (callee.computed) {
    return isStringLiteralNode(callee.property) && callee.property.value === 'register';
  }
  return isIdentifierNamed({ node: callee.property, name: 'register' });
}

function isHostedWorkerUrl({ node }: { node: ESTree.NewExpression }): boolean {
  if (!isIdentifierNamed({ node: node.callee, name: 'Worker' })) {
    return false;
  }
  const workerSource = node.arguments[0];
  return isNewExpressionNode(workerSource)
    && isIdentifierNamed({ node: workerSource.callee, name: 'URL' });
}

function readStaticallyKnownImportSpecifier({ node }: {
  node: ESTree.ImportExpression,
}): string | undefined {
  const { source } = node;
  if (isStringLiteralNode(source)) {
    return source.value;
  }
  if (isTemplateLiteralNode(source) && source.expressions.length === 0) {
    return source.quasis[0]?.value.cooked ?? source.quasis[0]?.value.raw;
  }
  return undefined;
}

function createLineStartOffsets({ source }: { source: string }): readonly number[] {
  const lineStartOffsets = [0];
  // Preserve Acorn's previous `locations: true` behavior for every
  // ECMAScript line terminator, with CRLF treated as one line break.
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit === 0x0D) {
      if (source.charCodeAt(index + 1) === 0x0A) {
        index += 1;
      }
      lineStartOffsets.push(index + 1);
      continue;
    }
    if (codeUnit === 0x0A || codeUnit === 0x2028 || codeUnit === 0x2029) {
      lineStartOffsets.push(index + 1);
    }
  }
  return lineStartOffsets;
}

function resolveSourcePosition({ lineStartOffsets, offset }: {
  lineStartOffsets: readonly number[],
  offset: number,
}): {
  line: number,
  column: number,
} {
  let lowerBound = 0;
  let upperBound = lineStartOffsets.length;
  while (lowerBound + 1 < upperBound) {
    const middle = Math.floor((lowerBound + upperBound) / 2);
    if ((lineStartOffsets[middle] ?? 0) <= offset) {
      lowerBound = middle;
    } else {
      upperBound = middle;
    }
  }
  return {
    line: lowerBound + 1,
    column: offset - (lineStartOffsets[lowerBound] ?? 0),
  };
}

/** @internal Exported for focused plugin tests. */
export function assertFileProtocolStandaloneClassicScript({
  source,
  label,
  mode,
}: {
  source: string,
  label: string,
  mode: FileProtocolStandaloneScriptRole,
}): FileProtocolStandaloneScriptValidation {
  const parseResult = parseSync(label, source, {
    lang: 'js',
    sourceType: 'script',
    preserveParens: false,
    showSemanticErrors: true,
  });
  const firstParseError = parseResult.errors[0];
  if (firstParseError !== undefined) {
    throw new SyntaxError(firstParseError.codeframe ?? firstParseError.message);
  }

  const lineStartOffsets = createLineStartOffsets({ source });
  const runtimeDynamicImports: FileProtocolStandaloneRuntimeDynamicImportOccurrence[] = [];
  let systemRegisterCallCount = 0;
  let hostedWorkerUrlCount = 0;

  new Visitor({
    CallExpression(node) {
      if (isSystemRegisterCall({ node })) {
        systemRegisterCallCount += 1;
      }
    },
    NewExpression(node) {
      if (isHostedWorkerUrl({ node })) {
        hostedWorkerUrlCount += 1;
      }
    },
    ImportExpression(node) {
      const specifier = readStaticallyKnownImportSpecifier({ node });
      const position = resolveSourcePosition({
        lineStartOffsets,
        offset: node.start,
      });
      runtimeDynamicImports.push({
        kind: specifier === undefined ? 'dynamic-specifier' : 'static-specifier',
        line: position.line,
        column: position.column,
        specifier,
      });
    },
  }).visit(parseResult.program);

  const modeValidation = (() => {
    switch (mode) {
    case 'application-chunk':
      return {
        rejectedRuntimeImports: runtimeDynamicImports,
        requireSystemRegister: true,
      } as const;
    case 'support-script':
      return {
        rejectedRuntimeImports: runtimeDynamicImports,
        requireSystemRegister: false,
      } as const;
    case 'worker':
      return {
        rejectedRuntimeImports: runtimeDynamicImports.filter((item) => item.kind === 'static-specifier'),
        requireSystemRegister: false,
      } as const;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled JavaScript validation mode: ${_ex}`);
    }
    }
  })();
  const reasons = [
    modeValidation.rejectedRuntimeImports.length > 0
      ? `${modeValidation.rejectedRuntimeImports.length} unsupported runtime import expression(s) remain`
      : undefined,
    modeValidation.requireSystemRegister && systemRegisterCallCount === 0
      ? 'System.register(...) is missing'
      : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  if (reasons.length > 0) {
    throw new Error(`[${pluginName}] ${label} is not valid standalone classic JavaScript: ${reasons.join(', ')}.`);
  }

  return { runtimeDynamicImports, systemRegisterCallCount, hostedWorkerUrlCount };
}
