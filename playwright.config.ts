import { defineConfig, devices } from '@playwright/test';

const BACKEND_CWD = 'backend';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5173',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // DATABASE_URL and DB settings come from backend/.env; only test-specific values are overridden here.
  webServer: [
    {
      command: 'npx tsx src/server.ts',
      cwd: BACKEND_CWD,
      url: 'http://localhost:4000/api/health',
      env: {
        PORT: '4000',
        ALLOW_DEV_RESET: '1',
        RESERVATION_TTL_SECONDS: '3',
      },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'npx tsx src/server.ts',
      cwd: BACKEND_CWD,
      url: 'http://localhost:4001/api/health',
      env: {
        PORT: '4001',
        ALLOW_DEV_RESET: '1',
        RESERVATION_TTL_SECONDS: '3',
      },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      cwd: 'frontend',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
    },
  ],
});
