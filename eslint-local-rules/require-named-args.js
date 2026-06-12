function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function isThisParameter(node) {
  return node?.type === 'Identifier' && node.name === 'this';
}

function isRecordNeverNeverParameter(node, sourceCode) {
  if (node?.type !== 'Identifier') {
    return false;
  }

  const typeAnnotation = node.typeAnnotation?.typeAnnotation;
  if (!typeAnnotation) {
    return false;
  }

  return [
    'Record<never, never>',
    'EmptyArgs',
  ].includes(normalizeWhitespace(sourceCode.getText(typeAnnotation)));
}

function isObjectDestructuringParameter(node) {
  return (
    node?.type === 'ObjectPattern' ||
    (node?.type === 'AssignmentPattern' && node.left?.type === 'ObjectPattern')
  );
}

function isTypePredicateReturnType(node) {
  const returnType = node.returnType?.typeAnnotation;
  return returnType?.type === 'TSTypePredicate';
}

function isDefineEmitsCallee(callee) {
  return (
    isIdentifier(callee, 'defineEmits') ||
    (
      callee?.type === 'MemberExpression' &&
      isIdentifier(callee.property, 'defineEmits')
    )
  );
}

function isInsideDefineEmitsType(node, sourceCode) {
  const ancestors = sourceCode.getAncestors(node);

  return ancestors.some((ancestor) => (
    ancestor.type === 'CallExpression' &&
    isDefineEmitsCallee(ancestor.callee)
  ));
}

function isDirectCallArgument(node) {
  const parent = node.parent;

  return (
    (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
    parent.arguments.includes(node)
  );
}

function getFunctionParams(node) {
  if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
    return node.value?.params ?? [];
  }

  return (node.params ?? []).filter((param) => !isThisParameter(param));
}

function isAllowedSignature({ node, params, sourceCode }) {
  if (params.length === 0) {
    return true;
  }

  if (isTypePredicateReturnType(node)) {
    return true;
  }

  if (params.length !== 1) {
    return false;
  }

  const [onlyParam] = params;

  return (
    isRecordNeverNeverParameter(onlyParam, sourceCode) ||
    isObjectDestructuringParameter(onlyParam)
  );
}

function checkFunctionLike(node, context) {
  const sourceCode = context.sourceCode;

  if (isInsideDefineEmitsType(node, sourceCode)) {
    return;
  }

  if (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    isDirectCallArgument(node)
  ) {
    return;
  }

  const params = getFunctionParams(node);

  if (isAllowedSignature({ node, params, sourceCode })) {
    return;
  }

  context.report({
    node,
    messageId: 'requireNamedArgs',
  });
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require Naidan-defined callables to use Swift-style named args.',
    },
    schema: [],
    messages: {
      requireNamedArgs: 'Naidan-defined callables must use no args, Record<never, never> / EmptyArgs, or a single destructured object parameter.',
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        checkFunctionLike(node, context);
      },
      FunctionExpression(node) {
        checkFunctionLike(node, context);
      },
      ArrowFunctionExpression(node) {
        checkFunctionLike(node, context);
      },
      TSFunctionType(node) {
        checkFunctionLike(node, context);
      },
      TSCallSignatureDeclaration(node) {
        checkFunctionLike(node, context);
      },
      TSConstructSignatureDeclaration(node) {
        checkFunctionLike(node, context);
      },
      TSMethodSignature(node) {
        checkFunctionLike(node, context);
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  plugins: {
    'local-rules-named-args': {
      rules: {
        'require-named-args': rule,
      },
    },
  },
  rules: {
    'local-rules-named-args/require-named-args': 'error',
  },
};
