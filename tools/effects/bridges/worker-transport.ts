import path from 'node:path';
import ts from 'typescript';

export type WorkerTransportModel = {
  file: string,
  sha256: string,
  wrapExport: string,
  exposeExport: string,
};

function builtinIdentifier({ expression, name, checker, program, seen }: {
  expression: ts.Expression, name: string, checker: ts.TypeChecker, program: ts.Program, seen: Set<ts.Symbol>,
}): boolean {
  if (!ts.isIdentifier(expression)) return false;
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined || seen.has(symbol)) return false;
  seen.add(symbol);
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol.declarations ?? [];
  if (symbol.name === name && declarations.length > 0 && declarations.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return true;
  const declaration = symbol.valueDeclaration;
  if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
    && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
    return builtinIdentifier({ expression: declaration.initializer, name, checker, program, seen });
  }
  return false;
}

/** Match code structure and builtin identity; method names and generic types are not connection evidence. */
export function literalWorkerEntry({ node, program }: { node: ts.NewExpression, program: ts.Program }): string | undefined {
  const checker = program.getTypeChecker();
  if (!builtinIdentifier({ expression: node.expression, name: 'Worker', checker, program, seen: new Set() })) return undefined;
  const url = node.arguments?.[0];
  if (url === undefined || !ts.isNewExpression(url) || !builtinIdentifier({ expression: url.expression, name: 'URL', checker, program, seen: new Set() })) return undefined;
  const [specifier, base] = url.arguments ?? [];
  if (specifier === undefined || !ts.isStringLiteral(specifier) || base === undefined || !ts.isPropertyAccessExpression(base)
    || base.name.text !== 'url' || !ts.isMetaProperty(base.expression) || base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword || base.expression.name.text !== 'meta') return undefined;
  if (!specifier.text.startsWith('./') && !specifier.text.startsWith('../')) return undefined;
  if (specifier.text.includes('?') || specifier.text.includes('#')) return undefined;
  return path.resolve(path.dirname(node.getSourceFile().fileName), specifier.text);
}

export function discoverWorkerEntries({ program }: { program: ts.Program }): string[] {
  const files = new Set<string>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || program.isSourceFileFromExternalLibrary(source)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const entry = literalWorkerEntry({ node, program });
        if (entry !== undefined) files.add(entry);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...files];
}
