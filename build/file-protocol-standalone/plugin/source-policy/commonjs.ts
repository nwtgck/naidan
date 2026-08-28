import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { builtinModules } from 'node:module';
import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from '../diagnostics.js';
import { isOutputChunk } from '../output-graph.js';
import { isBabelNode, isBabelNodeType } from './babel-node.js';

type CommonJsRequireCall = Readonly<{kind: string; staticSpecifier: string | null; dynamic: boolean; start: number | null; end: number | null}>;

const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
]);

function findCommonJsRequireCalls(code: string, id = '<unknown>'): CommonJsRequireCall[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: id,
    allowAwaitOutsideFunction: true,
    plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
  });
  const calls: CommonJsRequireCall[] = [];
  function visit(node: Node | null | undefined): void {
    if (!node || typeof node !== 'object') return;
    if (isBabelNodeType(node, 'CallExpression')) {
      const directRequire = node.callee?.type === 'Identifier' && node.callee.name === 'require';
      const requireResolve = node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === 'require'
        && node.callee.property?.type === 'Identifier'
        && node.callee.property.name === 'resolve';
      const moduleRequire = node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === 'module'
        && node.callee.property?.type === 'Identifier'
        && node.callee.property.name === 'require';
      if (directRequire || requireResolve || moduleRequire) {
        const argument = node.arguments[0];
        calls.push({
          kind: directRequire ? 'require' : requireResolve ? 'require.resolve' : 'module.require',
          staticSpecifier: node.arguments.length === 1 && argument?.type === 'StringLiteral' ? argument.value : null,
          dynamic: node.arguments.length !== 1 || argument?.type !== 'StringLiteral',
          start: node.start ?? null,
          end: node.end ?? null,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isBabelNode(item)) visit(item);
        }
      } else if (isBabelNode(value)) {
        visit(value);
      }
    }
  }
  visit(ast);
  return calls;
}

export function createCommonJsCompatibilityPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-commonjs-compatibility',
    enforce: 'pre',
    transform(code, id) {
      const sourcePath = id.split('?', 1)[0];
      if (!/\.(?:cjs|cts)$/u.test(sourcePath)) return null;
      const calls = findCommonJsRequireCalls(code, sourcePath);
      for (const call of calls) {
        if (call.kind !== 'require') {
          throw new Error(`${call.kind}() is unsupported in standalone browser output: ${sourcePath}:${call.start}`);
        }
        if (call.dynamic) {
          throw new Error(`Dynamic CommonJS require() is unsupported in standalone browser output: ${sourcePath}:${call.start}`);
        }
        if (call.staticSpecifier !== null && NODE_BUILTIN_MODULES.has(call.staticSpecifier)) {
          throw new Error(`Node.js builtin ${JSON.stringify(call.staticSpecifier)} is unsupported in standalone browser output: ${sourcePath}:${call.start}`);
        }
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (!isOutputChunk(output)) continue;
        const browserExternalModules = Object.keys(output.modules).filter(moduleId => /(?:vite-browser-external|browser-external:|\0browser-external)/u.test(moduleId));
        if (browserExternalModules.length > 0) {
          throw new Error(`Browser-external stub modules are unsupported in standalone output ${output.fileName}: ${browserExternalModules.join(', ')}`);
        }
        if (/environment that doesn't expose the [`']require[`'] function/u.test(output.code)) {
          throw new Error(`Unresolved runtime CommonJS require() fallback remains in standalone output: ${output.fileName}`);
        }
      }
      diagnostics.commonJsCompatibilityChecked = true;
    },
  };
}
