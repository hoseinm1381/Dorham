import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['.tools/**', 'apps/web/public/audio/**', '**/dist/**', '**/node_modules/**', 'artifacts/**', 'release/**', 'data/**', 'apps/android/android/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  { files: ['**/*.{mjs,cjs}'], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', Response: 'readonly', Headers: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', __dirname: 'readonly', require: 'readonly', module: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' } }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['apps/web/public/sw.js'], languageOptions: { globals: { self: 'readonly', caches: 'readonly', URL: 'readonly', fetch: 'readonly', Response: 'readonly' } } }
);
