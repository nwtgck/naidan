import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { babelTraverse } from './babel-traverse-runtime.js';

describe('file protocol standalone Babel traverse runtime interop', () => {
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
});
