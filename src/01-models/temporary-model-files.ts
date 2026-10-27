import { z } from 'zod';
import { isModelSourceSegment } from './llama-cpp-browser-model-id';

// A name in temp/ denotes the file currently registered there, not a lasting
// identity. Persisted references may be unresolved after reload, or resolve to
// different files after re-registration. Do not migrate or invalidate them.
const segment = ({ name }: { name: string }): boolean => isModelSourceSegment({ name })
  && !name.includes('\x7f') && new TextDecoder().decode(new TextEncoder().encode(name)) === name;

export const temporaryRootNameSchema = z.string().refine(name => segment({ name }) && !name.startsWith('.') && !name.includes(':'));
const temporaryRootPrefix = 'temp/';

/** Routing check only; root and file schemas validate their complete paths. */
export function hasTemporaryModelPathPrefix({ path }: { path: string }): boolean {
  return path.startsWith(temporaryRootPrefix);
}

export const temporaryRootPathSchema = z.string().refine(rootPath => hasTemporaryModelPathPrefix({ path: rootPath }) && temporaryRootNameSchema.safeParse(rootPath.slice(temporaryRootPrefix.length)).success);
export const temporaryFilePathSchema = z.string().max(8192).refine(path => {
  const parts = path.slice(temporaryRootPrefix.length).split('/');
  const root = parts.shift();
  return hasTemporaryModelPathPrefix({ path }) && temporaryRootNameSchema.safeParse(root).success
    && parts.length > 0 && parts.length <= 64 && parts.every(name => segment({ name }));
});

/** Shared File registry paths are independent of public language-model IDs. */
export function temporaryModelRootPath({ rootName }: { rootName: string }): string {
  return `${temporaryRootPrefix}${temporaryRootNameSchema.parse(rootName)}`;
}

export function parseTemporaryModelRootPath({ rootPath }: { rootPath: string }): { rootName: string } {
  return { rootName: temporaryRootPathSchema.parse(rootPath).slice(temporaryRootPrefix.length) };
}

export function temporaryModelFilePath({ rootPath, relativePath }: { rootPath: string, relativePath: string }): string {
  temporaryRootPathSchema.parse(rootPath);
  return temporaryFilePathSchema.parse(`${rootPath}/${relativePath}`);
}

export type TemporaryModelDirectoryInput = { rootName: string, files: { relativePath: string, file: File }[] };
export type TemporaryModelDirectory = Readonly<{
  rootPath: string, rootName: string, sourceRootName: string, registrationRevision: number,
  files: readonly Readonly<{ relativePath: string, file: File }>[],
}>;

export const TEST_ONLY = {
};
