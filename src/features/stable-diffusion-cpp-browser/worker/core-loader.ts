import type { Artifact } from '@/features/stable-diffusion-cpp-browser/types';
import type { CoreFactory, HostHelpers } from './core-types';
import { assertImageRuntimeContract } from '@/features/stable-diffusion-cpp-browser/runtime-contract';

function checkedCoreHelpers({ value, schemaSha256, bf16WeightRetention }: { value: unknown, schemaSha256: string, bf16WeightRetention?: boolean }): HostHelpers {
  if (!value || typeof value !== 'object' || !('attachCore' in value) || typeof value.attachCore !== 'function' || !('mountReadOnlyFile' in value) || typeof value.mountReadOnlyFile !== 'function' || !('schema' in value) || !value.schema || typeof value.schema !== 'object' || !('schemaSha256' in value.schema) || value.schema.schemaSha256 !== schemaSha256 || !('abiVersion' in value.schema) || value.schema.abiVersion !== 2) {
    throw new Error('Missing or incompatible thin image core helpers');
  }
  assertImageRuntimeContract({ schema: value.schema, bf16WeightRetention });
  return value as HostHelpers;
}

export async function loadCoreFactory({ artifact, baseUrl }: { artifact: Artifact, baseUrl: string }): Promise<{ create: CoreFactory, wasmBinary: Uint8Array<ArrayBuffer>, moduleUrl: string, helpers: HostHelpers }> {
  const base = new URL(baseUrl);
  if (base.origin !== self.location.origin || !['http:', 'https:'].includes(base.protocol) || base.search || base.hash) {
    throw new Error('Image runtime base must be the hosting application');
  }
  const moduleUrl = new URL(artifact.modulePath, base).href;
  const response = await fetch(new URL(artifact.wasmPath, base), { credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || !response.body) {
    throw new Error(`Image Wasm request failed (${response.status})`);
  }
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const wasmBinary = new Uint8Array(artifact.wasmBytes);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (offset + chunk.value.length > wasmBinary.length) {
        throw new Error('Decompressed image Wasm exceeds manifest size');
      }
      wasmBinary.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== wasmBinary.length) {
    throw new Error('Truncated image Wasm');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', wasmBinary));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== artifact.wasmSha256) {
    throw new Error('Image Wasm integrity mismatch');
  }
  const module: unknown = await import(/* @vite-ignore */ moduleUrl);
  if (!module || typeof module !== 'object' || !('default' in module) || typeof module.default !== 'function') {
    throw new Error('Missing image core factory');
  }
  const importedHelpers: unknown = await import(/* @vite-ignore */ new URL(artifact.helpersPath, base).href);
  const helpers = checkedCoreHelpers({ value: importedHelpers, schemaSha256: artifact.schemaSha256, bf16WeightRetention: artifact.bf16WeightRetention });
  return { helpers, create: module.default as CoreFactory, wasmBinary, moduleUrl };
}

export const TEST_ONLY = {
  checkedCoreHelpers,
};
