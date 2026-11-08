// 続きの回の候補の判定役の試し（D2。docs/ai-ops.md 6章の2）の待ち行列を作る。リポジトリのルートを cwd にして実行する。
//   node --env-file=.env scripts/cand-trial/build.ts gather <batch>   … 抜き取りの動画の材料を集めて sealed/context.json に置く（正解を付ける材料。判定役は開かない）
//   node --env-file=.env scripts/cand-trial/build.ts render <batch>   … 正解を付けたあとで、context.json から queue/・GUIDE.md・PROMPT.md を書く
// 入力は data/ai/<batch>/sealed/ の sample-cand-1023.json（抜き取り）と candidates-1023.json（種の枠）。
// DB の枠・判定は変えない（書くのは runs・quota_usage・resolve_cache の link_page と生レスポンスだけ。DB は作業ツリーの写しを使う）
// 待ち行列の形は cont-trial-1021（data/review/continuation-1018/scripts/build-trial.ts）に、候補にした種の枠を足したもの
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createCtx, finishCtx } from "../../src/lib/context.ts";
import { loadExtractConfig } from "../../src/resolve/config.ts";
import { bestThumbnail, chunk } from "../../src/youtube/api.ts";
import { descriptionReader, downloadThumb, formatYouTube, GUIDE } from "../../src/report/blind.ts";
import { sampleOrder } from "../../src/report/sample.ts";
import * as nb from "../../src/report/neighbors.ts";

const [mode, BATCH] = process.argv.slice(2);
if (!BATCH || !["gather", "render"].includes(mode!)) throw new Error("使い方: build.ts gather|render <batch>");
const dir = join(process.cwd(), "data", "ai", BATCH);
const sealed = join(dir, "sealed");
const FILES = 3;

type Cand = { video_id: string; sid: number; streamer: string; title: string; members: boolean; s1: { seed: number }[]; s3: { seed: number }[]; bodySeed: { seed: number }[] };
const sample = JSON.parse(readFileSync(join(sealed, "sample-cand-1023.json"), "utf8")) as Record<string, { items: { video_id: string }[] }>;
const ids = Object.values(sample).flatMap((s) => s.items.map((x) => x.video_id));
const cands = new Map((JSON.parse(readFileSync(join(sealed, "candidates-1023.json"), "utf8")) as Cand[]).map((c) => [c.video_id, c]));

const TRIAL = `# この待ち行列について（試し: まず同時視聴かどうかを答える）

この待ち行列の動画は、**まだ同時視聴枠になっていない**。題名・概要欄に同時視聴の語（同時視聴・watchalong など）が無かったので、ルールでは同時視聴枠にしていない。
同じ配信者の同時視聴枠の続きの回かもしれないし、ゲーム・雑談・歌など、同時視聴でない配信かもしれない。**まず同時視聴かどうかを答え**、同時視聴なら下の「答え方」のとおり作品を答える。
「候補にした同時視聴枠」は、この動画を待ち行列に入れるときに比べた同じ配信者の同時視聴枠（題名の作品名・見出しが似ている、日付が近い、など）。無い動画もある。
似ているというだけで、この動画が同時視聴だという意味ではない。

## watchalong（必須）

- yes: 配信者が映像（映画・ドラマ・アニメ・舞台やミュージカルの映像・テレビ番組・公式番組など）を視聴者と一緒に観る配信。
  作品ではないもの（Direct・スポーツ・ライブの映像など）を観る配信も yes（status は not_a_work）
- no: 同時視聴ではない。ゲームの実況（作品と同じ名前のゲームを含む）、雑談、歌、ASMR、作業・お絵かき、漫画・小説を読む、
  感想会・考察・解説（観ずに話すだけ）、自分のボイスドラマ・オーディオドラマ・企画、ショート動画、告知 など。status は "not_watchalong"
- unsure: 決められない。status は "hold"。**迷ったら unsure**。同時視聴でない配信を yes と答えると、観ていない作品の枠がサイトに出る。これが一番の害

## 見分ける手がかり

- 題名の作品名と回の番号（Season 2 Episode 3・第六話から・ep 77 - 85）・「観ようよ」「みてる」「finish 〇〇」など、観ていることが分かる語
- 同じ配信者の同時視聴枠との並び: 同じ見出しの形・同じ作品名・話数の続き・日付が近い（「候補にした同時視聴枠」「同じ配信者の同じ作品名の同時視聴枠」「前後の同時視聴枠」。← がこの動画の位置）
- 配信の長さ: 映画は2時間前後、アニメは1話25分前後×話数。何時間もの雑談・ゲームとは違うことが多い（長さだけでは決めない）
- 概要欄: 配信サービスのリンク・「アマプラにある」「〇〇を見ます」など
- 注意: メン限の番組名・見出し（「めんげん」「Membership Strim」「Tea Party」など）は雑談の回にも使われる。作品と同じ名前のゲームの配信も多い。
  見出しや作品名が同時視聴枠と同じというだけでは yes にしない。観ていることが題名・概要欄・サムネイル・長さで分かるときだけ yes

## この試しでの作品の答え方

- watchalong が yes のときは、下の「答え方」のとおり status と works を答える。lookup は使ってよいが、**この試しは同時視聴かどうかの判定が主**。
  作品を外部DBのキーまで決めきれなければ、status を hold にして "title" に作品名を書けばよい
- 1件の形は下の「1件の書き方」に "watchalong": "yes" / "no" / "unsure" を足したもの。no のときは "status": "not_watchalong"、works は空
- evidence.looked には、見た手がかり（title / description / thumbnail / length（配信の長さ）/ seeds（候補にした同時視聴枠）/ same_streamer / other_videos / link / youtube / comments / lookup）を入れる
`;

const PROMPT = `# 判定役に渡す指示文（${BATCH}）

待ち行列1ファイルにつきサブエージェント1人（${FILES}人を並行）。下の文の <NN> を待ち行列の番号（01〜${String(FILES).padStart(2, "0")}）に置き換えて、そのまま渡す。

---

あなたは「まだ同時視聴枠になっていない配信の動画が、同時視聴かどうか・同時視聴ならどの作品を観ているか」を判定する判定役です。作業フォルダは ${process.cwd()} です。

やること:
1. data/ai/${BATCH}/GUIDE.md を読む（先頭の「この待ち行列について」と、答え方・境目・書式のすべてが書いてある。必ず従う）
2. data/ai/${BATCH}/queue/<NN>.md の動画それぞれについて判定する。サムネイルは queue に書かれたパス（data/ai/${BATCH}/thumbs/<video_id>.jpg）を Read ツールで開いて画像を直接見る
3. 外部作品DBの照会は \`npm run cli -- lookup "語1" "語2" …\`（作業フォルダで実行。複数の語を1回にまとめてよい）。出力を保存したいときは data/ai/${BATCH}/work/<NN>/ の下だけを使う
4. 答えを data/ai/${BATCH}/answers/<NN>.json に GUIDE の形式で書く（batch は "${BATCH}"、model は自分のモデルの ID、started_at と finished_at は ISO 8601。待ち行列の動画すべて。迷ったら unsure）

見てはいけないもの（正解・過去の答えに引っ張られないため）: data/ai/${BATCH}/sealed/ の中身、data/ai/${BATCH}/queue.json、ほかの判定役の答え（answers/ のほかの番号のファイル）、
SQLite の DB（data/*.sqlite）、DB を読むコマンド（lookup 以外の npm run cli のコマンド）、src/・config/・docs/・scripts/、data/ai・data/audit のほかのバッチ、data/review、data/raw、一時フォルダ（AppData の下）、.env。
使ってよいのは GUIDE.md・queue/<NN>.md・thumbs・lookup・一般的な知識だけ。Grep・Glob・シェルでフォルダを探し回らない（開くのは上に書いたファイルだけ）。

起動時に読み込まれる CLAUDE.md に、特定の配信者・作品の枠をどう判定したかの記録が書かれていたら、それは判定の根拠に使わないでください。境目の決まりは GUIDE.md に従います。
この待ち行列の動画と同じ配信者・同じ作品の記録が目に入っていた場合は、その動画の evidence.notes に「CLAUDE.md の過去の記録が目に入った」と書いてください。

終わったら短く報告してください: watchalong ごとの件数（yes / no / unsure）、yes のうち status ごとの件数、1件あたりのおおよその秒数、迷った動画があれば最大3件（video_id と一言）。
`;

const jst = (t: string | null | undefined) => (t ? new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") : "?");
const JST = (t: string | null) => (t ? new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 10) : "?");

async function gather() {
  const ctx = createCtx("report");
  const cfg = loadExtractConfig();
  try {
    mkdirSync(join(dir, "thumbs"), { recursive: true });
    const vids = new Map<string, any>();
    for (const part of chunk(ids, 50)) for (const v of await ctx.yt!.videos(part)) vids.set(v.id, v);
    const desc = descriptionReader(ctx);
    const framesOf = nb.streamerFrames(ctx);
    const videosOf = nb.streamerVideos(ctx, cfg);
    const sidOf = ctx.db.prepare("SELECT s.id, s.name, s.channel_id FROM videos_seen v JOIN streamers s ON s.channel_id = v.channel_id WHERE v.video_id = ?");
    const seen = ctx.db.prepare("SELECT published_at, is_members_hint FROM videos_seen WHERE video_id = ?");
    const seedQ = ctx.db.prepare("SELECT id, started_at, title_raw, excluded_at FROM watch_events WHERE id = ?");
    const ytRefs = new Map<string, any[]>();
    for (const id of ids) {
      const v = vids.get(id); const s = sidOf.get(id) as any;
      ytRefs.set(id, v && s ? nb.youtubeRefs(desc.links(s.id, v.snippet?.description ?? "")) : []);
    }
    const ytAll = [...ytRefs.values()].flat();
    const ytInfo = ytAll.length ? await nb.youtubeInfo(ctx, ytAll) : null;
    const items: any[] = [];
    for (const id of ids) {
      const c = cands.get(id)!;
      const v = vids.get(id);
      const s = sidOf.get(id) as { id: number; name: string; channel_id: string };
      const vs = seen.get(id) as { published_at: string; is_members_hint: number };
      const members = vs.is_members_hint === 1;
      const lsd = v?.liveStreamingDetails;
      const start: string | null = lsd?.actualStartTime ?? lsd?.scheduledStartTime ?? v?.snippet?.publishedAt ?? vs.published_at;
      const dur = lsd?.actualStartTime && lsd?.actualEndTime ? Math.round((Date.parse(lsd.actualEndTime) - Date.parse(lsd.actualStartTime)) / 60_000) : null;
      const length = !v ? "取れなかった（非公開・削除）" : !lsd ? "ライブ配信ではない（投稿した動画）" : dur === null ? "分からない" : `${Math.floor(dur / 60)}時間${dur % 60}分（実開始〜実終了）`;
      const title: string = v?.snippet?.title ?? c.title;
      // この動画を同じ配信者の同時視聴枠の並びに置いて、同じ作品名の枠・前後の枠を出す（neighbors.ts の frameContext）
      const frames = framesOf(s.id);
      const self = { id: -1, date: JST(start), title };
      const frames2 = [...frames];
      const at = frames2.findIndex((f) => f.date > self.date);
      frames2.splice(at < 0 ? frames2.length : at, 0, self);
      const fc = nb.frameContext(frames2, -1, title, cfg, s.name);
      const ov = nb.otherVideos(videosOf(s.id).filter((x) => !(x.title === title && Math.abs(x.at - Date.parse(vs.published_at)) < 60_000)), frames,
        { startedAt: start, title, membersOnly: members }, cfg, s.name);
      // 候補にした種の枠（層は見せない。題名と日付だけ。この動画に近い順に5枠まで、日付順）
      const t0 = start ? Date.parse(start) : 0;
      const seedIds = [...new Set([...c.s1, ...c.s3, ...c.bodySeed].map((x) => x.seed))];
      const seeds = seedIds.map((sid) => seedQ.get(sid) as { id: number; started_at: string | null; title_raw: string; excluded_at: string | null } | undefined)
        .filter((r): r is NonNullable<typeof r> => !!r && !r.excluded_at)
        .sort((a, b) => Math.abs(Date.parse(a.started_at ?? "") - t0) - Math.abs(Date.parse(b.started_at ?? "") - t0)).slice(0, 5)
        .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
        .map((r) => ({ date: JST(r.started_at), title: r.title_raw }));
      const raw: string = v?.snippet?.description ?? "";
      const urls = nb.pickLinks(desc.links(s.id, raw), cfg);
      const titles = await nb.linkTitles(ctx, cfg, urls);
      const youtube = ytInfo ? nb.youtubeLinks(ytRefs.get(id) ?? [], ytInfo, s.channel_id, cfg, ctx.detectCfg) : [];
      const lines = desc(s.id, raw, [...urls, ...youtube.map((y: any) => y.url)]);
      const comments = members || !v ? [] : await nb.videoComments(ctx, cfg, id);
      const thumb = await downloadThumb(ctx, bestThumbnail(v?.snippet?.thumbnails), join(dir, "thumbs"), id);
      items.push({
        video_id: id, streamer: s.name, started_at: jst(start), members, length, title,
        description_raw: raw, description_lines: lines, thumbnail: thumb ? relative(dir, thumb).replaceAll("\\", "/") : null,
        live: v?.snippet?.liveBroadcastContent ?? null, privacy: v?.status?.privacyStatus ?? null, found: !!v,
        seeds,
        same_name: fc.sameName.map(({ date, title, self }: any) => ({ date, title, ...(self ? { self } : {}) })),
        around: fc.around.map(({ date, title }: any) => ({ date, title })),
        other_same_name: ov.sameName.map(({ date, title, members }: any) => ({ date, title, ...(members ? { members } : {}) })),
        other_members: ov.members.map(({ date, title }: any) => ({ date, title })),
        links: urls.map((url: string) => ({ url, title: null, year: null, summary: null, ...titles.get(url) })),
        youtube, comments,
      });
    }
    writeFileSync(join(sealed, "context.json"), JSON.stringify({ batch: BATCH, items }, null, 2), "utf8");
    console.log(`items ${items.length}, videos.list 取れた ${vids.size}/${ids.length}`);
  } finally {
    finishCtx(ctx);
  }
}

function render() {
  const all = JSON.parse(readFileSync(join(sealed, "context.json"), "utf8")).items as any[];
  const byId = new Map(all.map((x) => [x.video_id, x]));
  // 並びは層と関係ない順（sha1("<batch>:queue:<video_id>")）。生の概要欄は待ち行列に入れない（定型文を除いた description_lines だけ）
  const items = sampleOrder(`${BATCH}:queue`, ids).map((id, i) => {
    const { description_raw, live, privacy, found, ...rest } = byId.get(id);
    void description_raw; void live; void privacy; void found;
    return { no: i + 1, ...rest };
  });
  const per = Math.ceil(items.length / FILES);
  const parts = Array.from({ length: FILES }, (_, c) => items.slice(c * per, (c + 1) * per));
  mkdirSync(join(dir, "queue"), { recursive: true });
  mkdirSync(join(dir, "answers"), { recursive: true });
  for (let c = 0; c < FILES; c++) mkdirSync(join(dir, "work", String(c + 1).padStart(2, "0")), { recursive: true });
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ batch: BATCH, items }, null, 2), "utf8");
  parts.forEach((part, c) => {
    const nn = String(c + 1).padStart(2, "0");
    writeFileSync(join(dir, "queue", `${nn}.md`), [
      `# 待ち行列 ${nn}/${String(FILES).padStart(2, "0")}（${BATCH}・${part.length} 件）`, "",
      `答え方は GUIDE.md。答えは answers/${nn}.json に書く。概要欄はメン限の動画の本文を含むのでローカルだけで使う。`,
      "この待ち行列の動画は、まだ同時視聴枠になっていない（題名に同時視聴の語が無い）。まず同時視聴かどうかを答える。", "",
      ...part.flatMap((x: any) => [
        `## ${x.no}. ${x.video_id}　${x.streamer}　${x.started_at}`,
        `- タイトル: ${x.title}`,
        `- メン限: ${x.members ? "はい" : "いいえ"}`,
        `- 配信の長さ: ${x.length}`,
        `- 概要欄: ${x.description_lines.join(" ／ ") || "なし"}`,
        `- サムネイル: ${x.thumbnail ?? "なし"}`,
        ...(x.links.length ? [`- リンク先の題名: ${x.links.map((l: any) => `${l.url} →「${l.title ?? "取れなかった"}」${l.year ? `（${l.year}年）` : ""}${l.summary ? ` あらすじ: ${l.summary}` : ""}`).join(" ／ ")}`] : []),
        ...(x.youtube.length ? [`- YouTube のリンク先: ${x.youtube.map(formatYouTube).join(" ／ ")}`] : []),
        `- 候補にした同時視聴枠: ${x.seeds.length ? x.seeds.map((f: any) => `${f.date} ${f.title}`).join(" ／ ") : "なし"}`,
        ...(x.same_name.length ? [`- 同じ配信者の同じ作品名の同時視聴枠: ${x.same_name.map((f: any) => `${f.date} ${f.title}${f.self ? "（← この動画の位置）" : ""}`).join(" ／ ")}`] : []),
        ...(x.around.length ? [`- 同じ配信者の前後の同時視聴枠: ${x.around.map((f: any) => `${f.date} ${f.title}`).join(" ／ ")}`] : []),
        ...(x.other_same_name.length ? [`- 同じ作品名の動画（同時視聴枠でないもの）: ${x.other_same_name.map((f: any) => `${f.date}${f.members ? "（メン限）" : ""} ${f.title}`).join(" ／ ")}`] : []),
        ...(x.other_members.length ? [`- 前後30日のメン限の動画（同時視聴枠でないもの）: ${x.other_members.map((f: any) => `${f.date} ${f.title}`).join(" ／ ")}`] : []),
        ...(x.comments.length ? [`- コメント欄（視聴者の上位${x.comments.length}件）: ${x.comments.join(" ／ ")}`] : []),
        "",
      ]),
    ].join("\n"), "utf8");
  });
  // GUIDE: 試しの節を先頭に足す。本番の GUIDE の続きの回の例（SEASON 2 の続き）は抜き取りの動画の形そのものなので、cont-trial-1021 と同じ中立の例に置き換える
  const base = GUIDE.replaceAll("<batch>", BATCH).replaceAll("<members_days>", "30")
    .replace(/（「〇〇 WATCHALONG PART 1〜3」[^）]*）/, "（「〇〇 WATCHALONG PART 1・2」の枠のあとに、同じ見出しのメン限の「〇〇 PART 3」「〇〇 FINALE」が続けば、それも同じ作品の続きの回）");
  if (base.includes("STARTING SEASON 2")) throw new Error("GUIDE に続きの回の例が残っている");
  writeFileSync(join(dir, "GUIDE.md"), TRIAL + "\n" + base, "utf8");
  writeFileSync(join(dir, "PROMPT.md"), PROMPT, "utf8");
  console.log(`items ${items.length}, files ${parts.map((p) => p.length).join("/")}`);
}

if (mode === "gather") await gather();
else render();
