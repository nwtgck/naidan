import { z } from 'zod';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Build configuration consumes this schema before Vite aliases exist.
import { modelSourceRepositorySchema, modelSourceFileSchema } from '../../../01-models/llama-cpp-browser-model-launch';

export const modelDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opfs') }).strict(),
  z.object({ kind: z.literal('host'), directoryId: z.string().min(1).max(255) }).strict(),
]);
export type ModelDestination = z.infer<typeof modelDestinationSchema>;

export function destinationKey({ destination }: { destination: ModelDestination | undefined }): string {
  const target = destination ?? { kind: 'opfs' };
  switch (target.kind) {
  case 'opfs': return 'opfs';
  case 'host': return `host/${encodeURIComponent(target.directoryId)}`;
  default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
  }
}

export function hostModelReference({ directoryId, repository, modelPath }: { directoryId: string, repository: string, modelPath: string | undefined }): string {
  modelDestinationSchema.parse({ kind: 'host', directoryId }); modelSourceRepositorySchema.parse(repository);
  if (modelPath !== undefined) modelSourceFileSchema.shape.path.parse(modelPath);
  return `host/${encodeURIComponent(directoryId)}/${repository}${modelPath === undefined ? '' : `:${encodeURIComponent(modelPath)}`}`;
}

export function parseHostModelReference({ name }: { name: string }): { destination: Extract<ModelDestination, { kind: 'host' }>, repository: string, modelPath: string | undefined } {
  const match = /^host\/([^/]+)\/([^:]+)(?::(.+))?$/.exec(name);
  if (!match) throw new Error('Invalid linked model reference');
  const directoryId = decodeURIComponent(match[1]!); const repository = match[2]!;
  const modelPath = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
  if (hostModelReference({ directoryId, repository, modelPath }) !== name) throw new Error('Non-canonical linked model reference');
  return { destination: { kind: 'host', directoryId }, repository, modelPath };
}

export function isHostDestination(destination: ModelDestination | undefined): destination is Extract<ModelDestination, { kind: 'host' }> {
  if (!destination) return false;
  switch (destination.kind) {
  case 'host': return true;
  case 'opfs': return false;
  default: { const exhaustive: never = destination; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
};
