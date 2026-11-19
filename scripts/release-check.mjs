import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 发布前一键自检脚本 (`pnpm run release:check`)：
 * - 执行完整 prepack（TypeScript 类型检查 + Vitest 单元测试 + esbuild 构建）
 * - 校验 DSH 插件清单必填字段与图标体积限制（<= 256 KiB）
 * - 核对 docs/screenshots/ 下的 6 张 README 预留截图是否已就位
 * - 执行 npm pack --dry-run 并输出下一步手动推送 GitHub / 发布 npm 的标准命令
 */

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const EXPECTED_SCREENSHOTS = [
  {
    file: 'docs/screenshots/01-family-overview.png',
    desc: '首屏全景主界面（智能体家庭客厅 / 分栏视图）',
  },
  {
    file: 'docs/screenshots/02-group-chat-relay.png',
    desc: '家庭群聊多轮 @ 接龙、异议争论与悬浮名片',
  },
  {
    file: 'docs/screenshots/03-family-phone-collaboration.png',
    desc: '随身「家庭手机」跨 CLI 私下拨号与附件协作动态',
  },
  {
    file: 'docs/screenshots/04-main-session-delegation.png',
    desc: 'DSH 主会话 /family 斜杠委派、协作进度卡与变更文件交付卡',
  },
  {
    file: 'docs/screenshots/05-member-soul-workshop.png',
    desc: '成员与灵魂工坊（身体体检、厂商头像、模型/强度切换、家庭共享画像）',
  },
  {
    file: 'docs/screenshots/06-native-approval-relay.png',
    desc: '原生权限尊重与双栖「成员举手请求批示」确认横幅',
  },
];

console.log(`\n🔍 开始执行 ${pkg.name}@${pkg.version} 发布前预检...\n`);

// 1. 执行 npm pack --dry-run（自动触发 prepack: typecheck -> test -> build）
execSync('npm pack --dry-run', { cwd: root, stdio: 'inherit' });

// 2. 校验插件核心产物与图标限制
for (const requiredFile of [
  'dist/index.js',
  'dist/client.js',
  'dist/phone-mcp.js',
  'dist/index.d.ts',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  pkg.icon,
]) {
  const fullPath = resolve(root, requiredFile);
  if (!existsSync(fullPath)) {
    console.error(`❌ 缺少必需发布文件: ${requiredFile}`);
    process.exit(1);
  }
}

const iconBytes = statSync(resolve(root, pkg.icon)).size;
if (iconBytes > 256 * 1024) {
  console.error(`❌ 插件图标 ${pkg.icon} 超过 DSH 256 KiB 上限（当前 ${iconBytes} bytes）`);
  process.exit(1);
}
console.log(`\n✅ 核心构建产物与 DSH 插件清单校验通过（图标大小 ${(iconBytes / 1024).toFixed(1)} KiB）。`);

// 3. 检查 README 截图就位情况
console.log('\n📸 检查 docs/screenshots/ 预留截图状态:');
let missingCount = 0;
for (const item of EXPECTED_SCREENSHOTS) {
  const abs = resolve(root, item.file);
  if (existsSync(abs) && statSync(abs).size > 0) {
    const kb = (statSync(abs).size / 1024).toFixed(1);
    console.log(`  ✅ ${item.file} (${kb} KiB) — ${item.desc}`);
  } else {
    missingCount += 1;
    console.log(`  ⏳ [待放入] ${item.file} — ${item.desc}`);
  }
}

if (missingCount > 0) {
  console.log(
    `\n💡 提示: 还有 ${missingCount} 张预留截图尚未放入 docs/screenshots/。放入截图并提交推送到 GitHub 后，GitHub、npmjs.com 与 DSH 插件市场均会自动显示图片。`
  );
} else {
  console.log('\n🎉 全部 6 张预留截图均已就位！');
}

console.log(`
🚀 手动发布步骤参考:

  # 1. 提交 README、截图与发布配置并推送到 GitHub（确保远程图片可访问）
  git add -A
  git commit -m "chore: prepare v${pkg.version} release and documentation"
  git tag v${pkg.version}
  git push origin main --tags

  # 2. 登录官方 npm（如尚未登录）并校验当前账号
  npm whoami --registry=https://registry.npmjs.org/ || npm login --registry=https://registry.npmjs.org/

  # 3. 正式发布到 npm 公共仓库
  npm publish --access public --registry=https://registry.npmjs.org/
`);
