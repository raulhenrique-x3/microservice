import { defineConfig } from 'vitest/config';
import path from 'node:path';

// alias resolves @app/shared straight to source, so unit tests never need a
// build step.
export default defineConfig({
  resolve: {
    alias: {
      '@app/shared': path.resolve(import.meta.dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/test/**/*.spec.ts', 'apps/**/src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.e2e-spec.ts'],
  },
});
