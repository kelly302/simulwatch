// サイト共通の og:image（トップ・一覧・文章のページ）
import { completed, workPages } from "../../lib/data.ts";
import { ogPng, pngResponse } from "../../lib/og.ts";

export async function GET() {
  return pngResponse(await ogPng({
    eyebrow: "にじさんじ・ホロライブ・ぶいすぽっ！",
    title: "VTuber の同時視聴（ミラー配信）を作品から探す",
    stats: `${workPages.length.toLocaleString()}作品・${completed.length.toLocaleString()}枠`,
  }));
}
