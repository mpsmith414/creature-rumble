import type { Vector3 } from 'three/webgpu';
import type { Move } from './types';

/**
 * Special attacks: the shared contract between the fight (which charges and performs them) and the show (which makes
 * them look and sound big). Every fighting style has one special; a meter fills from landing and taking hits and the
 * fighter unleashes it when full.
 */
export type SpecialName = 'megaPunch' | 'jabFlurry' | 'helicopterKick' | 'bellyBomb' | 'rocketHeadbutt' | 'tornadoTail' | 'meteorDive';

export const SPECIAL_FOR: Record<Move, SpecialName> = {
  punch: 'megaPunch',
  jab: 'jabFlurry',
  kick: 'helicopterKick',
  bump: 'bellyBomb',
  headbutt: 'rocketHeadbutt',
  spin: 'tornadoTail',
  divebomb: 'meteorDive',
};

/** What the TV shouts (banner title and pop word). */
export const SPECIAL_TITLE: Record<SpecialName, string> = {
  megaPunch: 'MEGA PUNCH!',
  jabFlurry: 'JAB-JAB-JABBER!',
  helicopterKick: 'HELICOPTER KICK!',
  bellyBomb: 'BELLY BOMB!',
  rocketHeadbutt: 'ROCKET HEADBUTT!',
  tornadoTail: 'TORNADO TAIL!',
  meteorDive: 'METEOR DIVE!',
};

/**
 * A moment in a special, for the show:
 * - `charge`: the meter just filled and the wind-up starts (glow, banner, announcer)
 * - `release`: the attack is unleashed (whoosh, slow-mo, camera punch)
 * - `impact`: it hit the ground or a body at `at`; `radius` (m) is the shockwave's reach when it has one
 * - `end`: it is over (glow off)
 */
export type SpecialCue = {
  id: string;
  special: SpecialName;
  phase: 'charge' | 'release' | 'impact' | 'end';
  at: Vector3;
  radius?: number;
};

/** A fighter's special as the show reads it each frame. `meter` 0..1 fills toward the next special. */
export type SpecialState = { meter: number; active: SpecialName | null };
