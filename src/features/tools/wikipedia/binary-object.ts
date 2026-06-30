import { NAIDAN_SYSFS_MOUNT_PATH } from '@/features/wesh/types';
import { storageService } from '@/00-storage/service';
import { generateId } from '@/01-models/id';
import { idToRaw } from '@/01-models/ids';
import type { BinaryObjectId } from '@/01-models/ids';

export const WIKIPEDIA_INLINE_CONTENT_MAX_LINES = 80;

export type SavedWikipediaPageBinaryObject = {
  lineCount: number,
  byteLength: number,
  sysfsNaidanDataFilePath: string,
};

export function countLines({
  text,
}: {
  text: string,
}): number {
  // Avoid split('\n') here because it allocates a full array of lines for large page text.
  if (text.length === 0) {
    return 0;
  }

  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }

  return lineCount;
}

function buildWikipediaBinaryObjectName({
  title,
  lang,
  pageId,
}: {
  title: string,
  lang: string,
  pageId: number,
}): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/^_+|_+$/g, '');

  const titlePart = safeTitle.length > 0 ? safeTitle : 'wikipedia';

  return `${titlePart}_${lang}_${pageId}.txt`;
}

function buildSysfsNaidanBinaryObjectDataFilePath({
  binaryObjectId,
}: {
  binaryObjectId: BinaryObjectId,
}): string {
  return `${NAIDAN_SYSFS_MOUNT_PATH}/binary-objects/by-id/${idToRaw({ id: binaryObjectId })}/data`;
}

export async function saveWikipediaPageTextAsBinaryObject({
  lang,
  pageId,
  title,
  content,
  lineCount,
}: {
  lang: string,
  pageId: number,
  title: string,
  content: string,
  lineCount: number,
}): Promise<SavedWikipediaPageBinaryObject> {
  const binaryObjectId = generateId<BinaryObjectId>();
  const name = buildWikipediaBinaryObjectName({
    title,
    lang,
    pageId,
  });
  const blob = new Blob([content], {
    type: 'text/plain;charset=utf-8',
  });
  const byteLength = blob.size;

  await storageService.saveFile({ blob, binaryObjectId, name });

  return {
    lineCount,
    byteLength,
    sysfsNaidanDataFilePath: buildSysfsNaidanBinaryObjectDataFilePath({
      binaryObjectId,
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  buildWikipediaBinaryObjectName,
  buildSysfsNaidanBinaryObjectDataFilePath,
};
