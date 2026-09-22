import { ChatContentSchemaDto, type MessageNodeDto } from '@/00-storage/00-dto/dto';

// Validate with Zod, but retain the parsed JSON itself: even a loose object
// schema can omit reserved keys from its returned object. Only the two known
// attachment reference fields below may be changed by this migration.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord({ value }: { value: unknown }): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a JSON object in validated chat content.');
  return value;
}

function readItems({ value }: { value: unknown }): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a JSON array in validated chat content.');
  return value;
}

/** Returns a rewritten document only when a legacy reference actually changes. */
export function remapLegacyUploadedFileReferences({ serialized, binaryObjectIds }: {
  serialized: string,
  binaryObjectIds: ReadonlyMap<string, ReadonlyMap<string, string>>,
}): { serialized: string | undefined, unresolvedReferences: number } {
  const original: unknown = JSON.parse(serialized);
  const validated = ChatContentSchemaDto.parse(original);
  const document = readRecord({ value: original });
  const root = readRecord({ value: document.root });
  const pending: { nodes: MessageNodeDto[], originals: unknown[] }[] = [
    { nodes: validated.root.items, originals: readItems({ value: root.items }) },
  ];
  let modified = false;
  let unresolvedReferences = 0;
  while (pending.length > 0) {
    const branch = pending.pop();
    if (!branch) break;
    for (const [index, node] of branch.nodes.entries()) {
      const record = readRecord({ value: branch.originals[index] });
      branch.originals[index] = record;
      if (node.parts === undefined && node.role === 'user' && node.attachments !== undefined) {
        const attachments = readItems({ value: record.attachments });
        for (const [attachmentIndex, attachment] of node.attachments.entries()) {
          if ('binaryObjectId' in attachment) continue;
          const copiedFiles = binaryObjectIds.get(attachment.id);
          const binaryObjectId = copiedFiles?.get(attachment.originalName);
          if (binaryObjectId === undefined) {
            // A nonempty legacy directory with no matching file is ambiguous.
            // Do not redirect the reference to whichever entry was copied last.
            if (copiedFiles !== undefined && copiedFiles.size > 0) unresolvedReferences++;
            continue;
          }
          const source = readRecord({ value: attachments[attachmentIndex] });
          attachments[attachmentIndex] = {
            ...source,
            binaryObjectId,
            name: attachment.originalName,
          };
          modified = true;
        }
        record.attachments = attachments;
      }
      const replies = readRecord({ value: record.replies });
      pending.push({ nodes: node.replies.items, originals: readItems({ value: replies.items }) });
    }
  }
  if (!modified) return { serialized: undefined, unresolvedReferences };
  // Validate the deliberate reference edits without using stripped parse output.
  ChatContentSchemaDto.parse(document);
  return { serialized: JSON.stringify(document), unresolvedReferences };
}

/** Reads legacy metadata before attachment V2 moves it into the binary index. */
export function readLegacyUploadedFileMetadata({ serialized }: { serialized: string }): {
  attachmentId: string,
  name: string,
  mimeType: string,
  createdAt: number,
}[] {
  const content = ChatContentSchemaDto.parse(JSON.parse(serialized) as unknown);
  const pending = [...content.root.items];
  const metadata: ReturnType<typeof readLegacyUploadedFileMetadata> = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (node.parts === undefined && node.role === 'user') {
      for (const attachment of node.attachments ?? []) {
        if ('binaryObjectId' in attachment) continue;
        metadata.push({
          attachmentId: attachment.id,
          name: attachment.originalName,
          mimeType: attachment.mimeType,
          createdAt: attachment.uploadedAt,
        });
      }
    }
    for (const reply of node.replies.items) pending.push(reply);
  }
  return metadata;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
