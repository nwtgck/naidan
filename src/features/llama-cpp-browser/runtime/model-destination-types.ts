import { z } from 'zod';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Build configuration consumes this schema before Vite aliases exist.
import { parseRepositoryModelId } from '../../../01-models/llama-cpp-browser-model-id';

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
  default: {
    const exhaustive: never = target;
    throw new Error(String(exhaustive));
  }
  }
}

/** Validate the public segment separately: suffixes and encoded folder names
 * are not directory IDs and must not inherit their length constraint.
 */
export function parsePublicHostModelReference({ modelId }: { modelId: string }): { alias: string, repository: string, selector: string | undefined } {
  const { source, repository, variant } = parseRepositoryModelId({ modelId });
  switch (source.kind) {
  case 'host': return { alias: source.alias, repository, selector: variant };
  case 'hugging-face': throw new Error('Invalid public linked model reference');
  default: throw new Error(String(source satisfies never));
  }
}

export function isHostDestination(destination: ModelDestination | undefined): destination is Extract<ModelDestination, { kind: 'host' }> {
  if (!destination) {
    return false;
  }
  switch (destination.kind) {
  case 'host': return true;
  case 'opfs': return false;
  default: {
    const exhaustive: never = destination;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
