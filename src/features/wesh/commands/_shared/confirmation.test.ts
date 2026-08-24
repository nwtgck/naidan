import { describe, expect, it } from 'vitest';
import { TEST_ONLY } from './confirmation';

async function* inputChunks(chunks: readonly string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

describe('interactive confirmation', () => {
  it('accepts only y or Y as the first response character', async () => {
    const read = TEST_ONLY.createAffirmativeResponseReader({
      input: inputChunks([
        'y\nY\r\n y\n\ty\n\u00A0y\n',
        '\u2003y\nn\n\n',
      ]),
    });

    await expect(read()).resolves.toBe(true);
    await expect(read()).resolves.toBe(true);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
  });


  it('consumes one production text-input line per confirmation', async () => {
    const read = TEST_ONLY.createAffirmativeResponseReader({
      input: inputChunks(['y', 'Y', 'n', '']),
    });

    await expect(read()).resolves.toBe(true);
    await expect(read()).resolves.toBe(true);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
    await expect(read()).resolves.toBe(false);
  });

  it('uses an unterminated final response without trimming it', async () => {
    const read = TEST_ONLY.createAffirmativeResponseReader({
      input: inputChunks(['Y']),
    });

    await expect(read()).resolves.toBe(true);
    await expect(read()).resolves.toBe(false);
  });
});
