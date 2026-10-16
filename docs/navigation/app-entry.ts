import { DOCS_PUBLIC_ORIGIN } from '../build/seo';

export type AppDestination =
  | { kind: 'screen'; screen: 'home' | 'gguf-manager' | 'transformers-js-manager' | 'connection' | 'files-settings' | 'folders-settings' | 'image-generation' | 'audio-generation' }
  | { kind: 'model'; model: string };

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
    default: { const unreachable: never = destination.screen; throw new Error(`Unknown app screen: ${unreachable}`); }
    }
  }
  case 'model': return `/#/?${new URLSearchParams({ 'llama-cpp-browser-model': destination.model }).toString()}`;
  default: { const unreachable: never = destination; throw new Error(`Unknown app destination: ${String(unreachable)}`); }
  }
}

export function appEntryUrl({ destination, base }: { destination: AppDestination; base: string }): string {
  return new URL(appDestinationPath({ destination }), base).href;
}

export function appEntryFallbackUrl({ destination }: { destination: AppDestination }): string {
  // This is an HTML fallback, separate from the fixed Docs canonical metadata.
  return appEntryUrl({ destination, base: DOCS_PUBLIC_ORIGIN });
}
