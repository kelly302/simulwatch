// 同定の型（ゲート2の決定）。同定の経路と危なさで枠を1つの型に分ける。
//
//   型ごとに抽出して AI の答えと突き合わせ、1件でも誤りが見つかった型はルールで決めずに AI に回す。
//   1枠は1つの型だけに入る（下の ROUTE_ORDER の先に当たったもの）。危なさの目印（flags）は重なって付くので、
//   どの目印の枠がどの型に入ったかは、型分けの一覧（audit:types）の重なりの表で見る。
//
//   ここは純粋関数だけ。枠ごとの事実（段・曖昧さ回避・ほかの期の作品名）は report/audit.ts が DB と照会キャッシュから集める。

export type RouteType =
  | "series"
  | "multi"
  | "tiebreak"
  | "season_variant"
  | "sub_desc_tag"
  | "search"
  | "label"
  | "disambiguation"
  | "prefix_sibling"
  | "suffix"
  | "redirect"
  | "live_action_tv"
  | "unique_exact"
  | "other_identified"
  | "not_a_work_conflict"
  | "not_a_work_rule"
  | "unidentifiable_rule"
  | "ai_identified"
  | "ai_not_a_work"
  | "ai_unidentifiable"
  | "unresolved";

export interface RouteInfo {
  label: string;
  /** 一次の抽出件数。0 はこの抽出では測らない（理由は note） */
  sample: number;
  note?: string;
}

export const ROUTES: Record<RouteType, RouteInfo> = {
  series: { label: "視聴系列の推定（series:*）", sample: 50 },
  multi: { label: "1枠に複数作品", sample: 50 },
  tiebreak: { label: "同名の作品から手がかりで選んだもの（exact+date・+year・+episodes・+counter・+anime・+live・+bilingual・label+movie）", sample: 50 },
  season_variant: { label: "期の表記で作り直した作品名で当てたもの（exact+season）", sample: 50 },
  sub_desc_tag: { label: "小区間・概要欄・ハッシュタグで当てたもの", sample: 50 },
  search: { label: "Wikipedia の全文検索", sample: 50 },
  label: { label: "Wikidata のラベル", sample: 50 },
  disambiguation: { label: "区間と同名の曖昧さ回避ページがある", sample: 50 },
  prefix_sibling: { label: "区間の名前が、ほかの期・劇場版などの作品名の頭と同じ", sample: 50 },
  suffix: { label: "Wikipedia の接尾辞付きの記事（「区間 (映画)」など）", sample: 50 },
  redirect: { label: "Wikipedia のリダイレクト（記事名の別名）", sample: 50 },
  live_action_tv: {
    label: "Wikidata の実写のテレビ作品（アニメ以外。ドラマとバラエティを Wikidata の分類で分けられない）", sample: 0,
    note: "audit-1 で誤り（水曜どうでしょう）が出たので AI に回す（2026-10-01、名前が一意の完全一致から切り出した）",
  },
  unique_exact: { label: "名前が一意の完全一致（上のどれにも当たらない）", sample: 100 },
  other_identified: { label: "同定済みでどの型にも入らないもの（型分けの漏れ）", sample: 50 },
  not_a_work_conflict: {
    label: "作品ではない語に当たったが、区間が外部DBの作品にも当たる枠（「少林サッカー」の「サッカー」）", sample: 0,
    note: "ルールでは決めず AI に回す（2026-10-01。作品ではないの誤りはすべてこの形だった）",
  },
  not_a_work_rule: { label: "作品ではない（ルールの語彙）。語の種類（config/extract.yaml の not_a_work のコメント）ごとに分けて測る", sample: 50 },
  unidentifiable_rule: { label: "作品を特定できない（ルール）", sample: 50 },
  ai_identified: { label: "AI の同定（確定）", sample: 0, note: "ai-trial-1 のユーザーの採点で測る（盲検の AI にもう一度答えさせても、AI どうしの一致しか分からない）" },
  ai_not_a_work: { label: "作品ではない（AI・確定）", sample: 0, note: "同上。ai-trial-1 の採点で測る" },
  ai_unidentifiable: { label: "作品を特定できない（AI・確定）", sample: 0, note: "同上" },
  unresolved: { label: "未同定（照会でヒットしない・候補が複数・切り出せない・照会エラー）", sample: 0, note: "サイトに作品として出ない。AI の判定の対象（ai:queue）で、ここでは測らない" },
};

/** 型を決める順（先に当たったものに入る） */
export const ROUTE_ORDER: RouteType[] = [
  "series", "multi", "tiebreak", "season_variant", "sub_desc_tag", "search", "label",
  "disambiguation", "prefix_sibling", "suffix", "redirect", "live_action_tv", "unique_exact",
];

/** 同定に使った区間がどの段から来たか（resolve.ts の段。sub は小区間） */
export type SegmentFrom = "quote" | "title" | "sub" | "description" | "hashtag" | "unknown";

export interface RouteWork {
  /** EventWork の match_method（annict:exact / wikipedia:suffix / series:marker / annict:exact+season など） */
  method: string;
  from: SegmentFrom;
}

export interface RouteFacts {
  /** 取り消されていない確定の AI の判定（hold は確定ではないので入れない） */
  ai: "identified" | "not_a_work" | "unidentifiable" | null;
  /** 付いた作品（作品ごとに1つ。話数で行が分かれていてもまとめる） */
  works: RouteWork[];
  /** 未同定の理由（同定済みなら null） */
  unresolvedReason: string | null;
  /** 区間の Wikipedia の記事が曖昧さ回避ページか、「区間 (曖昧さ回避)」の記事がある */
  disambiguation: boolean;
  /** 区間の照合キーで始まる、ほかの作品名（枠の時点で公開済みのもの） */
  prefixSiblings: string[];
  /** 作品ではない語に当たったが、区間が外部DBの作品にも当たった（resolve の detail.work_conflicts） */
  notAWorkConflict?: boolean;
  /** 付いた作品に、Wikidata だけで引いた実写のテレビ作品（アニメ以外）がある */
  liveActionTv?: boolean;
}

/** 危なさの目印。1枠に重なって付く（型は ROUTE_ORDER の先のもの1つ） */
export function routeFlags(f: RouteFacts): RouteType[] {
  const out = new Set<RouteType>();
  if (f.works.length === 0) return [];
  const methods = f.works.map((w) => w.method);
  const base = (m: string) => m.replace(/\+.*$/, "");
  const tie = (m: string) => (m.includes("+") ? m.slice(m.indexOf("+") + 1) : "");
  if (methods.some((m) => m.startsWith("series:"))) out.add("series");
  if (f.works.length > 1) out.add("multi");
  if (methods.some((m) => tie(m) && tie(m) !== "season")) out.add("tiebreak");
  if (methods.some((m) => tie(m) === "season")) out.add("season_variant");
  if (f.works.some((w) => w.from === "sub" || w.from === "description" || w.from === "hashtag")) out.add("sub_desc_tag");
  if (methods.some((m) => base(m) === "wikipedia:search")) out.add("search");
  if (methods.some((m) => base(m).startsWith("wikidata:label"))) out.add("label");
  if (f.disambiguation) out.add("disambiguation");
  if (f.prefixSiblings.length) out.add("prefix_sibling");
  if (methods.some((m) => base(m) === "wikipedia:suffix")) out.add("suffix");
  if (methods.some((m) => base(m) === "wikipedia:redirect")) out.add("redirect");
  if (f.liveActionTv) out.add("live_action_tv");
  return ROUTE_ORDER.filter((t) => out.has(t));
}

const UNIQUE_METHODS = new Set(["annict:exact", "anilist:exact", "wikipedia:exact"]);

/** 枠の型 */
export function classifyRoute(f: RouteFacts): RouteType {
  if (f.ai === "identified") return "ai_identified";
  if (f.ai === "not_a_work") return "ai_not_a_work";
  if (f.ai === "unidentifiable") return "ai_unidentifiable";
  if (f.works.length === 0) {
    if (f.unresolvedReason === "not_a_work") return f.notAWorkConflict ? "not_a_work_conflict" : "not_a_work_rule";
    if (f.unresolvedReason === "unidentifiable") return "unidentifiable_rule";
    return "unresolved";
  }
  const flags = routeFlags(f);
  if (flags.length) return flags[0]!;
  // 目印が無く、括弧の中身か括弧の外の区間が、照会先の作品名と完全一致したもの
  const w = f.works[0]!;
  if (UNIQUE_METHODS.has(w.method) && (w.from === "quote" || w.from === "title")) return "unique_exact";
  return "other_identified";
}

/**
 * 作品ではない語の種類。config/extract.yaml の not_a_work の中のコメント行（「  # スポーツ」）を種類の見出しとし、
 * その下の語をその種類にする（語 → 種類）。種類は設定ファイルに先に書いてあった区切りをそのまま使う
 */
export function notAWorkGroups(yamlText: string, terms: string[]): Map<string, string> {
  // 語の並びごとの見出しを行から数え、語そのものは読み込み済みの設定（terms。YAML として解釈した値）から取る
  const groups: string[] = [];
  let inBlock = false;
  let group = "（見出しなし）";
  for (const line of yamlText.split(/\r?\n/)) {
    if (/^not_a_work:\s*$/.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^\S/.test(line)) break;
    const head = line.match(/^\s{2}#\s*(.+?)\s*$/);
    if (head) { group = head[1]!.replace(/（.*?）/g, "").trim(); continue; }
    if (/^\s{2}-\s/.test(line)) groups.push(group);
  }
  if (groups.length !== terms.length) throw new Error(`not_a_work の語の数（${terms.length}）と行の数（${groups.length}）が合わない`);
  return new Map(terms.map((t, i) => [t, groups[i]!]));
}

/** 抽出の層（型。作品ではないの型は語の種類まで） */
export function stratumOf(r: { type: RouteType; sub?: string | null }): string {
  return r.sub ? `${r.type}:${r.sub}` : r.type;
}

/** n 件抽出して誤りが0件だったときの、誤りの割合の95%上限（1 - 0.05^(1/n)） */
export function zeroErrorUpper95(n: number): number {
  return n > 0 ? 1 - Math.pow(0.05, 1 / n) : 1;
}

/** 枠が AI に回す型か（config/extract.yaml の ai_routes。型か層（not_a_work_rule:スポーツ）で書く） */
export function needsAi(r: { type: string; sub?: string | null }, aiRoutes: string[]): boolean {
  return aiRoutes.includes(r.type) || aiRoutes.includes(stratumOf(r as { type: RouteType; sub?: string | null }));
}

/**
 * サイトでの出し方（2026-10-01 の決定 (a)。AI に回す型の枠は AI が確かめるまで出さない）
 *   work       作品を付けて出す
 *   frame      作品を付けずに枠として出す（作品だが外部DBに無い・作品を特定できない・確度 low の同定）
 *   hidden     出さない（作品ではない）
 *   pending_ai AI の判定待ち（出さない。AI が保留にした枠もここ）
 */
export type PublishState = "work" | "frame" | "hidden" | "pending_ai";

export function publishState(
  p: {
    type: string | null;
    sub: string | null;
    /** 取り消されていない AI の判定（hold を含む） */
    ai: { status: string; confidence: string } | null;
    hasWorks: boolean;
    unresolvedReason: string | null;
  },
  aiRoutes: string[],
): PublishState {
  if (p.ai && p.ai.status !== "hold") {
    if (p.ai.status === "identified") return p.ai.confidence === "low" ? "frame" : "work";
    if (p.ai.status === "not_a_work") return "hidden";
    return "frame"; // not_in_db・unidentifiable
  }
  // AI の判定が無い（または保留）。型が分からない枠と AI に回す型の枠は、AI が確かめるまで出さない
  if (!p.type || needsAi({ type: p.type, sub: p.sub }, aiRoutes)) return "pending_ai";
  if (p.hasWorks) return "work";
  if (p.unresolvedReason === "not_a_work") return "hidden";
  if (p.unresolvedReason === "unidentifiable" || p.unresolvedReason === "not_in_db") return "frame";
  return "pending_ai";
}
