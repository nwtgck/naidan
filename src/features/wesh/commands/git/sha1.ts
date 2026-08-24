const SHA1_INITIAL_STATE = new Uint32Array([
  0x67452301,
  0xefcdab89,
  0x98badcfe,
  0x10325476,
  0xc3d2e1f0,
]);

export interface Sha1Hasher {
  update({ bytes }: { bytes: Uint8Array }): void,
  digestBytes(): Uint8Array,
  digestHex(): string,
}

function rotateLeft({ value, bits }: { value: number, bits: number }): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

class IncrementalSha1 implements Sha1Hasher {
  private readonly hashState = new Uint32Array(SHA1_INITIAL_STATE);
  private readonly schedule = new Uint32Array(80);
  private readonly remainder = new Uint8Array(64);
  private remainderLength = 0;
  private byteLengthHigh = 0;
  private byteLengthLow = 0;
  private phase: "accepting" | "finalized" = "accepting";
  private finalizedDigest: Uint8Array | undefined;

  update({ bytes }: { bytes: Uint8Array }): void {
    this.assertAccepting();
    this.addByteLength({ byteLength: bytes.byteLength });

    let offset = 0;
    if (this.remainderLength > 0) {
      const copiedLength = Math.min(64 - this.remainderLength, bytes.byteLength);
      this.remainder.set(bytes.subarray(0, copiedLength), this.remainderLength);
      this.remainderLength += copiedLength;
      offset += copiedLength;
      if (this.remainderLength === 64) {
        this.compressBlocks({ bytes: this.remainder, offset: 0, blockCount: 1 });
        this.remainderLength = 0;
      }
    }

    const blockCount = Math.floor((bytes.byteLength - offset) / 64);
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

  digestBytes(): Uint8Array {
    if (this.finalizedDigest !== undefined) {
      return this.finalizedDigest.slice();
    }
    this.assertAccepting();
    this.phase = "finalized";

    this.remainder[this.remainderLength] = 0x80;
    this.remainderLength += 1;
    if (this.remainderLength > 56) {
      this.remainder.fill(0, this.remainderLength);
      this.compressBlocks({ bytes: this.remainder, offset: 0, blockCount: 1 });
      this.remainderLength = 0;
    }

    this.remainder.fill(0, this.remainderLength, 56);
    const bitLengthHigh = ((this.byteLengthHigh << 3) | (this.byteLengthLow >>> 29)) >>> 0;
    const bitLengthLow = (this.byteLengthLow << 3) >>> 0;
    this.writeUint32BigEndian({ bytes: this.remainder, offset: 56, value: bitLengthHigh });
    this.writeUint32BigEndian({ bytes: this.remainder, offset: 60, value: bitLengthLow });
    this.compressBlocks({ bytes: this.remainder, offset: 0, blockCount: 1 });

    const digest = new Uint8Array(20);
    for (let index = 0; index < this.hashState.length; index += 1) {
      this.writeUint32BigEndian({ bytes: digest, offset: index * 4, value: this.hashState[index]! });
    }
    this.finalizedDigest = digest;
    return digest.slice();
  }

  digestHex(): string {
    return Array.from(this.digestBytes(), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private assertAccepting(): void {
    switch (this.phase) {
    case "accepting":
      return;
    case "finalized":
      throw new Error("SHA1 hasher is already finalized");
    default: {
      const _ex: never = this.phase;
      throw new Error(`Unhandled SHA1 phase: ${_ex}`);
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

  private compressBlocks({ bytes, offset, blockCount }: {
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
      for (let index = 16; index < 80; index += 1) {
        this.schedule[index] = rotateLeft({
          value: this.schedule[index - 3]! ^ this.schedule[index - 8]! ^ this.schedule[index - 14]! ^ this.schedule[index - 16]!,
          bits: 1,
        });
      }

      let a = this.hashState[0]!;
      let b = this.hashState[1]!;
      let c = this.hashState[2]!;
      let d = this.hashState[3]!;
      let e = this.hashState[4]!;

      for (let index = 0; index < 80; index += 1) {
        const { f, k } = (() => {
          if (index < 20) return { f: ((b & c) | (~b & d)) >>> 0, k: 0x5a827999 };
          if (index < 40) return { f: (b ^ c ^ d) >>> 0, k: 0x6ed9eba1 };
          if (index < 60) return { f: ((b & c) | (b & d) | (c & d)) >>> 0, k: 0x8f1bbcdc };
          return { f: (b ^ c ^ d) >>> 0, k: 0xca62c1d6 };
        })();
        const temporary = (
          rotateLeft({ value: a, bits: 5 })
          + f
          + e
          + k
          + this.schedule[index]!
        ) >>> 0;
        e = d;
        d = c;
        c = rotateLeft({ value: b, bits: 30 });
        b = a;
        a = temporary;
      }

      this.hashState[0] = (this.hashState[0]! + a) >>> 0;
      this.hashState[1] = (this.hashState[1]! + b) >>> 0;
      this.hashState[2] = (this.hashState[2]! + c) >>> 0;
      this.hashState[3] = (this.hashState[3]! + d) >>> 0;
      this.hashState[4] = (this.hashState[4]! + e) >>> 0;
      blockOffset += 64;
    }
  }

  private writeUint32BigEndian({ bytes, offset, value }: {
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

export function createSha1Hasher(): Sha1Hasher {
  return new IncrementalSha1();
}

export function sha1Bytes({ bytes }: { bytes: Uint8Array }): Uint8Array {
  const hasher = createSha1Hasher();
  hasher.update({ bytes });
  return hasher.digestBytes();
}

export function sha1Hex({ bytes }: { bytes: Uint8Array }): string {
  const hasher = createSha1Hasher();
  hasher.update({ bytes });
  return hasher.digestHex();
}

export const TEST_ONLY = {
};
