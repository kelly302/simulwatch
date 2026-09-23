import type { Http } from "../lib/http.ts";
import type { RosterConfig } from "../lib/config.ts";
import type { Affiliation } from "../shared/types.ts";
import { log, errorMessage } from "../lib/log.ts";

// 各事務所の公式サイトからタレント一覧を抜き出す。
// サイト改修で壊れる前提。壊れたら件数チェックで失敗扱いにし、前回の一覧を保持する。

export interface RosterEntry {
  /** 公式サイト上の識別子。例 "hololive:tokino-sora" */
  sourceKey: string;
  name: string;
  affiliation: Affiliation;
  channelId: string | null;
  handle: string | null;
  /** 卒業・活動終了など。巡回しない */
  inactive: boolean;
}

/** 既に分かっている sourceKey → channel_id。詳細ページの取得を省く */
export type KnownChannels = Map<string, string>;

const YT_LINK = /youtube\.com\/(?:channel\/(UC[\w-]{22})|@([\w.\-]+))/g;

export function parseYoutubeLinks(html: string, exclude: string[] = []): { channelId: string | null; handle: string | null } {
  for (const m of html.matchAll(YT_LINK)) {
    if (m[1] && !exclude.includes(m[1])) return { channelId: m[1], handle: null };
    if (m[2]) return { channelId: null, handle: m[2] };
  }
  return { channelId: null, handle: null };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

// ---------------------------------------------------------------- にじさんじ

interface NijiLiver {
  slug: string;
  hidden: boolean;
  name: string;
}

export async function fetchNijisanji(http: Http, cfg: RosterConfig["nijisanji"], known: KnownChannels): Promise<RosterEntry[]> {
  const res = await http.get(cfg.list_url);
  const livers = JSON.parse(res.body) as NijiLiver[];
  const out: RosterEntry[] = [];
  for (const l of livers) {
    const sourceKey = `nijisanji:${l.slug}`;
    let channelId = known.get(sourceKey) ?? null;
    let handle: string | null = null;
    if (!channelId) {
      try {
        const page = await http.get(cfg.detail_url.replace("{slug}", l.slug));
        const nd = page.body.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        const yt: string | undefined = nd ? JSON.parse(nd[1]!)?.props?.pageProps?.liverDetail?.socialLinks?.youtube : undefined;
        ({ channelId, handle } = parseYoutubeLinks(yt ?? page.body));
      } catch (e) {
        log.warn(`nijisanji detail failed ${l.slug}: ${errorMessage(e)}`);
      }
    }
    out.push({ sourceKey, name: l.name, affiliation: "nijisanji", channelId, handle, inactive: l.hidden });
  }
  return out;
}

// ---------------------------------------------------------------- ホロライブ

export function parseHololiveGroup(html: string): { slug: string; name: string }[] {
  const start = html.indexOf("talent_list");
  if (start < 0) return [];
  const list = html.slice(start);
  const out: { slug: string; name: string }[] = [];
  for (const m of list.matchAll(/talents\/([a-z0-9-]+)\/">\s*<figure>[\s\S]*?<h3>\s*([^<]*)<span>/g)) {
    out.push({ slug: m[1]!, name: decodeHtml(m[2]!) });
  }
  return out;
}

export function parseHololiveDetail(html: string, exclude: string[]): { channelId: string | null; handle: string | null } {
  // タレント本人のリンクは <ul class="t_sns"> にある。フッターには事務所の公式チャンネルがある
  const i = html.indexOf('class="t_sns');
  const block = i >= 0 ? html.slice(i, html.indexOf("</ul>", i)) : html;
  return parseYoutubeLinks(block, exclude);
}

export async function fetchHololive(http: Http, cfg: RosterConfig["hololive"], known: KnownChannels): Promise<RosterEntry[]> {
  const bySlug = new Map<string, string>();
  for (const g of cfg.groups) {
    const res = await http.get(cfg.group_url.replace("{group}", g));
    const members = parseHololiveGroup(res.body);
    if (members.length === 0) log.warn(`hololive group ${g}: メンバーを抜き出せませんでした`);
    for (const m of members) if (!bySlug.has(m.slug)) bySlug.set(m.slug, m.name);
  }
  const out: RosterEntry[] = [];
  for (const [slug, rawName] of bySlug) {
    const inactive = cfg.inactive_name_markers.some((mk) => rawName.includes(mk));
    let name = rawName;
    for (const mk of cfg.inactive_name_markers) name = name.replace(mk, "");
    name = name.trim();
    const sourceKey = `hololive:${slug}`;
    let channelId = known.get(sourceKey) ?? null;
    let handle: string | null = null;
    if (!channelId && !inactive) {
      try {
        const page = await http.get(cfg.detail_url.replace("{slug}", slug));
        ({ channelId, handle } = parseHololiveDetail(page.body, cfg.exclude_channel_ids));
      } catch (e) {
        log.warn(`hololive detail failed ${slug}: ${errorMessage(e)}`);
      }
    }
    out.push({ sourceKey, name, affiliation: "hololive", channelId, handle, inactive });
  }
  return out;
}

// ---------------------------------------------------------------- ぶいすぽっ！

export function parseVspo(html: string, japaneseClass: string): RosterEntry[] {
  const out = new Map<string, RosterEntry>();
  const re = /<li\s+class="([^"]*member__single__item[^"]*)"\s*data-id="([^"]+)"\s*data-name="([^"]+)"/g;
  const starts = [...html.matchAll(re)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i]!;
    const classes = m[1]!.split(/\s+/);
    if (!classes.includes(japaneseClass)) continue;
    const id = m[2]!.trim();
    if (out.has(id)) continue;
    const end = starts[i + 1]?.index ?? html.length;
    const block = html.slice(m.index, end);
    const snsStart = block.indexOf("member__sns");
    const { channelId, handle } = parseYoutubeLinks(snsStart >= 0 ? block.slice(snsStart) : block);
    out.set(id, {
      sourceKey: `vspo:${id}`,
      name: decodeHtml(m[3]!),
      affiliation: "vspo",
      channelId,
      handle,
      inactive: false,
    });
  }
  return [...out.values()];
}

export async function fetchVspo(http: Http, cfg: RosterConfig["vspo"]): Promise<RosterEntry[]> {
  const res = await http.get(cfg.list_url);
  return parseVspo(res.body, cfg.japanese_class);
}
