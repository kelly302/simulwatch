// 作品ページの og:image（作品名・種別形式・時期・観た配信者数と枠数）
import { workPages } from "../../../lib/data.ts";
import { ogPng, pngResponse } from "../../../lib/og.ts";
import type { SiteWork } from "../../../../src/shared/site.ts";
import { metaLine } from "../../../../src/shared/site.ts";

export function getStaticPaths() {
  return workPages.map((w) => ({ params: { key: w.key! }, props: { work: w } }));
}

export async function GET({ props }: { props: { work: SiteWork } }) {
  const w = props.work;
  return pngResponse(await ogPng({ eyebrow: metaLine(w) || "作品", title: w.title, stats: `配信者${w.streamersCount}人・${w.eventsCount}枠が同時視聴` }));
}
