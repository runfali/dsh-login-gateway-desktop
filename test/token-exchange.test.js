/**
 * 宿主浏览器鉴权「令牌交换」的端到端回归（审计第三轮补测）。
 *
 * 这是整个插件**最复杂也最危险**的一条链路：远端浏览器永远拿不到宿主打印在终端里的
 * 一次性启动令牌，所以门卫必须在「已登录用户的首页导航」上代跑一次交换
 * （宿主回 303 + Set-Cookie，门卫原样透传），否则 /api 永远 401，用户看到的界面是死的。
 *
 * 本用例用「桌面形态」的假宿主复刻 dsh 的真实行为：
 *   - authority 是 127.0.0.1:<port>（真实桌面是 19387），Cookie 名按该 authority 反推
 *   - 带正确 token 的首页导航 → 303 + Set-Cookie
 *   - 无 Cookie 的 /api → 401
 *   - 带正确 Cookie 的 /api → 200
 *
 * 四条不变量：令牌交换成功 / 令牌**绝不下发给浏览器** / 交换后可正常访问 /api /
 * 宿主会话失效时能自动重跑交换（用户不必手动清 Cookie）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { startGateway, startUpstream, request, login, cookieOf } from './helpers.js'
import { dshAuthCookieName } from '../src/proxy.js'

const LAUNCH_TOKEN = 'LAUNCH-TOKEN-ABC'

/** 起一个「桌面形态」的假宿主，返回 { port, close }。 */
async function startDesktopShapedHost() {
  let selfPort = 0
  const up = await startUpstream((req, res) => {
    const u = new URL(req.url, 'http://x')
    const authority = `127.0.0.1:${selfPort}`
    const cookieName = dshAuthCookieName(authority)
    // 首页导航 + 正确启动令牌 → 交换成功
    if (u.pathname === '/' && u.searchParams.get('token') === LAUNCH_TOKEN) {
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: './',
        'set-cookie': `${cookieName}=SIGNED; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }
    if (u.pathname === '/') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('dsh web authentication required')
      return
    }
    const cookies = String(req.headers.cookie ?? '')
    if (cookies.includes(`${cookieName}=SIGNED`)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('no cookie')
  })
  selfPort = up.port
  return up
}

/** 模拟宿主 connection 服务：authenticatedUrl 给初始登录 URL（带启动令牌）。 */
const fakeConnection = {
  authenticatedUrl(base) {
    const u = new URL(base)
    u.searchParams.set('token', LAUNCH_TOKEN)
    return u.toString()
  },
}

test('令牌交换：门卫代跑交换并把 Set-Cookie 透传给浏览器，/api 随后可用', async () => {
  const up = await startDesktopShapedHost()
  const gw = await startGateway({ targetPort: up.port, listenHost: '127.0.0.1' }, true, { connection: fakeConnection })
  try {
    const jar = cookieOf(await login(gw.port))
    const home = await request(gw.port, 'GET', '/', { headers: { cookie: jar } })
    assert.equal(home.status, 303, '首页导航应触发令牌交换并透传 303')

    const setCookie = home.headers['set-cookie']
    assert.ok(setCookie, '必须把宿主的 Set-Cookie 透传给浏览器')
    const dshCookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
    assert.match(dshCookie, /^dsh-auth-/, 'Cookie 名必须是 dsh-auth-* 形态')
    assert.match(dshCookie, /=SIGNED$/, 'Cookie 值应来自宿主')

    // 拿到 dsh-auth 后 /api 应被宿主放行
    const api = await request(gw.port, 'GET', '/api', { headers: { cookie: `${jar}; ${dshCookie}` } })
    assert.equal(api.status, 200, '带宿主会话 Cookie 时 /api 应可用')
    assert.equal(api.body, '{"ok":true}')
  } finally {
    gw.stop()
    await up.close()
  }
})

test('令牌绝不下发给浏览器：所有响应体与响应头都不得含启动令牌', async () => {
  const up = await startDesktopShapedHost()
  const gw = await startGateway({ targetPort: up.port, listenHost: '127.0.0.1' }, true, { connection: fakeConnection })
  try {
    const jar = cookieOf(await login(gw.port))
    const home = await request(gw.port, 'GET', '/', { headers: { cookie: jar } })
    const setCookie = String(home.headers['set-cookie'] ?? '')
    const serializedHeaders = JSON.stringify(home.headers)
    assert.equal(home.body.includes(LAUNCH_TOKEN), false, '响应体不得含启动令牌')
    assert.equal(setCookie.includes(LAUNCH_TOKEN), false, 'Set-Cookie 不得含启动令牌')
    assert.equal(serializedHeaders.includes(LAUNCH_TOKEN), false, '任何响应头都不得含启动令牌')
  } finally {
    gw.stop()
    await up.close()
  }
})

test('浏览器带着失效的 dsh-auth-*：门卫剥掉坏 Cookie 重跑交换（用户不必手动清）', async () => {
  const up = await startDesktopShapedHost()
  const gw = await startGateway({ targetPort: up.port, listenHost: '127.0.0.1' }, true, { connection: fakeConnection })
  try {
    const jar = cookieOf(await login(gw.port))
    // 浏览器带着一个已失效的（名字对但值不对）宿主 Cookie
    const authority = `127.0.0.1:${up.port}`
    const staleName = dshAuthCookieName(authority)
    const res = await request(gw.port, 'GET', '/', { headers: { cookie: `${jar}; ${staleName}=DEAD` } })
    assert.equal(res.status, 303, '失效 Cookie 应触发重跑交换，而不是把 401 直接甩给用户')
    const setCookie = String(res.headers['set-cookie'] ?? '')
    assert.match(setCookie, /=SIGNED/, '重跑后应换到新的宿主会话')
  } finally {
    gw.stop()
    await up.close()
  }
})

test('没有 connection 服务（旧版宿主/测试桩）：完全跳过交换，不崩', async () => {
  const up = await startDesktopShapedHost()
  const gw = await startGateway({ targetPort: up.port, listenHost: '127.0.0.1' }) // 不注入 connection
  try {
    const jar = cookieOf(await login(gw.port))
    const home = await request(gw.port, 'GET', '/', { headers: { cookie: jar } })
    // 不交换 → 原样透传宿主的 401（这正是桌面交付时「未验证项」的降级行为）
    assert.equal(home.status, 401, '无 connection 时应原样透传宿主 401，不得崩')
    assert.match(home.body, /authentication required/)
  } finally {
    gw.stop()
    await up.close()
  }
})
