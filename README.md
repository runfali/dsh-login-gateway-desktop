# dsh-login-gateway-desktop

DeepSeek Harness **桌面客户端（Electron）** 的登录门卫插件。

dsh Desktop 的宿主进程（`dsh-desktop-host` 拉起）只监听回环地址，局域网里的其他电脑
访问不到。本插件在外部再开一个入口（默认 `0.0.0.0:3082`），访问者先通过**用户名密码登录**，
登录成功后再由门卫**全量反向代理**（HTTP + WebSocket）到桌面宿主。桌面宿主自己继续只监听回环。

反代目标端口是**运行时自动发现**的（读宿主 `webServer` 的实测监听端口），不写死任何值：
当前桌面宿主恰好是 `127.0.0.1:19387`，但那是 `dsh-desktop-host` 里的一个字面量，会被 profile
层的 `webserver` 配置覆盖、也可能随版本漂移——钉死它会让插件在宿主换端口后静默代理到错误目标。

零运行时依赖（只用 Node.js 内置模块），Node 22+ ESM。

> 本项目是 [dsh-login-gateway](https://github.com/runfali/dsh-login-gateway) 的**桌面端**二次开发版：
> 同一套登录墙 / 反代 / 令牌交换内核，默认部署面改成桌面宿主。两个仓库可以同时跑在同一台
> 机器的两个 profile 上——端口与数据目录都已分开。

> [!WARNING]
> **平台支持：目前仅在 Windows 上测试通过。** Linux 与 macOS 未经验证，请勿直接用于生产。
>
> 具体未覆盖的面：
> - 防火墙放行用的是 Windows 专用命令（`New-NetFirewallRule`），Linux/macOS 需自行等效配置；
> - `nativeOpenAvailable()` 的原生"在应用中打开"分支只在 Windows 上验证过；
> - 证书路径、令牌文件路径的写法按 Windows 习惯给出（`%USERPROFILE%`、盘符），其它平台需换成 POSIX 路径；
> - 全部 172 个测试用例的实测环境是 Windows + Node 24。
>
> 在其它平台使用前，请先跑 `node --test` 并自行验证局域网访问链路。

---

## 与 web 版的差别（只有这些）

| 项 | web 版 dsh-login-gateway | 本仓（桌面版） |
|---|---|---|
| 外部入口端口 | 3081 | **3082** |
| 反代目标 | 固定 127.0.0.1:**3080**（`dsh web`） | **运行时自动发现**宿主 `webServer` 实测端口（取不到才兜底 19387），不写死 |
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

## HTTPS（自签证书）

门卫**自带 TLS**，不需要前置 nginx/caddy。默认是明文 HTTP，打开 TLS 只需三步。

### 1. 生成自签证书

一条命令即可，**无需任何第三方工具链**——用系统 `openssl`：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\certs" | Out-Null
openssl req -x509 -newkey rsa:2048 -nodes -days 825 `
  -keyout "$env:USERPROFILE\.dsh\certs\gateway-key.pem" `
  -out    "$env:USERPROFILE\.dsh\certs\gateway-cert.pem" `
  -subj "/CN=dsh-desktop-gateway" `
  -addext "subjectAltName=IP:127.0.0.1,IP:<你的局域网IP>,DNS:localhost,DNS:<你的主机名>"
```

**SAN 必须按你实际的访问地址填写**（把 `<你的局域网IP>` 换成 `ipconfig` 里的真实 IPv4）。
浏览器是拿你地址栏里的地址去校验证书 SAN 的——只写 IP 就用 IP 访问，只写域名就用域名访问，
对不上就是证书错误。**换网络（换 Wi-Fi、换网段）后 IP 变了，需要重新签一张。**

证书放在 `%USERPROFILE%\.dsh\certs\` 是刻意的：在插件仓库之外，不会被误提交进版本库。

### 2. 在 profile 用户层启用

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，追加：

```yaml
- id: login-gateway
  config:
    listenHost: '0.0.0.0'
    listenPort: 3082
    targetHost: '127.0.0.1'
    sessionTtlHours: 24
    maxLoginAttempts: 5
    lockMinutes: 5
    clientLoopbackTrust: true
    tls:
      enabled: true
      certPath: 'C:\Users\<你>\.dsh\certs\gateway-cert.pem'
      keyPath: 'C:\Users\<你>\.dsh\certs\gateway-key.pem'
```

补丁是**整段替换** `config`——上面把默认项全部写全了，漏写一项就会回退成代码默认值。

### 3. 重启 dsh Desktop

profile 配置是**加载期**读取的，改完必须重启桌面端才生效（不像 `settings.yaml` 会热更新）。

### 生效后的变化

| 项 | 之前 | 之后 |
|---|---|---|
| 入口协议 | `http://<主机>:3082` | `https://<主机>:3082` |
| 会话 Cookie | 无 Secure 标记 | 自动带 `Secure` |
| 响应头 | 无 HSTS | `Strict-Transport-Security: max-age=31536000` |

### 让浏览器信任自签证书

自签证书不在系统信任库里，浏览器首次访问会拦一次。三选一：

1. **单次放行**：点"高级" → "继续前往"（每次新会话都要点）。
2. **导入信任库（推荐）**：双击 `gateway-cert.pem` → 安装到"受信任的根证书颁发机构"。之后所有 SAN 内的地址都不再报警。
3. **让其它电脑也信任**：把 `gateway-cert.pem`（**只给证书，绝不给 `gateway-key.pem`**）拷到那台机器，同样导入受信任根存储。

> [!IMPORTANT]
> **HSTS 是一道单向门。** 开启 TLS 后门卫会给浏览器下发 `max-age=31536000`（一年）的 HSTS，
> 浏览器在这一年内对该主机**强制走 HTTPS**，即使你之后改回明文 HTTP 也会被自动跳转。
> 若确定要退回 HTTP，需在浏览器里清掉该主机的 HSTS 记录
> （Chrome/Edge：`chrome://net-internals/#hsts` → Delete domain security policies）。

> [!NOTE]
> **TLS 只加密"浏览器 → 门卫"这一跳。** 门卫到宿主是本机回环（`127.0.0.1`），本来就是明文且不出网，
> 无需加密。所以自带 TLS 与前置反代 TLS 二选一即可，不要叠加。

---

## 工作原理

```
局域网浏览器 ──HTTP/WS──▶ 0.0.0.0:3082（门卫：登录校验 + 会话 Cookie）
                              │ 通过校验后全量反代（Host/Origin 改写为 loopback 形态）
                              ▼
                    127.0.0.1:<自动发现的宿主端口>（dsh Desktop 宿主，信任围栏放行）
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
| `tls` | 无 | 自带 HTTPS：`{ enabled: true, certPath, keyPath }`。启用后自动开 `secureCookie`（Cookie 带 Secure）并下发 HSTS；证书读不到会**显式启动失败**（fail-fast），不会静默退回明文 |

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 其他电脑连不上 | 防火墙没放行 3082；或门卫没起（看宿主日志里的 `外部入口已启动`） |
| 登录后页面白屏 | 宿主没在跑：确认 dsh Desktop 开着，`netstat -ano | findstr LISTENING` 里有宿主进程在听回环端口 |
| 登录后 `502` | 反代目标不可达。看启动日志 `外部入口已启动…反代至 …`（会标注「自动发现/兜底」），确认它指的端口确实在听；只有日志显示「兜底」时才需要处理 |
| 设置改了不生效 | `clientLoopbackTrust` 被关掉了，设置页退化成内存持久化 |
| 页面能开但交互报错 | 非安全上下文缺 `crypto.randomUUID`：确认 HTML 注入没被前置反代剥掉 |
| 开了 tls 后端口连不上 | 证书路径写错或文件不可读（启动会 fail-fast 报错）；确认是否同时起了别的服务占端口 |
| 浏览器报证书无效 | 自签证书未被信任，或 SAN 里没有你地址栏用的那个地址（IP/域名不匹配）。重签并把 SAN 写全，或把 `gateway-cert.pem` 导入受信任根存储 |
| 改回 http 却被自动跳 https | 之前收了 HSTS（一年有效）。到浏览器的 `net-internals/#hsts` 删掉该域名的安全策略 |
| 忘记密码 | 删掉 `%USERPROFILE%\.dsh-login-gateway-desktop\users.json`，重启后重新走 `/setup` |

---

## 安全说明

- 门卫只提供**登录墙 + 反代**，不改变 dsh 本身的权限模型：登录进来的用户对这台电脑拥有
  dsh Desktop 的全部能力（跑命令、改文件）。**只在你信任的网络里开**。
- 跨公网访问**必须开 TLS**（见上方「HTTPS（自签证书）」）：明文 HTTP 下密码与 Session Cookie
  以明文过网，且浏览器处于非安全上下文。
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
