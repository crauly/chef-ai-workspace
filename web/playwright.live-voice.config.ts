import {defineConfig} from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: process.env.CHEF_LIVE_VOICE_CASE==="complaint"?"live-voice-complaint.spec.ts":"live-voice.spec.ts", workers: 1, timeout: 240_000,
  use: {baseURL: "http://localhost:3102", httpCredentials: {username: "chef", password: "isolated-live-voice-preview-password-48"}},
  webServer: {command: "npm run start -- --port 3102", url: "http://localhost:3102", reuseExistingServer: false,
    env: {FASTAPI_BASE_URL: "http://127.0.0.1:8102", DEMO_ACCESS_TOKEN: "isolated-live-voice-test-token-48-characters",
      DEMO_PREVIEW_PASSWORD: "isolated-live-voice-preview-password-48"}},
});
