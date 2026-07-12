import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import type { EncryptedStorageDebugNodeRef } from './types';
import { cloneEncryptedStorageDebugNodeRef } from './clone-node-ref';

describe('cloneEncryptedStorageDebugNodeRef', () => {
  it('removes Vue proxies before a node reference crosses the Worker boundary', () => {
    const proxied = reactive<EncryptedStorageDebugNodeRef>({
      type: 'directory',
      area: 'durable',
      fileSystemId: 'system/chat-wesh',
      directoryId: 'directory-id',
      path: '/workspace',
    });

    const cloned = cloneEncryptedStorageDebugNodeRef({ ref: proxied });

    expect(cloned).toEqual({
      type: 'directory',
      area: 'durable',
      fileSystemId: 'system/chat-wesh',
      directoryId: 'directory-id',
      path: '/workspace',
    });
    expect(() => structuredClone(cloned)).not.toThrow();
  });
});
