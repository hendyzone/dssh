import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { readTeamAvatarMailAnchor } from "./TeamMemberAvatar";
import type { OfficeMailEvent, OfficeMailView } from "../lib/teamOffice";
type Delivery = {
  event: OfficeMailEvent;
  landed: boolean;
  static: boolean;
};
type Point = {
  x: number;
  y: number;
  edge: boolean;
};
const labels: Record<string, string> = { ack: "确认", result: "结果", question: "提问" };
const symbols: Record<string, string> = { ack: "✓", result: "▣", question: "?" };
export const officeStationAnchor = (sourceId: string, memberId: string) => JSON.stringify([sourceId, memberId]);
/** Local presentation only: a new window/visible period establishes its own batch baseline. */
export default function OfficeMail({ mail, paused, motion, container, layoutKey, scale }: {
  mail?: OfficeMailView;
  paused: boolean;
  motion: boolean;
  container: RefObject<HTMLDivElement>;
  layoutKey: unknown;
  scale: 1 | 2 | 3;
}) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [overflow, setOverflow] = useState(0);
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [points, setPoints] = useState<Record<string, {
    from: Point;
    to: Point;
  }>>({});
  const consumed = useRef<{
    sequence: number;
    reset: number;
    paused: boolean;
  } | null>(null);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const active = useRef<Delivery[]>([]);
  const overflowTimer = useRef<ReturnType<typeof setTimeout>>();
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    active.current = [];
    setDeliveries([]);
    setOverflow(0);
  };
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media)
      return;
    const changed = () => setReduced(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (motion && !reduced)
      return;
    active.current = active.current.map(item => ({ ...item, static: true }));
    setDeliveries(active.current);
  }, [motion, reduced]);
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
  }, []);
  useEffect(() => {
    const previous = consumed.current;
    if (!mail) {
      consumed.current = null;
      clear();
      return;
    }
    consumed.current = {
      sequence: Math.max(previous?.sequence ?? 0, mail.sequence),
      reset: mail.reset,
      paused
    };
    if (paused || !previous || previous.paused || previous.reset !== mail.reset) {
      clear();
      return;
    }
    if (mail.sequence <= previous.sequence || mail.expiresAt <= Date.now())
      return;
    const fresh = mail.events;
    const available = Math.max(0, 5 - active.current.length);
    const added = fresh.slice(0, available).map(event => ({ event, landed: false, static: !motion || reduced }));
    active.current = [...active.current, ...added];
    setDeliveries(active.current);
    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        callback();
      }, delay);
      timers.current.add(timer);
      return timer;
    };
    for (const item of added) {
      schedule(() => {
        active.current = active.current.map(current =>
          current === item ? { ...current, landed: true } : current
        );
        setDeliveries(active.current);
      }, Math.min(1800, mail.expiresAt - Date.now()));
      schedule(() => {
        active.current = active.current.filter(current => current.event.id !== item.event.id);
        setDeliveries(active.current);
      }, Math.min(3800, mail.expiresAt - Date.now()));
    }
    const extra = Math.min(999, mail.overflow + Math.max(0, fresh.length - added.length));
    setOverflow(extra);
    if (extra) {
      if (overflowTimer.current) {
        clearTimeout(overflowTimer.current);
        timers.current.delete(overflowTimer.current);
      }
      overflowTimer.current = schedule(() => setOverflow(0), 3800);
    }
  }, [mail?.sequence, mail?.reset, paused]);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root || !deliveries.length)
      return;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const edge: Point = {
        x: Math.max(20, root.clientWidth - 15 * scale - 10),
        y: root.scrollTop + 24,
        edge: true
      };
      const locate = (endpoint: OfficeMailEvent["from"]): Point => {
        if (endpoint.kind !== "station")
          return edge;
        const key = officeStationAnchor(endpoint.sourceId, endpoint.memberId);
        const candidates = [...root.querySelectorAll<HTMLElement>("[data-office-station]")]
          .filter(el => el.dataset.officeStation === key);
        if (candidates.length !== 1)
          return edge;
        const station = candidates[0];
        const anchor = readTeamAvatarMailAnchor(station);
        if (!anchor || station.closest("[hidden]")
          || anchor.y <= bounds.top || anchor.y >= bounds.bottom
          || anchor.x <= bounds.left || anchor.x >= bounds.right)
          return edge;
        return {
          x: anchor.x - bounds.left - root.clientLeft + root.scrollLeft - 15 * scale / 2,
          y: anchor.y - bounds.top - root.clientTop + root.scrollTop - 14 * scale,
          edge: false
        };
      };
      const next: Record<string, {
        from: Point;
        to: Point;
      }> = {};
      for (const item of deliveries)
        next[item.event.id] = { from: locate(item.event.from), to: locate(item.event.to) };
      setPoints(next);
    };
    measure();
    root.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    observer?.observe(root);
    return () => {
      root.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [deliveries, layoutKey, container, scale]);
  const animate = motion && !reduced && !paused;
  return <div
    className="office-mail-layer"
    aria-live="polite"
    aria-atomic="false"
    data-mail-motion={animate ? "on" : "off"}
  >
    {deliveries.map(({ event, landed, static: stationary }) => {
      const route = points[event.id];
      if (!route)
        return null;
      const kind = event.kind && labels[event.kind] ? event.kind : "other";
      const style = {
        "--mail-scale": scale,
        "--mail-lane-x": `${Math.max(0, (container.current?.clientWidth ?? 0) - 15 * scale - 4)}px`,
        "--mail-from-x": `${route.from.x}px`,
        "--mail-from-y": `${route.from.y}px`,
        "--mail-to-x": `${route.to.x}px`,
        "--mail-to-y": `${route.to.y}px`
      } as CSSProperties;
      return <span
        key={event.id}
        className="office-flying-mail"
        data-event-id={event.id}
        data-kind={kind}
        data-landed={String(landed)}
        data-static={String(stationary)}
        data-from-edge={String(route.from.edge)}
        data-to-edge={String(route.to.edge)}
        style={style}
        role="img"
        aria-label={`${labels[kind] ?? "新"}邮件`}
      ><span aria-hidden="true">✉<b>{symbols[kind] ?? "·"}</b></span></span>;
    })}
    {overflow > 0 && <span className="office-mail-overflow" role="status">另有 +{overflow} 次投递</span>}
  </div>;
}
