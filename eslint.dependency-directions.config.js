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
];
