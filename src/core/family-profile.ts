import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EMPTY_FAMILY_PROFILE,
  formatFamilySharedProfileSection,
  resolveHumanDisplayLabel,
} from './family-profile-shared.ts';
import type { FamilySharedProfile, UpdateFamilyProfileInput } from './types.ts';

export {
  EMPTY_FAMILY_PROFILE,
  formatFamilySharedProfileSection,
  resolveHumanDisplayLabel,
};

/**
 * 负责持久化存储全体家庭成员共享的全局设定（`family-profile.json`）：
 * 包括用户名字、称呼方式、以及全员共享的全局提示词/家规。
 */
export class FamilyProfileStore {
  private readonly storageDir?: string;
  private profile: FamilySharedProfile = { ...EMPTY_FAMILY_PROFILE };
  private revision = 0;

  public constructor(storageDir?: string) {
    this.storageDir = storageDir;
    this.restoreFromDisk();
  }

  public get(): FamilySharedProfile {
    return this.profile;
  }

  public getRevision(): number {
    return this.revision;
  }

  public update(patch: UpdateFamilyProfileInput): FamilySharedProfile {
    const next: FamilySharedProfile = {
      userName:
        patch.userName !== undefined
          ? String(patch.userName).trim().slice(0, 80)
          : this.profile.userName,
      userHonorific:
        patch.userHonorific !== undefined
          ? String(patch.userHonorific).trim().slice(0, 80)
          : this.profile.userHonorific,
      sharedPrompt:
        patch.sharedPrompt !== undefined
          ? String(patch.sharedPrompt).trim().slice(0, 8000)
          : this.profile.sharedPrompt,
      updatedAt: new Date().toISOString(),
    };

    const changed =
      next.userName !== this.profile.userName ||
      next.userHonorific !== this.profile.userHonorific ||
      next.sharedPrompt !== this.profile.sharedPrompt;

    this.profile = next;
    if (changed) {
      this.revision += 1;
    }
    this.persistToDisk();
    return this.profile;
  }

  private persistToDisk(): void {
    if (!this.storageDir) return;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      const filePath = join(this.storageDir, 'family-profile.json');
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(
        tmpPath,
        `${JSON.stringify({ version: 1, profile: this.profile }, null, 2)}\n`,
        'utf8'
      );
      renameSync(tmpPath, filePath);
    } catch {
      // ignore disk failure in read-only environments
    }
  }

  private restoreFromDisk(): void {
    if (!this.storageDir) return;
    const filePath = join(this.storageDir, 'family-profile.json');
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const raw =
        parsed.profile && typeof parsed.profile === 'object'
          ? (parsed.profile as Record<string, unknown>)
          : parsed;
      this.profile = {
        userName: typeof raw.userName === 'string' ? raw.userName.trim() : '',
        userHonorific: typeof raw.userHonorific === 'string' ? raw.userHonorific.trim() : '',
        sharedPrompt: typeof raw.sharedPrompt === 'string' ? raw.sharedPrompt.trim() : '',
        ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
      };
      if (this.profile.userName || this.profile.userHonorific || this.profile.sharedPrompt) {
        this.revision = 1;
      }
    } catch {
      // ignore corrupted profile
    }
  }
}
