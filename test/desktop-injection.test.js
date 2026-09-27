/**
 * HTML 注入开关的桌面端口径测试。
 *
 * 桌面端与 web 端的注入策略差别：桌面浏览器**永远有原生桌面环境**（Electron 壳
 * 就长在那个桌面上），所以"打开配置文件"按钮的下载兜底注入不该出现；
 * 而 randomUUID polyfill 与 loopback 信任补丁在桌面端**同样必需**——经门卫
 * 从局域网 IP 访问 http:// 页面时是非安全上下文，且 dsh 客户端插件在桌面页面上
 * 也会装载（dsh.client 的 platform 门是 platform-agnostic 的），补丁必须照样注入。
 *
 * 本仓把 clientLoopbackTrust 的默认保留为 true（与 web 端一致），这条用例守住
 * 它不被误删——删掉会让桌面端经门卫访问时设置页全部退化成 memory 持久化。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { proxyRequest } from '../src/proxy.js'
import { startUpstream } from './helpers.js'

/** 起一个反代：注入 opts 原样传给 proxyRequest，返回 { port, close }。 */
async function startProxy(upstreamPort, injectOpts) {
  const srv = http.createServer((req, res) => {
    proxyRequest(req, res, '127.0.0.1', upstreamPort, 5000, 5000, injectOpts)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    port: srv.address().port,
    close: () => new Promise((r) => srv.close(r)),
  }
}

function get(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      .on('error', reject)
  })
}

const PAGE = '<html><head><title>dsh</title></head><body>app</body></html>'

async function withProxy(upstreamFactory, injectOpts, fn) {
  const up = await startUpstream(upstreamFactory)
  const px = await startProxy(up.port, injectOpts)
  try {
    return await fn(px)
  } finally {
    await px.close()
    await up.close()
  }
}

test('桌面端默认注入：randomUUID polyfill 与 loopback 信任补丁都在', async () => {
  const body = await withProxy(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    },
    { clientLoopbackTrust: true, settingsDownload: false },
    (px) => get(px.port),
  )
  assert.match(body, /crypto\.randomUUID/, '非安全上下文必须有 randomUUID polyfill')
  assert.match(body, /dsh-gw-logout-btn/, '改密/退出入口注入存在')
  assert.doesNotMatch(body, /__gateway\/settings\.yaml/, '桌面端不应注入设置文件下载兜底')
})

test('关掉 loopback 信任补丁时只剩 polyfill（开关确实生效）', async () => {
  const body = await withProxy(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    },
    { clientLoopbackTrust: false, settingsDownload: false },
    (px) => get(px.port),
  )
  assert.match(body, /crypto\.randomUUID/)
  // LOOPBACK_PATCH_TAG 关闭后不应出现（它改的是 connection.isLoopback）
  assert.doesNotMatch(body, /isLoopback/)
})

test('注入只发生在 text/html 且 2xx：JSON 与 500 页面原样透传', async () => {
  const json = await withProxy(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    },
    { clientLoopbackTrust: true, settingsDownload: true },
    (px) => get(px.port),
  )
  assert.equal(json, '{"ok":true}', 'JSON 响应不得被注入改写')

  const err = await withProxy(
    (req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' })
      res.end('<html><head></head><body>boom</body></html>')
    },
    { clientLoopbackTrust: true, settingsDownload: true },
    (px) => get(px.port),
  )
  assert.doesNotMatch(err, /crypto\.randomUUID/, '非 2xx 不注入')
})
