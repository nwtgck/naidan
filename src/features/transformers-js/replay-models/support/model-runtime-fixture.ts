import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL as NodeUrl } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

const modelDirectories: Record<string, string> = {
  'HuggingFaceTB/SmolLM2-1.7B-Instruct': 'huggingfacetb--smollm2-1.7b-instruct',
  'HuggingFaceTB/SmolLM2-135M-Instruct': 'huggingfacetb--smollm2-135m-instruct',
  'LiquidAI/LFM2.5-2.6B-ONNX': 'liquidai--lfm2.5-2.6b-onnx',
  'LiquidAI/LFM2.5-230M-ONNX': 'liquidai--lfm2.5-230m-onnx',
  'LiquidAI/LFM2.5-350M-ONNX': 'liquidai--lfm2.5-350m-onnx',
  'onnx-community/gemma-4-E2B-it-ONNX': 'onnx-community--gemma-4-e2b-it-onnx',
  'onnx-community/gpt-oss-20b-ONNX': 'onnx-community--gpt-oss-20b-onnx',
  'onnx-community/Qwen3.5-2B-ONNX': 'onnx-community--qwen3.5-2b-onnx',
  'onnx-community/Qwen3.5-4B-ONNX': 'onnx-community--qwen3.5-4b-onnx',
};

const recordedResourceSchema = z.object({
  path: z.string().regex(/^[a-z_]+\.(?:json|jinja)$/u),
  status: z.literal('recorded'),
  asset: z.string().regex(/^model-[a-z_]+\.(?:json|jinja)(?:\.gz)?$/u),
  encoding: z.enum(['identity', 'gzip']),
  byteLength: z.number().int().positive().max(32 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  scope: z.literal('Selected original runtime metadata and complete ONNX path/size inventory; not a complete repository or runnable model.'),
  resources: z.array(z.discriminatedUnion('status', [
    recordedResourceSchema,
    z.object({ path: z.string().regex(/^[a-z_]+\.(?:json|jinja)$/u), status: z.literal('repository-absent') }).strict(),
  ])).min(1),
  modelArtifacts: z.array(z.object({ path: z.string().regex(/^onnx\/[^/]+$/u), size: z.number().int().nonnegative().optional() }).strict()).min(1),
}).strict();

function readRecordedResource({ directory, resource }: {
  directory: URL, resource: z.infer<typeof recordedResourceSchema>,
}): Uint8Array {
  const stored = readFileSync(new NodeUrl(resource.asset, directory));
  const bytes = (() => {
    switch (resource.encoding) {
    case 'identity': return stored;
    case 'gzip': return gunzipSync(stored, { maxOutputLength: resource.byteLength });
    default: {
      const exhaustive: never = resource.encoding;
      throw new Error(`Unhandled fixture encoding: ${exhaustive}`);
    }
    }
  })();
  if (bytes.byteLength !== resource.byteLength || createHash('sha256').update(bytes).digest('hex') !== resource.sha256) {
    throw new Error(`Invalid checked-in original bytes: ${resource.path}`);
  }
  // Preserve the browser-facing byte type, not Node's Buffer subclass.
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function readModelFixture({ modelId }: { modelId: string }) {
  const slug = modelDirectories[modelId];
  if (slug === undefined) throw new Error(`No checked-in model fixture: ${modelId}`);
  // Fixture paths belong to Node's filesystem, not Vite's browser asset graph.
  const directory = new NodeUrl(`../${slug}/`, import.meta.url);
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(new NodeUrl('model-runtime-inputs.evidence.json', directory), 'utf8')));
  if (manifest.modelId !== modelId) throw new Error('Mismatched checked-in model identity');
  if (new Set(manifest.resources.map(resource => resource.path)).size !== manifest.resources.length
    || new Set(manifest.modelArtifacts.map(resource => resource.path)).size !== manifest.modelArtifacts.length) {
    throw new Error('Ambiguous checked-in resource identity');
  }
  const files = new Map<string, Uint8Array>();
  for (const resource of manifest.resources) {
    switch (resource.status) {
    case 'recorded': files.set(resource.path, readRecordedResource({ directory, resource })); break;
    case 'repository-absent': break;
    default: {
      const exhaustive: never = resource;
      throw new Error(`Unhandled fixture resource: ${exhaustive}`);
    }
    }
  }
  return {
    summary: { modelId, revision: manifest.revision, files: manifest.resources },
    files,
    repository: { resolvedRevision: manifest.revision, files: manifest.modelArtifacts },
  };
}

export function modelFixtureIds() {
  return Object.keys(modelDirectories);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  readRecordedResource,
};
