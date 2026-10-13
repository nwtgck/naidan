import { DOCS_PUBLIC_ORIGIN } from '../build/seo';

export type AppDestination =
  | { kind: 'screen'; screen: 'gguf-manager' | 'connection' | 'image-generation' | 'audio-generation' }
  | { kind: 'model'; model: string };

export function appDestinationPath({ destination }: { destination: AppDestination }): string {
  switch (destination.kind) {
  case 'screen': {
    switch (destination.screen) {
    case 'gguf-manager': return '/#/settings/llama-cpp-browser';
    case 'connection': return '/#/settings/connection';
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
