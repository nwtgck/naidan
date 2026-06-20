import type { WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import { resolvePath } from '@/services/wesh/path';
import { openFileReadStream, openHandleReadStream, readAllFileText } from '@/services/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/services/wesh/utils/stream';
import { iterateUtf8Lines } from '@/services/wesh/utils/text-records';

async function readStreamText({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

export async function readTextFromHandle({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<string> {
  return await readStreamText({
    stream: openHandleReadStream({ handle }),
  });
}

export async function readTextFromFile({
  files,
  path,
}: {
  files: WeshCommandContext['files'];
  path: string;
}): Promise<string> {
  return readAllFileText({ files, path });
}

export function iterateTextLinesFromHandle({
  handle,
}: {
  handle: WeshFileHandle;
}): AsyncIterable<string> {
  return iterateUtf8Lines({
    chunks: iterateReadableStreamChunks({
      stream: openHandleReadStream({ handle }),
    }),
  });
}

export async function openTextLineIterator({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<AsyncIterator<string>> {
  const stream = path === '-'
    ? openHandleReadStream({ handle: context.stdin })
    : await openFileReadStream({
      files: context.files,
      path: resolvePath({
        cwd: context.cwd,
        path,
      }),
    });
  return iterateUtf8Lines({
    chunks: iterateReadableStreamChunks({ stream }),
  })[Symbol.asyncIterator]();
}

export function splitTextLines({
  text,
}: {
  text: string;
}): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}
