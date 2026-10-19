// Astro の CLI を、利用状況の送信（telemetry）を止めて動かす（npm run site:build・site:dev から呼ぶ）。
// CI では Astro が自分で止めるが、ローカルでも送らない
process.env.ASTRO_TELEMETRY_DISABLED = "1";
await import(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url).href);
