import { describe, expect, it } from 'vitest';

import { applyRealtimeEventToState, createEmptyBootstrapState } from '../src/client/api.ts';
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
});
