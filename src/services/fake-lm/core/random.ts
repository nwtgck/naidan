export type FakeLmSeed = number;
export type SeededNonCryptoPseudoRandom = () => number;

export function createSeededNonCryptoPseudoRandom({ seed }: {
  seed: FakeLmSeed;
}): SeededNonCryptoPseudoRandom {
  return createMulberry32({ seed: seed >>> 0 });
}

function createMulberry32({ seed }: { seed: number }): SeededNonCryptoPseudoRandom {
  let t = seed >>> 0;

  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function mixSeed({ seed, salt }: {
  seed: FakeLmSeed;
  salt: string;
}): FakeLmSeed {
  let h = seed >>> 0;

  for (let i = 0; i < salt.length; i += 1) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

export function randomInt({ random, min, max }: {
  random: SeededNonCryptoPseudoRandom;
  min: number;
  max: number;
}): number {
  return min + Math.floor(random() * (max - min + 1));
}
