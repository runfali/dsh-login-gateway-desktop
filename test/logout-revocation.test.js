/**
 * 登出吊销宿主浏览器会话的回归（审计第四轮补测）。
 *
 * 审计过程中的一段弯路（诚实记录）：
 *   最初探针报告「登出未吊销 dsh-auth-* Cookie」，看似承诺未兑现。复核后发现是**探针自身的错**——
 *   假 connection 的 `authenticatedUrl(base)` 只回裸 origin、没有把 `token` 查询参数拼上去，
 *   而 `resolveDshAuth` 拿不到 token 就会返回 null（优雅降级），于是登出自然没有 dsh-auth 可吊销。
 *   探针与真实宿主的形状不一致 → 假阳性。修好探针（真实宿主会把令牌拼在 URL 上）后行为正确。
 *
 * 这条用例同时守住两边：
 *   1. connection 可用时，登出必须把宿主的 dsh-auth-* 一并吊销（否则共享浏览器上
 *      下一个人登录门卫后会继承上一个人换到的 dsh 会话）；
 *   2. connection 不可用时（旧版宿主），登出不得崩、只吊销门卫自己的会话。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { startGateway, request, login, cookieOf } from './helpers.js'
import { dshAuthCookieName } from '../src/proxy.js'

/** 忠实复刻宿主 connection.authenticatedUrl：把启动令牌拼进 URL 查询串。 */
const realisticConnection = (token = 'LAUNCH-TOKEN') => ({
  authenticatedUrl(base) {
    const u = new URL(base)
    u.searchParams.set('token', token)
    return u.toString()
  },
})

const TARGET_PORT = 19387 // 桌面宿主真实端口

test('登出：吊销门卫会话 + 宿主的 dsh-auth-*（connection 可用时）', async () => {
  const gw = await startGateway({ targetPort: TARGET_PORT, listenHost: '127.0.0.1' }, true, {
    connection: realisticConnection(),
  })
  try {
    const jar = cookieOf(await login(gw.port))
    const res = await request(gw.port, 'POST', '/logout', { headers: { cookie: jar } })
    assert.equal(res.status, 302, '登出应 302 回登录页')

    const setCookies = [].concat(res.headers['set-cookie'] ?? []).map(String)
    assert.ok(
      setCookies.some((c) => /^dsh_gw_session=;/.test(c)),
      `必须吊销门卫自己的会话，实际：${JSON.stringify(setCookies)}`,
    )

    // Cookie 名必须与门卫改写后的 authority（targetHost:targetPort）反推的一致
    const expected = dshAuthCookieName(`127.0.0.1:${TARGET_PORT}`)
    assert.ok(
      setCookies.some((c) => c.startsWith(`${expected}=`) && c.includes('Max-Age=0')),
      `必须吊销宿主会话 ${expected}，实际：${JSON.stringify(setCookies)}`,
    )

    // 属性必须与 dsh 签发的那份逐字对齐（不带 Secure），否则浏览器视为不同 Cookie 删不掉
    const dshLine = setCookies.find((c) => c.startsWith(`${expected}=`))
    assert.equal(dshLine.includes('Secure'), false, '吊销时不得加 Secure（与 dsh 签发形态保持一致）')
    assert.match(dshLine, /HttpOnly/)
  } finally {
    gw.stop()
  }
})

test('登出：无 connection 服务时不崩，只吊销门卫会话（旧版宿主降级）', async () => {
  const gw = await startGateway({ targetPort: TARGET_PORT, listenHost: '127.0.0.1' })
  try {
    const jar = cookieOf(await login(gw.port))
    const res = await request(gw.port, 'POST', '/logout', { headers: { cookie: jar } })
    assert.equal(res.status, 302)
    const setCookies = [].concat(res.headers['set-cookie'] ?? []).map(String)
    assert.ok(setCookies.some((c) => /^dsh_gw_session=;/.test(c)), '门卫会话仍必须吊销')
    assert.equal(
      setCookies.some((c) => c.includes('dsh-auth-')),
      false,
      '拿不到宿主 Cookie 名时不得凭空编一个',
    )
  } finally {
    gw.stop()
  }
})

test('探针保真度：authenticatedUrl 不返回令牌时，令牌交换必须优雅降级而非崩', async () => {
  // 这正是审计中假阳性的来源形状：不拼 token 的 connection。
  // 固化它作为「降级路径」的守护，同时说明为什么不能用它去断言吊销行为。
  const naive = { authenticatedUrl: (base) => base } // 只回裸 origin
  const gw = await startGateway({ targetPort: TARGET_PORT, listenHost: '127.0.0.1' }, true, { connection: naive })
  try {
    const jar = cookieOf(await login(gw.port))
    const home = await request(gw.port, 'GET', '/', { headers: { cookie: jar } })
    assert.ok([401, 502, 303].includes(home.status), `降级路径不得 500，实际 ${home.status}`)
    const res = await request(gw.port, 'POST', '/logout', { headers: { cookie: jar } })
    assert.equal(res.status, 302, '无宿主 Cookie 名时登出仍需正常收尾')
  } finally {
    gw.stop()
  }
})
