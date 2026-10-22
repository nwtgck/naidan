import path from 'node:path';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

export const preservedOnboardingModule = 'src/components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue';

type ReferenceKind = 'static' | 'dynamic' | 'type';
export type ModuleReference = Readonly<{ from: string, target: string, kind: ReferenceKind }>;
export type ModuleGraph = ReturnType<typeof createModuleGraph>;

function staticString({ node }: { node: ts.Node | undefined }): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticString({ node: node.expression });
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString({ node: node.left });
    const right = staticString({ node: node.right });
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function localPath({ from, specifier }: { from: string, specifier: string }): string | undefined {
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return path.posix.normalize(`src/${specifier.slice(2)}`);
  }
  if (specifier.startsWith('/')) {
    return path.posix.normalize(specifier.slice(1));
  }
  if (specifier.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  }
  return undefined;
}

function isImportMeta({ node }: { node: ts.Node }): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';
}

function isImportMetaGlob({ node }: { node: ts.Expression }): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'glob' && isImportMeta({ node: node.expression });
}

function isTypeOnlyImport({ node }: { node: ts.ImportDeclaration }): boolean {
  const clause = node.importClause;
  if (clause?.isTypeOnly === true) {
    return true;
  }
  return clause?.name === undefined && clause?.namedBindings !== undefined
    && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every(element => element.isTypeOnly);
}

function isTypeOnlyExport({ node }: { node: ts.ExportDeclaration }): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  return node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every(element => element.isTypeOnly);
}

function globPatterns({ node, from }: { node: ts.Expression | undefined, from: string }): readonly string[] {
  if (node !== undefined && ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(element => globPatterns({ node: element, from }));
  }
  const pattern = staticString({ node });
  if (pattern === undefined) {
    throw new Error(`Cannot inspect nonliteral import.meta.glob in ${from}`);
  }
  return [pattern];
}

function globKind({ options, from }: { options: ts.Expression | undefined, from: string }): ReferenceKind {
  if (options === undefined) {
    return 'dynamic';
  }
  if (!ts.isObjectLiteralExpression(options)) {
    throw new Error(`Cannot inspect import.meta.glob options in ${from}`);
  }
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error(`Cannot inspect spread import.meta.glob options in ${from}`);
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = ts.isIdentifier(property.name) ? property.name.text : staticString({ node: property.name });
    if (name !== 'eager') {
      continue;
    }
    if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return 'static';
    }
    if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return 'dynamic';
    }
    throw new Error(`Cannot inspect nonliteral import.meta.glob eager option in ${from}`);
  }
  return 'dynamic';
}

/** Parse source only; never execute application code, Vite transforms, workers, or builds. */
export function createModuleGraph({ sources }: { sources: ReadonlyMap<string, string> }) {
  const cache = new Map<string, readonly ModuleReference[]>();

  function resolve({ from, specifier }: { from: string, specifier: string }): string {
    const cleanSpecifier = specifier.replace(/[?#].*$/u, '');
    const local = localPath({ from, specifier: cleanSpecifier });
    if (local === undefined) {
      return cleanSpecifier;
    }
    const candidates = [local, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue'].map(extension => local + extension), ...['.ts', '.tsx', '.js', '.vue'].map(extension => `${local}/index${extension}`)];
    if (local.endsWith('.js')) {
      candidates.push(local.slice(0, -3) + '.ts');
    }
    return candidates.find(candidate => sources.has(candidate)) ?? local;
  }

  function referencesFrom({ from }: { from: string }): readonly ModuleReference[] {
    const cached = cache.get(from);
    if (cached !== undefined) {
      return cached;
    }
    const source = sources.get(from);
    if (source === undefined) {
      throw new Error(`Missing source module: ${from}`);
    }
    const references: ModuleReference[] = [];

    function add({ specifier, kind }: { specifier: string, kind: ReferenceKind }): void {
      references.push({ from, target: resolve({ from, specifier }), kind });
      if (/[?&](?:sharedworker|worker)(?:[=&]|$)/u.test(specifier)) {
        references.push({ from, target: '#worker-constructor', kind });
      }
    }

    function visit({ node }: { node: ts.Node }): void {
      if (ts.isImportDeclaration(node)) {
        const specifier = staticString({ node: node.moduleSpecifier });
        if (specifier !== undefined) {
          add({ specifier, kind: isTypeOnlyImport({ node }) ? 'type' : 'static' });
        }
      } else if (ts.isExportDeclaration(node)) {
        const specifier = staticString({ node: node.moduleSpecifier });
        if (specifier !== undefined) {
          add({ specifier, kind: isTypeOnlyExport({ node }) ? 'type' : 'static' });
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = staticString({ node: node.moduleReference.expression });
        if (specifier !== undefined) {
          add({ specifier, kind: node.isTypeOnly ? 'type' : 'static' });
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        const specifier = staticString({ node: node.argument.literal });
        if (specifier !== undefined) {
          add({ specifier, kind: 'type' });
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = staticString({ node: node.arguments[0] });
        if (specifier !== undefined) {
          add({ specifier, kind: 'dynamic' });
        }
      } else if (ts.isCallExpression(node) && isImportMetaGlob({ node: node.expression })) {
        const patterns = globPatterns({ node: node.arguments[0], from });
        const kind = globKind({ options: node.arguments[1], from });
        const included: string[] = [];
        const excluded: string[] = [];
        for (const pattern of patterns) {
          const negative = pattern.startsWith('!');
          const resolved = localPath({ from, specifier: negative ? pattern.slice(1) : pattern });
          if (resolved === undefined) {
            throw new Error(`Cannot resolve import.meta.glob pattern ${pattern} in ${from}`);
          }
          (negative ? excluded : included).push(resolved);
        }
        for (const target of sources.keys()) {
          if (included.some(pattern => path.matchesGlob(target, pattern))
            && !excluded.some(pattern => path.matchesGlob(target, pattern))) {
            references.push({ from, target, kind });
          }
        }
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'Worker' || node.expression.text === 'SharedWorker') {
          references.push({ from, target: '#worker-constructor', kind: 'static' });
        }
        if (node.expression.text === 'URL' && node.arguments?.[1] !== undefined) {
          const base = node.arguments[1];
          if (ts.isPropertyAccessExpression(base) && base.name.text === 'url' && isImportMeta({ node: base.expression })) {
            const specifier = staticString({ node: node.arguments[0] });
            if (specifier !== undefined) {
              add({ specifier, kind: 'static' });
            }
          }
        }
      }
      ts.forEachChild(node, child => visit({ node: child }));
    }

    const scripts: string[] = [];
    if (from.endsWith('.vue')) {
      const parsed = parse(source, { filename: from });
      if (parsed.errors.length > 0) {
        throw new Error(`Cannot parse Vue source: ${from}: ${String(parsed.errors[0])}`);
      }
      for (const block of [parsed.descriptor.script, parsed.descriptor.scriptSetup]) {
        if (block === null) {
          continue;
        }
        if (block.src !== undefined) {
          add({ specifier: block.src, kind: 'static' });
        }
        scripts.push(block.content);
      }
    } else {
      scripts.push(source);
    }
    for (const script of scripts) {
      const ast = ts.createSourceFile(from, script, ts.ScriptTarget.Latest, true, from.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      visit({ node: ast });
    }
    cache.set(from, references);
    return references;
  }

  return { sources, referencesFrom };
}

export function isProductionModule({ filename }: { filename: string }): boolean {
  return /\.(?:[cm]?[jt]sx?|vue)$/u.test(filename) && !/\.(?:test|test-support|d)\.[cm]?[jt]sx?$/u.test(filename)
    && !filename.startsWith('src/test-tmp/') && !filename.startsWith('src/lint-rule-tmp/') && !filename.startsWith('src/test-mocks/');
}

export function preservedOnboardingReferences({ graph }: { graph: ModuleGraph }): readonly ModuleReference[] {
  const references: ModuleReference[] = [];
  for (const from of graph.sources.keys()) {
    if (!isProductionModule({ filename: from })) {
      continue;
    }
    references.push(...graph.referencesFrom({ from }).filter(reference => reference.target === preservedOnboardingModule));
  }
  return references;
}

export function isHeavyEntryModule({ target }: { target: string }): boolean {
  // These adapters capture File/DataTransfer inputs during an input/drop event.
  // Continue traversing their imports so adding runtime I/O here still fails.
  const localInputAdapter = target === 'src/features/llama-cpp-browser/runtime/directory-input.ts'
    || target === 'src/features/llama-cpp-browser/runtime/model-directory-input.ts';
  return target === preservedOnboardingModule || target === '#worker-constructor'
    || /^(?:@huggingface\/transformers|onnxruntime-web|llama-cpp-browser-core|stable-diffusion-cpp-browser-core)(?:\/|$)/u.test(target)
    || /^src\/components\/(?:MainApp|AppAuxiliaryUi|(?:Current)?ChatPane)\.vue$/u.test(target)
    || /\/components\/[^/]*(?:Manager|ModelLibrary)\.vue$/u.test(target)
    || /\/(?:workers?|[^/]+-worker)\//u.test(target)
    || /\.worker\.[cm]?[jt]s$/u.test(target)
    || /\.wasm$/u.test(target)
    || (!localInputAdapter && /^src\/features\/(?:llama-cpp-browser|transformers-js|stable-diffusion-cpp-browser)\/runtime(?:\/|-)/u.test(target))
    || /^src\/logic\/hugging-face-download\//u.test(target)
    || /^src\/features\/llama-cpp-browser\/hugging-face\/(?:metadata-session|session|catalog|download(?:-[^/]+)?|writer(?:-[^/]+)?|storage|sync-access|host-download-marker)\.ts$/u.test(target);
}

/** The one inherited settings edge predates the browser-first entry presentation. */
export const inheritedAppSettingsEdge = {
  from: 'src/composables/useAppEntry.ts',
  target: 'src/composables/useSettings.ts',
} as const;

/** Reusing the existing language menu must not add a second settings owner. */
export const inheritedLanguageSettingsEdge = {
  from: 'src/components/LanguageSelector.vue',
  target: 'src/composables/useSettings.ts',
} as const;

export function staticEntryViolations({ graph, root, boundaryEdges }: { graph: ModuleGraph, root: string, boundaryEdges: readonly Readonly<{ from: string, target: string }>[] }): readonly string[] {
  const visited = new Set<string>();
  const violations: string[] = [];

  function walk({ from, route }: { from: string, route: readonly string[] }): void {
    if (visited.has(from)) {
      return;
    }
    visited.add(from);
    for (const reference of graph.referencesFrom({ from })) {
      const kind = reference.kind;
      switch (kind) {
      case 'static': break;
      case 'dynamic':
      case 'type': continue;
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled reference kind: ${_ex}`);
      }
      }
      const nextRoute = [...route, reference.target];
      if (isHeavyEntryModule({ target: reference.target })) {
        violations.push(nextRoute.join(' -> '));
      } else if (boundaryEdges.some(edge => edge.from === from && edge.target === reference.target)) {
        continue;
      } else if (graph.sources.has(reference.target)) {
        walk({ from: reference.target, route: nextRoute });
      } else if (reference.target.startsWith('src/')
        && (path.posix.extname(reference.target) === '' || /\.(?:[cm]?[jt]sx?|vue)$/u.test(reference.target))) {
        violations.push(`Unresolved source module: ${nextRoute.join(' -> ')}`);
      }
    }
  }

  walk({ from: root, route: [root] });
  return violations;
}
