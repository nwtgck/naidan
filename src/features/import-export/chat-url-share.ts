import { storageService } from '@/00-storage/service';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { ImportExportService, type IImportExportStorage } from './service';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import { hierarchyToDomain, hierarchyToDto } from '@/00-storage/mapper/mappers';
import type { MessageNode, Settings } from '@/01-models/types';
import { toBinaryObjectId, type BinaryObjectId, type ChatId } from '@/01-models/ids';
import { GeneratedImageBlockSchema, IMAGE_BLOCK_LANG } from '@/utils/image-generation';

/**
 * Generates a URL that contains a zipped version of the current chat.
 * This URL can be shared and when opened, the chat will be imported into the recipient's storage.
 */
export async function generateChatShareURL({ chatId }: { chatId: ChatId }): Promise<string> {
  const chat = await storageService.loadChat({ id: chatId });
  if (!chat) throw new Error('Chat not found');

  // Create an ephemeral memory storage for this export
  const memoryProvider = new MemoryStorageProvider();
  await memoryProvider.init();

  const adapter: IImportExportStorage = {
    loadSettings: () => memoryProvider.loadSettings(),
    updateSettings: async ({ updater }) => {
      const current = await memoryProvider.loadSettings();
      const updated = await updater({ current: current });
      await memoryProvider.saveSettings({ settings: updated });
    },
    listChats: () => memoryProvider.listChats(),
    listChatGroups: () => memoryProvider.listChatGroups(),
    loadChat: ({ id }) => memoryProvider.loadChat({ id }),
    loadHierarchy: async () => {
      const dto = await memoryProvider.loadHierarchy();
      return dto ? hierarchyToDomain({ dto }) : null;
    },
    clearAll: () => memoryProvider.clearAll(),
    dumpWithoutLock: () => memoryProvider.dump(),
    restore: ({ snapshot }) => memoryProvider.restore({ snapshot }),
  };

  // 1. Settings (minimal)
  const currentSettings = await storageService.loadSettings();
  if (currentSettings) {
    await memoryProvider.saveSettings({ settings: {
      ...currentSettings,
    } satisfies Settings });
  }

  // 2. Chat Data
  await memoryProvider.saveChatMeta({ meta: chat });
  await memoryProvider.saveChatContent({ id: chat.id, content: chat });

  // 3. Hierarchy (minimal)
  await memoryProvider.saveHierarchy({ hierarchy: hierarchyToDto({ domain: {
    items: [{ type: 'chat', id: chat.id }],
  } }) });

  // 4. Copy binaries referenced anywhere in the exported tree. Model text and
  // reasoning stay unchanged; only known image markers describe binary references.
  const binaryObjectIds = new Set<BinaryObjectId>();
  const memoryFiles = new Map<BinaryObjectId, { blob: Blob; name: string; mimeType: string }>();
  const nodes: MessageNode[] = [...chat.root.items];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    nodes.push(...node.replies.items);
    for (const part of node.parts) {
      switch (part.type) {
      case 'attachment': {
        const attachment = part.attachment;
        binaryObjectIds.add(attachment.binaryObjectId);
        switch (attachment.status) {
        case 'memory': memoryFiles.set(attachment.binaryObjectId, { blob: attachment.blob, name: attachment.originalName, mimeType: attachment.mimeType }); break;
        case 'persisted':
        case 'missing': break;
        default: { const _ex: never = attachment; throw new Error(`Unhandled attachment: ${_ex}`); }
        }
        break;
      }
      case 'text': {
        const blocks = new RegExp('```' + IMAGE_BLOCK_LANG + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g');
        for (const match of part.text.matchAll(blocks)) {
          if (match[1] === undefined) continue;
          try {
            const parsed = GeneratedImageBlockSchema.safeParse(JSON.parse(match[1]));
            if (parsed.success) binaryObjectIds.add(toBinaryObjectId({ raw: parsed.data.binaryObjectId }));
          } catch { /* Invalid marker text is preserved, not treated as a reference. */ }
        }
        break;
      }
      case 'tool_result': {
        const result = part.result;
        const content = (() => {
          switch (result.status) {
          case 'executing': return undefined;
          case 'success': return result.content;
          case 'error': return result.error.message;
          default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
          }
        })();
        if (content !== undefined) {
          switch (content.type) {
          case 'text': break;
          case 'binary_object': binaryObjectIds.add(content.id); break;
          default: { const _ex: never = content; throw new Error(`Unhandled result content: ${_ex}`); }
          }
        }
        break;
      }
      case 'reasoning':
      case 'tool_call': break;
      default: { const _ex: never = part; throw new Error(`Unhandled message part: ${_ex}`); }
      }
    }
  }

  for (const binaryObjectId of binaryObjectIds) {
    const memory = memoryFiles.get(binaryObjectId);
    if (memory !== undefined) {
      await memoryProvider.saveFile({ ...memory, binaryObjectId });
      continue;
    }
    const blob = await storageService.getFile({ binaryObjectId });
    const meta = await storageService.getBinaryObject({ binaryObjectId });
    if (blob && meta) {
      await memoryProvider.saveFile({ blob, binaryObjectId, name: meta.name ?? 'file', mimeType: meta.mimeType });
    }
  }

  // 5. Export using ImportExportService
  const exportService = new ImportExportService({ storage: adapter });
  const { stream } = await exportService.exportData({
    fileNameSegment: chat.title || 'chat-share',
  });

  // 6. Convert to Base64
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const zipBlob = new Blob(chunks as unknown as BlobPart[], { type: 'application/zip' });

  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => {
      const result = fr.result as string;
      const zipBase64 = result.split(',')[1];
      if (!zipBase64) return reject(new Error('Failed to encode ZIP to Base64'));

      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';

      const params = new URLSearchParams();
      params.set('data-zip', zipBase64);

      url.hash = `/?${params.toString()}`;
      resolve(url.toString());
    };
    fr.onerror = reject;
    fr.readAsDataURL(zipBlob);
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
