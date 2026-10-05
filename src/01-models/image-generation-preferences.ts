import type { NaidanRpcConnectionId, NaidanRpcPeerId } from './ids';
import type { RemoteImageModelFile } from './image-generation-history';

/** Editor state is separate from the immutable configuration of a generation.
 * Empty selections and disabled adapters remain meaningful after reopening. */
export type RemoteImageModelEditor = {
  primary: { slot: 'model' | 'diffusion', file: RemoteImageModelFile, family: string | undefined } | undefined,
  components: { slot: 'vae' | 'clipL' | 'clipG' | 't5' | 'lm', file: RemoteImageModelFile }[],
  loras: { file: RemoteImageModelFile, strength: number, enabled: 'enabled' | 'disabled' }[],
};

export type ImageInferenceLocationPreference =
  | { kind: 'local' }
  | { kind: 'naidan_rpc', connection: { connectionId: NaidanRpcConnectionId, peerId: NaidanRpcPeerId } | undefined };

export type RemoteImageModelEditorPreference = {
  connectionId: NaidanRpcConnectionId,
  peerId: NaidanRpcPeerId,
  editor: RemoteImageModelEditor,
};

export const TEST_ONLY = {
};
