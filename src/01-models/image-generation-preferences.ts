import type { UnavailableRpcValue } from './unavailable-rpc-value';
import type { NaidanRpcRegistrationId, NaidanRpcPeerPublicKey } from './ids';
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
  | { kind: 'naidan_rpc', registration: { registrationId: NaidanRpcRegistrationId, peerPublicKey: NaidanRpcPeerPublicKey } | undefined, unavailableRpc?: never }
  | { kind: 'naidan_rpc', registration: undefined, unavailableRpc: UnavailableRpcValue };

export type RemoteImageModelEditorPreference = {
  registrationId: NaidanRpcRegistrationId,
  peerPublicKey: NaidanRpcPeerPublicKey,
  editor: RemoteImageModelEditor,
};

export type RemoteImageModelEditorPreferenceValue = RemoteImageModelEditorPreference | { unavailableRpc: UnavailableRpcValue };

export function isAvailableRemoteImageEditor(value: RemoteImageModelEditorPreferenceValue): value is RemoteImageModelEditorPreference {
  return !('unavailableRpc' in value);
}

export function areImageInferenceLocationsEqual({ left, right }: { left: ImageInferenceLocationPreference, right: ImageInferenceLocationPreference }): boolean {
  switch (left.kind) {
  case 'local': return right.kind === 'local';
  case 'naidan_rpc': break;
  default: { const exhaustive: never = left; throw new Error(String(exhaustive)); }
  }
  switch (right.kind) {
  case 'local': return false;
  case 'naidan_rpc': break;
  default: { const exhaustive: never = right; throw new Error(String(exhaustive)); }
  }
  return left.registration?.registrationId === right.registration?.registrationId && left.registration?.peerPublicKey === right.registration?.peerPublicKey
    && (left.unavailableRpc === undefined ? right.unavailableRpc === undefined : right.unavailableRpc !== undefined && left.unavailableRpc.equals({ other: right.unavailableRpc }));
}

export const TEST_ONLY = {
};
