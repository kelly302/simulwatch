// og:image（1200×630 の PNG）をビルド時に作る。YouTube・AniList の画像は使わず、文字だけで描く（2026-10-03 決定）。
// フォントは Noto Sans JP（OFL。@expo-google-fonts/noto-sans-jp の TTF）。ビルドのときだけ動く（Node）

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { cfg } from "./data.ts";

const FONT_DIR = join(process.cwd(), "node_modules", "@expo-google-fonts", "noto-sans-jp");
const fonts = [
  { name: "Noto Sans JP", data: readFileSync(join(FONT_DIR, "400Regular", "NotoSansJP_400Regular.ttf")), weight: 400 as const, style: "normal" as const },
  { name: "Noto Sans JP", data: readFileSync(join(FONT_DIR, "700Bold", "NotoSansJP_700Bold.ttf")), weight: 700 as const, style: "normal" as const },
];

interface El {
  type: string;
  props: { style?: Record<string, string | number>; children?: El | string | (El | string)[] };
}
const el = (type: string, style: Record<string, string | number>, children?: El["props"]["children"]): El => ({ type, props: { style, children } });

// 色はサイトと同じ（global.css の --ink・--sub・--uv・--mint・--page。2026-10-20 の「ポップ」）
const INK = "#2A2233";
const SUB = "#5E5568";
const UV = "#C81E66";
const MINT = "#8FD3FF";
const PAGE = "#FFF5FA";

export interface OgContent {
  /** 上の小さな行（種別形式・時期、所属） */
  eyebrow: string;
  /** 大きな行（作品名・配信者名） */
  title: string;
  /** 大きな行の下（英語の名前など。無ければ空） */
  sub?: string;
  /** 下の行（「配信者14人・18枠が同時視聴」） */
  stats: string;
}

/** 描き方を変えたら上げる（キャッシュの画像を使わなくなる） */
const OG_VERSION = 4;
/** 描いた画像のキャッシュ（中身が同じなら描き直さない。1枚約90ms・全部で約3分かかるため）。OG_CACHE で場所を変えられる */
const CACHE_DIR = process.env.OG_CACHE ?? join(process.cwd(), "data", "site", "og-cache");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function ogPng(c: OgContent): Promise<Uint8Array> {
  // サイトの名前も鍵に入れる（設定の名前を変えたら描き直す）
  const hash = createHash("sha1").update(JSON.stringify([OG_VERSION, cfg.site_name, c])).digest("hex");
  const cached = join(CACHE_DIR, `${hash}.png`);
  if (existsSync(cached)) return readFileSync(cached);
  const png = await render(c);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, png);
  } catch {
    // キャッシュに書けなくてもビルドは続ける
  }
  return png;
}

async function render(c: OgContent): Promise<Uint8Array> {
  const title = clip(c.title, 56);
  const size = title.length <= 12 ? 80 : title.length <= 24 ? 64 : title.length <= 40 ? 52 : 44;
  const tree = el("div", { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: PAGE, fontFamily: "Noto Sans JP", color: INK }, [
    el("div", { height: 18, background: UV, display: "flex" }),
    el("div", { flexGrow: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "48px 72px 52px" }, [
      el("div", { display: "flex", flexDirection: "column", gap: 18 }, [
        el("div", { display: "flex", fontSize: 30, fontWeight: 700, color: SUB }, clip(c.eyebrow, 40)),
        el("div", { display: "flex", fontSize: size, fontWeight: 700, lineHeight: 1.25, letterSpacing: "-0.02em" }, title),
        ...(c.sub ? [el("div", { display: "flex", fontSize: 32, fontWeight: 700, color: SUB }, clip(c.sub, 48))] : []),
      ]),
      el("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        el("div", { display: "flex", fontSize: 34, fontWeight: 700, background: UV, color: "#FFFFFF", padding: "8px 26px", borderRadius: 40 }, c.stats),
        el("div", { display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 700 }, [
          el("div", { display: "flex", width: 56, height: 50, position: "relative" }, [
            el("div", { position: "absolute", left: 0, top: 0, width: 36, height: 28, background: UV, borderRadius: 7, display: "flex" }),
            el("div", { position: "absolute", left: 18, top: 18, width: 38, height: 32, background: MINT, border: `4px solid ${INK}`, borderRadius: 8, display: "flex" }),
          ]),
          cfg.site_name,
        ]),
      ]),
    ]),
    el("div", { height: 18, background: MINT, display: "flex" }),
  ]);
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], { width: 1200, height: 630, fonts });
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
}

export function pngResponse(png: Uint8Array): Response {
  return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png" } });
}
