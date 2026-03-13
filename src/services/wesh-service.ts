import { Wesh } from './wesh';

export interface WeshMount {
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
}

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

    const result = await this.shell.execute({ commandLine });
    return {
      exitCode: result.exitCode,
      output: (result.data as string) || '',
      error: result.error,
    };
  }
}
