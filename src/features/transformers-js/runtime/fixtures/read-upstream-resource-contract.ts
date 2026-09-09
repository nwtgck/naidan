import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';

// Development-only extraction of declarative upstream registration data. This
// does not import a second Transformers.js runtime or execute upstream code.
export function readUpstreamResourceContract({ packageRoot }: { packageRoot: string }) {
  const registryText = readFileSync(resolve(packageRoot, 'src/models/registry.js'), 'utf8');
  const source = ts.createSourceFile('registry.js', registryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const initializers = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  function array({ name }: { name: string }): ts.ArrayLiteralExpression {
    const expression = initializers.get(name);
    if (!expression || !ts.isArrayLiteralExpression(expression)) throw new Error(`Upstream array changed: ${name}`);
    return expression;
  }
  function tuple({ expression }: { expression: ts.Expression }): ts.ArrayLiteralExpression {
    if (!ts.isArrayLiteralExpression(expression)) throw new Error('Upstream registration tuple changed');
    return expression;
  }
  function text({ expression }: { expression: ts.Expression | undefined }): string {
    if (expression && (ts.isStringLiteral(expression) || ts.isIdentifier(expression))) return expression.text;
    throw new Error('Upstream registration name changed');
  }
  function family({ expression }: { expression: ts.Expression | undefined }): string {
    if (!expression || !ts.isPropertyAccessExpression(expression) || expression.expression.getText(source) !== 'MODEL_TYPES') throw new Error('Upstream family expression changed');
    return expression.name.text;
  }
  function entries({ name }: { name: string }): Array<[string, string]> {
    const expression = initializers.get(name);
    if (!expression || !ts.isNewExpression(expression) || expression.expression.getText(source) !== 'Map') throw new Error(`Upstream map changed: ${name}`);
    const values = expression.arguments?.[0];
    if (!values || !ts.isArrayLiteralExpression(values)) throw new Error(`Upstream map entries changed: ${name}`);
    return values.elements.map(element => {
      const row = tuple({ expression: element });
      return [text({ expression: row.elements[0] }), text({ expression: row.elements[1] })];
    });
  }
  const classFamilies: Record<string, string> = {};
  for (const element of array({ name: 'MODEL_CLASS_TYPE_MAPPING' }).elements) {
    const row = tuple({ expression: element });
    const selectedFamily = family({ expression: row.elements[1] });
    for (const [, className] of entries({ name: text({ expression: row.elements[0] }) })) classFamilies[className] = selectedFamily;
  }
  for (const element of array({ name: 'CUSTOM_MAPPING' }).elements) {
    const row = tuple({ expression: element });
    classFamilies[text({ expression: row.elements[0] })] = family({ expression: row.elements[2] });
  }
  for (const [name] of entries({ name: 'CUSTOM_ARCHITECTURES_MAPPING' })) classFamilies[name] = 'EncoderOnly';
  classFamilies.PreTrainedModel = 'EncoderOnly';
  const sourceSha256 = Object.fromEntries([
    'src/models/registry.js', 'src/models/modeling_utils.js', 'src/models/session_config.js',
    'src/models/session.js', 'src/models/auto/modeling_auto.js', 'src/utils/model-loader.js',
    'src/utils/dtypes.js', 'src/utils/devices.js', 'src/utils/hub/constants.js', 'dist/transformers.web.js', 'package.json',
  ].map(path => [path, createHash('sha256').update(readFileSync(resolve(packageRoot, path))).digest('hex')]));
  return {
    version: z.object({ version: z.string() }).parse(JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))).version,
    sourceSha256,
    classFamilies: Object.fromEntries(Object.entries(classFamilies).sort(([left], [right]) => left.localeCompare(right))),
    causalClasses: Object.fromEntries(entries({ name: 'MODEL_FOR_CAUSAL_LM_MAPPING_NAMES' })),
    imageTextClasses: Object.fromEntries(entries({ name: 'MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING_NAMES' })),
  };
}

export const TEST_ONLY = {
};
