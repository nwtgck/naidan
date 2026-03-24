import type { WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import { handleToStream, readFileAsText } from '@/services/wesh/utils/fs';

async function readStreamText({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
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
    stream: handleToStream({ handle }),
  });
}

export async function readTextFromFile({
  files,
  path,
}: {
  files: WeshCommandContext['files'];
  path: string;
}): Promise<string> {
  return readFileAsText({ files, path });
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
