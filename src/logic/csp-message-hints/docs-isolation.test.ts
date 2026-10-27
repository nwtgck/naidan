// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { NodeTypes, parse as parseHtml } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { createModuleGraph, isProductionModule } from '@/logic/startup/entry-module-graph.test-support';

const projectRoot = path.resolve(import.meta.dirname, '../../..');

function htmlScripts({ source }: { source: string }): string {
  const scripts: string[] = [];
  const ast = parseHtml(source);
  function visit({ node }: { node: typeof ast | (typeof ast.children)[number] }): void {
    if (node.type !== NodeTypes.ROOT && node.type !== NodeTypes.ELEMENT) {
      return;
    }
    if (node.type === NodeTypes.ELEMENT && node.tag === 'script') {
      const type = node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'type');
      if (type?.type === NodeTypes.ATTRIBUTE && type.value !== undefined
        && !['module', 'text/javascript', 'application/javascript'].includes(type.value.content)) {
        return;
      }
      const src = node.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'src');
      if (src?.type === NodeTypes.ATTRIBUTE && src.value !== undefined) {
        scripts.push(`import ${JSON.stringify(src.value.content)};`);
      }
      scripts.push(...node.children.filter(child => child.type === NodeTypes.TEXT).map(child => child.content));
      return;
    }
    for (const child of node.children) {
      visit({ node: child });
    }
  }
  visit({ node: ast });
  return scripts.join('\n');
}

function scriptsInModule({ filename, source }: { filename: string, source: string }): readonly string[] {
  if (!filename.endsWith('.vue')) {
    return [source];
  }
  const parsed = parseSfc(source, { filename });
  if (parsed.errors.length > 0) {
    throw new Error(`Cannot inspect Docs module ${filename}: ${String(parsed.errors[0])}`);
  }
  return [parsed.descriptor.script, parsed.descriptor.scriptSetup]
    .filter((block): block is NonNullable<typeof block> => block !== null)
    .map(block => block.content);
}

function staticSpecifier({ node }: { node: ts.Node | undefined }): string | undefined {
  if (node !== undefined && ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (node !== undefined && ts.isParenthesizedExpression(node)) {
    return staticSpecifier({ node: node.expression });
  }
  if (node !== undefined && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticSpecifier({ node: node.left });
    const right = staticSpecifier({ node: node.right });
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function moduleCalls({ filename, source }: { filename: string, source: string }): { requires: readonly string[], unresolved: readonly string[] } {
  const requires: string[] = [], unresolved: string[] = [];
  for (const script of scriptsInModule({ filename, source })) {
    const ast = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit({ node }: { node: ts.Node }): void {
      if (ts.isCallExpression(node)) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isRequireResolve = ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require'
          && node.expression.name.text === 'resolve';
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isRequireResolve || isDynamicImport) {
          const specifier = staticSpecifier({ node: node.arguments[0] });
          if (specifier === undefined) {
            unresolved.push(`Cannot inspect nonliteral module reference in ${filename}`);
          } else if (isRequire || isRequireResolve) {
            requires.push(specifier);
          }
        }
      }
      ts.forEachChild(node, child => visit({ node: child }));
    }
    visit({ node: ast });
  }
  return { requires, unresolved };
}

function resolveRequire({ from, specifier, sources }: { from: string, specifier: string, sources: ReadonlyMap<string, string> }): string {
  const clean = specifier.replace(/[?#].*$/u, '');
  const local = clean.startsWith('@/') || clean.startsWith('~/') ? `src/${clean.slice(2)}`
    : clean.startsWith('/') ? clean.slice(1)
      : clean.startsWith('.') ? path.posix.join(path.posix.dirname(from), clean) : undefined;
  if (local === undefined) {
    return clean;
  }
  const normalized = path.posix.normalize(local);
  const candidates = [normalized,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'].map(extension => normalized + extension),
    ...['.ts', '.tsx', '.js', '.vue'].map(extension => `${normalized}/index${extension}`)];
  if (normalized.endsWith('.js')) {
    candidates.push(normalized.slice(0, -3) + '.ts');
  }
  return candidates.find(candidate => sources.has(candidate)) ?? normalized;
}

function isCspTarget({ target }: { target: string }): boolean {
  return /^src\/(?:utils\/csp|logic\/(?:csp-message-hints|development-meta-csp))(?:\/|$)/u.test(target)
    || /^src\/composables\/(?:useCspMessageHintsOnly|useDevelopmentMetaCspNotForSecurity)(?:\.[cm]?[jt]s)?$/u.test(target)
    || /^src\/features\/privacy-fetch\/(?:broker-development-meta-csp|development-meta-csp-protocol)(?:\.[cm]?[jt]s)?$/u.test(target)
    || target.startsWith('src/components/csp/')
    || target === 'src/components/DeveloperCspDiagnostics.vue';
}

/** Traverse source only, including deferred and type references; never execute Docs or app modules. */
function docsCspViolations({ modules, roots }: { modules: ReadonlyMap<string, string>, roots: readonly string[] }): readonly string[] {
  const sources = new Map([...modules].map(([filename, source]) => [filename, filename.endsWith('.html') ? htmlScripts({ source }) : source]));
  const graph = createModuleGraph({ sources });
  const visited = new Set<string>(), violations: string[] = [];
  function walk({ from, route }: { from: string, route: readonly string[] }): void {
    if (visited.has(from)) {
      return;
    }
    visited.add(from);
    const source = sources.get(from);
    if (source === undefined) {
      violations.push(`Missing Docs entry: ${route.join(' -> ')}`);
      return;
    }
    const calls = moduleCalls({ filename: from, source });
    violations.push(...calls.unresolved);
    const targets = [...graph.referencesFrom({ from }).map(reference => reference.target),
      ...calls.requires.map(specifier => resolveRequire({ from, specifier, sources }))];
    for (const target of targets) {
      const next = [...route, target];
      if (isCspTarget({ target })) {
        violations.push(next.join(' -> '));
      } else if (sources.has(target)) {
        walk({ from: target, route: next });
      } else if (/^(?:src|docs|build)\//u.test(target)
        && (path.posix.extname(target) === '' || /\.(?:[cm]?[jt]sx?|vue)$/u.test(target))) {
        violations.push(`Unresolved source module: ${next.join(' -> ')}`);
      }
      // Docs virtual registries select authored source files. All authored
      // modules are independent roots below, including clients and islands,
      // so those generated selections cannot exempt a source subtree.
    }
  }
  for (const root of roots) {
    walk({ from: root, route: [root] });
  }
  return violations;
}

describe('Docs CSP isolation analyzer', () => {
  it.each([
    `import '@/components/csp/CspMessageHint.vue';`,
    `export * from '~/logic/csp-message-hints';`,
    `import type { ParsedCsp } from '@/utils/csp';`,
    `const load = () => import('@/composables/useCspMessageHintsOnly');`,
    `new URL('/src/components/csp/CspMessageHint.vue', import.meta.url);`,
    `require('@/utils/csp');`,
    `require.resolve('@/logic/csp-message-hints');`,
    `import { getDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';`,
    `import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types';`,
    `const recovery = import('@/composables/useDevelopmentMetaCspNotForSecurity');`,
    `export * from '@/logic/development-meta-csp/document-messages-only';`,
    `import { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from '@/logic/development-meta-csp/privacy-broker-sync';`,
    `import { createBrokerDevelopmentMetaCspNotForSecurity } from '@/features/privacy-fetch/broker-development-meta-csp';`,
    `import type { DevelopmentMetaCspSyncMessage } from '@/features/privacy-fetch/development-meta-csp-protocol';`,
    `const modules = import.meta.glob('@/components/csp/*.vue');`,
  ])('rejects a Docs reference through %s', code => {
    const modules = new Map([
      ['docs/client/main.ts', code],
      ['src/components/csp/CspMessageHint.vue', '<template><span /></template>'],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/client/main.ts'] })).toHaveLength(1);
  });

  it('follows a reused component through a deferred barrel and extensionless imports', () => {
    const modules = new Map([
      ['docs/islands/main.vue', '<script setup lang="ts">const load = () => import("../../src/reused");</script>'],
      ['src/reused/index.ts', `export { default } from '../components/csp/CspMessageHint.vue';`],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/islands/main.vue'] }))
      .toEqual(['docs/islands/main.vue -> src/reused/index.ts -> src/components/csp/CspMessageHint.vue']);
  });

  it('rejects development recovery reached through a reused app host', () => {
    const modules = new Map([
      ['docs/islands/main.vue', '<script setup lang="ts">import Host from "@/components/AppAuxiliaryUi.vue";</script>'],
      ['src/components/AppAuxiliaryUi.vue', '<script setup lang="ts">import Recovery from "./csp/DevelopmentMetaCspRecovery.vue";</script>'],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/islands/main.vue'] }))
      .toEqual(['docs/islands/main.vue -> src/components/AppAuxiliaryUi.vue -> src/components/csp/DevelopmentMetaCspRecovery.vue']);
  });

  it('rejects native broker synchronization reached through a reused privacy-fetch client', () => {
    const modules = new Map([
      ['docs/islands/main.vue', '<script setup lang="ts">import Client from "@/features/privacy-fetch/broker-client";</script>'],
      ['src/features/privacy-fetch/broker-client.ts', `import { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from '@/logic/development-meta-csp/privacy-broker-sync';`],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/islands/main.vue'] }))
      .toEqual(['docs/islands/main.vue -> src/features/privacy-fetch/broker-client.ts -> src/logic/development-meta-csp/privacy-broker-sync']);
  });

  it('allows Docs-owned protocol examples without importing app native control modules', () => {
    const modules = new Map([
      ['docs/client/main.ts', `import { example } from './development-meta-csp-protocol';`],
      ['docs/client/development-meta-csp-protocol.ts', `export const example = { type: 'development-meta-csp-sync', policies: ["connect-src 'none'"] };`],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/client/main.ts'] })).toEqual([]);
  });

  it('inspects module script sources and inline imports in HTML entries', () => {
    const modules = new Map([
      ['docs/page.html', '<!doctype html><script type="module" src="./client.ts"></script><script type="module">import "/src/utils/csp/index.ts";</script>'],
      ['docs/client.ts', `export * from '@/logic/csp-message-hints';`],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/page.html'] })).toEqual([
      'docs/page.html -> docs/client.ts -> src/logic/csp-message-hints',
      'docs/page.html -> src/utils/csp/index.ts',
    ]);
  });

  it('allows unrelated cycles and negative globs without reading comments or JSON as code', () => {
    const modules = new Map([
      ['docs/page.html', '<script type="module" src="./client.ts"></script><!-- <script src="/src/utils/csp/index.ts"></script> --><script type="application/json">{"example":"import x from \'@/utils/csp\'"}</script>'],
      ['docs/client.ts', `import './cycle'; const modules = import.meta.glob(['@/components/csp/*.vue', '!@/components/csp/**']);`],
      ['docs/cycle.ts', `import './client';`],
      ['src/components/csp/CspMessageHint.vue', '<template><span /></template>'],
    ]);
    expect(docsCspViolations({ modules, roots: ['docs/page.html'] })).toEqual([]);
  });

  it('reports unresolved local code and nonliteral imports instead of silently dropping edges', () => {
    const modules = new Map([['docs/client.ts', `import './missing'; const load = () => import(runtimeModule);`]]);
    expect(docsCspViolations({ modules, roots: ['docs/client.ts'] })).toEqual([
      'Cannot inspect nonliteral module reference in docs/client.ts',
      'Unresolved source module: docs/client.ts -> docs/missing',
    ]);
  });
});

describe('production Docs CSP boundary', () => {
  it('keeps all authored pages, client entries and islands independent of app CSP diagnostics', () => {
    const modules = new Map<string, string>();
    for (const directory of ['src', 'docs', 'build']) {
      for (const entry of fs.readdirSync(path.join(projectRoot, directory), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) {
          continue;
        }
        const filename = path.relative(projectRoot, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/');
        if ((isProductionModule({ filename }) || filename.endsWith('.html'))
          && !/\.(?:test|spec|test-support)\./u.test(filename)
          && !/\/(?:tests|dist|node_modules)\//u.test(filename)) {
          modules.set(filename, fs.readFileSync(path.join(projectRoot, filename), 'utf8'));
        }
      }
    }
    const roots = [...modules.keys()].filter(filename => filename.startsWith('docs/')
      && !filename.startsWith('docs/build/') && filename !== 'docs/vite.config.ts');
    expect(roots.some(filename => filename.startsWith('docs/client/'))).toBe(true);
    expect(roots.some(filename => filename.startsWith('docs/islands/'))).toBe(true);
    expect(roots.some(filename => filename.startsWith('docs/pages/'))).toBe(true);
    expect(docsCspViolations({ modules, roots })).toEqual([]);
  }, 30000);
});
