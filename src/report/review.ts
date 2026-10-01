import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 裁定・採点の HTML（ローカルで開く。ボタンとメモはブラウザに残り、md に書き出す）。audit:compare と ai:report が使う

/** 裁定・採点の HTML の1件 */
export interface ReviewItem {
  id: string; no: number; section: string; type: string; typeLabel: string;
  streamer: string; started_at: string; title: string; url: string; thumb: string | null; desc: string[];
  rule: { status: string; lines: string[]; flags: string };
  ai: { status: string; confidence: string; lines: string[]; looked: string; thumbnail: string; rationale: string };
  why: string;
}

/**
 * 裁定（audit: ルール / AI / 両方誤り / 判断できない）・採点（score: 正しい / 誤り / 判断できない）の HTML を書く。
 * ひな形は src/report/audit-review.html。押したボタンとメモはブラウザに残り、md（file）に書き出す。メン限枠の概要欄を含むので公開しない
 */
export function writeReviewHtml(path: string, data: {
  mode: "audit" | "score"; batch: string; source: string; file: string;
  sections: { key: string; label: string; required: boolean; note?: string }[]; items: ReviewItem[];
}): void {
  const tpl = readFileSync(fileURLToPath(new URL("./audit-review.html", import.meta.url)), "utf8");
  // </script> で埋め込みが切れないように < を逃がす
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = tpl.replaceAll("/*BATCH*/", data.batch).replaceAll("/*WORD*/", data.mode === "score" ? "採点" : "裁定")
    .replace("/*SAVE_PATH*/", resolve(dirname(path), data.file)).replace("/*DATA*/", () => json);
  writeFileSync(path, html, "utf8");
}

