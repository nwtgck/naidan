import type { z } from 'zod';
import type { NaidanPeerImplementation, PeerImageCatalogItem, PeerImageModelSelection, peerImageParametersSchema, peerImagePreviewSchema, peerProgressSchema } from '@/features/naidan-peer-rpc/contract';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { ImageExecutionOutput, ImageExecutionPreview } from '@/features/image-generation/execution/types';

export type PeerImageParameters = z.infer<typeof peerImageParametersSchema>;
export type PeerProgress = z.infer<typeof peerProgressSchema>;
export type PeerChatInput = Parameters<LlamaCppBrowserService['generate']>[0]['input'];
export type PeerImageInput = {
  modelSelection: PeerImageModelSelection;
  parameters: PeerImageParameters;
  preview: z.infer<typeof peerImagePreviewSchema>;
  imageInputs: { initial: File | undefined; references: File[]; strength: number };
};
/** Deliberately read-only at the provider storage boundary. No download,
 * import, delete, settings mutation or history writer is an RPC capability.
 * Per-call file selection controls computation, never the provider's editor. */
export interface ReadOnlyInferenceResources {
  listChatModels({ signal }: { signal: AbortSignal }): Promise<{ ref: string; label: string }[]>;
  generateChat({ input, signal, onEvent, onProgress }: {
    input: PeerChatInput; signal: AbortSignal;
    onEvent: Parameters<LlamaCppBrowserService['generate']>[0]['onEvent'];
    onProgress({ value }: { value: PeerProgress }): void;
  }): ReturnType<LlamaCppBrowserService['generate']>;
  listImageModels({ signal }: { signal: AbortSignal }): Promise<PeerImageCatalogItem[]>;
  generateImage({ input, signal, onProgress, onPreview }: {
    input: PeerImageInput; signal: AbortSignal;
    onProgress({ value }: { value: PeerProgress }): void;
    onPreview({ frame }: { frame: ImageExecutionPreview }): void;
  }): Promise<ImageExecutionOutput>;
}
/** Local lifecycle only, never exposed as a peer method. Dispose requests
 * cancellation and releases this owner's cached resources, not other clients'. */
export type OwnedInferenceResources = ReadOnlyInferenceResources & { dispose(): void | Promise<void> };
export type PeerInvocation<K extends keyof NaidanPeerImplementation> = Parameters<NaidanPeerImplementation[K]>[0];
export const TEST_ONLY = {
};
