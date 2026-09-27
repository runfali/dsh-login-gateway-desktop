/**
 * 反代目标端口「自动发现」的回归（2026-09-27 新增）。
 *
 * 背景：19387 只是 dsh-desktop-host/lib/index.js:231 里写死的一个字面量
 * （args: ["--no-open","--port","19387"]，全文件仅此一处，无环境变量、无配置项）。
 * 它可能被 profile 层的 webserver 行覆盖，也可能随上游版本漂移——
 * 把它当唯一来源，一旦变了就表现为「登录成功但页面全白」，且无从归因。
 *
 * 新契约（2026-09-27 拍板）：
 *   1. 显式配置 targetPort      -> 用配置值（最权威，保留旧用法）
 *   2. 未配置                   -> 读宿主 ctx.get('webServer').port（bind 后的实测值）
 *   3. 服务没挂载 / 拿不到端口  -> 回落 19387，并标记「非权威」（下次重查，不缓存）
 *
 * 为什么区分权威：令牌交换的 authority 必须与反代目标在同一次请求里取同一个值，
 * 否则 cookie 名反推错——审计第四轮那个假阳性正是「探针形状与真实宿主不一致」的同源问题。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, resolveTargetPort } from '../src/index.js'
import { dshAuthCookieName } from '../src/proxy.js'
import { startGateway, startUpstream, request, login, cookieOf } from './helpers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:'

// ---------- 1. 纯函数三分支 ----------

test('resolveTargetPort：显式配置最权威，压过宿主实测端口', () => {
  const r = resolveTargetPort({ targetPort: 8123, ctx: { get: () => ({ port: 9999 }) } })
  assert.deepEqual(r, { port: 8123, authoritative: true })
})

test('resolveTargetPort：未配置时读宿主 webServer 实测端口', () => {
  const r = resolveTargetPort({ targetPort: null, ctx: { get: () => ({ port: 4567 }) } })
  assert.deepEqual(r, { port: 4567, authoritative: true })
})

test('resolveTargetPort：服务未挂载时回落 19387 且标记非权威（下次重查）', () => {
  const ctxs = [null, undefined, {}, { get: () => undefined }, { get: () => ({}) }, { get: () => { throw new Error('not mounted') } }]
  for (const ctx of ctxs) {
    const r = resolveTargetPort({ targetPort: null, ctx })
    assert.equal(r.port, 19387, 'ctx=' + JSON.stringify(ctx) + ' 应回落到兜底端口')
    assert.equal(r.authoritative, false, '未拿到实测端口不得标记权威（否则会被缓存住错值）')
  }
})

test('resolveTargetPort：非整数/越界端口不采信（防脏值进反代）', () => {
  const bads = [0, -1, 65536, 70000, 3.5, 'abc', undefined, null]
  for (const bad of bads) {
    const r = resolveTargetPort({ targetPort: null, ctx: { get: () => ({ port: bad }) } })
    assert.equal(r.port, 19387, 'port=' + String(bad) + ' 应被拒并回落')
    assert.equal(r.authoritative, false)
  }
})

test('resolveConfig：未配置 targetPort 时是 null（= 自动发现），显式配置原样透传', () => {
  assert.equal(resolveConfig({}).targetPort, null, '默认必须是自动发现，不得钉死 19387')
  assert.equal(resolveConfig({ targetPort: 3080 }).targetPort, 3080, '显式配置必须原样保留')
  assert.equal(resolveConfig(null).targetPort, null, 'cordis 传 null 不得炸')
})
// ---------- 2. 启动日志：发现结果流进反代目标（只看日志，先不发请求）----------

test('未配置 targetPort：启动日志显示宿主实测端口（自动发现生效）', async () => {
  const gw = await startGateway({ targetPort: null }, true, { webServer: { port: 45678 } })
  try {
    const line = gw.logs.find((l) => l.includes('反代至')) ?? ''
    const expect = '反代至 ' + BASE + '45678'
    assert.ok(line.includes(expect), '自动发现结果必须流进反代目标，实际日志：' + JSON.stringify(gw.logs))
  } finally { gw.stop() }
})

test('显式 targetPort：启动日志用配置值，压过宿主实测端口', async () => {
  const gw = await startGateway({ targetPort: 55111 }, true, { webServer: { port: 45678 } })
  try {
    const line = gw.logs.find((l) => l.includes('反代至')) ?? ''
    assert.ok(line.includes('反代至 ' + BASE + '55111'), '显式配置必须压过宿主实测端口，实际：' + line)
    assert.ok(!line.includes('45678'), '不得同时出现宿主实测端口')
  } finally { gw.stop() }
})

// ---------- 3. 端到端：发现端口 = 反代去向 = 令牌交换的 authority ----------

test('自动发现端到端：cookie 名按发现的端口反推，响应该来自发现的那个宿主', async () => {
  // 假宿主用**自己的实际端口**反推 cookie 名。自动发现若失效（回落 19387），
  // 门卫会拿 19387 算 authority → cookie 名对不上 → 宿主回 401，本用例即红。
  const TOKEN = 'DISCOVERY-TOKEN'
  const up = await startUpstream((req, res) => {
    const u = new URL(req.url, 'http://x')
    const cookieName = dshAuthCookieName('127.0.0.1:' + up.port)
    if (u.pathname === '/' && u.searchParams.get('token') === TOKEN) {
      res.writeHead(303, { 'cache-control': 'no-store', location: './', 'set-cookie': cookieName + '=SIGNED; Path=/; HttpOnly; SameSite=Strict' })
      res.end()
      return
    }
    if (String(req.headers.cookie ?? '').includes(cookieName + '=SIGNED')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"via":"discovered"}')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('no cookie')
  })
  const conn = { authenticatedUrl(base) { const u = new URL(base); u.searchParams.set('token', TOKEN); return u.toString() } }
  // targetPort: null = 自动发现；webServer 服务给出宿主真实端口
  const gw = await startGateway({ targetPort: null }, true, { webServer: { port: up.port }, connection: conn })
  try {
    // 先断言日志确认目标是**假宿主**（发现若失效，这里就止损，绝不去碰真实桌面宿主）
    const line = gw.logs.find((l) => l.includes('反代至')) ?? ''
    const expect = '反代至 ' + BASE + up.port
    assert.ok(line.includes(expect), '发现失败必须在此止损，实际：' + line)

    const jar = cookieOf(await login(gw.port))
    const home = await request(gw.port, 'GET', '/', { headers: { cookie: jar } })
    assert.equal(home.status, 303, '首页应触发令牌交换')

    const setCookie = String([].concat(home.headers['set-cookie'] ?? [])[0])
    const dshCookie = setCookie.split(';')[0]
    const expected = dshAuthCookieName('127.0.0.1:' + up.port)
    assert.ok(dshCookie.startsWith(expected + '='), 'Cookie 名必须按发现的端口反推，期望 ' + expected + '，实际 ' + dshCookie)

    const page = await request(gw.port, 'GET', '/index.html', { headers: { cookie: jar + '; ' + dshCookie } })
    assert.equal(page.status, 200)
    assert.equal(page.body, '{"via":"discovered"}', '响应必须来自发现的那个宿主')
  } finally { gw.stop(); await up.close() }
})

// ---------- 4. 静态：随包 patch 不得钉死 targetPort ----------

test('cordis.patch.yml 不得声明 targetPort（钉死会让自动发现形同虚设）', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /^[ \t]+targetPort:/m, '随包挂载层不得钉死 targetPort，要留给自动发现')
  assert.match(patch, /^[ \t]+targetHost:/m, 'targetHost 仍应显式声明')
  assert.match(patch, /listenPort:\s*3082/, 'listenPort: 3082 不得回退')
})

