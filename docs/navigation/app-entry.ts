import { DOCS_PUBLIC_ORIGIN } from '../build/seo';
import type { ModelPageId } from '../../src/features/llama-cpp-browser/hugging-face/model-repositories';

export type AppDestination =
  | { kind: 'screen'; screen: 'home' | 'gguf-manager' | 'transformers-js-manager' | 'connection' | 'files-settings' | 'folders-settings' | 'image-generation' | 'audio-generation' }
  | { kind: 'model'; model: string }
  | { kind: 'model-page'; model: ModelPageId; quant: string | undefined };

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
  // Docs uses only the shared ID type, not the application's runtime.
  // The build contract checks links against the public page URL generator.
  case 'model-page': {
    if (destination.quant !== undefined && (destination.quant.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(destination.quant))) {
      throw new Error('Invalid model page quantization');
    }
    return `/llama-cpp-browser/${destination.model}${destination.quant === undefined ? '' : `?${new URLSearchParams({ quant: destination.quant })}`}`;
  }
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
    || /^\/llama-cpp-browser\/hf\.co\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/?(?:\?quant=[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/.test(value);
}
