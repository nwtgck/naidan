import { describe, expect, it } from 'vitest';
import type { EncryptedStorageDebugNode } from '@/features/debug-encrypted-storage/worker/types';
import {
  areDebugEncryptedStorageNodeRefsEqual,
  createDebugEncryptedStorageNavigationColumn,
} from './navigation';

const node: EncryptedStorageDebugNode = {
  ref: { type: 'store_manifest' },
  kind: 'naidan_encrypted_store_manifest',
  title: 'Naidan encrypted store manifest',
  fields: [],
  value: { collections: [] },
  references: [{ label: 'Chat metadata', ref: { type: 'collection', collectionType: 'chat_meta' } }],
  warnings: [],
};

describe('debug encrypted storage navigation', () => {
  it('keeps only graph-navigation data in columns', () => {
    expect(createDebugEncryptedStorageNavigationColumn({ node })).toEqual({
      ref: node.ref,
      kind: node.kind,
      title: node.title,
      references: node.references,
    });
  });

  it('compares structured node references by their complete value', () => {
    expect(areDebugEncryptedStorageNodeRefsEqual({
      left: { type: 'file', area: 'durable', fileSystemId: 'system/chat-wesh', fileId: 'f1', path: '/a' },
      right: { type: 'file', area: 'durable', fileSystemId: 'system/chat-wesh', fileId: 'f1', path: '/a' },
    })).toBe(true);
    expect(areDebugEncryptedStorageNodeRefsEqual({
      left: { type: 'file', area: 'durable', fileSystemId: 'system/chat-wesh', fileId: 'f1', path: '/a' },
      right: { type: 'file', area: 'durable', fileSystemId: 'system/chat-wesh', fileId: 'f2', path: '/a' },
    })).toBe(false);
  });
});
