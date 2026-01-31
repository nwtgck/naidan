import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import ensureFileProtocolInit from './eslint-local-rules/ensure-file-protocol-init.js';
// import forceSwitchForUnion from './eslint-local-rules/force-switch-for-union.js';

// TODO: Re-enable this full ESLint configuration once underlying issues are resolved or project stability allows for stricter enforcement.
// export default tseslint.config(
//   {
//     ignores: ['dist/**', 'node_modules/**', 'public/**'],
//   },
//   eslint.configs.recommended,
//   ...tseslint.configs.recommended,
//   ...pluginVue.configs['flat/essential'],
//   {
//     files: ['**/*.ts', '**/*.vue'],
//     languageOptions: {
//       parserOptions: {
//         parser: tseslint.parser,
//         extraFileExtensions: ['.vue'],
//         sourceType: 'module',
//       },
//       globals: {
//         ...globals.browser,
//         ...globals.node,
//       },
//     },
//     rules: {
//       '@typescript-eslint/no-explicit-any': 'error',
//       '@typescript-eslint/no-unused-vars': ['error', { 
//         argsIgnorePattern: '^_',
//         varsIgnorePattern: '^_',
//         caughtErrorsIgnorePattern: '^_',
//       }],
//       '@typescript-eslint/consistent-type-imports': 'error',
//       'vue/multi-word-component-names': 'off', // Relax for page components
//       'quotes': 'off',
//       'comma-dangle': ['warn', 'always-multiline'],
//       'max-len': 'off',
//       'vue/html-indent': ['warn', 2],
//       'indent': ['warn', 2],
//       // Prevents components (like icons) from disappearing silently due to missing imports.
//       // Without this, build succeeds but the component fails to render at runtime.
//       'vue/no-undef-components': ['error', {
//         'ignorePatterns': ['router-link', 'router-view'],
//       }],
//     },
//   },
//   ensureFileProtocolInit,
//   {
//     files: ['**/*.test.ts'],
//     languageOptions: {
//       globals: {
//         ...globals.vitest,
//       }
//     },
//     rules: {
//       '@typescript-eslint/no-explicit-any': 'warn',
//     }
//   }
// );

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'naidan-server/**', 'eslint-local-rules/*.test.ts'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.ts', '**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        __BUILD_MODE_IS_STANDALONE__: 'readonly',
        __BUILD_MODE_IS_HOSTED__: 'readonly',
        __APP_VERSION__: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // '@typescript-eslint/no-unused-vars': ['error', { 
      //   argsIgnorePattern: '^_',
      //   varsIgnorePattern: '^_',
      //   caughtErrorsIgnorePattern: '^_',
      // }],
      // '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      'vue/multi-word-component-names': 'off', // Relax for page components
      'quotes': 'off',
      // 'comma-dangle': ['warn', 'always-multiline'],
      'comma-dangle': 'off',
      'max-len': 'off',
      'vue/html-indent': ['warn', 2],
      'indent': ['warn', 2],
      // Prevents components (like icons) from disappearing silently due to missing imports.
      // Without this, build succeeds but the component fails to render at runtime.
      'vue/no-undef-components': ['error', {
        'ignorePatterns': ['router-link', 'router-view'],
      }],
      'vue/define-props-declaration': ['error', 'type-based'],
      'vue/define-emits-declaration': ['error', 'type-based'],
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
    },
  },
  ensureFileProtocolInit,
  // forceSwitchForUnion,
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      }
    },
    rules: {
      // '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      'local-rules-switch/force-switch-for-union': 'off',
    }
  }
);
