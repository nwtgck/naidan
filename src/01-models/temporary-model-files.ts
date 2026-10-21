import { z } from 'zod';
import { isModelSourceSegment } from './llama-cpp-browser-model-id';

// A name in temp/ denotes the file currently registered there, not a lasting
// identity. Persisted references may be unresolved after reload, or resolve to
// different files after re-registration. Do not migrate or invalidate them.
const segment = ({ name }: { name: string }): boolean => isModelSourceSegment({ name })
  && !name.includes('\x7f') && new TextDecoder().decode(new TextEncoder().encode(name)) === name;

export const temporaryRootNameSchema = z.string().refine(name => segment({ name }) && !name.startsWith('.') && !name.includes(':'));
export const temporaryRootPathSchema = z.string().refine(rootPath => rootPath.startsWith('temp/') && temporaryRootNameSchema.safeParse(rootPath.slice(5)).success);
export const temporaryFilePathSchema = z.string().max(8192).refine(path => {
  const [prefix, root, ...parts] = path.split('/');
  return prefix === 'temp' && temporaryRootNameSchema.safeParse(root).success
    && parts.length > 0 && parts.length <= 64 && parts.every(name => segment({ name }));
});
export type TemporaryModelDirectoryInput = { rootName: string, files: { relativePath: string, file: File }[] };
export type TemporaryModelDirectory = Readonly<{
  rootPath: string, rootName: string, sourceRootName: string, registrationRevision: number,
  files: readonly Readonly<{ relativePath: string, file: File }>[],
}>;

export const TEST_ONLY = {
};
