import { defineConfig } from 'vitest/config';

const isE2E = process.env['VITEST_E2E'] === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: isE2E
      ? ['test/e2e/**/*.spec.ts', 'test/e2e/**/*.test.ts']
      : ['test/unit/**/*.spec.ts', 'test/integration/**/*.spec.ts'],
    exclude: isE2E
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', 'test/e2e/**'],
  },
});
