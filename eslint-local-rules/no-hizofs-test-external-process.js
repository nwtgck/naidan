import {
  getStaticString,
  isStaticRequireCall,
} from './hizofs-ast-guards.js';

const processModuleRoots = new Set([
  'child_process',
  'cross-spawn',
  'execa',
  'shelljs',
  'zx',
]);

function moduleRoot(specifier) {
  const withoutNodePrefix = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return withoutNodePrefix.split('/')[0];
}

function reportModule({ context, node, specifier }) {
  if (processModuleRoots.has(moduleRoot(specifier))) {
    context.report({ data: { specifier }, messageId: 'processModule', node });
  }
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent HizoFS test assets from launching external commands or processes.',
    },
    messages: {
      processModule: 'HizoFS tests must not import {{specifier}}; external command and process execution requires explicit user review.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        if (isStaticRequireCall({ node, sourceCode })) {
          const specifier = getStaticString(node.arguments[0]);
          if (specifier !== undefined) reportModule({ context, node, specifier });
          return;
        }
      },
      ImportDeclaration(node) {
        reportModule({ context, node, specifier: node.source.value });
      },
      ImportExpression(node) {
        const specifier = getStaticString(node.source);
        if (specifier !== undefined) reportModule({ context, node, specifier });
      },
    };
  },
};

export default {
  files: [
    'src/00-storage/service/hizofs/**/*.{test,spec,fixture,harness}.{js,mjs,cjs,ts,tsx}',
    'src/00-storage/service/hizofs/**/{test,tests,testing,fixture,fixtures,test-fixtures,harness,harnesses}/**/*.{js,mjs,cjs,ts,tsx}',
  ],
  plugins: {
    'local-rules-hizofs-test-process': {
      rules: {
        'no-external-process': rule,
      },
    },
  },
  rules: {
    'local-rules-hizofs-test-process/no-external-process': 'error',
  },
};
