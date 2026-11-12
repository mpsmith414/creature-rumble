import type { KidCards } from '../../../src/designer/types';
import type { Recipe } from '../../../src/recipe/schema';
import { deer } from './deer';
import { duck } from './duck';
import { fox } from './fox';
import { frog } from './frog';
import { hawk } from './hawk';
import { rabbit } from './rabbit';
import { trout } from './trout';
import { wolf } from './wolf';

export type CastMember = { recipe: Recipe; cards: KidCards };

/** The valley's own animals, hand-tuned: the quality bar the body builder's tests hold it to. */
export const CAST: CastMember[] = [
  { recipe: deer, cards: { name: 'Deer', eats: 'grass and leaves 🌿', speed: 'very fast 💨', mood: 'gentle and watchful 👀', special: 'big ears that turn to every sound' } },
  { recipe: rabbit, cards: { name: 'Rabbit', eats: 'clover and flowers 🌸', speed: 'zippy hops 🐇', mood: 'shy 🙈', special: 'a fluffy cotton tail' } },
  { recipe: fox, cards: { name: 'Red Fox', eats: 'berries and mice 🫐', speed: 'quick 🏃', mood: 'curious 🤔', special: 'a big bushy tail with a white tip' } },
  { recipe: wolf, cards: { name: 'Wolf', eats: 'meat 🍖', speed: 'runs all day 🏃', mood: 'brave and loyal 💪', special: 'howls to call its pack' } },
  { recipe: duck, cards: { name: 'Duck', eats: 'pond weed and bugs 🪲', speed: 'waddles, then flies ✈️', mood: 'chatty 💬', special: 'waterproof feathers' } },
  { recipe: hawk, cards: { name: 'Hawk', eats: 'mice and voles 🐭', speed: 'soars and swoops 🦅', mood: 'sharp-eyed 🔭', special: 'sees a mouse from way up high' } },
  { recipe: trout, cards: { name: 'Trout', eats: 'bugs on the water 🦟', speed: 'darts and dashes 💨', mood: 'skittish 🫧', special: 'spotty, shiny scales' } },
  { recipe: frog, cards: { name: 'Frog', eats: 'flies 🪰', speed: 'big leaps 🐸', mood: 'sleepy in the sun ☀️', special: 'bulgy eyes on top of its head' } },
];
