import { findVariable, propertyName, unwrap } from './test-resource-ast.js';
import path from 'node:path';
import { commandPath, createResolver, hasRuntimeImport, isCommandModule, isRawModule, physicalPath, repoRoot } from './external-command-ast.js';

const messages = {
  rawCommandEntry: 'Use the common command runner. Raw host command modules, execution APIs, and known launchers are forbidden outside build/command.ts.',
  malformedPermission: 'Use // !!! ALLOW-EXTERNAL-COMMAND <literal command prefix>:* !!! -- <reason> as a standalone leading comment.',
  misplacedPermission: 'Command permissions must precede the first code or import in the file.',
  duplicatePermission: 'This command prefix is already permitted in this file.',
  unusedPermission: 'This command permission has no matching direct runner call in this file.',
  missingPermission: 'Declare the command prefix in a leading ALLOW-EXTERNAL-COMMAND comment with a reason.',
  mismatchedPermission: 'The literal argv prefix does not match a command permission in this file. Dynamic values and spreads may follow the permitted prefix.',
  invalidRunnerCall: 'Call the runner directly with one literal object containing argv and options. argv must be a nonempty array literal with a literal command prefix.',
  runnerEscape: 'Import runCommand/runCommandSync by name and call that binding directly. Do not re-export, alias, store, or pass the runner as a value.',
  docsCommand: 'Docs must not execute external commands or import the command runner, even with a command permission.',
};
const runnerNames = new Set(['runCommand', 'runCommandSync']);
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isRuntimeReference({ reference }) {
  // Type queries read the value namespace for typing without evaluating a value.
  for (let node = reference.identifier.parent; node; node = node.parent) {
    if (node.type === 'TSTypeQuery') {
      return false;
    }
    if (node.type === 'Program' || functionTypes.has(node.type)) {
      break;
    }
  }
  return reference.isTypeReference !== true || reference.isValueReference === true;
}

function outerExpression({ node }) {
  while (node.parent && unwrap({ node: node.parent }) === node) {
    node = node.parent;
  }
  return node;
}

function nearestFunction({ node }) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (functionTypes.has(parent.type)) {
      return parent;
    }
  }
  return undefined;
}

function runnerArgv({ node, sourceCode }) {
  if (node.optional || node.arguments.length !== 1) {
    return undefined;
  }
  const input = unwrap({ node: node.arguments[0] });
  if (input?.type !== 'ObjectExpression') {
    return undefined;
  }
  const fields = new Map();
  for (const property of input.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') {
      return undefined;
    }
    const key = propertyName({ sourceCode, node: property });
    if (!['argv', 'options'].includes(key) || fields.has(key)) {
      return undefined;
    }
    fields.set(key, unwrap({ node: property.value }));
  }
  const argv = fields.get('argv');
  if (fields.size !== 2 || argv?.type !== 'ArrayExpression' || !argv.elements.length) {
    return undefined;
  }
  return argv.elements.map(element => unwrap({ node: element }));
}

function makeRule({ mode }) {
  return {
    meta: { type: 'problem', docs: { description: 'Keep host execution at the common runner and make its command prefixes explicit.' }, schema: [], messages },
    create(context) {
      const sourceCode = context.sourceCode;
      const filename = context.physicalFilename ?? context.filename;
      const trusted = physicalPath({ filename }) === commandPath;
      const inDocs = path.relative(repoRoot, physicalPath({ filename }) ?? '').replaceAll('\\', '/').startsWith('docs/');
      const { resolve, string } = createResolver({ sourceCode, filename });
      const report = (node, messageId) => context.report({ node, messageId });
      const runnerBindings = new Set();
      const hasTemplate = Boolean(sourceCode.ast.templateBody);
      const permissions = [];
      const usedPermissions = new Set();
      const trustedImports = [];

      function checkModule({ node, value, kind }) {
        if (mode === 'raw' && value === 'bun' && (kind === 'export' && node.type === 'ExportAllDeclaration'
          || node.specifiers?.some(specifier => specifier.importKind !== 'type' && specifier.exportKind !== 'type'
            && ['spawn', 'spawnSync', '$'].includes(specifier.imported?.name ?? specifier.imported?.value ?? specifier.local?.name)))) {
          report(node, 'rawCommandEntry');
        }
        if (mode === 'raw' && isRawModule({ value })) {
          const allowed = trusted && ['node:child_process', 'child_process'].includes(value)
            && kind === 'import' && node.specifiers.length > 0
            && node.specifiers.every(specifier => specifier.importKind === 'type'
              || (specifier.type === 'ImportSpecifier' && ['spawn', 'spawnSync'].includes(specifier.imported.name ?? specifier.imported.value)));
          if (!allowed) {
            report(node, 'rawCommandEntry');
          }
        }
        if (mode === 'permission' && isCommandModule({ value, filename })) {
          if (inDocs) {
            report(node, 'docsCommand');
          }
          if (kind !== 'import' || !node.specifiers.length || node.specifiers.some(specifier => specifier.importKind !== 'type'
            && (specifier.type !== 'ImportSpecifier' || !runnerNames.has(specifier.imported.name ?? specifier.imported.value)))) {
            report(node, 'runnerEscape');
          }
        }
      }

      function references({ variable, messageId, validate }) {
        for (const reference of variable?.references ?? []) {
          if (reference.vueUsedInTemplate || !isRuntimeReference({ reference })) {
            continue;
          }
          const expression = outerExpression({ node: reference.identifier });
          const call = expression.parent;
          if (call?.type !== 'CallExpression' || call.callee !== expression || call.optional || !validate(call)) {
            report(reference.identifier, messageId);
          }
        }
      }

      function checkMock({ node }) {
        const target = node.arguments[0];
        const value = target?.type === 'ImportExpression' ? string(target.source) : string(target);
        const messageId = mode === 'raw' && isRawModule({ value }) ? 'rawCommandEntry'
          : mode === 'permission' && isCommandModule({ value, filename }) ? 'runnerEscape' : undefined;
        if (!messageId) {
          return;
        }
        const factory = unwrap({ node: node.arguments[1] });
        // The mock target string is not a load. Calling/passing importOriginal
        // in a factory does acquire the raw module and is a separate entry.
        if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(factory?.type)) {
          return;
        }
        for (const variable of sourceCode.getDeclaredVariables(factory)) {
          if (variable.defs.some(definition => definition.type === 'Parameter')) {
            for (const reference of variable.references) {
              if (isRuntimeReference({ reference })) {
                report(reference.identifier, messageId);
              }
            }
          }
        }
      }

      const visitors = {
        Program(node) {
          if (mode !== 'permission') {
            return;
          }
          const firstCode = node.body[0]?.range[0] ?? Infinity;
          const keys = new Set();
          for (const comment of sourceCode.getAllComments()) {
            if (comment.type !== 'Line' || !comment.value.includes('ALLOW-EXTERNAL-COMMAND')) {
              continue;
            }
            if (comment.range[0] >= firstCode) {
              report(comment, 'misplacedPermission');
              continue;
            }
            const raw = sourceCode.text.slice(...comment.range);
            const lineStart = Math.max(...['\n', '\r', '\u2028', '\u2029'].map(newline => sourceCode.text.lastIndexOf(newline, comment.range[0] - 1))) + 1;
            const match = /^\/\/ !!! ALLOW-EXTERNAL-COMMAND ([^\s*]+(?: [^\s*]+)*):\* !!! -- (\S[^\n\r\u2028\u2029]*)$/u.exec(raw);
            if (!match || sourceCode.text.slice(lineStart, comment.range[0]).trim()) {
              report(comment, 'malformedPermission');
              continue;
            }
            const tokens = match[1].split(' ');
            const key = JSON.stringify(tokens);
            if (keys.has(key)) {
              report(comment, 'duplicatePermission');
              continue;
            }
            keys.add(key);
            permissions.push({ tokens, comment });
          }
        },
        ImportDeclaration(node) {
          if (!hasRuntimeImport({ node })) {
            return;
          }
          const value = string(node.source);
          checkModule({ node, value, kind: 'import' });
          for (const specifier of node.specifiers) {
            if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') {
              continue;
            }
            const imported = specifier.imported.name ?? specifier.imported.value;
            const variable = findVariable({ sourceCode, node: specifier.local, name: specifier.local.name });
            if (mode === 'permission' && isCommandModule({ value, filename }) && runnerNames.has(imported)) {
              runnerBindings.add(variable);
            }
            if (mode === 'raw' && trusted && ['node:child_process', 'child_process'].includes(value)
              && ['spawn', 'spawnSync'].includes(imported)) {
              trustedImports.push({ imported, variable });
            }
          }
        },
        ExportNamedDeclaration(node) {
          if (node.source && hasRuntimeImport({ node })) {
            checkModule({ node, value: string(node.source), kind: 'export' });
          }
        },
        ExportAllDeclaration(node) {
          if (hasRuntimeImport({ node })) {
            checkModule({ node, value: string(node.source), kind: 'export' });
          }
        },
        ImportExpression(node) {
          const parent = node.parent;
          // Vitest removes this import-promise mock overload before evaluation.
          if (parent?.type === 'CallExpression' && parent.arguments[0] === node
            && ['vi.mock', 'vi.doMock'].includes(resolve(parent.callee))) {
            return;
          }
          checkModule({ node, value: string(node.source), kind: 'dynamic' });
        },
        TSImportEqualsDeclaration(node) {
          if (node.importKind !== 'type' && node.moduleReference.type === 'TSExternalModuleReference') {
            checkModule({ node, value: string(node.moduleReference.expression), kind: 'require' });
          }
        },
        MemberExpression(node) {
          if (mode === 'raw' && resolve(node) === 'raw-entry') {
            report(node, 'rawCommandEntry');
          }
        },
        Identifier(node) {
          if (mode !== 'permission' || !hasTemplate || !runnerBindings.size) {
            return;
          }
          let inTemplate = false;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.type === 'VExpressionContainer') {
              inTemplate = true;
              break;
            }
          }
          if (!inTemplate || !runnerBindings.has(findVariable({ sourceCode, node, name: node.name }))) {
            return;
          }
          const expression = outerExpression({ node });
          const parent = expression.parent;
          if (parent?.type !== 'CallExpression' || parent.callee !== expression || parent.optional) {
            report(node, 'runnerEscape');
          }
        },
        NewExpression(node) {
          if (mode === 'raw' && resolve(node.callee) === 'raw-entry') {
            report(node, 'rawCommandEntry');
          }
        },
        TaggedTemplateExpression(node) {
          if (mode === 'raw' && resolve(node.tag) === 'raw-entry') {
            report(node, 'rawCommandEntry');
          }
        },
        CallExpression(node) {
          const capability = resolve(node.callee);
          if (['require', 'loader', 'module-resolver', 'process.getBuiltinModule', 'vi.importActual', 'vi.importMock'].includes(capability)) {
            checkModule({ node, value: string(node.arguments[0]), kind: 'load' });
          }
          if (mode === 'raw' && (capability === 'raw-entry'
            || (['process.binding', 'process._linkedBinding'].includes(capability)
              && ['spawn_sync', 'process_wrap', 'pipe_wrap', 'child_process'].includes(string(node.arguments[0]))))) {
            report(node, 'rawCommandEntry');
          }
          if (['vi.mock', 'vi.doMock'].includes(capability)) {
            checkMock({ node });
          }
          if (mode !== 'permission' || capability !== 'runner') {
            return;
          }
          const callee = unwrap({ node: node.callee });
          if (callee?.type !== 'Identifier' || !runnerBindings.has(findVariable({ sourceCode, node: callee, name: callee.name }))) {
            report(node, 'runnerEscape');
            return;
          }
          const argv = runnerArgv({ node, sourceCode });
          if (!argv || argv[0]?.type !== 'Literal' || typeof argv[0].value !== 'string' || !argv[0].value) {
            report(node, 'invalidRunnerCall');
            return;
          }
          const matching = permissions.filter(permission => permission.tokens.length <= argv.length
            && permission.tokens.every((token, index) => argv[index]?.type === 'Literal' && argv[index].value === token));
          if (!matching.length) {
            report(node, permissions.length ? 'mismatchedPermission' : 'missingPermission');
            return;
          }
          const longest = Math.max(...matching.map(permission => permission.tokens.length));
          matching.filter(permission => permission.tokens.length === longest).forEach(permission => usedPermissions.add(permission));
        },
        'Program:exit'() {
          if (mode === 'permission') {
            for (const variable of runnerBindings) {
              references({ variable, messageId: 'runnerEscape', validate: () => true });
            }
            for (const permission of permissions) {
              if (!usedPermissions.has(permission)) {
                report(permission.comment, 'unusedPermission');
              }
            }
          }
          if (mode === 'raw') {
            const calls = new Map();
            for (const { imported, variable } of trustedImports) {
              references({ variable, messageId: 'rawCommandEntry', validate(call) {
                const expected = imported === 'spawn' ? 'runCommand' : 'runCommandSync';
                const fn = nearestFunction({ node: call });
                const count = (calls.get(imported) ?? 0) + 1;
                calls.set(imported, count);
                return fn?.type === 'FunctionDeclaration' && fn.id?.name === expected
                  && fn.parent.type === 'ExportNamedDeclaration' && count === 1;
              } });
            }
          }
        },
      };
      return sourceCode.parserServices?.defineTemplateBodyVisitor
        ? sourceCode.parserServices.defineTemplateBodyVisitor(visitors, visitors)
        : visitors;
    },
  };
}

export const noUnapprovedCommandEntry = makeRule({ mode: 'raw' });
export const requireCommandPermission = makeRule({ mode: 'permission' });

export default {
  name: 'naidan/external-command-policy',
  files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}'],
  plugins: {
    'local-rules-external-command': {
      rules: {
        'no-unapproved-command-entry': noUnapprovedCommandEntry,
        'require-command-permission': requireCommandPermission,
      },
    },
  },
  rules: {
    'local-rules-external-command/no-unapproved-command-entry': 'error',
    'local-rules-external-command/require-command-permission': 'error',
  },
};
