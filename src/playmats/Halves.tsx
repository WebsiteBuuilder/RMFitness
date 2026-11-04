// The two halves of the playmat under the Touch field: the opponent's mat on their half (turned
// round to face them), yours on yours. Each half is three still layers and one moving one:
//   .pm-art   the scene (fades back when a Field Spell's landscape takes that half)
//   .pm-fx    the mat's ambient motion: one repeating tile moved on transform or opacity only
//   .pm-trim  the metal edge, corner pieces and plaque (always stays)
// plus a red shade that rises with that duelist's danger state. Nothing here takes a tap.
import type { Pid } from '../eds/types';
import { duelPlaymatOf, playmatClass, useDuelPlaymats } from './duel';
import { playmatDef } from './roster';

function Half({ side, pos, fieldUp }: { side: Pid; pos: 'me' | 'opp'; fieldUp: boolean }) {
  const id = duelPlaymatOf(side);
  if (!id) return null;
  return (
    <div class={`pm-half ${pos}${playmatClass(id)}${fieldUp ? ' fieldup' : ''}`} aria-hidden="true">
      <i class="pm-art" />
      <i class="pm-fx" />
      <i class="pm-trim" />
    </div>
  );
}

/** Both halves (nothing when neither side has a mat). `field` says which halves a Field Spell's landscape holds. */
export function PlaymatHalves({ me, opp, field }: { me: Pid; opp: Pid; field: { me: boolean; opp: boolean } }) {
  useDuelPlaymats();
  return (
    <>
      <Half side={opp} pos="opp" fieldUp={field.opp} />
      <Half side={me} pos="me" fieldUp={field.me} />
    </>
  );
}

/** The class a field row takes for its side's mat (its zone frames take the mat's colour). */
export function rowMatClass(side: Pid): string {
  const id = duelPlaymatOf(side);
  return id ? ` pm-row pm-id-${id}${playmatDef(id)?.bright ? ' pm-bright' : ''}` : '';
}
