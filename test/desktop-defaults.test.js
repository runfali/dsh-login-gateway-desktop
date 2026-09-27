/**
 * 桌面端（dsh Desktop / Electron）默认值的守护测试。
 *
 * 本仓是 dsh-login-gateway 的桌面端二次开发版，与 web 端分支的**唯一语义差别**是
 * 默认部署面：
 *   - 入口监听 0.0.0.0:3082（web 端用 3081，两个插件可能同时装在两个 profile 里，
 *     端口撞车会导致后启动的那个 listen EADDRINUSE）；
 *   - 反代目标**自动发现**（null = 运行时读宿主 webServer 的实测端口，兜底 19387），
 *     不是写死 19387——19387 只是 dsh-desktop-host 当前写死的字面量，会被 profile 层
 *     webserver 行覆盖、也会随上游版本漂移（2026-09-27 拍板改为自动发现）。
 *
 * 这组用例把「差别只在默认值」变成不可回退的不变量：改错端口会让插件看起来
 * 启动成功，实际代理到空气或顶掉 web 端门卫。反代目标的发现细节另见
 * test/target-port-discovery.test.js。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

test('桌面端默认：入口 0.0.0.0:3082，反代目标自动发现（targetPort=null）', () => {
  // 契约变更记录（2026-09-27）：targetPort 默认值从 19387 改为 null（= 自动发现）。
  // 理由：19387 只是 dsh-desktop-host 写死的字面量，钉死默认值会让插件在
  // 「端口被 profile 覆盖 / 上游改版本」时静默打到空气（症状=登录成功页面全白）。
  // 兜底 19387 与显式配置的优先级见 test/target-port-discovery.test.js。
  const cfg = resolveConfig({})
  assert.equal(cfg.listenHost, '0.0.0.0')
  assert.equal(cfg.listenPort, 3082)
  assert.equal(cfg.targetHost, '127.0.0.1')
  assert.equal(cfg.targetPort, null, '默认必须是 null（自动发现），不得钉死 19387')
})

test('3081 必须留给 web 端：本仓默认入口端口不得等于 3081', () => {
  // 两个分支可能同时存在于同一台机器（web profile + desktop profile），
  // 3082 是桌面端的保留端口，3081 是 web 端 dsh-login-gateway 的保留端口。
  assert.notEqual(resolveConfig({}).listenPort, 3081)
})

test('显式配置优先于默认值（用户层覆盖仍然可用）', () => {
  const cfg = resolveConfig({ listenPort: 9000, targetPort: 1234, listenHost: '127.0.0.1' })
  assert.equal(cfg.listenPort, 9000)
  assert.equal(cfg.targetPort, 1234)
  assert.equal(cfg.listenHost, '127.0.0.1')
})

test('随包挂载层声明的端口与代码默认值一致（防两处漂移）', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /listenPort:\s*3082/, 'cordis.patch.yml 应声明 listenPort: 3082')
  // targetPort 不再声明：钉死它会让自动发现永远不生效（发现细节见 target-port-discovery 测试）
  assert.doesNotMatch(patch, /^[ \t]+targetPort:/m, 'cordis.patch.yml 不得钉死 targetPort')
  assert.doesNotMatch(patch, /listenPort:\s*3081/, '不得占用 web 端的 3081')
})

test('包名与仓库名是桌面端分支，不得与 web 端同名', () => {
  assert.equal(pkg.name, 'dsh-login-gateway-desktop')
  assert.match(pkg.repository.url, /dsh-login-gateway-desktop/)
})
