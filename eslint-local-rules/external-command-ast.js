import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { findVariable, propertyName, staticString, unwrap } from './test-resource-ast.js';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const commandPath = path.join(repoRoot, 'build/command.ts');
const launcherPackages = ['execa', 'cross-spawn', 'shelljs', 'zx', 'foreground-child', 'tinyexec'];

export function physicalPath({ filename }) {
  if (!filename || filename.startsWith('<') || /[?#]/u.test(filename)) {
    return undefined;
  }
  const normalized = filename.replaceAll('\\', '/');
  if (path.sep === '/' && /^[a-z]:\//iu.test(normalized)) {
    return undefined;
  }
  const absolute = path.resolve(repoRoot, normalized);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function isCommandModule({ value, filename }) {
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
  if (clean.startsWith('@/')) {
    resolved = path.resolve(repoRoot, 'src', clean.slice(2));
  } else if (clean.startsWith('.') || path.isAbsolute(clean)) {
    resolved = path.resolve(path.dirname(physicalPath({ filename }) ?? path.join(repoRoot, 'unknown.ts')), clean);
  } else {
    return false;
  }
  return [resolved, `${resolved}.ts`, resolved.replace(/\.js$/u, '.ts')]
    .some(candidate => physicalPath({ filename: candidate }) === commandPath);
}

export function isRawModule({ value }) {
  return ['child_process', 'node:child_process', 'cluster', 'node:cluster'].includes(value)
    || launcherPackages.some(name => value === name || value?.startsWith(`${name}/`));
}

export function hasRuntimeImport({ node }) {
  if (node.importKind === 'type' || node.exportKind === 'type') {
    return false;
  }
  return !node.specifiers?.length || node.specifiers.some(specifier => specifier.importKind !== 'type' && specifier.exportKind !== 'type');
}

function bindingPath({ pattern, target, name }) {
  if (!pattern) {
    return undefined;
  }
  if (pattern.type === 'Identifier') {
    return pattern.name === target ? [] : undefined;
  }
  if (pattern.type === 'AssignmentPattern') {
    return bindingPath({ pattern: pattern.left, target, name });
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') {
        const rest = bindingPath({ pattern: property.argument, target, name });
        if (rest) {
          return rest;
        }
      } else {
        const child = bindingPath({ pattern: property.value, target, name });
        const key = name(property);
        if (child && key !== undefined) {
          return [key, ...child];
        }
      }
    }
  }
  return undefined;
}

export function createResolver({ sourceCode, filename }) {
  const string = node => staticString({ sourceCode, node });
  const name = node => propertyName({ sourceCode, node });
  const modules = new Map();
  const module = value => {
    if (modules.has(value)) {
      return modules.get(value);
    }
    let resolved;
    if (['node:module', 'module'].includes(value)) {
      resolved = 'node-module';
    } else if (['node:process', 'process'].includes(value)) {
      resolved = 'process';
    } else if (value === 'vitest') {
      resolved = 'vitest-module';
    } else if (value === 'bun') {
      resolved = 'Bun';
    } else if (isCommandModule({ value, filename })) {
      resolved = 'command-module';
    }
    modules.set(value, resolved);
    return resolved;
  };
  const member = (owner, key) => {
    if (['globalThis', 'global', 'window', 'self'].includes(owner)) {
      return key;
    }
    if (owner === 'node-module' && key === 'createRequire') {
      return 'createRequire';
    }
    if (owner === 'command-module' && ['runCommand', 'runCommandSync'].includes(key)) {
      return 'runner';
    }
    if (owner === 'vitest-module' && ['vi', 'vitest'].includes(key)) {
      return 'vi';
    }
    if (owner === 'process' && ['getBuiltinModule', 'binding', '_linkedBinding', 'mainModule'].includes(key)) {
      return `process.${key}`;
    }
    if (owner === 'process.mainModule' && key === 'require') {
      return 'loader';
    }
    if (['require', 'loader'].includes(owner) && key === 'resolve') {
      return 'module-resolver';
    }
    if (owner === 'vi' && ['importActual', 'importMock', 'mock', 'doMock'].includes(key)) {
      return `vi.${key}`;
    }
    if (owner === 'Bun' && ['spawn', 'spawnSync', '$'].includes(key)) {
      return 'raw-entry';
    }
    if (owner === 'Deno' && ['Command', 'run'].includes(key)) {
      return 'raw-entry';
    }
    return undefined;
  };
  function resolve({ node, seen, depth }) {
    node = unwrap({ node });
    if (!node || depth > 24) {
      return undefined;
    }
    const next = value => resolve({ node: value, seen: new Set(seen), depth: depth + 1 });
    if (node.type === 'AwaitExpression') {
      return next(node.argument);
    }
    if (node.type === 'MemberExpression') {
      if (node.object.type === 'MetaProperty' && node.object.meta.name === 'import'
        && node.object.property.name === 'meta' && name(node) === 'resolve') {
        return 'module-resolver';
      }
      return member(next(node.object), name(node));
    }
    if (node.type === 'CallExpression') {
      const callee = next(node.callee);
      if (callee === 'createRequire') {
        return 'loader';
      }
      if (['require', 'loader', 'process.getBuiltinModule', 'vi.importActual', 'vi.importMock'].includes(callee)) {
        return module(string(node.arguments[0]));
      }
    }
    if (node.type === 'ImportExpression') {
      return module(string(node.source));
    }
    if (node.type !== 'Identifier') {
      return undefined;
    }
    const variable = findVariable({ sourceCode, node, name: node.name });
    if (!variable || variable.defs.length === 0) {
      return node.name === 'vitest' ? 'vi' : node.name;
    }
    if (variable.defs.length !== 1 || seen.has(variable)) {
      return undefined;
    }
    seen.add(variable);
    const definition = variable.defs[0];
    if (definition.type === 'ImportBinding') {
      const specifier = definition.node;
      if (definition.parent.importKind === 'type' || specifier.importKind === 'type') {
        return undefined;
      }
      const owner = module(string(definition.parent.source));
      return specifier.type === 'ImportSpecifier' ? member(owner, specifier.imported.name ?? specifier.imported.value) : owner;
    }
    if (definition.type !== 'Variable') {
      return undefined;
    }
    const keys = bindingPath({ pattern: definition.node.id, target: node.name, name });
    return keys?.reduce(member, next(definition.node.init));
  }
  return { resolve: node => resolve({ node, seen: new Set(), depth: 0 }), string };
}
