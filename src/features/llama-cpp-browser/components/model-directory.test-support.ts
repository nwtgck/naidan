import type { ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';

export function localModelDirectory({ primaryRelativePath, projectorRelativePath }: { primaryRelativePath: string, projectorRelativePath: string | undefined }): ModelDirectory {
  const primaryFile = { relativePath: primaryRelativePath, file: new File(['GGUF'], primaryRelativePath.split('/').at(-1)!), storageKind: 'temp' as const, registrationRevision: 1 };
  const projectorFile = projectorRelativePath === undefined ? undefined : { ...primaryFile, relativePath: projectorRelativePath, file: new File(['GGUF'], projectorRelativePath.split('/').at(-1)!) };
  return { primaryFile, projectorFile, files: projectorFile ? [primaryFile, projectorFile] : [primaryFile] };
}
