import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'ingredient-postgres.spec.ts',workers:1,
 use:{baseURL:'http://localhost:3103',httpCredentials:{username:'chef',password:'test-only-preview-password-32-characters'}},
 webServer:[
 {command:'PYTHONPATH=../tests:.. ../.venv/bin/uvicorn ingredient_pg_backend:app --host 127.0.0.1 --port 8103',url:'http://127.0.0.1:8103/test/state',reuseExistingServer:false},
 {command:'npm run build && npm run start -- --port 3103',url:'http://localhost:3103',timeout:180000,reuseExistingServer:false,
 env:{FASTAPI_BASE_URL:'http://127.0.0.1:8103',DEMO_ACCESS_TOKEN:'test-only-backend-token',DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters',MODEL_API_KEY:''}}
 ]});
