import type { Http } from "../../lib/http.ts";
import type { ResolveCache } from "../cache.ts";

// 日本語版 Wikipedia（候補探し）と Wikidata（ID と種類の確認）。実写・特撮・海外作品の同定に使う。
// - 記事名の照会は1回に50件までまとめる（titles=A|B|C）
// - User-Agent に連絡先が無いと 429 で弾かれる（config/crawl.yaml の http.user_agent）

const WP = "https://ja.wikipedia.org/w/api.php";
const WD = "https://www.wikidata.org/w/api.php";

export interface PageInfo {
  /** 照会した記事名 */
  query: string;
  /** リダイレクトを辿った先の記事名。無ければ null */
  title: string | null;
  qid: string | null;
  missing: boolean;
  disambiguation: boolean;
  /** リダイレクトを経由したか */
  redirected: boolean;
  /** 記事の節（#…）へのリダイレクト。主題が別の記事の一部なので採用しない */
  fragment: boolean;
}

export interface EntityInfo {
  qid: string;
  p31: string[];
  labelJa: string | null;
  /** 公開日（P577）か開始日（P580）の年 */
  year: number | null;
  /** シリーズ（P179） */
  series: string | null;
}

function form(params: Record<string, string>): Record<string, string> {
  return { format: "json", formatversion: "2", ...params };
}

/** MediaWiki の記事名に使えない文字を含むか */
export function isValidTitle(t: string): boolean {
  return t.length > 0 && t.length <= 255 && !/[#<>[\]{}|]/.test(t);
}

/** MediaWiki API の一時的なサーバーエラー（200 で本文にエラーが入って返る）。少し待てば通ることが多い */
function isTransient(code: string): boolean {
  return code.startsWith("internal_api_error") || code === "maxlag" || code === "ratelimited" || code === "readonly"
    || code === "cirrussearch-too-busy-error" || code === "toomanyrequests";
}

export class WikipediaClient {
  private readonly http: Http;
  private readonly cache: ResolveCache;
  requests = 0;
  /** 照会に失敗した記事名（1回の照会ごと）。これを使う区間は「照会エラー」にして次回に回す */
  readonly failedTitles = new Set<string>();
  readonly errors: string[] = [];

  constructor(http: Http, cache: ResolveCache) {
    this.http = http;
    this.cache = cache;
  }

  /** POST して JSON を返す。一時的なサーバーエラーは待って再試行し、それ以外のエラーはそのまま返す */
  private async getJson(base: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await this.http.postForm(base, form(params));
      const j = JSON.parse(res.body) as Record<string, unknown> & { error?: { code: string; info?: string; id?: string } };
      if (!j.error) return j;
      if (isTransient(j.error.code) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      return j;
    }
  }

  /** 記事名で引く（リダイレクトを辿る）。キャッシュに無いものだけ照会する */
  async pages(titles: string[]): Promise<Map<string, PageInfo>> {
    const out = new Map<string, PageInfo>();
    const todo: string[] = [];
    for (const t of new Set(titles)) {
      if (!isValidTitle(t)) {
        out.set(t, { query: t, title: null, qid: null, missing: true, disambiguation: false, redirected: false, fragment: false });
        continue;
      }
      const c = this.cache.get<PageInfo>("wp_page", t);
      if (c) out.set(t, c);
      else todo.push(t);
    }
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      // 1回の照会が落ちても他の回は続ける。落ちた回の記事名は failedTitles に入れ、その区間だけ「照会エラー」にする
      let q: Record<string, any>;
      try {
        const j = await this.getJson(WP, { action: "query", titles: batch.join("|"), redirects: "1", prop: "pageprops", ppprop: "wikibase_item|disambiguation" });
        if (j.error) throw new Error(`Wikipedia: ${JSON.stringify(j.error).slice(0, 200)}`);
        q = (j.query ?? {}) as Record<string, any>;
      } catch (e) {
        for (const t of batch) this.failedTitles.add(t);
        this.errors.push(String(e).slice(0, 300));
        continue;
      }
      const normalized = new Map<string, string>((q.normalized ?? []).map((n: { from: string; to: string }) => [n.from, n.to]));
      const redirects = new Map<string, { to: string; tofragment?: string }>(
        (q.redirects ?? []).map((r: { from: string; to: string; tofragment?: string }) => [r.from, r]),
      );
      const pages = new Map<string, { title: string; missing?: boolean; invalid?: boolean; pageprops?: Record<string, string> }>(
        (q.pages ?? []).map((p: { title: string }) => [p.title, p]),
      );
      for (const t of batch) {
        let cur = normalized.get(t) ?? t;
        const r = redirects.get(cur);
        if (r) cur = r.to;
        const p = pages.get(cur);
        const info: PageInfo = {
          query: t,
          title: p && !p.missing && !p.invalid ? p.title : null,
          qid: p?.pageprops?.wikibase_item ?? null,
          missing: !p || !!p.missing || !!p.invalid,
          disambiguation: p?.pageprops ? "disambiguation" in p.pageprops : false,
          redirected: !!r,
          fragment: !!r?.tofragment,
        };
        this.cache.set("wp_page", t, info);
        out.set(t, info);
      }
    }
    return out;
  }

  /** 全文検索の上位の記事名 */
  async search(text: string, limit = 5): Promise<string[]> {
    const c = this.cache.get<string[]>("wp_search", text);
    if (c) return c;
    const j = await this.getJson(WP, { action: "query", list: "search", srsearch: text, srlimit: String(limit), srnamespace: "0" });
    if (j.error) throw new Error(`Wikipedia: ${JSON.stringify(j.error).slice(0, 200)}`);
    const titles = (((j.query as { search?: { title: string }[] } | undefined)?.search ?? []) as { title: string }[]).map((s) => s.title);
    this.cache.set("wp_search", text, titles);
    return titles;
  }

  /** 照会に失敗した Wikidata の項目（一時的なエラーが続いたもの）。これを参照する区間は「照会エラー」にして次回に回す */
  readonly failedQids = new Set<string>();

  /** Wikidata の項目（P31・日本語ラベル・年・シリーズ） */
  async entities(qids: string[]): Promise<Map<string, EntityInfo>> {
    const out = new Map<string, EntityInfo>();
    const todo: string[] = [];
    for (const id of new Set(qids)) {
      const c = this.cache.get<EntityInfo>("wd_entity", id);
      if (c) out.set(id, c);
      else todo.push(id);
    }
    for (let i = 0; i < todo.length; i += 50) await this.fetchEntities(todo.slice(i, i + 50), out);
    return out;
  }

  /**
   * wbgetentities を1回まとめて呼ぶ。
   * - まとめた ID に存在しないものが1つでもあると全体がエラーになるので、その ID を外して呼び直す
   * - 一時的なサーバーエラーが続くときは半分に分けて呼び直し、1件でも落ちる項目は failedQids に入れる
   * - エラー応答や返ってこなかった項目はキャッシュしない（「P31 が空の項目」として残さない）
   */
  private async fetchEntities(ids: string[], out: Map<string, EntityInfo>): Promise<void> {
    let batch = ids;
    for (let attempt = 0; attempt < 10 && batch.length > 0; attempt++) {
      let j: { entities?: Record<string, WdEntity & { missing?: string }>; error?: { code: string; id?: string; info?: string } };
      try {
        j = (await this.getJson(WD, { action: "wbgetentities", ids: batch.join("|"), props: "claims|labels", languages: "ja" })) as typeof j;
      } catch (e) {
        // 通信エラー・タイムアウト（再試行しても落ちたもの）: 半分に分けて呼び直し、1件でも落ちる項目は failedQids に入れる
        this.errors.push(String(e).slice(0, 300));
        if (batch.length === 1) {
          this.failedQids.add(batch[0]!);
          return;
        }
        const half = Math.ceil(batch.length / 2);
        await this.fetchEntities(batch.slice(0, half), out);
        await this.fetchEntities(batch.slice(half), out);
        return;
      }
      if (j.error) {
        const bad = j.error.id;
        if (j.error.code === "no-such-entity" && bad && batch.includes(bad)) {
          batch = batch.filter((x) => x !== bad);
          continue;
        }
        if (isTransient(j.error.code)) {
          if (batch.length === 1) {
            this.failedQids.add(batch[0]!);
            return;
          }
          const half = Math.ceil(batch.length / 2);
          await this.fetchEntities(batch.slice(0, half), out);
          await this.fetchEntities(batch.slice(half), out);
          return;
        }
        throw new Error(`Wikidata: ${j.error.code} ${j.error.info ?? ""}`);
      }
      const ents = j.entities ?? {};
      for (const id of batch) {
        const e = ents[id];
        if (!e || e.missing !== undefined) continue;
        const info: EntityInfo = {
          qid: id,
          p31: claimIds(e, "P31"),
          labelJa: e.labels?.ja?.value ?? null,
          year: claimYear(e, "P577") ?? claimYear(e, "P580"),
          series: claimIds(e, "P179")[0] ?? null,
        };
        this.cache.set("wd_entity", id, info);
        out.set(id, info);
      }
      return;
    }
  }
}

interface WdEntity {
  labels?: Record<string, { value: string }>;
  claims?: Record<string, { mainsnak: { datavalue?: { value: unknown } } }[]>;
}

function claimIds(e: WdEntity | undefined, p: string): string[] {
  return (e?.claims?.[p] ?? [])
    .map((c) => (c.mainsnak.datavalue?.value as { id?: string } | undefined)?.id)
    .filter((x): x is string => !!x);
}

function claimYear(e: WdEntity | undefined, p: string): number | null {
  const years = (e?.claims?.[p] ?? [])
    .map((c) => (c.mainsnak.datavalue?.value as { time?: string } | undefined)?.time)
    .map((t) => (t ? Number(t.match(/^[+-](\d{4})/)?.[1]) : NaN))
    .filter((y) => Number.isFinite(y) && y > 0);
  return years.length ? Math.min(...years) : null;
}
