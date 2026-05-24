import { beforeEach, describe, expect, it } from 'vitest'
import { renderChatMetadataJson } from './naidan-sysfs/render/metadata-json'
import { renderChatMetadataMarkdown } from './naidan-sysfs/render/metadata-markdown'
import { renderLeafMetadataMarkdown } from './naidan-sysfs/render/leaf-metadata-markdown'
import { renderMessageMarkdown } from './naidan-sysfs/render/message-markdown'
import { NAIDAN_SYSFS_VERSION_TEXT } from './naidan-sysfs/constants'
import { createMountedNaidanSysfsWesh, executeInWesh, mainChatContent, mainChatMetadata, siblingChatMetadata } from './naidan-sysfs.test-helpers'
import type { Wesh } from './index'

describe('naidan sysfs current_chat_with_chat_group', () => {
  let wesh: Wesh

  beforeEach(async () => {
    wesh = await createMountedNaidanSysfsWesh({ visibility: 'current_chat_with_chat_group' })
  })

  it('supports ls, cat, and readlink across the naidan sysfs mount', async () => {
    const lsRoot = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan' })
    expect(lsRoot.stdout.text).toBe(`\
chat-groups
chats
current-chat
current-chat-group
hierarchy
version
`)
    expect(lsRoot.stderr.text).toBe('')

    const version = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/version' })
    expect(version.stdout.text).toBe(NAIDAN_SYSFS_VERSION_TEXT)

    const metadataMarkdown = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-1/metadata.md' })
    expect(metadataMarkdown.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: mainChatMetadata }))

    const metadataJson = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-1/metadata.json' })
    expect(metadataJson.stdout.text).toBe(`${renderChatMetadataJson({ metadata: mainChatMetadata })}\n`)

    const contentList = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chats/chat-1/content-md' })
    expect(contentList.stdout.text).toBe(`\
1-user-Ku1rA1B2c3D4e5F6g7H8.md
2-assistant-La2rF6G7h8J9k0L1m2N3.md
3-user-Mu3aL1M2n3P4q5R6s7T8.md
4-assistant-Xa4aX1Y2z3A4b5C6d7E8.md
`)

    const contentFile = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-1/content-md/1-user-Ku1rA1B2c3D4e5F6g7H8.md' })
    expect(contentFile.stdout.text).toBe(renderMessageMarkdown({ node: mainChatContent.root.items[0]! }))

    const treeList = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chats/chat-1/branches/tree-md' })
    expect(treeList.stdout.text).toBe(`\
1-user-Ku1rA1B2c3D4e5F6g7H8.md
2-assistant-La2rF6G7h8J9k0L1m2N3.md
3-branch-1
3-branch-2
`)

    const leafMetadata = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-1/branches/leaves-md/Xa4aX1Y2z3A4b5C6d7E8/metadata.md' })
    expect(leafMetadata.stdout.text).toBe(renderLeafMetadataMarkdown({
      chat: {
        ...mainChatMetadata,
        root: mainChatContent.root,
        currentLeafId: mainChatContent.currentLeafId,
      },
      leafId: 'Xa4aX1Y2z3A4b5C6d7E8',
      nodes: [
        mainChatContent.root.items[0]!,
        mainChatContent.root.items[0]!.replies.items[0]!,
        mainChatContent.root.items[0]!.replies.items[0]!.replies.items[0]!,
        mainChatContent.root.items[0]!.replies.items[0]!.replies.items[0]!.replies.items[1]!,
      ],
    }))

    const currentChatLink = await executeInWesh({ wesh, script: 'readlink /sys/fs/naidan/current-chat' })
    expect(currentChatLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-1\n')

    const currentChatGroupLink = await executeInWesh({ wesh, script: 'readlink /sys/fs/naidan/current-chat-group' })
    expect(currentChatGroupLink.stdout.text).toBe('/sys/fs/naidan/chat-groups/chat-group-1\n')

    const currentBranchLink = await executeInWesh({ wesh, script: 'readlink /sys/fs/naidan/chats/chat-1/branches/current-md' })
    expect(currentBranchLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-1/branches/leaves-md/Xa4aX1Y2z3A4b5C6d7E8\n')
  })

  it('follows intermediate symlinks when traversing current-chat paths', async () => {
    const metadataThroughCurrentChat = await executeInWesh({
      wesh,
      script: 'cat /sys/fs/naidan/current-chat/metadata.md',
    })
    expect(metadataThroughCurrentChat.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: mainChatMetadata }))
  })

  it('allows reading sibling chats in the same chat group', async () => {
    const siblingList = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chats' })
    expect(siblingList.stdout.text).toBe(`\
chat-1
chat-2
`)

    const siblingMetadata = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-2/metadata.md' })
    expect(siblingMetadata.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: siblingChatMetadata }))
  })
})
