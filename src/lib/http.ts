import { setTimeout as sleep } from "node:timers/promises";
import type { CrawlConfig } from "./config.ts";
import type { RawLog } from "./rawlog.ts";

// 外部へのリクエストはすべてここを通す。
// - ホストごとに間隔を空けて逐次リクエストする
// - 5xx・429・ネットワークエラーは再試行する。429 で Retry-After があればその秒数だけ待つ
// - 生レスポンスを RawLog に残す

/**
 * ログ・実行記録（runs）に出す URL。クエリの値とフラグメントを伏せ、パラメータの名前だけ残す。
 * 公開リポジトリの Actions のログは誰でも見られる。クエリには API キーや、照会の語（メン限の枠の概要欄の断片がありうる）が入る。
 * 生レスポンス（RawLog。非公開の置き場）は伏せない
 */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.replace(/[?#].*$/s, "?REDACTED");
  }
  // 名前も「?語」の形で値が入りうるので、識別子の形の名前だけ残す
  const names = [...new Set(u.searchParams.keys())].map((k) => (/^[A-Za-z0-9_.-]{1,40}$/.test(k) ? `${k}=…` : "…"));
  return `${u.origin}${u.pathname}${names.length ? `?${names.join("&")}` : ""}`;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} ${redactUrl(url)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export interface HttpResult {
  status: number;
  body: string;
}

export interface RequestOptions {
  allowStatus?: number[];
  headers?: Record<string, string>;
}

/** Retry-After の上限（秒）。これより長い指示は失敗として扱い、次回の実行に回す */
const MAX_RETRY_AFTER_SEC = 90;

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
  get(url: string, opts: RequestOptions = {}): Promise<HttpResult> {
    return this.request("GET", url, undefined, opts);
  }

  /** フォームを POST する（MediaWiki API 用。GET だと記事名をまとめたときに URL が長すぎて 414 になる） */
  postForm(url: string, params: Record<string, string>, opts: RequestOptions = {}): Promise<HttpResult> {
    return this.request("POST", url, new URLSearchParams(params).toString(), {
      ...opts,
      headers: { "content-type": "application/x-www-form-urlencoded", ...opts.headers },
    });
  }

  /** JSON を POST する（GraphQL 用） */
  postJson(url: string, body: unknown, opts: RequestOptions = {}): Promise<HttpResult> {
    return this.request("POST", url, JSON.stringify(body), {
      ...opts,
      headers: { "content-type": "application/json", accept: "application/json", ...opts.headers },
    });
  }

  private async request(method: string, url: string, body: string | undefined, opts: RequestOptions): Promise<HttpResult> {
    const host = new URL(url).host;
    let lastErr: unknown;
    let waitNext = 0;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt > 0) await sleep(Math.max(waitNext, 1000 * 2 ** (attempt - 1)));
      waitNext = 0;
      await this.throttle(host);
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method,
          body,
          headers: { "user-agent": this.cfg.user_agent, "accept-language": "ja", ...opts.headers },
          signal: AbortSignal.timeout(this.cfg.timeout_ms),
        });
        const text = await res.text();
        this.raw.add({
          at: new Date(started).toISOString(), method, url: body ? `${url} ${body.slice(0, 2000)}` : url,
          status: res.status, ms: Date.now() - started, body: text,
        });
        if (res.ok || opts.allowStatus?.includes(res.status)) return { status: res.status, body: text };
        const err = new HttpError(res.status, url, text);
        if (res.status !== 429 && res.status < 500) throw err;
        // 再試行する。Retry-After が長すぎるときは今回はあきらめる
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) {
          if (ra > MAX_RETRY_AFTER_SEC) throw err;
          waitNext = ra * 1000;
        }
        lastErr = err;
      } catch (e) {
        // HttpError はここまでに再試行するかを決めている。投げられたものはそのまま返す
        if (e instanceof HttpError) throw e;
        // ネットワークエラー・タイムアウトは再試行する
        this.raw.add({ at: new Date(started).toISOString(), method, url, status: 0, ms: Date.now() - started, body: String(e) });
        lastErr = e;
      }
    }
    throw lastErr;
  }
}
