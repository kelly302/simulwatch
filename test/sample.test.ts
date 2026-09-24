import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleOrder, isPrefixRelated, hasMultipleSeasons } from "../src/report/sample.ts";
import type { SeriesWork } from "../src/report/sample.ts";

const w = (title: string, media: SeriesWork["media"]): SeriesWork => ({
  key: title, title, media, seasonName: null, releaseYear: null, episodesCount: null,
});

test("抽出はシードで決まり、同じシードなら同じ順になる", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(sampleOrder("s1", ids), sampleOrder("s1", [...ids].reverse()));
  assert.notDeepEqual(sampleOrder("s1", ids), sampleOrder("s2", ids));
  assert.equal(sampleOrder("s1", ids).length, ids.length);
});

test("照合キーの前方一致でほかの期を探す（同じキー・1文字のキーは除く）", () => {
  assert.equal(isPrefixRelated("葬送のフリーレン", "葬送のフリーレン第2期"), true);
  assert.equal(isPrefixRelated("葬送のフリーレン第2期", "葬送のフリーレン"), true);
  assert.equal(isPrefixRelated("葬送のフリーレン", "葬送のフリーレン"), false);
  assert.equal(isPrefixRelated("a", "air"), false);
});

test("複数期のシリーズは、テレビ・Web・OVA の作品が2つ以上あるもの", () => {
  assert.equal(hasMultipleSeasons(w("A", "tv"), [w("A 2", "tv")]), true);
  assert.equal(hasMultipleSeasons(w("A", "tv"), [w("劇場版 A", "movie")]), false);
  assert.equal(hasMultipleSeasons(w("劇場版 A", "movie"), [w("A", "tv"), w("A OVA", "ova")]), true);
});
