import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";
import { normalize, templateLines } from "../detect/detect.ts";
import type { Routed } from "../resolve/routing.ts";
import { sampleOrder } from "./sample.ts";

// 候補を見せない AI の判定の待ち行列（型ごとの検証 audit:sample と本番の ai:queue が使う）。
//   queue/NN.md（50件ずつ）・queue.json・GUIDE.md・thumbs/（サムネイル）・sealed/answers.json（その時点のルールの答え。判定が終わるまで開かない）・answers/（AI の答え）
// AI に見せるのは配信者・日時・タイトル・概要欄（定型文と URL の行を除く）・サムネイルだけ。型・区間・候補・ルールの答えは見せず、並びはシードで混ぜる

export const CHUNK = 50;

const SELF = /(今日|本日|今回|この配信|この枠|を見ます|を観ます|みます|見ていく|観ていく|同時視聴)/;


/**
 * 概要欄の行を AI に見せる形にする。定型文（同じ配信者の枠に繰り返し出る行）と URL の行を除き、
 * その枠を指す行を先に、残りは先頭から（合わせて12行まで、1行120文字まで）
 */
export function descriptionReader(ctx: Ctx): (streamerId: number, raw: string | null) => string[] {
  const templates = new Map<number, Set<string>>();
  const templatesOf = (sid: number) => {
    let t = templates.get(sid);
    if (!t) {
      const ds = (ctx.db.prepare("SELECT description_raw FROM watch_events WHERE streamer_id = ?").all(sid) as { description_raw: string | null }[]).map((x) => x.description_raw);
      t = templateLines(ds, ctx.detectCfg);
      templates.set(sid, t);
    }
    return t;
  };
  return (sid, raw) => {
    const tpl = templatesOf(sid);
    const lines = String(raw ?? "").split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !tpl.has(normalize(l, ctx.detectCfg.normalize)) && !/^https?:\/\//.test(l));
    const self = lines.filter((l) => SELF.test(l));
    return [...self, ...lines.filter((l) => !SELF.test(l))].slice(0, 12).map((l) => l.slice(0, 120));
  };
}

/** サムネイルを判定のためだけにローカルへ落とす（サイトには使わない）。取れなければ null（タイトル・概要欄だけで見る） */
export async function downloadThumb(ctx: Ctx, url: string | null, dir: string, videoId: string): Promise<string | null> {
  if (!url || !/^https:\/\/i\d?\.ytimg\.com\//.test(url)) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${videoId}.jpg`);
  if (!existsSync(path)) {
    try {
      const res = await fetch(url, { headers: { "user-agent": ctx.crawlCfg.http.user_agent }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      await new Promise((ok) => setTimeout(ok, 150));
    } catch {
      // サムネイルが取れなくても判定はできる
    }
  }
  return existsSync(path) ? path : null;
}


export const GUIDE = `# 答え方（候補を見ない AI の判定）

この待ち行列の枠それぞれについて、**どの作品を同時視聴しているか**を、タイトル・概要欄・サムネイルと外部作品DBの照会だけで答える。

## 見てよいもの・見てはいけないもの

- 見てよい: この待ち行列（queue/NN.md）、thumbs/ のサムネイル（画像を直接開いて見る）、\`npm run cli -- lookup "語" …\` の照会結果、一般的な知識
- 見てはいけない: sealed/ の中身、DB（SQLite を開く・resolve:audit・unresolved:list・resolve:sample・ai:report など DB を読むコマンド）、
  data/review・data/ai の過去の判定と確認表。**ルールの答えに引っ張られないため**
- 待ち行列には、ルールがどう判定したか（型・区間・候補）を書いていない。並び順も型と関係ない

## status

- identified: 作品が外部DB（Annict・AniList・Wikidata）にあり、特定できた。works に外部DBのキー
- not_a_work: 作品ではない。Direct・スポーツ・公式番組・初配信・ライブやコンサートの映像・事務所の番組（歌謡祭・にじバラ・ラジオ）・
  MV・テレビのバラエティ（水曜どうでしょう）・M-1 など。**答える前に必ず lookup で照会する**（「ホロぐら」は外部DBにある）
  配信者本人の生誕祭の映像は、ミュージカル仕立てでも作品ではない。配信者自身・同僚のボイス商品・ASMR、配信者本人の周年記念配信、
  ゲーム会社の番組（中でショートアニメ・PV・ファン制作のアニメが流れても）、ほかの配信者の企画配信（にじさんじ甲子園・ミリしら杯）、
  自分の MV のプレミア公開、同時視聴の枠の切り抜き（#shorts）も作品ではない
- not_in_db: 作品（映画・ドラマ・アニメ・舞台やミュージカルの映像・事務所のアニメやドラマ）だが、外部DBに無い。title に作品名。**lookup で照会してから答える**
- not_a_work には、その枠でそもそも作品を観ていないもの（開封配信の中で別の枠を予告しているだけ、など）も入れる。evidence.notes に「同時視聴枠でない」と書く
- unidentifiable: 同時視聴だが、どの作品か書かれていない・見て取れない（「映画同時視聴！」・企画名だけ）
- hold: 決められない。**迷ったら hold**（埋めることが目的ではない）

## works

- key: アニメは Annict（annict:ID）を先に、無ければ AniList（anilist:ID）。アニメ以外（実写・特撮・海外作品）は Wikidata（wikidata:Qxx）
- also: 同じ作品のほかのDBのキーが分かれば並べる（突き合わせで同じ作品とみなす）。範囲が違う項目（全シーズンをまとめた Wikidata の項目、配信版と劇場版を分けていない項目など）は入れない
- 作品の単位は Annict に従う。期・分割クール・劇場版・総集編・リメイクは外部DBの区切りのまま別の作品（分割クールか本当の2期かは考えなくてよい）。どれか決められなければ hold
- **枠の日付は、まだ公開されていない作品を候補から外すのにだけ使う**。公開済みの同名の作品（リメイクと旧作など）のどれかを選ぶ根拠にはしない
  （「その時期に放送中だったから2023年版」とは決めない）。ほかに根拠がなければ hold
- 原作（本・漫画）と映像作品を1つにまとめた Wikidata の項目でも、lookup で作品（映画・テレビ）と出るなら key に使ってよい
- リンク先（Amazon・Netflix の URL）は開けないので、リンクだけが手がかりの枠は hold でよい
- 1枠で複数の作品を観ていれば全部並べる。そのうち外部DBに無い作品があれば、名前を "missing": ["作品名"] に並べる（status は identified のまま）
- episodes: タイトル・概要欄・サムネイルから分かる話数を、**Annict の話の番号**で書く（lookup の「話の番号: 第13話〜第24話」）。
  Annict は分割クールを別の作品にするが、話の番号は通し番号のまま（水星の魔女 Season2 は第13話〜第24話）。
  - タイトルの番号がその範囲に入れば、そのまま書く（「水星の魔女 16～18話」→ Season2 の 16,17,18）
  - 範囲より小さく、その作品の話数以内なら、期の中の番号として範囲の先頭から数え直す（「着せ恋 Season２ 9話」→ Season 2 の 21）
  - どちらとも決められなければ書かない。AniList・Wikidata の作品はタイトルの番号のまま。全シーズンを1つにまとめた Wikidata の項目には書かない（どのシーズンの話か決まらない）
  - 「11話から」のように終わりが分からなければ、確かな開始話だけを書く。分からなければ入れない。映画には入れない

## 1件の書き方（answers/NN.json）

\`\`\`json
{
  "batch": "<batch>", "model": "<モデルID>", "started_at": "…", "finished_at": "…",
  "answers": [
    {
      "video_id": "…",
      "status": "identified",
      "works": [{ "key": "annict:123", "also": ["wikidata:Q456"], "episodes": [3, 4] }],
      "confidence": "high",
      "evidence": { "looked": ["title", "description", "thumbnail", "lookup"], "queries": ["照会した語"], "thumbnail": "サムネイルに見えたもの" },
      "rationale": "根拠",
      "seconds": 40
    }
  ]
}
\`\`\`

- not_in_db のときは "title": "作品名" を付ける
- confidence: high / medium / low（hold は low）
- evidence.looked: 見たもの（title / description / thumbnail / lookup）。not_a_work と not_in_db は lookup と queries が必須
`;


export interface BlindItem {
  no: number;
  video_id: string;
  streamer: string;
  started_at: string;
  title: string;
  description_lines: string[];
  thumbnail: string | null;
}


function jst(t: string | null): string {
  if (!t) return "?";
  return new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

/** 待ち行列を書く。rows はシード（seed + ":queue"）で混ぜて並べる。sealed はルールの答えのファイルに足す項目 */
export async function writeBlindQueue(
  ctx: Ctx, dir: string,
  opts: { batch: string; seed: string; rows: Routed[]; sealed?: Record<string, unknown>; sealedNote: string },
): Promise<{ items: BlindItem[]; chunks: number }> {
  const picked = opts.rows;
  // 型をまたいで混ぜる
  const order = sampleOrder(`${opts.seed}:queue`, picked.map((r) => r.ev.video_id));
  const byVid = new Map(picked.map((r) => [r.ev.video_id, r]));
  mkdirSync(join(dir, "queue"), { recursive: true });
  mkdirSync(join(dir, "sealed"), { recursive: true });
  mkdirSync(join(dir, "answers"), { recursive: true });
  const desc = descriptionReader(ctx);
  const items: BlindItem[] = [];
  let i = 0;
  for (const vid of order) {
    const r = byVid.get(vid)!;
    const thumb = await downloadThumb(ctx, r.ev.thumbnail_url, join(dir, "thumbs"), vid);
    items.push({
      no: ++i, video_id: vid, streamer: r.ev.streamer, started_at: jst(r.ev.started_at), title: r.ev.title_raw,
      description_lines: desc(r.ev.streamer_id, r.ev.description_raw), thumbnail: thumb ? relative(dir, thumb).replaceAll("\\", "/") : null,
    });
    if (i % 100 === 0) log.info(`  待ち行列 ${i}/${order.length}`);
  }
  const created = nowIso();
  writeFileSync(join(dir, "sealed", "answers.json"), JSON.stringify({
    batch: opts.batch, seed: opts.seed, created_at: created, ...opts.sealed,
    answers: order.map((v) => byVid.get(v)!.rule),
  }, null, 2), "utf8");
  writeFileSync(join(dir, "sealed", "README.md"), `# 封をしたルールの答え\n\nAI の判定が終わるまで開かない（${opts.sealedNote}）。\n`, "utf8");
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ batch: opts.batch, created_at: created, items }, null, 2), "utf8");
  writeFileSync(join(dir, "GUIDE.md"), GUIDE.replaceAll("<batch>", opts.batch), "utf8");
  const chunks = Math.ceil(items.length / CHUNK);
  for (let c = 0; c < chunks; c++) {
    const nn = String(c + 1).padStart(2, "0");
    const part = items.slice(c * CHUNK, (c + 1) * CHUNK);
    const md = [
      `# 待ち行列 ${nn}/${String(chunks).padStart(2, "0")}（${opts.batch}・${part.length} 件）`, "",
      `答え方は GUIDE.md。答えは answers/${nn}.json に書く。概要欄はメン限枠の本文を含むのでローカルだけで使う。`, "",
      ...part.flatMap((x) => [
        `## ${x.no}. ${x.video_id}　${x.streamer}　${x.started_at}`,
        `- タイトル: ${x.title}`,
        `- 概要欄: ${x.description_lines.join(" ／ ") || "なし"}`,
        `- サムネイル: ${x.thumbnail ?? "なし"}`,
        "",
      ]),
    ];
    writeFileSync(join(dir, "queue", `${nn}.md`), md.join("\n"), "utf8");
  }
  return { items, chunks };
}
