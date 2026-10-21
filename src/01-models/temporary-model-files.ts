import { z } from 'zod';
import { isModelSourceSegment } from './llama-cpp-browser-model-launch';

// A name in temp/ denotes the file currently registered there, not a lasting
// identity. Persisted references may be unresolved after reload, or resolve to
// different files after re-registration. Do not migrate or invalidate them.
const segment = ({ name }: { name: string }): boolean => isModelSourceSegment({ name })
  && !name.includes('\x7f') && new TextDecoder().decode(new TextEncoder().encode(name)) === name;

export const temporaryRootNameSchema = z.string().refine(name => segment({ name }) && !name.startsWith('.') && !name.includes(':'));
export const temporaryRootIdSchema = z.string().refine(id => id.startsWith('temp/') && temporaryRootNameSchema.safeParse(id.slice(5)).success);
export const temporaryFilePathSchema = z.string().max(8192).refine(path => {
  const [prefix, root, ...parts] = path.split('/');
  return prefix === 'temp' && temporaryRootNameSchema.safeParse(root).success
    && parts.length > 0 && parts.length <= 64 && parts.every(name => segment({ name }));
});
export type TemporaryModelDirectoryInput = { name: string, files: { path: string, file: File }[] };
export type TemporaryModelDirectory = {
  id: string, name: string, sourceName: string, revision: number,
  files: readonly Readonly<{ path: string, file: File }>[],
};

export const TEST_ONLY = {
};
