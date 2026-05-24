import { beforeEach, describe, expect, it } from 'vitest'
import { createMountedNaidanSysfsWesh, executeInWesh } from './naidan-sysfs.test-helpers'
import type { Wesh } from './index'

describe('naidan sysfs current_chat_only', () => {
  let wesh: Wesh

  beforeEach(async () => {
    wesh = await createMountedNaidanSysfsWesh({ visibility: 'current_chat_only' })
  })

  it('shows the restricted chats directory but denies traversal', async () => {
    const groupEntries = await executeInWesh({ wesh, script: 'ls -1 /sys/fs/naidan/chat-groups/chat-group-1' })
    expect(groupEntries.stdout.text).toBe(`\
chats
metadata.json
metadata.md
`)

    const restricted = await executeInWesh({ wesh, script: 'ls /sys/fs/naidan/chat-groups/chat-group-1/chats' })
    expect(restricted.stderr.text).toContain('Permission denied')
    expect(restricted.result.exitCode).not.toBe(0)
  })
})
