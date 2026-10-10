import type { ChatId } from '@/01-models/ids';
import type { Tool } from '@/01-models/tool';

// Only a mounted Workspace can lend tools to a chat. No persisted tool JSON or
// global settings recreate this capability. Normal Chat loads only this bridge.
const registrations = new Map<ChatId, { create: () => Tool[] }>();

export function registerImageGenerationAssistant({ chatId, create }: { chatId: ChatId, create: () => Tool[] }): () => void {
  if (registrations.has(chatId)) throw new Error('This chat is already connected to another Image Generation.');
  const registration = { create };
  registrations.set(chatId, registration);
  return () => {
    if (registrations.get(chatId) === registration) registrations.delete(chatId);
  };
}

export function getImageGenerationToolsForChat({ chatId }: { chatId: ChatId }): Tool[] {
  return registrations.get(chatId)?.create() ?? [];
}

export const TEST_ONLY = {
};
