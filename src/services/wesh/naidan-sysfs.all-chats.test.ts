import { beforeEach, describe, expect, it } from 'vitest'
import { renderChatMetadataMarkdown } from './naidan-sysfs/render/metadata-markdown'
import { createMountedNaidanSysfsWesh, createMountedNaidanSysfsWeshWithCurrentChat, executeInWesh, individualChatMetadata, siblingChatMetadata } from './naidan-sysfs.test-helpers'
import type { Wesh } from './index'

describe('naidan sysfs all_chats', () => {
  let wesh: Wesh

  beforeEach(async () => {
    wesh = await createMountedNaidanSysfsWesh({ visibility: 'all_chats' })
  })

  it('lists hierarchy entries and allows access to all visible chats', async () => {
    const rootEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan' })
    expect(rootEntries.stdout.text).toBe(`\
chat-groups
chats
current-chat
current-chat-group
hierarchy
version
`)
    expect(rootEntries.stderr.text).toBe('')
    expect(rootEntries.result.exitCode).toBe(0)

    const chatEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chats' })
    expect(chatEntries.stdout.text).toBe(`\
chat-1
chat-2
chat-3
`)
    expect(chatEntries.stderr.text).toBe('')
    expect(chatEntries.result.exitCode).toBe(0)

    const chatGroupEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chat-groups' })
    expect(chatGroupEntries.stdout.text).toBe(`\
chat-group-1
`)
    expect(chatGroupEntries.stderr.text).toBe('')
    expect(chatGroupEntries.result.exitCode).toBe(0)

    const hierarchyEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/hierarchy' })
    expect(hierarchyEntries.stdout.text).toBe(`\
1-chat-group-chat-group-1
2-chat-chat-3
`)
    expect(hierarchyEntries.stderr.text).toBe('')
    expect(hierarchyEntries.result.exitCode).toBe(0)

    const hierarchyLink = await executeInWesh({ wesh, script: 'readlink /sys/fs/naidan/hierarchy/2-chat-chat-3' })
    expect(hierarchyLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-3\n')
    expect(hierarchyLink.stderr.text).toBe('')
    expect(hierarchyLink.result.exitCode).toBe(0)

    const siblingChat = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-2/metadata.md' })
    expect(siblingChat.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: siblingChatMetadata }))
    expect(siblingChat.stderr.text).toBe('')
    expect(siblingChat.result.exitCode).toBe(0)

    const individualChat = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-3/metadata.md' })
    expect(individualChat.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: individualChatMetadata }))
    expect(individualChat.stderr.text).toBe('')
    expect(individualChat.result.exitCode).toBe(0)
  })

  it('omits current-chat-group when the current chat is not in a chat group', async () => {
    const individualWesh = await createMountedNaidanSysfsWeshWithCurrentChat({
      visibility: 'all_chats',
      currentChatId: 'chat-3',
      currentChatGroupId: undefined,
    })

    const rootEntries = await executeInWesh({ wesh: individualWesh, script: 'ls -1 /sys/fs/naidan' })
    expect(rootEntries.stdout.text).toBe(`\
chat-groups
chats
current-chat
hierarchy
version
`)
    expect(rootEntries.stderr.text).toBe('')
    expect(rootEntries.result.exitCode).toBe(0)

    const currentChatLink = await executeInWesh({ wesh: individualWesh, script: 'readlink /sys/fs/naidan/current-chat' })
    expect(currentChatLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-3\n')
    expect(currentChatLink.stderr.text).toBe('')
    expect(currentChatLink.result.exitCode).toBe(0)

    const currentChatGroupLink = await executeInWesh({ wesh: individualWesh, script: 'readlink /sys/fs/naidan/current-chat-group' })
    expect(currentChatGroupLink.stdout.text).toBe('')
    expect(currentChatGroupLink.stderr.text).toBe('readlink: /sys/fs/naidan/current-chat-group: Path not found: /sys/fs/naidan/current-chat-group\n')
    expect(currentChatGroupLink.result.exitCode).toBe(1)
  })
})
