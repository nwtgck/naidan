import { z } from 'zod';
import { inspectWeightFile, readModelJson, type ModelMetadataFile, type WeightMetadata } from '@/features/stable-diffusion-cpp-browser/logic/model-metadata';
import { relativeCompanionPath, validModelPath } from '@/features/stable-diffusion-cpp-browser/logic/model-path';
import type { Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { SyncBlobReader } from './gguf-file';

type Input = Request['models'][number];
const indexSchema = z.object({ weight_map: z.record(z.string().min(1), z.string().min(1)).refine(map => Object.keys(map).length > 0) });
/** Validate untrusted model/index data before the native parser can fall back to
 * a different format. No model-provided network path or code is ever executed. */
export async function validateModelMounts({ input, reader, capabilities }: { input: Input, reader: SyncBlobReader, capabilities: number }): Promise<{ path: string, files: { path: string, file: File }[], summary: { tensorCount: number, dtypes: string, largestElements: number } }> {
  const path = input.path ?? input.file.name;
  const files = [{ path, file: input.file }, ...(input.companions ?? [])];
  const names = new Set(files.map(file => file.path));
  if (files.some(file => !validModelPath({ path: file.path })) || names.size !== files.length) throw new Error('Unsafe or duplicate model paths');
  const metadata = new Map<string, WeightMetadata>();
  function source({ file }: { file: File }): ModelMetadataFile {
    return { size: file.size,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Platform Blob.slice signature.
      slice(start, end) {
        return { async arrayBuffer() {
          return reader.readAsArrayBuffer(file.slice(start, end));
        } };
      },
    };
  }
  for (const entry of files) {
    if (entry.path === path && /\.json$/i.test(path)) continue;
    const inspection = await inspectWeightFile({ file: source({ file: entry.file }), signal: undefined });
    switch (inspection.status) {
    case 'weights': break;
    case 'invalid': case 'unknown': case 'lfs-pointer': throw new Error(`${entry.path}: ${inspection.reason}`);
    default: { const exhaustive: never = inspection; throw new Error(String(exhaustive)); }
    }
    if (inspection.value.unsupported) throw new Error(inspection.value.unsupported);
    if (inspection.value.format === 'safetensors' && entry.file.size >= 2 ** 32 && !(capabilities & 1)) throw new Error('This bicore needs the 64-bit safetensors update. Keep the original file; do not split it.');
    metadata.set(entry.path, inspection.value);
  }
  const primary = metadata.get(path);
  const required = new Set([path]);
  if (!primary) {
    if (!/\.json$/i.test(path)) throw new Error('Unsupported primary model file');
    const index = indexSchema.parse(await readModelJson({ file: source({ file: input.file }), signal: undefined }));
    const tensorNames = new Map<string, Set<string>>();
    for (const [key, value] of metadata) tensorNames.set(key, new Set(value.tensors.map(tensor => tensor.name)));
    for (const [tensor, reference] of Object.entries(index.weight_map)) {
      const target = relativeCompanionPath({ indexPath: path, reference }); required.add(target);
      if (metadata.get(target)?.format !== 'safetensors' || !tensorNames.get(target)?.has(tensor)) throw new Error(`Missing index shard or tensor: ${target} / ${tensor}`);
    }
  } else if (primary.format === 'gguf' && primary.split && primary.split.count > 1) {
    if (!(capabilities & 2)) throw new Error('This bicore needs the GGUF shard-group update. Keep the repository shard files unchanged.');
    const match = /^(.*)-([0-9]{5})-of-([0-9]{5})(\.gguf)$/i.exec(path);
    if (!match || Number(match[2]) !== primary.split.index + 1 || Number(match[3]) !== primary.split.count) throw new Error('GGUF filename and split metadata disagree');
    let count = 0;
    for (let i = 0; i < primary.split.count; i++) {
      const target = `${match[1]}-${String(i + 1).padStart(5, '0')}-of-${match[3]}${match[4]}`;
      required.add(target); const member = metadata.get(target);
      if (!member || member.format !== 'gguf' || !member.split || member.split.index !== i || member.split.count !== primary.split.count || member.split.tensors !== primary.split.tensors) throw new Error('Incomplete or inconsistent GGUF shard group');
      count += member.tensors.length;
    }
    if (count !== primary.split.tensors) throw new Error('GGUF shard tensor total mismatch');
  } else if (/-[0-9]{5}-of-[0-9]{5}\.(gguf|safetensors|sft)$/i.test(path)) {
    throw new Error('Select the complete shard group or safetensors index, not one unindexed shard');
  }
  const tensorNames = new Set<string>();
  for (const name of required) for (const tensor of metadata.get(name)?.tensors ?? []) {
    if (tensorNames.has(tensor.name)) throw new Error('Duplicate tensors in model shard group'); tensorNames.add(tensor.name);
  }
  // Unreferenced source files are preserved in storage, but never mounted.
  const dtypes = new Map<string, number>(); let tensorCount = 0, largestElements = 0;
  for (const name of required) for (const tensor of metadata.get(name)?.tensors ?? []) {
    const type = tensor.dtype === '30' ? 'BF16' : tensor.dtype === '0' ? 'F32' : tensor.dtype === '1' ? 'F16' : tensor.dtype;
    dtypes.set(type, (dtypes.get(type) ?? 0) + 1); tensorCount++;
    largestElements = Math.max(largestElements, tensor.shape.reduce((n, value) => n * value, 1));
  }
  return { path, files: files.filter(entry => required.has(entry.path)), summary: {
    tensorCount, dtypes: JSON.stringify(Object.fromEntries(dtypes)).slice(0, 512), largestElements,
  } };
}
export const TEST_ONLY = {
};
