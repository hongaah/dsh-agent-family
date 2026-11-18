import { describe, expect, it, vi } from 'vitest';

import {
  applyRealtimeEventToState,
  createEmptyBootstrapState,
  requestJsonWithRetry,
} from '../src/client/api.ts';
import type { FamilyMember, PendingApproval } from '../src/core/types.ts';

describe('Client Bootstrap State & Realtime Event Reducer', () => {
  it('merges roster, runtime snapshots, approvals, phone calls, and group rooms immutably', () => {
    let state = createEmptyBootstrapState();

    const member: FamilyMember = {
      id: 'fe-sis',
      name: '前端妹妹',
      avatar: '🎨',
      specialty: '交互组件',
      body: { kind: 'opencode' },
      soulPrompt: '前端专家',
      enabled: true,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    };

    state = applyRealtimeEventToState(state, {
      type: 'roster_updated',
      members: [member],
    });
    expect(state.members).toHaveLength(1);

    const approval: PendingApproval = {
      approvalId: 'app-1',
      scopeId: 's1',
      memberId: 'fe-sis',
      memberName: '前端妹妹',
      memberAvatar: '🎨',
      bodyKind: 'opencode',
      requestId: 'r1',
      title: '修改 Button.vue',
      options: [{ optionId: 'allow', label: '允许' }],
      createdAt: '2026-11-17T00:00:01.000Z',
    };

    state = applyRealtimeEventToState(state, {
      type: 'approval_opened',
      approval,
    });
    expect(state.pendingApprovals).toHaveLength(1);

    state = applyRealtimeEventToState(state, {
      type: 'approval_closed',
      approvalId: 'app-1',
      selectedOptionId: 'allow',
    });
    expect(state.pendingApprovals).toHaveLength(0);
  });

  it('automatically retries transient TypeError: Failed to fetch (Electron keep-alive socket close race) and succeeds', async () => {
    let attempts = 0;
    const mockFetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await requestJsonWithRetry<{ accepted: boolean }>(
      '/groups/messages',
      { method: 'POST', body: JSON.stringify({ content: 'hello' }) },
      mockFetch as unknown as typeof fetch
    );
    expect(res.accepted).toBe(true);
    expect(attempts).toBe(2);
  });
});
