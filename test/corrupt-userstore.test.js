/**
 * 审计第一轮补测：损坏的 users.json 不能让插件「静默消失」。
 *
 * 缺陷（修复前）：`loadUsersSync` 对格式损坏的用户文件**抛出**，异常一路穿到
 * `apply()`，插件挂载失败——用户看到的现象是「局域网入口根本不存在」，
 * 唯一的线索只在宿主 stderr 日志里，普通用户完全无法归因。
 *
 * 期望行为：
 *   1. `apply()` 不抛异常（插件必须挂起来，端口必须监听）
 *   2. 日志里出现**可操作**的提示（点名文件路径 + 恢复办法）
 *   3. 状态回到「未初始化」，用户能走 /setup 重建账号自救
 *   4. 损坏文件被**备份**而不是直接丢弃（不静默毁数据）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../src/index.js'
import { makeCtx, request, freePort } from './helpers.js'

const BAD_JSON = '{ this is not valid json'

function setupCorruptProfile(content) {
  const home = mkdtempSync(path.join(tmpdir(), 'gw-corrupt-'))
  const usersPath = path.join(home, 'users.json')
  writeFileSync(usersPath, content)
  return { home, usersPath }
}

test('损坏的 users.json：apply 不抛异常，端口照常监听', async () => {
  const { usersPath } = setupCorruptProfile(BAD_JSON)
  const pack = makeCtx()
  const port = await freePort()
  assert.doesNotThrow(() => {
    apply(pack.ctx, {
      listenHost: '127.0.0.1',
      listenPort: port,
      userStorePath: usersPath,
      settingsFilePath: path.join(path.dirname(usersPath), 'settings.yaml'),
    })
  }, '损坏的用户文件不得让插件挂载失败')

  // 端口真的起来了（而不是「没抛异常但也没监听」）
  const res = await request(port, 'GET', '/')
  assert.equal(res.status, 302, '应可访问并跳转到 /setup 自救')
  pack.dispose()
})

test('损坏的 users.json：日志点名文件路径与恢复办法', async () => {
  const { usersPath } = setupCorruptProfile(BAD_JSON)
  const pack = makeCtx()
  const port = await freePort()
  apply(pack.ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    userStorePath: usersPath,
    settingsFilePath: path.join(path.dirname(usersPath), 'settings.yaml'),
  })
  const joined = pack.logs.join('\n')
  assert.match(joined, /users\.json/, '日志必须点名出问题的文件')
  assert.match(joined, /\/setup/, '日志必须给出恢复路径（/setup）')
  pack.dispose()
})

test('损坏的 users.json：备份原文件，不静默丢数据', async () => {
  const { home, usersPath } = setupCorruptProfile(BAD_JSON)
  const pack = makeCtx()
  const port = await freePort()
  apply(pack.ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    userStorePath: usersPath,
    settingsFilePath: path.join(home, 'settings.yaml'),
  })
  const backups = readdirSync(home).filter((f) => f.includes('users.json') && f.includes('corrupt'))
  assert.equal(backups.length, 1, `应留下 1 份损坏文件备份，实际目录：${JSON.stringify(readdirSync(home))}`)
  assert.equal(readFileSync(path.join(home, backups[0]), 'utf8'), BAD_JSON, '备份内容必须与原文件逐字一致')
  pack.dispose()
})

test('损坏的 users.json：状态回到未初始化，/setup 可用', async () => {
  const { home, usersPath } = setupCorruptProfile(BAD_JSON)
  const pack = makeCtx()
  const port = await freePort()
  apply(pack.ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    userStorePath: usersPath,
    settingsFilePath: path.join(home, 'settings.yaml'),
  })
  // 未初始化时 /setup 返回引导页（200），而不是 410（已初始化）
  const res = await request(port, 'GET', '/setup')
  assert.equal(res.status, 200, '损坏后必须能走 /setup 重建账号')
  pack.dispose()
})

test('结构合法但 users 字段类型错误：同样走损坏恢复路径', async () => {
  const { home, usersPath } = setupCorruptProfile(JSON.stringify({ users: 'not-an-array' }))
  const pack = makeCtx()
  const port = await freePort()
  assert.doesNotThrow(() => {
    apply(pack.ctx, {
      listenHost: '127.0.0.1',
      listenPort: port,
      userStorePath: usersPath,
      settingsFilePath: path.join(home, 'settings.yaml'),
    })
  })
  const res = await request(port, 'GET', '/setup')
  assert.equal(res.status, 200)
  pack.dispose()
})
