import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const distDir = resolve(root, 'dist');
const { name: packageName } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 1. 构建 DSH Host 插件入口 (ESM)
await build({
  entryPoints: [resolve(root, 'src/host/index.ts')],
  outfile: resolve(distDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
});

// 2. 构建配发给各外部 CLI 身体的「家庭手机」Stdio MCP 入口 (ESM)
await build({
  entryPoints: [resolve(root, 'src/phone/phone-mcp-stdio.ts')],
  outfile: resolve(distDir, 'phone-mcp.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: '#!/usr/bin/env node',
  },
  sourcemap: false,
});
chmodSync(resolve(distDir, 'phone-mcp.js'), 0o755);

// 3. 构建 DSH 客户端插件包：编译为 CJS 并包裹进 window.__ModuleLoader__.load(...)
const clientCompiled = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
});

const rawClientCode = clientCompiled.outputFiles[0]?.text ?? '';
const wrappedClientBundle = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(packageName)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  rawClientCode,
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n');

writeFileSync(resolve(distDir, 'client.js'), wrappedClientBundle, 'utf8');

// 4. 生成基础类型声明桩
writeFileSync(
  resolve(distDir, 'index.d.ts'),
  [
    `export declare const name = ${JSON.stringify(packageName)};`,
    'export declare const inject: string[];',
    'export declare function apply(ctx: unknown): void;',
    '',
  ].join('\n'),
  'utf8'
);

console.log(`[${packageName}] Build completed -> dist/{index.js, client.js, phone-mcp.js}`);
