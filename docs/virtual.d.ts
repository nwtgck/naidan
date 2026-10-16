declare module 'virtual:naidan-docs/registry' {
  export const pages: import('./build/contracts').PageRegistry['pages'];
  export const common: import('./build/contracts').PageRegistry['common'];
}

// Match the repository's test-only component exposure convention.
declare const __BUILD_MODE_IS_TEST__: boolean;
