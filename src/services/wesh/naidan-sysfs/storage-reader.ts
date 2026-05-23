import { hierarchyToDomain } from '@/models/mappers'
import type { EmptyArgs } from '@/models/types'
import { OPFSStorageProvider } from '@/services/storage/opfs-storage'
import type { NaidanSysfsStorageReader } from './types'

export async function createOpfsNaidanSysfsStorageReader(
  _args: EmptyArgs,
): Promise<NaidanSysfsStorageReader> {
  const provider = new OPFSStorageProvider()
  await provider.init()

  return {
    async loadHierarchy(_args: EmptyArgs) {
      const dto = await provider.loadHierarchy()
      return dto ? hierarchyToDomain({ dto }) : { items: [] }
    },
    async getSidebarStructure(_args: EmptyArgs) {
      return provider.getSidebarStructure()
    },
    async listChats(_args: EmptyArgs) {
      return provider.listChats()
    },
    async listChatGroups(_args: EmptyArgs) {
      return provider.listChatGroups()
    },
    async loadChatMeta({ chatId }: { chatId: string }) {
      return (await provider.loadChatMeta({ id: chatId })) ?? undefined
    },
    async loadChatContent({ chatId }: { chatId: string }) {
      return (await provider.loadChatContent({ id: chatId })) ?? undefined
    },
    async loadChat({ chatId }: { chatId: string }) {
      return (await provider.loadChat({ id: chatId })) ?? undefined
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
      return (await provider.loadChatGroup({ id: chatGroupId })) ?? undefined
    },
  }
}
