import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRss } from "../src/youtube/rss.ts";
import { parseHololiveGroup, parseHololiveDetail, parseVspo, parseYoutubeLinks } from "../src/roster/sources.ts";

test("RSS: 動画ID・タイトル・概要欄・再生数を取り出す", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <entry>
  <id>yt:video:AAAAAAAAAAA</id>
  <yt:videoId>AAAAAAAAAAA</yt:videoId>
  <yt:channelId>UCxxxxxxxxxxxxxxxxxxxxxx</yt:channelId>
  <title>【同時視聴】劇場版 &amp; 特別編</title>
  <published>2026-09-23T11:20:03+00:00</published>
  <updated>2026-09-23T11:25:00+00:00</updated>
  <media:group>
   <media:title>x</media:title>
   <media:description>1行目
2行目</media:description>
   <media:community><media:statistics views="1234"/></media:community>
  </media:group>
 </entry>
 <entry>
  <yt:videoId>BBBBBBBBBBB</yt:videoId>
  <yt:channelId>UCxxxxxxxxxxxxxxxxxxxxxx</yt:channelId>
  <title>12345</title>
  <published>2026-09-22T00:00:00+00:00</published>
  <media:group><media:description></media:description><media:community><media:statistics views="0"/></media:community></media:group>
 </entry>
</feed>`;
  const es = parseRss(xml);
  assert.equal(es.length, 2);
  assert.equal(es[0]!.title, "【同時視聴】劇場版 & 特別編");
  assert.equal(es[0]!.description, "1行目\n2行目");
  assert.equal(es[0]!.views, 1234);
  assert.equal(es[1]!.title, "12345");
});

test("YouTube リンク: チャンネルIDと @handle、除外リスト", () => {
  assert.deepEqual(parseYoutubeLinks('<a href="https://www.youtube.com/channel/UC0TXe_LYZ4scaW2XMyi5_kw?sub_confirmation=1">'), { channelId: "UC0TXe_LYZ4scaW2XMyi5_kw", handle: null });
  assert.deepEqual(parseYoutubeLinks('<a href="https://www.youtube.com/@Chise_Tatsumaki">'), { channelId: null, handle: "Chise_Tatsumaki" });
  assert.deepEqual(
    parseYoutubeLinks('youtube.com/channel/UCJFZiqLMntJufDCHc6bQixg youtube.com/channel/UC0TXe_LYZ4scaW2XMyi5_kw', ["UCJFZiqLMntJufDCHc6bQixg"]),
    { channelId: "UC0TXe_LYZ4scaW2XMyi5_kw", handle: null },
  );
});

test("ホロライブ: グループページと詳細ページ", () => {
  const group = `<ul class="talent_list clearfix">
<li><a href="https://hololive.hololivepro.com/talents/tokino-sora/">
<figure><img src="x.png" /></figure>
<h3>
ときのそら<span>Tokino Sora</span>
</h3></a></li>
<li><a href="https://hololive.hololivepro.com/talents/minato-aqua/">
<figure><img src="y.png" /></figure>
<h3>
【卒業生】 湊あくあ<span>Minato Aqua</span>
</h3></a></li></ul>`;
  assert.deepEqual(parseHololiveGroup(group), [
    { slug: "tokino-sora", name: "ときのそら" },
    { slug: "minato-aqua", name: "【卒業生】 湊あくあ" },
  ]);
  const detail = `<ul class="t_sns clearfix"><li><a href="https://www.youtube.com/channel/UCp6993wxpyDPHUpavwDFqgg"></a></li></ul>
<ul class="foot_sns"><li><a href="https://www.youtube.com/channel/UCJFZiqLMntJufDCHc6bQixg"></a></li></ul>`;
  assert.equal(parseHololiveDetail(detail, ["UCJFZiqLMntJufDCHc6bQixg"]).channelId, "UCp6993wxpyDPHUpavwDFqgg");
});

test("VSPO!: 日本の所属だけ、重複を除いて取る", () => {
  const html = `
<li class="swiper-slide member__single__item --chise --japanese" data-id="chise" data-name="龍巻ちせ" data-color="#fff">
  <ul class="member__sns"><li><a href="https://x.com/chise"></a></li><li><a href="https://www.youtube.com/@Chise_Tatsumaki"></a></li></ul>
</li>
<li class="swiper-slide member__single__item --uruha --japanese" data-id="uruha" data-name="一ノ瀬 うるは" data-color="#fff">
  <ul class="member__sns"><li><a href="https://www.youtube.com/channel/UC5LyYg6cCA4yHEYvtUsir3g"></a></li></ul>
</li>
<li class="swiper-slide member__single__item --eris  --english" data-id="eris " data-name="涼上エリス" data-color="#fff">
  <ul class="member__sns"><li><a href="https://www.youtube.com/@ErisSuzukami"></a></li></ul>
</li>
<li class="swiper-slide member__single__item --chise --japanese" data-id="chise" data-name="龍巻ちせ" data-color="#fff"></li>`;
  const r = parseVspo(html, "--japanese");
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((e) => [e.sourceKey, e.name, e.channelId, e.handle]), [
    ["vspo:chise", "龍巻ちせ", null, "Chise_Tatsumaki"],
    ["vspo:uruha", "一ノ瀬 うるは", "UC5LyYg6cCA4yHEYvtUsir3g", null],
  ]);
});

test("共用チャンネル（複数タレントが同じ handle / channel_id）は登録しない", async () => {
  const { markSharedChannels } = await import("../src/roster/sync.ts");
  const e = (key: string, handle: string | null, channelId: string | null = null) =>
    ({ sourceKey: key, name: key, affiliation: "hololive" as const, channelId, handle, inactive: false, branch: "jp" as const });
  const entries = [e("a", "holoANroom"), e("b", "HoloANroom"), e("c", "solo"), e("d", null, "UCdddddddddddddddddddddd")];
  const shared = markSharedChannels(entries);
  assert.deepEqual(shared, { "@holoanroom": ["a", "b"] });
  assert.deepEqual(entries.map((x) => x.handle ?? x.channelId), [null, null, "solo", "UCdddddddddddddddddddddd"]);
});

test("にじさんじの区分: プロフィールの項目名が韓国語・インドネシア語なら旧 KR・旧 ID、ほかは日本", async () => {
  const { nijisanjiBranch } = await import("../src/roster/sources.ts");
  const markers = { kr: ["생일", "팬클럽 이름"], id: ["Ulang Tahun", "Nama Fans"] };
  const l = (names: string[]) => ({ slug: "x", hidden: false, name: "x", profile: { profileItems: names.map((name) => ({ name })) } });
  assert.equal(nijisanjiBranch(l(["誕生日", "ファンネーム"]), markers), "jp");
  assert.equal(nijisanjiBranch(l(["생일", "팬클럽 이름"]), markers), "kr");
  assert.equal(nijisanjiBranch(l(["Ulang Tahun", "Nama Fans"]), markers), "id");
  assert.equal(nijisanjiBranch({ slug: "x", hidden: false, name: "x" }, markers), "jp");
});
