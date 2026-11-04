import {defineConfig} from '@playwright/test';
import base from './playwright.ingredient-pg.config';
export default defineConfig({...base,testMatch:'recipe-master-postgres.spec.ts'});
