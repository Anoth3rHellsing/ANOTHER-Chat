import assert from "node:assert/strict";
import test from "node:test";
import {
  groupReactions,
  isSingleEmoji,
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
} from "./reactions";

test("emoji validation accepts common single-grapheme sequences", () => {
  const pirateFlag = `🏴${String.fromCodePoint(0xe0067, 0xe0072, 0xe0074, 0xe0062, 0xe007f)}`;
  for (const emoji of ["😀", "🙋🏽", "👨‍👩‍👧‍👦", "🇺🇳", "1️⃣", "©️", pirateFlag]) {
    assert.equal(isSingleEmoji(emoji), true, emoji);
  }
});

test("emoji validation rejects non-emojis, multiple graphemes, and oversized input", () => {
  for (const value of ["", "hello", "1", "©", "😀😀", "😀 text", "👍🏽🏻", "❤️‍", "😀".repeat(17)]) {
    assert.equal(isSingleEmoji(value), false, value);
  }
  assert.equal(isSingleEmoji(null), false);
});

test("reactions are grouped into the public full-state response shape", () => {
  assert.deepEqual(groupReactions([
    { emoji: "😀", userId: 2 },
    { emoji: "🔥", userId: 3 },
    { emoji: "😀", userId: 4 },
  ]), [
    { emoji: "😀", count: 2, userIds: [2, 4] },
    { emoji: "🔥", count: 1, userIds: [3] },
  ]);
  assert.equal(MAX_DISTINCT_REACTIONS_PER_MESSAGE, 20);
});