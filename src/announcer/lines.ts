/**
 * What the ring announcer says. Hammy, kind and short, for children aged 4 to 6: slapstick only, never mean about a creature,
 * nothing scary, no injuries. A ring-out goes into the ball pit and is a happy splash.
 * Slots: `{name}` (the one doing it), `{other}` (the one it happens to), `{names}` (everyone in a group). Names are shouted.
 * An intro is not here: it is the recipe's own `fight.intro` (see `introText` in announcer.ts).
 */

export type Beat = 'intro' | 'groupIntro' | 'hit' | 'bigHit' | 'ringOut' | 'holdsRing' | 'lone' | 'tie' | 'crown' | 'again';

/** The words a line may use. Missing ones get a friendly stand-in, so no slot is ever left showing. */
export type Slots = Partial<Record<'name' | 'other' | 'names' | 'maker' | 'weight', string>>;

/** The longest line, in characters, with every slot filled by a short name. */
export const LINE_MAX = 120;

const SHOUTED = new Set(['name', 'other', 'names']);
const STAND_IN: Record<string, string> = { name: 'OUR HERO', other: 'THEIR PAL', names: 'EVERYBODY', maker: 'a mystery maker', weight: 'a mystery weight' };

/** Fills every `{slot}` in one pass (so a name holding braces cannot make a new slot); names go in capitals, shouted. */
export function fillSlots(text: string, slots: Slots): string {
  return text.replace(/\{(name|other|names|maker|weight)\}/g, (_, k: keyof Slots) => {
    const v = slots[k]?.replace(/[{}]/g, '').trim();
    if (!v) return STAND_IN[k];
    return SHOUTED.has(k) ? v.toUpperCase() : v;
  });
}

export const LINES: Record<Exclude<Beat, 'intro'>, readonly string[]> = {
  groupIntro: [
    'Ladies and gentlemen, please welcome {names}!',
    'Here they come, all together: {names}!',
    'Make some noise for {names}!',
    'Step right up, {names}! The ring is all yours!',
    "It's the big, bouncy, brilliant {names}!",
    "Give them a wave, everybody! It's {names}!",
    'Wiggle your way in, {names}! Time to rumble!',
    'The crowd goes bananas for {names}!',
  ],
  hit: [
    'Boing! {name} bounces {other} right off the springy floor!',
    'Bonk! {name} gives {other} a gentle little nudge!',
    'Whoopsie! {other} wobbles like jelly!',
    'Look at {name} go! Wibble wobble!',
    'Oh my, {other} does a happy spin!',
    'A big floppy slap from {name}!',
    'Boop! {name} boops {other} on the nose!',
    'Wheee! {other} does a little twirl!',
    'That was a springy one, folks!',
    '{name} is bouncing all over the place!',
    'Bounce, bounce, bounce! This crowd loves it!',
    'Squish and squash! {other} goes wobbling by!',
    'Ooh, a silly spin from {name}!',
    '{other} gets a tickly bump from {name}!',
    'Flip, flop, flap! What a floppy fight!',
    "That's some fancy footwork, {name}!",
    'Doing the wobble! {other} is a wiggly one!',
    'Pow! Well, more of a pillow, really!',
    '{name} bumps {other} and giggles about it!',
    'Boing, boing, boing! Like a rubber ball!',
    'A bouncy bump for {other}!',
    'Here comes {name}, bouncing right along!',
    '{other} bounces back, quick as a bunny!',
    'What a wiggly wallop from {name}!',
    'Swish and swoosh! {name} is on the move!',
    'The crowd loves a good bump!',
    'Blip, blop, bump! Funniest fight ever!',
    '{other} goes tumbling and rolling!',
    'Hee hee! {name} is bouncing so high!',
    'Thwack! What a funny sound, {name}!',
  ],
  bigHit: [
    'KABOOM! {name} sends {other} flying like a cannonball!',
    'Whoa! {other} is zooming through the air!',
    'What a super springy launch from {name}!',
    'BOING! {other} bounces up to the clouds!',
    'A giant wallop from {name}! The crowd goes wild!',
    'Zoooom! {other} is a rocket!',
    'Holy hopping hippos, what a bounce!',
    'Look at {other} go! Up, up and away!',
    'The biggest boing of the day, from {name}!',
    'Super duper bump from {name}!',
    'Wheeeee! {other} is zooming around!',
    'Mega bonk! {name} is on a roll!',
    '{other} bounces and bounces and bounces!',
    'Wow! {name} gives {other} a great big shove!',
    'Right across the ring! {other} is flying!',
    'What a whopper of a whack from {name}!',
    "Ka-pow! The crowd can't believe it!",
    '{name} does the biggest boing ever!',
    'Hold on to your hats! {other} is flying by!',
    'Super-sized silliness from {name}!',
    '{other} is rolling and tumbling all around!',
    'What a big tumble! Oh, the wobble of it!',
    'BAM! Did you see that one, everybody?',
    'Look out below! {other} is coming down!',
    'Fantastic fling from {name}!',
    '{other} spins around and around and around!',
    'A whopping great wallop, folks!',
    'Yippee! {name} has the power of the pogo stick!',
    'Up, up, UP goes {other}! Bye bye!',
    "That's what we call a big bouncy bump!",
  ],
  ringOut: [
    'Splash! {other} goes into the ball pit! Hooray!',
    'Plop! {other} lands in the ball pit, wheee!',
    'Out of the ring and into the ball pit! What a splash!',
    'Splishy splashy! {other} lands in the ball pit!',
    'Into the ball pit goes {other}! Bounce, bounce!',
    'Ball pit party for {other}! Everybody cheer!',
    'Whoops, over the edge! {other} giggles in the pile of balls!',
    'A happy splash for {other}!',
    '{other} dives in the ball pit! What a dive!',
  ],
  holdsRing: [
    '{name} is still in the ring! Look at that bounce!',
    'Still standing: the bouncy, brilliant {name}!',
    '{name} holds the ring! Great wobbling!',
    'Hooray for {name}, still going strong!',
    'What a wiggler! {name} stays in the ring!',
    "{name} isn't going anywhere! Not today!",
    'Steady, silly {name} is still here!',
    'The crowd loves {name}!',
  ],
  lone: [
    '{name} is all by themselves in the ring! Give a wave!',
    'Only {name} left! What a bouncy day!',
    "It's just {name} now! Hip hip hooray!",
    '{name} is the last one in the ring!',
    'Just one wobbler left: {name}!',
    'All alone in the ring, {name} does a little dance!',
    'The ring is quiet, except for {name}! Boing!',
    '{name} has the whole ring to bounce in!',
  ],
  tie: [
    "It's a tie! Everyone splashes together!",
    'A tie! Everybody bounces, one big splash!',
    'Nobody wins, everybody wiggles! A tie!',
    "Into the ball pit together! It's a draw!",
    'What a silly finish! A tie, folks!',
    "It's a draw! High fives all around!",
    'A tie! The crowd goes aww and cheers!',
    'Nobody left in the ring! Everyone is a winner!',
  ],
  crown: [
    'And the champion of the ring is {name}! Hooray!',
    'All hail {name}, the bouncy champion!',
    'A big round of applause for {name}! You did it!',
    '{name} wins the rumble! Wobble wobble wobble!',
    'Our champion: the one, the only, {name}!',
    'Put the crown on {name}! What a bouncer!',
    'Hip hip hooray for {name}! Champion!',
    '{name} is the best bouncer in the whole ring!',
    "Confetti for {name}! You're the champion!",
  ],
  again: [
    "Ready for another rumble? Let's go again!",
    'Who is up for another bounce? Round two!',
    'Back in the ring, everybody! Again, again!',
    'That was a giggle! Shall we go again?',
    'Time for another wiggle-wobble round!',
    'One more time! The crowd wants more!',
    'Everybody into the ring! Here we go again!',
    'The ring is ready for another round!',
  ],
};
