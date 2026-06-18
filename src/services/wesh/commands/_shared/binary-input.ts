import type { WeshCommandContext } from '@/services/wesh/types';
import { resolvePath } from '@/services/wesh/path';
import { openFileReadStream, openHandleReadStream } from '@/services/wesh/utils/fs';


export async function openCommandInputStream({
  context,
  input,
}: {
  context: WeshCommandContext;
  input: string | undefined;
}): Promise<ReadableStream<Uint8Array>> {
  if (input === undefined || input === '-') {
    return openHandleReadStream({
      handle: context.stdin,
    });
  }

  return openFileReadStream({
    files: context.files,
    path: resolvePath({
      cwd: context.cwd,
      path: input,
    }),
  });
}
