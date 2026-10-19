// 配信者と作品の辞書（索引と一緒に読む。所属の区分・制作国・放送年を含む）
import { completed, streamerById, workById } from "../../../lib/data.ts";
import { dictFor } from "../../../lib/encode.ts";

export function GET() {
  return new Response(JSON.stringify(dictFor(completed, streamerById, workById)), { headers: { "Content-Type": "application/json" } });
}
