/**
 * 测试隔离性守护（审计第二轮补测）。
 *
 * 缺陷背景：`apply(ctx, null)` / `apply(ctx, {})` 这类「不传 userStorePath」的调用会
 * 让插件回落到**真实用户目录** `~/.dsh-login-gateway-desktop/`，并写入一次性令牌文件；
 * 同时 listenPort 回落到 3082、listenHost 回落到 0.0.0.0 —— 测试会真的把局域网端口绑起来。
 *
 * 实测证据（2026-09-27）：跑完全量测试后，
 *   `~/.dsh-login-gateway-desktop/setup-token.txt` 的 mtime 被刷新为当天时间，
 *   而当时插件并未安装（桌面 profile 的 bundles 里没有它，3082 也无人监听）。
 *
 * 为什么必须守住：
 *   1. 测试污染真实用户目录 —— 用户真实实例可能因此读到不该有的令牌文件/状态；
 *   2. 测试把 0.0.0.0:3082 真绑起来，若真实门卫也在跑会撞 EADDRINUSE，出现随机失败；
 *   3. 这类「测试写进了用户家目录」的缺陷完全静默，没人会注意到。
 *
 * 做法：静态扫描 test/ 下所有 `apply(` 调用点，要求同一个调用参数里出现 userStorePath
 * 与 listenPort（显式端口，避免回落 3082）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 收集 test/ 下真正会**启动门卫服务**的 `apply(` 调用（括号配平）。
 *
 * 只认来自 `../src/index.js` 的 apply：client.test.js 里的 `apply` 是
 * **浏览器端 bundle** 的 apply（测 isLoopback 修正），它不监听端口也不碰用户目录。
 * 用「同一文件是否 import 了 ../src/index.js」来区分，避免误报。
 */
function findApplyCalls(source) {
  // 该文件是否导入宿主插件入口
  if (!/from\s+'\.\.\/src\/index\.js'|import\('\.\.\/src\/index\.js'/.test(source)) return []
  const calls = []
  const re = /\bapply\s*\(/g
  let m
  while ((m = re.exec(source)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    const text = source.slice(start, i + 1)
    const line = source.slice(0, m.index).split('\n').length
    calls.push({ text, line })
  }
  return calls
}

test('测试里的 apply() 调用必须显式传 userStorePath（不得污染真实用户目录）', () => {
  const offenders = []
  for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
    const src = readFileSync(path.join(testDir, file), 'utf8')
    for (const { text, line } of findApplyCalls(src)) {
      // 只看「直接把 cfg 字面量内联进去」的调用；经变量传入的无法静态判定
      if (!text.includes('{')) continue
      if (!/userStorePath/.test(text)) offenders.push(`${file}:${line} 缺少 userStorePath`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下 apply() 调用会回落到真实用户目录 ~/.dsh-login-gateway-desktop/：\n${offenders.join('\n')}`,
  )
})

test('测试里的 apply() 调用必须显式传 listenPort（不得回落到局域网端口 3082）', () => {
  const offenders = []
  for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
    const src = readFileSync(path.join(testDir, file), 'utf8')
    for (const { text, line } of findApplyCalls(src)) {
      if (!text.includes('{')) continue
      // listenPort: 0 也算显式（OS 分配空闲端口）
      if (!/listenPort/.test(text)) offenders.push(`${file}:${line} 缺少 listenPort`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下 apply() 调用会回落到 0.0.0.0:3082（真实门卫端口）：\n${offenders.join('\n')}`,
  )
})

test('startGateway 测试桩必须固定 targetPort，不得指向真实桌面宿主 19387', () => {
  // 第一轮的实测：不传 targetPort 时 startGateway 会用插件默认值 19387，
  // 测试会真的把请求打到用户正在运行的 dsh Desktop 宿主上（读到它的 401 正文），
  // 既是越权副作用，也是「假绿/假红」的来源。
  const helpers = readFileSync(path.join(testDir, 'helpers.js'), 'utf8')
  assert.match(
    helpers,
    /targetPort/,
    'helpers.startGateway 必须提供 targetPort 默认值（隔离真实宿主）',
  )
})
