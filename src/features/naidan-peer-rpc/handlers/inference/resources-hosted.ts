import { createReadOnlyLlamaCppClient, llamaCppBrowserService } from '@/features/llama-cpp-browser/index-hosted';
import { idToRaw } from '@/01-models/ids';
import type { HostModelDirectoryId } from '@/01-models/ids';
import { listHostImageRepositories, listImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import { scanImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import type { ModelCandidate } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { createImageEngineClient } from '@/features/stable-diffusion-cpp-browser/inference/engine';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import { initialProfile } from '@/features/stable-diffusion-cpp-browser/capabilities';
import { configurationSchema, requestSchema, workerResultSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { Request, ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import rawConfiguration from 'virtual:stable-diffusion-cpp-browser/config';
import type { OwnedInferenceResources } from './resources';
import { imageModelSelectionSchema, imageCatalogItemSchema } from '@/features/naidan-peer-rpc/contract';
import type { PeerImageFile, PeerImageCatalogItem } from '@/features/naidan-peer-rpc/contract';
import { NaidanRpcError } from '@/features/naidan-rpc';

function selectedFile({ candidate }: { candidate: ModelCandidate }): PeerImageFile {
  const file = candidate.files.find(item => item.path === candidate.path)?.file;
  if (!file) throw new Error('The model file is missing');
  return { location: candidate.hostSource
    ? { kind: 'host', directoryId: candidate.hostSource.directoryId, path: `${candidate.hostSource.repository}/${candidate.path}` }
    : { kind: 'opfs', path: `models/${candidate.repositoryId}/${candidate.path}` },
  expected: { size: file.size, lastModified: file.lastModified } };
}
function matches({ candidate, file }: { candidate: ModelCandidate, file: PeerImageFile }): boolean {
  const { location, expected } = file;
  const own = selectedFile({ candidate });
  const present = (() => {
    switch (location.kind) {
    case 'opfs': return own.location.kind === 'opfs' && own.location.path === location.path;
    case 'host': return own.location.kind === 'host' && own.location.directoryId === location.directoryId && own.location.path === location.path;
    default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
    }
  })();
  if (present && expected && (own.expected?.size !== expected.size || own.expected.lastModified !== expected.lastModified)) throw new Error('The selected model changed since it was listed');
  return present;
}
function modelFile({ candidate, slot }: { candidate: ModelCandidate, slot: ModelSlot }): Request['models'][number] {
  if (candidate.issue || !candidate.roles.includes(slot)) throw new Error('The model cannot serve the requested role');
  const main = candidate.files.find(file => file.path === candidate.path);
  if (!main) throw new Error('The model file is missing');
  return { slot, file: main.file, path: candidate.path,
    companions: candidate.files.filter(file => file.path !== candidate.path).map(({ file, path }) => ({ file, path })) };
}
/** Existing files and explicit per-call selections only. Download, import,
 * model deletion, provider preference changes and provider history writes are
 * intentionally absent, not unfinished remote-management TODOs. */
export function createReadOnlyResources({ directories }: { directories(): readonly { id: HostModelDirectoryId, name: string }[] }): OwnedInferenceResources {
  const lifetime = new AbortController();
  const chat = createReadOnlyLlamaCppClient();
  let closing: Promise<void> | undefined;
  const operationSignal = ({ signal }: { signal: AbortSignal }) => {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    combined.throwIfAborted(); return combined;
  };
  let image: ImageClient | undefined;
  let imageBusy = false;
  let imageRetirement: Promise<void> = Promise.resolve();
  const inventory = async ({ signal }: { signal: AbortSignal }) => {
    signal.throwIfAborted();
    const opfs = await listImageRepositories({ signal });
    const host = await listHostImageRepositories({ directories: directories().map(({ id, name }) => ({ id: idToRaw({ id }), name })), signal });
    signal.throwIfAborted();
    return scanImageRepositories({ repositories: [...opfs, ...host], signal });
  };
  return {
    async listChatModels({ signal }) {
      signal = operationSignal({ signal });
      const models = await llamaCppBrowserService.listModels({ signal });
      signal.throwIfAborted(); return models.map(model => ({ ref: model.name, label: model.name }));
    },
    async generateChat({ input, signal, onEvent, onProgress }) {
      signal = operationSignal({ signal });
      const result = await chat.generate({ input, signal, onEvent, onProgress: ({ progress }) => {
        let phase: 'computing' | 'loading' | 'decoding';
        const current = progress.phase;
        switch (current) {
        case 'generating': case 'prefill': phase = 'computing'; break;
        case 'loading': case 'initializing': case 'importing': phase = 'loading'; break;
        case 'decoding-audio': phase = 'decoding'; break;
        default: { const exhaustive: never = current; throw new Error(String(exhaustive)); }
        }
        onProgress({ value: { phase, completed: progress.completed, total: progress.total } });
      } });
      signal.throwIfAborted(); return result;
    },
    async listImageModels({ signal }) {
      signal = operationSignal({ signal });
      const config = configurationSchema.parse(rawConfiguration);
      switch (config.kind) {
      case 'unavailable': return [];
      case 'available': break;
      default: { const exhaustive: never = config; throw new Error(String(exhaustive)); }
      }
      const result: PeerImageCatalogItem[] = [];
      for (const candidate of (await inventory({ signal })).candidates) {
        if (candidate.issue || candidate.files.length === 0) continue;
        const roles = candidate.classes.includes('lora') ? ['lora' as const] : candidate.roles;
        if (!roles.length) continue;
        const file = selectedFile({ candidate });
        // A split diffusion file is not a ready-to-generate model bundle. Do
        // not infer missing encoders/VAE or use the owner's saved editor preset.
        const selection = candidate.roles.includes('model') && !candidate.classes.includes('lora') ? { primary: { slot: 'model' as const, file }, components: [], loras: [] } : undefined;
        result.push(imageCatalogItemSchema.parse({ label: candidate.path, file, roles, selection }));
        if (result.length > 256) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
      }
      signal.throwIfAborted(); return result;
    },
    async generateImage({ input, signal, onProgress, onPreview }) {
      signal = operationSignal({ signal });
      if (imageBusy) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
      imageBusy = true;
      const retired = Promise.withResolvers<void>();
      imageRetirement = retired.promise;
      try {
        const selection = imageModelSelectionSchema.parse(input.modelSelection);
        const candidates = (await inventory({ signal })).candidates;
        const find = ({ file }: { file: PeerImageFile }) => {
          const candidate = candidates.find(candidate => !candidate.issue && matches({ candidate, file }));
          if (!candidate) throw new Error('The requested model is missing or outside the permitted roots');
          return candidate;
        };
        const models = [modelFile({ candidate: find({ file: selection.primary.file }), slot: selection.primary.slot }),
          ...selection.components.map(({ slot, file }) => modelFile({ candidate: find({ file }), slot }))];
        const loras = selection.loras.map(({ file, strength }) => {
          const candidate = find({ file });
          if (!candidate.classes.includes('lora') || candidate.files.length !== 1) throw new Error('The requested adapter is not a single LoRA file');
          return { file: candidate.files[0]!.file, path: candidate.path, strength };
        });
        const config = configurationSchema.parse(rawConfiguration);
        switch (config.kind) {
        case 'unavailable': throw new Error('Local image inference is not included in this build');
        case 'available': break;
        default: { const exhaustive: never = config; throw new Error(String(exhaustive)); }
        }
        const artifact = config.artifacts.find(artifact => artifact.profile === initialProfile());
        if (!artifact) throw new Error('The local image profile is not available');
        const request = requestSchema.parse({ artifact, models, loras, debug: 'off', weightResidency: 'auto',
          baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href,
          preview: input.preview,
          imageInputs: { initImage: input.imageInputs.initial, referenceImages: input.imageInputs.references, strength: input.imageInputs.strength },
          parameters: { ...input.parameters, vaeTiling: true, vaeTileSize: 32, flashAttention: false, bf16WeightType: 'f32',
            qwenVaePolicy: 'bounded', conditioningCacheSize: 0, modelArguments: '' },
        });
        signal.throwIfAborted(); image ??= createImageEngineClient({ onReleased: undefined });
        const rawResult = await image.generate({ request, signal, onPreview: ({ frame }) => {
          signal.throwIfAborted(); onPreview({ frame });
        }, onProgress: ({ event }) => {
          signal.throwIfAborted();
          let phase: 'computing' | 'loading' | 'decoding' | 'encoding';
          const current = event.phase;
          switch (current) {
          case 'sampling': phase = 'computing'; break;
          case 'runtime': case 'model': phase = 'loading'; break;
          case 'decoding': case 'encoding': phase = current; break;
          default: { const exhaustive: never = current; throw new Error(String(exhaustive)); }
          }
          onProgress({ value: { phase, completed: event.step, total: event.steps } });
        } });
        signal.throwIfAborted();
        const result = workerResultSchema.parse(rawResult);
        if ('cancelled' in result) throw new DOMException('Image generation cancelled', 'AbortError');
        return result;
      } finally {
        imageBusy = false;
        retired.resolve();
      }
    },
    dispose() {
      if (closing) return closing;
      const completed = Promise.withResolvers<void>();
      closing = completed.promise;
      lifetime.abort();
      const retiring = chat.dispose();
      // The image owner aborts immediately; acknowledgment also waits for the
      // in-flight resource call. Never release another local UI owner's cache.
      let imageDisposal: Promise<void>;
      try {
        image?.dispose(); imageDisposal = Promise.resolve();
      } catch (error) {
        imageDisposal = Promise.reject(error);
      }
      image = undefined;
      // A failing dispose must not let the other native operation retire early.
      void Promise.allSettled([retiring, imageRetirement, imageDisposal]).then(results => {
        for (const result of results) {
          switch (result.status) {
          case 'fulfilled': break;
          case 'rejected': completed.reject(result.reason); return;
          default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
          }
        }
        completed.resolve();
      }).catch(completed.reject);
      return closing;
    },
  };
}
export const TEST_ONLY = {
  matches,
  modelFile,
};
