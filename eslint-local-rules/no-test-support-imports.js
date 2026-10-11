import { builtinName, isTestFile, isTestOnlyModule, isTestSupportFile, propertyName, staticString } from './test-resource-ast.js';

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep test-only modules out of normal implementation modules.' },
    schema: [],
    messages: { forbidden: 'Only *.test.ts and *.test-support.ts may import test-only modules. Rename test support; never import it into production or .vue.' },
  },
  create(context) {
    // Processors may name a virtual script *.test.ts; permissions belong to the physical file.
    const filename = context.physicalFilename ?? context.filename;
    if (isTestFile({ filename }) || isTestSupportFile({ filename })) return {};
    const sourceCode = context.sourceCode;
    const check = node => {
      const value = staticString({ node, sourceCode });
      if (typeof value === 'string' && isTestOnlyModule({ value })) context.report({ node, messageId: 'forbidden' });
    };
    const visitors = {
      ImportDeclaration(node) { check(node.source); },
      ExportNamedDeclaration(node) { check(node.source); },
      ExportAllDeclaration(node) { check(node.source); },
      ImportExpression(node) { check(node.source); },
      TSImportType(node) { check(node.source); },
      TSExternalModuleReference(node) { check(node.expression); },
      CallExpression(node) {
        const callee = node.callee;
        if (['require', 'importScripts'].includes(builtinName({ node: callee, sourceCode }))) node.arguments.forEach(check);
        if (callee.type === 'MemberExpression' && propertyName({ node: callee, sourceCode }) === 'addModule') check(node.arguments[0]);
        if (callee.type === 'MemberExpression' && builtinName({ node: callee.object, sourceCode }) === 'require'
          && propertyName({ node: callee, sourceCode }) === 'resolve') check(node.arguments[0]);
        if (callee.type === 'MemberExpression' && ['glob', 'globEager'].includes(propertyName({ node: callee, sourceCode }))
          && callee.object.type === 'MetaProperty' && callee.object.meta.name === 'import') {
          const argument = node.arguments[0];
          if (argument?.type === 'ArrayExpression') argument.elements.forEach(check);
          else check(argument);
        }
      },
      NewExpression(node) {
        // URL literals include Worker, SharedWorker and worklet entry paths.
        if (['URL', 'Worker', 'SharedWorker'].includes(builtinName({ node: node.callee, sourceCode }))) check(node.arguments[0]);
      },
    };
    return sourceCode.parserServices?.defineTemplateBodyVisitor
      ? sourceCode.parserServices.defineTemplateBodyVisitor(visitors, visitors)
      : visitors;
  },
};

export default {
  files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}'],
  plugins: { 'local-rules-test-imports': { rules: { 'no-test-support-imports': rule } } },
  rules: { 'local-rules-test-imports/no-test-support-imports': 'error' },
};
