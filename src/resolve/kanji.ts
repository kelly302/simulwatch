// 漢数字の読み取り（話数・期・部の表記で使う）

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 壱: 1, 二: 2, 弐: 2, 三: 3, 参: 3, 四: 4, 肆: 4, 五: 5, 伍: 5,
  六: 6, 陸: 6, 七: 7, 漆: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

/** 漢数字（十・百まで）を数値にする。読めなければ null */
export function parseKanjiNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) cur = KANJI_DIGIT[ch]!;
    else if (ch === "十" || ch === "拾") {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch === "百") {
      total += (cur || 1) * 100;
      cur = 0;
    } else return null;
  }
  return total + cur;
}
