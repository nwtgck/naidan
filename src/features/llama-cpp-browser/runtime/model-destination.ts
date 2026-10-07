import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { hostModelDirectoryLock, hostModelPermissionGranted } from '@/logic/host-model-directories';
import { modelDestinationSchema, type ModelDestination } from './model-destination-types';
export { modelDestinationSchema, destinationKey, hostModelReference, parseHostModelReference, isHostDestination, type ModelDestination } from './model-destination-types';

export async function hostModelRoot({ destination, mode }: { destination: Extract<ModelDestination, { kind: 'host' }>, mode: 'read' | 'readwrite' }): Promise<HostModelDirectoryHandle> {
  modelDestinationSchema.parse(destination);
  const handle = await hostModelHandles.get({ id: toHostModelDirectoryId({ raw: destination.directoryId }) });
  if (!handle) throw new Error('Reconnect the linked model folder');
  if (!hostModelPermissionGranted({ permission: await handle.queryPermission({ mode }) })) throw new Error('Linked model folder permission expired; reconnect the folder');
  return handle;
}
export async function withDestinationLock<T>({ destination, operation, signal }: { destination: ModelDestination | undefined, signal?: AbortSignal, operation: () => Promise<T> }): Promise<T> {
  const target = destination ?? { kind: 'opfs' };
  switch (target.kind) {
  case 'opfs': return operation();
  case 'host': return navigator.locks.request(hostModelDirectoryLock({ id: toHostModelDirectoryId({ raw: target.directoryId }) }), { signal }, operation);
  default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
};
