import { XMLParser } from "fast-xml-parser";

// チャンネルRSS（Atom）。クォータを消費しない。直近15件程度しか返さない。

export interface RssEntry {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt: string | null;
  views: number | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // タイトルが数字だけの動画でも文字列のまま受け取る
  parseTagValue: false,
  htmlEntities: true,
  isArray: (name) => name === "entry",
});

function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  return String(v);
}

export function parseRss(xml: string): RssEntry[] {
  const doc = parser.parse(xml);
  const entries: unknown[] = doc?.feed?.entry ?? [];
  const out: RssEntry[] = [];
  for (const raw of entries) {
    const e = raw as Record<string, any>;
    const videoId = text(e["yt:videoId"]);
    if (!videoId) continue;
    const group = e["media:group"] ?? {};
    const views = group["media:community"]?.["media:statistics"]?.["@views"];
    out.push({
      videoId,
      channelId: text(e["yt:channelId"]),
      title: text(e["title"]),
      description: text(group["media:description"]),
      publishedAt: text(e["published"]),
      updatedAt: e["updated"] ? text(e["updated"]) : null,
      views: views === undefined ? null : Number(views),
    });
  }
  return out;
}
