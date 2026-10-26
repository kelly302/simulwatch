// トップ「すべての同時視聴」の全件の索引（絞り込み・並べ替え・300枠より先で読む）。名前は辞書（dict.json）に分ける
import { completed } from "../../../lib/data.ts";
import { encodeRow } from "../../../lib/encode.ts";

export function GET() {
  return new Response(JSON.stringify({ e: completed.map(encodeRow) }), { headers: { "Content-Type": "application/json" } });
}
