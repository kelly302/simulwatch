// サイト共通の og:image（トップ・一覧・文章のページ）
import { completed, workPages } from "../../lib/data.ts";
import { ogPng, pngResponse } from "../../lib/og.ts";

export async function GET() {
  return pngResponse(await ogPng({
    eyebrow: "VTuber の同時視聴（ミラー配信）",
    title: "にじさんじ・ホロライブ・ぶいすぽっ！の同時視聴まとめ",
    stats: `${workPages.length.toLocaleString()}作品・${completed.length.toLocaleString()}枠`,
  }));
}
