import type { ExtractConfig } from "./config.ts";
import type { Media, WorkCandidate } from "./types.ts";
import type { WikipediaClient } from "./sources/wikipedia.ts";
import { workMedia, labelCandidate } from "./match.ts";

// 実写のシーズンの項目を、所属するシリーズの項目に付け替える（2026-10-02 の決定 (b)）。
// 実写は Wikidata の項目の分け方（全体の項目・シーズンの項目）がそろわないので、シリーズ全体の項目にそろえる。
// 「イカゲーム (シーズン2)」→「イカゲーム」、TXQ FICTION の各作品（UFO山・魔法少女山田）→「TXQ FICTION」。
// 付け替えた作品には話数を付けない（どのシーズンの話か分からない）。名寄せ（resolve）と AI の判定（ai:apply）の両方が通る

/**
 * 候補のうち実写のシーズンの項目（liveSeasonOf がある）を、シリーズの項目の候補に付け替えた対応（元の sourceKey → シリーズの候補）。
 * シリーズの項目が作品でなければ付け替えない。extra は AI の判定でだけ受け付ける作品クラス
 */
export async function liftLiveSeasons(
  cands: WorkCandidate[], wp: WikipediaClient, cfg: ExtractConfig, extra: Record<string, Media> = {},
): Promise<Map<string, WorkCandidate>> {
  const out = new Map<string, WorkCandidate>();
  const qs = [...new Set(cands.map((c) => c.liveSeasonOf).filter((q): q is string => !!q))];
  if (qs.length === 0) return out;
  const ents = await wp.entities(qs);
  for (const c of cands) {
    if (!c.liveSeasonOf || out.has(c.sourceKey)) continue;
    const e = ents.get(c.liveSeasonOf);
    if (!e) continue;
    const media = workMedia(e, cfg) ?? e.p31.map((x) => extra[x]).find((m): m is Media => !!m) ?? null;
    if (!media) continue;
    const { liveSeasonOf: _s, ...series } = labelCandidate(e, cfg);
    out.set(c.sourceKey, { ...series, media, liftedFrom: c.sourceKey });
  }
  return out;
}
