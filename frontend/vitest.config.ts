import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000',
      },
    },
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // This suite has load-dependent flakes (PrintModal, ArchivesPage, ...).
      // Vitest defaults reportOnFailure to false, so a single flake would make
      // the coverage gate emit NO number at all -- indistinguishable from a
      // coverage collapse. Always emit the report; the pass/fail judgement is
      // the test run's job, not the reporter's.
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/__tests__/**',
        'src/main.tsx',
        // Ambient declaration files carry no executable statements, and the
        // whole-tree coverage pass (getCoverageMapForUncoveredFiles) hard-fails
        // trying to parse them as modules: `export const X: number[]` has no
        // initializer. Excluding them hides no runtime code -- the implementation
        // they describe (e.g. lib/vendor/toolpathRenderer.js) is JS and was never
        // matched by the .ts/.tsx include glob in the first place.
        'src/**/*.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
