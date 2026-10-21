import { collaborationKey, type CollaborationProfile, type CollaborationSession } from './collaboration';
import { officeKey, officeMailBindingKey, officeMailAddress, type OfficeMailDirectory, type OfficeMailEvent, type OfficeMailView } from './teamOffice';
import { sameSshEndpoint } from './tmuxTabs';
import type { ServerEntry } from '../types';

// Five visible envelopes plus the maximum displayed overflow of 999.
const MAX_MAIL_BATCH_COUNT = 5 + 999;

export interface MailSource {
  id: string;
  config: string;
  backendId?: string;
  profile: CollaborationProfile;
}
export function officeMailSources(profiles: Record<string, CollaborationProfile>, servers: ServerEntry[], sessions: CollaborationSession[]): MailSource[] {
  const result = new Map<string, MailSource>();
  for (const [key, profile] of Object.entries(profiles)) {
    if (!profile.enabled || !profile.mailEnabled)
      continue;
    const server = [...servers, ...sessions.map(s => s.pane.server)].find(s => collaborationKey(s.id, profile) === key);
    const routes = server ? sessions.filter(s => s.backendId && sameSshEndpoint(server, s.pane.server)) : [];
    const route = routes.find(s => s.pane.tmux?.id === profile.tmuxId && s.pane.tmux.created === profile.tmuxCreated) ?? routes[0];
    const id = officeMailBindingKey(server, profile, key);
    const source = { id, config: JSON.stringify([route?.backendId, profile]), backendId: route?.backendId, profile };
    if (!result.has(id) || source.backendId)
      result.set(id, source);
  }
  return [...result.values()];
}
interface Header {
  uid: number;
  from: string | null;
  to: string[];
  kind: string | null;
}
export interface InboxHeadersPage {
  namespace: string;
  account: string;
  maximum: number;
  highwater: number;
  next: number;
  complete: boolean;
  messages: Header[];
}
const uint = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 4294967295;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const address = (v: unknown): v is string => typeof v === 'string' && v.length <= 320;
export function parseInboxHeaders(raw: string, after: number, through?: number): InboxHeadersPage {
  const p: unknown = JSON.parse(raw);
  if (!record(p) || p.schema !== 'amail.inbox.headers.v1' || !record(p.namespace))
    throw Error('Invalid inbox schema');
  const n = p.namespace;
  if (!address(n.server) || !n.server.trim() || !address(n.account) || !n.account.trim() || !address(n.mailbox) || !n.mailbox.trim() || !uint(n.port) || !n.port || n.port > 65535 || !uint(p.uidvalidity) || !p.uidvalidity)
    throw Error('Invalid mailbox identity');
  if (!uint(p.max_uid) || !uint(p.highwater_uid) || !uint(p.next_after_uid) || typeof p.complete !== 'boolean' || typeof p.has_more !== 'boolean' || p.complete === p.has_more || !Array.isArray(p.errors) || p.errors.length > 1 || !Array.isArray(p.messages) || p.messages.length > 100)
    throw Error('Incomplete inbox response');
  if ((through !== undefined && p.highwater_uid !== through) || (through === undefined && p.highwater_uid !== p.max_uid) || p.next_after_uid < after || (!p.complete && !p.errors.length && p.next_after_uid <= after) || p.next_after_uid > Math.max(after, p.highwater_uid))
    throw Error('Invalid inbox cursor');
  const next = p.next_after_uid, highwater = p.highwater_uid;
  let previous = after;
  const messages = p.messages.map((m: unknown): Header => {
    if (!record(m) || !uint(m.uid) || m.uid <= previous || m.uid > next || m.uid > highwater || (m.from !== null && !address(m.from)) || !Array.isArray(m.to) || m.to.length > 1000 || !m.to.every(address) || (m.kind !== null && (typeof m.kind !== 'string' || m.kind.length > 64)))
      throw Error('Invalid inbox header');
    previous = m.uid;
    const known = ['request', 'ack', 'progress', 'blocked', 'handoff', 'result', 'question', 'answer'];
    const kind = m.kind === 'ping' && m.classification_source === 'heartbeat_header' ? 'ping' : known.includes(String(m.kind)) ? m.kind as string : null;
    return { uid: m.uid, from: m.from as string | null, to: m.to as string[], kind };
  });
  let cursor = next;
  if (p.errors.length) {
    const error: unknown = p.errors[0];
    if (!record(error) || !["invalid_header", "missing_header"].includes(String(error.code))
      || !uint(error.uid) || error.uid <= next || error.uid <= after || error.uid > highwater
      || p.complete || !p.has_more)
      throw Error("Unsafe inbox error");
    // The header-only inbox response reports the first failed SEARCH UID. Numeric gaps are legal after expunge.
    cursor = error.uid;
  }
  return { namespace: JSON.stringify([n.server, n.port, n.account, n.mailbox, p.uidvalidity]), account: n.account, maximum: p.max_uid, highwater: p.highwater_uid, next: cursor, complete: p.complete, messages };
}
export function unsupportedInbox(error: unknown): boolean {
  const text = String(error);
  return /(?:协作服务|本地) 操作失败：/.test(text) && /usage:[^\r\n]*mailctl/.test(text) && /error: unrecognized arguments:[^\r\n]*(?:--json|--headers-only)/.test(text);
}
export function unavailableInbox(error: unknown): boolean {
  const text = String(error);
  return /(?:协作服务|本地) 操作失败：/.test(text) && /mailbox is not provisioned/i.test(text);
}
interface Candidate {
  uid: number;
  from: string | null;
  kind: string | null;
}
interface Transaction {
  namespace: string;
  highwater: number;
  next: number;
  candidates: Candidate[];
  count: number;
}
interface SourceState {
  incarnation: number;
  config: string;
  available: boolean;
  partition?: string;
  tx?: Transaction;
  due: number;
  failures: number;
  pages: number;
  unsupported: boolean;
  unavailable: boolean;
}
interface Partition {
  committed: number;
  initialized: boolean;
  baseline: boolean;
  owner?: string;
}
export interface MailMachine {
  serial: number;
  active: boolean;
  generation: number;
  sources: Record<string, SourceState>;
  partitions: Record<string, Partition>;
  pending?: {
    events: OfficeMailEvent[];
    count: number;
  };
  view: OfficeMailView;
}
export interface MailRequest {
  incarnation: number;
  sourceId: string;
  config: string;
  generation: number;
  afterUid: number;
  throughUid?: number;
}
export function initialMailMachine(): MailMachine { return { serial: 0, active: false, generation: 0, sources: {}, partitions: {}, view: { sequence: 0, reset: 0, expiresAt: 0, events: [], overflow: 0, availability: 'unavailable' } }; }
type Action = {
  type: 'flush';
  now: number;
} | {
  type: 'configure';
  sources: MailSource[];
  active: boolean;
  now: number;
} | {
  type: 'page';
  request: MailRequest;
  page: InboxHeadersPage;
  now: number;
  directory: OfficeMailDirectory;
} | {
  type: 'failure';
  request: MailRequest;
  unsupported: boolean;
  unavailable?: boolean;
  now: number;
};
export function nextMailRequest(state: MailMachine, id: string, now: number): MailRequest | undefined {
  const s = state.sources[id], p = s?.partition ? state.partitions[s.partition] : undefined;
  if (!state.active || !s || !s.available || s.unsupported || s.due > now || (p?.owner && p.owner !== id))
    return;
  return { incarnation: s.incarnation, sourceId: id, config: s.config, generation: state.generation, afterUid: s.tx?.next ?? p?.committed ?? 0, ...(s.tx ? { throughUid: s.tx.highwater } : {}) };
}
/** Incremental transactions commit on their final page; a first valid page silently baselines its observed maximum. */
export function reduceOfficeMail(old: MailMachine, action: Action): MailMachine {
  const state: MailMachine = { ...old, sources: Object.fromEntries(Object.entries(old.sources).map(([id, s]) => [id, { ...s, tx: s.tx ? { ...s.tx, candidates: [...s.tx.candidates] } : undefined }])), partitions: Object.fromEntries(Object.entries(old.partitions).map(([id, p]) => [id, { ...p }])), view: { ...old.view } };
  if (action.type === 'flush') {
    if (!state.active || !state.pending)
      return old;
    state.view = { ...state.view, sequence: state.view.sequence + 1, events: state.pending.events,
      overflow: Math.max(0, state.pending.count - state.pending.events.length), expiresAt: action.now + 6000 };
    state.pending = undefined;
  }
  else if (action.type === 'configure') {
    const selected = new Set(action.sources.map(s => s.id));
    for (const [id, s] of Object.entries(state.sources))
      if (!selected.has(id) || action.sources.find(x => x.id === id)?.config !== s.config) {
        if (s.partition && state.partitions[s.partition]?.owner === id)
          state.partitions[s.partition].owner = undefined;
        delete state.sources[id];
        if (state.pending) {
          state.pending = undefined;
          state.view = { ...state.view, reset: state.view.reset + 1, events: [], overflow: 0, expiresAt: 0 };
        }
      }
    for (const s of action.sources)
      state.sources[s.id] ??= { incarnation: ++state.serial, config: s.config, available: !!s.backendId, due: action.now, failures: 0, pages: 0, unsupported: false, unavailable: false };
    if (state.active && !action.active) {
      state.generation++;
      state.pending = undefined;
      for (const s of Object.values(state.sources)) {
        s.tx = undefined;
        s.pages = 0;
        s.due = action.now;
      }
      for (const p of Object.values(state.partitions))
        p.baseline = true;
      state.view = { ...state.view, reset: state.view.reset + 1, events: [], overflow: 0, expiresAt: 0 };
    }
    state.active = action.active;
    for (const key of Object.keys(state.partitions))
      if (!Object.values(state.sources).some(s => s.partition === key))
        delete state.partitions[key];
  }
  else {
    const { request } = action, s = state.sources[request.sourceId];
    if (!state.active || request.generation !== state.generation || !s || s.incarnation !== request.incarnation || s.config !== request.config)
      return old;
    if (action.type === 'failure') {
      s.tx = undefined;
      s.pages = 0;
      s.failures = action.unavailable ? 0 : s.failures + 1;
      s.unsupported = action.unsupported;
      s.unavailable = !!action.unavailable;
      s.due = action.now + (s.unavailable ? 300 : Math.min(300, 30 * 2 ** Math.min(s.failures - 1, 4))) * 1000;
    }
    else {
      const { page } = action;
      s.unavailable = false;
      if (s.tx && s.tx.namespace !== page.namespace) {
        s.tx = undefined;
        s.pages = 0;
      }
      const changed = !!s.partition && s.partition !== page.namespace;
      if (changed && state.partitions[s.partition!]?.owner === request.sourceId)
        state.partitions[s.partition!].owner = undefined;
      s.partition = page.namespace;
      const p = state.partitions[page.namespace] ??= { committed: 0, initialized: false, baseline: true };
      if (p.owner && p.owner !== request.sourceId) {
        s.tx = undefined;
        s.due = action.now + 30000;
      }
      else {
        p.owner = request.sourceId;
        if (changed || p.baseline || !p.initialized) {
          // A trustworthy first page already carries the observed maximum: never scan history.
          p.committed = Math.max(p.committed, page.maximum);
          p.initialized = true;
          p.baseline = false;
          s.tx = undefined;
          s.pages = 0;
          s.failures = 0;
          s.due = action.now + 30000;
          if (changed) {
            state.pending = undefined;
            state.view = { ...state.view, reset: state.view.reset + 1, events: [], overflow: 0, expiresAt: 0 };
          }
        }
        else if (!s.tx && request.afterUid < p.committed) {
          s.tx = undefined;
          s.due = action.now;
          s.pages = 0;
        }
        else {
          const tx = s.tx ?? { namespace: page.namespace, highwater: page.highwater,
            next: request.afterUid, candidates: [], count: 0 };
          if (tx.highwater !== page.highwater)
            return reduceOfficeMail(old, { type: 'failure', request, unsupported: false, now: action.now });
          for (const message of page.messages) {
            if (message.kind === 'ping')
              continue;
            tx.count = Math.min(MAX_MAIL_BATCH_COUNT, tx.count + 1);
            if (tx.candidates.length < 5)
              tx.candidates.push({ uid: message.uid, from: message.from, kind: message.kind });
          }
          tx.next = page.next;
          s.pages++;
          s.unsupported = false;
          if (page.complete) {
            s.failures = 0;
            p.committed = Math.max(p.committed, page.highwater);
            s.tx = undefined;
            s.pages = 0;
            s.due = action.now + 30000;
            if (tx.count) {
              const endpoint = (address: string | null) => {
                const found = address ? action.directory.get(officeMailAddress(address)) : undefined;
                return found?.length === 1 ? found[0] : { kind: 'edge' as const };
              };
              const owner = officeMailOwner(action.directory, page.account);
              if (!owner)
                return finishAvailability(state);
              const events: OfficeMailEvent[] = tx.candidates.map(candidate => ({
                id: officeKey(JSON.stringify([page.namespace, candidate.uid])), uid: candidate.uid,
                kind: candidate.kind, from: endpoint(candidate.from), to: owner,
              }));
              const pending = state.pending ?? { events: [], count: 0 };
              state.pending = { events: [...pending.events, ...events].slice(0, 5), count: Math.min(MAX_MAIL_BATCH_COUNT, pending.count + tx.count) };
            }
          }
          else {
            s.tx = tx;
            s.due = s.pages >= 5 ? action.now + 30000 : action.now;
            if (s.pages >= 5)
              s.pages = 0;
          }
        }
      }
    }
  }
  return finishAvailability(state);
}
function finishAvailability(state: MailMachine): MailMachine {
  for (const key of Object.keys(state.partitions))
    if (!Object.values(state.sources).some(s => s.partition === key))
      delete state.partitions[key];
  const sources = Object.entries(state.sources).filter(([id, s]) => s.available && !s.unsupported && !s.unavailable
    && (!s.partition || !state.partitions[s.partition]?.owner || state.partitions[s.partition].owner === id)).map(([, s]) => s);
  state.view.availability = !state.active || !sources.length ? 'unavailable' : sources.some(s => !s.failures && s.partition && state.partitions[s.partition]?.initialized) ? 'ready' : sources.some(s => s.failures) ? 'error' : 'loading';
  return state;
}
/** Only the actual mailbox account selects the destination; To/Cc and roles are irrelevant. */
export function officeMailOwner(directory: OfficeMailDirectory, account: string) {
  const matches = directory.get(officeMailAddress(account));
  return matches?.length === 1 ? matches[0] : undefined;
}
