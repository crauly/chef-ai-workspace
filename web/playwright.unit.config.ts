import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',workers:1,testMatch: /(?:structured-output|voice-recipe-deferred|price-web-search)\.spec\.ts/});
