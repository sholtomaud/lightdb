import globals from 'globals';
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'playwright-report/', 'test-results/'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      // TypeScript resolves identifiers itself, and no-undef cannot see type-only
      // names like CanvasImageSource or ReadableWritablePair. Disabling it for
      // .ts files is typescript-eslint's own recommendation.
      'no-undef': 'off',
    },
  },
];
