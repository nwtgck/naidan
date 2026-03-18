import { Wesh } from './wesh';
import type { WeshFileHandle, WeshMount } from './wesh/types';

export class WeshService {
  private static instance: WeshService | undefined;
  private shell: Wesh | undefined;

  private constructor() {}

  static async getInstance(): Promise<WeshService> {
    if (!WeshService.instance) {
      WeshService.instance = new WeshService();
    }
    return WeshService.instance;
  }

  isInitialized(): boolean {
    return !!this.shell;
  }

  getWeshInstance(): Wesh {
    if (!this.shell) {
      throw new Error('WeshService not initialized');
    }
    return this.shell;
  }

  /**
   * Initializes the Wesh shell with an explicit root directory handle
   * and an optional list of external mounts.
   */
  async init({
    rootHandle,
    user = 'user',
    initialEnv = {},
    mounts = [],
  }: {
    rootHandle: FileSystemDirectoryHandle;
    user?: string;
    initialEnv?: Record<string, string>;
    mounts?: WeshMount[];
  }): Promise<void> {
    this.shell = new Wesh({
      rootHandle,
      user,
      initialEnv
    });

    /** Apply external mounts */
    for (const mount of mounts) {
      this.shell.vfs.mount({
        path: mount.path,
        handle: mount.handle,
        readOnly: mount.readOnly
      });
    }
  }

  async execute({ commandLine }: { commandLine: string }): Promise<{ exitCode: number; output: string; error: string | undefined }> {
    if (!this.shell) {
      throw new Error('WeshService not initialized');
    }

    const decoder = new TextDecoder();

    const outputBuffer: Uint8Array[] = [];
    const errorBuffer: Uint8Array[] = [];

    const createDummyHandle = (): WeshFileHandle => ({
      read: async () => ({ bytesRead: 0 }),
      write: async ({ buffer }) => {
        // Correctly handle the buffer passed to write
        outputBuffer.push(new Uint8Array(buffer));
        return { bytesWritten: buffer.length };
      },
      close: async () => {},
      stat: async () => ({ size: 0, mode: 0, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }),
      truncate: async () => {},
      ioctl: async () => ({ ret: 0 })
    });

    const result = await this.shell.execute({
      script: commandLine,
      stdin: createDummyHandle(),
      stdout: createDummyHandle(),
      stderr: createDummyHandle()
    });

    return {
      exitCode: result.exitCode,
      output: outputBuffer.map(b => decoder.decode(b)).join(''),
      error: errorBuffer.length > 0 ? errorBuffer.map(b => decoder.decode(b)).join('') : undefined,
    };
  }
}
