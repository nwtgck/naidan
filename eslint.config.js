import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import ensureReadyStateAwareAppBootstrap from './eslint-local-rules/ensure-ready-state-aware-app-bootstrap.js';
import ensureVueErrorHandler from './eslint-local-rules/ensure-vue-error-handler.js';
import forceSwitchForUnion from './eslint-local-rules/force-switch-for-union.js';
import preferMultilineTemplateLiterals from './eslint-local-rules/prefer-multiline-template-literals.js';
import requireTestOnlyExport from './eslint-local-rules/require-test-only-export.js';
import requireDefineExposeTestOnly from './eslint-local-rules/require-define-expose-test-only.js';
import requireIconSuffix from './eslint-local-rules/require-icon-suffix.js';
import requireWorkerClientFacade from './eslint-local-rules/require-worker-client-facade.js';
import requireNamedArgs from './eslint-local-rules/require-named-args.js';
import requireStaticStringAccess from './eslint-local-rules/require-static-string-access.js';
import noRawVHtml from './eslint-local-rules/no-raw-v-html.js';
import noAllowedHtmlCast from './eslint-local-rules/no-allowed-html-cast.js';
import noNaidanIdCast from './eslint-local-rules/no-naidan-id-cast.js';
import noInvalidAllowedHtmlTemplate from './eslint-local-rules/no-invalid-allowed-html-template.js';
import noRawDompurify from './eslint-local-rules/no-raw-dompurify.js';
import noXssProneBrowserApis from './eslint-local-rules/no-xss-prone-browser-apis.js';
import preferRootAliasImports from './eslint-local-rules/prefer-root-alias-imports.js';
import enforceDependencyDirections from './eslint-local-rules/enforce-dependency-directions.js';

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
//   ensureReadyStateAwareAppBootstrap,
//   ensureVueErrorHandler,
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
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'naidan-server/**', 'eslint-local-rules/*.test.ts', 'scripts/**'],
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
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNever: true,
        allowAny: false,
        allowBoolean: true,
        allowNullish: true,
        allowNumber: true,
        allowRegExp: false,
      }],
      // ESLint 10 adds stricter recommended rules. Keep this major-version
      // migration focused on tooling compatibility; tighten these separately.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
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
      'brace-style': ['warn', '1tbs', { allowSingleLine: false }],
      'no-trailing-spaces': 'error',
      // Prevents components (like icons) from disappearing silently due to missing imports.
      // Without this, build succeeds but the component fails to render at runtime.
      'vue/no-undef-components': ['error', {
        'ignorePatterns': ['router-link', 'router-view'],
      }],
      'vue/define-props-declaration': ['error', 'type-based'],
      'vue/define-emits-declaration': ['error', 'type-based'],
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@huggingface/transformers',
            message: 'Do not import @huggingface/transformers directly from main-thread code. Use the Transformers.js worker client facade to keep the UI responsive and preserve standalone tree shaking.'
          },
          {
            name: '@/features/transformers-js/worker/entry',
            message: 'Do not import the worker entry directly. Use the Transformers.js worker client facade instead.'
          },
          {
            name: 'highlight.js',
            message: 'Do not import highlight.js in main-thread code. Use the highlight worker client and keep highlight.js bundled only in the worker path.'
          },
          {
            name: '@/features/highlight/worker/core',
            message: 'Do not import worker-only highlight helpers from main-thread code. Use the highlight worker client or plain HTML escaping.'
          },
        ]
      }]
    },
  },
  ensureReadyStateAwareAppBootstrap,
  ensureVueErrorHandler,
  forceSwitchForUnion,
  preferMultilineTemplateLiterals,
  requireTestOnlyExport,
  requireDefineExposeTestOnly,
  requireIconSuffix,
  requireWorkerClientFacade,
  requireNamedArgs,
  requireStaticStringAccess,
  noRawVHtml,
  noAllowedHtmlCast,
  noNaidanIdCast,
  noInvalidAllowedHtmlTemplate,
  noRawDompurify,
  noXssProneBrowserApis,
  preferRootAliasImports,
  enforceDependencyDirections,
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
