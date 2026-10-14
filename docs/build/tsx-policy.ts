import ts from 'typescript';

const inlineElements = new Set(['span', 'strong', 'em', 'code', 'kbd', 'br']);
const reservedIslandAttributes = new Set(['data-docs-island', 'data-docs-props', 'data-docs-hydrated']);
const flatMessageKey = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const noSpreads = new Set<string>();
const commonAggregateSpreads = new Set(['chrome', 'searchUi']);
const commonDomainMetadata = new Set(['navigation', 'search_purpose_descriptions']);

function tsxError({ ast, filename, node, reason }: {
  ast: ts.SourceFile;
  filename: string;
  node: ts.Node;
  reason: string;
}): never {
  const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
  throw new Error(`${filename}:${line + 1}:${character + 1}: ${reason}`);
}

function declares({ name, identifier }: { name: ts.BindingName; identifier: string }): boolean {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some(element => ts.isBindingElement(element) && declares({ name: element.name, identifier }));
}

function unwrapped({ expression }: { expression: ts.Expression }): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) return unwrapped({ expression: expression.expression });
  return expression;
}

export function validateFlatMessageKeys({ ast, filename, object, allowedSpreads }: {
  ast: ts.SourceFile;
  filename: string;
  object: ts.ObjectLiteralExpression;
  allowedSpreads: ReadonlySet<string>;
}): void {
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (!ts.isIdentifier(property.expression) || !allowedSpreads.has(property.expression.text)) {
        tsxError({ ast, filename, node: property, reason: 'Docs locale messages require explicit flat message keys.' });
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      tsxError({ ast, filename, node: property, reason: 'Docs locale messages use explicit scalar values or functions.' });
    }
    const key = property.name;
    if ((!ts.isIdentifier(key) && !ts.isStringLiteral(key)) || !flatMessageKey.test(key.text)) {
      tsxError({ ast, filename, node: key, reason: 'Docs locale message keys must use snake_case.' });
    }
  }
}

function isLiteralText({ expression }: { expression: ts.Expression }): boolean {
  const value = unwrapped({ expression });
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
}

function isInlineStringFunction({ expression }: { expression: ts.Expression }): boolean {
  const value = unwrapped({ expression });
  return (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
    && value.type?.kind === ts.SyntaxKind.StringKeyword;
}

function hasCommonGroupImport({ ast, group, locale }: { ast: ts.SourceFile; group: string; locale: string }): boolean {
  const source = group === 'chrome' ? `../replica-chrome/${locale}` : `../search-ui/${locale}`;
  return ast.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== source || statement.importClause?.isTypeOnly) return false;
    const bindings = statement.importClause?.namedBindings;
    return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.some(element =>
      !element.isTypeOnly && element.propertyName?.text === 'messages' && element.name.text === group));
  });
}

export function validatePlainLocaleMessageKeys({ ast, filename }: { ast: ts.SourceFile; filename: string }): void {
  const common = /^messages\/common\/(?:en|ja)\.ts$/u.test(filename);
  const locale = filename.endsWith('/ja.ts') ? 'ja' : 'en';
  let found = false;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'messages') continue;
      found = true;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        tsxError({ ast, filename, node: declaration, reason: 'Docs locale messages must be exported as a const object.' });
      }
      if (locale === 'ja' && !hasCanonicalJapaneseCheck({ initializer: declaration.initializer })) {
        tsxError({ ast, filename, node: declaration, reason: "Japanese Docs locale messages require satisfies typeof import('./en').messages." });
      }
      const initializer = declaration.initializer && unwrapped({ expression: declaration.initializer });
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        tsxError({ ast, filename, node: declaration, reason: 'Docs locale messages must be an object literal.' });
      }
      validateFlatMessageKeys({
        ast,
        filename,
        object: initializer,
        allowedSpreads: common ? commonAggregateSpreads : noSpreads,
      });
      for (const property of initializer.properties) {
        if (ts.isSpreadAssignment(property)) {
          if (common && ts.isIdentifier(property.expression)
            && !hasCommonGroupImport({ ast, group: property.expression.text, locale })) {
            tsxError({ ast, filename, node: property, reason: 'Common Docs locale groups must import their matching locale messages.' });
          }
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
        const value = unwrapped({ expression: property.initializer });
        if (common && commonDomainMetadata.has(key) && ts.isObjectLiteralExpression(value)) continue;
        if (!isLiteralText({ expression: property.initializer }) && !isInlineStringFunction({ expression: property.initializer })) {
          tsxError({ ast, filename, node: property.initializer, reason: 'Plain Docs locale messages require literal text values or inline functions with an explicit string return type.' });
        }
      }
    }
  }
  if (!found) tsxError({ ast, filename, node: ast, reason: 'Docs locale modules must directly export const messages.' });
}

function hasCanonicalJapaneseCheck({ initializer }: { initializer: ts.Expression | undefined }): boolean {
  let expression = initializer;
  while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!expression || !ts.isSatisfiesExpression(expression)) return false;
  const type = expression.type;
  return ts.isImportTypeNode(type) && type.isTypeOf
    && ts.isLiteralTypeNode(type.argument) && ts.isStringLiteral(type.argument.literal)
    && type.argument.literal.text === './en' && type.qualifier !== undefined
    && ts.isIdentifier(type.qualifier) && type.qualifier.text === 'messages'
    && type.typeArguments === undefined;
}

function validateMessagesValues({ ast, filename, role }: {
  ast: ts.SourceFile;
  filename: string;
  role: 'article' | 'branching-island';
}): void {
  let found = false;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'messages') continue;
      found = true;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        tsxError({ ast, filename, node: declaration, reason: 'Docs locale messages must be exported as a const object.' });
      }
      if (filename.endsWith('/ja.tsx') && !hasCanonicalJapaneseCheck({ initializer: declaration.initializer })) {
        tsxError({ ast, filename, node: declaration, reason: "Japanese Docs locale messages require satisfies typeof import('./en').messages." });
      }
      const initializer = declaration.initializer && unwrapped({ expression: declaration.initializer });
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        tsxError({ ast, filename, node: declaration, reason: 'Docs locale messages must be an object literal.' });
      }
      switch (role) {
      case 'branching-island': continue;
      case 'article': break;
      default: {
        const unreachable: never = role;
        throw new Error(`Unsupported Docs message role: ${String(unreachable)}`);
      }
      }
      validateFlatMessageKeys({ ast, filename, object: initializer, allowedSpreads: noSpreads });
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const value = unwrapped({ expression: property.initializer });
        if (!isLiteralText({ expression: value }) && !ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) {
          tsxError({ ast, filename, node: value, reason: 'Article locale messages use literal text or inline functions that create fresh rich content.' });
        }
      }
    }
  }
  if (!found) tsxError({ ast, filename, node: ast, reason: 'Docs locale modules must export const messages.' });
}

export function validateDocsRichTsx({ ast, filename, componentImports, role }: {
  ast: ts.SourceFile;
  filename: string;
  componentImports: ReadonlySet<string>;
  role: 'article' | 'branching-island';
}): void {
  validateMessagesValues({ ast, filename, role });
  const visit = ({ node }: { node: ts.Node }): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      let parent = node.parent;
      while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
      if (!parent) {
        tsxError({ ast, filename, node, reason: 'Article locale JSX cannot be initialized at module scope. Return fresh JSX from a message function.' });
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const { tagName } = node;
      if (!ts.isIdentifier(tagName)) {
        tsxError({ ast, filename, node: tagName, reason: 'Static Docs rich JSX requires an explicit inline tag or imported typed component.' });
      }
      const tag = tagName.text;
      if (!inlineElements.has(tag) && !(componentImports.has(tag) && /^[A-Z]/u.test(tag))) {
        const reason = tag.toLowerCase() === 'a'
          ? 'Use a typed Docs link component instead of native <a> in rich JSX.'
          : `Unsupported static Docs rich JSX element <${tag}>.`;
        tsxError({ ast, filename, node: tagName, reason });
      }
      for (const property of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(property)) {
          tsxError({ ast, filename, node: property, reason: 'Static Docs rich JSX requires explicit attribute names.' });
        }
        const originalName = property.name.getText(ast);
        const name = originalName.toLowerCase();
        if (name.startsWith('on') || /^v(?:-|:|[A-Z])/u.test(originalName) || name === 'ref'
          || name === 'innerhtml' || name === 'outerhtml' || name === 'dangerouslysetinnerhtml'
          || name === 'dompropsinnerhtml' || name === 'dompropsouterhtml'
          || reservedIslandAttributes.has(name)) {
          tsxError({ ast, filename, node: property, reason: `Unsupported static Docs rich JSX attribute ${name}.` });
        }
      }
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node))
      && [...componentImports].some(identifier => declares({ name: node.name, identifier }))) {
      tsxError({ ast, filename, node, reason: 'A typed Docs rich JSX component import cannot be shadowed.' });
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node))
      && node.name && componentImports.has(node.name.text)) {
      tsxError({ ast, filename, node, reason: 'A typed Docs rich JSX component import cannot be shadowed.' });
    }
    ts.forEachChild(node, child => visit({ node: child }));
  };
  visit({ node: ast });
}
