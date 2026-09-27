/**
 * 第七轮（2026-09-10）追加回归：设置文件下载端点。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { fileURLToPath } from 'node:url'

import { startGateway, request, login, cookieOf, makeCtx } from './helpers.js'

test('设置文件下载：文件缺失时 404 且错误文案不含绝对路径', async () => {
  const gw = await startGateway({ settingsFileDownload: true })
  try {
    const jar = cookieOf(await login(gw.port))
    const res = await request(gw.port, 'GET', '/__gateway/settings.yaml', { headers: { cookie: jar } })
    assert.equal(res.status, 404)
    const body = JSON.parse(res.body)
    assert.equal(body.error, '配置文件不存在')
    assert.ok(!res.body.includes('/tmp/'), '不得泄漏服务器目录结构')
    // 细节进日志（排障有据）
    assert.ok(gw.logs.some((l) => l.includes('设置文件下载失败') && l.includes('settings.yaml')))
  } finally {
    gw.stop()
  }
})

test('设置文件下载：HEAD 仅回响应头，GET 仍下附件', async () => {
  const gw = await startGateway({ settingsFileDownload: true, settingsFilePath: fileURLToPath(new URL('./fixtures-settings.yaml', import.meta.url)) })
  try {
    const jar = cookieOf(await login(gw.port))
    const head = await request(gw.port, 'HEAD', '/__gateway/settings.yaml', { headers: { cookie: jar } })
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
    assert.match(head.headers['content-disposition'] ?? '', /attachment/) // 头与 GET 一致，仅无正文
    assert.equal(head.headers['content-length'], undefined) // HEAD 不声明长度
    const get = await request(gw.port, 'GET', '/__gateway/settings.yaml', { headers: { cookie: jar } })
    assert.equal(get.status, 200)
    assert.match(get.headers['content-disposition'], /attachment/)
  } finally {
    gw.stop()
  }
})

test('设置文件下载：非 GET/HEAD 返回 405', async () => {
  const gw = await startGateway({ settingsFileDownload: true })
  try {
    const jar = cookieOf(await login(gw.port))
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await request(gw.port, method, '/__gateway/settings.yaml', { headers: { cookie: jar } })
      assert.equal(res.status, 405, method)
    }
  } finally {
    gw.stop()
  }
})

test('apply(ctx, null) 不再抛 TypeError（cordis 可能传 null 配置）', async () => {
  // 审计第二轮修复（2026-09-27）：原写法 `apply(pack2.ctx, null)` 会走到 cfg 的**全部默认值**
  // ——listenHost 0.0.0.0 / listenPort 3082 / userStorePath ~/.dsh-login-gateway-desktop。
  // 实测后果：跑一次测试就把**真实用户目录**里的 setup-token.txt 重写一遍
  // （当时插件并未安装，3082 也无人监听，属纯测试污染），且真的去绑局域网端口。
  // 修法：把 null 路径的默认值覆写掉（cordis 配置合并语义 = null 等价空对象 + 默认值），
  // 保留「null 不抛」这一被测行为，同时不碰真实环境。
  const { apply } = await import('../src/index.js')
  const home = mkdtempSync(path.join(tmpdir(), 'gw-nullcfg-'))
  const pack = makeCtx({})
  assert.doesNotThrow(() => {
    apply(pack.ctx, { listenHost: '127.0.0.1', userStorePath: path.join(home, 'users.json'), listenPort: 0 })
  })
  pack.dispose()
  // 直接验证 resolveConfig 的 null 语义（纯函数，无副作用）——
  // 这才是本用例真正要守的东西：null 配置不得炸成 TypeError。
  const { resolveConfig } = await import('../src/index.js')
  assert.doesNotThrow(() => resolveConfig(null))
  const cfgFromNull = resolveConfig(null)
  assert.equal(cfgFromNull.listenHost, '0.0.0.0')
  assert.equal(cfgFromNull.listenPort, 3082)
  // 顺带把「null 等价空对象」这一契约写成断言，防止将来给 null 加特例分支
  assert.deepEqual(cfgFromNull, resolveConfig({}))
  // 端到端仍要跑一次真实 apply（用隔离端口与临时用户目录）
  const pack2 = makeCtx({})
  assert.doesNotThrow(() => {
    apply(pack2.ctx, {
      listenHost: '127.0.0.1',
      listenPort: 0,
      userStorePath: path.join(home, 'users2.json'),
      settingsFilePath: path.join(home, 'settings.yaml'),
    })
  })
  pack2.dispose()
})
