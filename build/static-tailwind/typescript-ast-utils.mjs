import path from 'node:path';
import ts from 'typescript';

export function scriptKindForFilename({ filename }) {
  switch (path.extname(filename).toLowerCase()) {
  case '.tsx': return ts.ScriptKind.TSX;
  case '.jsx': return ts.ScriptKind.JSX;
  case '.js':
  case '.mjs':
  case '.cjs': return ts.ScriptKind.JS;
  case '.json': return ts.ScriptKind.JSON;
  default: return ts.ScriptKind.TS;
  }
}

export function createTypeScriptSourceFile({ source, filename }) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFilename({ filename }),
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const details = diagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (diagnostic.start === undefined) return message;
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      return `${position.line + 1}:${position.character + 1} ${message}`;
    });
    throw new Error(`${filename}: TypeScript parse failed:\n${details.join('\n')}`);
  }
  return sourceFile;
}

export function visitTypeScriptAst({ node, visitor }) {
  visitor(node);
  ts.forEachChild(node, (child) => visitTypeScriptAst({ node: child, visitor }));
}

export function unwrapTypeScriptExpression({ node }) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isPartiallyEmittedExpression(current)
  ) current = current.expression;
  return current;
}

export function parseTypeScriptExpression({ expression, filename = 'expression.ts' }) {
  const prefix = 'const __naidanExpression = ';
  const sourceFile = createTypeScriptSourceFile({ source: `${prefix}${expression};`, filename });
  const statement = sourceFile.statements[0];
  if (!ts.isVariableStatement(statement)) throw new Error(`${filename}: expression wrapper did not parse as a variable statement.`);
  const declaration = statement.declarationList.declarations[0];
  if (declaration?.initializer === undefined) throw new Error(`${filename}: expression wrapper has no initializer.`);
  return { sourceFile, root: declaration.initializer, offset: prefix.length };
}

export function nodePosition({ sourceFile, node, blockStart = { line: 1, column: 1 } }) {
  const local = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: blockStart.line + local.line,
    column: local.line === 0 ? blockStart.column + local.character : local.character + 1,
  };
}

export function nodeRange({ sourceFile, node, offset = 0 }) {
  return {
    start: node.getStart(sourceFile) - offset,
    end: node.getEnd() - offset,
  };
}

export function staticStringValue({ node }) {
  const value = unwrapTypeScriptExpression({ node });
  if (ts.isStringLiteralLike(value)) return value.text;
  return undefined;
}

export function propertyNameText({ name, sourceFile }) {
  if (name === undefined || ts.isComputedPropertyName(name)) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

export { ts };
