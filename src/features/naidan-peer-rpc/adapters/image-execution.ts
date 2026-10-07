import { createImageExecutionPlan } from '@/features/image-generation/execution/plan';
import type { PreparedImageExecution, ImageExecutionOutcome, ImageExecutionProgress } from '@/features/image-generation/execution/types';
import { imageModelSelectionSchema, naidanPeerContract, peerImageParametersSchema, peerImagePreviewSchema } from '@/features/naidan-peer-rpc/contract';
import type { PeerImageInput, PeerProgress } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import type { RpcClientBinding } from '@/features/naidan-peer-rpc/runtime/manager';
import { startPeerImage } from './image-provider';

/** This is an in-memory request, not a persisted local model snapshot. Input
 * Files remain caller-owned; no provider filesystem handle crosses the wire. */
export type PeerImageExecutionSnapshot = {
  target: { type: 'naidan_rpc', connection: RpcClientBinding['connection'] },
  input: PeerImageInput,
};
function copyInput({ input }: { input: PeerImageInput }): PeerImageInput {
  const { modelSelection, parameters, preview, imageInputs, ...rest } = input;
  rest satisfies Record<PropertyKey, never>;
  const { initial, references, strength, ...imageRest } = imageInputs;
  imageRest satisfies Record<PropertyKey, never>;
  return { modelSelection: imageModelSelectionSchema.parse(modelSelection), parameters: peerImageParametersSchema.parse(parameters),
    preview: peerImagePreviewSchema.parse(preview), imageInputs: { initial, references: [...references],
      strength: naidanPeerContract.methods.generateImage.input.shape.imageInputs.shape.strength.parse(strength) } };
}
function copySnapshot({ snapshot }: { snapshot: PeerImageExecutionSnapshot }): PeerImageExecutionSnapshot {
  const { target, input, ...rest } = snapshot;
  rest satisfies Record<PropertyKey, never>;
  return { target: { type: target.type, connection: { ...target.connection } }, input: copyInput({ input }) };
}
function progress({ value }: { value: PeerProgress }): ImageExecutionProgress {
  const { phase, completed, total, ...rest } = value;
  rest satisfies Record<PropertyKey, never>;
  const mapped = (() => {
    switch (phase) {
    case 'waiting': return 'runtime' as const;
    case 'loading': return 'model' as const;
    case 'computing': return 'sampling' as const;
    case 'decoding': return 'decoding' as const;
    case 'encoding': return 'encoding' as const;
    default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
    }
  })();
  return { phase: mapped, step: completed, steps: total };
}

/** Preparing does not query models, connect, upload, or generate. The captured
 * client and abort signal pin every seed in this plan to the original session.
 * A later reconnection cannot silently execute the remaining images elsewhere. */
export function preparePeerImageExecution({ binding, input }: {
  binding: RpcClientBinding, input: PeerImageInput,
}): PreparedImageExecution<PeerImageExecutionSnapshot> {
  const { client, signal: sessionSignal, connection, ...rest } = binding;
  rest satisfies Record<PropertyKey, never>;
  const snapshot = copySnapshot({ snapshot: { target: { type: 'naidan_rpc', connection }, input } });
  return createImageExecutionPlan({ snapshot, copySnapshot,
    start({ seed, signal, onProgress, onPreview }) {
      const stop = AbortSignal.any([signal, sessionSignal]);
      const job = startPeerImage({ client, input: { ...copyInput({ input: snapshot.input }), parameters: { ...snapshot.input.parameters, seed } },
        signal: stop, onProgress: ({ value }) => onProgress({ event: progress({ value }) }), onPreview });
      return { cancel: job.cancel, updatePreview: undefined,
        result: job.result.then((outcome): ImageExecutionOutcome => {
          switch (outcome.status) {
          case 'completed': return { status: 'completed', output: outcome.output };
          case 'interrupted': case 'cancelled': case 'failed': return outcome;
          default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
          }
        }) };
    },
  });
}
export const TEST_ONLY = {
};
