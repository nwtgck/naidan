import { errorCode } from '@/features/llama-cpp-browser/types';
import { z } from 'zod';
import { NaidanRpcError } from '@/features/naidan-rpc';
import { peerChatEventSchema, imageCatalogItemSchema, chatModelReferenceSchema } from '@/features/naidan-peer-rpc/contract';
import { collectBytes, computationSource } from '@/features/naidan-peer-rpc/codecs/transfer';
import { receiveTranscript, eventBytes, TRANSCRIPT_LIMIT, OUTPUT_LIMIT } from '@/features/naidan-peer-rpc/codecs/chat-wire';
import { peerImageDimensions } from '@/features/naidan-peer-rpc/codecs/image-bounds';
import { createImageGenerationFailure } from '@/features/naidan-peer-rpc/handlers/inference/image-generation-failure';
import { createImageResponse } from './image-response';
import type { ReadOnlyInferenceResources, PeerInvocation } from './resources';
import type { InferenceBudget } from './budget';

export type InferenceDependencies = { resources: ReadOnlyInferenceResources; inputBudget: InferenceBudget; deliveryBudget: InferenceBudget };
const chatItemSchema = z.strictObject({ ref: chatModelReferenceSchema, label: z.string().min(1).max(1024) });

export function listChatModels({ resources, signal }: { resources: ReadOnlyInferenceResources } & PeerInvocation<'listChatModels'>) {
  return computationSource<z.infer<typeof chatItemSchema>>({ signal, run: async ({ signal, emit }) => {
    const models = z.array(chatItemSchema).max(256).parse(await resources.listChatModels({ signal }));
    for (const value of models) await emit({ value });
  } });
}
export function listImageModels({ resources, signal }: { resources: ReadOnlyInferenceResources } & PeerInvocation<'listImageModels'>) {
  return computationSource<z.infer<typeof imageCatalogItemSchema>>({ signal, run: async ({ signal, emit }) => {
    const models = z.array(imageCatalogItemSchema).max(256).parse(await resources.listImageModels({ signal }));
    for (const value of models) await emit({ value });
  } });
}
export function generateChat({ resources, inputBudget, input, signal, notify }: InferenceDependencies & PeerInvocation<'generateChat'>) {
  return { events: computationSource<Uint8Array>({ signal, run: async ({ signal, emit }) => {
    const { model, transcript, images, ...rest } = input; rest satisfies Record<PropertyKey, never>;
    const encoded = images.reduce((bytes, image) => bytes + image.byteLength, 0);
    if (encoded > 64 * 1024 * 1024) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
    const leases = [inputBudget.reserve({ bytes: 2 * (TRANSCRIPT_LIMIT + encoded) })];
    try {
      const request = await receiveTranscript({ transcript, images, model, signal });
      // One attachment can be referenced many times in the transcript. Inspect
      // each encoded Blob once, but reserve decoded work for every occurrence.
      // Never copy all repeated payloads and only then check the aggregate.
      const occurrences = new Map<Blob, number>();
      for (const message of request.messages) {
        if (typeof message.content === 'string') continue;
        for (const part of message.content) {
          switch (part.type) {
          case 'text': break;
          case 'image': occurrences.set(part.blob, (occurrences.get(part.blob) ?? 0) + 1); break;
          default: { const exhaustive: never = part; throw new Error(String(exhaustive)); }
          }
        }
      }
      let pixels = 0;
      for (const [blob, uses] of occurrences) {
        signal.throwIfAborted();
        const mimeType = z.enum(['image/png', 'image/jpeg', 'image/webp']).parse(blob.type);
        const dimensions = peerImageDimensions({ bytes: new Uint8Array(await blob.arrayBuffer()), mimeType });
        signal.throwIfAborted();
        const count = dimensions.width * dimensions.height * uses;
        if ((pixels += count) > 8 * 1024 * 1024) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
        leases.push(inputBudget.reserve({ bytes: count * 16 }));
      }
      signal.throwIfAborted();
      let transmitted = 0;
      let result: Awaited<ReturnType<ReadOnlyInferenceResources['generateChat']>>;
      try {
        result = await resources.generateChat({ input: request, signal, onProgress: notify.progress, onEvent: async ({ event }) => {
          const bytes = eventBytes({ event: peerChatEventSchema.parse(event) });
          if ((transmitted += bytes.length) > OUTPUT_LIMIT) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
          await emit({ value: bytes });
        } });
      } catch (error) {
        signal.throwIfAborted();
        // Preserve the base's title-only fallback without leaking native error
        // text or replaying normal chat. Once output starts, never classify a
        // later failure as a pre-generation rejection.
        if (request.reasoningEffort !== undefined && transmitted === 0 && errorCode({ error }) === 'reasoning-unsupported') {
          await emit({ value: eventBytes({ event: { type: 'rejected', reason: 'reasoning-unsupported' } }) });
          return;
        }
        throw error;
      }
      await emit({ value: eventBytes({ event: { type: 'finish', reason: result.finishReason } }) });
    } finally {
      for (const lease of leases) lease.release();
    }
  } }) };
}
export function generateImage({ resources, inputBudget, deliveryBudget, input, signal, notify }: InferenceDependencies & PeerInvocation<'generateImage'>) {
  const { modelSelection, parameters, preview, imageInputs, ...rest } = input; rest satisfies Record<PropertyKey, never>;
  return createImageResponse({ signal, seed: parameters.seed, width: parameters.width, height: parameters.height, budget: deliveryBudget,
    run: async ({ signal, onPreview }) => {
      const { initial, references, strength, ...rest } = imageInputs; rest satisfies Record<PropertyKey, never>;
      const uploads = [...(initial ? [initial] : []), ...references];
      const encoded = uploads.reduce((bytes, image) => bytes + image.byteLength, 0);
      if (encoded > 64 * 1024 * 1024) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
      const leases = [inputBudget.reserve({ bytes: 2 * encoded })];
      let generating = false;
      try {
        const files: File[] = []; let pixels = 0;
        for (const upload of uploads) {
          const { mimeType, byteLength, data, ...rest } = upload; rest satisfies Record<PropertyKey, never>;
          const bytes = await collectBytes({ readable: data, limit: byteLength, signal });
          if (bytes.length !== byteLength) throw new Error('Remote image length mismatch');
          const dimensions = peerImageDimensions({ bytes, mimeType });
          const count = dimensions.width * dimensions.height;
          if ((pixels += count) > 8 * 1024 * 1024) throw new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' });
          leases.push(inputBudget.reserve({ bytes: count * 16 }));
          files.push(new File([bytes], `input-${files.length}`, { type: mimeType }));
        }
        signal.throwIfAborted();
        generating = true;
        return await resources.generateImage({ input: { modelSelection, parameters, preview,
          imageInputs: { initial: initial ? files[0] : undefined, references: initial ? files.slice(1) : files, strength } },
        signal, onProgress: notify.progress, onPreview });
      } catch (error) {
        signal.throwIfAborted();
        throw createImageGenerationFailure({ error, stage: generating ? 'generation' : 'input', reason: generating ? 'generation-failed' : 'invalid-input', profile: undefined, gpu: false, nativeContext: undefined });
      } finally {
        for (const lease of leases) lease.release();
      }
    },
  });
}
export const TEST_ONLY = {
};
