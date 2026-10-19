// トップ「同時視聴した枠」の「さらに表示」で読む、新しい順の枠（辞書つき。索引を読まずに出せる）
import { completed, cfg, streamerById, workById } from "../../../lib/data.ts";
import { dictFor, encodeRow } from "../../../lib/encode.ts";
import type { TopRecent } from "../../../lib/encode.ts";

export function GET() {
  const evs = completed.slice(0, cfg.top.recent_json);
  const body: TopRecent = { d: dictFor(evs, streamerById, workById), e: evs.map(encodeRow) };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
