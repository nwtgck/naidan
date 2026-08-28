import type { Node } from '@babel/types';

export function isBabelNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string';
}

export function isBabelNodeType<T extends Node['type']>(
  node: Node | null | undefined,
  type: T,
): node is Extract<Node, {type: T}> {
  return node?.type === String(type);
}

export function staticMemberPropertyName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.type === 'MemberExpression' && node.computed && node.property.type === 'StringLiteral') {
    return typeof node.property.value === 'string' ? node.property.value : null;
  }
  return null;
}
