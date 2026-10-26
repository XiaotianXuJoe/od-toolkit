# 华为OD题解工作流 —— 服务器部署说明（端口 4000，含风格数据后端）

一体化服务 `server.py`（Python 标准库，**零第三方依赖**，3.8+ 即可）：

- 静态托管 `app/` 下全部 7 个页面
- 风格学习数据后端保存：`GET/PUT /api/style`，原子写入 `data/style_store.json`
- API 中转：`/api/proxy/*`，解决第三方 API 端点不支持浏览器跨域（CORS）的问题
- 可选同步密钥：环境变量 `SYNC_TOKEN` 设置后，仅 `/api/proxy` 中转请求需携带 `X-Sync-Token` 头；
  `/api/style` 风格数据接口默认**免密**（与主站页面一致开箱即用，多设备打开即同步）。
  如需恢复风格接口鉴权，设环境变量 `STYLE_AUTH=1`（此时浏览器端设置面板需填写同一密钥才能同步）。

数据流向：浏览器打开页面时自动从服务器拉取风格数据（样本库/风格档案/开关/提示词）覆盖本地；
每次修改防抖 600ms 推回服务器。服务器不可达时自动退回浏览器 localStorage，功能不受影响。
API Key 只保存在访客浏览器本地；仅在直连失败进入中转模式时，Key 随请求经本服务器转发到
API 端点，服务器不存储、不记录。

- 代码微调记忆：`GET/PUT /api/memory`，记忆中心页（memory.html）管理。
  生成/转换/微调代码后出现确认条，用户「确认无误」且结果与 AI 原版有差异时，
  自动调用 LLM 对比前后代码提炼 1~3 条偏好规则存入服务器；后续生成的提示词自动注入
  同功能（题解/模板/转换）的历史规则，逐步逼近用户习惯。功能默认关闭，记忆中心开启。

## API 中转（/api/proxy）

**为什么需要**：浏览器直连第三方 API 时，带 `Authorization` 头的请求会触发 CORS 预检（OPTIONS）。
部分端点/中转站预检不返回 CORS 头（甚至返回 401），浏览器直接拦截，页面表现为
「Failed to fetch」——此时前端会自动切换到同源 `/api/proxy/*`，由服务器代为转发。

**工作方式**：
- 前端直连抛出网络层错误（TypeError）时自动切中转，本会话内记住该模式，切换时 toast 提示；
  下次直连恢复后仍走中转记忆（同一会话），刷新页面后重新探测。
- 请求头 `X-Upstream-Base` 指定上游（如 `https://api.moonshot.cn/v1`），服务器仅透传
  `Authorization` 与 `Content-Type` 两个头；上游响应（含 4xx 业务错误）原样回传，并带
  `X-Proxied: 1` 响应头，前端据此区分「中转可用但密钥缺失」与「中转不存在」。
- 中转同样受 `SYNC_TOKEN` 保护：服务器设了密钥而浏览器没填时，返回 401 并提示填写。

**服务器内置 Key（打开即用模式）**：
- 设环境变量 `UPSTREAM_API_KEY`（+ 可选 `UPSTREAM_BASE`）后，浏览器端 **API Key 留空即可使用**：
  前端不带 Authorization 直走中转，服务器自动注入内置 Key；未带 `X-Upstream-Base` 时用 `UPSTREAM_BASE`。
- 访客自带 Key 的请求不受影响（原样透传，不会被内置 Key 覆盖）。
- Key 只存在于服务器环境变量，不进代码、不进仓库；启动日志只打印前4后4位掩码。
- `/api/health` 返回 `serverKey: true` 表示已配置。
- ⚠️ 注意：此模式下任何能访问站点的人都消耗你的 API 配额，适合个人/小圈子部署；
  如需限制，同时设置 `SYNC_TOKEN`（中转恢复鉴权，浏览器填一次同步密钥即可）。

**安全边界**：
- 上游仅允许 **https 公网地址**，私网/回环/保留地址一律拒绝（SSRF 防护）。
- **上游主机白名单**：默认只放行常见 OpenAI 兼容端点
  （`api.moonshot.cn`、`api.deepseek.com`、`api.siliconflow.cn`、`api.openai.com`、
  `open.bigmodel.cn`、`dashscope.aliyuncs.com`、`ai.ctaigw.cn`），防止服务器被当作通用开放代理。
  白名单外主机返回 403 并说明原因。
- 需要新增上游：设环境变量 `PROXY_ALLOWED_HOSTS=api.moonshot.cn,你的域名`（英文逗号分隔，
  **覆盖**默认列表，请把默认项一并写上）。显式设为空字符串表示不限制（不推荐）。
- `PROXY_ALLOW_PRIVATE=1`：允许 http/私网上游并跳过白名单，**仅供本地测试**，切勿在生产设置。
- 中转单请求超时 150s（大于前端 120s 单请求超时），请求体上限 64MB。

**何时不用它**：端点本身支持 CORS（如官方 api.moonshot.cn）时浏览器直连即可，不经过服务器。

## 部署步骤

### 1. 上传到服务器

```bash
scp od-toolkit-port4000.tar.gz root@你的服务器IP:/opt/
ssh root@你的服务器IP
cd /opt && tar -xzf od-toolkit-port4000.tar.gz && mv od-toolkit-deploy od-toolkit
```

### 2. 启动（四选一）

**方式 A：一键脚本（最快验证）**
```bash
cd /opt/od-toolkit
SYNC_TOKEN=你的密钥 bash start.sh -d   # 后台运行，日志 server.log
bash stop.sh                            # 停止
```

**方式 B：systemd 常驻（推荐正式使用）**
```bash
# 先编辑 od-toolkit.service：确认路径、设置 SYNC_TOKEN
cp /opt/od-toolkit/od-toolkit.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now od-toolkit
systemctl status od-toolkit
```

**方式 C：Docker**
```bash
cd /opt/od-toolkit
SYNC_TOKEN=你的密钥 docker compose up -d --build
# 或不用 compose：
# docker build -t od-toolkit . && docker run -d --name od-toolkit -p 4000:4000 \
#   -e SYNC_TOKEN=你的密钥 -v $(pwd)/data:/srv/data --restart unless-stopped od-toolkit
```

**方式 D：已有 Nginx 反代**
`server.py` 本身监听 4000；用 Nginx 反代到 4000 即可（含 /api/ 路径一起转发），参考 nginx.conf。

### 3. 放行端口

```bash
ufw allow 4000                                                           # Ubuntu/Debian
firewall-cmd --permanent --add-port=4000/tcp && firewall-cmd --reload   # CentOS/RHEL
```
云服务器还需在**控制台安全组**放行 TCP 4000。

### 4. 访问与配置

浏览器打开 `http://服务器IP:4000`，点右上角 ⚙️ 设置：
- **API Key 可留空**（服务器设了 `UPSTREAM_API_KEY` 时推荐）：留空即自动使用服务器内置 Key，打开即用
- 或填自己的 Key：API 端点 `https://api.moonshot.cn/v1` + 你的 Kimi Key（仅存浏览器本地）
- 模型 `kimi-k2.6`，temperature 保持 0.6（`kimi-latest` 已于 2026-01-28 退役，勿用）
- **同步密钥**：仅当服务器设了 `SYNC_TOKEN` 且你要用「API 中转」时填写；风格数据同步默认免密，无需为此填写（若管理员设了 `STYLE_AUTH=1`，则风格同步也需填写）
- 可用「测试连接」按钮自助诊断：成功列出模型数 / 401 密钥无效 / 404 Base URL 错误 / 网络失败自动走中转

## 运维

- **备份**：`data/style_store.json` 一个文件即全部风格数据，定期复制即可
- **更新**：替换 `app/` 与 `server.py` 后 `systemctl restart od-toolkit`（或 `bash stop.sh && SYNC_TOKEN=... bash start.sh -d`）
- **健康检查**：`curl http://127.0.0.1:4000/api/health` → `{"ok":true,...}`

## 常见问题

- **页面能开但 API 报 Failed to fetch**：端点不支持浏览器跨域，前端会自动切换服务器中转；
  若仍失败，看中转日志确认上游地址在白名单内
- **API 报 403「上游主机不在白名单」**：你的 Base URL 主机未放行，按上文「API 中转」一节
  设置 `PROXY_ALLOWED_HOSTS` 后重启
- **提示"同步密钥不正确"**：仅影响 API 中转——设置面板的密钥与服务器 SYNC_TOKEN 不一致；
  风格数据同步默认免密不受此影响（除非管理员设了 `STYLE_AUTH=1`）
- **复制按钮无反应**：HTTP 环境下浏览器限制剪贴板 API，前端已自动降级（execCommand），
  正常应有成功 toast；彻底解法是按下节上 HTTPS
- **想换端口**：改 PORT 环境变量即可（脚本/service/compose 都支持）

## 启用 HTTPS（现役部署已启用，自签名证书）

HTTP 明文下，中转转发的 API Key 与 X-Sync-Token 头在传输链路上可被嗅探；且浏览器剪贴板
等能力受限。当前线上部署结构：

```
浏览器 ──https──> nginx :4000（SSL 终止）──http──> server.py 127.0.0.1:4001
```

- 证书：自签名 `/etc/nginx/ssl/od-toolkit.crt`（SAN 含 IP 与 `175.178.16.78.nip.io`，10 年）；
  浏览器首次访问需确认「继续前往」例外，之后剪贴板等安全上下文能力恢复
- nginx 配置：`/etc/nginx/conf.d/od-toolkit-https.conf`（listen 4000 ssl → proxy 127.0.0.1:4001）
- server.py 支持 `HOST` 环境变量，systemd 已设 `HOST=127.0.0.1`、`PORT=4001`，后端不再直接暴露
- 旧 `http://IP:4000` 会得到 nginx 400 提示页，请改用 `https://175.178.16.78:4000`

**为什么不是 Let's Encrypt**：本机实测 LE 多点验证跨境链路被稳定 RST/超时（nginx 日志可见
验证请求到达且返回 200，但响应被重置），4 次尝试均失败。后续若有自己的域名（非 nip.io 这类
公共泛解析），可再试 `certbot certonly --nginx -d 你的域名`；80 端口的 ACME server 块
（`/etc/nginx/conf.d/od-acme.conf`）已备好。

**自行复现自签名方案**：
```bash
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/od-toolkit.key -out /etc/nginx/ssl/od-toolkit.crt -days 3650 \
  -subj /CN=服务器IP -addext subjectAltName=IP:服务器IP
# nginx: listen 4000 ssl + proxy_pass http://127.0.0.1:4001
# systemd: Environment=PORT=4001 + Environment=HOST=127.0.0.1
```

## 文件清单

```
od-toolkit/
├── server.py             # 一体化服务（静态 + 风格数据 API）
├── app/                  # 站点文件（7 页面 + common.css/js）
├── data/                 # 风格数据（运行后自动生成 style_store.json）
├── start.sh / stop.sh    # 一键启停脚本
├── od-toolkit.service    # systemd 单元模板
├── Dockerfile            # Docker 镜像（python:3.12-alpine）
├── docker-compose.yml    # compose 编排
└── nginx.conf            # Nginx 反代参考配置
```
