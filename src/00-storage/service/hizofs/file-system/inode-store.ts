import {
  HizoFSDirectoryInodeSchemaDto,
  HizoFSFileInodeSchemaDto,
  HizoFSSymlinkInodeSchemaDto,
  type HizoFSDirectoryInodeDto,
  type HizoFSFileInodeDto,
  type HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import {
  assertHizoFSDirectoryInode,
  assertHizoFSFileInode,
  assertHizoFSSymlinkInode,
} from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';

export type HizoFSFileInodeRecord = {
  readonly inode: HizoFSFileInodeDto;
  readonly binaryPayload: Uint8Array;
};

export class HizoFSInodeStore {
  constructor({ recordStore }: {
    recordStore: HizoFSRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async writeFile({ inode, binaryPayload }: {
    inode: HizoFSFileInodeDto;
    binaryPayload: Uint8Array;
  }): Promise<string> {
    assertHizoFSFileInode({ inode, binaryPayload });
    return this.recordStore.write({
      kind: 'file_inode',
      metadata: inode,
      binaryPayload,
    });
  }

  async readFile({ objectId }: {
    objectId: string;
  }): Promise<HizoFSFileInodeRecord> {
    const { metadata, binaryPayload } = await this.recordStore.read({
      objectId,
      expectedKind: 'file_inode',
      schema: HizoFSFileInodeSchemaDto,
      binaryPayload: 'allowed',
    });
    assertHizoFSFileInode({ inode: metadata, binaryPayload });
    return { inode: metadata, binaryPayload };
  }

  async writeDirectory({ inode }: {
    inode: HizoFSDirectoryInodeDto;
  }): Promise<string> {
    assertHizoFSDirectoryInode({ inode });
    return this.recordStore.write({
      kind: 'directory_inode',
      metadata: inode,
      binaryPayload: new Uint8Array(),
    });
  }

  async readDirectory({ objectId }: {
    objectId: string;
  }): Promise<HizoFSDirectoryInodeDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'directory_inode',
      schema: HizoFSDirectoryInodeSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertHizoFSDirectoryInode({ inode: metadata });
    return metadata;
  }

  async writeSymlink({ inode }: {
    inode: HizoFSSymlinkInodeDto;
  }): Promise<string> {
    assertHizoFSSymlinkInode({ inode });
    return this.recordStore.write({
      kind: 'symlink_inode',
      metadata: inode,
      binaryPayload: new Uint8Array(),
    });
  }

  async readSymlink({ objectId }: {
    objectId: string;
  }): Promise<HizoFSSymlinkInodeDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'symlink_inode',
      schema: HizoFSSymlinkInodeSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertHizoFSSymlinkInode({ inode: metadata });
    return metadata;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
