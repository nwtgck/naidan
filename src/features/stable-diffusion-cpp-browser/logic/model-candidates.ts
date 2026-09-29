import { imageModelRecipes } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import { z } from 'zod';
import type { InspectionReport } from '@/features/stable-diffusion-cpp-browser/inventory-worker/types';
import type { ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import { inspectWeightFile, readModelJson, type TensorInfo, type WeightMetadata } from './model-metadata';
import { relativeCompanionPath } from './model-path';
import type { LocalImageRepository, RepositoryFile } from './repository-store';

export type ImageFamily = 'sd-checkpoint' | 'z-image' | 'qwen-image-2.1' | 'flux1' | 'unknown';
export type ComponentClass = 'vae-flux16' | 'vae-qwen21' | 'lm-qwen3-4b' | 'lm-qwen3vl-8b' | 'clip-l' | 'clip-g' | 't5-xxl' | 'other-lm' | 'other-vae';
export type ModelCandidate = {
  id: string; repositoryId: string; path: string; files: RepositoryFile[];
  format: 'gguf' | 'safetensors' | 'safetensors-index';
  size: number; family: ImageFamily; classes: ComponentClass[]; roles: ModelSlot[];
  evidence: string[]; issue: string | undefined; turboHint: boolean; variant: 'turbo' | 'base' | 'unknown';
};
export type ModelInventory = { candidates: ModelCandidate[], issues: { repositoryId: string, path: string, message: string }[] };
const configSchema = z.object({
  model_type: z.string().optional(), _class_name: z.string().optional(),
  text_config: z.object({ model_type: z.string().optional() }).optional(),
});
const indexSchema = z.object({ weight_map: z.record(z.string().min(1), z.string().min(1)).refine(value => Object.keys(value).length > 0) });

function fingerprint({ tensors, metadata, config }: { tensors: TensorInfo[], metadata: ReadonlyMap<string, string | number | boolean>, config: z.infer<typeof configSchema> | undefined }): Pick<ModelCandidate, 'family' | 'roles' | 'classes' | 'evidence' | 'turboHint' | 'variant'> {
  const find = ({ suffix }: { suffix: string }): TensorInfo | undefined => tensors.find(t => t.name === suffix || t.name.endsWith('.' + suffix));
  const has = ({ pattern }: { pattern: RegExp }): boolean => tensors.some(t => pattern.test(t.name));
  const classes: ComponentClass[] = [], roles: ModelSlot[] = [], evidence: string[] = [];
  let family: ImageFamily = 'unknown';
  const cap = find({ suffix: 'cap_embedder.0.weight' });
  const capProjection = find({ suffix: 'cap_embedder.1.weight' });
  const zInput = tensors.find(t => /(^|\.)(x_embedder|all_x_embedder\.2-1)\.weight$/.test(t.name));
  const qText = find({ suffix: 'txt_in.text_norm.weight' });
  const qInput = find({ suffix: 'img_in.weight' });
  const unet = has({ pattern: /(^|\.)(input_blocks\.0\.0|down_blocks\.0\.resnets\.0\.conv1)\.weight$/ });
  const decoder = find({ suffix: 'decoder.conv_in.weight' });
  const text = has({ pattern: /(^|\.)token_embedding\.weight$/ });
  if (cap?.shape[0] === 2560 && capProjection?.shape.at(-1) === 2560 && zInput?.shape.at(-1) === 64) {
    family = 'z-image'; roles.push('diffusion'); evidence.push('cap_embedder: 2560; image patch input: 64');
  } else if (qText?.shape[0] === 4096 && qInput?.shape.at(-1) === 64 && find({ suffix: 'txt_in.in_layer.weight' })?.shape.at(-1) === 4096) {
    family = 'qwen-image-2.1'; roles.push('diffusion'); evidence.push('txt_in.text_norm: 4096; image latent: 64');
  } else if (unet && decoder && text) {
    family = 'sd-checkpoint'; roles.push('model'); evidence.push('UNet + text encoder + image decoder in one checkpoint');
  } else if (has({ pattern: /(^|\.)double_blocks\.0\.img_attn\./ }) && has({ pattern: /(^|\.)single_blocks\.0\./ })) {
    family = 'flux1'; roles.push('diffusion'); evidence.push('FLUX double/single transformer blocks');
  }
  const vaeOutput = find({ suffix: 'decoder.conv_out.weight' });
  if (decoder && vaeOutput && decoder.shape.length === 4 && decoder.shape[1] === 16 && vaeOutput.shape[0] === 3 && find({ suffix: 'encoder.conv_out.weight' })?.shape[0] === 32) {
    classes.push('vae-flux16'); roles.push('vae'); evidence.push('2D VAE: latent 16, RGB output, encoder 32');
  } else {
    const conv2 = find({ suffix: 'conv2.weight' }), head = find({ suffix: 'decoder.head.2.weight' });
    const conv1 = find({ suffix: 'decoder.conv1.weight' });
    if (conv2?.shape[0] === 64 && conv2.shape[1] === 64 && head?.shape[0] === 4 && conv1?.shape[1] === 64) {
      classes.push('vae-qwen21'); roles.push('vae'); evidence.push('Qwen Image 2.1 VAE: latent 64, RGBA output');
    } else if (decoder || has({ pattern: /(^|\.)decoder\.(conv1|head\.2)\.weight$/ })) {
      classes.push('other-vae'); roles.push('vae'); evidence.push('Image decoder with a different or unknown latent format');
    }
  }
  const architecture = metadata.get('general.architecture');
  const embedding = find({ suffix: 'token_embd.weight' }) ?? find({ suffix: 'model.embed_tokens.weight' }) ?? find({ suffix: 'embed_tokens.weight' });
  const qNorm = tensors.find(t => /(^|\.)(blk\.0\.attn_q_norm|layers\.0\.self_attn\.q_norm)\.weight$/.test(t.name));
  let layers = 0;
  for (const tensor of tensors) {
    const match = /(?:^|\.)(?:blk|layers)\.([0-9]+)\./.exec(tensor.name);
    if (match && !tensor.name.includes('visual')) layers = Math.max(layers, Number(match[1]) + 1);
  }
  const width = embedding?.shape.at(-1);
  const q3 = architecture === 'qwen3' || config?.model_type === 'qwen3';
  const q3vl = architecture === 'qwen3vl' || config?.model_type === 'qwen3_vl' || config?.text_config?.model_type === 'qwen3_vl_text'
    || has({ pattern: /visual\.deepstack_merger_list\./ });
  if (embedding) {
    roles.push('lm');
    // Dimensions and architecture must agree. Qwen2.5-VL / Gemma / differently
    // sized Qwen models never become defaults merely from a filename hint.
    if ((q3 || (!q3vl && !architecture && !config?.model_type && !config?.text_config?.model_type && qNorm?.shape[0] === 128)) && width === 2560 && layers === 36) classes.push('lm-qwen3-4b');
    // Qwen3-VL-8B has 36 text layers, not 32 attention heads.
    // https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/blob/main/config.json
    else if (q3vl && width === 4096 && layers === 36) classes.push('lm-qwen3vl-8b');
    else if (architecture || config?.model_type || config?.text_config?.model_type || !((width === 2560 && layers === 36) || (width === 4096 && layers === 36))) classes.push('other-lm');
    // A stripped text-only export can lack evidence identifying its model
    // family. Matching dimensions alone are not sufficient for an automatic
    // choice, but absence of evidence is not a known incompatibility either.
    evidence.push(`Text architecture: ${String(architecture ?? config?.model_type ?? 'unverified')}; width: ${width}; layers: ${layers}`);
  }
  if (text && !unet) {
    const clip = find({ suffix: 'token_embedding.weight' });
    if (clip?.shape.at(-1) === 768) {
      roles.push('clipL'); classes.push('clip-l');
    } else if (clip?.shape.at(-1) === 1280) {
      roles.push('clipG'); classes.push('clip-g');
    }
  }
  if (has({ pattern: /encoder\.block\.0\.layer\.0\.SelfAttention\.q\.weight$/ }) && tensors.some(t => t.name.endsWith('shared.weight') && t.shape.at(-1) === 4096)) {
    roles.push('t5'); classes.push('t5-xxl');
  }
  const training = ['general.name', 'general.basename', 'general.finetune'].map(key => String(metadata.get(key) ?? '')).join(' ');
  // Base/Turbo share tensor shapes. A renamed filename must never select the
  // eight-step distillation preset; unknown metadata stays unknown.
  const variant = (() => {
    switch (family) {
    case 'z-image': return /\bturbo\b/i.test(training) ? 'turbo' : /\bbase\b/i.test(training) ? 'base' : 'unknown';
    case 'sd-checkpoint': case 'qwen-image-2.1': case 'flux1': case 'unknown': return 'unknown';
    default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
    }
  })();
  return { family, roles: [...new Set(roles)], classes, evidence, turboHint: variant === 'turbo', variant };
}

/** Header-based evidence is advisory, not proof of training-weight provenance. */
export async function scanImageRepositories({ repositories, signal, onProgress }: { repositories: LocalImageRepository[], signal: AbortSignal | undefined, onProgress?: InspectionReport }): Promise<ModelInventory> {
  const candidates: ModelCandidate[] = [], issues: ModelInventory['issues'] = [];
  const total = repositories.reduce((n, repo) => n + repo.files.length, 0);
  let completed = 0;
  for (const repository of repositories) {
    for (const issue of repository.issues ?? []) issues.push({ repositoryId: repository.id, ...issue });
    const inspected = new Map<string, WeightMetadata>();
    const fileMap = new Map(repository.files.map(file => [file.path, file]));
    const configs = new Map<string, z.infer<typeof configSchema>>();
    const indices: { path: string, map: Record<string, string> }[] = [];
    const failures = new Map<string, string>();
    for (const entry of repository.files) {
      signal?.throwIfAborted();
      const progress = () => onProgress?.({ progress: { phase: 'headers', completed, total, path: `${repository.id}/${entry.path}`.slice(0, 2048) } });
      progress(); completed++;
      // Report real I/O progress without reading any additional bytes.
      const file = { size: entry.file.size,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Blob slice-compatible adapter.
        slice(start?: number, end?: number) {
          return { async arrayBuffer() {
            const bytes = await entry.file.slice(start, end).arrayBuffer(); progress(); return bytes;
          } };
        },
      };
      if (/\.json$/i.test(entry.path)) {
        if (!/(?:^|\/)(?:config|model_index)\.json$|\.index\.json$/i.test(entry.path)) continue;
        try {
          const data = await readModelJson({ file, signal });
          if (/\.index\.json$/i.test(entry.path)) indices.push({ path: entry.path, map: indexSchema.parse(data).weight_map });
          else configs.set(entry.path, configSchema.parse(data));
        } catch (error) {
          signal?.throwIfAborted(); failures.set(entry.path, error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (/\.(md|txt|png|jpg|jpeg|webp|gitattributes|gitignore)$/i.test(entry.path) || entry.path.startsWith('.')) continue;
      const inspection = await inspectWeightFile({ file, signal });
      switch (inspection.status) {
      case 'weights': inspected.set(entry.path, inspection.value); break;
      case 'invalid': case 'lfs-pointer': failures.set(entry.path, inspection.reason); break;
      case 'unknown':
        if (/\.(gguf|safetensors|sft)$/i.test(entry.path)) failures.set(entry.path, inspection.reason);
        break;
      default: { const exhaustive: never = inspection; throw new Error(String(exhaustive)); }
      }
    }
    const tensorNamesByFile = new Map([...inspected].map(([path, data]) => [path, new Set(data.tensors.map(tensor => tensor.name))]));
    const consumed = new Set<string>();
    function add({ path, members, format, issue }: { path: string, members: string[], format: ModelCandidate['format'], issue: string | undefined }): void {
      const tensors: TensorInfo[] = [];
      const metadata = new Map<string, string | number | boolean>();
      const names = new Set<string>();
      for (const name of members) {
        const item = inspected.get(name);
        if (!item) continue;
        for (const tensor of item.tensors) {
          if (names.has(tensor.name)) issue = 'Duplicate tensor names across shards';
          names.add(tensor.name); tensors.push(tensor);
        }
        for (const [key, value] of item.metadata) {
          if (key === 'general.architecture' && metadata.has(key) && metadata.get(key) !== value) issue = 'Shard architecture metadata disagrees';
          if (!metadata.has(key)) metadata.set(key, value);
        }
        issue ??= item.unsupported;
      }
      const configPath = relativeCompanionPath({ indexPath: path, reference: 'config.json' });
      const facts = fingerprint({ tensors, metadata, config: configs.get(configPath) ?? configs.get('config.json') });
      const files = [path, ...members.filter(member => member !== path)].map(name => fileMap.get(name)).filter((entry): entry is RepositoryFile => entry !== undefined);
      // Published immutable catalog provenance can identify a distilled variant
      // whose exported header has no training label. Require structure AND receipt.
      const turboRecipe = imageModelRecipes.find(recipe => recipe.id === 'z-image-turbo');
      const source = fileMap.get(path)?.receipt?.source;
      if (facts.family === 'z-image' && source?.kind === 'hugging-face' && turboRecipe?.components.some(component => component.role === 'diffusion' && component.options.some(option =>
        option.repository === source.repository && option.revision === source.revision && option.path === source.path))) {
        facts.variant = 'turbo'; facts.turboHint = true; facts.evidence.push('Turbo variant: verified catalog download receipt');
      }
      candidates.push({ id: JSON.stringify([repository.id, path]), repositoryId: repository.id, path, files, format, size: files.reduce((n, f) => n + f.file.size, 0), ...facts, issue });
    }
    for (const index of indices) {
      const shards = new Set<string>(); let issue: string | undefined;
      for (const [tensor, reference] of Object.entries(index.map)) {
        try {
          const path = relativeCompanionPath({ indexPath: index.path, reference });
          shards.add(path);
          const data = inspected.get(path);
          if (data?.format !== 'safetensors' || !tensorNamesByFile.get(path)?.has(tensor)) issue = `Missing shard or declared tensor: ${path} / ${tensor}`;
        } catch {
          issue = 'Index contains an unsafe companion reference';
        }
      }
      const members = [...shards]; members.forEach(path => consumed.add(path));
      add({ path: index.path, members, format: 'safetensors-index', issue });
    }
    const groups = new Map<string, string[]>();
    for (const [path, data] of inspected) {
      if (consumed.has(path)) continue;
      const match = /^(.*)-([0-9]{5})-of-([0-9]{5})(\.gguf)$/i.exec(path);
      if (data.format === 'gguf' && (data.split && data.split.count > 1 || match && Number(match[3]) > 1)) {
        const key = match ? `${match[1]}-of-${match[3]}${match[4]}` : path;
        const group = groups.get(key) ?? []; group.push(path); groups.set(key, group);
      } else add({ path, members: [path], format: data.format, issue: /-[0-9]{5}-of-[0-9]{5}\.(safetensors|sft)$/i.test(path) ? 'Select the complete safetensors index, not an individual shard' : undefined });
    }
    for (const group of groups.values()) {
      group.sort(); const first = group[0]!; const data = inspected.get(first)!;
      const match = /^(.*)-([0-9]{5})-of-([0-9]{5})(\.gguf)$/i.exec(first);
      let issue: string | undefined;
      const count = data.split?.count;
      if (!match || count === undefined || count !== Number(match[3]) || count !== group.length) issue = 'Incomplete GGUF shard group';
      let total = 0;
      for (let i = 0; i < group.length; i++) {
        const value = inspected.get(group[i]!)!;
        if (!match || group[i] !== `${match[1]}-${String(i + 1).padStart(5, '0')}-of-${match[3]}${match[4]}` || !value.split || value.split.index !== i || value.split.count !== count || value.split.tensors !== data.split?.tensors) issue = 'GGUF shard names or split metadata disagree';
        total += value.tensors.length;
      }
      if (total !== data.split?.tensors) issue ??= 'GGUF shard tensor total mismatch';
      add({ path: first, members: group, format: 'gguf', issue });
    }
    for (const [path, message] of failures) issues.push({ repositoryId: repository.id, path, message });
  }
  for (const candidate of candidates) if (candidate.issue) issues.push({ repositoryId: candidate.repositoryId, path: candidate.path, message: candidate.issue });
  signal?.throwIfAborted(); onProgress?.({ progress: { phase: 'headers', completed: total, total, path: '' } }); return { candidates, issues };
}
export function componentRequirements({ family }: { family: ImageFamily }): { slot: ModelSlot, accepts: ComponentClass[] }[] {
  switch (family) {
  case 'z-image': return [{ slot: 'vae', accepts: ['vae-flux16'] }, { slot: 'lm', accepts: ['lm-qwen3-4b'] }];
  case 'qwen-image-2.1': return [{ slot: 'vae', accepts: ['vae-qwen21'] }, { slot: 'lm', accepts: ['lm-qwen3vl-8b'] }];
  case 'flux1': return [{ slot: 'vae', accepts: ['vae-flux16'] }, { slot: 'clipL', accepts: ['clip-l'] }, { slot: 't5', accepts: ['t5-xxl'] }];
  case 'sd-checkpoint': case 'unknown': return [];
  default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
  }
}
export function componentMatch({ candidate, requirement }: { candidate: ModelCandidate, requirement: { slot: ModelSlot, accepts: ComponentClass[] } }): 'matching' | 'unverified' | 'incompatible' {
  if (candidate.issue) return 'incompatible';
  if (candidate.classes.some(value => requirement.accepts.includes(value))) return 'matching';
  if (candidate.classes.length || candidate.roles.length && !candidate.roles.includes(requirement.slot)) return 'incompatible';
  return 'unverified';
}
export function defaultCompanion({ main, candidates, requirement }: { main: ModelCandidate, candidates: ModelCandidate[], requirement: { slot: ModelSlot, accepts: ComponentClass[] } }): string | undefined {
  const entries = candidates.filter(candidate => candidate.id !== main.id && componentMatch({ candidate, requirement }) === 'matching');
  // Smaller files are a footprint preference, not a quality or memory guarantee.
  entries.sort((a, b) => Number(b.repositoryId === main.repositoryId) - Number(a.repositoryId === main.repositoryId) || a.size - b.size || a.id.localeCompare(b.id));
  return entries[0]?.id;
}
export const TEST_ONLY = {
  fingerprint,
};
