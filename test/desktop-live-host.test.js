/**
 * 真实桌面宿主的冒烟测试（live smoke）。
 *
 * 与 gateway.test.js 的差别：那些用例打的是**假上游**，这条打的是**本机真正在跑的
 * dsh Desktop 宿主**，验证「桌面宿主 + 门卫」这条真实链路上最容易被想当然的一环：
 * 门卫改写 Host 后，宿主的信任围栏是否真的放行。
 *
 * 判据出自 dsh-client-connection 的 isTrustedApiRequest()：
 *   Host 非 loopback 且不在 trustedHosts → 403；loopback 但缺浏览器鉴权 Cookie → 401。
 * 于是「经门卫拿到 401 而不是 403」等价于「Host 改写确实是 loopback 形态」。
 *
 * 注意：/favicon.svg 这类浏览器自动请求的静态小资源被门卫直接短路成 204
 * （AUTO_RESOURCE_PATHS），不经过反代，不能用来验证这条链路——本文件用 / 与 /index.html。
 *
 * 宿主端口**不写死**（0.2.1 起 dsh-desktop-host 用 `--port 0` 随机端口，
 * 旧版的 19387 已从整个 asar 里消失，钉死会让本组用例永远静默 SKIP）。
 * 发现顺序：显式环境变量 → 宿主公告 URL（DSH_WEB_URL）→ 常见端口探测。
 * 桌面宿主没在跑时整组跳过（不阻塞未安装环境）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startGateway, request, login, cookieOf } from './helpers.js'

const HOST = '127.0.0.1'
/** 0.1.x/0.2.0 桌面宿主的历史端口，仅作为最后的兜底探测候选。 */
const LEGACY_DESKTOP_PORT = 19387

function directGet(port, path, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, method, path, timeout: 3000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

/** 候选端口：环境变量 → DSH_WEB_URL → 历史端口。去重、保序。 */
function candidatePorts() {
  const out = []
  const push = (value) => {
    const port = Number(value)
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !out.includes(port)) out.push(port)
  }
  push(process.env.DSH_DESKTOP_HOST_PORT)
  try {
    push(new URL(process.env.DSH_WEB_URL ?? '').port)
  } catch {
    /* 未设置或不可解析：跳过 */
  }
  push(LEGACY_DESKTOP_PORT)
  return out
}

/**
 * 探测真正在跑的桌面宿主：能对 /index.html 应答的候选端口。
 * 判据不能是「端口有人听」——门卫自己也可能在听；必须拿到宿主的 401/200 应答。
 */
async function detectDesktopHost() {
  for (const port of candidatePorts()) {
    const probe = await directGet(port, '/index.html')
    if (probe === null) continue
    if (![200, 401].includes(probe.status)) continue
    const asset = await directGet(port, '/assets/')
    return { port, indexStatus: probe.status, assetStatus: asset === null ? null : asset.status }
  }
  return null
}

const host = await detectDesktopHost()
// 0.2.1 起宿主端口随机，探测依赖环境变量；跳过信息必须告诉人怎么让它跑起来，
// 否则「静默 SKIP」会被误读成「这组用例通过」（本轮实测踩过：宿主在 32489，
// 用例却报 SKIP 而无人察觉）。
const skipMsg = host === null
  ? `dsh Desktop 宿主未在候选端口 [${candidatePorts().join(', ')}] 运行。`
    + `0.2.1 起宿主端口随机（--port 0），请设 DSH_DESKTOP_HOST_PORT=<端口> 或 DSH_WEB_URL=<宿主 URL> 后重跑`
  : false

test('桌面宿主直连基线：未带浏览器鉴权 Cookie 时 /index.html 回 401（不是 403）', { skip: skipMsg }, async () => {
  assert.equal(host.indexStatus, 401, `直连宿主应回 401，实际 ${host.indexStatus}`)
})

test('经门卫登录后再说：宿主回 401 而不是 403（Host 改写通过信任围栏）', { skip: skipMsg }, async () => {
  const gw = await startGateway({ targetPort: host.port, listenHost: '127.0.0.1' })
  try {
    // 未登录：门卫必须先拦住，绝不放未认证流量到宿主
    const anon = await request(gw.port, 'GET', '/index.html')
    assert.ok(
      [302, 303, 401].includes(anon.status),
      `未登录应被门卫拦截，实际 ${anon.status}`,
    )

    const jar = cookieOf(await login(gw.port))
    // 门卫没有 connection 服务（测试桩）→ 不做令牌交换 → 宿主按「缺 dsh-auth Cookie」回 401。
    // 403 会说明 Host 改写失效（非 loopback 被栅栏拒绝）——这正是本条要抓的回归。
    const res = await request(gw.port, 'GET', '/index.html', { headers: { cookie: jar } })
    assert.equal(res.status, 401, `应透传宿主的 401，实际 ${res.status}（403 = Host 改写失效，502 = 反代目标不可达）`)
  } finally {
    gw.stop()
  }
})

test('经门卫登录后取宿主真实响应：与直连宿主字节一致（透传未被改写）', { skip: skipMsg }, async () => {
  // 用 /index.html 而不是硬编码的构建产物名：0.2.1 换过前端构建，旧产物名会 404，
  // 而 `status !== 200 就 return` 会让本用例**静默通过**（假绿，实测踩过）。
  // /index.html 是宿主稳定提供的路径（未带鉴权 Cookie 时回 401 + 固定文案），
  // 直连与经门卫都必须逐字节相同——这才是「透传未被改写」的有效判据。
  const direct = await directGet(host.port, '/index.html')
  assert.ok(direct !== null, '直连宿主应可访问 /index.html')

  const gw = await startGateway({ targetPort: host.port, listenHost: '127.0.0.1' })
  try {
    const jar = cookieOf(await login(gw.port))
    const viaGw = await request(gw.port, 'GET', '/index.html', { headers: { cookie: jar } })
    assert.equal(viaGw.status, direct.status, `经门卫与直连的状态码应一致，实际 ${viaGw.status} vs ${direct.status}`)
    // 注意：helpers.request 的 body 是已解码的 UTF-8 字符串，长度是字符数不是字节数，
    // 必须用 Buffer.byteLength 比较，否则非 ASCII 内容会算出「少了 N 字节」的假失败。
    assert.equal(Buffer.byteLength(viaGw.body), direct.body.length, '经门卫与直连的字节数应一致')
    assert.equal(viaGw.body, direct.body.toString('utf8'), '正文必须逐字节一致（透传不得改写）')
  } finally {
    gw.stop()
  }
})
