import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVideo } from "../src/crawl/classify.ts";
import type { VideoItem } from "../src/youtube/api.ts";

const LIVE_ONLY = { allowNonLive: false };
const ALLOW = { allowNonLive: true };

const base = (over: Partial<VideoItem>): VideoItem => ({
  id: "abc",
  snippet: { publishedAt: "2026-09-01T00:00:00Z", channelId: "UCx", title: "t", description: "d", liveBroadcastContent: "none" },
  status: { privacyStatus: "public" },
  ...over,
});

test("予定枠: 再生数は NULL、開始は予定時刻", () => {
  const c = classifyVideo(base({
    snippet: { publishedAt: "2026-09-01T00:00:00Z", channelId: "UCx", title: "t", description: "", liveBroadcastContent: "upcoming" },
    liveStreamingDetails: { scheduledStartTime: "2026-09-30T12:00:00Z" },
    statistics: { viewCount: "0" },
  }), ALLOW);
  assert.equal(c.kind, "event");
  if (c.kind !== "event") return;
  assert.equal(c.status, "upcoming");
  assert.equal(c.started_at, "2026-09-30T12:00:00Z");
  assert.equal(c.view_count, null);
});

test("配信中と終了後", () => {
  const live = classifyVideo(base({
    snippet: { publishedAt: "x", channelId: "UCx", title: "t", description: "", liveBroadcastContent: "live" },
    liveStreamingDetails: { scheduledStartTime: "2026-09-01T12:00:00Z", actualStartTime: "2026-09-01T12:03:00Z" },
    statistics: { viewCount: "100" },
  }), ALLOW);
  assert.equal(live.kind === "event" && live.status, "live");
  assert.equal(live.kind === "event" && live.started_at, "2026-09-01T12:03:00Z");

  const done = classifyVideo(base({
    liveStreamingDetails: { actualStartTime: "2026-09-01T12:03:00Z", actualEndTime: "2026-09-01T14:00:00Z" },
    statistics: { viewCount: "12345" },
  }), ALLOW);
  assert.equal(done.kind === "event" && done.status, "completed");
  assert.equal(done.kind === "event" && done.view_count, 12345);
});

test("再生数が取れない（メン限など）は NULL で 0 と区別する", () => {
  const c = classifyVideo(base({ liveStreamingDetails: { actualStartTime: "x", actualEndTime: "y" }, statistics: {} }), ALLOW);
  assert.equal(c.kind === "event" && c.view_count, null);
  const zero = classifyVideo(base({ liveStreamingDetails: { actualStartTime: "x" }, statistics: { viewCount: "0" } }), ALLOW);
  assert.equal(zero.kind === "event" && zero.view_count, 0);
});

test("ライブでない動画: 既定では枠として扱い、開始は公開日時で代用する", () => {
  const c = classifyVideo(base({ statistics: { viewCount: "321" } }), ALLOW);
  assert.equal(c.kind, "event");
  if (c.kind !== "event") return;
  assert.equal(c.status, "completed");
  assert.equal(c.started_at, "2026-09-01T00:00:00Z");
  assert.equal(c.started_at_source, "published_at");
  assert.equal(c.is_live, false);
  assert.equal(c.view_count, 321);
  assert.equal(classifyVideo(base({}), LIVE_ONLY).kind, "not_live");
});

test("started_at_source: 実開始 / 予定時刻", () => {
  const a = classifyVideo(base({ liveStreamingDetails: { actualStartTime: "A", scheduledStartTime: "S" } }), ALLOW);
  assert.equal(a.kind === "event" && a.started_at_source, "actual_start");
  const s = classifyVideo(base({ liveStreamingDetails: { scheduledStartTime: "S" } }), ALLOW);
  assert.equal(s.kind === "event" && s.started_at_source, "scheduled_start");
});

test("非公開の動画", () => {
  assert.equal(classifyVideo(base({ status: { privacyStatus: "unlisted" }, liveStreamingDetails: {} }), ALLOW).kind, "unavailable");
});
