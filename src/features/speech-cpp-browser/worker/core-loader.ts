import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';
import type createModule from 'speech-cpp-browser-core/speech-cpp/profiles/webgpu-wasm64-jspi/browser/core.mjs';
import type { SpeechArtifact } from '@/features/speech-cpp-browser/artifacts';
import { speechError } from '@/features/speech-cpp-browser/types';

type Helpers = typeof import('speech-cpp-browser-core/speech-cpp/host');

export async function loadSpeechCore({ artifact, baseUrl }: { artifact: SpeechArtifact, baseUrl: string }): Promise<{ core: Core, helpers: Helpers }> {
  const base = new URL(baseUrl);
  if (base.origin !== self.location.origin || !['https:', 'http:'].includes(base.protocol) || base.search || base.hash) {
    throw speechError({ code: 'unavailable', message: 'Speech assets must belong to the hosting application' });
  }
  const response = await fetch(new URL(artifact.wasmPath, base), { credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || response.body === null) {
    throw speechError({ code: 'unavailable', message: `Speech Wasm request failed (${response.status})` });
  }
  const wasmBinary = new Uint8Array(artifact.wasmBytes);
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (offset + chunk.value.length > wasmBinary.length) {
        throw new Error('Decompressed speech Wasm exceeds manifest size');
      }
      wasmBinary.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== wasmBinary.length) {
    throw new Error('Truncated speech Wasm');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', wasmBinary));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== artifact.wasmSha256) {
    throw new Error('Speech Wasm integrity mismatch');
  }
  const factoryModule: unknown = await import(/* @vite-ignore */ new URL(artifact.modulePath, base).href);
  const helperModule: unknown = await import(/* @vite-ignore */ new URL(artifact.helpersPath, base).href);
  if (factoryModule === null || typeof factoryModule !== 'object' || !('default' in factoryModule) || typeof factoryModule.default !== 'function' || helperModule === null || typeof helperModule !== 'object' || !('attachCore' in helperModule) || typeof helperModule.attachCore !== 'function' || !('mountReadOnlyFile' in helperModule) || typeof helperModule.mountReadOnlyFile !== 'function' || !('schema' in helperModule) || helperModule.schema === null || typeof helperModule.schema !== 'object' || !('schemaSha256' in helperModule.schema) || helperModule.schema.schemaSha256 !== artifact.schemaSha256) {
    throw new Error('Missing or incompatible generated speech host helpers');
  }
  // The immutable artifact's inventory/fingerprint is verified by the build
  // reader; these callable types come from that artifact's generated declarations.
  const create = factoryModule.default as typeof createModule;
  const helpers = helperModule as Helpers;
  const module = await create({ wasmBinary });
  const core = helpers.attachCore(module, helpers.schema, { suspension: 'jspi' });
  if (core.pointerBytes !== 8 || core.schema.runtime !== 'speech-cpp' || core.schema.abiVersion !== 3 || await core.api.speech_api_version_major() !== 4 || await core.api.speech_api_version_minor() < 2) {
    throw new Error('Speech dialogue ABI 3 / upstream API 4.2 is required');
  }
  return { core, helpers };
}

export const TEST_ONLY = {
};
