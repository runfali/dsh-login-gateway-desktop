# dsh-login-gateway-desktop

DeepSeek Harness **桌面客户端（Electron）** 的登录门卫插件。

dsh Desktop 的宿主进程（`dsh-desktop-host` 拉起）只监听 `127.0.0.1:19387`，局域网里的
其他电脑访问不到。本插件在外部再开一个入口（默认 `0.0.0.0:3082`），访问者先通过
**用户名密码登录**，登录成功后再由门卫**全量反向代理**（HTTP + WebSocket）到桌面宿主。
桌面宿主自己继续只监听回环。

零运行时依赖（只用 Node.js 内置模块），Node 22+ ESM。

> 本项目是 [dsh-login-gateway](https://github.com/runfali/dsh-login-gateway) 的**桌面端**二次开发版：
> 同一套登录墙 / 反代 / 令牌交换内核，默认部署面改成桌面宿主。两个仓库可以同时跑在同一台
> 机器的两个 profile 上——端口与数据目录都已分开。

---

## 与 web 版的差别（只有这些）

| 项 | web 版 dsh-login-gateway | 本仓（桌面版） |
|---|---|---|
| 外部入口端口 | 3081 | **3082** |
| 反代目标 | 127.0.0.1:**3080**（`dsh web`） | **自动发现**宿主实测端口，兜底 127.0.0.1:**19387**（dsh Desktop 宿主） |
| 用户存储 | `~/.dsh-login-gateway/` | `~/.dsh-login-gateway-desktop/` |
| 安装 profile | `web`（`dsh plugin --profile web add`） | `desktop`（应用内插件页，见下） |
| 登录墙 / 反代 / 令牌交换 / 限速 / 改密 | 完全相同 | 完全相同 |

端口分开是刻意的：桌面宿主和 `dsh web` 可能同时跑在同一台机器上，撞端口会 `EADDRINUSE`；
用户目录分开是刻意的：两个门卫各管各的账号与一次性令牌。

---

## 桌面端安装

桌面 profile 由 Electron 独占管理——`dsh plugin --profile desktop add` 会被 CLI 直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

因此装法有三种，任选其一：

**方式 A：应用内插件页（推荐）**

打开 dsh Desktop → 左侧 **插件** 页 → 安装本地目录 `D:\DSH\dsh-login-gateway-desktop`
（或本仓所在路径）。插件页走的是与应用同一套 Plugin Manager，会把包名追加进
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。

**方式 B：手改 profile 清单 + pnpm**

```powershell
# 1) 关掉 dsh Desktop（profile 有锁，运行中改会被 DesktopProjectManager 拒绝）
# 2) 在桌面 profile 里把本仓库装成 link
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:/DSH/dsh-login-gateway-desktop"
# 3) 编辑 package.json，把 dsh-login-gateway-desktop 追加到 dsh.profile.bundles 末尾
# 4) 重启 dsh Desktop
```

**方式 C：让 dsh 自己装**

在 dsh Desktop 的会话里让 agent 调用插件管理工具（`tool-plugin-manager`）安装本目录。

装好后**重启 dsh Desktop** 生效。

---

## 快速开始（首次使用）

1. 拿一次性初始化令牌，二选一：
   - 看 dsh Desktop 的宿主日志：门卫启动时会打印一行
     `[login-gateway] 登录门卫未初始化，请访问 http://<主机>:3082/setup 并输入一次性令牌：XXXX-...`
   - 读令牌文件：`%USERPROFILE%\.dsh-login-gateway-desktop\setup-token.txt`
2. 浏览器打开 `http://<这台电脑的局域网IP>:3082/setup`，输入令牌 + 管理员用户名 + 密码（≥8 位）。
3. 初始化完成后跳转登录页，用刚建的账号登录，即可进入**这台电脑上正在运行的 dsh Desktop**。

> 令牌只在未初始化阶段有效；初始化完成后 `/setup` 返回 410，令牌文件被删除。

---

## 局域网访问

1. 确认门卫在监听：`netstat -ano | findstr 3082`（应为 `0.0.0.0:3082`）。
2. 其他电脑打开 `http://<本机局域网IP>:3082`。
3. 放行防火墙入站端口 3082（管理员 PowerShell）：
   ```powershell
   New-NetFirewallRule -DisplayName "dsh desktop gateway 3082" -Direction Inbound -Protocol TCP -LocalPort 3082 -Action Allow
   ```

多网卡机器用真实的局域网 IPv4（`ipconfig`），不要用 `127.0.0.1` 或 WSL 的虚拟网卡地址。

---

## 工作原理

```
局域网浏览器 ──HTTP/WS──▶ 0.0.0.0:3082（门卫：登录校验 + 会话 Cookie）
                              │ 通过校验后全量反代（Host/Origin 改写为 loopback 形态）
                              ▼
                        127.0.0.1:19387（dsh Desktop 宿主，信任围栏放行）
```

三个要点：

1. **信任围栏**：dsh 0.1.2+ 的 `/api` 会校验 `Host`，非 loopback 一律 403。门卫把
   `Host`/`Origin`/`Sec-Fetch-Site` 改写成 loopback 形态，让宿主把请求当作本机请求放行。
2. **浏览器鉴权（令牌交换）**：dsh 0.1.2+ 起首页与 `/api` 必须携带宿主签发的 `dsh-auth-*`
   Cookie，而该 Cookie 只能用启动令牌换取。启动令牌只打印在宿主终端里，远端浏览器拿不到
   ——所以门卫在「已登录用户的首页导航」上**代跑一次交换**，把 `303 + Set-Cookie` 原样透传给
   浏览器。令牌只出现在门卫→宿主这一跳，不进入任何下发给浏览器的内容。
3. **HTML 注入**：经非 loopback 的 `http://` 页面访问时浏览器处于**非安全上下文**，
   `crypto.randomUUID` 不存在，dsh 客户端会启动即崩。门卫在反代 HTML 时注入 polyfill；
   同时注入「改密 / 退出」悬浮栏，并修正 dsh 的 loopback 判定（否则设置页会退化成内存
   持久化，改了不生效且不报错）。

---

## 配置项

随包挂载层（`cordis.patch.yml`）只给默认值。要改就在桌面 profile 的用户层覆盖：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: login-gateway
  config:
    listenHost: '0.0.0.0'
    listenPort: 3082
    targetHost: '127.0.0.1'
    # targetPort 故意不写 = 自动发现（运行时读宿主 webServer 实测端口，取不到才兜底 19387）。
    # 需要强制钉到某个端口时才在这里显式写，写了它发现就不再生效。
    sessionTtlHours: 24
    maxLoginAttempts: 5
    lockMinutes: 5
    clientLoopbackTrust: true
```

注意：补丁是**整段替换** `config`，覆盖时必须把要保留的项全部写全。

| 字段 | 默认 | 说明 |
|---|---|---|
| `listenHost` | `0.0.0.0` | 门卫监听地址 |
| `listenPort` | `3082` | 门卫监听端口（3081 留给 web 版） |
| `targetHost` | `127.0.0.1` | 桌面宿主地址 |
| `targetPort` | *自动发现* | 不写 = 运行时读宿主 `webServer` 实测端口，取不到才兜底 19387；显式写则钉死 |
| `sessionTtlHours` | `24` | 登录会话有效期 |
| `maxLoginAttempts` | `5` | 单维度失败上限 |
| `lockMinutes` | `5` | 触发上限后的锁定时长 |
| `clientLoopbackTrust` | `true` | 注入 loopback 信任补丁（设置持久化必需） |
| `settingsFileDownload` | `true` | 暴露 `/__gateway/settings.yaml` 下载路由 |
| `trustProxy` | `false` | 前置反代时置 true 才信 `X-Forwarded-For` |
| `tls` | 无 | 自带 HTTPS：`{ enabled: true, certPath, keyPath }` |

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 其他电脑连不上 | 防火墙没放行 3082；或门卫没起（看宿主日志里的 `外部入口已启动`） |
| 登录后页面白屏 | 宿主没在跑：确认 dsh Desktop 开着，`netstat -ano | findstr 19387` 有监听 |
| 登录后 `502` | 反代目标不可达。看启动日志 `外部入口已启动…反代至 …`（会标注「自动发现/兜底」），确认它指的端口确实在听；只有日志显示「兜底」时才需要处理 |
| 设置改了不生效 | `clientLoopbackTrust` 被关掉了，设置页退化成内存持久化 |
| 页面能开但交互报错 | 非安全上下文缺 `crypto.randomUUID`：确认 HTML 注入没被前置反代剥掉 |
| 忘记密码 | 删掉 `%USERPROFILE%\.dsh-login-gateway-desktop\users.json`，重启后重新走 `/setup` |

---

## 安全说明

- 门卫只提供**登录墙 + 反代**，不改变 dsh 本身的权限模型：登录进来的用户对这台电脑拥有
  dsh Desktop 的全部能力（跑命令、改文件）。**只在你信任的网络里开**，或配合自带 TLS /
  前置反代使用。
- 登录失败限速是双维度的（IP + 用户名），并有全局节流防 CPU 打满。
- 会话 Cookie 默认绑定 User-Agent，被嗅探后在别的客户端上不可复用。
- `trustProxy` 直连场景必须保持 `false`，否则攻击者可伪造 `X-Forwarded-For` 绕过限速。

---

## 开发

```sh
node --test          # 全部测试（零依赖，node 内置 test runner）
```

`docs/` 是内部适配与审计记录，不随包发布（见 `.gitignore`）。

## License

MIT
