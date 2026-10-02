import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";
import { normalize, templateLines } from "../detect/detect.ts";
import type { Routed } from "../resolve/routing.ts";
import { sampleOrder } from "./sample.ts";
import { loadExtractConfig } from "../resolve/config.ts";
import { streamerFrames, frameContext, pickLinks, linkTitles } from "./neighbors.ts";

// 候補を見せない AI の判定の待ち行列（型ごとの検証 audit:sample と本番の ai:queue が使う）。
//   queue/NN.md（50件ずつ）・queue.json・GUIDE.md・thumbs/（サムネイル）・sealed/answers.json（その時点のルールの答え。判定が終わるまで開かない）・answers/（AI の答え）
// AI に見せるのは配信者・日時・タイトル・概要欄（定型文と URL の行を除く）・サムネイルだけ。型・区間・候補・ルールの答えは見せず、並びはシードで混ぜる

export const CHUNK = 50;

const SELF = /(今日|本日|今回|この配信|この枠|を見ます|を観ます|みます|見ていく|観ていく|同時視聴)/;


/**
 * 概要欄の行を AI に見せる形にする。定型文（同じ配信者の枠に繰り返し出る行）と URL の行を除き、
 * その枠を指す行を先に、残りは先頭から（合わせて12行まで、1行120文字まで）
 */
export function descriptionReader(ctx: Ctx): ((streamerId: number, raw: string | null) => string[]) & { links: (streamerId: number, raw: string | null) => string[] } {
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
  // リンク先の題名を取りに行く行（定型文でない行。URL だけの行も含める）
  const links = (sid: number, raw: string | null) => {
    const tpl = templatesOf(sid);
    return String(raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /https?:\/\//.test(l) && !tpl.has(normalize(l, ctx.detectCfg.normalize)));
  };
  return Object.assign((sid: number, raw: string | null) => {
    const tpl = templatesOf(sid);
    const lines = String(raw ?? "").split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !tpl.has(normalize(l, ctx.detectCfg.normalize)) && !/^https?:\/\//.test(l));
    const self = lines.filter((l) => SELF.test(l));
    return [...self, ...lines.filter((l) => !SELF.test(l))].slice(0, 12).map((l) => l.slice(0, 120));
  }, { links });
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

この待ち行列の枠それぞれについて、**どの作品を同時視聴しているか**を、タイトル・概要欄・サムネイル・リンク先の題名・同じ配信者のほかの枠と外部作品DBの照会だけで答える。

## 見てよいもの・見てはいけないもの

- 見てよい: この待ち行列（queue/NN.md。リンク先の題名・同じ配信者のほかの枠を含む）、thumbs/ のサムネイル（画像を直接開いて見る）、\`npm run cli -- lookup "語" …\` の照会結果、一般的な知識
- 見てはいけない: sealed/ の中身、DB（SQLite を開く・resolve:audit・unresolved:list・resolve:sample・ai:report など DB を読むコマンド）、
  data/review・data/ai の過去の判定と確認表。**ルールの答えに引っ張られないため**
- 待ち行列には、ルールがどう判定したか（型・区間・候補）を書いていない。並び順も型と関係ない

## status

- identified: 作品が外部DB（Annict・AniList・Wikidata）にあり、特定できた。works に外部DBのキー
- not_a_work: 作品ではない。Direct・スポーツ・公式番組・初配信・ライブやコンサートの映像・事務所の番組（歌謡祭・にじバラ・ラジオ）・
  MV・テレビのバラエティ（水曜どうでしょう）・M-1 など。**答える前に必ず lookup で照会する**（「ホロぐら」は外部DBにある）
  配信者本人の生誕祭の映像は、ミュージカル仕立てでも作品ではない。配信者自身・同僚のボイス商品・ASMR、配信者本人の周年記念配信、
  ゲーム会社の番組（中でショートアニメ・PV・ファン制作のアニメが流れても）、ほかの配信者の企画配信（にじさんじ甲子園・ミリしら杯）、
  自分の MV のプレミア公開、同時視聴の枠の切り抜き（#shorts）も作品ではない。テレビの特番（本編の総復習ダイジェストなど）も作品ではない（劇場総集編は作品）
- not_in_db: 作品（映画・ドラマ・アニメ・舞台やミュージカルの映像・事務所のアニメやドラマ）だが、外部DBに無い。title に作品名。**lookup で照会してから答える**
- not_a_work には、その枠でそもそも作品を観ていないもの（開封配信の中で別の枠を予告しているだけ、など）も入れる。evidence.notes に「同時視聴枠でない」と書く
- unidentifiable: 同時視聴だが、どの作品か書かれていない・見て取れない（「映画同時視聴！」・企画名だけ）
- hold: 決められない。**迷ったら hold**（埋めることが目的ではない）。ただし、リンク先の題名・同じ配信者のほかの枠まで見て決められるなら決める
  （採点では、決められたはずなのに保留にしたものは誤りになる）

## リンク先の題名・同じ配信者のほかの枠

- リンク先の題名: 概要欄のリンク先（Amazon Prime Video・Netflix・ABEMA・Hulu・映画.com など）のページの題名。作品を決める強い手がかり。
  「(吹替版)」「(字幕版)」は作品の違いではない。題名の取れないサイト（Disney+・U-NEXT など）のリンクは開けない
- 同じ作品名の枠: 同じ配信者が同じ作品名を書いた枠（日付順。「← この枠」がこの枠の位置）。シリーズを順に観ていれば、話数の続き・最終話（「（終）」「最終回」）・
  全部で何話かで、どの作品（期・リメイク）か決まることがある（「刃牙（バキ）」の枠が第26話（終）で終わる → 26話のバキ 最凶死刑囚編。グラップラー刃牙は24話）
- 前後の枠: 時期の近い枠。観ている作品の傾向（ディズニーのアニメ映画が続く、ジュラシック・パークのシリーズを順に観ている）は手がかりにしてよい。
  傾向だけで決めたときは confidence を medium にする
- ほかの枠の作品をこの枠の答えにはしない（この枠の作品を決める根拠にだけ使う）
- 「〇〇同時視聴４」のように作品名と回数だけで、テレビシリーズと劇場版・外伝がある作品は、前後の枠で劇場版・外伝に進んでいなければテレビシリーズにする（話数は書かない）
- タイトルに書かれた作品名を優先する（「モノノ怪 化猫」は『モノノ怪』の化猫の章。同じ章のある『怪 ～ayakashi～』にはしない）

## works

- key: アニメは Annict（annict:ID）を先に、無ければ AniList（anilist:ID）。アニメ以外（実写・特撮・海外作品）は Wikidata（wikidata:Qxx）
- 英語のタイトルの枠（NIJISANJI EN・hololive EN など）: Annict は英題では引けないので、アニメは日本語の題名でも lookup して Annict のキーを探す。
  実写・海外作品は英題のままでも lookup の Wikipedia（英題からのリダイレクト）と Wikidata のラベルで引ける。
  **英語のタイトルの枠は無理に同定しない**（2026-10-03 ユーザー）。タイトル・リンク先・サムネイルではっきり分かるときだけ答え、
  手がかりが足りなければ hold でよい（日本語の枠のような「決められたはずの保留」の採点はしない）
- also: 同じ作品のほかのDBのキーが分かれば並べる（突き合わせで同じ作品とみなす）。範囲が違う項目（全シーズンをまとめた Wikidata の項目、配信版と劇場版を分けていない項目など）は入れない
- 作品の単位は Annict に従う。期・分割クール・劇場版・総集編・リメイクは外部DBの区切りのまま別の作品（分割クールか本当の2期かは考えなくてよい）。どれか決められなければ hold
- **枠の日付は、まだ公開されていない作品を候補から外すのにだけ使う**。公開済みの同名の作品（リメイクと旧作など）のどれかを選ぶ根拠にはしない
  （「その時期に放送中だったから2023年版」とは決めない）。ほかに根拠がなければ hold
- 原作（本・漫画）と映像作品を1つにまとめた Wikidata の項目でも、lookup で作品（映画・テレビ）と出るなら key に使ってよい
- 実写で、Wikidata に全体の項目とシーズン（各作）の項目の両方があれば、**全体の項目**を key にする（「イカゲーム (シーズン2)」ではなく「イカゲーム」。
  TXQ FICTION の各作品は「TXQ FICTION」）。この場合は話数を書かない（どのシーズンの話か分からないため）
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

- not_in_db のときは "title": "作品名"、"kind": "anime" / "tokusatsu" / "live_action"、"movie": true / false を付ける
  - kind: anime はアニメーション（海外のアニメ・CG・ストップモーションを含む）、tokusatsu は日本の特撮ヒーロー（仮面ライダー・スーパー戦隊・ウルトラマンなど）、
    live_action はそれ以外（怪獣映画（ゴジラ・ガメラ）、実写と CG の合成、舞台・ミュージカルの映像を含む）
  - movie: 映画（劇場公開か配信の単発の長編）なら true。テレビ・Web のシリーズ、特番、舞台の映像は false
- confidence: high / medium / low（hold は low）
- evidence.looked: 見たもの（title / description / thumbnail / lookup / link（リンク先の題名）/ same_streamer（同じ配信者のほかの枠））。not_a_work と not_in_db は lookup と queries が必須
`;


export interface BlindItem {
  no: number;
  video_id: string;
  streamer: string;
  started_at: string;
  title: string;
  description_lines: string[];
  thumbnail: string | null;
  /** 同じ配信者の同じ作品名の枠（日付順。self がこの枠）・前後の枠（src/report/neighbors.ts） */
  same_name: { date: string; title: string; self?: boolean }[];
  around: { date: string; title: string }[];
  /** 概要欄のリンク先の題名・公開年・あらすじの冒頭（題名が取れなければ title が null） */
  links: { url: string; title: string | null; year: number | null; summary: string | null }[];
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
  const cfg = loadExtractConfig();
  const framesOf = streamerFrames(ctx);
  const items: BlindItem[] = [];
  let i = 0;
  for (const vid of order) {
    const r = byVid.get(vid)!;
    const thumb = await downloadThumb(ctx, r.ev.thumbnail_url, join(dir, "thumbs"), vid);
    const lines = desc(r.ev.streamer_id, r.ev.description_raw);
    const fc = frameContext(framesOf(r.ev.streamer_id), r.ev.id, r.ev.title_raw, cfg, r.ev.streamer);
    const urls = pickLinks(desc.links(r.ev.streamer_id, r.ev.description_raw), cfg);
    const titles = await linkTitles(ctx, cfg, urls);
    items.push({
      no: ++i, video_id: vid, streamer: r.ev.streamer, started_at: jst(r.ev.started_at), title: r.ev.title_raw,
      description_lines: lines, thumbnail: thumb ? relative(dir, thumb).replaceAll("\\", "/") : null,
      same_name: fc.sameName.map(({ date, title, self }) => ({ date, title, ...(self ? { self } : {}) })),
      around: fc.around.map(({ date, title }) => ({ date, title })),
      links: urls.map((url) => ({ url, title: null, year: null, summary: null, ...titles.get(url) })),
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
        ...(x.links.length ? [`- リンク先の題名: ${x.links.map((l) => `${l.url} →「${l.title ?? "取れなかった"}」${l.year ? `（${l.year}年）` : ""}${l.summary ? ` あらすじ: ${l.summary}` : ""}`).join(" ／ ")}`] : []),
        ...(x.same_name.length ? [`- 同じ配信者の同じ作品名の枠: ${x.same_name.map((f) => `${f.date} ${f.title}${f.self ? "（← この枠）" : ""}`).join(" ／ ")}`] : []),
        ...(x.around.length ? [`- 同じ配信者の前後の枠: ${x.around.map((f) => `${f.date} ${f.title}`).join(" ／ ")}`] : []),
        "",
      ]),
    ];
    writeFileSync(join(dir, "queue", `${nn}.md`), md.join("\n"), "utf8");
  }
  return { items, chunks };
}
