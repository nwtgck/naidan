import fs from 'node:fs';
import path from 'node:path';

import MagicString from 'magic-string';
import * as ts from 'typescript';

import { messageKeyFromLocaleModuleId, stripModuleQuery } from './module-id';

const compactIdentifierCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_';

export type BoundaryStringCompaction = {
  messageId: string;
  parameterIdsByName: ReadonlyMap<string, string>;
};

export type BoundaryStringsCompactionState = {
  compactionByMessageKey: ReadonlyMap<string, BoundaryStringCompaction>;
  messageKeyByCompactedId: ReadonlyMap<string, string>;
};

type MessageLike = { key: string };
type FunctionLike = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
};

function unwrapExpression({ expression }: { expression: ts.Expression }): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression({ expression: expression.expression });
  }
  return expression;
}

function hasExportModifier({ node }: { node: ts.Node }): boolean {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function findMessageFunction({ key, sourceFile }: { key: string; sourceFile: ts.SourceFile }): FunctionLike {
  const matches: FunctionLike[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === key
      && hasExportModifier({ node: statement })
    ) {
      matches.push(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier({ node: statement })) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== key) {
        continue;
      }
      if (declaration.initializer === undefined) {
        continue;
      }
      const initializer = unwrapExpression({ expression: declaration.initializer });
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        matches.push(initializer);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `[naidan-boundary-strings] Message module must export exactly one function named "${key}".`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`[naidan-boundary-strings] Message module does not export a function named "${key}".`);
  }
  return match;
}

function staticPropertyName({ name }: { name: ts.PropertyName }): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function parameterNamesFromFunction({ key, messageFunction }: {
  key: string;
  messageFunction: FunctionLike;
}): readonly string[] {
  if (messageFunction.parameters.length === 0) {
    return [];
  }
  if (messageFunction.parameters.length !== 1) {
    throw new Error(`[naidan-boundary-strings] Message "${key}" must accept zero arguments or one object argument.`);
  }
  const parameter = messageFunction.parameters[0];
  if (parameter === undefined || !ts.isObjectBindingPattern(parameter.name)) {
    throw new Error(`[naidan-boundary-strings] Message "${key}" must destructure its object argument.`);
  }
  const names = parameter.name.elements.map((element) => {
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) {
      throw new Error(`[naidan-boundary-strings] Message "${key}" uses an unsupported parameter binding.`);
    }
    if (element.propertyName === undefined) {
      return element.name.text;
    }
    const propertyName = staticPropertyName({ name: element.propertyName });
    if (propertyName === undefined) {
      throw new Error(`[naidan-boundary-strings] Message "${key}" uses a computed parameter name.`);
    }
    return propertyName;
  });
  if (new Set(names).size !== names.length) {
    throw new Error(`[naidan-boundary-strings] Message "${key}" declares a duplicate parameter name.`);
  }
  return names;
}

export function createCompactedIdentifier({ index }: { index: number }): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`[naidan-boundary-strings] Invalid compact identifier index ${index}.`);
  }
  let value = index;
  let identifier = '';
  do {
    const character = compactIdentifierCharacters[value % compactIdentifierCharacters.length];
    if (character === undefined) {
      throw new Error(`[naidan-boundary-strings] Failed to encode compact identifier index ${index}.`);
    }
    identifier = `${character}${identifier}`;
    value = Math.floor(value / compactIdentifierCharacters.length) - 1;
  } while (value >= 0);
  return identifier;
}

export function createBoundaryStringsCompactionState({ root, messages }: {
  root: string;
  messages: readonly MessageLike[];
}): BoundaryStringsCompactionState {
  const compactionByMessageKey = new Map<string, BoundaryStringCompaction>();
  const messageKeyByCompactedId = new Map<string, string>();

  // Assign every ID from catalog order before transforms run. Transform hook
  // order can vary with parallel builds, so lazy assignment could make call
  // sites, locale packs, and runtime metadata disagree about an identifier.
  for (const [messageIndex, message] of messages.entries()) {
    const messageId = createCompactedIdentifier({ index: messageIndex });
    const englishModulePath = path.resolve(root, 'src/strings/messages', message.key, 'en.ts');
    const sourceCode = fs.readFileSync(englishModulePath, 'utf8');
    const sourceFile = parseTypeScript({
      code: sourceCode,
      moduleId: englishModulePath,
    });
    const parameterNames = parameterNamesFromFunction({
      key: message.key,
      messageFunction: findMessageFunction({ key: message.key, sourceFile }),
    });
    const parameterIdsByName = new Map(parameterNames.map((parameterName, parameterIndex) => {
      return [parameterName, createCompactedIdentifier({ index: parameterIndex })];
    }));
    if (messageKeyByCompactedId.has(messageId)) {
      throw new Error(`[naidan-boundary-strings] Duplicate compact message ID "${messageId}".`);
    }
    compactionByMessageKey.set(message.key, { messageId, parameterIdsByName });
    messageKeyByCompactedId.set(messageId, message.key);
  }
  return { compactionByMessageKey, messageKeyByCompactedId };
}

export function compactedMessageKey({ key, state }: {
  key: string;
  state: BoundaryStringsCompactionState;
}): string {
  const compaction = state.compactionByMessageKey.get(key);
  if (compaction === undefined) {
    throw new Error(`[naidan-boundary-strings] Missing compaction state for "${key}".`);
  }
  return compaction.messageId;
}

function scriptKindForModule({ moduleId }: { moduleId: string }): ts.ScriptKind {
  const filePath = stripModuleQuery({ moduleId });
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseTypeScript({ code, moduleId }: {
  code: string;
  moduleId: string;
}): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    moduleId,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForModule({ moduleId }),
  ) as SourceFileWithParseDiagnostics;
  if (sourceFile.parseDiagnostics.length > 0) {
    const details = sourceFile.parseDiagnostics.map((diagnostic) => {
      return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
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

function importedAllowedSymbols({ allowedBindingNames, checker, sourceFile }: {
  allowedBindingNames: ReadonlySet<string>;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
}): ReadonlySet<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const specifier of namedBindings.elements) {
      if (specifier.isTypeOnly || !allowedBindingNames.has(specifier.name.text)) {
        continue;
      }
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (symbol !== undefined) {
        symbols.add(symbol);
      }
    }
  }
  return symbols;
}

function unwrapReceiverExpression({ expression }: {
  expression: ts.Expression;
}): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    return unwrapReceiverExpression({ expression: expression.expression });
  }
  return expression;
}

function isAllowedBoundaryStringsReceiver({
  allowedBindingNames,
  checker,
  expression,
  importedSymbols,
  moduleId,
}: {
  allowedBindingNames: ReadonlySet<string>;
  checker: ts.TypeChecker;
  expression: ts.Expression;
  importedSymbols: ReadonlySet<ts.Symbol>;
  moduleId: string;
}): boolean {
  const receiver = unwrapReceiverExpression({ expression });
  if (ts.isIdentifier(receiver)) {
    const symbol = checker.getSymbolAtLocation(receiver);
    return symbol !== undefined && importedSymbols.has(symbol);
  }

  // Vue compiler output exposes setup bindings through generated context
  // objects or unref helpers. Restrict these shapes to transformed SFC modules
  // so user-authored objects with the same property names are never compacted.
  if (!stripModuleQuery({ moduleId }).endsWith('.vue')) {
    return false;
  }
  if (ts.isPropertyAccessExpression(receiver)) {
    return allowedBindingNames.has(receiver.name.text)
      && ts.isIdentifier(receiver.expression)
      && ['$setup', '_ctx', '__returned__'].includes(receiver.expression.text);
  }
  if (ts.isElementAccessExpression(receiver)) {
    return receiver.argumentExpression !== undefined
      && ts.isStringLiteral(receiver.argumentExpression)
      && allowedBindingNames.has(receiver.argumentExpression.text)
      && ts.isIdentifier(receiver.expression)
      && ['$setup', '_ctx', '__returned__'].includes(receiver.expression.text);
  }
  if (
    ts.isCallExpression(receiver)
    && ts.isIdentifier(receiver.expression)
    && ['_unref', 'unref'].includes(receiver.expression.text)
    && receiver.arguments.length === 1
  ) {
    const argument = receiver.arguments[0];
    if (argument === undefined) {
      return false;
    }
    const unwrappedArgument = unwrapReceiverExpression({ expression: argument });
    return ts.isIdentifier(unwrappedArgument) && allowedBindingNames.has(unwrappedArgument.text);
  }
  return false;
}

function compactCallArgument({ argument, compaction, key, magicString, sourceFile }: {
  argument: ts.Expression | undefined;
  compaction: BoundaryStringCompaction;
  key: string;
  magicString: MagicString;
  sourceFile: ts.SourceFile;
}): void {
  if (compaction.parameterIdsByName.size === 0) {
    if (argument !== undefined) {
      throw new Error(`[naidan-boundary-strings] Message "${key}" does not accept an argument.`);
    }
    return;
  }

  // A direct object literal lets the build rewrite the public named-argument
  // contract locally. Supporting variables or spreads would require data-flow
  // analysis or a runtime map that would cancel the size reduction.
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    throw new Error(
      `[naidan-boundary-strings] Message "${key}" must be called with one direct object literal so production parameter keys can be compacted.`,
    );
  }
  const seenParameters = new Set<string>();
  for (const property of argument.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      const parameterName = property.name.text;
      const parameterId = compaction.parameterIdsByName.get(parameterName);
      if (parameterId === undefined) {
        throw new Error(`[naidan-boundary-strings] Unknown parameter "${parameterName}" for message "${key}".`);
      }
      magicString.prependLeft(property.name.getStart(sourceFile), `${parameterId}: `);
      seenParameters.add(parameterName);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const parameterName = staticPropertyName({ name: property.name });
      if (parameterName === undefined) {
        throw new Error(`[naidan-boundary-strings] Message "${key}" uses a computed argument property.`);
      }
      const parameterId = compaction.parameterIdsByName.get(parameterName);
      if (parameterId === undefined) {
        throw new Error(`[naidan-boundary-strings] Unknown parameter "${parameterName}" for message "${key}".`);
      }
      magicString.overwrite(property.name.getStart(sourceFile), property.name.getEnd(), parameterId);
      seenParameters.add(parameterName);
      continue;
    }
    throw new Error(
      `[naidan-boundary-strings] Message "${key}" arguments cannot use spread, methods, getters, or setters.`,
    );
  }
  for (const parameterName of compaction.parameterIdsByName.keys()) {
    if (!seenParameters.has(parameterName)) {
      throw new Error(`[naidan-boundary-strings] Missing parameter "${parameterName}" for message "${key}".`);
    }
  }
}

function compactMessageCalls({ allowedBindingNames, code, magicString, moduleId, sourceFile, state }: {
  allowedBindingNames: ReadonlySet<string>;
  code: string;
  magicString: MagicString;
  moduleId: string;
  sourceFile: ts.SourceFile;
  state: BoundaryStringsCompactionState;
}): boolean {
  if (!code.includes('__') || allowedBindingNames.size === 0) return false;
  const checker = createTypeChecker({ moduleId, sourceCode: code, sourceFile });
  const importedSymbols = importedAllowedSymbols({ allowedBindingNames, checker, sourceFile });
  let changed = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && isAllowedBoundaryStringsReceiver({
        allowedBindingNames,
        checker,
        expression: node.expression.expression,
        importedSymbols,
        moduleId,
      })
    ) {
      const key = node.expression.name.text;
      const compaction = state.compactionByMessageKey.get(key);
      if (compaction !== undefined) {
        if (node.arguments.length > 1) {
          throw new Error(`[naidan-boundary-strings] Message "${key}" received multiple arguments in ${moduleId}.`);
        }
        magicString.overwrite(node.expression.name.getStart(sourceFile), node.expression.name.getEnd(), compaction.messageId);
        compactCallArgument({ argument: node.arguments[0], compaction, key, magicString, sourceFile });
        changed = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return changed;
}

function compactMessageImplementation({ key, magicString, sourceFile, state }: {
  key: string;
  magicString: MagicString;
  sourceFile: ts.SourceFile;
  state: BoundaryStringsCompactionState;
}): boolean {
  const compaction = state.compactionByMessageKey.get(key);
  if (compaction === undefined) return false;
  const messageFunction = findMessageFunction({ key, sourceFile });
  if (messageFunction.parameters.length === 0) {
    if (compaction.parameterIdsByName.size !== 0) {
      throw new Error(`[naidan-boundary-strings] Message "${key}" lost its object parameter.`);
    }
    return false;
  }
  const parameter = messageFunction.parameters[0];
  if (parameter === undefined || !ts.isObjectBindingPattern(parameter.name)) {
    throw new Error(`[naidan-boundary-strings] Message "${key}" must destructure its object argument.`);
  }
  const seenParameters = new Set<string>();
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) {
      throw new Error(`[naidan-boundary-strings] Message "${key}" uses an unsupported parameter binding.`);
    }
    const parameterName = element.propertyName === undefined ? element.name.text : staticPropertyName({ name: element.propertyName });
    if (parameterName === undefined) {
      throw new Error(`[naidan-boundary-strings] Message "${key}" uses a computed parameter name.`);
    }
    const parameterId = compaction.parameterIdsByName.get(parameterName);
    if (parameterId === undefined) {
      throw new Error(`[naidan-boundary-strings] Unknown implementation parameter "${parameterName}" for message "${key}".`);
    }
    if (element.propertyName === undefined) {
      magicString.prependLeft(element.name.getStart(sourceFile), `${parameterId}: `);
    } else {
      magicString.overwrite(element.propertyName.getStart(sourceFile), element.propertyName.getEnd(), parameterId);
    }
    seenParameters.add(parameterName);
  }
  for (const parameterName of compaction.parameterIdsByName.keys()) {
    if (!seenParameters.has(parameterName)) {
      throw new Error(`[naidan-boundary-strings] Locale implementation for "${key}" is missing parameter "${parameterName}".`);
    }
  }
  if (parameter.type !== undefined && ts.isTypeLiteralNode(parameter.type)) {
    for (const member of parameter.type.members) {
      if (!ts.isPropertySignature(member) || member.name === undefined) continue;
      const parameterName = staticPropertyName({ name: member.name });
      const parameterId = parameterName === undefined ? undefined : compaction.parameterIdsByName.get(parameterName);
      if (parameterId !== undefined) {
        magicString.overwrite(member.name.getStart(sourceFile), member.name.getEnd(), parameterId);
      }
    }
  }
  return true;
}

export function compactBoundaryStringsModule({ allowedBindingNames, code, moduleId, state }: {
  allowedBindingNames: readonly string[];
  code: string;
  moduleId: string;
  state: BoundaryStringsCompactionState;
}): { code: string; map: ReturnType<MagicString['generateMap']> } | undefined {
  const messageKey = messageKeyFromLocaleModuleId({ moduleId });
  if (messageKey === undefined && allowedBindingNames.length === 0) return undefined;
  const sourceFile = parseTypeScript({ code, moduleId });
  const magicString = new MagicString(code);
  const implementationChanged = messageKey === undefined
    ? false
    : compactMessageImplementation({ key: messageKey, magicString, sourceFile, state });
  const callsChanged = compactMessageCalls({
    allowedBindingNames: new Set(allowedBindingNames),
    code,
    magicString,
    moduleId,
    sourceFile,
    state,
  });
  if (!implementationChanged && !callsChanged) return undefined;
  return {
    code: magicString.toString(),
    map: magicString.generateMap({ hires: true, includeContent: true, source: moduleId }),
  };
}
