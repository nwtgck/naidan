import { transformAsync } from '@babel/core';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import {
  babelTransformDynamicImportPlugin,
  babelTransformModulesSystemjsPlugin,
  babelTraverse,
} from './babel-runtime.js';

describe('file protocol standalone Babel runtime interop', () => {
  it('normalizes the Babel traverse CommonJS default export to a callable function', () => {
    const ast = parse('const answer = value;', { sourceType: 'module' });
    const identifiers: string[] = [];

    babelTraverse(ast, {
      Identifier(path) {
        identifiers.push(path.node.name);
      },
    });

    expect(identifiers).toEqual(['answer', 'value']);
  });

  it('normalizes Babel transform plugin CommonJS defaults to callable plugins', async () => {
    expect(typeof babelTransformDynamicImportPlugin).toBe('function');
    expect(typeof babelTransformModulesSystemjsPlugin).toBe('function');

    const transformed = await transformAsync(
      'export async function load() { return import("./dependency.js"); }',
      {
        babelrc: false,
        configFile: false,
        sourceType: 'module',
        plugins: [babelTransformDynamicImportPlugin, babelTransformModulesSystemjsPlugin],
      },
    );

    expect(transformed?.code).toContain('System.register');
    expect(transformed?.code).toContain('_context.import("./dependency.js")');
  });
});
