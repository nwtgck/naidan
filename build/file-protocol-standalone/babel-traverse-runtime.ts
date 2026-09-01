import babelTraverseImport from '@babel/traverse';

type BabelTraverse = typeof import('@babel/traverse').default;

// Babel 7 publishes traverse as CommonJS. When Vite loads the TypeScript config
// through Node ESM, a default import can be the CommonJS wrapper object instead
// of the callable default export. Normalize only this AST-analysis boundary.
function resolveCallableCommonJsDefault<T>(value: unknown, moduleId: string): T {
  if (typeof value === 'function') return value as T;
  if (typeof value === 'object' && value !== null && 'default' in value) {
    const nestedDefault = value.default;
    if (typeof nestedDefault === 'function') return nestedDefault as T;
  }
  throw new TypeError(`Expected callable CommonJS default export from ${moduleId}`);
}

export const babelTraverse = resolveCallableCommonJsDefault<BabelTraverse>(
  babelTraverseImport,
  '@babel/traverse',
);
