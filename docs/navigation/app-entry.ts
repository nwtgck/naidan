import { DOCS_PUBLIC_ORIGIN } from '../build/seo';
import type { ModelSeoId } from '../../src/features/llama-cpp-browser/hugging-face/model-repositories';

export type AppDestination =
  | { kind: 'screen'; screen: 'home' | 'gguf-manager' | 'transformers-js-manager' | 'connection' | 'files-settings' | 'folders-settings' | 'image-generation' | 'audio-generation' }
  | { kind: 'model'; model: string }
  | { kind: 'model-page'; model: ModelSeoId };

export function appDestinationPath({ destination }: { destination: AppDestination }): string {
  switch (destination.kind) {
  case 'screen': {
    switch (destination.screen) {
    case 'home': return '/#/';
    case 'gguf-manager': return '/#/settings/llama-cpp-browser';
    case 'transformers-js-manager': return '/#/settings/transformers-js';
    case 'connection': return '/#/settings/connection';
    case 'files-settings': return '/#/settings/binary-objects';
    case 'folders-settings': return '/#/settings/volumes';
    case 'image-generation': return '/#/image-generation/';
    case 'audio-generation': return '/#/audio-generation';
    default: {
      const unreachable: never = destination.screen;
      throw new Error(`Unknown app screen: ${unreachable}`);
    }
    }
  }
  // Published IDs contain only path-safe repository names and quantizations.
  // The build contract checks this Docs path against the public page registry.
  case 'model-page': return `/llama-cpp-browser/${destination.model}/`;
  case 'model': return `/#/?${new URLSearchParams({ 'llama-cpp-browser-model': destination.model }).toString()}`;
  default: {
    const unreachable: never = destination;
    throw new Error(`Unknown app destination: ${String(unreachable)}`);
  }
  }
}

export function appEntryUrl({ destination, base }: { destination: AppDestination; base: string }): string {
  return new URL(appDestinationPath({ destination }), base).href;
}

export function appEntryFallbackUrl({ destination }: { destination: AppDestination }): string {
  // This is an HTML fallback, separate from the fixed Docs canonical metadata.
  return appEntryUrl({ destination, base: DOCS_PUBLIC_ORIGIN });
}

/** Accept only root-relative app routes, never an origin supplied by article HTML. */
export function isAppEntryPath({ value }: { value: string }): boolean {
  return value.startsWith('/#/')
    || /^\/llama-cpp-browser\/hf\.co\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(value);
}
