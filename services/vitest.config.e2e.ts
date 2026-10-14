import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@app/shared': path.resolve(import.meta.dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['apps/**/test/*.e2e-spec.ts'],
  },
});
