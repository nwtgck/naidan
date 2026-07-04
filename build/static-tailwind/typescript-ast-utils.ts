import path from 'node:path';

import ts from 'typescript';

export type SourcePosition = {
  line: number;
  column: number;
};

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
};

export function scriptKindForFilename({ filename }: {
  filename: string;
}): ts.ScriptKind {
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

export function createTypeScriptSourceFile({ source, filename }: {
  source: string;
  filename: string;
}): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFilename({ filename }),
  ) as SourceFileWithParseDiagnostics;
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const details = parseDiagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (diagnostic.start === undefined) return message;
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      return `${position.line + 1}:${position.character + 1} ${message}`;
    });
    throw new Error(`${filename}: TypeScript parse failed:\n${details.join('\n')}`);
  }
  return sourceFile;
}

export function createTypeScriptTypeChecker({ sourceFile }: {
  sourceFile: ts.SourceFile;
}): ts.TypeChecker {
  const fileName = sourceFile.fileName;
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host: ts.CompilerHost = {
    fileExists(candidate) {
      return candidate === fileName;
    },
    getCanonicalFileName(candidate) {
      return candidate;
    },
    getCurrentDirectory() {
      return path.dirname(path.resolve(fileName));
    },
    getDefaultLibFileName() {
      return 'lib.d.ts';
    },
    getDirectories() {
      return [];
    },
    getNewLine() {
      return '\n';
    },
    getSourceFile(candidate) {
      return candidate === fileName ? sourceFile : undefined;
    },
    readFile(candidate) {
      return candidate === fileName ? sourceFile.text : undefined;
    },
    useCaseSensitiveFileNames() {
      return true;
    },
    writeFile() {},
  };
  return ts.createProgram({
    rootNames: [fileName],
    options: compilerOptions,
    host,
  }).getTypeChecker();
}

export function visitTypeScriptAst({ node, visitor }: {
  node: ts.Node;
  visitor: (node: ts.Node) => void;
}): void {
  visitor(node);
  ts.forEachChild(node, (child) => visitTypeScriptAst({ node: child, visitor }));
}

export function unwrapTypeScriptExpression({ node }: {
  node: ts.Expression;
}): ts.Expression {
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

export function parseTypeScriptExpression({ expression, filename }: {
  expression: string;
  filename: string;
}): {
  sourceFile: ts.SourceFile;
  root: ts.Expression;
  offset: number;
} {
  const prefix = 'const __naidanExpression = ';
  const sourceFile = createTypeScriptSourceFile({ source: `${prefix}${expression};`, filename });
  const statement = sourceFile.statements[0];
  if (!ts.isVariableStatement(statement)) {
    throw new Error(`${filename}: expression wrapper did not parse as a variable statement.`);
  }
  const declaration = statement.declarationList.declarations[0];
  if (declaration?.initializer === undefined) {
    throw new Error(`${filename}: expression wrapper has no initializer.`);
  }
  return { sourceFile, root: declaration.initializer, offset: prefix.length };
}

export function nodePosition({ sourceFile, node, blockStart }: {
  sourceFile: ts.SourceFile;
  node: ts.Node;
  blockStart: SourcePosition;
}): SourcePosition {
  const local = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: blockStart.line + local.line,
    column: local.line === 0 ? blockStart.column + local.character : local.character + 1,
  };
}

export function nodeRange({ sourceFile, node, offset }: {
  sourceFile: ts.SourceFile;
  node: ts.Node;
  offset: number;
}): {
  start: number;
  end: number;
} {
  return {
    start: node.getStart(sourceFile) - offset,
    end: node.getEnd() - offset,
  };
}

export function staticStringValue({ node }: {
  node: ts.Expression;
}): string | undefined {
  const value = unwrapTypeScriptExpression({ node });
  if (ts.isStringLiteralLike(value)) return value.text;
  return undefined;
}

export function propertyNameText({ name, sourceFile }: {
  name: ts.PropertyName | undefined;
  sourceFile: ts.SourceFile;
}): string | undefined {
  if (name === undefined || ts.isComputedPropertyName(name)) return undefined;
  if (
    ts.isIdentifier(name)
    || ts.isPrivateIdentifier(name)
    || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name)
  ) return name.text;
  return name.getText(sourceFile);
}

export { ts };
