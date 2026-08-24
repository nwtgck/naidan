import type { WeshCommandContext, WeshStat } from '@/features/wesh/types';

export function normalizePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  const joined = path.startsWith('/')
    ? path
    : cwd === '/'
      ? `/${path}`
      : `${cwd}/${path}`;

  const segments = joined.split('/');
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.length === 0 ? '/' : `/${normalizedSegments.join('/')}`;
}

export function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  return normalizePath({ cwd, path });
}

type CanonicalizationMode = 'existing' | 'missing_leaf' | 'missing_components';
type SymlinkTraversalPolicy = 'detect_cycles' | 'limit_40';

type PendingPathComponent = {
  value: string,
  mayBeMissingLeaf: boolean,
};

type PendingPathNode = {
  id: number,
  component: PendingPathComponent,
  next: PendingPathNode | undefined,
};

function isPathNotFoundError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError';
  }
  return error instanceof Error && (
    error.name === 'NotFoundError'
    || error.message.includes('NotFoundError')
    || error.message.startsWith('Path not found:')
  );
}

function createOriginalPendingComponents({
  path,
}: {
  path: string,
}): PendingPathComponent[] {
  const rawComponents = path.split('/');
  const hasTrailingSlash = path.length > 1 && path.endsWith('/');
  let lastSyntacticComponentIndex = -1;
  for (let index = rawComponents.length - 1; index >= 0; index -= 1) {
    if ((rawComponents[index] ?? '').length > 0) {
      lastSyntacticComponentIndex = index;
      break;
    }
  }

  return rawComponents.map((value, index) => ({
    value,
    mayBeMissingLeaf: !hasTrailingSlash
      && index === lastSyntacticComponentIndex
      && value !== '.'
      && value !== '..',
  }));
}

function appendPendingComponentsLexically({
  pending,
  resolvedSegments,
}: {
  pending: PendingPathNode | undefined,
  resolvedSegments: string[],
}): void {
  let current = pending;
  while (current !== undefined) {
    const { value } = current.component;
    if (value.length === 0 || value === '.') {
      current = current.next;
      continue;
    }
    if (value === '..') {
      resolvedSegments.pop();
      current = current.next;
      continue;
    }
    resolvedSegments.push(value);
    current = current.next;
  }
}

async function canonicalizePath({
  context,
  path,
  mode,
  symlinkPolicy,
}: {
  context: WeshCommandContext,
  path: string,
  mode: CanonicalizationMode,
  symlinkPolicy: SymlinkTraversalPolicy,
}): Promise<string> {
  if (path.length === 0) {
    throw new Error('No such file or directory');
  }

  const joined = path.startsWith('/')
    ? path
    : context.cwd === '/'
      ? `/${path}`
      : `${context.cwd}/${path}`;
  let nextPendingNodeId = 1;
  const pendingNodeByStructure = new Map<string, PendingPathNode>();
  const prependPendingComponents = ({
    components,
    next,
  }: {
    components: readonly PendingPathComponent[],
    next: PendingPathNode | undefined,
  }): PendingPathNode | undefined => {
    let head = next;
    for (let index = components.length - 1; index >= 0; index -= 1) {
      const component = components[index];
      if (component === undefined) {
        continue;
      }
      const structureKey = JSON.stringify([
        component.value,
        component.mayBeMissingLeaf,
        head?.id ?? 0,
      ]);
      const existing = pendingNodeByStructure.get(structureKey);
      if (existing !== undefined) {
        head = existing;
        continue;
      }
      const created: PendingPathNode = {
        id: nextPendingNodeId,
        component,
        next: head,
      };
      nextPendingNodeId += 1;
      pendingNodeByStructure.set(structureKey, created);
      head = created;
    }
    return head;
  };
  let pending = prependPendingComponents({
    components: createOriginalPendingComponents({ path: joined }),
    next: undefined,
  });
  const resolvedSegments: string[] = [];
  let symlinkDepth = 0;
  const seenSymlinkStates = new Set<string>();

  while (pending !== undefined) {
    const current = pending.component;
    pending = pending.next;

    const component = current.value;
    if (component.length === 0 || component === '.') {
      continue;
    }
    if (component === '..') {
      resolvedSegments.pop();
      continue;
    }

    const candidate = `/${[...resolvedSegments, component].join('/')}`;
    let stat: WeshStat;
    try {
      stat = await context.files.lstat({ path: candidate });
    } catch (error: unknown) {
      if (!isPathNotFoundError({ error })) {
        throw error;
      }

      switch (mode) {
      case 'existing':
        throw error;
      case 'missing_leaf':
        if (!current.mayBeMissingLeaf || pending !== undefined) {
          throw error;
        }
        resolvedSegments.push(component);
        continue;
      case 'missing_components':
        resolvedSegments.push(component);
        continue;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled canonicalization mode: ${_ex}`);
      }
      }
    }

    switch (stat.type) {
    case 'symlink': {
      symlinkDepth += 1;
      switch (mode) {
      case 'existing':
      case 'missing_leaf':
        switch (symlinkPolicy) {
        case 'limit_40':
          if (symlinkDepth > 40) {
            throw new Error(`Too many levels of symbolic links: ${candidate}`);
          }
          break;
        case 'detect_cycles':
          if (symlinkDepth > 20) {
            const stateKey = `${candidate}\0${pending?.id ?? 0}`;
            if (seenSymlinkStates.has(stateKey)) {
              throw new Error(`Too many levels of symbolic links: ${candidate}`);
            }
            seenSymlinkStates.add(stateKey);
          }
          break;
        default: {
          const _ex: never = symlinkPolicy;
          throw new Error(`Unhandled symlink traversal policy: ${_ex}`);
        }
        }
        break;
      case 'missing_components':
        if (symlinkDepth > 20) {
          const stateKey = `${candidate}\0${pending?.id ?? 0}`;
          if (seenSymlinkStates.has(stateKey)) {
            resolvedSegments.push(component);
            appendPendingComponentsLexically({ pending, resolvedSegments });
            return resolvedSegments.length === 0 ? '/' : `/${resolvedSegments.join('/')}`;
          }
          seenSymlinkStates.add(stateKey);
        }
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled canonicalization mode: ${_ex}`);
      }
      }

      const target = await context.files.readlink({ path: candidate });
      if (target.length === 0) {
        throw new Error(`Invalid symbolic link target: ${candidate}`);
      }
      if (target.startsWith('/')) {
        resolvedSegments.length = 0;
      }
      const targetComponents = target.split('/');
      let lastTargetSyntacticComponentIndex = -1;
      for (let index = targetComponents.length - 1; index >= 0; index -= 1) {
        if ((targetComponents[index] ?? '').length > 0) {
          lastTargetSyntacticComponentIndex = index;
          break;
        }
      }
      pending = prependPendingComponents({
        components: targetComponents.flatMap((value, index) => value.length === 0
          ? []
          : [{
            value,
            mayBeMissingLeaf: current.mayBeMissingLeaf
              && pending === undefined
              && index === lastTargetSyntacticComponentIndex
              && value !== '.'
              && value !== '..',
          }]),
        next: pending,
      });
      break;
    }
    case 'directory':
      resolvedSegments.push(component);
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
      if (pending !== undefined) {
        switch (mode) {
        case 'missing_components':
          resolvedSegments.push(component);
          appendPendingComponentsLexically({ pending, resolvedSegments });
          return resolvedSegments.length === 0 ? '/' : `/${resolvedSegments.join('/')}`;
        case 'existing':
        case 'missing_leaf':
          throw new Error(`Not a directory: ${candidate}`);
        default: {
          const _ex: never = mode;
          throw new Error(`Unhandled canonicalization mode: ${_ex}`);
        }
        }
      }
      resolvedSegments.push(component);
      break;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled Wesh file type: ${_ex}`);
    }
    }
  }

  return resolvedSegments.length === 0 ? '/' : `/${resolvedSegments.join('/')}`;
}

export async function canonicalizeExistingPath({
  context,
  path,
  symlinkPolicy = 'detect_cycles',
}: {
  context: WeshCommandContext,
  path: string,
  symlinkPolicy?: SymlinkTraversalPolicy,
}): Promise<string> {
  return canonicalizePath({
    context,
    path,
    mode: 'existing',
    symlinkPolicy: symlinkPolicy,
  });
}

export async function canonicalizePathAllowingMissingLeaf({
  context,
  path,
  symlinkPolicy = 'detect_cycles',
}: {
  context: WeshCommandContext,
  path: string,
  symlinkPolicy?: SymlinkTraversalPolicy,
}): Promise<string> {
  return canonicalizePath({
    context,
    path,
    mode: 'missing_leaf',
    symlinkPolicy,
  });
}

export async function canonicalizePathAllowingMissingComponents({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<string> {
  return canonicalizePath({
    context,
    path,
    mode: 'missing_components',
    symlinkPolicy: 'detect_cycles',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
