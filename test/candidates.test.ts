import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtractConfig } from "../src/resolve/config.ts";
import type { ExtractConfig } from "../src/resolve/config.ts";
import { matchKey } from "../src/resolve/normalize.ts";
import { videoKeys, otherVideos } from "../src/report/neighbors.ts";
import type { Frame, Video } from "../src/report/neighbors.ts";
import { selectCandidates, loadCandidatesConfig, titleBody } from "../src/candidates/select.ts";
import type { Seed, StreamerInput } from "../src/candidates/select.ts";

const cfg = loadExtractConfig();
const ccfg = loadCandidatesConfig();

const video = (id: string, at: string, title: string, members: boolean): Video => ({
  id, date: at.slice(0, 10), at: Date.parse(at), title, members, key: matchKey(title, cfg), norm: title.normalize("NFKC").toLowerCase(),
});

// メン限の見出し「【ひみつのへや】」が、メン限の動画30本のうち12本に出るチャンネル（ignore_keys には無い見出し）
function channel(): { videos: Video[]; frames: Frame[]; seeds: Seed[] } {
  const videos: Video[] = [];
  for (let i = 0; i < 12; i++) videos.push(video(`h${i}`, `2024-0${1 + (i % 9)}-1${i % 10}T12:00:00Z`, `【ひみつのへや】雑談 ${i}`, true));
  for (let i = 0; i < 14; i++) videos.push(video(`m${i}`, `2023-0${1 + (i % 9)}-0${1 + (i % 9)}T12:00:00Z`, `メン限 歌枠 ${i}`, true));
  videos.push(
    video("arc4", "2025-01-10T12:00:00Z", "【ひみつのへや】ARCANE PART 4", true),
    video("s2e3", "2025-01-20T12:00:00Z", "SEASON 2 EPISODE 3 AND 4", true),
    video("pub", "2025-01-12T12:00:00Z", "ARCANE 感想会", false),
    video("vsan", "2025-02-01T12:00:00Z", "【雑談】バーチャルさんはみている 第9話！", false),
  );
  // 全動画の3%（boilerplate_ratio）には届かない本数にする（実際のチャンネルは千本前後）
  for (let i = 0; i < 500; i++) videos.push(video(`g${i}`, `2022-0${1 + (i % 9)}-0${1 + (i % 9)}T12:00:00Z`, `ゲーム実況 ${i}`, false));
  const frames: Frame[] = [
    { id: 1, date: "2025-01-01", title: "【ひみつのへや】ARCANE 同時視聴" },
    { id: 2, date: "2025-01-25", title: "【同時視聴】バーチャルさんはみている 第9話" },
  ];
  const seeds: Seed[] = [
    { id: 1, startedAt: "2025-01-01T12:00:00Z", title: frames[0]!.title, membersOnly: true },
    { id: 2, startedAt: "2025-01-25T12:00:00Z", title: frames[1]!.title, membersOnly: false },
  ];
  return { videos, frames, seeds };
}

const input = (c: ReturnType<typeof channel>): StreamerInput[] => [{ id: 1, name: "テスト配信者", ...c }];
const withoutHeading = (): ExtractConfig => {
  const c = structuredClone(cfg);
  delete c.ai_context!.other_videos!.members_heading;
  return c;
};

test("メン限の動画の決まった割合を超えて出る区間はメン限の見出しとして使わない（作品名の区間は残す）", () => {
  const c = channel();
  const keys = videoKeys(c.videos, c.frames, c.frames[0]!.title, cfg, "テスト配信者");
  assert.ok(keys.includes("arcane"));
  assert.ok(!keys.some((k) => k.includes("ヒミツノヘヤ")), keys.join(","));
  // 設定が無ければ見出しも残る（前の挙動）
  const c2 = channel();
  assert.ok(videoKeys(c2.videos, c2.frames, c2.frames[0]!.title, withoutHeading(), "テスト配信者").some((k) => k.includes("ヒミツノヘヤ")));
});

test("判定役に見せる同じ作品名の動画にも同じ決まりを使う", () => {
  const c = channel();
  const ov = otherVideos(c.videos, c.frames, { startedAt: "2025-01-01T12:00:00Z", title: c.frames[0]!.title, membersOnly: false }, cfg, "テスト配信者");
  assert.deepEqual(ov.sameName.map((v) => v.id).sort(), ["arc4", "pub"]);
});

test("3層: 作品名の区間を含むメン限・続きの語・題名の本体が同じ。公開の動画は作品名の区間だけでは候補にしない", () => {
  const got = selectCandidates(input(channel()), cfg, ccfg);
  const by = new Map(got.map((c) => [c.videoId, c.reasons]));
  assert.deepEqual(by.get("arc4"), ["same_work_members", "continuation_word"]);
  assert.deepEqual(by.get("s2e3"), ["continuation_word"]); // 作品名は無いが、メン限の種の枠の前後30日
  assert.deepEqual(by.get("vsan"), ["same_title_body"]);
  assert.ok(!by.has("pub"));
  assert.ok(![...by.keys()].some((id) => id.startsWith("h")), "見出しの区間だけで当たる動画は入れない");
  assert.equal(got.find((c) => c.videoId === "s2e3")!.hits[0]!.seed, 1);
  // 見出しの決まりが無ければ、見出しだけの動画も same_work_members に入る（2026-10-23 の214本の形）
  const loose = selectCandidates(input(channel()), withoutHeading(), ccfg);
  assert.equal(loose.filter((c) => c.videoId.startsWith("h")).length, 12);
});

test("使う層は設定で絞れる。題名の本体は【】の中身・感嘆符・空白を除く", () => {
  const got = selectCandidates(input(channel()), cfg, { ...ccfg, layers: ["same_title_body"] });
  assert.deepEqual(got.map((c) => c.videoId), ["vsan"]);
  assert.equal(titleBody("【雑談】バーチャルさんは みている！ 第9話"), "バーチャルさんはみている第9話");
});
