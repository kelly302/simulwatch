// 検索の照合用の文字列（作品一覧・配信者一覧で共通）。
// 全角半角・大文字小文字をそろえ、カタカナはひらがなに、空白と記号の一部を落とす
export function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・･·!！?？、。,.:：;；'"「」『』【】()（）\[\]〜~\-‐－―]/g, "");
}
