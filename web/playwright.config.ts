import {defineConfig} from "@playwright/test";
const password = "test-only-preview-password-32-characters";
const liveMeta = process.env.CHEF_LIVE_META_BROWSER === "1";
export default defineConfig({
  testDir: "./tests", workers: 1, use: {baseURL: "http://localhost:3100", httpCredentials: {username: "chef", password}},
  webServer: [
    {command: "node tests/backend.mjs", port: 8100, reuseExistingServer: false},
    {// Rebuild checked-out source and test production authentication semantics; never reuse stale .next.
    command: "npm run build && npm run start -- --port 3100", url: "http://localhost:3100", reuseExistingServer: false, timeout: 180000,
      env: {FASTAPI_BASE_URL: liveMeta ? "http://127.0.0.1:8101" : "http://127.0.0.1:8100", DEMO_ACCESS_TOKEN: "test-only-backend-token", DEMO_PREVIEW_PASSWORD: password, MODEL_API_KEY: liveMeta ? process.env.MODEL_API_KEY ?? "" : ""}},
  ],
});
