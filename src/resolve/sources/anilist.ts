import type { Http } from "../../lib/http.ts";
import type { ResolveCache } from "../cache.ts";
import type { Media, WorkCandidate } from "../types.ts";

// AniList GraphQL API（アニメの補完・作品画像）。キー不要。約90回/分（混雑時30回/分）を超えない。
// 1回のリクエストに別名（a0, a1, …）で複数の検索をまとめる。
// 画像URLは参照するだけで保存しない（規約のデータ溜め込み禁止）。

const ENDPOINT = "https://graphql.anilist.co";

const MEDIA_FIELDS = `id idMal title { romaji english native } synonyms format season seasonYear episodes coverImage { large } startDate { year }`;

interface AniMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[] | null;
  format: string | null;
  season: "WINTER" | "SPRING" | "SUMMER" | "FALL" | null;
  seasonYear: number | null;
  episodes: number | null;
  coverImage: { large: string | null } | null;
  startDate: { year: number | null } | null;
}

const FORMAT: Record<string, Media | null> = {
  TV: "tv", TV_SHORT: "tv", MOVIE: "movie", OVA: "ova", SPECIAL: "ova", ONA: "web", MUSIC: null,
};

export function anilistToCandidate(m: AniMedia): WorkCandidate {
  const year = m.seasonYear ?? m.startDate?.year ?? null;
  const season = m.season === "FALL" ? "autumn" : m.season?.toLowerCase();
  return {
    source: "anilist",
    sourceKey: `anilist:${m.id}`,
    annictId: null,
    anilistId: m.id,
    wikidataId: null,
    malId: m.idMal,
    title: m.title.native ?? m.title.romaji ?? m.title.english ?? String(m.id),
    titleKana: null,
    titles: [m.title.native, m.title.romaji, m.title.english, ...(m.synonyms ?? [])].filter((x): x is string => !!x),
    media: m.format ? FORMAT[m.format] ?? null : null,
    seasonName: year ? (season ? `${year}-${season}` : String(year)) : null,
    releaseYear: year,
    episodesCount: m.episodes,
    imageUrl: m.coverImage?.large ?? null,
    seriesId: null,
  };
}

export class AniListClient {
  private readonly http: Http;
  private readonly cache: ResolveCache;
  private readonly batchSize: number;
  requests = 0;

  constructor(http: Http, cache: ResolveCache, cfg: { batch_size: number }) {
    this.http = http;
    this.cache = cache;
    this.batchSize = Math.max(1, cfg.batch_size);
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.requests++;
    const res = await this.http.postJson(ENDPOINT, { query, variables });
    const j = JSON.parse(res.body) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length && !j.data) throw new Error(`AniList GraphQL: ${j.errors.map((e) => e.message).join("; ")}`);
    return j.data as T;
  }

  /** 検索語ごとの候補（上位10件） */
  async search(queries: string[]): Promise<Map<string, WorkCandidate[]>> {
    const out = new Map<string, WorkCandidate[]>();
    const todo: string[] = [];
    for (const q of new Set(queries)) {
      const c = this.cache.get<WorkCandidate[]>("anilist", q);
      if (c) out.set(q, c);
      else todo.push(q);
    }
    for (let i = 0; i < todo.length; i += this.batchSize) {
      const batch = todo.slice(i, i + this.batchSize);
      const vars: Record<string, string> = {};
      const decl = batch.map((_, k) => `$s${k}: String`).join(", ");
      const body = batch
        .map((q, k) => {
          vars[`s${k}`] = q;
          return `a${k}: Page(perPage: 10) { media(search: $s${k}, type: ANIME) { ${MEDIA_FIELDS} } }`;
        })
        .join("\n");
      const data = await this.gql<Record<string, { media: AniMedia[] } | null>>(`query(${decl}) { ${body} }`, vars);
      batch.forEach((q, k) => {
        const ws = (data[`a${k}`]?.media ?? []).map(anilistToCandidate);
        this.cache.set("anilist", q, ws);
        out.set(q, ws);
      });
    }
    return out;
  }

  /** MyAnimeList の ID から AniList の作品（ID と画像）を引く。Annict で同定した作品の画像に使う */
  async byMalIds(malIds: number[]): Promise<Map<number, WorkCandidate>> {
    const out = new Map<number, WorkCandidate>();
    const todo: number[] = [];
    for (const id of new Set(malIds)) {
      const c = this.cache.get<WorkCandidate | null>("anilist_mal", String(id));
      if (c !== undefined) {
        if (c) out.set(id, c);
      } else todo.push(id);
    }
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const data = await this.gql<{ Page: { media: AniMedia[] } }>(
        `query($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`,
        { ids: batch },
      );
      const got = new Map(data.Page.media.filter((m) => m.idMal !== null).map((m) => [m.idMal!, anilistToCandidate(m)]));
      for (const id of batch) {
        const c = got.get(id) ?? null;
        this.cache.set("anilist_mal", String(id), c);
        if (c) out.set(id, c);
      }
    }
    return out;
  }
}
