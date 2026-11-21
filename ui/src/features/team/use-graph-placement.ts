import * as React from 'react';
import { canPlace, keyboardGraphMove, placeGraphNodes, type GraphBoxes, type GraphPositions, type Point } from './graph-model';

const directions: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
};

function svgPoint(event: React.PointerEvent<SVGGElement>): Point | undefined {
  const matrix = event.currentTarget.ownerSVGElement?.getScreenCTM();
  return matrix && new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) || undefined;
}

function readPositions(storageKey: string): GraphPositions {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

type Drag = {
  id: string;
  pointerId: number;
  pointerType: string;
  start: Point;
  screen: Point;
  origin: Point;
  last: Point;
  moved: boolean;
};

export function useGraphPlacement(storageKey: string, slots: GraphBoxes, height: number, svg: React.RefObject<SVGSVGElement | null>) {
  const [saved, setSaved] = React.useState(() => readPositions(storageKey));
  const [preview, setPreview] = React.useState<{ id: string; point: Point }>();
  const [notice, setNotice] = React.useState('');
  const drag = React.useRef<Drag | null>(null);
  const suppressClick = React.useRef(false);
  const scrollTo = React.useRef<SVGGElement | null>(null);
  const placed = React.useMemo(() => placeGraphNodes(slots, saved, height), [slots, saved, height]);
  const previewBox = preview && placed[preview.id] && { ...placed[preview.id], ...preview.point };
  const displayed = preview && previewBox && canPlace(previewBox, preview.id, slots, placed, height)
    ? { ...placed, [preview.id]: previewBox }
    : placed;

  React.useEffect(() => {
    const canvas = svg.current;
    // Chromium can start panning over SVG shapes despite touch-action on the node.
    const keepDragging = (event: TouchEvent) => {
      if (drag.current?.pointerType === 'touch' && event.cancelable) event.preventDefault();
    };
    canvas?.addEventListener('touchmove', keepDragging, { passive: false });
    return () => canvas?.removeEventListener('touchmove', keepDragging);
  }, [svg]);

  React.useLayoutEffect(() => {
    if (drag.current && !placed[drag.current.id]) {
      drag.current = null;
      setPreview(undefined);
    }
  }, [placed]);

  React.useLayoutEffect(() => {
    scrollTo.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scrollTo.current = null;
  }, [saved]);

  function save(next: GraphPositions) {
    setSaved(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }

  function move(id: string, label: string, point: Point) {
    const { x, y } = point;
    if (x === placed[id]?.x && y === placed[id]?.y) return;
    save({ ...saved, [id]: { x, y } });
    setNotice(`${label} moved to ${Math.round(x)} across, ${Math.round(y)} down.`);
  }

  function cancelDrag() {
    drag.current = null;
    setPreview(undefined);
  }

  function bind(id: string, label: string, open: () => void, onOtherKey?: (e: React.KeyboardEvent) => void): React.SVGProps<SVGGElement> {
    return {
      role: 'button',
      tabIndex: 0,
      'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight',
      className: `select-none outline-none [&:focus-visible>rect:first-child]:stroke-foreground ${preview?.id === id ? 'cursor-grabbing' : 'cursor-grab'}`,
      onPointerDown: (event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        const start = svgPoint(event);
        if (!start) return;
        suppressClick.current = false;
        const origin = placed[id];
        drag.current = { id, pointerId: event.pointerId, pointerType: event.pointerType, start, screen: { x: event.clientX, y: event.clientY }, origin, last: origin, moved: false };
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event) => {
        const current = drag.current;
        if (current?.id !== id || current.pointerId !== event.pointerId) return;
        if (!current.moved && Math.hypot(event.clientX - current.screen.x, event.clientY - current.screen.y) < 5) return;
        current.moved = true;
        suppressClick.current = true;
        const pointer = svgPoint(event);
        if (!pointer) return;
        const point = { x: current.origin.x + pointer.x - current.start.x, y: current.origin.y + pointer.y - current.start.y };
        if (canPlace({ ...placed[id], ...point }, id, slots, placed, height)) current.last = point;
        setPreview({ id, point: current.last });
      },
      onPointerUp: (event) => {
        const current = drag.current;
        if (current?.id !== id || current.pointerId !== event.pointerId) return;
        if (current.moved && canPlace({ ...placed[id], ...current.last }, id, slots, placed, height)) move(id, label, current.last);
        cancelDrag();
      },
      onPointerCancel: (event) => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); },
      onLostPointerCapture: (event) => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); },
      onClick: (event) => {
        if (event.detail > 0 && suppressClick.current) return;
        open();
      },
      onKeyDown: (event) => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          cancelDrag();
          setNotice('Move canceled.');
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (!drag.current && !event.repeat) open();
        } else if (Object.hasOwn(directions, event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          if (drag.current) return;
          const point = keyboardGraphMove(id, directions[event.key], slots, placed, height);
          if (point) {
            scrollTo.current = event.currentTarget;
            move(id, label, point);
          } else {
            setNotice(`No room to move ${label} ${event.key.slice(5).toLowerCase()}.`);
          }
        } else {
          onOtherKey?.(event);
        }
      },
    };
  }

  function reset() {
    cancelDrag();
    save({});
    setNotice('Graph layout reset.');
  }

  return { displayed, bind, notice, reset, canReset: Object.keys(saved).length > 0 };
}
