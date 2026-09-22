// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from './blob-view.test-helpers';
import { NaidanSysfsProvider } from '@/features/wesh/naidan-sysfs/provider';
import { mainChatMetadata } from '@/features/wesh/naidan-sysfs.test-helpers';
import { renderChatMetadataJson } from '@/features/wesh/naidan-sysfs/render/metadata-json';
import type { NaidanSysfsStorageReader } from '@/features/wesh/naidan-sysfs/types';
import { GeneratedTextFileHandle } from '@/features/wesh/naidan-sysfs/generated-text-file-handle';
import { readAllFileBytes, readAllFileText, openFileReadStream } from './fs';

afterEach(() => vi.restoreAllMocks());

function createFiles({ text, estimatedSize }: { text: string, estimatedSize: number }) {
  const render = vi.fn(async () => text);
  const handle = new GeneratedTextFileHandle({ estimatedSize, readText: render });
  const close = vi.spyOn(handle, 'close');
  const stat = vi.spyOn(handle, 'stat');
  const open = vi.fn(async () => handle);
  return { files: { open, stat }, handle, render, close };
}

describe('Wesh full-file helpers with generated sizes', () => {
  it.each([0, 1, 4096, Number.MAX_SAFE_INTEGER])('reads all bytes despite a stat estimate of %s', async estimatedSize => {
    const text = '日本語😀'.repeat(20_000);
    const { files, close, render } = createFiles({ text, estimatedSize });
    const actual = await readAllFileBytes({ files, path: '/virtual/input' });
    const expected = new TextEncoder().encode(text);
    expect(actual.length).toBe(expected.length);
    expect(actual.every((byte, index) => byte === expected[index])).toBe(true);
    expect(files.stat).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not truncate JSON or a final multibyte character at the estimated size', async () => {
    const text = JSON.stringify({ title: '日本語😀'.repeat(1000) });
    const { files, close } = createFiles({ text, estimatedSize: 2 });
    const actual = await readAllFileText({ files, path: '/metadata.json' });
    expect(actual).toBe(text);
    expect(JSON.parse(actual)).toEqual(JSON.parse(text));
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not pad an empty generated file to its estimate', async () => {
    const { files, close, render } = createFiles({ text: '', estimatedSize: 4096 });
    expect(await readAllFileBytes({ files, path: '/empty' })).toEqual(new Uint8Array(0));
    expect(render).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates generation failure and closes the handle instead of returning an empty result', async () => {
    const { files, render, close } = createFiles({ text: '', estimatedSize: 0 });
    const error = new DOMException('Stored metadata unreadable', 'NotReadableError');
    render.mockRejectedValue(error);
    await expect(readAllFileBytes({ files, path: '/failed' })).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not turn a later read failure into a successful partial file', async () => {
    const { files, handle, close } = createFiles({ text: 'x'.repeat(100_000), estimatedSize: 1 });
    const readOriginal = handle.read.bind(handle);
    const error = new Error('File read failed');
    vi.spyOn(handle, 'read').mockImplementationOnce(readOriginal).mockRejectedValueOnce(error);
    await expect(readAllFileBytes({ files, path: '/failed' })).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the streaming EOF and byte content with no Blob reconstruction', async () => {
    const text = '\uFEFF日\ud800😀'.repeat(15_000);
    const expected = new TextEncoder().encode(text);
    const { files, close } = createFiles({ text, estimatedSize: 1 });
    const chunks: Uint8Array[] = [];
    const reader = (await openFileReadStream({ files, path: '/stream' })).getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const actual = Buffer.concat(chunks);
    expect(actual.length).toBe(expected.length);
    expect(actual.every((byte, index) => byte === expected[index])).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});


describe('Wesh commands read complete generated sysfs files', () => {
  async function fixture() {
    const shell = await createBlobViewShellFixture();
    const title = '日本語😀'.repeat(5_000);
    const metadata = { ...mainChatMetadata, title };
    const reader: NaidanSysfsStorageReader = {
      loadHierarchy: async () => ({ items: [] }),
      getSidebarStructure: async () => [], listChats: async () => [], listChatGroups: async () => [],
      loadChatMeta: async ({ chatId }) => chatId === metadata.id ? metadata : undefined,
      loadChatContent: async () => undefined, loadChat: async () => undefined, loadChatGroup: async () => undefined,
      async *listBinaryObjects() {},
      getBinaryObject: async () => undefined, getBinaryObjectBlob: async () => undefined,
    };
    shell.wesh.vfs.mountVirtual({
      path: '/sys/fs/naidan', readOnly: true,
      provider: new NaidanSysfsProvider({
        reader, blobs: shell.blobs, visibility: 'current_chat_only', binaryObjectAccess: 'none',
        currentChatId: 'chat-1', currentChatGroupId: undefined,
      }),
    });
    return { shell, title, text: `${renderChatMetadataJson({ metadata })}\n` };
  }

  it('runs jq on a generated JSON document larger than its estimated stat size', async () => {
    const { shell, title } = await fixture();
    try {
      shell.blockNativeReads();
      const result = await shell.execute({ script: 'jq -r .title /sys/fs/naidan/current-chat/metadata.json', stdinText: undefined });
      expect(result.result.exitCode).toBe(0);
      expect(result.stderr.text).toBe('');
      expect(result.stdout.text).toBe(`${title}\n`);
    } finally {
      shell.dispose();
    }
  });

  it('keeps generated cat/cmp contents identical to a native snapshot through the safe Blob path', async () => {
    const { shell, text } = await fixture();
    try {
      await shell.writeFile({ path: '/expected.json', data: text });
      shell.blockNativeReads();
      const cat = await shell.execute({ script: 'cat /sys/fs/naidan/current-chat/metadata.json', stdinText: undefined });
      expect(cat.result.exitCode).toBe(0);
      expect(cat.stdout.text).toBe(text);
      const cmp = await shell.execute({ script: 'cmp /sys/fs/naidan/current-chat/metadata.json /expected.json', stdinText: undefined });
      expect(cmp.result.exitCode).toBe(0);
      expect(cmp.stdout.text).toBe('');
      expect(cmp.stderr.text).toBe('');
    } finally {
      shell.dispose();
    }
  });
});
