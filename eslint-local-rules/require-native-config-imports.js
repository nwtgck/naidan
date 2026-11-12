import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import ts from 'typescript';
import { repoRoot, hasRuntimeImport } from './external-command-ast.js';

const graphCache = new Map();
const scriptExtensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function signature({ file }) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}:${stat.isDirectory()}`;
  } catch {
    return 'missing';
  }
}

function localPath({ specifier, importer }) {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier) && !specifier.startsWith('file:')) {
    return undefined;
  }
  try {
    return fileURLToPath(new URL(specifier, pathToFileURL(importer)));
  } catch {
    return undefined;
  }
}

function resolveLocal({ file, watch }) {
  const candidates = [file];
  if (/\.[cm]?js$/u.test(file)) {
    candidates.push(file.replace(/\.js$/u, '.ts').replace(/\.mjs$/u, '.mts').replace(/\.cjs$/u, '.cts'));
  }
  candidates.push(...[...scriptExtensions, '.json'].map(extension => file + extension));
  candidates.push(...[...scriptExtensions, '.json'].map(extension => path.join(file, 'index' + extension)));
  for (const candidate of candidates) {
    const current = signature({ file: candidate });
    watch?.set(candidate, current);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch { /* Missing candidates are also watched for later creation. */ }
  }
  return undefined;
}

function runtimeSource({ node }) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly || clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && !clause.name && clause.namedBindings.elements.every(binding => binding.isTypeOnly)) {
      return undefined;
    }
    return node.moduleSpecifier;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(binding => binding.isTypeOnly)) {
      return undefined;
    }
    return node.moduleSpecifier;
  }
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
}

function configGraph({ entryFile, filename, code }) {
  const cached = graphCache.get(entryFile);
  if (cached && (!cached.overlay || cached.overlay === filename) && (!cached.contents.has(filename) || cached.contents.get(filename) === code)
    && [...cached.watch].every(([file, previous]) => signature({ file }) === previous)) {
    return cached.files;
  }
  const files = new Set();
  const watch = new Map();
  const contents = new Map();
  const pending = [entryFile];
  let overlay;
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    watch.set(file, signature({ file }));
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      source = undefined;
    }
    contents.set(file, source);
    if (file === filename && source !== code) {
      overlay = filename;
      source = code;
    }
    if (source === undefined || !scriptExtensions.includes(path.extname(file))) {
      continue;
    }
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit({ node }) {
      const literal = runtimeSource({ node });
      if (literal && ts.isStringLiteralLike(literal)) {
        const local = localPath({ specifier: literal.text, importer: file });
        const resolved = local && resolveLocal({ file: local, watch });
        if (resolved) {
          pending.push(resolved);
        }
      }
      ts.forEachChild(node, child => visit({ node: child }));
    }
    visit({ node: parsed });
  }
  graphCache.set(entryFile, { files, watch, contents, overlay });
  return files;
}

function stringValue({ node }) {
  if (typeof node?.value === 'string') {
    return node.value;
  }
  return node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined;
}

function propertyValue({ node, name }) {
  return node?.type === 'ObjectExpression' ? node.properties.find(property => property.type === 'Property' && !property.computed && (property.key.name ?? property.key.value) === name)?.value : undefined;
}

/** Enforce Node module syntax only along the real configuration dependency graph. */
export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the Vite configuration dependency graph directly loadable by Node.' },
    schema: [{ type: 'object', properties: { entryFile: { type: 'string' } }, additionalProperties: false }],
    messages: {
      extension: 'Native configuration imports must name the actual file extension and index file: "{{specifier}}".',
      missing: 'Native configuration imports must resolve to an existing file with that exact name: "{{specifier}}".',
      alias: 'Native configuration imports cannot use application-only aliases: "{{specifier}}".',
      json: 'Native JSON imports require with { type: \'json\' }.',
      jsonNamed: 'Native JSON modules provide only a default export. Import the default value instead of named bindings.',
      dirname: 'Use import.meta.{{replacement}} instead of the free CommonJS global {{name}} in native configuration modules.',
    },
  },
  create(context) {
    const filename = path.resolve(context.physicalFilename ?? context.filename);
    const entryFile = path.resolve(context.options[0]?.entryFile ?? path.join(repoRoot, 'vite.config.ts'));
    const sourceCode = context.sourceCode;
    if (!configGraph({ entryFile, filename, code: sourceCode.text }).has(filename)) {
      return {};
    }
    function check({ node, source, runtime, jsonAttributes, named }) {
      const specifier = stringValue({ node: source });
      if (specifier === undefined) {
        return;
      }
      const local = localPath({ specifier, importer: filename });
      if (!local && (specifier.startsWith('.') || path.isAbsolute(specifier) || specifier.startsWith('file:'))) {
        context.report({ node: source, messageId: 'missing', data: { specifier } });
        return;
      }
      if (runtime && (specifier.startsWith('@/') || specifier.startsWith('~/'))) {
        context.report({ node: source, messageId: 'alias', data: { specifier } });
      }
      if (local) {
        const extension = path.extname(local);
        if (![...scriptExtensions, '.json'].includes(extension)) {
          context.report({ node: source, messageId: 'extension', data: { specifier } });
        } else {
          try {
            if (!fs.statSync(local).isFile()) {
              context.report({ node: source, messageId: 'missing', data: { specifier } });
            }
          } catch {
            context.report({ node: source, messageId: 'missing', data: { specifier } });
          }
        }
      }
      if (runtime && (local ? path.extname(local) === '.json' : specifier.split(/[?#]/u, 1)[0].endsWith('.json'))) {
        if (!jsonAttributes) {
          context.report({ node, messageId: 'json' });
        }
        if (named) {
          context.report({ node, messageId: 'jsonNamed' });
        }
      }
    }
    function declaration({ node }) {
      check({
        node,
        source: node.source,
        runtime: hasRuntimeImport({ node }),
        jsonAttributes: node.attributes?.some(attribute => (attribute.key.name ?? attribute.key.value) === 'type' && attribute.value.value === 'json')
          && sourceCode.getTokenAfter(node.source)?.value === 'with',
        named: node.specifiers?.some(specifier => (specifier.type === 'ImportSpecifier' && (specifier.imported.name ?? specifier.imported.value) !== 'default' && specifier.importKind !== 'type')
          || (specifier.type === 'ExportSpecifier' && (specifier.local.name ?? specifier.local.value) !== 'default' && specifier.exportKind !== 'type')),
      });
    }
    return {
      ImportDeclaration: node => declaration({ node }),
      ExportNamedDeclaration: node => declaration({ node }),
      ExportAllDeclaration: node => declaration({ node }),
      ImportExpression(node) {
        check({ node, source: node.source, runtime: true, jsonAttributes: stringValue({ node: propertyValue({ node: propertyValue({ node: node.options, name: 'with' }), name: 'type' }) }) === 'json', named: false });
      },
      TSImportType(node) {
        check({ node, source: node.source ?? node.argument, runtime: false, jsonAttributes: false, named: false });
      },
      'Program:exit'() {
        if (['.cjs', '.cts'].includes(path.extname(filename))) {
          return;
        }
        for (const scope of sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            const name = reference.identifier.name;
            if (reference.isValueReference !== false && ['__dirname', '__filename'].includes(name) && !reference.resolved?.defs.length) {
              context.report({ node: reference.identifier, messageId: 'dirname', data: { name, replacement: name.slice(2) } });
            }
          }
        }
      },
    };
  },
};

export default {
  files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
  plugins: { 'local-rules-native-config': { rules: { 'require-native-config-imports': rule } } },
  rules: { 'local-rules-native-config/require-native-config-imports': 'error' },
};
