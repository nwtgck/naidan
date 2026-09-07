import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { dirnamePath } from '@/features/wesh/commands/_shared/path';
import { normalizePath } from '@/features/wesh/path';
import { readAllFileText, readAllHandleBytes } from '@/features/wesh/utils/fs';
import type { WeshCommandContext, WeshFileType } from '@/features/wesh/types';

export type NodeSyntaxMode = 'commonjs' | 'module' | 'ambiguous';

export interface NodeSyntaxInput {
  readonly source: string,
  readonly displayName: string,
  readonly mode: NodeSyntaxMode,
}

export type NodeSyntaxInputResult =
  | { readonly kind: 'source', readonly input: NodeSyntaxInput }
  | { readonly kind: 'error', readonly message: string };

type PackageTypeLookupResult =
  | { readonly kind: 'ok', readonly type: 'commonjs' | 'module' | undefined }
  | { readonly kind: 'error', readonly message: string };

type NodeSyntaxModeResult =
  | { readonly kind: 'ok', readonly mode: NodeSyntaxMode }
  | { readonly kind: 'error', readonly message: string };

const acceptedExtensions = new Set(['', '.js', '.cjs', '.mjs', '.json']);

function extensionOf({ path }: { path: string }): string {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return name.slice(dot);
}

function isRegularFileType({ type }: { type: WeshFileType }): boolean {
  switch (type) {
  case 'file':
    return true;
  case 'directory':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return false;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled Wesh file type: ${_ex}`);
  }
  }
}

function invalidPackageConfig({ packagePath }: { packagePath: string }): PackageTypeLookupResult {
  return {
    kind: 'error',
    message: `Error: Invalid package config ${packagePath}.`,
  };
}

async function readNearestPackageType({
  context,
  filePath,
}: {
  context: WeshCommandContext,
  filePath: string,
}): Promise<PackageTypeLookupResult> {
  let directory = dirnamePath({ path: filePath });

  while (true) {
    const packagePath = directory === '/' ? '/package.json' : `${directory}/package.json`;
    try {
      const stat = await context.files.stat({ path: packagePath });
      if (isRegularFileType({ type: stat.type })) {
        const text = await readAllFileText({ files: context.files, path: packagePath });
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          return invalidPackageConfig({ packagePath });
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return invalidPackageConfig({ packagePath });
        }

        if (!('type' in parsed)) {
          return { kind: 'ok', type: undefined };
        }

        const type = (parsed as { readonly type?: unknown }).type;
        if (typeof type !== 'string') {
          return invalidPackageConfig({ packagePath });
        }
        return {
          kind: 'ok',
          type: type === 'module' || type === 'commonjs' ? type : undefined,
        };
      }
    } catch (error) {
      if (!isPathNotFoundError({ error })) {
        throw error;
      }
    }

    if (directory === '/') {
      return { kind: 'ok', type: undefined };
    }
    directory = dirnamePath({ path: directory });
  }
}

async function classifyPackageScopedMode({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<NodeSyntaxModeResult> {
  const packageType = await readNearestPackageType({ context, filePath: path });
  switch (packageType.kind) {
  case 'error':
    return packageType;
  case 'ok':
    return { kind: 'ok', mode: packageType.type ?? 'ambiguous' };
  default: {
    const _ex: never = packageType;
    throw new Error(`Unhandled package type lookup result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

async function classifyFileMode({
  context,
  path,
  extension,
}: {
  context: WeshCommandContext,
  path: string,
  extension: string,
}): Promise<NodeSyntaxModeResult> {
  switch (extension) {
  case '.mjs':
    return { kind: 'ok', mode: 'module' };
  case '.cjs':
    return { kind: 'ok', mode: 'commonjs' };
  case '.js':
  case '':
    return classifyPackageScopedMode({ context, path });
  case '.json':
    return { kind: 'ok', mode: 'ambiguous' };
  default:
    throw new Error(`Unsupported accepted Node extension: ${extension}`);
  }
}

async function readStdinInput({
  context,
}: {
  context: WeshCommandContext,
}): Promise<NodeSyntaxInput> {
  const bytes = await readAllHandleBytes({ handle: context.stdin });
  return {
    source: new TextDecoder().decode(bytes),
    displayName: '[stdin]',
    mode: 'commonjs',
  };
}

export async function resolveNodeSyntaxInput({
  context,
  operand,
}: {
  context: WeshCommandContext,
  operand: string | undefined,
}): Promise<NodeSyntaxInputResult> {
  if (operand === undefined || operand === '-') {
    return { kind: 'source', input: await readStdinInput({ context }) };
  }

  const requestedPath = normalizePath({ cwd: context.cwd, path: operand });
  let resolved: Awaited<ReturnType<WeshCommandContext['files']['resolve']>>;
  try {
    resolved = await context.files.resolve({ path: requestedPath });
  } catch (error) {
    if (isPathNotFoundError({ error })) {
      return { kind: 'error', message: `Error: Cannot find module '${requestedPath}'` };
    }
    throw error;
  }

  if (!isRegularFileType({ type: resolved.stat.type })) {
    return { kind: 'error', message: `Error: Cannot find module '${requestedPath}'` };
  }

  const extension = extensionOf({ path: resolved.fullPath });
  if (!acceptedExtensions.has(extension)) {
    return {
      kind: 'error',
      message: `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension "${extension}" for ${resolved.fullPath}`,
    };
  }

  const mode = await classifyFileMode({
    context,
    path: resolved.fullPath,
    extension,
  });
  switch (mode.kind) {
  case 'error':
    return mode;
  case 'ok':
    return {
      kind: 'source',
      input: {
        source: await readAllFileText({ files: context.files, path: resolved.fullPath }),
        displayName: resolved.fullPath,
        mode: mode.mode,
      },
    };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled Node syntax mode result: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

export const TEST_ONLY = {
  extensionOf,
  isRegularFileType,
  readNearestPackageType,
  classifyFileMode,
};
