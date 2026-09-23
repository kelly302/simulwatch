import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVideo } from "../src/crawl/classify.ts";
import type { VideoItem } from "../src/youtube/api.ts";

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
  }));
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
  }));
  assert.equal(live.kind === "event" && live.status, "live");
  assert.equal(live.kind === "event" && live.started_at, "2026-09-01T12:03:00Z");

  const done = classifyVideo(base({
    liveStreamingDetails: { actualStartTime: "2026-09-01T12:03:00Z", actualEndTime: "2026-09-01T14:00:00Z" },
    statistics: { viewCount: "12345" },
  }));
  assert.equal(done.kind === "event" && done.status, "completed");
  assert.equal(done.kind === "event" && done.view_count, 12345);
});

test("再生数が取れない（メン限など）は NULL で 0 と区別する", () => {
  const c = classifyVideo(base({ liveStreamingDetails: { actualStartTime: "x", actualEndTime: "y" }, statistics: {} }));
  assert.equal(c.kind === "event" && c.view_count, null);
  const zero = classifyVideo(base({ liveStreamingDetails: { actualStartTime: "x" }, statistics: { viewCount: "0" } }));
  assert.equal(zero.kind === "event" && zero.view_count, 0);
});

test("ライブでない動画・非公開の動画", () => {
  assert.equal(classifyVideo(base({})).kind, "not_live");
  assert.equal(classifyVideo(base({ status: { privacyStatus: "unlisted" }, liveStreamingDetails: {} })).kind, "unavailable");
});
