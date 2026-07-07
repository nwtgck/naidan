import type { WeshCommandContext, WeshFileHandle, WeshOpenFlags } from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import type { TreeOutputWriter } from './types';

class HandleTreeOutputWriter implements TreeOutputWriter {
  private readonly handle: WeshFileHandle;
  private readonly writer: ReturnType<typeof createBufferedTextWriter>;
  private readonly closeHandle: boolean;
  private closed = false;

  constructor({
    handle,
    closeHandle,
  }: {
    handle: WeshFileHandle,
    closeHandle: boolean,
  }) {
    this.handle = handle;
    this.closeHandle = closeHandle;
    this.writer = createBufferedTextWriter({
      handle,
      maxBufferLength: 16 * 1024,
    });
  }

  async write({ text }: { text: string }): Promise<void> {
    await this.writer.write({ text });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.writer.flush();
    if (this.closeHandle) {
      await this.handle.close();
    }
  }

  async abort({ reason: _reason }: { reason: unknown }): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.closeHandle) {
      await this.handle.close();
    }
  }
}

class EfficientTreeOutputWriter implements TreeOutputWriter {
  private readonly writer: { write({ chunk }: { chunk: Uint8Array }): Promise<void>, close(): Promise<void>, abort({ reason }: { reason: unknown }): Promise<void> };
  private readonly encoder = new TextEncoder();
  private chunks: string[] = [];
  private bufferedLength = 0;
  private closed = false;

  constructor({
    writer,
  }: {
    writer: { write({ chunk }: { chunk: Uint8Array }): Promise<void>, close(): Promise<void>, abort({ reason }: { reason: unknown }): Promise<void> },
  }) {
    this.writer = writer;
  }

  private async flush(): Promise<void> {
    if (this.bufferedLength === 0) {
      return;
    }
    const text = this.chunks.join('');
    this.chunks = [];
    this.bufferedLength = 0;
    await this.writer.write({ chunk: this.encoder.encode(text) });
  }

  async write({ text }: { text: string }): Promise<void> {
    this.chunks.push(text);
    this.bufferedLength += text.length;
    if (this.bufferedLength >= 16 * 1024) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.flush();
    await this.writer.close();
  }

  async abort({ reason }: { reason: unknown }): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.writer.abort({ reason });
  }
}

export async function createTreeOutputWriter({
  context,
  outputPath,
}: {
  context: WeshCommandContext,
  outputPath: string | undefined,
}): Promise<TreeOutputWriter> {
  if (outputPath === undefined) {
    return new HandleTreeOutputWriter({
      handle: context.stdout,
      closeHandle: false,
    });
  }

  const efficientWriter = await context.files.tryCreateFileWriterEfficiently({
    path: outputPath,
    mode: 'truncate',
  });
  switch (efficientWriter.kind) {
  case 'writer':
    return new EfficientTreeOutputWriter({ writer: efficientWriter.writer });
  case 'fallback_required':
    break;
  default: {
    const _ex: never = efficientWriter;
    throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
  }
  }

  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'truncate',
    append: 'preserve',
  };
  const handle = await context.files.open({
    path: outputPath,
    flags,
  });
  return new HandleTreeOutputWriter({
    handle,
    closeHandle: true,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
