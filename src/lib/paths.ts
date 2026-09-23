import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** リポジトリのルート */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** ローカルの作業データ（SQLite・生レスポンス）。リポジトリにはコミットしない */
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, "data");

export const DB_PATH = join(DATA_DIR, "db.sqlite");
export const RAW_DIR = join(DATA_DIR, "raw");
