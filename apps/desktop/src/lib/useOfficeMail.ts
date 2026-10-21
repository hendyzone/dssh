import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { collaborationRequest, type CollaborationProfile, type CollaborationSession } from './collaboration';
import { initialMailMachine, nextMailRequest, officeMailSources, parseInboxHeaders, reduceOfficeMail, unavailableInbox, unsupportedInbox } from './teamOfficeMail';
import type { OfficeMailDirectory } from './teamOffice';
import type { ServerEntry } from '../types';
/** Only the main window mounts this scheduler. Physical calls retain their slot until settled. */
export function useOfficeMail({ profiles, servers, sessions, enabled, directory }: {
  profiles: Record<string, CollaborationProfile>;
  servers: ServerEntry[];
  sessions: CollaborationSession[];
  enabled: boolean;
  directory: MutableRefObject<OfficeMailDirectory>;
}) {
  const key = JSON.stringify([profiles, servers, sessions]);
  const sources = useMemo(() => officeMailSources(profiles, servers, sessions), [key]);
  const machine = useRef(initialMailMachine());
  const [view, setView] = useState(machine.current.view);
  const calls = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pump = useRef<() => void>(() => { });
  const apply = (action: Parameters<typeof reduceOfficeMail>[1]) => {
    machine.current = reduceOfficeMail(machine.current, action);
    if (batchTimer.current !== undefined && !machine.current.pending) {
      clearTimeout(batchTimer.current);
      batchTimer.current = undefined;
    }
    if (mounted.current && machine.current.pending && batchTimer.current === undefined) {
      // Fixed window, not debounce; 300ms exceeds the popup publisher's 250ms coalescing.
      batchTimer.current = setTimeout(() => {
        batchTimer.current = undefined;
        apply({ type: 'flush', now: Date.now() });
      }, 300);
    }
    if (mounted.current)
      setView(machine.current.view);
  };
  pump.current = () => {
    if (timer.current !== undefined)
      clearTimeout(timer.current);
    timer.current = undefined;
    if (!mounted.current || !machine.current.active)
      return;
    for (const source of sources) {
      if (calls.current.size >= 2)
        break;
      if (calls.current.has(source.id))
        continue;
      const request = nextMailRequest(machine.current, source.id, Date.now());
      if (!request || !source.backendId)
        continue;
      calls.current.add(source.id);
      void collaborationRequest(source.backendId, source.profile, { operation: 'inboxHeaders', afterUid: request.afterUid, ...(request.throughUid === undefined ? {} : { throughUid: request.throughUid }) }).then(raw => {
        try {
          apply({ type: 'page', request, page: parseInboxHeaders(raw, request.afterUid, request.throughUid), now: Date.now(), directory: directory.current });
        }
        catch {
          apply({ type: 'failure', request, unsupported: false, now: Date.now() });
        }
      }, error => apply({ type: 'failure', request, unsupported: unsupportedInbox(error), unavailable: unavailableInbox(error), now: Date.now() })).finally(() => {
        calls.current.delete(source.id);
        pump.current();
      });
    }
    const due = Object.entries(machine.current.sources).filter(([id, s]) => !calls.current.has(id) && s.available && !s.unsupported && (!s.partition || !machine.current.partitions[s.partition]?.owner || machine.current.partitions[s.partition].owner === id)).map(([, s]) => s.due);
    if (calls.current.size < 2 && due.length)
      timer.current = setTimeout(() => pump.current(), Math.max(1, Math.min(...due) - Date.now()));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (batchTimer.current !== undefined)
        clearTimeout(batchTimer.current);
      batchTimer.current = undefined;
      if (timer.current !== undefined)
        clearTimeout(timer.current);
      machine.current = reduceOfficeMail(machine.current, { type: 'configure', sources, active: false, now: Date.now() });
    };
  }, []);
  useEffect(() => {
    apply({ type: 'configure', sources, active: enabled, now: Date.now() });
    pump.current();
  }, [key, enabled]);
  return view;
}
