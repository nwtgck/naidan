import { opfsFormat } from '@/00-format/01-layout/layout';
import { idToRaw, type ImageGenerationSessionId } from '@/01-models/ids';
import { imageGenerationDirectory, imageGenerationIo } from './files';
import { imageGenerationRootIo } from './context';

export function imageGenerationSessionTable({ directory, create }: { directory: FileSystemDirectoryHandle, create: boolean }) {
  return opfsFormat.storage.experimental.imageGeneration.sessions.open({ io: imageGenerationRootIo({ directory }), create });
}

export async function imageGenerationSessionDirectory({ directory, sessionId, requireLive = true }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, requireLive?: boolean,
}): Promise<FileSystemDirectoryHandle | undefined> {
  const location = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
  let current = directory;
  for (const name of location.path.slice(opfsFormat.storage.experimental.imageGeneration.path.length)) {
    const next = await imageGenerationDirectory({ parent: current, name, create: false });
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  if (!requireLive) {
    return current;
  }
  // A directory is not a session without a validated canonical session record.
  const session = await (await imageGenerationSessionTable({ directory, create: false })).load({ id: sessionId });
  return session && session.state !== 'deleted' && session.state !== 'deleting' ? current : undefined;
}

export function imageGenerationRunTable({ directory, sessionId, create }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, create: boolean,
}) {
  const session = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
  return session.runs.open({ io: imageGenerationIo({ directory, path: session.path }), create });
}

export function imageGenerationAssetTable({ directory, sessionId, create }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, create: boolean,
}) {
  const session = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
  return session.assets.open({ io: imageGenerationIo({ directory, path: session.path }), create });
}

export function imageGenerationAnnotationsTable({ directory, sessionId, create }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, create: boolean,
}) {
  const session = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
  return session.annotations.open({ io: imageGenerationIo({ directory, path: session.path }), create });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
