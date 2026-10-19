// 検索エンジン向け。JSON は robots.txt で塞がず、X-Robots-Tag: noindex で検索に載せない（_headers）
export function GET({ site }: { site: URL }) {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", site).href}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
