import { useEffect, useState } from 'react';

import type {
  BodyHealthStatus,
  BodyKind,
  CreateMemberInput,
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
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = typeof data.error === 'string' ? data.error : `请求失败 (${res.status})`;
    throw new Error(errMsg);
  }
  return data as unknown as T;
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
  }): Promise<{ finalText: string; snapshot: MemberRuntimeSnapshot }> {
    return requestJson<{ finalText: string; snapshot: MemberRuntimeSnapshot }>('/chat', {
      method: 'POST',
      body: JSON.stringify(params),
    });
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
  }): Promise<{ room: FamilyGroupRoom }> {
    return requestJson<{ room: FamilyGroupRoom }>('/groups/messages', {
      method: 'POST',
      body: JSON.stringify(params),
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
  private eventSource: EventSource | null = null;
  private readonly subscribers = new Set<() => void>();

  public getState(): FamilyBootstrapState {
    return this.state;
  }

  public subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    this.ensureStream();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0 && this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    };
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
    const es = new EventSource(`${API_BASE}/events`);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as FamilyRealtimeEvent;
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
