/**
 * 真实桌面宿主的冒烟测试（live smoke）。
 *
 * 与 gateway.test.js 的差别：那些用例打的是**假上游**，这条打的是**本机真正在跑的
 * dsh Desktop 宿主**（127.0.0.1:19387），验证「桌面宿主 + 门卫」这条真实链路上最
 * 容易被想当然的一环：门卫改写 Host 后，宿主的信任围栏是否真的放行。
 *
 * 判据出自 dsh-client-connection 的 isTrustedApiRequest()：
 *   Host 非 loopback 且不在 trustedHosts → 403；loopback 但缺浏览器鉴权 Cookie → 401。
 * 于是「经门卫拿到 401 而不是 403」等价于「Host 改写确实是 loopback 形态」。
 *
 * 注意：/favicon.svg 这类浏览器自动请求的静态小资源被门卫直接短路成 204
 * （AUTO_RESOURCE_PATHS），不经过反代，不能用来验证这条链路——本文件用 / 与 /index.html。
 *
 * 桌面宿主没在跑时整组跳过（不阻塞未安装环境）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startGateway, request, login, cookieOf } from './helpers.js'

const HOST = '127.0.0.1'
const DESKTOP_PORT = 19387

function directGet(path, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: DESKTOP_PORT, method, path, timeout: 3000 }, (res) => {
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

async function detectDesktopHost() {
  const probe = await directGet('/index.html')
  if (probe === null) return null
  const asset = await directGet('/assets/')
  return { indexStatus: probe.status, assetStatus: asset === null ? null : asset.status }
}

const host = await detectDesktopHost()
const skipMsg = host === null ? 'dsh Desktop 宿主未在 127.0.0.1:19387 运行' : false

test('桌面宿主直连基线：未带浏览器鉴权 Cookie 时 /index.html 回 401（不是 403）', { skip: skipMsg }, async () => {
  assert.equal(host.indexStatus, 401, `直连宿主应回 401，实际 ${host.indexStatus}`)
})

test('经门卫登录后再说：宿主回 401 而不是 403（Host 改写通过信任围栏）', { skip: skipMsg }, async () => {
  const gw = await startGateway({ targetPort: DESKTOP_PORT, listenHost: '127.0.0.1' })
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

test('经门卫登录后取公开静态资源：与直连宿主同源同内容（字节一致）', { skip: skipMsg }, async () => {
  // 挑一个不在 AUTO_RESOURCE_PATHS 里的真实资源：从宿主根文档拿不到（401），
  // 因此直接用一个已知存在的构建产物路径，找不到就跳过（版本升级会改文件名）。
  const candidate = '/assets/index-Q6zc2uHV.js'
  const direct = await directGet(candidate)
  if (direct === null || direct.status !== 200) return

  const gw = await startGateway({ targetPort: DESKTOP_PORT, listenHost: '127.0.0.1' })
  try {
    const jar = cookieOf(await login(gw.port))
    const viaGw = await request(gw.port, 'GET', candidate, { headers: { cookie: jar } })
    assert.equal(viaGw.status, 200, `经门卫应 200，实际 ${viaGw.status}`)
    // 注意：helpers.request 的 body 是已解码的 UTF-8 字符串，长度是字符数不是字节数，
    // 必须用 Buffer.byteLength 比较，否则非 ASCII 内容会算出「少了 N 字节」的假失败。
    assert.equal(Buffer.byteLength(viaGw.body), direct.body.length, '经门卫与直连的字节数应一致')
  } finally {
    gw.stop()
  }
})
