import {
  EncryptedOpfsDirectoryInodeSchemaDto,
  EncryptedOpfsFileInodeSchemaDto,
  EncryptedOpfsSymlinkInodeSchemaDto,
  type EncryptedOpfsDirectoryInodeDto,
  type EncryptedOpfsFileInodeDto,
  type EncryptedOpfsSymlinkInodeDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import {
  assertEncryptedOpfsDirectoryInode,
  assertEncryptedOpfsFileInode,
  assertEncryptedOpfsSymlinkInode,
} from './semantic-validation';
import type { EncryptedOpfsRecordStore } from './record-store';

export type EncryptedOpfsFileInodeRecord = {
  readonly inode: EncryptedOpfsFileInodeDto;
  readonly binaryPayload: Uint8Array;
};

export class EncryptedOpfsInodeStore {
  constructor({ recordStore }: {
    recordStore: EncryptedOpfsRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: EncryptedOpfsRecordStore;

  async writeFile({ inode, binaryPayload }: {
    inode: EncryptedOpfsFileInodeDto;
    binaryPayload: Uint8Array;
  }): Promise<string> {
    assertEncryptedOpfsFileInode({ inode, binaryPayload });
    return this.recordStore.write({
      kind: 'file_inode',
      metadata: inode,
      binaryPayload,
    });
  }

  async readFile({ objectId }: {
    objectId: string;
  }): Promise<EncryptedOpfsFileInodeRecord> {
    const { metadata, binaryPayload } = await this.recordStore.read({
      objectId,
      expectedKind: 'file_inode',
      schema: EncryptedOpfsFileInodeSchemaDto,
      binaryPayload: 'allowed',
    });
    assertEncryptedOpfsFileInode({ inode: metadata, binaryPayload });
    return { inode: metadata, binaryPayload };
  }

  async writeDirectory({ inode }: {
    inode: EncryptedOpfsDirectoryInodeDto;
  }): Promise<string> {
    assertEncryptedOpfsDirectoryInode({ inode });
    return this.recordStore.write({
      kind: 'directory_inode',
      metadata: inode,
      binaryPayload: new Uint8Array(),
    });
  }

  async readDirectory({ objectId }: {
    objectId: string;
  }): Promise<EncryptedOpfsDirectoryInodeDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'directory_inode',
      schema: EncryptedOpfsDirectoryInodeSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertEncryptedOpfsDirectoryInode({ inode: metadata });
    return metadata;
  }

  async writeSymlink({ inode }: {
    inode: EncryptedOpfsSymlinkInodeDto;
  }): Promise<string> {
    assertEncryptedOpfsSymlinkInode({ inode });
    return this.recordStore.write({
      kind: 'symlink_inode',
      metadata: inode,
      binaryPayload: new Uint8Array(),
    });
  }

  async readSymlink({ objectId }: {
    objectId: string;
  }): Promise<EncryptedOpfsSymlinkInodeDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'symlink_inode',
      schema: EncryptedOpfsSymlinkInodeSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertEncryptedOpfsSymlinkInode({ inode: metadata });
    return metadata;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
