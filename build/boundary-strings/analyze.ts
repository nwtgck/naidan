import crypto from 'node:crypto';
import path from 'node:path';

import {
  compileScript,
  compileTemplate,
  parse as parseSfc,
  type SFCDescriptor,
} from '@vue/compiler-sfc';
import * as ts from 'typescript';

import { stripModuleQuery } from './module-id';

const supportedBindings = new Set(['lazyStrings', 'ensureStrings']);
const generatedTemplateContexts = new Set(['$setup', '_ctx', '__returned__']);

type ScriptAnalysis = {
  importedBindingNames: ReadonlySet<string>;
  keys: ReadonlySet<string>;
};

export type BoundaryStringSourceAnalysis = {
  importedBindingNames: readonly string[];
  keys: readonly string[];
};

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
};

function scriptKindForModule({ lang, moduleId }: {
  lang: string | undefined;
  moduleId: string;
}): ts.ScriptKind {
  switch (lang) {
  case 'js':
    return ts.ScriptKind.JS;
  case 'jsx':
    return ts.ScriptKind.JSX;
  case 'tsx':
    return ts.ScriptKind.TSX;
  case 'ts':
  case undefined:
    break;
  default:
    throw new Error(`[naidan-boundary-strings] Unsupported script language "${lang}" in ${moduleId}.`);
  }

  const filePath = stripModuleQuery({ moduleId });
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function formatDiagnostic({ diagnostic }: {
  diagnostic: ts.Diagnostic;
}): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function parseTypeScript({ moduleId, scriptKind, sourceCode }: {
  moduleId: string;
  scriptKind: ts.ScriptKind;
  sourceCode: string;
}): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    moduleId,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  ) as SourceFileWithParseDiagnostics;
  if (sourceFile.parseDiagnostics.length > 0) {
    const details = sourceFile.parseDiagnostics.map((diagnostic) => {
      return formatDiagnostic({ diagnostic });
    }).join('\n');
    throw new Error(`[naidan-boundary-strings] Failed to parse ${moduleId}:\n${details}`);
  }
  return sourceFile;
}

function createTypeChecker({ moduleId, sourceCode, sourceFile }: {
  moduleId: string;
  sourceCode: string;
  sourceFile: ts.SourceFile;
}): ts.TypeChecker {
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host: ts.CompilerHost = {
    fileExists(fileName) {
      return fileName === moduleId;
    },
    getCanonicalFileName(fileName) {
      return fileName;
    },
    getCurrentDirectory() {
      return '/';
    },
    getDefaultLibFileName() {
      return '';
    },
    getDirectories() {
      return [];
    },
    getNewLine() {
      return '\n';
    },
    getSourceFile(fileName) {
      return fileName === moduleId ? sourceFile : undefined;
    },
    readFile(fileName) {
      return fileName === moduleId ? sourceCode : undefined;
    },
    useCaseSensitiveFileNames() {
      return true;
    },
    writeFile() {
    },
  };
  return ts.createProgram([moduleId], compilerOptions, host).getTypeChecker();
}

function unwrapParentExpression({ expression }: {
  expression: ts.Expression;
}): ts.Expression {
  let current = expression;
  while (true) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent)
        || ts.isAsExpression(parent)
        || ts.isTypeAssertionExpression(parent)
        || ts.isNonNullExpression(parent)
        || ts.isSatisfiesExpression(parent))
      && parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

function messageCallFromBindingReference({ identifier }: {
  identifier: ts.Identifier;
}): { call: ts.CallExpression; key: string } | undefined {
  const receiver = unwrapParentExpression({ expression: identifier });
  const propertyAccess = receiver.parent;
  if (!ts.isPropertyAccessExpression(propertyAccess) || propertyAccess.expression !== receiver) {
    return undefined;
  }
  const callee = unwrapParentExpression({ expression: propertyAccess });
  const call = callee.parent;
  if (!ts.isCallExpression(call) || call.expression !== callee) {
    return undefined;
  }
  return {
    call,
    key: propertyAccess.name.text,
  };
}

function importedBoundaryStringSymbols({ checker, sourceFile }: {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
}): ReadonlyMap<ts.Symbol, string> {
  const symbols = new Map<ts.Symbol, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '@/strings'
      || statement.importClause?.isTypeOnly === true
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const specifier of namedBindings.elements) {
      if (specifier.isTypeOnly) {
        continue;
      }
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (!supportedBindings.has(importedName)) {
        continue;
      }
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (symbol === undefined) {
        throw new Error(
          `[naidan-boundary-strings] Failed to resolve imported binding "${specifier.name.text}".`,
        );
      }
      symbols.set(symbol, specifier.name.text);
    }
  }
  return symbols;
}

function isBoundaryStringsInternalModule({ moduleId }: {
  moduleId: string;
}): boolean {
  const normalizedModuleId = stripModuleQuery({ moduleId }).replaceAll('\\', '/');
  return normalizedModuleId.includes('/src/strings/');
}

function isDirectLocaleModuleSpecifier({ moduleId, moduleSpecifier }: {
  moduleId: string;
  moduleSpecifier: string;
}): boolean {
  const withoutQuery = moduleSpecifier.split(/[?#]/u, 1)[0] ?? moduleSpecifier;
  const normalizedSpecifier = path.posix.normalize(withoutQuery.replaceAll('\\', '/'));
  if (
    normalizedSpecifier.startsWith('@/strings/messages/')
    || normalizedSpecifier.startsWith('@/strings/catalogs/')
    || normalizedSpecifier.startsWith('/src/strings/messages/')
    || normalizedSpecifier.startsWith('/src/strings/catalogs/')
  ) {
    return true;
  }
  if (!normalizedSpecifier.startsWith('.')) {
    return false;
  }

  const resolvedPath = path.resolve(
    path.dirname(stripModuleQuery({ moduleId })),
    normalizedSpecifier,
  ).replaceAll('\\', '/');
  return resolvedPath.includes('/src/strings/messages/')
    || resolvedPath.includes('/src/strings/catalogs/');
}

function validateNoDirectLocaleImports({ moduleId, sourceFile }: {
  moduleId: string;
  sourceFile: ts.SourceFile;
}): void {
  if (isBoundaryStringsInternalModule({ moduleId })) {
    return;
  }

  function reject({ moduleSpecifier }: { moduleSpecifier: string }): never {
    throw new Error(
      `[naidan-boundary-strings] ${moduleId} imports ${moduleSpecifier} directly. `
      + 'Application code must access messages through @/strings.',
    );
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
      && isDirectLocaleModuleSpecifier({
        moduleId,
        moduleSpecifier: node.moduleSpecifier.text,
      })
    ) {
      reject({ moduleSpecifier: node.moduleSpecifier.text });
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (
        argument !== undefined
        && ts.isStringLiteralLike(argument)
        && isDirectLocaleModuleSpecifier({ moduleId, moduleSpecifier: argument.text })
      ) {
        reject({ moduleSpecifier: argument.text });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function analyzeScript({ lang, moduleId, sourceCode }: {
  lang: string | undefined;
  moduleId: string;
  sourceCode: string;
}): ScriptAnalysis {
  const sourceFile = parseTypeScript({
    moduleId,
    scriptKind: scriptKindForModule({ lang, moduleId }),
    sourceCode,
  });
  validateNoDirectLocaleImports({ moduleId, sourceFile });
  const checker = createTypeChecker({ moduleId, sourceCode, sourceFile });
  const importedSymbols = importedBoundaryStringSymbols({ checker, sourceFile });
  const importedBindingNames = new Set(importedSymbols.values());
  const keys = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node)
      && !ts.isImportSpecifier(node.parent)
    ) {
      const symbol = checker.getSymbolAtLocation(node);
      const bindingName = symbol === undefined ? undefined : importedSymbols.get(symbol);
      if (bindingName !== undefined) {
        const access = messageCallFromBindingReference({ identifier: node });
        if (access === undefined) {
          throw new Error(
            `[naidan-boundary-strings] ${bindingName} must be used as ${bindingName}.<message_key>(...).`,
          );
        }
        keys.add(access.key);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return {
    importedBindingNames,
    keys,
  };
}

function isGeneratedAccessorReceiver({ allowedBindingNames, expression }: {
  allowedBindingNames: ReadonlySet<string>;
  expression: ts.Expression;
}): boolean {
  const receiver = expression;
  if (ts.isPropertyAccessExpression(receiver)) {
    return allowedBindingNames.has(receiver.name.text)
      && ts.isIdentifier(receiver.expression)
      && generatedTemplateContexts.has(receiver.expression.text);
  }
  if (ts.isElementAccessExpression(receiver)) {
    return receiver.argumentExpression !== undefined
      && ts.isStringLiteral(receiver.argumentExpression)
      && allowedBindingNames.has(receiver.argumentExpression.text)
      && ts.isIdentifier(receiver.expression)
      && generatedTemplateContexts.has(receiver.expression.text);
  }
  if (
    ts.isCallExpression(receiver)
    && ts.isIdentifier(receiver.expression)
    && ['_unref', 'unref'].includes(receiver.expression.text)
    && receiver.arguments.length === 1
  ) {
    const argument = receiver.arguments[0];
    return argument !== undefined
      && ts.isIdentifier(argument)
      && allowedBindingNames.has(argument.text);
  }
  return false;
}

function collectGeneratedTemplateKeys({ allowedBindingNames, moduleId, sourceCode }: {
  allowedBindingNames: ReadonlySet<string>;
  moduleId: string;
  sourceCode: string;
}): ReadonlySet<string> {
  const sourceFile = parseTypeScript({
    moduleId,
    scriptKind: ts.ScriptKind.TS,
    sourceCode,
  });
  const keys = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && isGeneratedAccessorReceiver({
        allowedBindingNames,
        expression: node.expression.expression,
      })
    ) {
      keys.add(node.expression.name.text);
    }
    if (
      ts.isCallExpression(node)
      && ts.isElementAccessExpression(node.expression)
      && isGeneratedAccessorReceiver({
        allowedBindingNames,
        expression: node.expression.expression,
      })
    ) {
      throw new Error(
        `[naidan-boundary-strings] Generated Vue template in ${moduleId} uses a dynamic Boundary Strings key.`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return keys;
}

function formatVueError({ error }: {
  error: Error | string;
}): string {
  return typeof error === 'string' ? error : error.message;
}

function compileVueTemplate({ descriptor, moduleId }: {
  descriptor: SFCDescriptor;
  moduleId: string;
}): string | undefined {
  const template = descriptor.template;
  if (template === null) {
    return undefined;
  }
  const id = crypto.createHash('sha256').update(moduleId).digest('hex').slice(0, 8);
  const bindings = descriptor.script === null && descriptor.scriptSetup === null
    ? undefined
    : compileScript(descriptor, { id }).bindings;
  const result = compileTemplate({
    compilerOptions: {
      bindingMetadata: bindings,
      expressionPlugins: ['typescript'],
    },
    filename: moduleId,
    id,
    source: template.content,
  });
  if (result.errors.length > 0) {
    throw new Error(
      `[naidan-boundary-strings] Failed to compile the template in ${moduleId}:\n${result.errors.map((error) => {
        return formatVueError({ error });
      }).join('\n')}`,
    );
  }
  return result.code;
}

function analyzeVueSfc({ moduleId, sourceCode }: {
  moduleId: string;
  sourceCode: string;
}): BoundaryStringSourceAnalysis {
  const parsed = parseSfc(sourceCode, { filename: moduleId });
  if (parsed.errors.length > 0) {
    throw new Error(
      `[naidan-boundary-strings] Failed to parse ${moduleId}:\n${parsed.errors.map((error) => {
        return formatVueError({ error });
      }).join('\n')}`,
    );
  }

  const keys = new Set<string>();
  const importedBindingNames = new Set<string>();
  for (const [blockName, block] of [
    ['script', parsed.descriptor.script],
    ['script setup', parsed.descriptor.scriptSetup],
  ] as const) {
    if (block === null) {
      continue;
    }
    const scriptExtension = block.lang === 'js' || block.lang === 'jsx' || block.lang === 'tsx'
      ? block.lang
      : 'ts';
    const analysis = analyzeScript({
      lang: block.lang,
      moduleId: `${moduleId}.${blockName.replaceAll(' ', '-')}.${scriptExtension}`,
      sourceCode: block.content,
    });
    for (const key of analysis.keys) {
      keys.add(key);
    }
    for (const bindingName of analysis.importedBindingNames) {
      importedBindingNames.add(bindingName);
    }
  }

  if (importedBindingNames.size > 0) {
    const compiledTemplate = compileVueTemplate({
      descriptor: parsed.descriptor,
      moduleId,
    });
    if (compiledTemplate !== undefined) {
      for (const key of collectGeneratedTemplateKeys({
        allowedBindingNames: importedBindingNames,
        moduleId: `${moduleId} <compiled template>`,
        sourceCode: compiledTemplate,
      })) {
        keys.add(key);
      }
    }
  }

  return {
    importedBindingNames: [...importedBindingNames].sort(),
    keys: [...keys].sort(),
  };
}

export function analyzeBoundaryStringSource({ moduleId, sourceCode }: {
  moduleId: string;
  sourceCode: string;
}): BoundaryStringSourceAnalysis {
  if (stripModuleQuery({ moduleId }).endsWith('.vue')) {
    return analyzeVueSfc({ moduleId, sourceCode });
  }
  const analysis = analyzeScript({
    lang: undefined,
    moduleId,
    sourceCode,
  });
  return {
    importedBindingNames: [...analysis.importedBindingNames].sort(),
    keys: [...analysis.keys].sort(),
  };
}

export function collectBoundaryStringKeys({ moduleId, sourceCode }: {
  moduleId: string;
  sourceCode: string;
}): readonly string[] {
  return analyzeBoundaryStringSource({ moduleId, sourceCode }).keys;
}
