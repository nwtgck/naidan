import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { findVariable, propertyName, staticString, unwrap, builtinName } from './test-resource-ast.js';
import { physicalPath, repoRoot } from './external-command-ast.js';

export const registryPath = path.join(repoRoot, 'build/node-env.ts');
export const registryConsumers = new Set([
  'vite.config.ts',
  'build/app-source-environment.ts',
  'build/app-source.test.ts',
  'build/node-env.test.ts',
  'src/features/stable-diffusion-cpp-browser/build-runtime.ts',
  'src/features/llama-cpp-browser/worker/generation.test.ts',
].map(file => path.join(repoRoot, file)));

export function isRegistryModule({ value, filename }) {
  if (typeof value !== 'string') {
    return false;
  }
  let clean = value.replaceAll('\\', '/');
  if (clean.startsWith('file:')) {
    try {
      const url = new URL(clean);
      url.search = '';
      url.hash = '';
      clean = fileURLToPath(url);
    } catch {
      return false;
    }
  } else {
    clean = clean.split(/[?#]/u, 1)[0];
  }
  let resolved;
  if (clean.startsWith('@/') || clean.startsWith('~/')) {
    resolved = path.resolve(repoRoot, 'src', clean.slice(2));
  } else if (clean.startsWith('.') || path.isAbsolute(clean)) {
    resolved = path.resolve(path.dirname(physicalPath({ filename }) ?? path.join(repoRoot, 'unknown.ts')), clean);
  } else {
    return false;
  }
  return [resolved, `${resolved}.ts`, resolved.replace(/\.js$/u, '.ts')]
    .some(candidate => physicalPath({ filename: candidate }) === registryPath);
}

export function isProcessModule({ value }) {
  return value === 'process' || value === 'node:process';
}

export function isTypePosition({ node }) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'TSTypeQuery' || current.type === 'TSTypeAnnotation' || current.type === 'TSImportType') {
      return true;
    }
    if (['Program', 'Statement', 'Expression'].some(suffix => current.type.endsWith(suffix))) {
      return false;
    }
  }
  return false;
}

/** Lexical provenance, not evaluation. NodeJS.ProcessEnv is NOT proof of origin. */
export function createEnvResolver({ sourceCode }) {
  const name = node => propertyName({ node, sourceCode });
  const string = node => staticString({ node, sourceCode });
  const builtin = node => {
    const result = builtinName({ node, sourceCode });
    node = unwrap({ node });
    return result ?? (node?.type === 'MemberExpression' && builtinName({ node: node.object, sourceCode }) === 'JSON' ? `JSON.${name(node)}` : undefined);
  };
  const globals = new Set(['globalThis', 'global', 'window', 'self']);
  const program = sourceCode.parserServices?.program;
  // The parser can reuse an isolated noResolve Program even with project:false.
  // It has no trustworthy imported types (and querying it can crash TypeScript).
  const checker = program && !program.getCompilerOptions().noResolve ? program.getTypeChecker() : undefined;
  const typeCache = new WeakMap();

  function typedProcess({ node }) {
    if (!node || !checker || !sourceCode.parserServices.esTreeNodeToTSNodeMap) {
      return false;
    }
    if (typeCache.has(node)) {
      return typeCache.get(node);
    }
    const tsNode = sourceCode.parserServices.esTreeNodeToTSNodeMap.get(node);
    function containsProcess({ type, seen = new Set() }) {
      if (!type || seen.has(type)) {
        return false;
      }
      seen.add(type);
      // Only the actual Node declaration counts, not a similarly named app type.
      if (type.getSymbol()?.getName() === 'Process' && type.getSymbol().declarations?.some(declaration => /(?:^|\/)@types\/node\/(?:ts\d+\.[\d]+\/)?process\.d\.ts$/u.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')))) {
        return true;
      }
      return type.types?.some(part => containsProcess({ type: part, seen })) ?? false;
    }
    const result = tsNode ? containsProcess({ type: checker.getTypeAtLocation(tsNode) }) : false;
    typeCache.set(node, result);
    return result;
  }

  function processAnnotation({ annotation, seen = new Set() }) {
    if (!annotation || seen.has(annotation)) {
      return false;
    }
    seen.add(annotation);
    if (annotation.type === 'TSTypeAnnotation') {
      return processAnnotation({ annotation: annotation.typeAnnotation, seen });
    }
    if (['TSUnionType', 'TSIntersectionType'].includes(annotation.type)) {
      return annotation.types.some(type => processAnnotation({ annotation: type, seen }));
    }
    if (annotation.type === 'TSTypeQuery') {
      if (builtin(annotation.exprName) === 'process') {
        return true;
      }
      if (annotation.exprName.type !== 'Identifier') {
        return false;
      }
      const variable = findVariable({ sourceCode, node: annotation.exprName, name: annotation.exprName.name });
      return variable?.defs.some(definition => definition.type === 'ImportBinding'
        && isProcessModule({ value: string(definition.parent.source) })
        && (definition.node.type !== 'ImportSpecifier' || definition.node.imported.name === 'default')) ?? false;
    }
    if (annotation.type !== 'TSTypeReference') {
      return false;
    }
    const typeName = annotation.typeName;
    if (typeName.type === 'TSQualifiedName' && typeName.left.name === 'NodeJS' && typeName.right.name === 'Process') {
      return true;
    }
    if (typeName.type !== 'Identifier') {
      return false;
    }
    const variable = findVariable({ sourceCode, node: typeName, name: typeName.name });
    return variable?.defs.some(definition => {
      if (definition.type === 'ImportBinding') {
        return isProcessModule({ value: string(definition.parent.source) }) && definition.node.imported?.name === 'Process';
      }
      return definition.node.type === 'TSTypeAliasDeclaration' && processAnnotation({ annotation: definition.node.typeAnnotation, seen });
    }) ?? false;
  }

  function prefer({ values }) {
    // A union or later assignment must not hide a possible Node process behind
    // an earlier global/loader alias. This is deliberately flow-insensitive.
    return values.find(value => value === 'process') ?? values.find(value => value === 'environment' || value === 'environment-writer') ?? values.find(Boolean);
  }

  function select({ owner, key }) {
    if (globals.has(owner)) {
      return ['process', 'module', 'require'].includes(key) ? key : undefined;
    }
    if (owner === 'process') {
      if (key === 'env') {
        return 'environment';
      }
      if (key === 'default') {
        return 'process';
      }
      if (key === 'loadEnvFile') {
        return 'environment-writer';
      }
      if (key === 'mainModule') {
        return 'module';
      }
      if (key === 'getBuiltinModule') {
        return 'builtin-loader';
      }
    }
    if (owner === 'vitest' && ['vi', 'vitest'].includes(key)) {
      return 'vi';
    }
    if (owner === 'vi' && ['stubEnv', 'unstubAllEnvs', 'spyOn', 'importActual', 'importMock'].includes(key)) {
      return `vi.${key}`;
    }
    if (owner === 'process-descriptor' && key === 'value') {
      return 'process';
    }
    if (owner === 'module') {
      if (key === 'createRequire') {
        return 'create-require';
      }
      if (key === 'require') {
        return 'loader';
      }
    }
    return undefined;
  }

  function moduleKind({ value }) {
    if (isProcessModule({ value })) {
      return 'process';
    }
    if (value === 'vitest') {
      return 'vitest';
    }
    if (['module', 'node:module'].includes(value)) {
      return 'module';
    }
    return undefined;
  }

  function bindingKeys({ pattern, target }) {
    if (!pattern) {
      return undefined;
    }
    if (pattern.type === 'Identifier') {
      return pattern.name === target ? [] : undefined;
    }
    if (pattern.type === 'AssignmentPattern') {
      return bindingKeys({ pattern: pattern.left, target });
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        const keys = bindingKeys({ pattern: property.value ?? property.argument, target });
        if (keys) {
          return property.type === 'RestElement' ? keys : [name(property), ...keys];
        }
      }
    }
    return undefined;
  }

  function resolve({ node, seen = new Set(), depth = 0 }) {
    node = unwrap({ node });
    if (!node || depth > 32 || seen.has(node)) {
      return undefined;
    }
    seen = new Set(seen).add(node);
    const next = value => resolve({ node: value, seen, depth: depth + 1 });
    if (node.type === 'AwaitExpression') {
      return next(node.argument);
    }
    if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      return prefer({ values: [next(node.consequent ?? node.left), next(node.alternate ?? node.right)] });
    }
    if (node.type === 'SequenceExpression') {
      return next(node.expressions.at(-1));
    }
    if (node.type === 'AssignmentExpression') {
      return next(node.right);
    }
    if (node.type === 'MemberExpression') {
      const key = name(node);
      const owner = next(node.object);
      return select({ owner, key }) ?? project({ node: node.object, keys: [key], seen, depth: depth + 1 });
    }
    if (node.type === 'ImportExpression') {
      return moduleKind({ value: string(node.source) });
    }
    if (node.type === 'CallExpression') {
      const callee = next(node.callee);
      const calleeName = builtin(node.callee);
      if (callee === 'create-require') {
        return 'loader';
      }
      if (['loader', 'require', 'builtin-loader', 'vi.importActual', 'vi.importMock'].includes(callee)) {
        return moduleKind({ value: string(node.arguments[0]) });
      }
      if (calleeName === 'Reflect.get') {
        return select({ owner: next(node.arguments[0]), key: string(node.arguments[1]) });
      }
      if (['Object.getOwnPropertyDescriptor', 'Reflect.getOwnPropertyDescriptor'].includes(calleeName)
        && globals.has(next(node.arguments[0])) && string(node.arguments[1]) === 'process') {
        return 'process-descriptor';
      }
      if (calleeName === 'Object.assign') {
        return node.arguments.map(next).find(value => value === 'process');
      }
    }
    if (node.type !== 'Identifier') {
      return undefined;
    }
    const variable = findVariable({ sourceCode, node, name: node.name });
    if (!variable || variable.defs.length === 0) {
      return ['process', 'globalThis', 'global', 'window', 'self', 'require', 'module', 'vi'].includes(node.name) ? node.name : node.name === 'vitest' ? 'vi' : undefined;
    }
    if (processAnnotation({ annotation: variable.identifiers?.[0]?.typeAnnotation })) {
      return 'process';
    }
    const values = [];
    for (const definition of variable.defs) {
      if (definition.type === 'ImportBinding') {
        if (definition.parent.importKind === 'type' || definition.node.importKind === 'type') {
          continue;
        }
        const owner = moduleKind({ value: string(definition.parent.source) });
        return definition.node.type === 'ImportSpecifier' ? select({ owner, key: definition.node.imported.name ?? definition.node.imported.value }) : owner;
      }
      if (definition.type === 'Variable') {
        const keys = bindingKeys({ pattern: definition.node.id, target: node.name });
        if (keys) {
          const value = keys.length ? project({ node: definition.node.init, keys, seen, depth: depth + 1 }) : next(definition.node.init);
          values.push(value);
        }
      }
    }
    // A later assignment must not hide the origin behind an unrelated initializer.
    for (const reference of variable.references ?? []) {
      if (reference.writeExpr && reference.writeExpr !== node) {
        let assignment = reference.identifier.parent;
        while (assignment && !['AssignmentExpression', 'VariableDeclarator', 'Program'].includes(assignment.type)) {
          assignment = assignment.parent;
        }
        const keys = assignment?.type === 'AssignmentExpression' ? bindingKeys({ pattern: assignment.left, target: node.name }) : undefined;
        values.push(keys?.length ? project({ node: reference.writeExpr, keys, seen, depth: depth + 1 }) : next(reference.writeExpr));
      }
    }
    return prefer({ values });
  }

  function project({ node, keys, seen, depth }) {
    node = unwrap({ node });
    if (!node || depth > 32 || seen.has(node)) {
      return undefined;
    }
    if (keys.length === 0) {
      return resolve({ node, seen, depth });
    }
    const owner = resolve({ node, seen, depth });
    let projected = owner;
    for (const key of keys) {
      projected = select({ owner: projected, key });
    }
    if (projected) {
      return projected;
    }
    seen = new Set(seen).add(node);
    if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const value = project({ node: property.argument, keys, seen, depth: depth + 1 });
          if (value) {
            return value;
          }
        } else if (name(property) === keys[0]) {
          return project({ node: property.value, keys: keys.slice(1), seen, depth: depth + 1 });
        }
      }
    }
    if (node.type === 'Identifier') {
      const variable = findVariable({ sourceCode, node, name: node.name });
      for (const definition of variable?.defs ?? []) {
        if (definition.type === 'Variable' && definition.node.id.type === 'Identifier') {
          const value = project({ node: definition.node.init, keys, seen, depth: depth + 1 });
          if (value) {
            return value;
          }
        }
      }
    }
    return undefined;
  }

  const cache = new WeakMap();
  function cachedResolve(node) {
    if (!node) {
      return undefined;
    }
    if (!cache.has(node)) {
      cache.set(node, resolve({ node }));
    }
    return cache.get(node);
  }
  return {
    resolve: cachedResolve,
    isProcess: node => cachedResolve(node) === 'process' || processAnnotation({ annotation: node?.typeAnnotation }) || typedProcess({ node }),
    name, string, builtin,
    select,
  };
}
