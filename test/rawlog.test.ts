import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { RawLog, sanitizeUrl } from "../src/lib/rawlog.ts";

test("生レスポンス: 大きくても分割して追記し、1本の gzip として読める", () => {
  const dir = mkdtempSync(join(tmpdir(), "rawlog-"));
  try {
    const log = new RawLog("2026-09-23T00-00-00-000Z-test", dir);
    const body = "x".repeat(1024 * 1024); // 1MB × 40 = 16MB の閾値を2回またぐ
    for (let i = 0; i < 40; i++) log.add({ at: "t", method: "GET", url: `https://example.com/${i}?key=SECRET`, status: 200, ms: 1, body });
    const path = log.flush();
    assert.ok(path);
    const lines = gunzipSync(readFileSync(path!)).toString().trim().split("\n");
    assert.equal(lines.length, 40);
    assert.equal(JSON.parse(lines[39]!).url, "https://example.com/39?key=REDACTED");
    assert.equal(log.size, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生レスポンス: 1件もなければファイルを作らない", () => {
  const dir = mkdtempSync(join(tmpdir(), "rawlog-"));
  try {
    assert.equal(new RawLog("2026-09-23T00-00-00-000Z-empty", dir).flush(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("URL の API キーを伏せる", () => {
  assert.equal(sanitizeUrl("https://www.googleapis.com/youtube/v3/videos?id=a&key=DUMMY_KEY"), "https://www.googleapis.com/youtube/v3/videos?id=a&key=REDACTED");
});
