import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import type { DownloadDestination } from '@/01-models/download';
import type { AuthorizeModelLaunchDestination } from './entry-state';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { confirmModelLaunchConfiguration, initialRepositorySelection } from '@/features/llama-cpp-browser/model-launch/target';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { awaitInspection } from '@/logic/model-file-inspection/abort';

export function bundledRepositoryDownloadKey({ repository, variant, companionPath }: { repository: string, variant: string, companionPath: string | undefined }): string {
  return `bundled:${JSON.stringify([repository.toLowerCase(), variant, companionPath])}`;
}

export async function resolveBundledRepositoryTarget({ repository, variant, companionPath, signal }: {
  repository: string, variant: string, companionPath: string | undefined, signal: AbortSignal,
}): Promise<ModelLaunchTarget> {
  const catalog = await awaitInspection({ task: getMetadataSession().inspect({ input: repository, signal, freshness: 'refresh' }), signal });
  signal.throwIfAborted();
  if (catalog.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const { mainPath } = initialRepositorySelection({ catalog, requestedVariant: variant });
  try {
    return confirmModelLaunchConfiguration({ catalog, mainFilePath: mainPath, companionFilePath: companionPath, multimodal: companionPath === undefined ? 'off' : 'on' });
  } catch {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
}

export type RepositoryModelSource =
  | { kind: 'bundled', repository: string, variant: string, companionPath: string | undefined }
  | { kind: 'resolved', target: ModelLaunchTarget };

export type RepositoryModelSelection = {
  modelId: string,
  source: RepositoryModelSource,
  defaultDownloadKey?: string,
  destination: DownloadDestination,
  authorizeDestination: AuthorizeModelLaunchDestination | undefined,
};

export function repositoryModelDownloadIdentity({ source }: { source: RepositoryModelSource }) {
  switch (source.kind) {
  case 'bundled': return { key: bundledRepositoryDownloadKey(source), selection: undefined };
  case 'resolved': return { key: selectionKey({ selection: source.target.selection }), selection: source.target.selection };
  default: throw new Error(String(source satisfies never));
  }
}

export const TEST_ONLY = {
};
