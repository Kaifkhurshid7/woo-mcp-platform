// Flat ESLint config: Node services, the React dashboard, and the test scripts.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const common = {
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
};

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'charts/**'] },
  js.configs.recommended,
  { files: ['services/*/src/**/*.js', 'services/*/test/**/*.js', 'tests/**/*.mjs', 'eslint.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node }, ...common },
  {
    files: ['services/dashboard/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: 'detect' } },
    rules: { ...common.rules, ...reactHooks.configs.recommended.rules, 'react/jsx-uses-vars': 'error', 'react/jsx-uses-react': 'error' },
  },
  { files: ['services/dashboard/vite.config.js'], languageOptions: { globals: globals.node } },
];
