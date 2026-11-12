import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";
import { normalize, templateLines } from "../detect/detect.ts";
import type { Routed } from "../resolve/routing.ts";
import { sampleOrder } from "./sample.ts";
import { loadExtractConfig } from "../resolve/config.ts";
import { streamerFrames, streamerVideos, frameContext, otherVideos, pickLinks, linkTitles, videoComments, youtubeRefs, youtubeInfo, youtubeLinks } from "./neighbors.ts";
import type { YouTubeLink, YouTubeShown } from "./neighbors.ts";

// 候補を見せない AI の判定の待ち行列（型ごとの検証 audit:sample と本番の ai:queue が使う）。
//   queue/NN.md（50件ずつ）・queue.json・GUIDE.md・thumbs/（サムネイル）・sealed/answers.json（その時点のルールの答え。判定が終わるまで開かない）・answers/（AI の答え）
// AI に見せるのは配信者・日時・タイトル・概要欄（定型文と URL で始まる行を除く。題名を見せるリンクの行は残す）・サムネイルと、判定の手がかり（src/report/neighbors.ts。
// 同じ配信者のほかの枠・同時視聴枠でない動画・リンク先の題名・YouTube のリンク先・コメント欄）だけ。型・区間・候補・ルールの答えは見せず、並びはシードで混ぜる

export const CHUNK = 50;

const SELF = /(今日|本日|今回|この配信|この枠|を見ます|を観ます|みます|見ていく|観ていく|同時視聴)/;


/**
 * 概要欄の行を AI に見せる形にする。定型文（同じ配信者の枠に繰り返し出る行）と URL で始まる行を除き、
 * その枠を指す行を先に、残りは先頭から（合わせて12行まで、1行120文字まで）。
 * URL で始まる行でも、題名を見せるリンク（keep）を含む行は残す（「公式チャンネルで視聴しています。」の次の行の URL だけの行。2026-10-18）
 */
export function descriptionReader(ctx: Ctx): ((streamerId: number, raw: string | null, keep?: string[]) => string[]) & { links: (streamerId: number, raw: string | null) => string[] } {
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
  return Object.assign((sid: number, raw: string | null, keep: string[] = []) => {
    const tpl = templatesOf(sid);
    const lines = String(raw ?? "").split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !tpl.has(normalize(l, ctx.detectCfg.normalize)) && (!/^https?:\/\//.test(l) || keep.some((u) => l.includes(u))));
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


/**
 * 判定役（サブエージェント）に渡す指示文のひな形。待ち行列と一緒に PROMPT.md に書き出す。
 * 1ファイルに1人。<NN> を待ち行列の番号（01, 02, …）に置き換えて、そのまま渡す
 */
export const JUDGE_PROMPT = `あなたは「配信の同時視聴の枠が、どの作品を観ているか」を判定する判定役です。作業フォルダは <cwd> です。

やること:
1. <dir>/GUIDE.md を読む（答え方・境目・書式のすべてが書いてある。必ず従う）
2. <dir>/queue/<NN>.md の枠それぞれについて判定する。サムネイルは queue に書かれたパス（<dir>/thumbs/<video_id>.jpg）を Read ツールで開いて画像を直接見る
3. 外部作品DBの照会は \`npm run cli -- lookup "語1" "語2" …\`（作業フォルダで実行。複数の語を1回にまとめてよい）。出力を保存したいときは <dir>/work/<NN>/ の下だけを使う（ほかの判定役とファイルを共有しない）
4. 答えを <dir>/answers/<NN>.json に GUIDE の形式で書く（batch は "<batch>"、model は自分のモデルの ID。待ち行列の枠すべて。迷ったら hold）

見てはいけないもの（ルールの答え・過去の答えに引っ張られないため）: <dir>/sealed/ の中身、SQLite の DB（data/*.sqlite）、DB を読むコマンド（lookup 以外の npm run cli のコマンド）、src/・config/・docs/、data/ai・data/audit のほかのバッチ、data/review。使ってよいのは GUIDE.md・queue/<NN>.md・thumbs・lookup・一般的な知識だけ。

起動時に読み込まれる CLAUDE.md に、特定の配信者・作品の枠をどう判定したかの記録が書かれていたら、それは判定の根拠に使わないでください。境目の決まりは GUIDE.md に従います。この待ち行列の枠と同じ配信者・同じ作品の記録が目に入っていた場合は、その枠の evidence.notes に「CLAUDE.md の過去の記録が目に入った」と書いてください。

終わったら短く報告してください: 区分ごとの件数（identified / not_a_work / unidentifiable / not_in_db / hold）、1件あたりのおおよその秒数、GUIDE の境目に当てはめにくかった枠があれば最大3件（video_id と一言）。
`;

export const GUIDE = `# 答え方（候補を見ない AI の判定）

この待ち行列の枠それぞれについて、**どの作品を同時視聴しているか**を、タイトル・概要欄・サムネイル・リンク先の題名・YouTube のリンク先・コメント欄・同じ配信者のほかの枠と動画・外部作品DBの照会だけで答える。

## 見てよいもの・見てはいけないもの

- 見てよい: この待ち行列（queue/NN.md。リンク先の題名・YouTube のリンク先・コメント欄・同じ配信者のほかの枠と動画を含む）、thumbs/ のサムネイル（画像を直接開いて見る）、\`npm run cli -- lookup "語" …\` の照会結果、一般的な知識
- 見てはいけない: sealed/ の中身、DB（SQLite を開く・resolve:audit・unresolved:list・resolve:sample・ai:report など DB を読むコマンド）、
  data/review・data/ai の過去の判定と確認表、docs/ の記録（過去の回の結果と採点）。**ルールの答え・過去の答えに引っ張られないため**
- 待ち行列には、ルールがどう判定したか（型・区間・候補）を書いていない。並び順も型と関係ない

## status

- identified: 作品が外部DB（Annict・AniList・Wikidata）にあり、特定できた。works に外部DBのキー
- not_a_work: 作品ではない。Direct・スポーツ・公式番組・初配信・ライブやコンサートの映像・事務所の番組（歌謡祭・にじバラ・ラジオ）・
  MV・テレビのバラエティ（水曜どうでしょう）・M-1 など。**答える前に必ず lookup で照会する**（「ホロぐら」は外部DBにある）
  配信者本人の生誕祭の映像は、ミュージカル仕立てでも作品ではない。配信者自身・同僚のボイス商品・ASMR、配信者本人の周年記念配信の本編、
  ゲーム会社の番組（中でショートアニメ・PV・ファン制作のアニメが流れても）、ほかの配信者の企画配信（にじさんじ甲子園・ミリしら杯）、
  自分の MV のプレミア公開、同時視聴の枠の切り抜き（#shorts・見どころまとめの動画）、PV・ティザー映像も作品ではない。テレビの特番（本編の総復習ダイジェストなど）も作品ではない（劇場総集編は作品）。
  リアリティ番組（恋愛リアリティのバチェラー・ジャパンなど）も作品ではない（テレビのバラエティと同じ）。歌の映像でできたアニメーションの作品（ALIEN STAGE）は作品。
  #shorts でもライブ配信（縦型配信）は普通の枠として作品を答える（作品ではないのは同時視聴の枠の切り抜きの動画だけ）
  テレビのドキュメンタリー（メーデー！：航空機事故の真実と真相、自然・歴史のドキュメンタリー番組。配信サービスのドキュメンタリーのシリーズも同じ）は作品ではない。
  題名が書かれていなくても、ドキュメンタリー番組を観る枠だと分かれば not_a_work。劇場公開のドキュメンタリー映画は作品（映画）。
  オーディション番組（No No Girls）も作品ではない（リアリティ番組と同じ）。同僚の周年記念のミュージカル・映像も作品ではない（生誕祭と同じ）。
  フェイクドキュメンタリー（作りものの映像作品。TXQ FICTION・フェイクドキュメンタリー「Q」・このテープもってないですか？）は作品。
  歌だけで物語を通すミュージカルのアルバムに付けた映像を通して観る枠（EPIC: The Musical）は作品（外部DBに無ければ not_in_db）
- not_in_db: 作品（映画・ドラマ・アニメ・舞台やミュージカルの映像・事務所のアニメやドラマ）だが、外部DBに無い。title に作品名。**lookup で照会してから答える**
- not_a_work には、その枠でそもそも作品を観ていないもの（開封配信の中で別の枠を予告しているだけ、など）も入れる。evidence.notes に「同時視聴枠でない」と書く
- unidentifiable: 同時視聴だが、どの作品か書かれていない・見て取れない（「映画同時視聴！」・企画名だけ）。
  **同じ題の別の作品（リメイクと旧作・アニメと実写・ドラマと映画）のどれか決まらないときも unidentifiable**（title に共通の題名、evidence.notes に候補。2026-10-19 ユーザー）
- hold: 決められない。**迷ったら hold**（埋めることが目的ではない）。ただし、リンク先の題名・YouTube のリンク先・コメント欄・同じ配信者のほかの枠と動画まで見て決められるなら決める
  （採点では、決められたはずなのに保留にしたものは誤りになる）

## リンク先の題名・YouTube のリンク先・コメント欄・同じ配信者のほかの枠と動画

- リンク先の題名: 概要欄のリンク先（Amazon Prime Video・Netflix・ABEMA・Hulu・映画.com など）のページの題名。作品を決める強い手がかり。
  「(吹替版)」「(字幕版)」は作品の違いではない。題名の取れないサイト（Disney+・U-NEXT など）のリンクは開けない
- YouTube のリンク先: 概要欄の YouTube の動画・再生リストの題名・チャンネル名・公開日（再生リストは作った日）。概要欄に同じ URL の行があれば、前後の行でそのリンクが何か確かめる
  （「公式チャンネルで視聴しています。」の次の行のリンクが公式チャンネルの本編なら、その題名で作品・版・話数が決まる）
  - 公式チャンネルの本編・予告（「【公式】アニメ『…』第1話」）、同じ作品を観ているほかの配信者の同時視聴の枠、番組（Nintendo Direct・初配信・甲子園など。作品ではない枠の手がかり）が分かる
  - 「この配信者のチャンネル」は配信者自身の同時視聴の枠・再生リスト（前回・次回の回、「同時視聴(映画コマンドー)」のような再生リスト）
  - 「取れなかった（消えたか非公開）」は今は見られない動画。題名は分からないので、再生リストの題名・概要欄の文で何のリンクか確かめる（それだけで作品を決めない）
  - 宣伝・おすすめ・ほかの配信者の別の企画へのリンクもある。この枠で観ているものを指すリンクか（概要欄の文・タイトルと合うか）を確かめてから使う
  - これで決めたら evidence.looked に youtube を入れる
- コメント欄（公開の枠だけ。メン限の枠には無い）: 視聴者のコメントの上位。タイムスタンプに話数・作品名・どの版かが書かれていることが多い
  （「46話『壁の王』」「今日観るのは TIGER & BUNNY -The Rising-」「after S1 ends」）。冗談・推測・ほかの作品の話もあるので、タイトル・サムネイルと合うかで確かめる。
  コメントで決めたら evidence.looked に comments を入れる
- 同じ作品名の枠: 同じ配信者が同じ作品名を書いた枠（日付順。「← この枠」がこの枠の位置）。シリーズを順に観ていれば、話数の続き・最終話（「（終）」「最終回」）・
  全部で何話かで、どの作品（期・リメイク）か決まることがある（同じ題の期が全24話と全26話に分かれていて、枠が第26話（終）で終わる → 全26話の期）
- 前後の枠: 時期の近い枠。観ている作品の傾向（ディズニーのアニメ映画が続く、ジュラシック・パークのシリーズを順に観ている）は手がかりにしてよい。
  傾向だけで決めたときは confidence を medium にする
- 同時視聴枠でない動画（題名だけ）: 同じ配信者の動画のうち、題名に同時視聴の語が無く同時視聴枠にならなかったもの（ゲーム・雑談・歌枠なども入る）。
  「同じ作品名の動画」はこの枠の作品名を題名に含む動画（期間を限らない）、「前後<members_days>日のメン限の動画」はこの枠がメン限のときの前後のメン限の動画。
  日付は動画を公開した日（ライブ配信は枠を作った日で、配信日と数日ずれることがある）
  - 同時視聴の続きの回が、題名に同時視聴の語を書かずに配信されていることがある。**続きの回の題名は強い手がかり**
    （「〇〇 WATCHALONG PART 1〜3」「EPISODE 7 AND 8」の枠のあとに、同じ形式のメン限の「STARTING SEASON 2」「SEASON 2 EPISODE 3 AND 4」が続けば、前の枠はシーズン1）
  - ただし、同じ作品名のゲームの実況・感想の雑談・歌ってみた・別の企画のこともある。題名の書き方（同じ形式の見出し・話数の続き）と日付の並びが、この枠と合うかで確かめる
  - これで決めたら evidence.looked に other_videos を入れる
- ほかの枠・動画の作品をこの枠の答えにはしない（この枠の作品を決める根拠にだけ使う）
- 「〇〇同時視聴４」のように作品名と回数だけで、テレビシリーズと劇場版・外伝がある作品は、前後の枠で劇場版・外伝に進んでいなければテレビシリーズにする（話数は書かない）
- タイトルに書かれた作品名を優先する（同じ章・同じ話の題を持つ別の作品があっても、タイトルに書かれた作品のほうにする）。
  同じ配信者の枠の並びから別の作品だと分かるときだけ、その根拠を evidence.notes に書いて別の作品にする（確かでなければ confidence を low に）

## works

- key: アニメは Annict（annict:ID）を先に、無ければ AniList（anilist:ID）。アニメ以外（実写・特撮・海外作品）は Wikidata（wikidata:Qxx）
- 英語のタイトルの枠（NIJISANJI EN・hololive EN など）: Annict は英題では引けないので、アニメは日本語の題名でも lookup して Annict のキーを探す。
  実写・海外作品は英題のままでも lookup の Wikipedia（英題からのリダイレクト）と Wikidata のラベルで引ける。
  **英語のタイトルの枠は無理に同定しない**（2026-10-03 ユーザー）。タイトル・リンク先・サムネイルではっきり分かるときだけ答え、
  手がかりが足りなければ hold でよい（日本語の枠のような「決められたはずの保留」の採点はしない）
- also: 同じ作品のほかのDBのキーが分かれば並べる（突き合わせで同じ作品とみなす）。範囲が違う項目（全シーズンをまとめた Wikidata の項目、配信版と劇場版を分けていない項目など）は入れない
- 作品の単位は Annict に従う。期・分割クール・劇場版・総集編・リメイクは外部DBの区切りのまま別の作品（分割クールか本当の2期かは考えなくてよい。分割クールはサイトで自動で1作品にまとめる）。
  1枠で前半と後半の作品をまたいで観ていれば（前半の作品が第13話までで、枠が後半の作品の話まで続くとき）、両方の作品をそれぞれの話数で並べる。
  期・編のどれか決められなければ hold。同じ題の別の作品（リメイクと旧作など）のどれか決められなければ unidentifiable（上の「unidentifiable」）
- **枠の日付は、まだ公開されていない作品を候補から外すのにだけ使う**。公開済みの同名の作品（リメイクと旧作など）のどれかを選ぶ根拠にはしない
  （「その時期に放送中だったから2023年版」とは決めない）。ほかに根拠がなければ unidentifiable（title に共通の題名）
- 原作（本・漫画）と映像作品を1つにまとめた Wikidata の項目でも、lookup で作品（映画・テレビ）と出るなら key に使ってよい
- 実写で、Wikidata に全体の項目とシーズン（各作）の項目の両方があれば、**全体の項目**を key にする（「イカゲーム (シーズン2)」ではなく「イカゲーム」。
  TXQ FICTION の各作品は「TXQ FICTION」）。この場合は話数を書かない（どのシーズンの話か分からないため）
- 海外のアニメのシリーズ（My Little Pony など）も、Annict に作品があれば Annict の作品を key にする（Wikidata の全体の項目は also に入れない）。
  観ているシーズンが Annict の話の番号の外でも同じ作品に付け、話数は書かない。Annict に無ければ Wikidata の全体の項目。
  **サウスパークは、シーズンが分かっても全体の項目（wikidata:Q16538）にする**（Annict はシーズンごとに作品を分けているが、まとめて見せる決まり）。話数は書かない
- 期・編で作品が分かれていて、枠には通し番号や回数しか無いとき（「〇〇 3 EP. 5-9」「〇〇 #3」）は、**どの数え方でも確かに含まれる作品だけ**を答える
  （含むかもしれない作品は evidence.notes に書く。確かに含まれる作品が1つも決まらなければ hold）
- 1枠で複数の作品を観ていれば全部並べる。そのうち外部DBに無い作品があれば、名前を "missing": ["作品名"] に並べる（status は identified のまま）
- episodes: タイトル・概要欄・サムネイルから分かる話数を、**Annict の話の番号**で書く（lookup の「話の番号: 第13話〜第24話」）。
  Annict は分割クールを別の作品にするが、話の番号は通し番号のまま（水星の魔女 Season2 は第13話〜第24話）。
  - タイトルの番号がその範囲に入れば、そのまま書く（「水星の魔女 16～18話」→ Season2 の 16,17,18）
  - 範囲より小さく、その作品の話数以内なら、期の中の番号として範囲の先頭から数え直す（「着せ恋 Season２ 9話」→ Season 2 の 21）
  - どちらとも決められなければ書かない。AniList・Wikidata の作品はタイトルの番号のまま。全シーズンを1つにまとめた Wikidata の項目には書かない（どのシーズンの話か決まらない）
  - 「11話から」のように終わりが分からなければ、確かな開始話だけを書く。分からなければ入れない。映画には入れない
  - 観ている版で番号がずれるとき（リマスター版・再編集版で話数が本放送と違う作品）は、話の題名で Annict の番号に直して書く。
    題名が分からず直せなければ話数を書かない

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
- evidence.looked: 見たもの（title / description / thumbnail / lookup / link（リンク先の題名）/ youtube（YouTube のリンク先）/ comments（コメント欄）/ same_streamer（同じ配信者のほかの枠）/
  other_videos（同時視聴枠でない動画））。not_a_work と not_in_db は lookup と queries が必須
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
  /** 同時視聴枠にならなかった同じ配信者の動画（題名だけ）: 同じ作品名の動画・前後のメン限の動画（src/report/neighbors.ts の otherVideos） */
  other_same_name: { date: string; title: string; members?: boolean }[];
  other_members: { date: string; title: string }[];
  /** 概要欄のリンク先の題名・公開年・あらすじの冒頭（題名が取れなければ title が null） */
  links: { url: string; title: string | null; year: number | null; summary: string | null }[];
  /** 概要欄の YouTube の動画・再生リストのリンク先（題名・チャンネル名・公開日。null は取れなかった。src/report/neighbors.ts の youtubeLinks） */
  youtube: YouTubeLink[];
  /** 公開の枠の YouTube のコメント（上位。メン限の枠は空） */
  comments: string[];
  /** YouTube のクォータ（ローカルの AI の判定の取り分。docs/ai-ops.md の 5）を使い切って取らなかったもの */
  skipped?: ("comments" | "youtube")[];
}


/** YouTube のリンク先の1件を待ち行列の書き方にする（「URL → 動画「題名」（チャンネル名・公開日）・再生リスト「題名」（チャンネル名・作成 日付）」） */
export function formatYouTube(y: YouTubeLink): string {
  const one = (kind: "動画" | "再生リスト", s: YouTubeShown | null) => s === null
    ? `${kind}は取れなかった（消えたか非公開）`
    : `${kind}「${s.title}」（${s.self ? "この配信者のチャンネル" : s.channel}・${kind === "再生リスト" ? "作成 " : ""}${s.date}）`;
  const parts = [...(y.video !== undefined ? [one("動画", y.video)] : []), ...(y.playlist !== undefined ? [one("再生リスト", y.playlist)] : [])];
  return `${y.url} → ${parts.join("・")}`;
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
  const videosOf = streamerVideos(ctx, cfg);
  const daysLabel = String(cfg.ai_context?.other_videos?.members_days ?? 30);
  // 概要欄の YouTube のリンクは、待ち行列の全部の枠ぶんをまとめて引く（50件ずつ1ユニット）。自分のチャンネルのものを除くのに持ち主を見る
  const ytRefs = new Map(picked.map((r) => [r.ev.video_id, (cfg.ai_context?.youtube_links ?? 3) > 0 ? youtubeRefs(desc.links(r.ev.streamer_id, r.ev.description_raw)) : []]));
  const ytAll = [...ytRefs.values()].flat();
  const units0 = ctx.quota.runUsed;
  const ytInfo = ytAll.length ? await youtubeInfo(ctx, ytAll) : null;
  if (ytAll.length) log.info(`  YouTube のリンク: ${ytRefs.size} 枠中 ${[...ytRefs.values()].filter((x) => x.length).length} 枠・${ytAll.length} 件（${ctx.quota.runUsed - units0} ユニット）`);
  const channelOf = ctx.db.prepare("SELECT channel_id FROM streamers WHERE id = ?");
  const items: BlindItem[] = [];
  let i = 0;
  for (const vid of order) {
    const r = byVid.get(vid)!;
    const thumb = await downloadThumb(ctx, r.ev.thumbnail_url, join(dir, "thumbs"), vid);
    const fc = frameContext(framesOf(r.ev.streamer_id), r.ev.id, r.ev.title_raw, cfg, r.ev.streamer);
    const ov = otherVideos(videosOf(r.ev.streamer_id), framesOf(r.ev.streamer_id),
      { startedAt: r.ev.started_at, title: r.ev.title_raw, membersOnly: !!r.ev.is_members_only }, cfg, r.ev.streamer);
    const urls = pickLinks(desc.links(r.ev.streamer_id, r.ev.description_raw), cfg);
    const titles = await linkTitles(ctx, cfg, urls);
    const channelId = (channelOf.get(r.ev.streamer_id) as { channel_id: string } | undefined)?.channel_id ?? "";
    const youtube = ytInfo ? youtubeLinks(ytRefs.get(vid) ?? [], ytInfo, channelId, cfg, ctx.detectCfg) : [];
    const lines = desc(r.ev.streamer_id, r.ev.description_raw, [...urls, ...youtube.map((y) => y.url)]);
    const comments = r.ev.is_members_only ? [] : await videoComments(ctx, cfg, vid);
    // クォータを使い切って取らなかったものは「取らなかった」と書く（無いのか取らなかったのかを判定役が分けられるように）
    const skipped: ("comments" | "youtube")[] = [];
    if (!r.ev.is_members_only && !comments.length && ctx.quota.exhausted && (cfg.ai_context?.comments ?? 0) > 0 && ctx.yt) skipped.push("comments");
    if (!ytInfo && (ytRefs.get(vid) ?? []).length && ctx.quota.exhausted) skipped.push("youtube");
    items.push({
      no: ++i, video_id: vid, streamer: r.ev.streamer, started_at: jst(r.ev.started_at), title: r.ev.title_raw,
      description_lines: lines, thumbnail: thumb ? relative(dir, thumb).replaceAll("\\", "/") : null,
      same_name: fc.sameName.map(({ date, title, self }) => ({ date, title, ...(self ? { self } : {}) })),
      around: fc.around.map(({ date, title }) => ({ date, title })),
      other_same_name: ov.sameName.map(({ date, title, members }) => ({ date, title, ...(members ? { members } : {}) })),
      other_members: ov.members.map(({ date, title }) => ({ date, title })),
      links: urls.map((url) => ({ url, title: null, year: null, summary: null, ...titles.get(url) })),
      youtube,
      comments,
      ...(skipped.length ? { skipped } : {}),
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
  writeFileSync(join(dir, "GUIDE.md"), GUIDE.replaceAll("<batch>", opts.batch).replaceAll("<members_days>", daysLabel), "utf8");
  writeFileSync(join(dir, "PROMPT.md"), [
    "# 判定役に渡す指示文",
    "",
    "待ち行列1ファイルにつきサブエージェント1人（5人ずつ並行）。下の文の <NN> を待ち行列の番号（01, 02, …）に置き換えて、そのまま渡す。",
    "この会話で CLAUDE.md を直した直後は、サブエージェントに古い CLAUDE.md が渡ることがある（会話を開き直すと新しいものが渡る）。",
    "",
    "---",
    "",
    JUDGE_PROMPT.replaceAll("<batch>", opts.batch).replaceAll("<cwd>", process.cwd()).replaceAll("<dir>", relative(process.cwd(), dir).replaceAll("\\", "/")),
  ].join("\n"), "utf8");
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
        ...(x.youtube.length ? [`- YouTube のリンク先: ${x.youtube.map(formatYouTube).join(" ／ ")}`] : []),
        ...(x.same_name.length ? [`- 同じ配信者の同じ作品名の枠: ${x.same_name.map((f) => `${f.date} ${f.title}${f.self ? "（← この枠）" : ""}`).join(" ／ ")}`] : []),
        ...(x.around.length ? [`- 同じ配信者の前後の枠: ${x.around.map((f) => `${f.date} ${f.title}`).join(" ／ ")}`] : []),
        ...(x.other_same_name.length ? [`- 同じ作品名の動画（同時視聴枠でないもの）: ${x.other_same_name.map((f) => `${f.date}${f.members ? "（メン限）" : ""} ${f.title}`).join(" ／ ")}`] : []),
        ...(x.other_members.length ? [`- 前後${daysLabel}日のメン限の動画（同時視聴枠でないもの）: ${x.other_members.map((f) => `${f.date} ${f.title}`).join(" ／ ")}`] : []),
        ...(x.comments.length ? [`- コメント欄（視聴者の上位${x.comments.length}件）: ${x.comments.join(" ／ ")}`] : []),
        ...(x.skipped?.includes("youtube") ? ["- YouTube のリンク先: 取らなかった（YouTube のクォータの都合。リンク先が無いという意味ではない）"] : []),
        ...(x.skipped?.includes("comments") ? ["- コメント欄: 取らなかった（YouTube のクォータの都合。コメントが無いという意味ではない）"] : []),
        "",
      ]),
    ];
    writeFileSync(join(dir, "queue", `${nn}.md`), md.join("\n"), "utf8");
  }
  return { items, chunks };
}
