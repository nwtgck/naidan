const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export interface Sha256Hasher {
  update({ bytes }: { bytes: Uint8Array }): void,
  digestHex(): string,
}

class IncrementalSha256 implements Sha256Hasher {
  private readonly hashState = new Uint32Array(SHA256_INITIAL_STATE);
  private readonly schedule = new Uint32Array(64);
  private readonly remainder = new Uint8Array(64);
  private remainderLength = 0;
  private byteLengthHigh = 0;
  private byteLengthLow = 0;
  private phase: 'accepting' | 'finalized' = 'accepting';

  update({ bytes }: { bytes: Uint8Array }): void {
    this.assertAccepting();

    this.addByteLength({ byteLength: bytes.byteLength });
    let offset = 0;

    if (this.remainderLength > 0) {
      const copiedLength = Math.min(
        64 - this.remainderLength,
        bytes.byteLength,
      );
      this.remainder.set(
        bytes.subarray(0, copiedLength),
        this.remainderLength,
      );
      this.remainderLength += copiedLength;
      offset += copiedLength;

      if (this.remainderLength === 64) {
        this.compressBlocks({
          bytes: this.remainder,
          offset: 0,
          blockCount: 1,
        });
        this.remainderLength = 0;
      }
    }

    const remainingLength = bytes.byteLength - offset;
    const blockCount = Math.floor(remainingLength / 64);
    if (blockCount > 0) {
      this.compressBlocks({ bytes, offset, blockCount });
      offset += blockCount * 64;
    }

    if (offset < bytes.byteLength) {
      const tail = bytes.subarray(offset);
      this.remainder.set(tail, 0);
      this.remainderLength = tail.byteLength;
    }
  }

  digestHex(): string {
    this.assertAccepting();
    this.phase = 'finalized';

    this.remainder[this.remainderLength] = 0x80;
    this.remainderLength += 1;

    if (this.remainderLength > 56) {
      this.remainder.fill(0, this.remainderLength);
      this.compressBlocks({
        bytes: this.remainder,
        offset: 0,
        blockCount: 1,
      });
      this.remainderLength = 0;
    }

    this.remainder.fill(0, this.remainderLength, 56);
    const bitLengthHigh = (
      (this.byteLengthHigh << 3)
      | (this.byteLengthLow >>> 29)
    ) >>> 0;
    const bitLengthLow = (this.byteLengthLow << 3) >>> 0;

    this.writeUint32BigEndian({
      bytes: this.remainder,
      offset: 56,
      value: bitLengthHigh,
    });
    this.writeUint32BigEndian({
      bytes: this.remainder,
      offset: 60,
      value: bitLengthLow,
    });
    this.compressBlocks({
      bytes: this.remainder,
      offset: 0,
      blockCount: 1,
    });

    return Array.from(this.hashState, value => value.toString(16).padStart(8, '0')).join('');
  }

  private assertAccepting(): void {
    switch (this.phase) {
    case 'accepting':
      return;
    case 'finalized':
      throw new Error('SHA256 hasher is already finalized');
    default: {
      const _ex: never = this.phase;
      throw new Error(`Unhandled SHA256 phase: ${_ex}`);
    }
    }
  }

  private addByteLength({ byteLength }: { byteLength: number }): void {
    const previousLow = this.byteLengthLow;
    this.byteLengthLow = (this.byteLengthLow + byteLength) >>> 0;
    if (this.byteLengthLow < previousLow) {
      this.byteLengthHigh = (this.byteLengthHigh + 1) >>> 0;
    }
  }

  private compressBlocks({
    bytes,
    offset,
    blockCount,
  }: {
    bytes: Uint8Array,
    offset: number,
    blockCount: number,
  }): void {
    let blockOffset = offset;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      for (let index = 0; index < 16; index += 1) {
        const wordOffset = blockOffset + index * 4;
        this.schedule[index] = (
          (bytes[wordOffset]! << 24)
          | (bytes[wordOffset + 1]! << 16)
          | (bytes[wordOffset + 2]! << 8)
          | bytes[wordOffset + 3]!
        ) >>> 0;
      }

      for (let index = 16; index < 64; index += 1) {
        const value15 = this.schedule[index - 15]!;
        const value2 = this.schedule[index - 2]!;
        const sigma0 = (
          ((value15 >>> 7) | (value15 << 25))
          ^ ((value15 >>> 18) | (value15 << 14))
          ^ (value15 >>> 3)
        ) >>> 0;
        const sigma1 = (
          ((value2 >>> 17) | (value2 << 15))
          ^ ((value2 >>> 19) | (value2 << 13))
          ^ (value2 >>> 10)
        ) >>> 0;
        this.schedule[index] = (
          this.schedule[index - 16]!
          + sigma0
          + this.schedule[index - 7]!
          + sigma1
        ) >>> 0;
      }

      let a = this.hashState[0]!;
      let b = this.hashState[1]!;
      let c = this.hashState[2]!;
      let d = this.hashState[3]!;
      let e = this.hashState[4]!;
      let f = this.hashState[5]!;
      let g = this.hashState[6]!;
      let h = this.hashState[7]!;

      for (let index = 0; index < 64; index += 1) {
        const sum1 = (
          ((e >>> 6) | (e << 26))
          ^ ((e >>> 11) | (e << 21))
          ^ ((e >>> 25) | (e << 7))
        ) >>> 0;
        const choice = ((e & f) ^ (~e & g)) >>> 0;
        const temporary1 = (
          h
          + sum1
          + choice
          + SHA256_ROUND_CONSTANTS[index]!
          + this.schedule[index]!
        ) >>> 0;
        const sum0 = (
          ((a >>> 2) | (a << 30))
          ^ ((a >>> 13) | (a << 19))
          ^ ((a >>> 22) | (a << 10))
        ) >>> 0;
        const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temporary2 = (sum0 + majority) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temporary1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temporary1 + temporary2) >>> 0;
      }

      this.hashState[0] = (this.hashState[0]! + a) >>> 0;
      this.hashState[1] = (this.hashState[1]! + b) >>> 0;
      this.hashState[2] = (this.hashState[2]! + c) >>> 0;
      this.hashState[3] = (this.hashState[3]! + d) >>> 0;
      this.hashState[4] = (this.hashState[4]! + e) >>> 0;
      this.hashState[5] = (this.hashState[5]! + f) >>> 0;
      this.hashState[6] = (this.hashState[6]! + g) >>> 0;
      this.hashState[7] = (this.hashState[7]! + h) >>> 0;

      blockOffset += 64;
    }
  }

  private writeUint32BigEndian({
    bytes,
    offset,
    value,
  }: {
    bytes: Uint8Array,
    offset: number,
    value: number,
  }): void {
    bytes[offset] = value >>> 24;
    bytes[offset + 1] = value >>> 16;
    bytes[offset + 2] = value >>> 8;
    bytes[offset + 3] = value;
  }
}

export function createSha256Hasher(): Sha256Hasher {
  return new IncrementalSha256();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
