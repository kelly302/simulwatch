// サイトのビルド（Phase 3）。Astro の SSG で dist/ に書き出す。
// 入力は data/site/site-data.json（npm run cli -- site:data が DB から書き出す）。設定は config/site.yaml
import { defineConfig } from "astro/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

const siteCfg = parse(readFileSync(new URL("./config/site.yaml", import.meta.url), "utf8"));
const dataPath = process.env.SITE_DATA ?? fileURLToPath(new URL("./data/site/site-data.json", import.meta.url));

/**
 * Cloudflare の設定ファイルを dist/ に書く
 *   _headers    JSON は検索に載せない（X-Robots-Tag: noindex。robots.txt では塞がない）
 *   _redirects  作品の公開キーが変わったときの 301（固定の転送は2,000件まで）
 */
function cloudflareFiles() {
  return {
    name: "simulwatch:cloudflare-files",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        writeFileSync(join(out, "_headers"), ["/data/*", "  X-Robots-Tag: noindex", ""].join("\n"));
        const redirects = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, "utf8")).redirects ?? [] : [];
        // 末尾スラッシュの無い形（/works/annict-1856）も転送する（無くなったページには Pages のスラッシュの付け直しが効かないため）
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
