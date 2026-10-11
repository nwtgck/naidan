import { builtinName, isTestFile, isTestSupportFile, propertyName, staticString, unwrap } from './test-resource-ast.js';

const protocolNames = new Set(['dispose', 'asyncDispose']);
const runtimeNames = new Set(['DisposableStack', 'AsyncDisposableStack', 'SuppressedError']);
const replacementNames = new Set(['Symbol', ...runtimeNames]);
const registryNames = new Set(['Symbol.dispose', 'Symbol.asyncDispose']);

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep explicit resource management in tests, without runtime polyfills.' },
    schema: [],
    messages: {
      usingOnlyInTest: 'using / await using are allowed only in *.test.ts, never in *.test-support.ts or .vue.',
      protocolOnlyInTest: 'Disposal symbols/runtime APIs belong only in *.test.ts or *.test-support.ts, never production or .vue. Symbol property keys must be statically known outside tests.',
      noPolyfill: 'Do not polyfill or replace explicit resource-management symbols or runtime APIs, including in tests. Use a compatible test runtime.',
    },
  },
  create(context) {
    // Processors may name a virtual script *.test.ts; permissions belong to the physical file.
    const filename = context.physicalFilename ?? context.filename;
    const sourceCode = context.sourceCode;
    const isTest = isTestFile({ filename });
    const allowedProtocol = isTest || isTestSupportFile({ filename });
    const builtin = node => builtinName({ node, sourceCode });
    const name = node => propertyName({ node, sourceCode });
    const string = node => staticString({ node, sourceCode });
    const protocol = node => node?.type === 'MemberExpression' && builtin(node.object) === 'Symbol' && (protocolNames.has(name(node)) || (node.computed && name(node) === undefined));
    const report = (node, messageId) => context.report({ node, messageId });
    const polyfillImport = node => {
      const value = string(node);
      if (value && /(?:core-js(?:-pure)?(?:\/(?:index|stable|actual|full)(?:\/index)?(?:\.js)?\/?|\/)?$|core-js(?:-pure)?\/.*(?:dispos|explicit-resource|suppressed-error)|(?:^|\/)(?:disposablestack|asyncdisposablestack|suppressed-error)\/.*(?:polyfill|shim)|@esfx\/disposable)/u.test(value)) report(node, 'noPolyfill');
    };
    const writeTarget = node => {
      node = unwrap({ node });
      if (!node) return;
      if (protocol(node) || replacementNames.has(builtin(node))) report(node, 'noPolyfill');
      if (node.type === 'ArrayPattern') node.elements.forEach(writeTarget);
      if (node.type === 'ObjectPattern') node.properties.forEach(property => writeTarget(property.value ?? property.argument));
      if (node.type === 'AssignmentPattern') writeTarget(node.left);
    };
    const destructure = (pattern, value, node) => {
      if (builtin(value) !== 'Symbol' || pattern?.type !== 'ObjectPattern') return;
      if (!allowedProtocol && pattern.properties.some(property => property.type === 'Property' && (protocolNames.has(name(property)) || (property.computed && name(property) === undefined)))) report(node, 'protocolOnlyInTest');
    };
    const visitors = {
      VariableDeclaration(node) {
        if (!isTest && (node.kind === 'using' || node.kind === 'await using')) report(node, 'usingOnlyInTest');
      },
      MemberExpression(node) {
        if (!allowedProtocol && (protocol(node) || runtimeNames.has(builtin(node)))) report(node, 'protocolOnlyInTest');
      },
      Identifier(node) {
        if (allowedProtocol || !runtimeNames.has(node.name)) return;
        // Identifier keys and declarations are not reads of a global runtime API.
        const parent = node.parent;
        if ((parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
          || ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key === node && !parent.computed && !parent.shorthand)) return;
        if (builtin(node) === node.name) report(node, 'protocolOnlyInTest');
      },
      TSQualifiedName(node) {
        if (!allowedProtocol && builtin(node.left) === 'Symbol' && protocolNames.has(node.right.name)) report(node, 'protocolOnlyInTest');
      },
      TSIndexedAccessType(node) {
        if (!allowedProtocol && node.objectType.type === 'TSTypeQuery' && builtin(node.objectType.exprName) === 'Symbol'
          && node.indexType.type === 'TSLiteralType' && protocolNames.has(string(node.indexType.literal))) report(node, 'protocolOnlyInTest');
      },
      VariableDeclarator(node) { destructure(node.id, node.init, node); },
      AssignmentExpression(node) {
        writeTarget(node.left);
        destructure(node.left, node.right, node);
      },
      UpdateExpression(node) { writeTarget(node.argument); },
      UnaryExpression(node) { if (node.operator === 'delete') writeTarget(node.argument); },
      CallExpression(node) {
        const callee = unwrap({ node: node.callee });
        if (callee?.type === 'MemberExpression' && name(callee) === 'stubGlobal'
          && ['Symbol', ...runtimeNames].includes(string(node.arguments[0]))) report(node, 'noPolyfill');
        if (builtin(callee) === 'Symbol' && registryNames.has(string(node.arguments[0]))) report(node, 'noPolyfill');
        if (builtin(callee) === 'require') node.arguments.forEach(polyfillImport);
        const resolved = builtin(callee);
        const separator = resolved?.lastIndexOf('.') ?? -1;
        const owner = separator >= 0 ? resolved.slice(0, separator) : callee?.type === 'MemberExpression' ? builtin(callee.object) : undefined;
        const method = separator >= 0 ? resolved.slice(separator + 1) : callee?.type === 'MemberExpression' ? name(callee) : undefined;
        if (owner === 'Symbol' && method === 'for' && registryNames.has(string(node.arguments[0]))) report(node, 'noPolyfill');
        if (!['Object', 'Reflect'].includes(owner)) return;
        const target = node.arguments[0];
        const key = string(node.arguments[1]);
        if (builtin(target) === 'Symbol' && (protocolNames.has(key) || key === undefined)) {
          if (['defineProperty', 'set', 'deleteProperty'].includes(method)) report(node, 'noPolyfill');
          else if (!allowedProtocol && ['get', 'has', 'hasOwn', 'getOwnPropertyDescriptor'].includes(method)) report(node, 'protocolOnlyInTest');
        }
        if (builtin(target) === 'Symbol' && ['defineProperties', 'assign'].includes(method)) {
          // Spreads/dynamic descriptor objects cannot establish that a protocol is untouched.
          const argumentsToCheck = node.arguments.slice(1);
          if (argumentsToCheck.some(argument => argument.type !== 'ObjectExpression'
            || argument.properties.some(property => property.type !== 'Property' || protocolNames.has(name(property)) || (property.computed && name(property) === undefined)))) report(node, 'noPolyfill');
        }
        if (['globalThis', 'window', 'self', 'global'].includes(builtin(target)) && replacementNames.has(key)
          && ['defineProperty', 'set'].includes(method)) report(node, 'noPolyfill');
        if (['globalThis', 'window', 'self', 'global'].includes(builtin(target)) && ['defineProperties', 'assign'].includes(method)
          && node.arguments.slice(1).some(argument => argument.type !== 'ObjectExpression'
            || argument.properties.some(property => property.type !== 'Property' || replacementNames.has(name(property))
              || (property.computed && name(property) === undefined)))) report(node, 'noPolyfill');
      },
      ImportDeclaration(node) { polyfillImport(node.source); },
      ImportExpression(node) { polyfillImport(node.source); },
      TSExternalModuleReference(node) { polyfillImport(node.expression); },
      ExportNamedDeclaration(node) { polyfillImport(node.source); },
      ExportAllDeclaration(node) { polyfillImport(node.source); },
    };
    // Template event handlers can contain DECLARATIONS as well as expressions.
    return sourceCode.parserServices?.defineTemplateBodyVisitor
      ? sourceCode.parserServices.defineTemplateBodyVisitor(visitors, visitors)
      : visitors;
  },
};

export default {
  files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}'],
  plugins: { 'local-rules-test-resource': { rules: { 'test-resource-management': rule } } },
  rules: { 'local-rules-test-resource/test-resource-management': 'error' },
};
