import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.js'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', '*.config.js']
    }
  }
});
