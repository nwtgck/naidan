import { z } from 'zod';
import type { ModelSupportInvestigationRepository } from '@/features/transformers-js/model-support-investigation/types';
import { investigationJsonObjectSchema, parseInvestigationJson } from '@/features/transformers-js/model-support-investigation/logic/json-value-schema';

const repositoryLfsSchema = z.object({
  oid: z.string().optional(),
  size: z.number().finite().optional(),
}).passthrough();

const repositoryFileSchema = z.object({
  rfilename: z.string().min(1),
  size: z.number().finite().optional(),
  blobId: z.string().optional(),
  lfs: repositoryLfsSchema.optional(),
}).passthrough();

const repositoryMetadataSchema = z.object({
  sha: z.string(),
  siblings: z.array(repositoryFileSchema),
  pipeline_tag: z.string().optional(),
  library_name: z.string().optional(),
}).passthrough();

export function normalizeHuggingFaceModelId({ modelId }: { modelId: string }): string {
  let value = modelId.trim();
  if (value.startsWith('https://huggingface.co/')) {
    value = value.slice('https://huggingface.co/'.length);
  } else if (value.startsWith('hf.co/')) {
    value = value.slice('hf.co/'.length);
  }
  value = value.replace(/^\/+|\/+$/g, '');
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Unsupported Hugging Face model ID: ${modelId}`);
  }
  return parts.join('/');
}

function repositoryApiUrl({ normalizedModelId, requestedRevision }: {
  normalizedModelId: string,
  requestedRevision: string,
}): string {
  const encodedModelId = normalizedModelId.split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://huggingface.co/api/models/${encodedModelId}/revision/${encodeURIComponent(requestedRevision)}?blobs=true`;
}

export async function inspectHuggingFaceRepository({
  modelId,
  requestedRevision,
  repositoryFetch,
}: {
  modelId: string,
  requestedRevision: 'main',
  repositoryFetch: typeof fetch,
}): Promise<ModelSupportInvestigationRepository> {
  const normalizedModelId = normalizeHuggingFaceModelId({ modelId });
  const apiUrl = repositoryApiUrl({ normalizedModelId, requestedRevision });
  const response = await repositoryFetch(apiUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Hugging Face repository metadata request failed: ${response.status} ${response.statusText}`);
  }

  const responseUrl = response.url || apiUrl;
  const contentType = response.headers.get('content-type') ?? undefined;
  if (contentType?.toLowerCase().includes('text/html') === true) {
    throw new Error(`Hugging Face repository metadata resolved to HTML instead of JSON: ${responseUrl}`);
  }

  const text = await response.text();
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
    throw new Error(`Hugging Face repository metadata returned HTML-like content instead of JSON: ${responseUrl}`);
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Hugging Face repository metadata is not valid JSON at ${responseUrl}: ${detail}`, { cause: error });
  }
  const metadataJson = investigationJsonObjectSchema.parse(parseInvestigationJson({
    value: parsedMetadata,
    label: 'Hugging Face repository metadata',
  }));
  const metadata = repositoryMetadataSchema.parse(metadataJson);
  const resolvedRevision = metadata.sha;
  if (!/^[0-9a-f]{40}$/iu.test(resolvedRevision)) {
    throw new Error('Hugging Face repository metadata did not include a resolved commit SHA');
  }
  const files = metadata.siblings.map(sibling => ({
    path: sibling.rfilename,
    size: sibling.size ?? sibling.lfs?.size,
    blobId: sibling.blobId,
    lfsOid: sibling.lfs?.oid,
  })).sort((a, b) => a.path.localeCompare(b.path));

  return {
    requestedModelId: modelId,
    normalizedModelId,
    requestedRevision,
    resolvedRevision,
    apiUrl,
    responseUrl,
    fileCount: files.length,
    files,
    pipelineTag: metadata.pipeline_tag,
    libraryName: metadata.library_name,
    metadata: metadataJson,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
