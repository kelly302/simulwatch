// 作品名の検索の索引（検索欄を触ったときに読む）。並びは作品一覧の既定（配信者数の多い順）
import { sortWorks, workPages } from "../../../lib/data.ts";
import { encodeWorkRow } from "../../../lib/encode.ts";
import type { WorkSearchRow } from "../../../lib/encode.ts";

export function GET() {
  const rows: WorkSearchRow[] = sortWorks(workPages, "streamers", false).map((w) => [...encodeWorkRow(w), w.titleKana ?? ""]);
  return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
}
