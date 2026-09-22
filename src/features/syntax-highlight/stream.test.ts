import { describe, expect, it, vi } from 'vitest';
import { createCodeEditSource } from './code-edit-source';
import { highlightSyntaxStream } from './stream';
import { createTokenDisplay } from './token-display';
import type { CodeEdit } from './types';

describe('highlightSyntaxStream', () => {
  it('uses demand-driven edits and coalesces queued snapshots against the last consumed source', async () => {
    const input = createCodeEditSource();
    const controller = new AbortController();
    const stream = highlightSyntaxStream({ edits: input.edits, language: 'shell', signal: controller.signal });
    const display = createTokenDisplay();
    input.setCode({ code: 'echo first' });
    const first = await stream.next();
    if (first.done) throw new Error('Expected first highlight');
    display.apply({ edit: first.value });
    for (let index = 0; index < 100; index++) input.setCode({ code: 'echo ignored ' + index });
    input.setCode({ code: 'printf "last"' });
    const last = await stream.next();
    if (last.done) throw new Error('Expected latest highlight');
    display.apply({ edit: last.value });
    expect(display.tokens.map(token => token.text).join('')).toBe('printf "last"');
    expect(display.tokens[0]).toEqual({ kind: 'command', text: 'printf' });
    input.close();
    expect((await stream.next()).done).toBe(true);
  });

  it('settles a pending next on abort and observes late producer rejection', async () => {
    let rejectInput: (error: Error) => void = () => {};
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const edits: AsyncIterable<CodeEdit> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((_, reject) => {
          rejectInput = reject;
        }),
        return: returned,
      }),
    };
    const controller = new AbortController();
    const stream = highlightSyntaxStream({ edits, language: 'shell', signal: controller.signal });
    const pending = stream.next();
    controller.abort();
    expect((await pending).done).toBe(true);
    rejectInput(new Error('Late producer failure'));
    await Promise.resolve();
    expect(returned).toHaveBeenCalledOnce();
  });

  it('closes component-owned input waiters and ignores later snapshots', async () => {
    const input = createCodeEditSource();
    const iterator = input.edits[Symbol.asyncIterator]();
    const pending = iterator.next();
    input.close();
    input.setCode({ code: 'echo late' });
    expect((await pending).done).toBe(true);
    expect((await iterator.next()).done).toBe(true);
  });

  it('closes an abandoned input after a delivered edit', async () => {
    let closed = false;
    async function* input() {
      try {
        yield { offset: 0, text: 'echo hello' };
        throw new Error('Consumer must not request another item');
      } finally {
        closed = true;
      }
    }
    const stream = highlightSyntaxStream({ edits: input(), language: 'shell', signal: new AbortController().signal });
    expect((await stream.next()).done).toBe(false);
    await stream.return(undefined);
    await Promise.resolve();
    expect(closed).toBe(true);
  });

  it('rejects malformed offsets rather than creating inaccurate displayed source', async () => {
    async function* input() {
      yield { offset: 1, text: 'bad' };
    }
    const stream = highlightSyntaxStream({ edits: input(), language: 'shell', signal: new AbortController().signal });
    await expect(stream.next()).rejects.toThrow('Invalid code edit offset');
  });

  it('releases each cancellation listener before delivering the next highlighted edit', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    async function* input() {
      for (let offset = 0; offset < 20; offset++) yield { offset, text: 'a' };
    }
    const stream = highlightSyntaxStream({ edits: input(), language: 'shell', signal: controller.signal });
    for await (const _edit of stream) {
      expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    }
    expect(add.mock.calls.length).toBe(21);
    expect(remove.mock.calls.length).toBe(21);
  });
});
