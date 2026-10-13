import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { Card, FieldCard, Pid, Prompt, SelectOption } from '../eds/types';
import { other } from '../eds/engine';
import { getEffect } from '../eds/effects';
import { card as cardInfo } from '../eds/db';
import { CardImg, CardInfoPanel } from './CardImg';
import { Menu, Overlay, Win } from './Window';
import { playBlip, playDraw, playHit, playSummon, playWin, unlockAudio } from './sound';
import { CONTROL_NAMES, type ControlStyle } from '../eds/save';
import { TouchDuel } from './TouchDuel';
import { ArtStage, useCinematicsMenu } from '../art/ArtStage';
import { LpCount, useShownState } from '../art/flow';
import { artBusy, onArtChange } from '../art/cues';

const PHASE_SHORT: Record<string, string> = { DP: 'DP', SP: 'SP', M1: 'M1', BP: 'BP', M2: 'M2', EP: 'EP' };

interface Props {
  session: DuelSession;
  view: SessionView;
  mySeat: Pid;
  hotseat: boolean;
  /** each seat's control style when the duel starts */
  controlsFor?: (p: Pid) => ControlStyle;
  /** remember a seat's new control style */
  onControls?: (p: Pid, c: ControlStyle) => void;
  onLeave: () => void;
  onFinished: (winner: Pid | 'draw') => void;
  /** watching the computer duel itself: nothing on the board takes input */
  spectator?: boolean;
  /** a Tag Duel where your teammate is in: you watch your side's moves (their hand shows) but can't touch */
  locked?: boolean;
}

export type Mode = { kind: 'attack'; uid: number } | null;

export interface Command {
  label: string;
  onPick: () => void;
  disabled?: boolean;
}

export function Duel({ session, view, mySeat, hotseat, controlsFor, onControls, onLeave, onFinished, spectator, locked }: Props) {
  const state = useShownState(view.state, hotseat ? null : mySeat);
  const e = session.engine;
  const acting: Pid = hotseat ? (state.prompt?.player ?? state.turnPlayer) : mySeat;
  const me = state.players[acting];
  const opp = state.players[other(acting)];
  const canAct = !spectator && !locked && (hotseat || acting === mySeat);
  const myTurn = state.turnPlayer === acting;
  const prompt = state.prompt && state.prompt.player === acting && canAct ? state.prompt : null;

  const [sel, setSel] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [skillOf, setSkillOf] = useState<Pid | null>(null);
  const [pile, setPile] = useState<{ title: string; cards: Card[] } | null>(null);
  const [pass, setPass] = useState(false);
  const artItems = useCinematicsMenu();
  const [anim, setAnim] = useState<{ kind: string; uid?: number; player?: Pid; amount?: number; seq: number } | null>(null);
  const [styles, setStyles] = useState<[ControlStyle, ControlStyle]>(() => [controlsFor?.(0) ?? 'classic', controlsFor?.(1) ?? 'classic']);
  const style = styles[acting];
  const switchStyle = () => {
    const next: ControlStyle = style === 'touch' ? 'classic' : 'touch';
    setStyles((cur) => (acting === 0 ? [next, cur[1]] : [cur[0], next]));
    onControls?.(acting, next);
  };
  // Test hook: ?debug exposes the engine so automated checks can see what a button did.
  if (typeof location !== 'undefined' && location.search.includes('debug')) (window as unknown as Record<string, unknown>).__duel = { e, state, acting };
  const lastActing = useRef(acting);
  const lastSeq = useRef(0);
  const finished = useRef(false);

  // Hotseat: pass the phone when the acting seat changes (before paint, so the next hand never flashes).
  useLayoutEffect(() => {
    if (hotseat && lastActing.current !== acting && state.winner === null) setPass(true);
    lastActing.current = acting;
  }, [acting, hotseat, state.winner]);

  // Hotseat: hide the first hand until whoever goes first has the phone.
  useLayoutEffect(() => {
    if (hotseat && state.winner === null) setPass(true);
  }, []);

  // Animations and sounds from engine events.
  useEffect(() => {
    const ev = state.lastEvent;
    if (!ev || ev.seq === lastSeq.current) return;
    lastSeq.current = ev.seq;
    setAnim(ev);
    if (ev.kind === 'summon' || ev.kind === 'flip') playSummon();
    else if (ev.kind === 'damage' || ev.kind === 'hit') playHit();
    else if (ev.kind === 'draw') playDraw();
    else if (ev.kind === 'win') playWin();
    const t = setTimeout(() => setAnim(null), 700);
    return () => clearTimeout(t);
  }, [state.lastEvent]);

  useEffect(() => {
    setSel(null);
    setMode(null);
    setPicks([]);
  }, [state.prompt, state.phase, state.turn]);

  useEffect(() => {
    if (state.winner !== null && !finished.current) {
      finished.current = true;
    }
    // the result goes up: no card inspector, info box or pile left open over it
    if (state.winner !== null) {
      setSel(null);
      setMode(null);
      setInfo(null);
      setPile(null);
    }
  }, [state.winner]);

  // a cinematic starts: a card inspector or info box open over the board closes (the stage takes the screen)
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(
    () =>
      onArtChange(() => {
        if (!artBusy() || modeRef.current) return;
        setSel(null);
        setInfo(null);
      }),
    [],
  );

  /** The last move sent, so a double tap can't send it twice before the game answers (online it takes a moment). */
  const sent = useRef<{ view: SessionView; at: number } | null>(null);
  const online = !!session.adapter.roomCode;
  /** Saves the result exactly once, however many times Continue is tapped. */
  const recorded = useRef(false);
  const finish = (w: Pid | 'draw') => {
    if (recorded.current) return;
    recorded.current = true;
    onFinished(w);
  };
  /** Leaving a finished duel still saves its result; leaving an online duel early concedes it, so the other player isn't left waiting. */
  const leave = () => {
    if (state.winner !== null) return finish(state.winner);
    if (online && canAct) session.send({ type: 'SURRENDER', player: acting });
    onLeave();
  };
  const send = (a: Parameters<DuelSession['send']>[0]) => {
    if (sent.current && sent.current.view === view && Date.now() - sent.current.at < 1500) return;
    sent.current = { view, at: Date.now() };
    unlockAudio();
    playBlip();
    // A command used up the selection: don't leave the old card's menu on screen.
    setSel(null);
    setMode(null);
    session.send(a);
  };

  const tap = (uid: number) => {
    unlockAudio();
    playBlip();
    if (prompt?.kind === 'select') {
      const i = prompt.options.findIndex((o) => o.uid === uid);
      if (i >= 0) togglePick(prompt, i);
      return;
    }
    if (mode?.kind === 'attack') {
      const f = e.find(uid);
      const attacker = e.fieldCard(mode.uid);
      if (f && f.loc.zone === 'mz' && f.loc.player === other(acting) && attacker && e.legalTargets(acting, attacker).some((t) => t.uid === uid)) send({ type: 'ATTACK', player: acting, uid: mode.uid, target: uid });
      setMode(null);
      return;
    }
    setSel(sel === uid ? null : uid);
  };

  const togglePick = (p: Extract<Prompt, { kind: 'select' }>, i: number) => {
    if (p.max === 1) {
      send({ type: 'CHOOSE', player: acting, picks: [i] });
      return;
    }
    setPicks((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : cur.length < p.max ? [...cur, i] : cur));
  };

  /** The Eye of Truth, Respect Play and Ceremonial Bell show the opponent's hand; a spectator sees both hands and set cards. */
  const oppHandShown = !!spectator || e.handRevealed(other(acting));
  const selected = sel !== null ? e.find(sel) : null;
  const selCard = selected?.card ?? null;
  const selField = selected && (selected.loc.zone === 'mz' || selected.loc.zone === 'sz' || selected.loc.zone === 'field') ? (selected.card as FieldCard) : null;

  // ----- commands for the selected card -----
  const commands: Command[] = [];
  if (selCard && selected && canAct && !prompt && state.winner === null) {
    const info = cardInfo(selCard.name);
    const mine = selected.loc.player === acting;
    if (mine && selected.loc.zone === 'hand' && myTurn && e.inMainPhase()) {
      if (info?.kind === 'monster') {
        const ok = e.canNormalSummon(acting, selCard);
        const zone = e.freeMonsterZone(acting);
        commands.push({ label: 'Summon', disabled: !ok || !e.canNormalSummon(acting, selCard, true), onPick: () => send({ type: 'SUMMON', player: acting, uid: selCard.uid, zone, pos: 'atk', faceUp: true }) });
        commands.push({ label: 'Set', disabled: !ok, onPick: () => send({ type: 'SUMMON', player: acting, uid: selCard.uid, zone, pos: 'def', faceUp: false }) });
        const eff = getEffect(selCard.name);
        if (eff?.summonProc) commands.push({ label: 'Special Summon', disabled: !e.canSpecialProc(acting, selCard), onPick: () => send({ type: 'SPECIAL', player: acting, uid: selCard.uid }) });
        if (eff?.handIgnition) commands.push({ label: 'Effect', disabled: !e.canUseMonsterEffect(acting, selCard), onPick: () => send({ type: 'MONSTER_EFFECT', player: acting, uid: selCard.uid }) });
      } else {
        const zone = me.sz.findIndex((z) => z === null);
        if (info?.kind === 'spell') commands.push({ label: 'Activate', disabled: !e.canActivateMain(acting, selCard.uid), onPick: () => send({ type: 'ACTIVATE', player: acting, uid: selCard.uid, zone }) });
        commands.push({ label: 'Set', disabled: !e.canSet(acting, selCard), onPick: () => send({ type: 'SET_ST', player: acting, uid: selCard.uid, zone }) });
      }
    }
    if (mine && selField && selected.loc.zone === 'mz' && myTurn) {
      const m = selField;
      const fresh = m.placedTurn !== state.turn && !m.posChanged && !m.attacked;
      if (state.phase === 'BP') {
        const can = e.canAttackWith(acting, m);
        commands.push({
          label: 'Attack',
          disabled: !can || (e.monsters(other(acting)).length > 0 && e.legalTargets(acting, m).length === 0 && !e.canAttackDirectly(m)),
          onPick: () => {
            if (e.monsters(other(acting)).length === 0) send({ type: 'ATTACK', player: acting, uid: m.uid, target: null });
            else setMode({ kind: 'attack', uid: m.uid });
          },
        });
        if (can && e.canAttackDirectly(m) && e.monsters(other(acting)).length > 0) commands.push({ label: 'Direct Attack', onPick: () => send({ type: 'ATTACK', player: acting, uid: m.uid, target: null }) });
      }
      if (e.inMainPhase()) {
        if (m.faceUp && getEffect(m.name)?.ignition) commands.push({ label: 'Effect', disabled: !e.canUseMonsterEffect(acting, m), onPick: () => send({ type: 'MONSTER_EFFECT', player: acting, uid: m.uid }) });
        if (m.faceUp) commands.push({ label: m.pos === 'atk' ? 'To Defense' : 'To Attack', disabled: !fresh || !!m.cannotChangePos || !e.canChangePosition(acting, m), onPick: () => send({ type: 'CHANGE_POS', player: acting, uid: m.uid }) });
        else commands.push({ label: 'Flip Summon', disabled: !fresh || e.summonBlocked(acting, m, 'flip', 'mz'), onPick: () => send({ type: 'FLIP_SUMMON', player: acting, uid: m.uid }) });
      }
    }
    if (mine && selField && (selected.loc.zone === 'sz' || selected.loc.zone === 'field') && !selField.faceUp && myTurn) {
      commands.push({ label: 'Activate', disabled: !e.canActivateMain(acting, selField.uid), onPick: () => send({ type: 'ACTIVATE', player: acting, uid: selField.uid }) });
    }
    // Face-up Spells and Traps with an effect you can use (Magical Labyrinth, Metalmorph...).
    if (mine && selField && (selected.loc.zone === 'sz' || selected.loc.zone === 'field') && selField.faceUp && myTurn && e.inMainPhase() && getEffect(selField.name)?.ignition) {
      commands.push({ label: 'Effect', disabled: !e.canUseMonsterEffect(acting, selField), onPick: () => send({ type: 'MONSTER_EFFECT', player: acting, uid: selField.uid }) });
    }
  }
  // Speed Duel Quick Effects you can use in your own Main Phase (from the hand or the field).
  if (selCard && selected && canAct && !prompt && state.winner === null && selected.loc.player === acting && e.canUseQuickNow(acting, selCard.uid)) {
    commands.push({ label: 'Quick Effect', onPick: () => send({ type: 'QUICK_EFFECT', player: acting, uid: selCard.uid }) });
  }
  const canSeeSel = !!selCard && (!selField || selField.faceUp || selected?.loc.player === acting);
  if (selCard && canSeeSel) commands.push({ label: 'Card Info', onPick: () => setInfo(selCard.name) });

  const highlight = (uid: number): string => {
    let cls = '';
    if (sel === uid) cls += ' sel';
    if (prompt?.kind === 'select' && prompt.options.some((o) => o.uid === uid)) cls += ' pick';
    if (prompt?.kind === 'select' && picks.some((i) => prompt.options[i]?.uid === uid)) cls += ' picked';
    if (mode?.kind === 'attack') {
      const attacker = e.fieldCard(mode.uid);
      if (attacker && e.legalTargets(acting, attacker).some((t) => t.uid === uid)) cls += ' pick';
    }
    if (anim?.uid === uid) cls += ` anim-${anim.kind}`;
    return cls;
  };

  const zone = (c: FieldCard | null, owner: Pid, kind: 'm' | 's', i: number) => {
    const visible = c ? c.faceUp || owner === acting || !!spectator : false;
    return (
      <div key={`${owner}${kind}${i}`} data-uid={c?.uid} class={`zone z-${kind} ${c ? '' : 'empty'} ${c ? highlight(c.uid) : ''}`} onClick={() => c && tap(c.uid)}>
        {c ? (
          <div class={`fcard ${c.pos === 'def' ? 'def' : ''} ${c.faceUp ? '' : 'fd'}`}>
            <CardImg name={c.name} back={!visible} owner={c.owner} />
            {c.faceUp && kind === 'm' && (
              <div class="fstat">
                {c.pos === 'atk' ? e.atkOf(c) : e.defOf(c)}
                {c.pos === 'def' ? 'D' : ''}
              </div>
            )}
            {c.equips.length > 0 && <div class="eqmark">{c.equips.length}</div>}
            {(c.mats?.length ?? 0) > 0 && <div class="matmark" title="Xyz Materials">{c.mats!.length}</div>}
          </div>
        ) : (
          <span class="zlabel">{kind === 'm' ? '' : ''}</span>
        )}
      </div>
    );
  };

  const sideBox = (p: Pid, top: boolean) => {
    const ps = state.players[p];
    return (
      <div class={`sidebox ${top ? 'top' : 'bottom'}`}>
        <button class="pile" onClick={() => setPile({ title: `${ps.name}'s Graveyard`, cards: ps.gy })}>
          <div class="pile-stack">{ps.gy.length > 0 && <CardImg name={ps.gy[ps.gy.length - 1].name} />}</div>
          <span>GY {ps.gy.length}</span>
        </button>
        <div class="pile">
          <div class="pile-stack">{ps.deck.length > 0 && <CardImg name="" back />}</div>
          <span>Deck {ps.deck.length}</span>
        </div>
        <div class={`zone z-f ${ps.field ? '' : 'empty'} ${ps.field ? highlight(ps.field.uid) : ''}`} onClick={() => ps.field && tap(ps.field.uid)}>
          {ps.field ? <CardImg name={ps.field.name} back={!ps.field.faceUp && p !== acting && !spectator} /> : <span class="zlabel">F</span>}
        </div>
        {ps.removed.length > 0 && (
          <button class="pile small" onClick={() => setPile({ title: `${ps.name}'s removed cards`, cards: ps.removed })}>
            <span>Out {ps.removed.length}</span>
          </button>
        )}
        {ps.fusion.length > 0 && (
          <button class={`pile small ${p === acting && canAct && !prompt && ps.fusion.some((c) => e.canSpecialProc(acting, c)) ? 'xready' : ''}`} onClick={() => p === acting && setPile({ title: e.speed ? 'Extra Deck' : 'Fusion Deck', cards: ps.fusion })}>
            <span>
              {e.speed ? 'Extra' : 'Fusion'} {ps.fusion.length}
            </span>
          </button>
        )}
        {ps.skill && (
          <button class={`pile small skillbtn ${ps.skillRevealed ? 'up' : ''} ${p === acting && e.canUseSkill(acting) && canAct ? 'ready' : ''}`} onClick={() => setSkillOf(p)}>
            <span>Skill</span>
          </button>
        )}
      </div>
    );
  };

  // ----- the message window -----
  const renderWindow = () => {
    if (state.winner !== null) {
      const won = state.winner === 'draw' ? null : state.winner === mySeat;
      return (
        <Win title={state.winner === 'draw' ? 'DRAW' : hotseat || spectator ? `${state.players[state.winner].name} WINS` : won ? 'YOU WIN!' : 'YOU LOSE'} class="msgwin">
          <p>{state.winReason}</p>
          <Menu items={[{ label: 'Continue', onPick: () => finish(state.winner!) }, { label: 'View log', onPick: () => setShowLog(true) }]} />
        </Win>
      );
    }
    if (prompt) {
      if (prompt.kind === 'yesno')
        return (
          <Win title={prompt.title} class="msgwin">
            <Menu items={[{ label: 'Yes', onPick: () => send({ type: 'YES', player: acting }) }, { label: 'No', onPick: () => send({ type: 'NO', player: acting }) }]} />
          </Win>
        );
      if (prompt.kind === 'response')
        return (
          <Win title={prompt.title} class="msgwin">
            <Menu items={[...prompt.options.map((o, i) => ({ label: `Activate ${o.label}`, onPick: () => send({ type: 'CHOOSE', player: acting, picks: [i] }) })), { label: 'Pass', onPick: () => send({ type: 'PASS', player: acting }) }]} />
          </Win>
        );
      const listOptions = prompt.options.map((o: SelectOption, i: number) => ({
        label: o.label,
        selected: picks.includes(i),
        onPick: () => togglePick(prompt, i),
      }));
      const items = [...listOptions];
      if (prompt.max > 1 || prompt.min === 0) items.push({ label: `OK (${picks.length}/${prompt.max})`, selected: false, onPick: () => picks.length >= prompt.min && send({ type: 'CHOOSE', player: acting, picks }) });
      if (prompt.cancel) items.push({ label: 'Cancel', selected: false, onPick: () => send({ type: 'CANCEL', player: acting }) });
      return (
        <Win title={prompt.title} class="msgwin">
          <Menu items={items} class="scroll" />
        </Win>
      );
    }
    if (state.prompt && state.prompt.player !== acting) {
      return (
        <Win title="Please wait" class="msgwin">
          <p>{state.players[state.prompt.player].name} is deciding…</p>
        </Win>
      );
    }
    if (mode?.kind === 'attack') {
      return (
        <Win title="Attack which monster?" class="msgwin">
          <Menu items={[{ label: 'Cancel', onPick: () => setMode(null) }]} />
        </Win>
      );
    }
    if (selCard) {
      const info = cardInfo(selCard.name);
      return (
        <Win title={canSeeSel ? selCard.name : 'Face-down card'} class="msgwin">
          {canSeeSel && info && (
            <div class="selstat">
              {info.kind === 'monster' ? `Lv${info.level} ${info.attribute}/${info.race} ATK ${info.atk} DEF ${info.def}` : `${info.sub} ${info.kind === 'spell' ? 'Magic' : 'Trap'}`}
            </div>
          )}
          <Menu items={commands} />
        </Win>
      );
    }
    return (
      <Win title={myTurn ? 'Your turn' : `${opp.name}'s turn`} class="msgwin">
        <p class="hint">
          {!myTurn
            ? 'Waiting for your opponent.'
            : state.phase === 'BP'
              ? state.firstTurn
                ? 'No attacks on the first turn.'
                : 'Tap a monster, then Attack.'
              : e.inMainPhase()
                ? 'Tap a card in your hand to Summon or Set it.'
                : 'Tap Next Phase.'}
        </p>
      </Win>
    );
  };

  const nextPhaseLabel = state.phase === 'M1' ? (state.firstTurn ? 'End Phase' : 'Battle') : state.phase === 'BP' ? (e.rules.mainPhase2 ? 'Main 2' : 'End Phase') : state.phase === 'M2' ? 'End Phase' : 'Next';

  // Card info, piles, log, menu and the hotseat hand-over screen look the same in both styles.
  const overlays = (
    <>
      <ArtStage state={state} viewer={acting} />
      {info && (
        <Overlay onClose={() => setInfo(null)}>
          <Win title="Card Info" onClose={() => setInfo(null)}>
            <CardInfoPanel name={info} />
          </Win>
        </Overlay>
      )}
      {pile && (
        <Overlay onClose={() => setPile(null)}>
          <Win title={pile.title} onClose={() => setPile(null)}>
            {pile.cards.length === 0 ? (
              <p>Empty.</p>
            ) : (
              <div class="grid">
                {pile.cards
                  .slice()
                  .reverse()
                  .map((c) =>
                    canAct && !prompt && e.canSpecialProc(acting, c) ? (
                      <div key={c.uid} class="gcard">
                        <button onClick={() => setInfo(c.name)}>
                          <CardImg name={c.name} />
                          <span>{c.name}</span>
                        </button>
                        <button class="gbtn geff" onClick={() => (setPile(null), send({ type: 'SPECIAL', player: acting, uid: c.uid }))}>
                          {['Xyz', 'Synchro', 'Link'].includes(e.info(c.name).sub) ? `${e.info(c.name).sub} Summon` : 'Summon'}
                        </button>
                      </div>
                    ) : canAct && !prompt && (e.canUseGraveEffect(acting, c.uid) || e.canUseQuickNow(acting, c.uid)) ? (
                      <div key={c.uid} class="gcard">
                        <button onClick={() => setInfo(c.name)}>
                          <CardImg name={c.name} />
                          <span>{c.name}</span>
                        </button>
                        <button class="gbtn geff" onClick={() => (setPile(null), send({ type: e.canUseGraveEffect(acting, c.uid) ? 'GRAVE_EFFECT' : 'QUICK_EFFECT', player: acting, uid: c.uid }))}>
                          Effect
                        </button>
                      </div>
                    ) : (
                      <button key={c.uid} class="gcard" onClick={() => setInfo(c.name)}>
                        <CardImg name={c.name} />
                        <span>{c.name}</span>
                      </button>
                    ),
                  )}
              </div>
            )}
          </Win>
        </Overlay>
      )}
      {skillOf !== null && (
        <Overlay onClose={() => setSkillOf(null)}>
          <Win title={skillOf === acting ? 'Your Skill' : `${state.players[skillOf].name}'s Skill`} onClose={() => setSkillOf(null)}>
            {skillOf === acting || state.players[skillOf].skillRevealed ? (
              <>
                <CardInfoPanel name={state.players[skillOf].skill ?? ''} />
                {skillOf === acting && canAct && (
                  <Menu
                    items={[
                      {
                        label: 'Use Skill',
                        disabled: !e.canUseSkill(acting),
                        note: state.players[skillOf].skillUses ? `used ${state.players[skillOf].skillUses}×` : undefined,
                        onPick: () => (setSkillOf(null), send({ type: 'SKILL', player: acting })),
                      },
                    ]}
                  />
                )}
              </>
            ) : (
              <p>Face-down. It flips over when they use it.</p>
            )}
          </Win>
        </Overlay>
      )}
      {showLog && (
        <Overlay onClose={() => setShowLog(false)}>
          <Win title="Duel Log" onClose={() => setShowLog(false)}>
            <ul class="log">
              {state.log
                .slice()
                .reverse()
                .map((l, i) => (
                  <li key={i} class={l.player === null ? 'sys' : l.player === mySeat ? 'me' : 'them'}>
                    <span class="lt">T{l.turn}</span> {l.text}
                  </li>
                ))}
            </ul>
          </Win>
        </Overlay>
      )}
      {showMenu && (
        <Overlay onClose={() => setShowMenu(false)}>
          <Win title="Menu" onClose={() => setShowMenu(false)}>
            <Menu
              items={[
                { label: `Controls: ${CONTROL_NAMES[style]}`, note: style === 'touch' ? 'switch to Classic' : 'switch to Touch', onPick: () => (setShowMenu(false), switchStyle()) },
                ...(e.speed ? artItems : []),
                { label: 'Duel Log', onPick: () => (setShowMenu(false), setShowLog(true)) },
                { label: 'Surrender', disabled: !canAct || state.winner !== null, onPick: () => confirm('Surrender this duel?') && (send({ type: 'SURRENDER', player: acting }), setShowMenu(false)) },
                { label: 'Leave duel', onPick: () => (setShowMenu(false), leave()) },
                { label: 'Back', onPick: () => setShowMenu(false) },
              ]}
            />
          </Win>
        </Overlay>
      )}
      {online && view.status !== 'connected' && state.winner === null && <div class="netwarn">{view.detail || 'Connection lost. Reconnecting…'}</div>}
      {pass && (
        <div class="pass" onClick={() => setPass(false)}>
          <Win title="Pass the phone">
            <p>
              Hand the phone to <b>{me.name}</b>.
            </p>
            <p class="hint">Tap when ready</p>
          </Win>
        </div>
      )}
    </>
  );

  if (style === 'touch')
    return (
      <TouchDuel
        ctl={{ state, e, acting, mySeat, hotseat, me, opp, canAct, spectator, locked, myTurn, prompt, sel, setSel, mode, setMode, picks, togglePick, send, tap, commands, highlight, anim, selCard, canSeeSel, oppHandShown, nextPhaseLabel, setInfo, setPile, openSkill: setSkillOf, openMenu: () => setShowMenu(true), setShowLog, onFinished: finish }}
        overlays={overlays}
      />
    );

  const lpAnim = (p: Pid) => (anim && (anim.kind === 'damage' || anim.kind === 'heal') && anim.player === p ? `lp-${anim.kind}` : '');

  return (
    <div class={`duel ${canAct ? '' : 'spectate'} ${e.speed ? 'speed' : ''}`}>
      <div class="pbar top">
        <span class="pname">{opp.name}</span>
        <span class={`lp ${lpAnim(other(acting))}`}>
          LP <LpCount value={opp.lp} who={other(acting)} />
          {anim && anim.kind === 'damage' && anim.player === other(acting) && <span class="dmg">-{anim.amount}</span>}
        </span>
        <span class="hcount">Hand {opp.hand.length}</span>
      </div>
      <div class="opp-hand">
        {opp.hand.map((c) => (
          <div key={c.uid} class={`hcard ${oppHandShown ? '' : 'back'} ${anim?.uid === c.uid ? 'anim-draw' : ''}`} onClick={() => oppHandShown && setInfo(c.name)}>
            <CardImg name={c.name} back={!oppHandShown} owner={c.owner} />
          </div>
        ))}
      </div>
      <div class="field">
        {sideBox(other(acting), true)}
        <div class="rows">
          <div class="row">{opp.sz.map((c, i) => zone(c, other(acting), 's', i))}</div>
          <div class="row">{opp.mz.map((c, i) => zone(c, other(acting), 'm', i))}</div>
          <div class="center">
            <div class="phases">
              {e.phases().map((p) => (
                <span key={p} class={`ph ${state.phase === p ? 'on' : ''} ${p === 'BP' && state.firstTurn ? 'off' : ''}`}>
                  {PHASE_SHORT[p]}
                </span>
              ))}
            </div>
            <div class="turninfo">Turn {state.turn}</div>
            {myTurn && canAct && !state.prompt && state.winner === null && (
              <div class="phasebtns">
                {state.phase !== 'EP' && (
                  <button class="gbtn" onClick={() => send({ type: 'NEXT_PHASE', player: acting })}>
                    {nextPhaseLabel}
                  </button>
                )}
                <button class="gbtn end" onClick={() => send({ type: 'END_TURN', player: acting })}>
                  End Turn
                </button>
              </div>
            )}
            <button class="gbtn menu-btn" onClick={() => setShowMenu(true)}>
              MENU
            </button>
          </div>
          <div class="row">{me.mz.map((c, i) => zone(c, acting, 'm', i))}</div>
          <div class="row">{me.sz.map((c, i) => zone(c, acting, 's', i))}</div>
        </div>
        {sideBox(acting, false)}
      </div>
      <div class="pbar bottom">
        <span class="pname">{me.name}</span>
        <span class={`lp ${lpAnim(acting)}`}>
          LP <LpCount value={me.lp} who={acting} />
          {anim && anim.kind === 'damage' && anim.player === acting && <span class="dmg">-{anim.amount}</span>}
        </span>
        <span class="hcount">{me.normalSummoned ? 'Summoned' : ''}</span>
      </div>
      <div class="hand">
        {me.hand.map((c) => (
          <div key={c.uid} data-uid={c.uid} class={`hcard ${highlight(c.uid)} ${anim?.uid === c.uid && anim.kind === 'draw' ? 'anim-draw' : ''}`} onClick={() => tap(c.uid)}>
            <CardImg name={c.name} back={!canAct && !spectator && !locked} owner={c.owner} />
          </div>
        ))}
        {me.hand.length === 0 && <div class="hint">No cards in hand</div>}
      </div>
      {renderWindow()}

      {overlays}
    </div>
  );
}
