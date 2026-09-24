import type { Http } from "../../lib/http.ts";
import type { ResolveCache } from "../cache.ts";
import type { Media, WorkCandidate } from "../types.ts";

// Annict GraphQL API（アニメの主軸）。アクセストークンが必要。
// searchWorks(titles:) は複数の検索語をまとめて照会できるので、batch_size 件ずつまとめる。
// 返ってきた作品の和集合を、その回の検索語それぞれのキャッシュに入れる（照合は作品名の一致で行うので、余分な作品が混ざっても害はない）。

const ENDPOINT = "https://api.annict.com/graphql";

const WORK_FIELDS = `
  annictId title titleKana titleEn titleRo media seasonName seasonYear episodesCount malAnimeId
  seriesList(first: 1) { nodes { annictId } }
`;

// シリーズの作品を並べるときの項目。Series.works は edges.item で取る（works.nodes は Annict 側で HTTP 500 になる）
const SERIES_WORK_FIELDS = "annictId title titleKana titleEn titleRo media seasonName seasonYear episodesCount malAnimeId";

interface AnnictWork {
  annictId: number;
  title: string;
  titleKana: string | null;
  titleEn: string | null;
  titleRo: string | null;
  media: "TV" | "OVA" | "MOVIE" | "WEB" | "OTHER";
  seasonName: "WINTER" | "SPRING" | "SUMMER" | "AUTUMN" | null;
  seasonYear: number | null;
  episodesCount: number;
  malAnimeId: string | null;
  seriesList?: { nodes: { annictId: number }[] };
}

export interface AnnictEpisode {
  number: number | null;
  numberText: string | null;
  title: string | null;
}

const MEDIA: Record<AnnictWork["media"], Media | null> = { TV: "tv", OVA: "ova", MOVIE: "movie", WEB: "web", OTHER: null };

export function annictToCandidate(w: AnnictWork): WorkCandidate {
  const mal = w.malAnimeId ? Number(w.malAnimeId) : null;
  return {
    source: "annict",
    sourceKey: `annict:${w.annictId}`,
    annictId: w.annictId,
    anilistId: null,
    wikidataId: null,
    malId: Number.isFinite(mal) ? mal : null,
    title: w.title,
    titleKana: w.titleKana,
    titles: [w.title, w.titleEn, w.titleRo].filter((x): x is string => !!x),
    media: MEDIA[w.media] ?? null,
    seasonName: w.seasonYear ? (w.seasonName ? `${w.seasonYear}-${w.seasonName.toLowerCase()}` : String(w.seasonYear)) : null,
    releaseYear: w.seasonYear ?? null,
    episodesCount: w.episodesCount || null,
    imageUrl: null,
    seriesId: w.seriesList?.nodes[0] ? `annict:${w.seriesList.nodes[0].annictId}` : null,
  };
}

export class AnnictClient {
  private readonly http: Http;
  private readonly cache: ResolveCache;
  private readonly token: string;
  private readonly batchSize: number;
  private readonly perQuery: number;
  requests = 0;

  constructor(http: Http, cache: ResolveCache, token: string, cfg: { batch_size: number; per_query: number }) {
    this.http = http;
    this.cache = cache;
    this.token = token;
    this.batchSize = Math.max(1, cfg.batch_size);
    this.perQuery = cfg.per_query;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.requests++;
    const res = await this.http.postJson(ENDPOINT, { query, variables }, { headers: { authorization: `Bearer ${this.token}` } });
    const j = JSON.parse(res.body) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(`Annict GraphQL: ${j.errors.map((e) => e.message).join("; ")}`);
    return j.data as T;
  }

  /** 検索語ごとの候補。キャッシュに無い語だけ照会する */
  async search(queries: string[]): Promise<Map<string, WorkCandidate[]>> {
    const out = new Map<string, WorkCandidate[]>();
    const todo: string[] = [];
    for (const q of new Set(queries)) {
      const c = this.cache.get<WorkCandidate[]>("annict", q);
      if (c) out.set(q, c);
      else todo.push(q);
    }
    for (let i = 0; i < todo.length; i += this.batchSize) {
      const batch = todo.slice(i, i + this.batchSize);
      const first = this.perQuery * batch.length;
      const data = await this.gql<{ searchWorks: { nodes: AnnictWork[]; pageInfo: { hasNextPage: boolean } } }>(
        `query($titles: [String!], $first: Int) {
          searchWorks(titles: $titles, first: $first, orderBy: { field: WATCHERS_COUNT, direction: DESC }) {
            nodes { ${WORK_FIELDS} } pageInfo { hasNextPage }
          }
        }`,
        { titles: batch, first },
      );
      let works = data.searchWorks.nodes.map(annictToCandidate);
      // 和集合が上限で切れたら、1語ずつ照会し直す（取りこぼしを防ぐ）
      if (data.searchWorks.pageInfo.hasNextPage && batch.length > 1) {
        for (const q of batch) {
          const d = await this.gql<{ searchWorks: { nodes: AnnictWork[] } }>(
            `query($titles: [String!], $first: Int) {
              searchWorks(titles: $titles, first: $first, orderBy: { field: WATCHERS_COUNT, direction: DESC }) { nodes { ${WORK_FIELDS} } }
            }`,
            { titles: [q], first: this.perQuery },
          );
          const ws = d.searchWorks.nodes.map(annictToCandidate);
          this.cache.set("annict", q, ws);
          out.set(q, ws);
        }
        continue;
      }
      for (const q of batch) {
        this.cache.set("annict", q, works);
        out.set(q, works);
      }
      works = [];
    }
    return out;
  }

  /**
   * 作品が属するシリーズの全作品（自分を含む）。同定の検証（期の取り違えの確認）で、ほかの期を並べるのに使う。
   * シリーズに入っていない作品は空の配列
   */
  async seriesWorks(annictIds: number[]): Promise<Map<number, WorkCandidate[]>> {
    const out = new Map<number, WorkCandidate[]>();
    const todo: number[] = [];
    for (const id of new Set(annictIds)) {
      const c = this.cache.get<WorkCandidate[]>("annict_series", String(id));
      if (c) out.set(id, c);
      else todo.push(id);
    }
    for (let i = 0; i < todo.length; i += 10) {
      const batch = todo.slice(i, i + 10);
      const data = await this.gql<{
        searchWorks: { nodes: { annictId: number; seriesList: { nodes: { works: { edges: { item: AnnictWork }[] } }[] } }[] };
      }>(
        `query($ids: [Int!]) {
          searchWorks(annictIds: $ids, first: 10) {
            nodes { annictId seriesList(first: 5) { nodes { works(first: 100) { edges { item { ${SERIES_WORK_FIELDS} } } } } } }
          }
        }`,
        { ids: batch },
      );
      const got = new Map(data.searchWorks.nodes.map((n) => [n.annictId, n.seriesList.nodes.flatMap((s) => s.works.edges.map((e) => e.item))]));
      for (const id of batch) {
        const seen = new Set<number>();
        const ws = (got.get(id) ?? []).filter((w) => !seen.has(w.annictId) && seen.add(w.annictId)).map(annictToCandidate);
        this.cache.set("annict_series", String(id), ws);
        out.set(id, ws);
      }
    }
    return out;
  }

  /** 作品ごとの話（number・numberText・title）。テレビ作品で話数を紐付けるときだけ使う */
  async episodes(annictIds: number[]): Promise<Map<number, AnnictEpisode[]>> {
    const out = new Map<number, AnnictEpisode[]>();
    const todo: number[] = [];
    for (const id of new Set(annictIds)) {
      const c = this.cache.get<AnnictEpisode[]>("annict_episodes", String(id));
      if (c) out.set(id, c);
      else todo.push(id);
    }
    for (let i = 0; i < todo.length; i += 10) {
      const batch = todo.slice(i, i + 10);
      const data = await this.gql<{ searchWorks: { nodes: { annictId: number; episodes: { nodes: AnnictEpisode[] } }[] } }>(
        `query($ids: [Int!]) {
          searchWorks(annictIds: $ids, first: 10) {
            nodes { annictId episodes(first: 400, orderBy: { field: SORT_NUMBER, direction: ASC }) { nodes { number numberText title } } }
          }
        }`,
        { ids: batch },
      );
      const got = new Map(data.searchWorks.nodes.map((n) => [n.annictId, n.episodes.nodes]));
      for (const id of batch) {
        const eps = got.get(id) ?? [];
        this.cache.set("annict_episodes", String(id), eps);
        out.set(id, eps);
      }
    }
    return out;
  }
}
