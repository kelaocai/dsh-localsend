# dsh-localsend

在 **DeepSeek Harness** 里用 **LocalSend 协议（v2.2）** 在局域网内发现设备、收发文件。Agent 可以直接把本地文件发到手机/其他电脑上的 LocalSend，也可以开启接收端，让其他设备把文件发进本机——全程不经过任何云端服务器。

> 这不是把 LocalSend App 本身做成插件，而是把它的**局域网传文件能力**做成了一个 DSH 工具（协议直连、零运行时依赖的纯 Node 实现）。

## 致谢 · 上游 LocalSend

本插件实现的是 [LocalSend](https://github.com/localsend/localsend) 的局域网传输协议，与官方客户端（手机 / 电脑）完全互通：插件既能发现并向它们发文件，也能作为接收端让它们把文件发进本机。感谢 LocalSend 团队的开源工作。

- **源码仓库**：[github.com/localsend/localsend](https://github.com/localsend/localsend)
- **协议文档**：[github.com/localsend/protocol](https://github.com/localsend/protocol)
- **下载安装版**（与插件互通）：官方站 <https://localsend.org> 或 [GitHub Releases](https://github.com/localsend/localsend/releases/latest) 提供 iOS / Android / macOS / Windows / Linux 各端安装包与源码打包。

<img width="1536" height="1024" alt="ChatGPT 图像 2026年11月11日 02_12_17" src="https://github.com/user-attachments/assets/b6ec0744-6871-4609-b19f-72586557c6e6" />


## 功能

插件有两半：

1. **Agent 工具** `localsend`，5 个动作：

| 动作 | 作用 |
|---|---|
| `discover` | 扫描局域网，列出可达的 LocalSend 设备（别名 / IP / 端口 / 协议 / 设备类型 / 指纹） |
| `send` | 把一个或多个本地文件发给指定设备（Upload API：prepare-upload → upload → cancel） |
| `receive` | 在本机启动一个 LocalSend 接收端，其他设备可把文件发进来 |
| `status` | 查看接收端状态与已收到的文件 |
| `stop` | 停止接收端 |

2. **侧边栏界面**（`LocalSend` 面板），和工具共享同一个接收端：

| 区域 | 能力 |
|---|---|
| 接收卡片 | 一键开启/停止接收，实时显示名称/端口/保存目录/已收文件（含完整路径，可一键复制路径） |
| 设备列表 | 自动扫描局域网设备（可手动刷新），点击选择设备 |
| 发送卡片 | 原生文件选择器选文件、或拖拽文件进面板、或直接输入主机路径，点「发送」 |

> 装好后需要**刷新一下 DSH 网页**（或开新会话），侧边栏才会出现 `LocalSend` 面板。

## 安装

### 方式一：Discover 市场（推荐）

在 DSH 的「插件 → Discover / 市场」里添加本插件的市场索引后即可浏览安装：

```
https://cdn.jsdelivr.net/gh/kelaocai/dsh-localsend@main/market/index.json
```

### 方式二：npm

```bash
npm install @kelaocai/dsh-localsend
```

或安装指定版本 `@kelaocai/dsh-localsend@0.1.4`。

### 方式三：本地 link（开发用）

在 DSH 的插件管理里用 `link:` 源安装，指向本仓库目录：

```
link:/path/to/dsh-localsend
```

## 使用示例

```text
# 发现设备
localsend(discover)

# 发一个文件到手机（别名或 ip:port 或指纹前缀均可定位设备）
localsend(action=send, device="iPhone", files=["/path/to/photo.jpg"])

# 如果对方设备要求 PIN
localsend(action=send, device="iPhone", files=["/path/to/a.pdf"], pin="123456")

# 开启接收端（手机 → 本机），文件落到指定目录
localsend(action=receive, destination="/Users/you/Downloads")

# 查看状态 / 停止
localsend(action=status)
localsend(action=stop)
```

## 配置（可选）

`cordis.patch.yml` 的 `config` 默认为空，运行时兜底如下，可在此处覆盖：

| 键 | 默认值 | 说明 |
|---|---|---|
| `alias` | `DeepSeek Harness` | 本机在局域网里对外显示的名字 |
| `port` | `53317` | 接收端 TCP/UDP 端口；被占用时自动改用随机空闲端口 |
| `autoReceive` | `true` | 插件加载时是否自动开启接收 |
| `deviceType` | `desktop` | 对外声明的设备类型 |
| `deviceModel` | `null` | 对外声明的设备型号 |
| `destination` | `$DSH_HOME/localsend-received` | 接收文件的落盘目录 |
| `certDir` | `~/.localsend-dsh/certs` | 本机身份证书（自签）的存放目录；首次运行自动生成，请勿提交或共享 |

## 协议实现要点

- **端口 53317**，发现用 UDP 组播 `224.0.0.167:53317`，传输用 HTTPS（自签证书）。
- **发现**：被动监听组播广播 + 主动发送 `announce` + 短期 HTTP `POST /api/localsend/v2/register` 应答器，三条路径合并去重。
- **发送**：`prepare-upload` 拿 `sessionId`+`token`，再流式 `upload`，失败时 `cancel`。
- **接收**：`https.createServer` 实现 `register` / `info` / `prepare-upload` / `upload` / `cancel`，按 `sha256` 校验，自动处理同名冲突。
- **指纹**：HTTPS 模式下指纹 = 证书 DER 的 SHA-256。首次运行时每台机器自动生成一份唯一自签证书并缓存，保证每台设备有稳定且互不相同的身份指纹。

## 安全说明

- 自签证书仅用于局域网内“首次连接即信任”的身份标识，不提供真正的证书链校验；**请只在可信局域网使用**。私钥只在首次运行时生成并保存在本机（默认 `~/.localsend-dsh/certs`，权限 0600），不随包发布。
- 发送端当前以 `rejectUnauthorized: false` 连接目标设备（LocalSend 客户端之间本就不做 CA 校验，而是靠用户核对指纹）；设备指纹会随 `discover` 结果返回，可供人工比对。

## 限制

- **组播不可用时**发现会失败（部分访客 Wi-Fi / AP 隔离）。此时可绕过发现：先 `send` 时直接给 `device` 传 `ip:port`（已知对方 IP 且协议直连仍可用）。
- **端口冲突**：若本机已运行 LocalSend 桌面端占用 53317，接收端会自动改用随机空闲端口（组播会广播真实端口，设备仍能发现）。
- **macOS 防火墙**：首次开启接收端时系统可能弹防火墙授权，允许后设备才能连入。
- **系统代理**：发送请求强制走直连（`agent: false`），绕过 `NODE_USE_ENV_PROXY` / Surge 等代理，避免局域网流量被代理劫持。

## 开发

```bash
# 运行协议与插件测试
node --test test/*.mjs
```

`protocol.js` 不依赖 DSH，可单独在任何 Node ≥ 20 环境测试（用到 `crypto.X509Certificate`）。

## 发布

包名为 `@kelaocai/dsh-localsend`，已固定公开发布到 npm 官方 registry。

```bash
npm run release:check  # 测试并预览打包内容
npm run release        # 检查通过后发布，按提示完成安全密钥验证
```

后续版本先更新 `package.json` 的版本号；已发布的版本号不能重复使用。
本地交互发布可能需要浏览器验证，普通登录不会取消发布时的双因素认证。
