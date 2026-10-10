import ts from 'typescript';
import type { Value } from '../../analysis/values.ts';

/** These wrappers change types or grouping, not the option object's runtime value. */
function unwrap({ expression }: { expression: ts.Expression }): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

/**
 * Only claim non-creation from an evaluated fresh literal or an absent field in
 * a checked closed shape. Do not freeze mutable aliases at their initial value.
 * Traverse from the right: a later spread can overwrite an earlier create:false.
 * All argument expressions have already been checked independently for effects.
 */
export function filesystemCreationPossible({ node, options }: { node: ts.Node, options: Value | undefined }): boolean {
  if (options === undefined) return false;
  const raw = ts.isCallExpression(node) ? node.arguments[1] : undefined;
  if (raw !== undefined) {
    const expression = unwrap({ expression: raw });
    if (ts.isVoidExpression(expression)) return false;
    if (ts.isObjectLiteralExpression(expression)) {
      for (let index = expression.properties.length - 1; index >= 0; index--) {
        const property = expression.properties[index]!;
        if (ts.isSpreadAssignment(property)) return true;
        const name = property.name;
        if (name === undefined || ts.isComputedPropertyName(name)) return true;
        const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
        if (key === undefined) return true;
        if (key !== 'create') continue;
        if (!ts.isPropertyAssignment(property)) return true;
        const initializer = unwrap({ expression: property.initializer });
        return initializer.kind !== ts.SyntaxKind.FalseKeyword && !ts.isVoidExpression(initializer);
      }
      return false;
    }
  }
  return options.kind !== 'record' || options.shape !== 'closed' || options.fields.has('create');
}
