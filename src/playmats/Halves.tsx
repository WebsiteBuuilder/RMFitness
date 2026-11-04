// The two halves of the playmat under the Touch field: the opponent's mat on their half (turned
// round to face them), yours on yours. Each half is three still layers and one moving one:
//   .pm-art   the scene (fades back when a Field Spell's landscape takes that half)
//   .pm-fx    the mat's ambient motion: one repeating tile moved on transform or opacity only
//   .pm-trim  the metal edge, corner pieces and plaque (always stays)
// plus a red shade that rises with that duelist's danger state. Nothing here takes a tap.
import type { Pid } from '../eds/types';
import { duelPlaymatOf, playmatClass, useDuelPlaymats } from './duel';

function Half({ side, pos, fieldUp, odd }: { side: Pid; pos: 'me' | 'opp'; fieldUp: boolean; odd: boolean }) {
  const id = duelPlaymatOf(side);
  if (!id) return null;
  return (
    <div class={`pm-half ${pos}${playmatClass(id)}${fieldUp ? ' fieldup' : ''}${odd ? ' pm-t-odd' : ''}`} aria-hidden="true">
      <i class="pm-art" />
      <i class="pm-fx" />
      <i class="pm-trim" />
    </div>
  );
}

/** Both halves (nothing when neither side has a mat). `field` says which halves a Field Spell's
 *  landscape holds; `turn` is the duel's turn number (its motion name flips with it each turn, so
 *  the burst of motion starts again every turn in every layout, hotseat included). */
export function PlaymatHalves({ me, opp, field, turn }: { me: Pid; opp: Pid; field: { me: boolean; opp: boolean }; turn: number }) {
  const odd = turn % 2 === 1;
  useDuelPlaymats();
  return (
    <>
      <Half side={opp} pos="opp" fieldUp={field.opp} odd={odd} />
      <Half side={me} pos="me" fieldUp={field.me} odd={odd} />
    </>
  );
}

/** The class a field row takes for its side's mat (its zone frames take the mat's colour). */
export function rowMatClass(side: Pid): string {
  const id = duelPlaymatOf(side);
  // (playmatClass writes the mat's rule too, so the row's colours never wait on the halves)
  return id ? ` pm-row${playmatClass(id).replace(/ pm-fx-\w+/, '')}` : '';
}
