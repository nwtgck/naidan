import { beforeEach, describe, expect, it } from 'vitest'
import { renderChatMetadataMarkdown } from './naidan-sysfs/render/metadata-markdown'
import { createMountedNaidanSysfsWesh, executeInWesh, mainChatMetadata } from './naidan-sysfs.test-helpers'
import type { Wesh } from './index'

describe('naidan sysfs current_chat_only', () => {
  let wesh: Wesh

  beforeEach(async () => {
    wesh = await createMountedNaidanSysfsWesh({ visibility: 'current_chat_only' })
  })

  it('exposes the current chat paths but denies sibling chat traversal', async () => {
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
    expect(lsRoot.result.exitCode).toBe(0)

    const currentChatLink = await executeInWesh({ wesh, script: 'readlink /sys/fs/naidan/current-chat' })
    expect(currentChatLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-1\n')
    expect(currentChatLink.stderr.text).toBe('')
    expect(currentChatLink.result.exitCode).toBe(0)

    const currentChatMetadata = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-1/metadata.md' })
    expect(currentChatMetadata.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: mainChatMetadata }))
    expect(currentChatMetadata.stderr.text).toBe('')
    expect(currentChatMetadata.result.exitCode).toBe(0)

    const chatEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chats' })
    expect(chatEntries.stdout.text).toBe(`\
chat-1
`)
    expect(chatEntries.stderr.text).toBe('')
    expect(chatEntries.result.exitCode).toBe(0)

    const siblingMetadata = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-2/metadata.md' })
    expect(siblingMetadata.stdout.text).toBe('')
    expect(siblingMetadata.stderr.text).toBe('cat: /sys/fs/naidan/chats/chat-2/metadata.md: Path not found: /sys/fs/naidan/chats/chat-2/metadata.md\n')
    expect(siblingMetadata.result.exitCode).toBe(1)
  })

  it('shows the restricted chats directory but denies traversal', async () => {
    const groupEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chat-groups/chat-group-1' })
    expect(groupEntries.stdout.text).toBe(`\
chats
metadata.json
metadata.md
`)
    expect(groupEntries.stderr.text).toBe('')
    expect(groupEntries.result.exitCode).toBe(0)

    const restricted = await executeInWesh({ wesh, script: 'ls /sys/fs/naidan/chat-groups/chat-group-1/chats' })
    expect(restricted.stdout.text).toBe('')
    expect(restricted.stderr.text).toBe('ls: /sys/fs/naidan/chat-groups/chat-group-1/chats: Permission denied: /sys/fs/naidan/chat-groups/chat-group-1/chats\n')
    expect(restricted.result.exitCode).toBe(1)
  })
})
