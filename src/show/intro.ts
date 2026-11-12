/**
 * A creature's intro as shown (banners) and spoken (the announcer): the designer writes `{maker}` where the maker's
 * name goes, and an intro is capped at INTRO_MAX characters wherever it reaches the screen or the voice.
 */

/** Who made it, when nobody is known (a fixture, a creature from before makers were kept). */
export const MYSTERY_MAKER = 'a mystery maker';
/** The longest intro shown or spoken (characters). The designer is asked for this much; the model may run over. */
export const INTRO_MAX = 220;
const PLACEHOLDER = /\{maker\}/g;
const ELLIPSIS = '…';

/** The maker's name to show or say: trimmed, or "a mystery maker" when there is none. */
export function makerName(maker: string | null | undefined): string {
  const name = maker?.trim();
  return name ? name : MYSTERY_MAKER;
}

/**
 * The intro with every `{maker}` replaced by the maker's name (`makerName`), then cut to at most INTRO_MAX characters:
 * at the last word boundary that fits, with an ellipsis (a single endless word is cut hard).
 */
export function fillIntro(intro: string, maker: string | null | undefined): string {
  const name = makerName(maker);
  const text = intro.replace(PLACEHOLDER, () => name).trim();
  if (text.length <= INTRO_MAX) return text;
  const room = INTRO_MAX - ELLIPSIS.length;
  const cut = text.slice(0, room + 1);
  const space = cut.lastIndexOf(' ');
  const head = (space > 0 ? cut.slice(0, space) : cut.slice(0, room)).replace(/[\s,;:–—-]+$/, '');
  return head + ELLIPSIS;
}
