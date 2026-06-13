import ts from 'typescript';

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

function getStaticPropertyName(node) {
  const key = node?.key ?? node?.property;

  if (key?.type === 'Identifier') {
    return key.name;
  }

  if (key?.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }

  return undefined;
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


function isAssignmentFunctionRhs(node) {
  const parent = node.parent;

  return (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    parent?.type === 'AssignmentExpression' &&
    parent.right === node
  );
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

function getObjectPropertyForFunction(node) {
  const parent = node.parent;

  if (parent?.type === 'Property' && parent.value === node) {
    return parent;
  }

  return undefined;
}

function getObjectExpressionCallParent(property) {
  const objectExpression = property?.parent;
  const callOrNew = objectExpression?.parent;

  if (objectExpression?.type !== 'ObjectExpression') {
    return undefined;
  }

  if (
    (callOrNew?.type === 'CallExpression' || callOrNew?.type === 'NewExpression') &&
    callOrNew.arguments.includes(objectExpression)
  ) {
    return callOrNew;
  }

  return undefined;
}

function getCalleeName(callee) {
  if (callee?.type === 'Identifier') {
    return callee.name;
  }

  if (callee?.type === 'MemberExpression') {
    const propertyName = getStaticPropertyName(callee);
    const objectName = callee.object?.type === 'Identifier' ? callee.object.name : undefined;

    return objectName && propertyName ? `${objectName}.${propertyName}` : propertyName;
  }

  return undefined;
}


function getParserServices(context) {
  const parserServices = context.sourceCode?.parserServices ?? context.parserServices;

  if (!parserServices?.program || !parserServices?.esTreeNodeToTSNodeMap) {
    return undefined;
  }

  return parserServices;
}

function isExternalDeclarationFile(fileName) {
  if (!fileName) {
    return false;
  }

  const normalized = fileName.replaceAll('\\', '/');

  return (
    normalized.includes('/node_modules/') ||
    /\/typescript\/lib\/lib\..*\.d\.ts$/.test(normalized) ||
    /\/lib\/lib\..*\.d\.ts$/.test(normalized)
  );
}

function getTypeParts(type) {
  if (!type) {
    return [];
  }

  return type.isUnion?.() ? type.types : [type];
}

function getCallSignatureDeclarations(type, checker) {
  const declarations = [];

  for (const typePart of getTypeParts(type)) {
    const candidateTypes = [typePart];
    const apparentType = checker.getApparentType(typePart);
    if (apparentType !== typePart) {
      candidateTypes.push(apparentType);
    }

    for (const candidateType of candidateTypes) {
      for (const signature of candidateType.getCallSignatures()) {
        const declaration = signature.getDeclaration();
        if (declaration) {
          declarations.push(declaration);
        }
      }
    }
  }

  return declarations;
}

function hasExternalDeclaration(declarations) {
  return declarations.some((declaration) => (
    isExternalDeclarationFile(declaration.getSourceFile().fileName)
  ));
}

function isExternalCallableType(type, checker) {
  return hasExternalDeclaration(getCallSignatureDeclarations(type, checker));
}

function getTsPropertyNameText(name) {
  if (!name) {
    return undefined;
  }

  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return undefined;
}

function getObjectLiteralContextualPropertySymbol({ checker, objectExpression, propertyName, location }) {
  const contextualType = checker.getContextualType(objectExpression);

  for (const typePart of getTypeParts(contextualType)) {
    const symbol = typePart.getProperty(propertyName);
    if (symbol) {
      return { symbol, location };
    }
  }

  return undefined;
}

function isObjectLiteralPropertyContextuallyExternal({ checker, tsNode }) {
  const propertyAssignment = ts.isArrowFunction(tsNode) || ts.isFunctionExpression(tsNode)
    ? tsNode.parent
    : tsNode;

  if (
    !ts.isMethodDeclaration(propertyAssignment) &&
    !ts.isPropertyAssignment(propertyAssignment)
  ) {
    return false;
  }

  if (!ts.isObjectLiteralExpression(propertyAssignment.parent)) {
    return false;
  }

  const propertyName = getTsPropertyNameText(propertyAssignment.name);
  if (!propertyName) {
    return false;
  }

  const contextualProperty = getObjectLiteralContextualPropertySymbol({
    checker,
    objectExpression: propertyAssignment.parent,
    propertyName,
    location: propertyAssignment.name,
  });

  if (!contextualProperty) {
    return false;
  }

  const { symbol, location } = contextualProperty;
  if (hasExternalDeclaration(symbol.getDeclarations() ?? [])) {
    return true;
  }

  const propertyType = checker.getTypeOfSymbolAtLocation(symbol, location);
  return isExternalCallableType(propertyType, checker);
}

function isClassMethodImplementingExternalSignature({ checker, tsNode }) {
  if (!ts.isMethodDeclaration(tsNode) || !ts.isClassDeclaration(tsNode.parent)) {
    return false;
  }

  const propertyName = getTsPropertyNameText(tsNode.name);
  if (!propertyName) {
    return false;
  }

  for (const heritageClause of tsNode.parent.heritageClauses ?? []) {
    for (const heritageType of heritageClause.types) {
      const implementedType = checker.getTypeAtLocation(heritageType);

      for (const typePart of getTypeParts(implementedType)) {
        const symbol = typePart.getProperty(propertyName);
        if (!symbol) {
          continue;
        }

        if (hasExternalDeclaration(symbol.getDeclarations() ?? [])) {
          return true;
        }

        const propertyType = checker.getTypeOfSymbolAtLocation(symbol, heritageType);
        if (isExternalCallableType(propertyType, checker)) {
          return true;
        }
      }
    }
  }

  return false;
}


function isInterfaceMethodExtendingExternalSignature({ checker, tsNode }) {
  if (!ts.isMethodSignature(tsNode) || !ts.isInterfaceDeclaration(tsNode.parent)) {
    return false;
  }

  const propertyName = getTsPropertyNameText(tsNode.name);
  if (!propertyName) {
    return false;
  }

  for (const heritageClause of tsNode.parent.heritageClauses ?? []) {
    for (const heritageType of heritageClause.types) {
      const baseType = checker.getTypeAtLocation(heritageType);

      for (const typePart of getTypeParts(baseType)) {
        const symbol = typePart.getProperty(propertyName);
        if (!symbol) {
          continue;
        }

        if (hasExternalDeclaration(symbol.getDeclarations() ?? [])) {
          return true;
        }

        const propertyType = checker.getTypeOfSymbolAtLocation(symbol, heritageType);
        if (isExternalCallableType(propertyType, checker)) {
          return true;
        }
      }
    }
  }

  return false;
}

function isContextualSignatureFromExternalDeclaration({ checker, tsNode }) {
  // getContextualType covers external signatures attached through variable declarations,
  // function arguments, and assignment RHS expressions such as `window.onresize = (...) => {}`.
  // This intentionally checks the callable signature context rather than parameter types;
  // a Naidan-owned callback that happens to receive a DOM Event must still be reported.
  const contextualType = checker.getContextualType(tsNode);

  return Boolean(contextualType && isExternalCallableType(contextualType, checker));
}


function getEnclosingFunctionLike(node) {
  let current = node?.parent;

  while (current) {
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'MethodDefinition'
    ) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function hasLikelyObjectExpressionContext(objectExpression) {
  const parent = objectExpression?.parent;

  if (!parent) {
    return false;
  }

  if (
    parent.type === 'TSAsExpression' ||
    parent.type === 'TSSatisfiesExpression' ||
    parent.type === 'TSInstantiationExpression'
  ) {
    return true;
  }

  if (parent.type === 'VariableDeclarator') {
    return Boolean(parent.id?.typeAnnotation);
  }

  if (parent.type === 'AssignmentExpression') {
    return true;
  }

  if (parent.type === 'Property') {
    return hasLikelyObjectExpressionContext(parent.parent);
  }

  if (parent.type === 'ReturnStatement') {
    return Boolean(getEnclosingFunctionLike(parent)?.returnType);
  }

  return (
    (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
    parent.arguments.includes(objectExpression)
  );
}

function getTypedExpressionContextNode(node) {
  let current = node;

  while (current?.parent) {
    const parent = current.parent;

    if (parent.type === 'VariableDeclarator') {
      return parent.id?.typeAnnotation ? parent : undefined;
    }

    if (parent.type === 'PropertyDefinition') {
      return parent.typeAnnotation ? parent : undefined;
    }

    if (parent.type === 'AssignmentExpression') {
      return parent.right === current ? parent : undefined;
    }

    if (parent.type === 'Property') {
      return hasLikelyObjectExpressionContext(parent.parent) ? parent : undefined;
    }

    if (parent.type === 'ReturnStatement') {
      return getEnclosingFunctionLike(parent)?.returnType ? parent : undefined;
    }

    if (
      parent.type === 'LogicalExpression' ||
      parent.type === 'ConditionalExpression' ||
      parent.type === 'TSAsExpression' ||
      parent.type === 'TSSatisfiesExpression' ||
      parent.type === 'TSInstantiationExpression'
    ) {
      current = parent;
      continue;
    }

    return undefined;
  }

  return undefined;
}

function getExternalContextEstreeNode(node) {
  if (node.parent?.type === 'MethodDefinition' && node.parent.value === node) {
    return node.parent;
  }

  return node;
}

function canHaveTypeCheckedExternalContext(node) {
  if (node.parent?.type === 'MethodDefinition' && node.parent.value === node) {
    return true;
  }

  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
    return (
      node.type === 'MethodDefinition' ||
      node.type === 'PropertyDefinition' ||
      node.type === 'TSMethodSignature'
    );
  }

  return Boolean(getTypedExpressionContextNode(node));
}

function isTypeCheckedExternalBoundaryCallback({ node, state }) {
  if (!canHaveTypeCheckedExternalContext(node) || !state.services || !state.checker) {
    return false;
  }

  const estreeNode = getExternalContextEstreeNode(node);
  const tsNode = state.services.esTreeNodeToTSNodeMap.get(estreeNode);
  if (!tsNode) {
    return false;
  }

  return (
    isContextualSignatureFromExternalDeclaration({ checker: state.checker, tsNode }) ||
    isObjectLiteralPropertyContextuallyExternal({ checker: state.checker, tsNode }) ||
    isClassMethodImplementingExternalSignature({ checker: state.checker, tsNode }) ||
    isInterfaceMethodExtendingExternalSignature({ checker: state.checker, tsNode })
  );
}

function collectVueComputedLocalNames(programNode) {
  const names = new Set();

  for (const statement of programNode.body ?? []) {
    if (statement.type !== 'ImportDeclaration' || statement.source?.value !== 'vue') {
      continue;
    }

    for (const specifier of statement.specifiers ?? []) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported?.type === 'Identifier' &&
        specifier.imported.name === 'computed' &&
        specifier.local?.type === 'Identifier'
      ) {
        names.add(specifier.local.name);
      }
    }
  }

  return names;
}

function isWebStreamUnderlyingSourceOrSinkCallback(node) {
  const property = getObjectPropertyForFunction(node);
  const propertyName = getStaticPropertyName(property);
  const callOrNew = getObjectExpressionCallParent(property);
  const calleeName = getCalleeName(callOrNew?.callee);

  if (!propertyName || !calleeName) {
    return false;
  }

  const allowedByConstructor = {
    ReadableStream: new Set(['start', 'pull', 'cancel']),
    WritableStream: new Set(['start', 'write', 'close', 'abort']),
    TransformStream: new Set(['start', 'transform', 'flush']),
  };

  return allowedByConstructor[calleeName]?.has(propertyName) ?? false;
}

function isVueComputedSetter(node, vueComputedLocalNames) {
  const property = getObjectPropertyForFunction(node);
  const propertyName = getStaticPropertyName(property);
  const call = getObjectExpressionCallParent(property);
  const calleeName = getCalleeName(call?.callee);

  return propertyName === 'set' && vueComputedLocalNames.has(calleeName);
}

function isAllowedExternalBoundaryCallback({ node, state }) {
  return (
    isTypeCheckedExternalBoundaryCallback({ node, state }) ||
    isWebStreamUnderlyingSourceOrSinkCallback(node) ||
    isVueComputedSetter(node, state.vueComputedLocalNames)
  );
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



function getFunctionNameHintText(node) {
  if (node.id?.type === 'Identifier') {
    return node.id.name;
  }

  let current = node.parent;
  while (current) {
    if (current.type === 'VariableDeclarator' && current.id?.type === 'Identifier') {
      return current.id.name;
    }

    if (
      current.type === 'Property' ||
      current.type === 'MethodDefinition' ||
      current.type === 'PropertyDefinition' ||
      current.type === 'TSPropertySignature' ||
      current.type === 'TSMethodSignature'
    ) {
      return getStaticPropertyName(current);
    }

    if (current.type === 'TSTypeAliasDeclaration' && current.id?.type === 'Identifier') {
      return current.id.name;
    }

    current = current.parent;
  }

  return undefined;
}

function hasPromiseCallbackLikeName(node) {
  const name = getFunctionNameHintText(node);
  return Boolean(name && /(?:resolve|reject)/iu.test(name));
}

function hasDomCallbackLikeName(node) {
  const name = getFunctionNameHintText(node);
  return Boolean(name && /(?:idle|animation|storage|message|resize)/iu.test(name));
}

function getReportMessageId({ node, params }) {
  if (isAssignmentFunctionRhs(node)) {
    return 'requireNamedArgsAssignment';
  }

  if (hasPromiseCallbackLikeName(node)) {
    return 'requireNamedArgsPromiseCallback';
  }

  if (hasDomCallbackLikeName(node)) {
    return 'requireNamedArgsDomCallback';
  }

  if (
    node.type === 'TSFunctionType' ||
    node.type === 'TSCallSignatureDeclaration' ||
    node.type === 'TSConstructSignatureDeclaration' ||
    node.type === 'TSMethodSignature'
  ) {
    return 'requireNamedArgsTypeSignature';
  }

  if (params.length > 1) {
    return 'requireNamedArgsWrap';
  }

  if (params.length === 1) {
    return 'requireNamedArgsDestructure';
  }

  return 'requireNamedArgs';
}

function checkFunctionLike(node, context, state) {
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

  if (isAllowedExternalBoundaryCallback({ node, state })) {
    return;
  }

  context.report({
    node,
    messageId: getReportMessageId({ node, params }),
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
      requireNamedArgs: 'Use named args: no args, Record<never, never>, or one destructured object param. Disable only for true external/deprecated contracts.',
      requireNamedArgsDestructure: 'Use one destructured object param, e.g. fn({ value }: Args). Disable only for true external/deprecated contracts.',
      requireNamedArgsWrap: 'Wrap positional params into one object param, e.g. fn({ id, name }). Disable only for true external/deprecated contracts.',
      requireNamedArgsTypeSignature: 'Naidan callback/signature types should use one object param. Import external callback types instead of redefining them.',
      requireNamedArgsAssignment: "Use named args, or type the assignment target with an external callback type, e.g. Window['onstorage']. Disable only for true external/deprecated contracts.",
      requireNamedArgsPromiseCallback: "Use named args. Stored Promise callbacks can use ReturnType<typeof Promise.withResolvers<T>>['resolve'|'reject'].",
      requireNamedArgsDomCallback: "Use named args. For DOM callbacks, prefer external types like Window['onstorage'] or typeof window.requestIdleCallback.",
    },
  },
  create(context) {
    const services = getParserServices(context);
    const state = {
      checker: services?.program.getTypeChecker(),
      services,
      vueComputedLocalNames: new Set(),
    };

    return {
      Program(node) {
        state.vueComputedLocalNames = collectVueComputedLocalNames(node);
      },
      FunctionDeclaration(node) {
        checkFunctionLike(node, context, state);
      },
      FunctionExpression(node) {
        checkFunctionLike(node, context, state);
      },
      ArrowFunctionExpression(node) {
        checkFunctionLike(node, context, state);
      },
      TSFunctionType(node) {
        checkFunctionLike(node, context, state);
      },
      TSCallSignatureDeclaration(node) {
        checkFunctionLike(node, context, state);
      },
      TSConstructSignatureDeclaration(node) {
        checkFunctionLike(node, context, state);
      },
      TSMethodSignature(node) {
        checkFunctionLike(node, context, state);
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
