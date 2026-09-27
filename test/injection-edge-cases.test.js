/**
 * HTML 注入的边界形态回归测试（审计第一轮补测）。
 *
 * injectTags 有四条注入路径（head 开标签后 / head 闭标签前 / body 闭标签前 /
 * 末尾兜底）。此前测试只覆盖了「结构完整」的 HTML；真实世界里宿主返回的
 * 错误页、极简页、被中间件改写过的页都可能缺 </head> 或 </body>。
 *
 * 判据：无论落在哪条路径，polyfill 都**必须**注入成功——否则非安全上下文下
 * crypto.randomUUID 缺失会让 dsh 客户端启动即崩，而页面看起来是「打开就白屏」，
 * 用户完全无法归因。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { proxyRequest } from '../src/proxy.js'
import { startUpstream } from './helpers.js'

async function fetchThroughProxy(html, status = 200) {
  const up = await startUpstream((req, res) => {
    res.writeHead(status, { 'content-type': 'text/html' })
    res.end(html)
  })
  const srv = http.createServer((req, res) => {
    proxyRequest(req, res, '127.0.0.1', up.port, 5000, 5000, { clientLoopbackTrust: true })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    return await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: srv.address().port, path: '/' }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })
        .on('error', reject)
    })
  } finally {
    await up.close()
    await new Promise((r) => srv.close(r))
  }
}

const POLYFILL_MARKER = 'crypto.randomUUID'

test('完整 HTML：polyfill 注入到 head 区', async () => {
  const body = await fetchThroughProxy('<html><head><title>t</title></head><body>x</body></html>')
  assert.match(body, new RegExp(POLYFILL_MARKER))
  assert.ok(body.indexOf(POLYFILL_MARKER) < body.indexOf('<body>'), '应落在 head 区')
})

test('缺 </head> 的极简 HTML：polyfill 仍必须注入（落 body 闭标签前）', async () => {
  const body = await fetchThroughProxy('<html><body><div>app</div></body></html>')
  assert.match(body, new RegExp(POLYFILL_MARKER), '缺 </head> 时不能漏注入')
})

test('缺 </head> 也缺 </body> 的畸形 HTML：polyfill 追加到末尾兜底', async () => {
  const body = await fetchThroughProxy('<html><body><div>partial')
  assert.match(body, new RegExp(POLYFILL_MARKER), '畸形 HTML 也必须注入（末尾兜底）')
})

test('空 HTML 响应：不崩且注入兜底生效', async () => {
  const body = await fetchThroughProxy('')
  assert.match(body, new RegExp(POLYFILL_MARKER), '空页面也要注入')
})

test('带 <header> 的页面：不误匹配 <head>，原标签完整保留', async () => {
  const body = await fetchThroughProxy('<html><head><title>t</title></head><body><header class="top">H</header></body></html>')
  assert.match(body, /<header class="top">H<\/header>/, '<header> 必须完整保留')
  assert.match(body, new RegExp(POLYFILL_MARKER))
})

test('gzip 压缩的畸形 HTML：解压后仍注入', async () => {
  const zlib = await import('node:zlib')
  const html = '<html><body><div>gz</div></body></html>'
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
    res.end(zlib.gzipSync(html))
  })
  const srv = http.createServer((req, res) => {
    proxyRequest(req, res, '127.0.0.1', up.port, 5000, 5000, { clientLoopbackTrust: true })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const body = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: srv.address().port, path: '/' }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })
        .on('error', reject)
    })
    assert.match(body, new RegExp(POLYFILL_MARKER), '压缩页解压后也必须注入')
    assert.match(body, /<div>gz<\/div>/)
  } finally {
    await up.close()
    await new Promise((r) => srv.close(r))
  }
})
