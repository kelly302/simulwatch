// サイトのビルド（Phase 3）。Astro の SSG で dist/ に書き出す。
// 入力は data/site/site-data.json（npm run cli -- site:data が DB から書き出す）。設定は config/site.yaml
import { defineConfig } from "astro/config";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

const siteCfg = parse(readFileSync(new URL("./config/site.yaml", import.meta.url), "utf8"));
const dataPath = process.env.SITE_DATA ?? fileURLToPath(new URL("./data/site/site-data.json", import.meta.url));
const ogCache = process.env.OG_CACHE ?? fileURLToPath(new URL("./data/site/og-cache", import.meta.url));
/** 作品一覧の種類のタブ（URL の名前）と works.kind */
const KIND_TABS = { anime: "anime", tokusatsu: "tokusatsu", "live-action": "live_action" };

/**
 * Cloudflare の設定ファイルを dist/ に書く
 *   _headers    JSON は検索に載せない（X-Robots-Tag: noindex。robots.txt では塞がない）
 *   _redirects  作品の公開キーが変わったときの 301（固定の転送は2,000件まで）
 */
function cloudflareFiles() {
  let buildStart = 0;
  return {
    name: "simulwatch:cloudflare-files",
    hooks: {
      "astro:build:start": () => {
        buildStart = Date.now();
      },
      "astro:build:done": ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        const data = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, "utf8")) : { works: [], redirects: [] };

        // 作品が0の種類のタブの一覧は作らない（枠0のページは 404。タブのリンクと sitemap からは外してある）。種類のタブは固定のページなので、できたあとに消す
        for (const [slug, kind] of Object.entries(KIND_TABS)) {
          if (data.works.some((w) => w.hasPage && w.kind === kind)) continue;
          rmSync(join(out, "works", slug), { recursive: true, force: true });
          rmSync(join(out, "data", "works", slug), { recursive: true, force: true });
          logger.info(`作品が0の種類のタブ /works/${slug}/ を消しました`);
        }

        // og:image のキャッシュから、このビルドで使わなかった画像を消す（使った画像は og.ts が更新日時を今にする。増える一方にしない）
        if (existsSync(ogCache)) {
          let removed = 0;
          for (const f of readdirSync(ogCache)) {
            if (!f.endsWith(".png")) continue;
            const p = join(ogCache, f);
            if (statSync(p).mtimeMs < buildStart - 1000) {
              rmSync(p, { force: true });
              removed++;
            }
          }
          if (removed) logger.info(`og:image のキャッシュから使わなかった画像 ${removed} 枚を消しました`);
        }

        writeFileSync(join(out, "_headers"), ["/data/*", "  X-Robots-Tag: noindex", ""].join("\n"));
        const redirects = data.redirects ?? [];
        // 末尾スラッシュの無い形（/works/annict-1856）も転送する。Workers の静的アセットの html_handling（wrangler.jsonc の auto-trailing-slash）は
        // ファイルがある所だけスラッシュを付け直すので（公式の表はファイルがある場合だけ）、無くなったページには効かない見込み。_redirects はファイルの有無に関係なく先に効く（公式）。
        // 実際の動きは段6 のプレビューで確かめる（docs/phase4-plan.md）
        const lines = redirects.flatMap((r) => [`${r.from} ${r.to} 301`, ...(r.from.endsWith("/") ? [`${r.from.slice(0, -1)} ${r.to} 301`] : [])]);
        if (lines.length > 2000) throw new Error(`_redirects が ${lines.length} 行で、Cloudflare の上限（2,000件）を超えます`);
        writeFileSync(join(out, "_redirects"), lines.join("\n") + (lines.length ? "\n" : ""));
        logger.info(`_headers と _redirects（${redirects.length}件・${lines.length}行）を書きました`);
      },
    },
  };
}

export default defineConfig({
  site: process.env.SITE_URL ?? siteCfg.site_url,
  srcDir: "./site",
  publicDir: "./site/public",
  outDir: "./dist",
  trailingSlash: "always",
  build: { format: "directory" },
  integrations: [cloudflareFiles()],
});
