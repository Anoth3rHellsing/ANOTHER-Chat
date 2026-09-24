export const MAX_DISTINCT_REACTIONS_PER_MESSAGE = 20;

const EMOJI_COMPONENT = String.raw`(?:\p{Emoji_Modifier_Base}\uFE0F?\p{Emoji_Modifier}|\p{Emoji_Presentation}\uFE0F?|\p{Extended_Pictographic}\uFE0F)`;
const EMOJI_SEQUENCE = new RegExp(`^${EMOJI_COMPONENT}(?:\\u200D${EMOJI_COMPONENT})*$`, "u");
const FLAG_SEQUENCE = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP_SEQUENCE = /^[0-9#*]\uFE0F?\u20E3$/u;
const TAG_FLAG_SEQUENCE = /^\p{Extended_Pictographic}\uFE0F?(?:[\u{E0020}-\u{E007E}])+\u{E007F}$/u;

/** Accept one bounded Unicode emoji grapheme, including common composed sequences. */
export function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (Array.from(value).length > 32) return false;

  return EMOJI_SEQUENCE.test(value)
    || FLAG_SEQUENCE.test(value)
    || KEYCAP_SEQUENCE.test(value)
    || TAG_FLAG_SEQUENCE.test(value);
}

export function groupReactions(rows: Array<{ emoji: string; userId: number }>) {
  const map = new Map<string, number[]>();
  for (const row of rows) {
    if (!map.has(row.emoji)) map.set(row.emoji, []);
    map.get(row.emoji)!.push(row.userId);
  }
  return Array.from(map.entries()).map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
  }));
}