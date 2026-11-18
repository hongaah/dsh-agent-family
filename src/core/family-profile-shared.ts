import type { FamilySharedProfile } from './types.ts';

export const EMPTY_FAMILY_PROFILE: FamilySharedProfile = {
  userName: '',
  userHonorific: '',
  sharedPrompt: '',
};

export function formatFamilySharedProfileSection(profile: FamilySharedProfile): string {
  const userName = profile.userName.trim();
  const honorific = profile.userHonorific.trim();
  const sharedPrompt = profile.sharedPrompt.trim();

  if (!userName && !honorific && !sharedPrompt) {
    return '';
  }

  const lines: string[] = ['【家庭主人与全员共享设定（全体家庭成员必读）】'];
  if (userName && honorific) {
    lines.push(
      `- 家庭主人姓名：${userName}；全家人日常对话、群聊与汇报时，请自然亲切地称呼他为「${honorific}」（不要生硬机械地叫“用户”或“人类”）。`
    );
  } else if (honorific) {
    lines.push(
      `- 全家人日常对话、群聊与汇报时，请自然亲切地称呼家庭主人为「${honorific}」（不要生硬机械地叫“用户”或“人类”）。`
    );
  } else if (userName) {
    lines.push(`- 家庭主人姓名：${userName}；交流时可直接自然称呼他的名字。`);
  }

  if (sharedPrompt) {
    lines.push('- 全体家庭成员共享提示词 / 家庭公约：');
    lines.push(sharedPrompt);
  }

  return lines.join('\n');
}

export function resolveHumanDisplayLabel(profile?: FamilySharedProfile): string {
  if (!profile) return '家庭主人（用户）';
  const honorific = profile.userHonorific.trim();
  const userName = profile.userName.trim();
  if (honorific && userName && honorific !== userName) {
    return `${honorific}（${userName}）`;
  }
  if (honorific) return honorific;
  if (userName) return userName;
  return '家庭主人（用户）';
}
