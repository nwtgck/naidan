import ts from 'typescript';
import { EffectSyntaxError } from './error.ts';

/** Parse strict JSON and retain duplicate-key evidence before objects lose it. */
export function parseJsonPayload({ text }: { text: string }): unknown {
  if (text.length > 65_536) throw new EffectSyntaxError({ message: 'Effect JSON payload is too long.', offset: 0 });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EffectSyntaxError({ message: 'Expected a strict JSON effect payload.', offset: 0 });
  }
  try {
    const source = ts.parseJsonText('effects.json', text);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set<string>();
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) {
            throw new EffectSyntaxError({ message: 'Expected JSON object properties with string keys.', offset: property.getStart(source) });
          }
          const name = property.name.text;
          if (names.has(name)) throw new EffectSyntaxError({ message: `Duplicate JSON object key: ${JSON.stringify(name)}.`, offset: property.name.getStart(source) });
          names.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new EffectSyntaxError({ message: 'Effect JSON payload is too deeply nested.', offset: 0 });
  }
  return value;
}
