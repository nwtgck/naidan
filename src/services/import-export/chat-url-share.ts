import { storageService } from '../storage';
import { MemoryStorageProvider } from '../storage/memory-storage';
import { ImportExportService, type IImportExportStorage } from './service';
import { hierarchyToDomain } from '../../models/mappers';
import type { MessageNode, Settings } from '../../models/types';

/**
 * Generates a URL that contains a zipped version of the current chat.
 * This URL can be shared and when opened, the chat will be imported into the recipient's storage.
 */
export async function generateChatShareURL({ chatId }: { chatId: string }): Promise<string> {
  const chat = await storageService.loadChat(chatId);
  if (!chat) throw new Error('Chat not found');

  // Create an ephemeral memory storage for this export
  const memoryProvider = new MemoryStorageProvider();
  await memoryProvider.init();

  const adapter: IImportExportStorage = {
    loadSettings: () => memoryProvider.loadSettings(),
    updateSettings: async (updater) => {
      const current = await memoryProvider.loadSettings();
      const updated = await updater(current);
      await memoryProvider.saveSettings(updated);
    },
    listChats: () => memoryProvider.listChats(),
    listChatGroups: () => memoryProvider.listChatGroups(),
    loadChat: (id) => memoryProvider.loadChat(id),
    loadHierarchy: async () => {
      const dto = await memoryProvider.loadHierarchy();
      return dto ? hierarchyToDomain(dto) : null;
    },
    clearAll: () => memoryProvider.clearAll(),
    dumpWithoutLock: () => memoryProvider.dump(),
    restore: (snapshot) => memoryProvider.restore(snapshot),
  };

  // 1. Settings (minimal)
  const currentSettings = await storageService.loadSettings();
  if (currentSettings) {
    await memoryProvider.saveSettings({
      ...currentSettings,
    } as Settings);
  }

  // 2. Chat Data
  await memoryProvider.saveChatMeta(chat);
  await memoryProvider.saveChatContent(chat.id, chat);

  // 3. Hierarchy (minimal)
  await memoryProvider.saveHierarchy({
    items: [{ type: 'chat', id: chat.id }]
  });

  // 4. Attachments
  const binaryObjectIds = new Set<string>();
  const collectBinaryIds = (nodes: MessageNode[]) => {
    for (const node of nodes) {
      if (node.role === 'user' && node.attachments) {
        for (const att of node.attachments) {
          binaryObjectIds.add(att.binaryObjectId);
        }
      }
      if (node.replies?.items) {
        collectBinaryIds(node.replies.items);
      }
    }
  };
  collectBinaryIds(chat.root.items);

  for (const bId of binaryObjectIds) {
    const blob = await storageService.getFile(bId);
    const meta = await storageService.getBinaryObject({ binaryObjectId: bId });
    if (blob && meta) {
      await memoryProvider.saveFile({
        blob,
        binaryObjectId: bId,
        name: meta.name || 'file',
        mimeType: meta.mimeType
      });
    }
  }

  // 5. Export using ImportExportService
  const exportService = new ImportExportService(adapter);
  const { stream } = await exportService.exportData({
    fileNameSegment: chat.title || 'chat-share'
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
