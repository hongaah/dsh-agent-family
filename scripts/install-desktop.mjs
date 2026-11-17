import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * 将构建好的 `dsh-agent-family` 一键安装（或卸载）到本机 DeepSeek Harness 桌面端 Profile (`~/.dsh/profiles/desktop`)。
 * 非破坏式物理拷贝至 `node_modules/dsh-agent-family` 并注册进 `dsh.profile.bundles`，保留全部已有插件。
 */

const projectRoot = resolve(import.meta.dirname, '..');
const { name: PLUGIN_NAME } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const removeMode = process.argv.includes('--remove');
const profileArgIndex = process.argv.indexOf('--profile');
const profileName =
  profileArgIndex !== -1 && process.argv[profileArgIndex + 1]
    ? process.argv[profileArgIndex + 1]
    : 'desktop';

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profileName);
const profilePkgPath = join(profileDir, 'package.json');
const installedDir = join(profileDir, 'node_modules', PLUGIN_NAME);

if (!existsSync(profilePkgPath)) {
  console.error(`[${PLUGIN_NAME}] 未找到 DSH profile 清单: ${profilePkgPath}`);
  process.exit(1);
}

const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'));
profilePkg.dsh ??= {};
profilePkg.dsh.profile ??= {};
profilePkg.dsh.profile.bundles ??= [];

if (removeMode) {
  profilePkg.dsh.profile.bundles = profilePkg.dsh.profile.bundles.filter(
    (bundleName) => bundleName !== PLUGIN_NAME
  );
  rmSync(installedDir, { recursive: true, force: true });
  writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8');
  console.log(`[${PLUGIN_NAME}] 已从 profile "${profileName}" 卸载插件。重启 DeepSeek Harness 即可生效。`);
  process.exit(0);
}

const distIndex = resolve(projectRoot, 'dist/index.js');
const distClient = resolve(projectRoot, 'dist/client.js');
const distPhone = resolve(projectRoot, 'dist/phone-mcp.js');
if (!existsSync(distIndex) || !existsSync(distClient) || !existsSync(distPhone)) {
  console.error(`[${PLUGIN_NAME}] 请先执行 pnpm run build 生成 dist 产物后再安装。`);
  process.exit(1);
}

const alreadyInstalled =
  existsSync(installedDir) && realpathSync(installedDir) === realpathSync(projectRoot);
if (!alreadyInstalled) {
  rmSync(installedDir, { recursive: true, force: true });
  mkdirSync(installedDir, { recursive: true });
  for (const item of [
    'dist',
    'assets',
    'cordis.patch.yml',
    'package.json',
    'README.md',
    'scripts/install-desktop.mjs',
  ]) {
    const src = resolve(projectRoot, item);
    if (existsSync(src)) {
      const destination = join(installedDir, item);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(src, destination, { recursive: true });
    }
  }
}

const previousBundles = profilePkg.dsh.profile.bundles;
const bundles = previousBundles.filter(
  (bundleName, index, all) => bundleName !== PLUGIN_NAME || all.indexOf(PLUGIN_NAME) === index
);
if (!bundles.includes(PLUGIN_NAME)) {
  bundles.push(PLUGIN_NAME);
}
if (JSON.stringify(bundles) !== JSON.stringify(previousBundles)) {
  profilePkg.dsh.profile.bundles = bundles;
  writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8');
}

console.log(`[${PLUGIN_NAME}] 已安装到 DeepSeek Harness (${profileName}):`);
console.log(`  - 插件目录: ${installedDir}`);
console.log(`  - Profile 清单: ${profilePkgPath}`);
console.log('  请完全退出并重新启动 DeepSeek Harness 桌面端，即可在左侧看到「智能体家庭」入口。');
