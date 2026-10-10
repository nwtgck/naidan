import path from 'node:path';
import ts from 'typescript';
import { BOUNDARY_STRING_LOCALES, boundaryStringMessageFilePath, createBoundaryStringProjectPaths, isBoundaryStringMessageKey } from '../../../build/boundary-strings/message-catalog.ts';
import { findMessageFunction, parameterNamesFromFunction } from '../../../build/boundary-strings/compaction.ts';
import type { ContractOwner } from './values.ts';

function primitiveLiteral({ expression }: { expression: ts.Expression }): boolean {
  if (ts.isParenthesizedExpression(expression)) return primitiveLiteral({ expression: expression.expression });
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) || ts.isBigIntLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword
    || ts.isVoidExpression(expression) && ts.isNumericLiteral(expression.expression) && expression.expression.text === '0';
}

/** Existing Strings import/call validation protects this exact message domain. */
export function boundaryStringMessages({ root, sources }: { root: string, sources: readonly ts.SourceFile[] }): ReadonlySet<ts.Node> {
  const paths = createBoundaryStringProjectPaths({ root });
  const functions = new Set<ts.Node>();
  for (const source of sources) {
    const key = path.basename(path.dirname(source.fileName));
    if (!isBoundaryStringMessageKey({ key }) || !BOUNDARY_STRING_LOCALES.some(locale =>
      path.resolve(source.fileName) === boundaryStringMessageFilePath({ key, locale, paths }))) continue;
    try {
      const fn = findMessageFunction({ key, sourceFile: source });
      parameterNamesFromFunction({ key, messageFunction: fn });
      if (!ts.canHaveModifiers(fn) || !ts.getModifiers(fn)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) functions.add(fn);
    } catch { /* Invalid message definitions retain the ordinary annotation requirement. */ }
  }
  return functions;
}

function primitiveType({ type }: { type: ts.TypeNode }): boolean {
  if (ts.isParenthesizedTypeNode(type)) return primitiveType({ type: type.type });
  if (ts.isUnionTypeNode(type)) return type.types.every(item => primitiveType({ type: item }));
  if (ts.isLiteralTypeNode(type)) return primitiveLiteral({ expression: type.literal });
  return [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.UndefinedKeyword].includes(type.kind);
}

function messageTemplate({ node }: { node: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression }): boolean {
  if (node.parameters.length !== 1 || node.typeParameters !== undefined || ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const parameter = node.parameters[0]!;
  if (parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined || parameter.questionToken !== undefined
    || !ts.isObjectBindingPattern(parameter.name) || parameter.type === undefined || !ts.isTypeLiteralNode(parameter.type)) return false;
  const fields = new Set<string>();
  for (const member of parameter.type.members) {
    if (!ts.isPropertySignature(member) || member.name === undefined || !ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name) && !ts.isNumericLiteral(member.name)
      || member.type === undefined || member.questionToken !== undefined || !primitiveType({ type: member.type })) return false;
    fields.add(member.name.text);
  }
  const bindings = new Set<string>();
  for (const element of parameter.name.elements) {
    if (!ts.isIdentifier(element.name) || element.initializer !== undefined || element.dotDotDotToken !== undefined) return false;
    const property = element.propertyName ?? element.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteral(property) && !ts.isNumericLiteral(property) || !fields.has(property.text)) return false;
    bindings.add(element.name.text);
  }
  const body = node.body;
  const statement = body !== undefined && ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  let expression = body !== undefined && !ts.isBlock(body) ? body : statement !== undefined && ts.isReturnStatement(statement) ? statement.expression : undefined;
  while (expression !== undefined && ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (expression === undefined || !ts.isTemplateExpression(expression)) return false;
  return expression.templateSpans.every(span => {
    let value = span.expression;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    return ts.isIdentifier(value) && bindings.has(value.text);
  });
}

/** Omission changes annotation requirements, never body analysis or diagnostics. */
export function mayOmitEffectAnnotation({ owner }: { owner: ContractOwner }): boolean {
  switch (owner.role) {
  case 'implementation': break;
  case 'slot': case 'signature': case 'symbolic': case 'module': case 'body': return false;
  default: { const exhaustive: never = owner.role; throw new Error(String(exhaustive)); }
  }
  let node = owner.anchor;
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) node = node.declarationList.declarations[0]!;
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) node = node.initializer;
  if (ts.isPropertyAssignment(node)) node = node.initializer;
  if ((!ts.isArrowFunction(node) && !ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node)) || node.body === undefined) return false;
  if (!ts.isArrowFunction(node) && node.asteriskToken !== undefined) return false;
  if (node.parameters.length !== 0) return owner.parameterBoundary === 'boundary-string' && messageTemplate({ node });
  if (!ts.isBlock(node.body)) return primitiveLiteral({ expression: node.body });
  if (node.body.statements.length === 0) return true;
  const statement = node.body.statements.length === 1 ? node.body.statements[0] : undefined;
  return statement !== undefined && ts.isReturnStatement(statement) && statement.expression !== undefined && primitiveLiteral({ expression: statement.expression });
}
