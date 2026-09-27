/**
 * 门卫自带 TLS（tls.enabled）**成功路径**的回归（审计第四轮补测）。
 *
 * 这是 index.js 里最后一条没有测试覆盖的分支：`https.createServer(...)` 那一支。
 * 此前只测了失败路径（证书不可读 → fail-fast）与 secureCookie 的派生行为
 * （Cookie 带 Secure、自产响应带 HSTS），从未验证「https 真的能起来并完成一次握手」。
 *
 * 为什么值得测：桌面端常见玩法是「在外面经自建反代/隧道访问」，那通常要 HTTPS；
 * 若这条分支有问题（例如证书读取顺序、https server 的 upgrade 绑定），
 * 用户会看到「开了 tls 之后端口连不上」，而所有测试仍全绿。
 *
 * 依赖处理：**不引运行时依赖、不在仓库里放私钥**。用系统 openssl 在临时目录现场生成自签证书；
 * 没有 openssl 的环境整组跳过（保持可移植性）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import https from 'node:https'

import { makeCtx, freePort, tempDir, request, login } from './helpers.js'

/** 检测 openssl 是否可用（不可用则整组跳过）。 */
function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasOpenssl = opensslAvailable()
const skipMsg = hasOpenssl ? false : '系统没有 openssl，跳过 TLS 成功路径测试'

/** 在临时目录生成一对自签证书，返回 { certPath, keyPath, dir }。 */
function makeSelfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-tls-cert-'))
  const certPath = path.join(dir, 'cert.pem')
  const keyPath = path.join(dir, 'key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })
  return { certPath, keyPath, dir }
}

/** 对 https 门卫发一次请求（自签证书 → 关闭校验）。 */
function httpsRequest(port, method, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path: urlPath, headers,
      rejectUnauthorized: false, // 自签证书：只验证「TLS 能建立」，不验证信任链
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  });
}

test('tls.enabled 成功路径：https 起得来、能握手、能返回登录页', { skip: skipMsg }, async () => {
  const { certPath, keyPath } = makeSelfSignedCert()
  const home = tempDir('gw-tls-ok-')
  const pack = makeCtx()
  const port = await freePort()
  const { apply } = await import('../src/index.js')
  assert.doesNotThrow(() => {
    apply(pack.ctx, {
      listenHost: '127.0.0.1',
      listenPort: port,
      userStorePath: path.join(home, 'users.json'),
      settingsFilePath: path.join(home, 'settings.yaml'),
      tls: { enabled: true, certPath, keyPath },
    })
  }, '合法证书下 tls.enabled 不得报错')
  try {
    // 等到 https 端口真的可连
    let res
    for (let i = 0; i < 40; i++) {
      try { res = await httpsRequest(port, 'GET', '/'); break } catch { await new Promise((r) => setTimeout(r, 50)) }
    }
    assert.ok(res, 'https 端口必须在超时内可连（否则 tls.enabled 等于把入口关掉了）')
    // 未初始化 → 302 跳 /setup，说明请求真的走到 handle() 里了
    assert.equal(res.status, 302, `https 上应正常处理请求，实际 ${res.status}`)
    assert.equal(res.headers.location, '/setup')
  } finally {
    pack.dispose()
  }
})

test('tls.enabled 成功路径：启用后自产响应带 HSTS（Secure 语义一并生效）', { skip: skipMsg }, async () => {
  const { certPath, keyPath } = makeSelfSignedCert()
  const home = tempDir('gw-tls-hsts-')
  const pack = makeCtx()
  const port = await freePort()
  const { apply } = await import('../src/index.js')
  apply(pack.ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    userStorePath: path.join(home, 'users.json'),
    settingsFilePath: path.join(home, 'settings.yaml'),
    tls: { enabled: true, certPath, keyPath },
  })
  try {
    let res
    for (let i = 0; i < 40; i++) {
      try { res = await httpsRequest(port, 'GET', '/'); break } catch { await new Promise((r) => setTimeout(r, 50)) }
    }
    assert.ok(res);
    assert.equal(
      res.headers['strict-transport-security'],
      'max-age=31536000',
      'HTTPS 部署必须发 HSTS（tls.enabled ⇒ secureCookie ⇒ HSTS）',
    )
  } finally {
    pack.dispose()
  }
})
