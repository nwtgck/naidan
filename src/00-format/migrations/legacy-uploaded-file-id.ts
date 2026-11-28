import { toBinaryObjectId, type BinaryObjectId } from '@/01-models/ids';

/** A retry copies the same legacy entry without allocating another orphan body. */
export async function createLegacyUploadedFileId({ attachmentId, name }: {
  attachmentId: string,
  name: string,
}): Promise<BinaryObjectId> {
  // Hash only the unambiguous source identity, not a potentially large file body.
  const identity = new TextEncoder().encode(JSON.stringify([attachmentId, name]));
  const digest = await crypto.subtle.digest('SHA-256', identity);
  const suffix = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return toBinaryObjectId({ raw: `uploaded_${suffix}` });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
