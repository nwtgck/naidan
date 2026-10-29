import { physicalPath, hasRuntimeImport } from './external-command-ast.js';
import { isTestFile, isTestSupportFile, unwrap } from './test-resource-ast.js';
import { createEnvResolver, isProcessModule, isRegistryModule, isTypePosition, registryPath, registryConsumers } from './node-env-ast.js';

const readerName = /^READ_ENV_[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Audit Node environment reads in one lazy, read-only registry; forbid raw reads and writes everywhere else.' },
    schema: [],
    messages: {
      directEnvironment: 'Read Node environment variables through named READ_ENV_*() functions in build/node-env.ts. Direct access, mutation and environment-object extraction are forbidden.',
      registryShape: 'Only export const READ_ENV_FOO = () => process.env.FOO; is allowed in build/node-env.ts. Names must match; no defaults, wrappers, writes or snapshots.',
      dynamicProcessKey: 'The property of a Node process must be statically known and must not access env or loadEnvFile.',
      processReflection: 'Do not read or modify the Node environment through process reflection, rest destructuring or bulk mutation.',
      processModule: 'Do not dynamically load or re-export the process module. Use static imports of non-environment members instead.',
      registryImport: 'Only approved Node callers may import named READ_ENV_* functions directly from build/node-env.ts; no aliases, namespaces, loaders or re-exports.',
      testStubOnly: 'Environment stubs and restoration belong only in *.test.ts or *.test-support.ts. Restore stubs after the test.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const filename = context.physicalFilename ?? context.filename;
    const file = physicalPath({ filename });
    const registry = file === registryPath;
    const test = isTestFile({ filename }) || isTestSupportFile({ filename });
    const { resolve, isProcess, name, string, builtin, select } = createEnvResolver({ sourceCode });
    const allowedReads = new WeakSet();
    const reported = new WeakMap();
    function report({ node, messageId }) {
      if (reported.get(node)?.has(messageId)) {
        return;
      }
      const ids = reported.get(node) ?? new Set();
      ids.add(messageId);
      reported.set(node, ids);
      context.report({ node, messageId });
    }
    function checkValue({ node }) {
      if (allowedReads.has(node) || isTypePosition({ node })) {
        return;
      }
      const value = resolve(node);
      if (value === 'environment' || value === 'environment-writer') {
        report({ node, messageId: 'directEnvironment' });
      }
      if (!test && ['vi.stubEnv', 'vi.unstubAllEnvs'].includes(value)) {
        report({ node, messageId: 'testStubOnly' });
      }
    }
    function checkRegistry({ program }) {
      for (const statement of program.body) {
        if (statement.type === 'EmptyStatement') {
          continue;
        }
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined;
        const entry = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' && !declaration.declare
          && declaration.declarations.length === 1 ? declaration.declarations[0] : undefined;
        const fn = entry?.init;
        const body = fn?.body;
        const env = body?.object;
        const valid = entry?.id.type === 'Identifier' && !entry.id.typeAnnotation && readerName.test(entry.id.name)
          && fn?.type === 'ArrowFunctionExpression' && fn.params.length === 0 && !fn.async && !fn.returnType && !fn.typeParameters
          && body?.type === 'MemberExpression' && !body.computed && !body.optional && body.property.type === 'Identifier'
          && entry.id.name === `READ_ENV_${body.property.name}`
          && env?.type === 'MemberExpression' && !env.computed && !env.optional && env.property.type === 'Identifier' && env.property.name === 'env'
          && env.object.type === 'Identifier' && env.object.name === 'process' && resolve(env.object) === 'process';
        if (valid) {
          allowedReads.add(env);
        } else {
          report({ node: statement, messageId: 'registryShape' });
        }
      }
    }
    function pattern({ node, owner, emit }) {
      if (!node || !owner) {
        return;
      }
      if (node.type === 'AssignmentPattern') {
        pattern({ node: node.left, owner, emit });
      }
      if (node.type === 'ObjectPattern') {
        for (const property of node.properties) {
          if (property.type === 'RestElement') {
            if (owner === 'process') {
              emit({ node: property, messageId: 'processReflection' });
            }
            continue;
          }
          const key = name(property);
          const value = select({ owner, key });
          if (owner === 'process' && key === undefined) {
            emit({ node: property, messageId: 'dynamicProcessKey' });
          }
          if (value === 'environment' || value === 'environment-writer') {
            emit({ node: property, messageId: 'directEnvironment' });
          }
          if (!test && ['vi.stubEnv', 'vi.unstubAllEnvs'].includes(value)) {
            emit({ node: property, messageId: 'testStubOnly' });
          }
          pattern({ node: property.value, owner: value, emit });
        }
      }
    }
    function checkPattern({ node, value, otherOwner }) {
      const processReports = [];
      const otherReports = [];
      // Reuse the diagnostic walk rather than maintaining a second property
      // allowlist. Skip type queries only if NEITHER possible owner can report.
      // A typed Process takes precedence over lexical provenance, even when
      // only that other provenance would produce a diagnostic.
      pattern({ node, owner: 'process', emit: descriptor => processReports.push(descriptor) });
      pattern({ node, owner: otherOwner, emit: descriptor => otherReports.push(descriptor) });
      if (processReports.length === 0 && otherReports.length === 0) {
        return;
      }
      for (const descriptor of isProcess(value) ? processReports : otherReports) {
        report(descriptor);
      }
    }
    function checkParameters(node) {
      for (const parameter of node.params) {
        if (parameter.type === 'ObjectPattern') {
          checkPattern({ node: parameter, value: parameter, otherOwner: undefined });
        } else if (parameter.type === 'AssignmentPattern') {
          checkPattern({ node: parameter, value: parameter.right, otherOwner: undefined });
        }
      }
    }
    function checkModule({ node, value, kind }) {
      if (isRegistryModule({ value, filename })) {
        const valid = kind === 'import' && registryConsumers.has(file) && node.specifiers.length > 0
          && node.specifiers.every(specifier => specifier.type === 'ImportSpecifier'
            && readerName.test(specifier.imported.name ?? specifier.imported.value)
            && specifier.local.name === (specifier.imported.name ?? specifier.imported.value));
        if (!valid) {
          report({ node, messageId: 'registryImport' });
        }
      }
      if (isProcessModule({ value })) {
        if (kind === 'load' || kind === 'export' && (node.type === 'ExportAllDeclaration'
          || node.specifiers.some(specifier => ['default', 'env', 'loadEnvFile'].includes(specifier.local?.name ?? specifier.local?.value)))) {
          report({ node, messageId: 'processModule' });
        }
        if (kind === 'import' && node.specifiers.some(specifier => specifier.importKind !== 'type'
          && ['env', 'loadEnvFile'].includes(specifier.imported?.name ?? specifier.imported?.value))) {
          report({ node, messageId: 'directEnvironment' });
        }
      }
    }
    const visitors = {
      Program(node) {
        if (registry) {
          checkRegistry({ program: node });
        }
      },
      ImportDeclaration(node) {
        if (hasRuntimeImport({ node })) {
          checkModule({ node, value: string(node.source), kind: 'import' });
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.importKind !== 'type' && node.moduleReference.type === 'TSExternalModuleReference') {
          checkModule({ node, value: string(node.moduleReference.expression), kind: 'load' });
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && hasRuntimeImport({ node })) {
          checkModule({ node, value: string(node.source), kind: 'export' });
        }
        if (!node.source && node.exportKind !== 'type') {
          for (const specifier of node.specifiers) {
            if (specifier.exportKind !== 'type' && isProcess(specifier.local)) {
              report({ node: specifier, messageId: 'processModule' });
            }
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (isProcess(node.declaration)) {
          report({ node, messageId: 'processModule' });
        }
      },
      ExportAllDeclaration(node) {
        if (hasRuntimeImport({ node })) {
          checkModule({ node, value: string(node.source), kind: 'export' });
        }
      },
      ImportExpression(node) {
        checkModule({ node, value: string(node.source), kind: 'load' });
      },
      MemberExpression(node) {
        const key = name(node);
        // Most members have no relation to environment access. In particular,
        // avoid asking TypeScript for every property in large application files.
        if (key !== undefined && !['env', 'loadEnvFile', 'stubEnv', 'unstubAllEnvs'].includes(key)) {
          return;
        }
        checkValue({ node });
        if (isTypePosition({ node })) {
          return;
        }
        if (isProcess(node.object)) {
          if (!allowedReads.has(node) && ['env', 'loadEnvFile'].includes(name(node))) {
            report({ node, messageId: 'directEnvironment' });
          } else if (name(node) === undefined) {
            report({ node, messageId: 'dynamicProcessKey' });
          }
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === 'ObjectPattern') {
          checkPattern({ node: node.id, value: node.init, otherOwner: resolve(node.init) });
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === 'ObjectPattern') {
          checkPattern({ node: node.left, value: node.right, otherOwner: resolve(node.right) });
        }
      },
      FunctionDeclaration: checkParameters,
      ArrowFunctionExpression: checkParameters,
      FunctionExpression: checkParameters,
      CallExpression(node) {
        let called = unwrap({ node: node.callee });
        let args = node.arguments;
        if (called?.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(name(called))) {
          const kind = name(called);
          called = unwrap({ node: called.object });
          const supplied = unwrap({ node: args[1] });
          args = kind === 'apply' ? supplied?.type === 'ArrayExpression' ? supplied.elements : [] : args.slice(1);
        }
        const callee = resolve(called);
        if (['require', 'loader', 'builtin-loader', 'vi.importActual', 'vi.importMock'].includes(callee)) {
          checkModule({ node, value: string(args[0]), kind: 'load' });
        }
        const api = builtin(called);
        const propertyApis = ['Reflect.get', 'Reflect.set', 'Reflect.deleteProperty', 'Reflect.defineProperty', 'Reflect.getOwnPropertyDescriptor', 'Reflect.has', 'Object.defineProperty', 'Object.getOwnPropertyDescriptor'];
        const bulkApis = ['Object.assign', 'Object.defineProperties', 'Object.getOwnPropertyDescriptors', 'Object.entries', 'Object.values', 'Object.setPrototypeOf', 'Reflect.setPrototypeOf', 'JSON.stringify'];
        if (called?.type === 'MemberExpression' && ['__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(name(called))
          && isProcess(called.object) && (string(args[0]) === undefined || string(args[0]) === 'env')) {
          report({ node, messageId: 'processReflection' });
        }
        if (!propertyApis.includes(api) && !bulkApis.includes(api) && resolve(called) !== 'vi.spyOn') {
          return;
        }
        if (!isProcess(args[0])) {
          return;
        }
        if (propertyApis.includes(api) || resolve(called) === 'vi.spyOn') {
          const key = string(args[1]);
          if (key === undefined || ['env', 'loadEnvFile'].includes(key)) {
            report({ node, messageId: 'processReflection' });
          }
        }
        if (bulkApis.includes(api)) {
          report({ node, messageId: 'processReflection' });
        }
      },
    };
    return sourceCode.parserServices?.defineTemplateBodyVisitor
      ? sourceCode.parserServices.defineTemplateBodyVisitor(visitors, visitors)
      : visitors;
  },
};

export default /** @satisfies {import('eslint').Linter.Config} */ ({
  name: 'naidan/node-env-policy',
  files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}'],
  plugins: { 'local-rules-node-env': { rules: { 'node-env-policy': rule } } },
  rules: { 'local-rules-node-env/node-env-policy': 'error' },
});
