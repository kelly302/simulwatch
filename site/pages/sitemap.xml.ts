// sitemap。lastmod はページの中身が変わった日（作品ページ・配信者ページは site:data が指紋で決めた日。一覧とトップはその中の最新）
import { STREAMER_AFFS, AFF_SLUG, pageCount, site, streamerPages, tabPath, workPages, worksOfTab } from "../lib/data.ts";
import { WORK_TABS } from "../lib/encode.ts";
import { isoDateJst, streamerPath, workPath } from "../../src/shared/site.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const maxOf = (xs: (string | null)[]) => xs.reduce<string | null>((m, x) => (x && (!m || x > m) ? x : m), null);

export function GET({ site: base }: { site: URL }) {
  const entries: { path: string; lastmod: string | null }[] = [];
  const allLast = maxOf([...workPages.map((w) => w.lastmod), ...streamerPages.map((s) => s.lastmod)]) ?? site.generatedAt;
  entries.push({ path: "/", lastmod: allLast });
  for (const tab of WORK_TABS) {
    const ws = worksOfTab(tab);
    if (!ws.length) continue;
    const last = maxOf(ws.map((w) => w.lastmod));
    for (let p = 1; p <= pageCount(ws.length); p++) entries.push({ path: tabPath(tab, p), lastmod: last });
  }
  entries.push({ path: "/streamers/", lastmod: maxOf(streamerPages.map((s) => s.lastmod)) });
  for (const a of STREAMER_AFFS) {
    const ss = streamerPages.filter((s) => s.affiliation === a);
    if (ss.length) entries.push({ path: `/streamers/${AFF_SLUG[a]}/`, lastmod: maxOf(ss.map((s) => s.lastmod)) });
  }
  for (const w of workPages) entries.push({ path: workPath(w.key!), lastmod: w.lastmod });
  for (const s of streamerPages) entries.push({ path: streamerPath(s.channelId), lastmod: s.lastmod });
  entries.push({ path: "/about/", lastmod: null }, { path: "/privacy/", lastmod: null });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `<url><loc>${esc(new URL(e.path, base).href)}</loc>${e.lastmod ? `<lastmod>${isoDateJst(e.lastmod)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
