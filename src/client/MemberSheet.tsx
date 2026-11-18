import { ChevronDown, ChevronRight, RefreshCw, RotateCcw, Search, Upload, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { defaultLobeAvatarForBody } from '../core/avatar-spec.ts';
import { PERMISSION_MODE_METAS } from '../core/permission-policy.ts';
import {
  BODY_KINDS,
  type BodyHealthStatus,
  type BodyKind,
  type FamilyMember,
  type PermissionMode,
  type StarterMemberTemplate,
} from '../core/types.ts';
import { familyClientApi } from './api.ts';
import {
  isPhotoAvatarUrl,
  LOBE_VENDOR_ICONS,
  MemberAvatar,
  prepareUploadedPhotoDataUrl,
} from './MemberAvatar.tsx';
import { EFFORT_PRESETS, PermissionModeIcon, useBodyModelCatalog } from './ModelQuickPopover.tsx';

export interface MemberSheetProps {
  readonly open: boolean;
  readonly editingMember: FamilyMember | null;
  readonly templates: readonly StarterMemberTemplate[];
  readonly bodies: readonly BodyHealthStatus[];
  readonly onClose: () => void;
  readonly onSaved: (member: FamilyMember) => void;
}

export function MemberSheet({
  open,
  editingMember,
  templates,
  bodies,
  onClose,
  onSaved,
}: MemberSheetProps): React.ReactElement | null {
  const firstAvailableBody = useMemo<BodyKind>(
    () => bodies.find((b) => b.available)?.kind ?? 'claude',
    [bodies]
  );

  const [formId, setFormId] = useState<string>('');
  const [formName, setFormName] = useState<string>('');
  const [formAvatar, setFormAvatar] = useState<string>('lobe:claudecode');
  const [avatarManuallyChosen, setAvatarManuallyChosen] = useState<boolean>(false);
  const [formSpecialty, setFormSpecialty] = useState<string>('');
  const [formBodyKind, setFormBodyKind] = useState<BodyKind>('claude');
  const [formPermissionMode, setFormPermissionMode] = useState<PermissionMode>('auto');
  const [formModel, setFormModel] = useState<string>('');
  const [formEffort, setFormEffort] = useState<string>('');
  const [formCommand, setFormCommand] = useState<string>('');
  const [formExtraArgs, setFormExtraArgs] = useState<string>('');
  const [formSoulPrompt, setFormSoulPrompt] = useState<string>('');
  const [iconQuery, setIconQuery] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [uploadingPhoto, setUploadingPhoto] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { catalog: modelCatalog, loading: loadingModels, reload: reloadModels } =
    useBodyModelCatalog(formBodyKind, open);

  useEffect(() => {
    if (!open) return;
    setErrorText(null);
    setIconQuery('');
    if (editingMember) {
      setFormId(editingMember.id);
      setFormName(editingMember.name);
      setFormAvatar(editingMember.avatar);
      setAvatarManuallyChosen(true);
      setFormSpecialty(editingMember.specialty);
      setFormBodyKind(editingMember.body.kind);
      setFormPermissionMode(editingMember.body.permissionMode ?? 'ask');
      setFormModel(editingMember.body.model ?? '');
      setFormEffort(editingMember.body.reasoningEffort ?? '');
      setFormCommand(editingMember.body.command ?? '');
      setFormExtraArgs((editingMember.body.extraArgs ?? []).join(' '));
      setFormSoulPrompt(editingMember.soulPrompt);
      setShowAdvanced(
        Boolean(editingMember.body.command || (editingMember.body.extraArgs?.length ?? 0) > 0)
      );
    } else {
      setFormId('');
      setFormName('');
      setFormBodyKind(firstAvailableBody);
      setFormPermissionMode('auto');
      setFormModel('');
      setFormEffort('');
      setFormAvatar(defaultLobeAvatarForBody(firstAvailableBody));
      setAvatarManuallyChosen(false);
      setFormSpecialty('');
      setFormCommand('');
      setFormExtraArgs('');
      setFormSoulPrompt('');
      setShowAdvanced(false);
    }
  }, [open, editingMember, firstAvailableBody]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filteredIcons = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    if (!q) return LOBE_VENDOR_ICONS;
    return LOBE_VENDOR_ICONS.filter(
      (item) => item.label.toLowerCase().includes(q) || item.key.toLowerCase().includes(q)
    );
  }, [iconQuery]);

  if (!open) return null;

  const applyTemplate = (tpl: StarterMemberTemplate) => {
    if (!editingMember) setFormId(tpl.id);
    setFormName(tpl.name);
    setFormAvatar(tpl.avatar);
    setAvatarManuallyChosen(true);
    setFormSpecialty(tpl.specialty);
    setFormBodyKind(tpl.recommendedBody);
    setFormSoulPrompt(tpl.soulPrompt);
  };

  const handleUploadFile = async (file: File) => {
    setErrorText(null);
    setUploadingPhoto(true);
    try {
      const prepared = await prepareUploadedPhotoDataUrl(file);
      const uploaded = await familyClientApi.uploadAvatar(prepared);
      setFormAvatar(uploaded.url);
      setAvatarManuallyChosen(true);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErrorText(null);
    setSaving(true);
    const parsedArgs = formExtraArgs
      .split(/\s+/u)
      .map((s) => s.trim())
      .filter(Boolean);
    const bodySpec = {
      kind: formBodyKind,
      permissionMode: formPermissionMode,
      ...(formModel.trim() ? { model: formModel.trim() } : {}),
      ...(formEffort.trim() ? { reasoningEffort: formEffort.trim() } : {}),
      ...(formCommand.trim() ? { command: formCommand.trim() } : {}),
      ...(parsedArgs.length > 0 ? { extraArgs: parsedArgs } : {}),
    };

    try {
      if (editingMember) {
        const res = await familyClientApi.updateMember(editingMember.id, {
          name: formName,
          avatar: formAvatar,
          specialty: formSpecialty,
          body: bodySpec,
          soulPrompt: formSoulPrompt,
        });
        onSaved(res.member);
      } else {
        const res = await familyClientApi.createMember({
          id: formId,
          name: formName,
          avatar: formAvatar,
          specialty: formSpecialty,
          body: bodySpec,
          soulPrompt: formSoulPrompt,
        });
        onSaved(res.member);
      }
      onClose();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="sh-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sh-sheet" role="dialog" aria-modal="true" aria-label="配置家庭成员">
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--sh-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {editingMember ? `编辑家庭成员 · ${editingMember.name}` : '创造新家庭成员'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--sh-muted-fg)', marginTop: 2 }}>
              绑定本机 CLI 身体并注入灵魂准则，内部记忆与审批意志完全归成员自身所有
            </div>
          </div>
          <button
            type="button"
            className="sh-btn sh-btn-ghost sh-btn-icon"
            aria-label="关闭抽屉"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {errorText && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                background: 'var(--sh-destructive-soft)',
                color: 'var(--sh-destructive)',
                fontSize: 12.5,
              }}
            >
              {errorText}
            </div>
          )}

          {!editingMember && templates.length > 0 && (
            <div>
              <span className="sh-label">快速套用预设角色模板</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="dshfam-chip"
                    onClick={() => applyTemplate(tpl)}
                  >
                    <MemberAvatar
                      avatar={tpl.avatar}
                      bodyKind={tpl.recommendedBody}
                      alt={tpl.name}
                      size={15}
                    />
                    <span>{tpl.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 头像与照片上传卡片 */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) void handleUploadFile(dropped);
            }}
            style={{
              padding: 13,
              borderRadius: 10,
              border: `1px ${dragOver ? 'dashed var(--sh-fg)' : 'solid var(--sh-border)'}`,
              background: 'var(--sh-sidebar)',
              display: 'flex',
              flexDirection: 'column',
              gap: 11,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <MemberAvatar
                  avatar={formAvatar}
                  bodyKind={formBodyKind}
                  alt={formName || '预览'}
                  size={48}
                />
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>头像与品牌标识</div>
                  <div style={{ fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>
                    {isPhotoAvatarUrl(formAvatar)
                      ? '自定义照片（支持拖拽替换，自动居中裁剪 256×256）'
                      : `LobeHub 厂商矢量图标 (${formAvatar.replace('lobe:', '')})`}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void handleUploadFile(f);
                  }}
                />
                <button
                  type="button"
                  className="sh-btn sh-btn-outline sh-btn-sm"
                  disabled={uploadingPhoto}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={13} />
                  <span>{uploadingPhoto ? '处理中…' : '上传照片'}</span>
                </button>
                <button
                  type="button"
                  className="sh-btn sh-btn-ghost sh-btn-sm"
                  title="恢复当前身体的默认厂商图标"
                  onClick={() => {
                    setFormAvatar(defaultLobeAvatarForBody(formBodyKind));
                    setAvatarManuallyChosen(false);
                  }}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            </div>

            <div style={{ position: 'relative' }}>
              <Search
                size={13}
                style={{
                  position: 'absolute',
                  left: 9,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--sh-muted-fg)',
                }}
              />
              <input
                className="sh-input"
                style={{ height: 29, paddingLeft: 28, fontSize: 12 }}
                placeholder="筛选 Lobe Icons 厂商图标（如 DeepSeek, Claude, Codex, OpenCode, Qwen…）"
                value={iconQuery}
                onChange={(e) => setIconQuery(e.target.value)}
              />
            </div>

            <div className="dshfam-icon-grid" style={{ maxHeight: 132, overflowY: 'auto' }}>
              {filteredIcons.map((icon) => (
                <button
                  key={icon.key}
                  type="button"
                  className="dshfam-icon-option"
                  data-selected={String(formAvatar === icon.key)}
                  onClick={() => {
                    setFormAvatar(icon.key);
                    setAvatarManuallyChosen(true);
                  }}
                >
                  <MemberAvatar avatar={icon.key} alt={icon.label} size={18} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {icon.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="sh-label">唯一代号 ID（用于 @点名）</label>
              <input
                className="sh-input"
                disabled={Boolean(editingMember)}
                placeholder="如 fe-claude、arch-bro"
                value={formId}
                onChange={(e) => setFormId(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="sh-label">家庭称呼</label>
              <input
                className="sh-input"
                placeholder="如 大前端、架构师大哥"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label className="sh-label">连接身体（本机 CLI 运行时）</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {BODY_KINDS.map((kind) => {
                const probe = bodies.find((b) => b.kind === kind);
                const selected = formBodyKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      if (formBodyKind !== kind) {
                        setFormBodyKind(kind);
                        setFormModel('');
                        setFormEffort('');
                      }
                      if (!avatarManuallyChosen) {
                        setFormAvatar(defaultLobeAvatarForBody(kind));
                      }
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: `1px solid ${selected ? 'var(--sh-fg)' : 'var(--sh-border)'}`,
                      background: selected ? 'var(--sh-accent)' : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <MemberAvatar avatar={defaultLobeAvatarForBody(kind)} bodyKind={kind} size={20} />
                      <span
                        className="dshfam-dot"
                        data-state={probe?.available ? 'working' : 'sleeping'}
                      />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{kind}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 执行权限模式卡片（每次询问 / 自动模式 / 完全访问） */}
          <div>
            <label className="sh-label">执行权限模式</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {PERMISSION_MODE_METAS.map((pm) => {
                const selected = formPermissionMode === pm.value;
                return (
                  <button
                    key={pm.value}
                    type="button"
                    onClick={() => setFormPermissionMode(pm.value)}
                    style={{
                      padding: '9px 10px',
                      borderRadius: 8,
                      border: `1px solid ${selected ? 'var(--sh-fg)' : 'var(--sh-border)'}`,
                      background: selected ? 'var(--sh-accent)' : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 4,
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
                      <PermissionModeIcon mode={pm.value} size={13} />
                      <span>{pm.shortLabel}</span>
                    </div>
                    <span style={{ fontSize: 10.5, color: 'var(--sh-muted-fg)', lineHeight: 1.4 }}>
                      {pm.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 模型与思考快慢配置卡片 */}
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--sh-border)',
              background: 'var(--sh-sidebar)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                  大脑模型与思考快慢（可选）
                </div>
                <div style={{ fontSize: 11, color: 'var(--sh-muted-fg)' }}>
                  留空则跟随 {formBodyKind} 默认配置
                  {modelCatalog?.currentDefault ? ` (${modelCatalog.currentDefault})` : ''}
                  ；怕慢可选 Flash / Mini / Haiku 或极速档位
                </div>
              </div>
              <button
                type="button"
                className="sh-btn sh-btn-ghost sh-btn-icon"
                style={{ width: 26, height: 26 }}
                disabled={loadingModels}
                title="重新读取本机 CLI 可用模型"
                onClick={() => void reloadModels()}
              >
                <RefreshCw size={12} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
              <select
                aria-label="快速选择本机 CLI 模型"
                className="sh-select"
                value={
                  (modelCatalog?.models ?? []).some((m) => m.id === formModel) ? formModel : '__custom__'
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__custom__') return;
                  setFormModel(val);
                }}
              >
                <option value="">跟随 {formBodyKind} 默认模型</option>
                {(modelCatalog?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.isFast ? '⚡ ' : ''}
                    {m.id}
                    {m.label && m.label !== m.id ? ` — ${m.label}` : ''}
                  </option>
                ))}
                {formModel && !(modelCatalog?.models ?? []).some((m) => m.id === formModel) && (
                  <option value="__custom__">自定义: {formModel}</option>
                )}
              </select>

              <input
                className="sh-input"
                style={{ height: 30, fontSize: 12 }}
                placeholder="也可直接输入任意模型 ID（留空使用 CLI 默认）"
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
              />
            </div>

            {(!modelCatalog || modelCatalog.supportsEffort) && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--sh-muted-fg)', marginBottom: 5 }}>
                  思考快慢（Reasoning Effort）
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5 }}>
                  {EFFORT_PRESETS.map((preset) => {
                    const active = formEffort === preset.value;
                    return (
                      <button
                        key={preset.value || 'default'}
                        type="button"
                        title={preset.title}
                        onClick={() => setFormEffort(preset.value)}
                        style={{
                          height: 28,
                          borderRadius: 6,
                          border: `1px solid ${active ? 'var(--sh-fg)' : 'var(--sh-border)'}`,
                          background: active ? 'var(--sh-card)' : 'transparent',
                          color: active ? 'var(--sh-fg)' : 'var(--sh-muted-fg)',
                          fontSize: 11.5,
                          fontWeight: active ? 600 : 500,
                          cursor: 'pointer',
                        }}
                      >
                        {preset.shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="sh-label">专长与职责定位（同伴通过手机通讯录按此找人协作）</label>
            <input
              className="sh-input"
              placeholder="如：前端负责人，把控架构、类型规范与交互体验"
              value={formSpecialty}
              onChange={(e) => setFormSpecialty(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="sh-label">灵魂提示词（Soul Prompt）</label>
            <textarea
              className="sh-textarea"
              rows={6}
              placeholder="赋予这位成员独特的说话风格、专业准则、协作习惯与拒绝越界要求的底线…"
              value={formSoulPrompt}
              onChange={(e) => setFormSoulPrompt(e.target.value)}
              required
            />
          </div>

          <div>
            <button
              type="button"
              className="sh-btn sh-btn-ghost sh-btn-sm"
              style={{ paddingLeft: 2 }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>高级 CLI 参数覆盖（可选，默认继承本机 CLI 自身配置）</span>
            </button>
            {showAdvanced && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
                <div>
                  <label className="sh-label" style={{ fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>
                    自定义可执行文件路径
                  </label>
                  <input
                    className="sh-input"
                    placeholder="留空自动探测 PATH / NVM"
                    value={formCommand}
                    onChange={(e) => setFormCommand(e.target.value)}
                  />
                </div>
                <div>
                  <label className="sh-label" style={{ fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>
                    附加启动参数（空格分隔）
                  </label>
                  <input
                    className="sh-input"
                    placeholder="例如 --model sonnet"
                    value={formExtraArgs}
                    onChange={(e) => setFormExtraArgs(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: 'auto',
              paddingTop: 14,
              borderTop: '1px solid var(--sh-border)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <button type="button" className="sh-btn sh-btn-outline" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="sh-btn sh-btn-primary" disabled={saving}>
              {saving ? '保存中…' : editingMember ? '保存修改' : '创建家庭成员'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
