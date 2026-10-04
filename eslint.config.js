import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**',
    // Arena fixtures, hidden evaluators and reference solutions are standalone sample projects, not NEXUS source.
    'arena/cases/**',
    'tests/fixtures/**',
  ] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly' } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The renderer must reach the system only through the preload bridge.
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'electron', 'better-sqlite3', '@anthropic-ai/*', '@main/*'] },
      ],
    },
  },
  {
    // Domain logic stays free of adapters so it can be tested without Electron, SQLite, or the SDK.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'electron', 'better-sqlite3', '@anthropic-ai/*', '@main/*'] },
      ],
    },
  },
)
