import {defineConfig} from "@playwright/test";
const password = "test-only-preview-password-32-characters";
export default defineConfig({
  testDir: "./tests", workers: 1, use: {baseURL: "http://localhost:3100", httpCredentials: {username: "chef", password}},
  webServer: [
    {command: "node tests/backend.mjs", port: 8100, reuseExistingServer: false},
    {command: "npm run start -- --port 3100", url: "http://localhost:3100", reuseExistingServer: false,
      env: {FASTAPI_BASE_URL: "http://127.0.0.1:8100", DEMO_ACCESS_TOKEN: "test-only-backend-token", DEMO_PREVIEW_PASSWORD: password}},
  ],
});
