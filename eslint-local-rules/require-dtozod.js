import ts from 'typescript';

function isDtoFile({ filename }) {
  return /(?:^|\/)(?:[^/]+\.)?dto\.ts$/u.test(filename.replace(/\\/gu, '/'));
}

function isUnrestrictedSource({ value }) {
  return typeof value === 'string' && (
    value === 'zod' || value.startsWith('zod/') ||
    /(?:^|\/)utils\/zod(?:\/|$)/u.test(value)
  );
}

function literalValue({ node }) {
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked;
  return undefined;
}

// Import spelling alone misses domain schemas re-exported as DTOs. Inspect the
// public value types instead, without attempting whole-program dataflow analysis.
function containsNativeSchema({ type, checker, location, seen, depth }) {
  if (seen.has(type) || depth > 8 || seen.size >= 256) return false;
  seen.add(type);
  const nested = child => containsNativeSchema({ type: child, checker, location, seen, depth: depth + 1 });
  if (type.isUnionOrIntersection()) return type.types.some(nested);
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && nested(constraint);
  }
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const propertyType = ({ owner, name }) => {
    const symbol = checker.getPropertyOfType(owner, name);
    return symbol && checker.getTypeOfSymbolAtLocation(symbol, location);
  };
  const internals = propertyType({ owner: type, name: '_zod' });
  if (internals && checker.getPropertyOfType(internals, 'input') && checker.getPropertyOfType(internals, 'output')) {
    // Stop at schema boundaries. DTO input/output slots may contain arbitrary
    // data types; they are not executable schemas and must not be traversed.
    const run = propertyType({ owner: internals, name: 'run' });
    return Boolean(checker.getPropertyOfType(internals, 'def') && run && checker.getSignaturesOfType(run, ts.SignatureKind.Call).length);
  }
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).some(signature => nested(checker.getReturnTypeOfSignature(signature)))) return true;
  if (checker.getIndexInfosOfType(type).some(info => nested(info.type))) return true;
  return checker.getPropertiesOfType(type).some(symbol => nested(checker.getTypeOfSymbolAtLocation(symbol, location)));
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep persisted DTO definitions inside the structural dtozod allowlist.' },
    schema: [],
    messages: {
      nativeExport: 'Do not export an unrestricted native Zod schema (including factories or containers) as a DTO. Define its structural shape with @/utils/dtozod; do not reuse a domain validator.',
      native: 'Use @/utils/dtozod for DTO values. Direct Zod construction bypasses the structural allowlist. Type-only Zod imports remain allowed.',
      assertion: 'Do not assert a schema or raw value through the DTO boundary. Keep type bridges in the narrowly scoped compatibility implementation, not DTO definitions.',
      internals: 'DTO _zod slots exist only for type inference. Runtime access bypasses the intentionally restricted API; no unwrap/fromZod is provided.',
    },
  },
  create(context) {
    if (!isDtoFile({ filename: context.filename ?? context.getFilename?.() ?? '' })) return {};
    const reportSource = ({ node, source, typeOnly }) => {
      if (!typeOnly && isUnrestrictedSource({ value: literalValue({ node: source }) })) {
        context.report({ node, messageId: 'native' });
      }
    };
    const reportNativeExport = ({ node, value }) => {
      const services = context.sourceCode.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap || !value) return;
      const location = services.esTreeNodeToTSNodeMap.get(value);
      if (!location) return;
      const checker = services.program.getTypeChecker();
      const moduleSymbol = ts.isStringLiteral(location) ? checker.getSymbolAtLocation(location) : undefined;
      const type = moduleSymbol ? checker.getTypeOfSymbolAtLocation(moduleSymbol, location) : checker.getTypeAtLocation(location);
      if (containsNativeSchema({ type, checker, location, seen: new Set(), depth: 0 })) {
        context.report({ node, messageId: 'nativeExport' });
      }
    };
    const assertion = node => {
      // "as const" preserves a literal structure, not a claimed validation.
      if (node.typeAnnotation.type === 'TSTypeReference' && node.typeAnnotation.typeName.type === 'Identifier' && node.typeAnnotation.typeName.name === 'const') return;
      context.report({ node, messageId: 'assertion' });
    };
    return {
      ImportDeclaration(node) {
        const typeOnly = node.importKind === 'type' ||
          (node.specifiers.length > 0 && node.specifiers.every(specifier => specifier.importKind === 'type'));
        reportSource({ node, source: node.source, typeOnly });
      },
      ExportNamedDeclaration(node) {
        const typeOnly = node.exportKind === 'type' ||
          (node.specifiers.length > 0 && node.specifiers.every(specifier => specifier.exportKind === 'type'));
        reportSource({ node, source: node.source, typeOnly });
        if (typeOnly || isUnrestrictedSource({ value: literalValue({ node: node.source }) })) return;
        if (node.declaration?.type === 'VariableDeclaration') {
          for (const declaration of node.declaration.declarations) reportNativeExport({ node: declaration, value: declaration.id });
        } else if (node.declaration?.type === 'FunctionDeclaration') {
          reportNativeExport({ node: node.declaration, value: node.declaration });
        }
        for (const specifier of node.specifiers) {
          if (specifier.exportKind !== 'type') reportNativeExport({ node: specifier, value: specifier.local });
        }
      },
      ExportDefaultDeclaration(node) {
        if (node.declaration.type !== 'TSInterfaceDeclaration') reportNativeExport({ node, value: node.declaration });
      },
      ExportAllDeclaration(node) {
        reportSource({ node, source: node.source, typeOnly: node.exportKind === 'type' });
        if (node.exportKind !== 'type' && !isUnrestrictedSource({ value: literalValue({ node: node.source }) })) reportNativeExport({ node, value: node.source });
      },
      ImportExpression(node) {
        reportSource({ node, source: node.source, typeOnly: false });
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          reportSource({ node, source: node.moduleReference.expression, typeOnly: node.importKind === 'type' });
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          reportSource({ node, source: node.arguments[0], typeOnly: false });
        }
      },
      TSAsExpression: assertion,
      TSTypeAssertion: assertion,
      MemberExpression(node) {
        const key = node.computed ? literalValue({ node: node.property }) : node.property.name;
        if (key === '_zod') context.report({ node, messageId: 'internals' });
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') return;
        const key = node.computed ? literalValue({ node: node.key }) : node.key.name ?? literalValue({ node: node.key });
        if (key === '_zod') context.report({ node, messageId: 'internals' });
      },
    };
  },
};

export default {
  files: ['src/**/dto.ts', 'src/**/*.dto.ts'],
  plugins: { 'local-rules-dtozod': { rules: { 'require-dtozod': rule } } },
  rules: { 'local-rules-dtozod/require-dtozod': 'error' },
};
