import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'out',
      'dist',
      'release',
      'website/**',
      'playwright-report/**',
      'test-results/**',
      'resources/codex-schema',
      '.tmp-openai-docs-cache',
      '.tmp-omniparser-reference',
      '.sidecar-smoke',
      '.venv-paddleocr',
      '.paddle-ocr-cache',
      '.venv-omniparser',
      '.omniparser-runtime'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' }
    }
  },
  {
    files: ['build/**/*.cjs'],
    languageOptions: {
      globals: { console: 'readonly', module: 'readonly', process: 'readonly', require: 'readonly' }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
)
