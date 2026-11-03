// A card you can turn in your hand, as in Master Duel's card view: drag to tilt it (a light
// slides over its face as it turns), let go and it springs back. A tap without a drag is a tap.
// The angle is written straight to CSS variables: no re-render while the finger moves.
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import './tilt.css';

const MAX = 26;

export function TiltCard({ children, class: cls = '' }: { children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const aim = (rx: number, ry: number, gx: number, gy: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--rx', `${rx.toFixed(1)}deg`);
    el.style.setProperty('--ry', `${ry.toFixed(1)}deg`);
    el.style.setProperty('--gx', `${gx.toFixed(0)}%`);
    el.style.setProperty('--gy', `${gy.toFixed(0)}%`);
  };
  return (
    <div
      ref={ref}
      class={`tilt ${cls}`}
      onPointerDown={(ev) => {
        press.current = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, moved: false };
        moved.current = false;
        (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
        ref.current?.classList.add('held');
      }}
      onPointerMove={(ev) => {
        const p = press.current;
        const el = ref.current;
        if (!p || p.id !== ev.pointerId || !el) return;
        const dx = ev.clientX - p.x;
        const dy = ev.clientY - p.y;
        if (Math.hypot(dx, dy) > 8) p.moved = true;
        const r = el.getBoundingClientRect();
        const ry = Math.max(-MAX, Math.min(MAX, (dx / Math.max(1, r.width)) * 70));
        const rx = Math.max(-MAX, Math.min(MAX, (-dy / Math.max(1, r.height)) * 70));
        aim(rx, ry, 50 + ry * 2.2, 40 - rx * 2.2);
      }}
      onPointerUp={(ev) => {
        const p = press.current;
        if (!p || p.id !== ev.pointerId) return;
        moved.current = p.moved;
        press.current = null;
        ref.current?.classList.remove('held');
        aim(0, 0, 50, 30);
      }}
      onPointerCancel={() => {
        press.current = null;
        ref.current?.classList.remove('held');
        aim(0, 0, 50, 30);
      }}
      // a drag isn't a tap: the click that follows the finger lifting stops here
      onClickCapture={(ev) => {
        if (moved.current) (ev.stopPropagation(), ev.preventDefault(), (moved.current = false));
      }}
    >
      <div class="tilt-sway">
        <div class="tilt-in">
          {children}
          <i class="tilt-glare" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
