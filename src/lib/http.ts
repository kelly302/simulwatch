import { setTimeout as sleep } from "node:timers/promises";
import type { CrawlConfig } from "./config.ts";
import type { RawLog } from "./rawlog.ts";

// 外部へのリクエストはすべてここを通す。
// - ホストごとに間隔を空けて逐次リクエストする
// - 5xx・429・ネットワークエラーは指数バックオフで再試行する
// - 生レスポンスを RawLog に残す

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} ${url.replace(/key=[^&]+/, "key=REDACTED")}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export interface HttpResult {
  status: number;
  body: string;
}

export class Http {
  private lastAt = new Map<string, number>();
  private readonly cfg: CrawlConfig["http"];
  private readonly raw: RawLog;

  constructor(cfg: CrawlConfig["http"], raw: RawLog) {
    this.cfg = cfg;
    this.raw = raw;
  }

  private async throttle(host: string): Promise<void> {
    const interval = this.cfg.min_interval_ms[host] ?? this.cfg.min_interval_ms["default"] ?? 0;
    const last = this.lastAt.get(host) ?? 0;
    const wait = last + interval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt.set(host, Date.now());
  }

  /**
   * GET して本文を返す。2xx 以外は HttpError を投げる。
   * `allowStatus` に含めたステータスは例外にせずそのまま返す（404 を「存在しない」として扱う場合など）。
   */
  async get(url: string, opts: { allowStatus?: number[]; headers?: Record<string, string> } = {}): Promise<HttpResult> {
    const host = new URL(url).host;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      await this.throttle(host);
      const started = Date.now();
      try {
        const res = await fetch(url, {
          headers: { "user-agent": this.cfg.user_agent, "accept-language": "ja", ...opts.headers },
          signal: AbortSignal.timeout(this.cfg.timeout_ms),
        });
        const body = await res.text();
        this.raw.add({ at: new Date(started).toISOString(), method: "GET", url, status: res.status, ms: Date.now() - started, body });
        if (res.ok || opts.allowStatus?.includes(res.status)) return { status: res.status, body };
        const err = new HttpError(res.status, url, body);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof HttpError && !(e.status === 429 || e.status >= 500)) throw e;
        if (!(e instanceof HttpError)) {
          this.raw.add({ at: new Date(started).toISOString(), method: "GET", url, status: 0, ms: Date.now() - started, body: String(e) });
        }
        lastErr = e;
      }
    }
    throw lastErr;
  }
}
