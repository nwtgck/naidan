import type { PluginItem } from '@babel/core';
import babelTraverseImport from '@babel/traverse';
import transformDynamicImportImport from '@babel/plugin-transform-dynamic-import';
import transformModulesSystemjsImport from '@babel/plugin-transform-modules-systemjs';

type BabelTraverse = typeof import('@babel/traverse').default;

// Babel 7 publishes these build-time helpers as CommonJS. When Vite loads the
// TypeScript config through Node ESM, a default import can be the CommonJS wrapper
// object instead of the callable default export. Normalize that boundary here so
// AST policy and SystemJS transforms behave the same under config loading and tests.
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

export const babelTransformDynamicImportPlugin = resolveCallableCommonJsDefault<PluginItem>(
  transformDynamicImportImport,
  '@babel/plugin-transform-dynamic-import',
);

export const babelTransformModulesSystemjsPlugin = resolveCallableCommonJsDefault<PluginItem>(
  transformModulesSystemjsImport,
  '@babel/plugin-transform-modules-systemjs',
);
