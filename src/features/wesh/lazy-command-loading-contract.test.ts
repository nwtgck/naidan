import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIRECTORY = path.resolve(process.cwd(), 'src/features/wesh/commands');

function parseSourceFile({ filePath }: { filePath: string }): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function getDynamicImportSpecifiers({ sourceFile }: { sourceFile: ts.SourceFile }): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function getDefinitionFilePaths(): string[] {
  return fs.readdirSync(COMMANDS_DIRECTORY, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(COMMANDS_DIRECTORY, entry.name, 'definition.ts'))
    .filter(filePath => fs.existsSync(filePath))
    .sort();
}

describe('Wesh lazy command loading source contract', () => {
  it('keeps builtin command registry imports on lightweight definition modules', () => {
    const sourceFile = parseSourceFile({
      filePath: path.join(COMMANDS_DIRECTORY, 'index.ts'),
    });
    const implementationImports = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .flatMap(statement => ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [])
      .filter(specifier => specifier.startsWith('./'));

    expect(implementationImports.length).toBeGreaterThan(0);
    expect(implementationImports.every(specifier => specifier.endsWith('/definition.ts'))).toBe(true);
  });

  it.each(getDefinitionFilePaths())(
    'keeps %s free of static implementation dependencies',
    (filePath) => {
      const sourceFile = parseSourceFile({ filePath });
      const staticValueImports = sourceFile.statements
        .filter(ts.isImportDeclaration)
        .filter(statement => statement.importClause !== undefined && !statement.importClause.isTypeOnly)
        .map(statement => ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : statement.moduleSpecifier.getText(sourceFile));

      expect(staticValueImports).toEqual([]);
      expect(new Set(getDynamicImportSpecifiers({ sourceFile }))).toEqual(new Set(['./index.ts']));
    },
  );
});
