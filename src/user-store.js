/**
 * dsh-login-gateway-desktop 用户存储：JSON 文件 + 原子写入（同步版本）。
 * 仅在插件启动阶段一次性调用；零外部依赖，只使用 node:fs 与 node:path。
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 读取用户文件，返回用户数组 `[{ username, passwordHash, createdAt }]`，
 * 或一个描述「为何不可用」的 `{ corrupt, reason }` 标记。文件不存在返回 null。
 *
 * **不抛异常**：用户文件损坏（手改错、磁盘写坏、外部工具改写）时，抛出去会一路
 * 穿过 apply() 让插件挂载失败——用户看到的现象是「局域网入口直接不存在」，
 * 而唯一线索只在宿主 stderr 里。改为返回损坏标记，由调用方降级成「未初始化」，
 * 让用户还能走 /setup 自救。
 *
 * @returns {Array|null|{corrupt: true, reason: string}}
 */
export function loadUsersSync(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err // 权限/IO 类错误仍上抛：不是「数据坏」而是「环境坏」，静默降级会掩盖真问题
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { corrupt: true, reason: '不是有效 JSON' }
  }
  if (!data || !Array.isArray(data.users)) {
    return { corrupt: true, reason: '缺少 users 数组' }
  }
  const users = data.users.filter((u) => u && typeof u.username === 'string' && typeof u.passwordHash === 'string')
  // 空数组等同"未初始化"：否则 /setup 返回 410、登录永远 401，且没有任何报错，
  // 只能靠人工删文件恢复（曾把空 users 数组判为已初始化）。
  return users.length > 0 ? users : null
}

/**
 * 把损坏的用户文件备份成 `users.json.corrupt-<时间戳>` 后从原路径移除，
 * 让插件能退回「未初始化」并重建账号。
 *
 * **绝不静默丢数据**：损坏文件里可能仍有用户想抢救的账号信息（比如只少了一个
 * 引号），直接删掉等于毁证据。备份失败时不删原文件——宁可下次启动继续报损坏，
 * 也不能让用户的数据凭空消失。
 *
 * @returns {string|null} 备份文件路径；失败返回 null（原文件保持不动）
 */
export function quarantineUsersSync(path, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backup = `${path}.corrupt-${stamp}`
  try {
    copyFileSync(path, backup)
  } catch {
    return null
  }
  try {
    renameSync(path, `${path}.replaced-${stamp}`)
  } catch {
    // 原文件挪不走也不影响：调用方按未初始化继续，备份已保住数据
  }
  return backup
}

/**
 * 原子写入用户文件：先写临时文件再 rename，避免写一半损坏。
 * 自动创建父目录（默认 ~/.dsh-login-gateway-desktop 可能不存在）。
 */
export function saveUsersSync(path, users) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ users }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}
