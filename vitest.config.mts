import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 20000,
    // Socket/Redis and database tests share one set of local containers;
    // run files serially so they cannot race each other.
    fileParallelism: false,
    // Point the app's Prisma singleton at the test database. dotenv does not
    // override variables that are already set, so this wins over .env.
    env: {
      // Presence normally lingers for seconds so a recycled connection does not
      // flash a collaborator out of the list; tests should not wait for it.
      PRESENCE_GRACE_MS: '150',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        'postgresql://syncdraft:syncdraft@localhost:5432/syncdraft_test?schema=public',
    },
  },
});
