import { fileURLToPath } from 'node:url';
import path from 'node:path';

// repo root = two levels up from src/lib/
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = path.join(ROOT, 'data');
export const DATA_ITEMS_DIR = path.join(DATA_DIR, 'items');
export const DATA_RETAIL_DIR = path.join(DATA_DIR, 'retail');
export const DATA_ESTAT_DIR = path.join(DATA_DIR, 'estat');
export const DATA_SOCIAL_DIR = path.join(DATA_DIR, 'social');
export const RAW_SAMPLES_DIR = path.join(DATA_DIR, 'raw-samples');
export const RAW_SAMPLES_FILES_DIR = path.join(RAW_SAMPLES_DIR, 'files');
export const VEGETAN_FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures', 'vegetan');
export const ESTAT_FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures', 'estat');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const TEMPLATES_DIR = path.join(ROOT, 'src', 'templates');
