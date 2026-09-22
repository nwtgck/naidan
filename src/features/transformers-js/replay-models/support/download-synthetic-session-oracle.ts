import { createHash } from 'node:crypto';
import { z } from 'zod';

const identitySchema = z.object({
  modelId: z.string().regex(/^[^/]+\/[^/]+$/u),
  revision: z.string().regex(/^[0-9a-f]{40}$/u),
  path: z.string().regex(/^onnx\/[a-zA-Z0-9_.-]+\.onnx(?:_data(?:_\d+)?)?$/u),
}).strict();
const bodySchema = z.object({
  format: z.literal('naidan-synthetic-model-body-v1'),
  identity: identitySchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const optionsSchema = z.object({
  executionProviders: z.array(z.enum(['webgpu', 'wasm'])).nonempty(),
  externalData: z.array(z.object({ path: z.string(), data: z.instanceof(Uint8Array) }).strict()).optional(),
}).passthrough();

type SyntheticBodyIdentity = z.infer<typeof identitySchema>;
export type SyntheticSessionObservation = {
  modelId: string,
  revision: string,
  corePath: string,
  externalData: Array<{ path: string, artifactPath: string }>,
  executionProviders: Array<'webgpu' | 'wasm'>,
};

/** Small, identifiable test bytes. This is deliberately not an ONNX model. */
export function createSyntheticModelBody({ modelId, revision, path }: SyntheticBodyIdentity): Uint8Array {
  const identity = identitySchema.parse({ modelId, revision, path });
  const sha256 = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return new TextEncoder().encode(JSON.stringify({ format: 'naidan-synthetic-model-body-v1', identity, sha256 }));
}

export function readSyntheticModelBody({ bytes }: { bytes: Uint8Array }): SyntheticBodyIdentity {
  if (bytes.byteLength > 4096) throw new Error('Synthetic model body exceeds the fixture size limit');
  const body = bodySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const expected = createHash('sha256').update(JSON.stringify(body.identity)).digest('hex');
  if (body.sha256 !== expected) throw new Error('Synthetic model body checksum mismatch');
  return body.identity;
}

/** Validate ORT inputs before returning a fake session; never accepts arbitrary bytes. */
export function inspectSyntheticOrtSession({ modelId, revision, repositoryPaths, core, options }: {
  modelId: string,
  revision: string,
  repositoryPaths: ReadonlySet<string>,
  core: unknown,
  options: unknown,
}): SyntheticSessionObservation {
  function readIdentity({ bytes }: { bytes: Uint8Array }) {
    const identity = readSyntheticModelBody({ bytes });
    if (identity.modelId !== modelId || identity.revision !== revision) {
      throw new Error(`Synthetic model identity mismatch: ${identity.modelId}@${identity.revision}`);
    }
    if (!repositoryPaths.has(identity.path)) throw new Error(`Synthetic model path is not in the repository inventory: ${identity.path}`);
    return identity;
  }
  const identity = readIdentity({ bytes: z.instanceof(Uint8Array).parse(core) });
  if (!identity.path.endsWith('.onnx')) throw new Error('Synthetic ORT core must identify an ONNX core path');
  const parsedOptions = optionsSchema.parse(options);
  const externalData = (parsedOptions.externalData ?? []).map(({ path, data }) => {
    const externalIdentity = readIdentity({ bytes: data });
    if (`onnx/${path}` !== externalIdentity.path) throw new Error(`Synthetic external data binding mismatch: ${path} versus ${externalIdentity.path}`);
    const coreExternalPrefix = `${identity.path}_data`;
    const suffix = externalIdentity.path.slice(coreExternalPrefix.length);
    if (!externalIdentity.path.startsWith(coreExternalPrefix) || (suffix !== '' && !/^_\d+$/u.test(suffix))) {
      throw new Error(`Synthetic external data does not belong to core ${identity.path}: ${externalIdentity.path}`);
    }
    return { path, artifactPath: externalIdentity.path };
  });
  if (new Set(externalData.map(item => item.path)).size !== externalData.length) {
    throw new Error('Synthetic ORT session has duplicate external data bindings');
  }
  return { modelId, revision, corePath: identity.path, externalData, executionProviders: parsedOptions.executionProviders };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
