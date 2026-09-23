import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { RAW_DIR } from "./paths.ts";

// 取得した生レスポンスをデバッグ用に保存する。
// ジョブ1回につき1ファイル（JSON Lines を gzip）にまとめ、R2 へのアップロード回数を抑える。
// 日次ジョブは数百MBになるので、一定量ごとに gzip して追記する（gzip のメンバーを連結した形。
// gunzip でそのまま1本として読める）。メモリに溜め込まない。

export interface RawEntry {
  at: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  body: string;
}

/** 追記する単位（非圧縮のバイト数） */
const CHUNK_BYTES = 16 * 1024 * 1024;

/** URL からAPIキーを取り除く。生レスポンスにキーを残さない */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("key")) u.searchParams.set("key", "REDACTED");
    return u.toString();
  } catch {
    return url;
  }
}

export class RawLog {
  private lines: string[] = [];
  private bytes = 0;
  private count = 0;
  private written = false;
  readonly runId: string;
  readonly path: string;

  constructor(runId: string, dir: string = RAW_DIR) {
    this.runId = runId;
    this.path = join(dir, runId.slice(0, 10), `${runId}.jsonl.gz`);
  }

  add(entry: RawEntry): void {
    const line = JSON.stringify({ ...entry, url: sanitizeUrl(entry.url) });
    this.lines.push(line);
    this.bytes += line.length;
    this.count++;
    if (this.bytes >= CHUNK_BYTES) this.writeChunk();
  }

  get size(): number {
    return this.count;
  }

  private writeChunk(): void {
    if (this.lines.length === 0) return;
    mkdirSync(join(this.path, ".."), { recursive: true });
    appendFileSync(this.path, gzipSync(this.lines.join("\n") + "\n"));
    this.written = true;
    this.lines = [];
    this.bytes = 0;
  }

  /** 残りを書き出し、ファイルのパスを返す（1件もなければ null） */
  flush(): string | null {
    this.writeChunk();
    return this.written ? this.path : null;
  }
}
