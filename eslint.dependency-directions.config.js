import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import { rule as enforceDependencyDirectionsRule } from './eslint-local-rules/enforce-dependency-directions.js';
import { rule as forceSwitchForUnionRule } from './eslint-local-rules/force-switch-for-union.js';
import { rule as requireNamedArgsRule } from './eslint-local-rules/require-named-args.js';

const dependencyDirectionRule = {
  plugins: {
    '@typescript-eslint': tseslint.plugin,
    vue: pluginVue,
    'local-rules': {
      rules: {
        'enforce-dependency-directions': enforceDependencyDirectionsRule,
      },
    },
    'local-rules-named-args': {
      rules: {
        'require-named-args': requireNamedArgsRule,
      },
    },
    'local-rules-switch': {
      rules: {
        'force-switch-for-union': forceSwitchForUnionRule,
      },
    },
  },
  rules: {
    'local-rules/enforce-dependency-directions': [
      'error',
      { rootDir: 'src', aliasPrefixes: ['@', '~'] },
    ],
  },
};

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'public/**', 'src/test-tmp/**'],
    linterOptions: {
      // Existing source files contain suppressions for rules that are
      // intentionally absent from this dependency-only configuration.
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    ...dependencyDirectionRule,
  },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
      },
    },
    ...dependencyDirectionRule,
  },
  // debug-hizofs is a developer and reviewer audit surface, not a general-user
  // abstraction. It intentionally reads persisted-format and inspection DTOs
  // directly so newly added fields cannot disappear behind a lossy mapper. It
  // displays authoritative copies, segments, frames, records, indexes,
  // corruption, maintenance, benchmark, and fault-injection state while reusing
  // the owner codecs. Disable only the dependency-direction rule for this exact
  // path; ordinary features must continue to use public boundaries.
  {
    files: ['src/features/debug-hizofs/**/*.{ts,tsx,vue}'],
    rules: {
      'local-rules/enforce-dependency-directions': 'off',
    },
  },
  // debug-opfs-encryption is the corresponding developer and reviewer audit
  // surface for exact Naidan Persistence Control evidence and container-local
  // cryptographic state. Direct persisted DTO access is intentional: a mapper
  // could normalize or omit fields required to review A/B authority and proof
  // validity. The exception is exact-path only, grants no `debug-*` wildcard,
  // and leaves every lint rule other than dependency direction enabled.
  {
    files: ['src/features/debug-opfs-encryption/**/*.{ts,tsx,vue}'],
    rules: {
      'local-rules/enforce-dependency-directions': 'off',
    },
  },
];
