import { storageService } from '@/00-storage/service';
import { modelGraphRequestRegistrations } from './request-registry';

/** Read at request admission, not during token generation. Do not cache across
 * storage-provider generations or hide an unreadable approved registry. */
export async function readModelGraphRequestSettings() {
  const snapshot = await storageService.loadModelGraphRegistry();
  return modelGraphRequestRegistrations({ registrations: snapshot.registrations });
}

export const TEST_ONLY = {
};
