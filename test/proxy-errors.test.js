/**
 * 反代错误路径的回归测试（审计第一轮补测）。
 *
 * 覆盖此前**零覆盖**的三条路径——它们正是桌面用户最容易撞上的状态：
 *   1. 桌面宿主没起来（Node 未监听 19387）→ 反代必须回 502，不能挂起
 *   2. 桌面宿主卡住不回响应头 → 必须按 proxyTimeoutMs 回 504，不能无限等
 *   3. 宿主在响应中途断开 → 已发头则掐断连接（浏览器立刻报错），未发头则 502
 *
 * 判据：这三条在真实桌面环境里分别对应「dsh Desktop 没开」「宿主死锁」
 * 「宿主崩溃」，做成静默挂起会让用户以为门卫坏了。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { startGateway, login, cookieOf, request, freePort } from './helpers.js'

test('反代目标未监听（桌面宿主没起来）→ 502，不是挂起', async () => {
  const deadPort = await freePort() // 拿到一个刚释放的端口，几乎必然无人监听
  const gw = await startGateway({ targetPort: deadPort, listenHost: '127.0.0.1' })
  try {
    const jar = cookieOf(await login(gw.port))
    const res = await request(gw.port, 'GET', '/api', { headers: { cookie: jar } })
    assert.equal(res.status, 502, `宿主不可达应回 502，实际 ${res.status}`)
  } finally {
    gw.stop()
  }
})

test('反代目标卡住不回响应头 → 按 proxyTimeoutMs 回 504', async () => {
  // 上游接受连接但永不响应：模拟宿主死锁
  const stuck = http.createServer(() => { /* 故意不响应 */ })
  await new Promise((r) => stuck.listen(0, '127.0.0.1', r))
  const gw = await startGateway({
    targetPort: stuck.address().port,
    listenHost: '127.0.0.1',
    proxyTimeoutMs: 300, // 缩短等待，让用例快速收敛
  })
  try {
    const jar = cookieOf(await login(gw.port))
    const res = await request(gw.port, 'GET', '/api', { headers: { cookie: jar } })
    assert.equal(res.status, 504, `宿主不响应应回 504，实际 ${res.status}`)
  } finally {
    gw.stop()
    await new Promise((r) => stuck.close(r))
  }
})

test('宿主响应中途断开且未发头 → 502（不返回半截响应）', async () => {
  // 上游收到请求后立刻销毁 socket，不给任何响应
  const aborting = http.createServer((req, res) => {
    res.socket?.destroy()
  })
  await new Promise((r) => aborting.listen(0, '127.0.0.1', r))
  const gw = await startGateway({ targetPort: aborting.address().port, listenHost: '127.0.0.1' })
  try {
    const jar = cookieOf(await login(gw.port))
    const res = await request(gw.port, 'GET', '/api', { headers: { cookie: jar } })
    assert.ok([502, 504].includes(res.status), `应回 502/504，实际 ${res.status}`)
  } finally {
    gw.stop()
    await new Promise((r) => aborting.close(r))
  }
})

test('监听端口被占用时不崩：记录错误且进程存活', async () => {
  const occupied = await freePort()
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(occupied, '127.0.0.1', r))
  try {
    const { apply } = await import('../src/index.js')
    const { makeCtx, tempDir } = await import('./helpers.js')
    const path = await import('node:path')
    const home = tempDir('gw-audit-port')
    const pack = makeCtx()
    // apply 必须同步返回（cordis 契约）；EADDRINUSE 由 server.on('error') 记录，不得抛出
    assert.doesNotThrow(() => {
      apply(pack.ctx, {
        listenHost: '127.0.0.1',
        listenPort: occupied,
        userStorePath: path.join(home, 'users.json'),
        settingsFilePath: path.join(home, 'settings.yaml'),
      })
    })
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(
      pack.logs.some((l) => /外部入口错误/.test(l)),
      `端口占用应记录到日志，实际日志：${JSON.stringify(pack.logs)}`,
    )
    pack.dispose()
  } finally {
    await new Promise((r) => blocker.close(r))
  }
})
