// 配信者ページの og:image（名前・所属・観た作品数と枠数）
import { streamerPages } from "../../../lib/data.ts";
import { ogPng, pngResponse } from "../../../lib/og.ts";
import { affLabel } from "../../../lib/views.ts";
import type { SiteStreamer } from "../../../../src/shared/site.ts";
import { showsNameEn } from "../../../../src/shared/site.ts";

export function getStaticPaths() {
  return streamerPages.map((s) => ({ params: { channel: s.channelId }, props: { streamer: s } }));
}

export async function GET({ props }: { props: { streamer: SiteStreamer } }) {
  const s = props.streamer;
  return pngResponse(await ogPng({
    eyebrow: affLabel(s.affiliation, s.branch),
    title: s.name,
    sub: showsNameEn(s) ? s.nameEn! : "",
    stats: `${s.worksCount}作品・${s.eventsCount}枠を同時視聴`,
  }));
}
