import fs from 'node:fs';
import path from 'node:path';

import MagicString from 'magic-string';
import * as ts from 'typescript';

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

function findMessageFunction({ key, sourceFile }: { key: string; sourceFile: ts.SourceFile }): FunctionLike {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === key) {
      return statement;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== key) {
        continue;
      }
      if (declaration.initializer === undefined) {
        break;
      }
      const initializer = unwrapExpression({ expression: declaration.initializer });
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return initializer;
      }
      break;
    }
  }
  throw new Error(`[naidan-boundary-strings] Message module does not export a function named "${key}".`);
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
    const sourceFile = ts.createSourceFile(
      englishModulePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
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
  const filePath = moduleId.split('?', 1)[0] ?? moduleId;
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
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

function compactMessageCalls({ code, magicString, moduleId, sourceFile, state }: {
  code: string;
  magicString: MagicString;
  moduleId: string;
  sourceFile: ts.SourceFile;
  state: BoundaryStringsCompactionState;
}): boolean {
  if (!code.includes('__')) return false;
  let changed = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
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

function messageKeyFromModuleId({ moduleId }: { moduleId: string }): string | undefined {
  const normalizedModuleId = (moduleId.split('?', 1)[0] ?? moduleId).replaceAll('\\', '/');
  return /\/src\/strings\/messages\/([^/]+)\/(?:en|ja)\.ts$/.exec(normalizedModuleId)?.[1];
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

export function compactBoundaryStringsModule({ code, moduleId, state }: {
  code: string;
  moduleId: string;
  state: BoundaryStringsCompactionState;
}): { code: string; map: ReturnType<MagicString['generateMap']> } | undefined {
  const messageKey = messageKeyFromModuleId({ moduleId });
  // Most project modules have no Boundary Strings access. Avoid parsing them
  // after Vue and Vite transforms because this hook runs across every module.
  if (messageKey === undefined && !code.includes('__')) return undefined;
  const sourceFile = ts.createSourceFile(moduleId, code, ts.ScriptTarget.Latest, true, scriptKindForModule({ moduleId }));
  const magicString = new MagicString(code);
  const implementationChanged = messageKey === undefined
    ? false
    : compactMessageImplementation({ key: messageKey, magicString, sourceFile, state });
  const callsChanged = compactMessageCalls({ code, magicString, moduleId, sourceFile, state });
  if (!implementationChanged && !callsChanged) return undefined;
  return {
    code: magicString.toString(),
    map: magicString.generateMap({ hires: true, includeContent: true, source: moduleId }),
  };
}
