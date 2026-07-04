import ts from 'typescript';

const FIXED_INPUT_STATUS = {
  dynamic: 'dynamic',
  value: 'value',
  void: 'void',
};

function getParserServices(context) {
  const parserServices = context.sourceCode?.parserServices ?? context.parserServices;

  if (!parserServices?.program || !parserServices?.esTreeNodeToTSNodeMap) {
    return undefined;
  }

  return parserServices;
}

function normalizePath(filePath = '') {
  return filePath.replace(/\\/gu, '/');
}

function isPromiseAllKeyedCompatibilityFile({ filePath }) {
  return normalizePath(filePath).endsWith('/src/utils/promise.ts');
}

function unwrapExpression(node) {
  let current = node;

  while ([
    'ChainExpression',
    'TSAsExpression',
    'TSNonNullExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
  ].includes(current?.type)) {
    current = current.expression;
  }

  return current;
}

function getStaticMemberPropertyName(memberExpression) {
  const property = memberExpression.property;

  if (!memberExpression.computed && property?.type === 'Identifier') {
    return property.name;
  }

  if (memberExpression.computed && property?.type === 'Literal' && typeof property.value === 'string') {
    return property.value;
  }

  if (
    memberExpression.computed &&
    property?.type === 'TemplateLiteral' &&
    property.expressions.length === 0
  ) {
    return property.quasis[0]?.value.cooked;
  }

  return undefined;
}

function getPromiseAllInput(node) {
  const expression = unwrapExpression(node);
  if (expression?.type !== 'CallExpression' || expression.arguments.length !== 1) {
    return undefined;
  }

  const callee = unwrapExpression(expression.callee);
  if (
    callee?.type !== 'MemberExpression' ||
    callee.object?.type !== 'Identifier' ||
    callee.object.name !== 'Promise' ||
    getStaticMemberPropertyName(callee) !== 'all'
  ) {
    return undefined;
  }

  const inputExpression = unwrapExpression(expression.arguments[0]);
  if (!inputExpression || inputExpression.type === 'SpreadElement') {
    return undefined;
  }

  return {
    callExpression: expression,
    inputExpression,
    promiseIdentifier: callee.object,
  };
}

function isTypeScriptLibDeclaration(declaration) {
  const sourceFile = declaration.getSourceFile();
  const normalizedFileName = sourceFile.fileName.replaceAll('\\', '/');

  return (
    sourceFile.hasNoDefaultLib === true ||
    /\/typescript\/lib\/lib\..*\.d\.ts$/u.test(normalizedFileName) ||
    /\/lib\/lib\..*\.d\.ts$/u.test(normalizedFileName)
  );
}

function isBuiltInPromise({ checker, promiseIdentifier, services }) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(promiseIdentifier);
  if (!tsNode) return false;

  const symbol = checker.getSymbolAtLocation(tsNode);
  return Boolean(symbol?.declarations?.some(isTypeScriptLibDeclaration));
}

function isFunctionExpressionNode(node) {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression'
  );
}

function isInsidePromiseAllKeyedCompatibilityFunction({ filePath, node }) {
  if (!isPromiseAllKeyedCompatibilityFile({ filePath })) {
    return false;
  }

  let current = node.parent;

  while (current && !isFunctionExpressionNode(current)) {
    current = current.parent;
  }

  return (
    current?.type === 'FunctionDeclaration' &&
    current.id?.name === 'promiseAllKeyed' &&
    current.parent?.type === 'ExportNamedDeclaration'
  );
}

function isVoidLikeType(type) {
  if (type.isUnion?.()) {
    return type.types.every(isVoidLikeType);
  }

  const flags = type.getFlags();
  const allowedFlags = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never;
  return (flags & allowedFlags) !== 0;
}

function typeProducesOnlyVoid({ checker, type }) {
  const awaitedType = checker.getAwaitedType(type);
  return awaitedType !== undefined && isVoidLikeType(awaitedType);
}

function expressionProducesOnlyVoid({ checker, expression, services }) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(unwrapExpression(expression));
  if (!tsNode) return false;

  return typeProducesOnlyVoid({
    checker,
    type: checker.getTypeAtLocation(tsNode),
  });
}

function getFixedTupleElementTypes({ checker, expression, services }) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(unwrapExpression(expression));
  if (!tsNode) return undefined;

  const type = checker.getTypeAtLocation(tsNode);
  const unionMembers = type.isUnion?.() ? type.types : [type];
  const elementTypes = [];

  for (const unionMember of unionMembers) {
    if (!checker.isTupleType(unionMember)) {
      return undefined;
    }

    const elementFlags = unionMember.target?.elementFlags;
    if (
      !Array.isArray(elementFlags) ||
      elementFlags.some(flag => (flag & ts.ElementFlags.Variable) !== 0)
    ) {
      return undefined;
    }

    elementTypes.push(...checker.getTypeArguments(unionMember));
  }

  return elementTypes;
}

function getFixedInputStatus({ checker, expression, services }) {
  const inputExpression = unwrapExpression(expression);

  if (inputExpression?.type !== 'ArrayExpression') {
    const tupleElementTypes = getFixedTupleElementTypes({
      checker,
      expression: inputExpression,
      services,
    });

    if (!tupleElementTypes) {
      return FIXED_INPUT_STATUS.dynamic;
    }

    return tupleElementTypes.every(type => typeProducesOnlyVoid({ checker, type }))
      ? FIXED_INPUT_STATUS.void
      : FIXED_INPUT_STATUS.value;
  }

  let hasValueProducingElement = false;

  for (const element of inputExpression.elements) {
    if (element === null) {
      continue;
    }

    if (element.type === 'SpreadElement') {
      const spreadStatus = getFixedInputStatus({
        checker,
        expression: element.argument,
        services,
      });

      if (spreadStatus === FIXED_INPUT_STATUS.dynamic) {
        return FIXED_INPUT_STATUS.dynamic;
      }

      if (spreadStatus === FIXED_INPUT_STATUS.value) {
        hasValueProducingElement = true;
      }

      continue;
    }

    if (!expressionProducesOnlyVoid({ checker, expression: element, services })) {
      hasValueProducingElement = true;
    }
  }

  return hasValueProducingElement
    ? FIXED_INPUT_STATUS.value
    : FIXED_INPUT_STATUS.void;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require keyed aggregation for fixed Promise.all inputs that produce values.',
    },
    schema: [],
    messages: {
      requirePromiseAllKeyed: "Use promiseAllKeyed from '@/utils/promise' when a fixed set of concurrent operations produces values. Promise.all is reserved for fixed void-producing operations and dynamic collections.",
    },
  },
  create(context) {
    const services = getParserServices(context);
    if (!services) return {};

    const checker = services.program.getTypeChecker();
    const filePath = context.filename ?? context.getFilename?.() ?? '';

    return {
      CallExpression(node) {
        const match = getPromiseAllInput(node);
        if (!match) return;

        if (!isBuiltInPromise({
          checker,
          promiseIdentifier: match.promiseIdentifier,
          services,
        })) {
          return;
        }

        if (isInsidePromiseAllKeyedCompatibilityFunction({ filePath, node })) {
          return;
        }

        const inputStatus = getFixedInputStatus({
          checker,
          expression: match.inputExpression,
          services,
        });

        if (inputStatus !== FIXED_INPUT_STATUS.value) return;

        context.report({
          node: match.callExpression,
          messageId: 'requirePromiseAllKeyed',
        });
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  plugins: {
    'local-rules-promise-all-keyed': {
      rules: {
        'require-promise-all-keyed': rule,
      },
    },
  },
  rules: {
    'local-rules-promise-all-keyed/require-promise-all-keyed': 'error',
  },
};
