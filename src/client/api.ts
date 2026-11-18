import { useEffect, useState } from 'react';

import type {
  BodyHealthStatus,
  BodyKind,
  BodyModelCatalog,
  CreateMemberInput,
  FamilyFocusTarget,
  FamilyGroupRoom,
  FamilyMember,
  FamilyRealtimeEvent,
  MemberRuntimeSnapshot,
  PendingApproval,
  PhoneCallRecord,
  StarterMemberTemplate,
  UpdateMemberInput,
} from '../core/types.ts';

const API_BASE = '/dsh-agent-family/api';

export interface FamilyBootstrapState {
  readonly members: readonly FamilyMember[];
  readonly templates: readonly StarterMemberTemplate[];
  readonly bodies: readonly BodyHealthStatus[];
  readonly snapshots: readonly MemberRuntimeSnapshot[];
  readonly rooms: readonly FamilyGroupRoom[];
  readonly callRecords: readonly PhoneCallRecord[];
  readonly pendingApprovals: readonly PendingApproval[];
}

export function createEmptyBootstrapState(): FamilyBootstrapState {
  return {
    members: [],
    templates: [],
    bodies: [],
    snapshots: [],
    rooms: [],
    callRecords: [],
    pendingApprovals: [],
  };
}

export interface SessionFamilyActivitySummary {
  readonly kind: 'approval' | 'active' | 'unread' | 'idle';
  readonly shortLabel: string;
  readonly detailLabel: string;
  readonly totalUnread: number;
  readonly approvalCount: number;
}

export function deriveSessionFamilyActivity(
  state: FamilyBootstrapState,
  sessionId: string
): SessionFamilyActivitySummary {
  if (!sessionId || sessionId.startsWith('family-')) {
    return {
      kind: 'idle',
      shortLabel: '',
      detailLabel: '',
      totalUnread: 0,
      approvalCount: 0,
    };
  }

  const scopedApprovals = state.pendingApprovals.filter((a) => a.scopeId === sessionId);
  const rooms = state.rooms.filter((r) => r.scopeId === sessionId);
  const snaps = state.snapshots.filter((s) => s.scopeId === sessionId);

  const unreadRooms = rooms.reduce((sum, r) => sum + (r.unreadCount ?? 0), 0);
  const unreadMembers = snaps.reduce((sum, s) => sum + (s.unreadCount ?? 0), 0);
  const totalUnread = unreadRooms + unreadMembers;

  if (scopedApprovals.length > 0) {
    const first = scopedApprovals[0]!;
    const isAsk = Boolean(first.allowCustomInput);
    return {
      kind: 'approval',
      shortLabel: isAsk ? `${first.memberName}提问` : '待批示',
      detailLabel: isAsk
        ? `${first.memberName} 正在等待你的回答`
        : `${first.memberName} 请求执行批示 (${scopedApprovals.length})`,
      totalUnread,
      approvalCount: scopedApprovals.length,
    };
  }

  const runningRoom = rooms.find((r) => r.running);
  if (runningRoom) {
    const speakerName = runningRoom.activeSpeakerId
      ? state.members.find((m) => m.id === runningRoom.activeSpeakerId)?.name ??
        runningRoom.streamingDraft?.senderName ??
        runningRoom.activeSpeakerId
      : runningRoom.streamingDraft?.senderName ?? '';
    const shortLabel = speakerName ? `${speakerName}发言中` : '群聊进行中';
    return {
      kind: 'active',
      shortLabel,
      detailLabel: speakerName
        ? `${speakerName} 正在「${runningRoom.title.replace(/^🏠\s*/u, '')}」发言…`
        : `「${runningRoom.title.replace(/^🏠\s*/u, '')}」正在讨论…`,
      totalUnread,
      approvalCount: 0,
    };
  }

  const activeSnap = snaps.find(
    (s) => s.state === 'working' || s.state === 'in_call' || s.state === 'awaiting_approval'
  );
  if (activeSnap) {
    const memberName =
      state.members.find((m) => m.id === activeSnap.memberId)?.name ?? activeSnap.memberId;
    const actionWord = activeSnap.state === 'in_call' ? '通话中' : '执行中';
    return {
      kind: 'active',
      shortLabel: `${memberName}${actionWord}`,
      detailLabel: activeSnap.statusText
        ? `${memberName}：${activeSnap.statusText}`
        : `${memberName} 正在${actionWord}…`,
      totalUnread,
      approvalCount: 0,
    };
  }

  if (totalUnread > 0) {
    return {
      kind: 'unread',
      shortLabel: `${totalUnread} 未读`,
      detailLabel: `智能体家庭有 ${totalUnread} 条未读新消息`,
      totalUnread,
      approvalCount: 0,
    };
  }

  return {
    kind: 'idle',
    shortLabel: '',
    detailLabel: '',
    totalUnread: 0,
    approvalCount: 0,
  };
}

export function applyRealtimeEventToState(
  prev: FamilyBootstrapState,
  event: FamilyRealtimeEvent
): FamilyBootstrapState {
  switch (event.type) {
    case 'roster_updated':
      return {
        ...prev,
        members: event.members,
      };
    case 'member_runtime': {
      const idx = prev.snapshots.findIndex(
        (s) =>
          s.scopeId === event.snapshot.scopeId && s.memberId === event.snapshot.memberId
      );
      const nextSnapshots =
        idx === -1
          ? [...prev.snapshots, event.snapshot]
          : prev.snapshots.map((item, i) => (i === idx ? event.snapshot : item));
      return {
        ...prev,
        snapshots: nextSnapshots,
      };
    }
    case 'approval_opened': {
      const exists = prev.pendingApprovals.some(
        (a) => a.approvalId === event.approval.approvalId
      );
      return exists
        ? prev
        : {
            ...prev,
            pendingApprovals: [...prev.pendingApprovals, event.approval],
          };
    }
    case 'approval_closed':
      return {
        ...prev,
        pendingApprovals: prev.pendingApprovals.filter(
          (a) => a.approvalId !== event.approvalId
        ),
      };
    case 'phone_call_updated': {
      const idx = prev.callRecords.findIndex((r) => r.id === event.record.id);
      const nextCalls =
        idx === -1
          ? [...prev.callRecords.slice(-99), event.record]
          : prev.callRecords.map((item, i) => (i === idx ? event.record : item));
      return {
        ...prev,
        callRecords: nextCalls,
      };
    }
    case 'group_updated': {
      const idx = prev.rooms.findIndex(
        (r) => r.scopeId === event.room.scopeId && r.id === event.room.id
      );
      const nextRooms =
        idx === -1
          ? [...prev.rooms, event.room]
          : prev.rooms.map((item, i) => (i === idx ? event.room : item));
      return {
        ...prev,
        rooms: nextRooms,
      };
    }
    case 'focus_requested':
      return prev;
  }
}

function makeClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isTransientFetchError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /failed to fetch|networkerror|load failed|socket|econnreset/iu.test(msg);
}

export async function requestJsonWithRetry<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${API_BASE}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      const text = await res.text();
      const data = (text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;
      if (!res.ok) {
        const errMsg = typeof data.error === 'string' ? data.error : `请求失败 (${res.status})`;
        throw new Error(errMsg);
      }
      return data as unknown as T;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isTransientFetchError(err)) {
        await new Promise((r) => setTimeout(r, attempt * 60));
        continue;
      }
      if (isTransientFetchError(err)) {
        throw new Error('家庭后台连接瞬时中断，请再试一次（若刚重启客户端请稍候 1~2 秒）');
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJsonWithRetry<T>(path, init);
}

export const familyClientApi = {
  uploadAvatar(dataUrl: string): Promise<{ filename: string; url: string; mimeType: string }> {
    return requestJson<{ filename: string; url: string; mimeType: string }>('/avatars', {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    });
  },
  bootstrap(scopeId: string): Promise<FamilyBootstrapState> {
    const qs = new URLSearchParams({ scopeId }).toString();
    return requestJson<FamilyBootstrapState>(`/bootstrap?${qs}`);
  },
  probeBodies(): Promise<{ bodies: readonly BodyHealthStatus[] }> {
    return requestJson<{ bodies: readonly BodyHealthStatus[] }>('/probe', { method: 'POST' });
  },
  listBodyModels(
    kind: BodyKind,
    refresh: boolean = false
  ): Promise<{ catalog: BodyModelCatalog }> {
    const qs = new URLSearchParams({
      kind,
      ...(refresh ? { refresh: '1' } : {}),
    }).toString();
    return requestJson<{ catalog: BodyModelCatalog }>(`/models?${qs}`);
  },
  seedTemplates(preferredBody?: BodyKind): Promise<{ members: readonly FamilyMember[] }> {
    return requestJson<{ members: readonly FamilyMember[] }>('/members/seed', {
      method: 'POST',
      body: JSON.stringify({ preferredBody }),
    });
  },
  createMember(input: CreateMemberInput): Promise<{ member: FamilyMember; members: readonly FamilyMember[] }> {
    return requestJson<{ member: FamilyMember; members: readonly FamilyMember[] }>('/members', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateMember(
    id: string,
    patch: UpdateMemberInput
  ): Promise<{ member: FamilyMember; members: readonly FamilyMember[] }> {
    return requestJson<{ member: FamilyMember; members: readonly FamilyMember[] }>(
      `/members/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(patch),
      }
    );
  },
  deleteMember(id: string): Promise<{ removed: boolean; members: readonly FamilyMember[] }> {
    return requestJson<{ removed: boolean; members: readonly FamilyMember[] }>(
      `/members/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      }
    );
  },
  sendDirectChat(params: {
    scopeId: string;
    memberId: string;
    message: string;
    cwd?: string;
    fresh?: boolean;
  }): Promise<{ accepted?: boolean; finalText?: string; snapshot?: MemberRuntimeSnapshot }> {
    const clientRequestId = makeClientRequestId();
    return requestJson<{ accepted?: boolean; finalText?: string; snapshot?: MemberRuntimeSnapshot }>(
      '/chat',
      {
        method: 'POST',
        body: JSON.stringify({
          ...params,
          async: true,
          clientRequestId,
        }),
      }
    );
  },
  interrupt(params: {
    scopeId: string;
    memberId?: string;
    groupId?: string;
  }): Promise<{ memberInterrupted: boolean; groupInterrupted: boolean }> {
    return requestJson<{ memberInterrupted: boolean; groupInterrupted: boolean }>('/interrupt', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
  resetSession(scopeId: string, memberId: string): Promise<{ ok: boolean; snapshot: MemberRuntimeSnapshot }> {
    return requestJson<{ ok: boolean; snapshot: MemberRuntimeSnapshot }>('/reset-session', {
      method: 'POST',
      body: JSON.stringify({ scopeId, memberId }),
    });
  },
  clearHistory(params: {
    scopeId: string;
    memberId?: string;
    groupId?: string;
  }): Promise<{ ok: boolean; snapshot?: MemberRuntimeSnapshot; room?: FamilyGroupRoom }> {
    return requestJson<{ ok: boolean; snapshot?: MemberRuntimeSnapshot; room?: FamilyGroupRoom }>(
      '/clear-history',
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    );
  },
  markRead(params: {
    scopeId: string;
    groupId?: string;
    memberId?: string;
  }): Promise<{ ok: boolean; room?: FamilyGroupRoom; snapshot?: MemberRuntimeSnapshot }> {
    return requestJson<{ ok: boolean; room?: FamilyGroupRoom; snapshot?: MemberRuntimeSnapshot }>(
      '/mark-read',
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    );
  },
  deleteGroup(
    scopeId: string,
    groupId: string
  ): Promise<{ deleted: boolean; rooms: readonly FamilyGroupRoom[] }> {
    const qs = new URLSearchParams({ scopeId }).toString();
    return requestJson<{ deleted: boolean; rooms: readonly FamilyGroupRoom[] }>(
      `/groups/${encodeURIComponent(groupId)}?${qs}`,
      { method: 'DELETE' }
    );
  },
  createGroup(params: {
    scopeId: string;
    title: string;
    memberIds: readonly string[];
  }): Promise<{ room: FamilyGroupRoom; rooms: readonly FamilyGroupRoom[] }> {
    return requestJson<{ room: FamilyGroupRoom; rooms: readonly FamilyGroupRoom[] }>('/groups', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
  postGroupMessage(params: {
    scopeId: string;
    groupId: string;
    content: string;
    cwd?: string;
  }): Promise<{ accepted?: boolean; room?: FamilyGroupRoom }> {
    const clientRequestId = makeClientRequestId();
    return requestJson<{ accepted?: boolean; room?: FamilyGroupRoom }>('/groups/messages', {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        async: true,
        clientRequestId,
      }),
    });
  },
  replyApproval(
    approvalId: string,
    optionId: string
  ): Promise<{ applied: boolean; pendingApprovals: readonly PendingApproval[] }> {
    return requestJson<{ applied: boolean; pendingApprovals: readonly PendingApproval[] }>(
      '/approvals/reply',
      {
        method: 'POST',
        body: JSON.stringify({ approvalId, optionId }),
      }
    );
  },
};

class FamilyLiveClientStore {
  private state: FamilyBootstrapState = createEmptyBootstrapState();
  private activeScopeId = 'default';
  private initialBootstrapPromise: Promise<void> | null = null;
  private eventSource: EventSource | null = null;
  private readonly subscribers = new Set<() => void>();
  private readonly focusListeners = new Set<
    (scopeId: string, target: FamilyFocusTarget) => void
  >();

  public getState(): FamilyBootstrapState {
    return this.state;
  }

  public subscribeFocus(
    fn: (scopeId: string, target: FamilyFocusTarget) => void
  ): () => void {
    this.focusListeners.add(fn);
    this.ensureStream();
    return () => {
      this.focusListeners.delete(fn);
    };
  }

  public subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    this.ensureStream();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0 && this.focusListeners.size === 0 && this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    };
  }

  public ensureBootstrapped(): Promise<void> {
    if (!this.initialBootstrapPromise) {
      this.initialBootstrapPromise = this.refresh(this.activeScopeId).catch(() => {
        this.initialBootstrapPromise = null;
      });
    }
    return this.initialBootstrapPromise;
  }

  public async refresh(scopeId: string = this.activeScopeId): Promise<void> {
    this.activeScopeId = scopeId;
    const loaded = await familyClientApi.bootstrap(scopeId);
    this.state = loaded;
    this.notify();
  }

  public patchState(updater: (prev: FamilyBootstrapState) => FamilyBootstrapState): void {
    this.state = updater(this.state);
    this.notify();
  }

  private ensureStream(): void {
    if (this.eventSource || typeof EventSource === 'undefined') return;
    let openedOnce = false;
    const es = new EventSource(`${API_BASE}/events`);
    es.onopen = () => {
      if (openedOnce) {
        void this.refresh(this.activeScopeId).catch(() => undefined);
      }
      openedOnce = true;
    };
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as FamilyRealtimeEvent;
        if (parsed.type === 'focus_requested') {
          for (const fl of this.focusListeners) {
            fl(parsed.scopeId, parsed.target);
          }
          return;
        }
        this.state = applyRealtimeEventToState(this.state, parsed);
        this.notify();
      } catch {
        // ignore malformed event
      }
    };
    es.onerror = () => {
      // EventSource 自动重连
    };
    this.eventSource = es;
  }

  private notify(): void {
    for (const sub of this.subscribers) {
      sub();
    }
  }
}

export const familyLiveStore = new FamilyLiveClientStore();

export function useFamilyLiveState(scopeId: string): {
  state: FamilyBootstrapState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<FamilyBootstrapState>(() => familyLiveStore.getState());

  useEffect(() => {
    const unsub = familyLiveStore.subscribe(() => {
      setState(familyLiveStore.getState());
    });
    void familyLiveStore.refresh(scopeId).catch(() => undefined);
    return unsub;
  }, [scopeId]);

  return {
    state,
    refresh: () => familyLiveStore.refresh(scopeId),
  };
}

/**
 * 轻量全局状态订阅（供左侧边栏几十条会话行共享，零重复 HTTP 请求风暴）。
 */
export function useFamilyGlobalState(): FamilyBootstrapState {
  const [state, setState] = useState<FamilyBootstrapState>(() => familyLiveStore.getState());

  useEffect(() => {
    const unsub = familyLiveStore.subscribe(() => {
      setState(familyLiveStore.getState());
    });
    void familyLiveStore.ensureBootstrapped();
    return unsub;
  }, []);

  return state;
}
