import { beforeEach, describe, expect, it } from 'vitest'
import { renderChatMetadataMarkdown } from './naidan-sysfs/render/metadata-markdown'
import { createMountedNaidanSysfsWesh, executeInWesh, individualChatMetadata } from './naidan-sysfs.test-helpers'
import type { Wesh } from './index'

describe('naidan sysfs all_chats', () => {
  let wesh: Wesh

  beforeEach(async () => {
    wesh = await createMountedNaidanSysfsWesh({ visibility: 'all_chats' })
  })

  it('lists hierarchy entries and allows access to individual chats', async () => {
    const hierarchyEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/hierarchy' })
    expect(hierarchyEntries.stdout.text).toBe(`\
1-chat-group-chat-group-1
2-chat-chat-3
`)

    const hierarchyLink = await executeInWesh({ wesh, script: 'readlink /sys/fs/naidan/hierarchy/2-chat-chat-3' })
    expect(hierarchyLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-3\n')

    const individualChat = await executeInWesh({ wesh, script: 'cat /sys/fs/naidan/chats/chat-3/metadata.md' })
    expect(individualChat.stdout.text).toBe(renderChatMetadataMarkdown({ metadata: individualChatMetadata }))
  })
})
