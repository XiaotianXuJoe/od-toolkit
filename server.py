#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
华为OD题解工作流 —— 一体化服务器（零第三方依赖，Python 3.8+）

功能：
  1. 静态托管 app/ 目录下的全部页面
  2. 风格学习数据的后端保存接口：
       GET  /api/style   读取风格数据（样本库/风格档案/开关/提示词）
       PUT  /api/style   保存风格数据（整体覆盖，原子写入 data/style_store.json）
       GET  /api/memory  读取代码微调记忆（开关/偏好规则）
       PUT  /api/memory  保存代码微调记忆（整体覆盖，原子写入 data/memory_store.json）
       GET  /api/health  健康检查

环境变量：
  HOST                 监听地址，默认 0.0.0.0（前置 nginx 反代时设 127.0.0.1）
  PORT                 监听端口，默认 4000
  SYNC_TOKEN           同步密钥；设置后 /api/proxy 中转请求必须携带 X-Sync-Token 头
  STYLE_AUTH           设为 1 时 /api/style 也要求 SYNC_TOKEN 鉴权（默认免密）
  UPSTREAM_API_KEY     服务器内置 API Key；中转请求没带 Authorization 时自动注入
                       （浏览器端 Key 留空即可用，Key 只存服务器环境变量，不进代码）
  UPSTREAM_BASE        内置 Key 对应的上游地址（如 https://api.example.com/v1）；
                       中转请求没带 X-Upstream-Base 时使用
  PROXY_ALLOWED_HOSTS  中转上游主机白名单（英文逗号分隔，覆盖默认列表）
  PROXY_ALLOW_PRIVATE  设为 1 时允许私网/http 上游并跳过白名单（仅本地测试用）
"""

import ipaddress
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(BASE_DIR, 'app')
DATA_DIR = os.path.join(BASE_DIR, 'data')
STORE_FILE = os.path.join(DATA_DIR, 'style_store.json')
MEMORY_FILE = os.path.join(DATA_DIR, 'memory_store.json')   # 代码微调记忆库存储文件

HOST = os.environ.get('HOST', '0.0.0.0')   # 前置 nginx 时设为 127.0.0.1
PORT = int(os.environ.get('PORT', '4000'))
SYNC_TOKEN = os.environ.get('SYNC_TOKEN', '')
# 风格数据接口默认免密（与主站页面一致开箱即用）；设 STYLE_AUTH=1 恢复 SYNC_TOKEN 鉴权
STYLE_AUTH = os.environ.get('STYLE_AUTH', '') == '1'
MAX_BODY = 96 * 1024 * 1024          # 请求体上限 96MB（样本图片为压缩后的 dataURL）
MAX_SAMPLES = 50                     # 样本数量上限（前端自身限制 20）
MAX_TEXT_FIELD = 2 * 1024 * 1024     # profile/prompt 单字段上限 2MB

# API 中转（解决第三方端点不支持浏览器 CORS 预检的问题）：
# 前端直连失败时改请求同源 /api/proxy/...，由本服务器转发到真实上游
PROXY_TIMEOUT = 150                  # 上游请求超时（秒），需大于前端 120s 单请求超时
PROXY_MAX_BODY = 64 * 1024 * 1024    # 中转请求体上限（风格分析含 base64 图片）
ALLOW_PRIVATE_UPSTREAM = os.environ.get('PROXY_ALLOW_PRIVATE', '') == '1'  # 仅测试用

# 服务器内置上游 Key（完全免密模式）：浏览器端 API Key 留空时，中转请求由服务器注入此 Key。
# 注意：注入仅在请求未自带 Authorization 时发生，访客自带 Key 的请求不受影响（原样透传）。
UPSTREAM_API_KEY = os.environ.get('UPSTREAM_API_KEY', '')
UPSTREAM_BASE = os.environ.get('UPSTREAM_BASE', '').strip().rstrip('/')

# 中转上游白名单：默认只放行常见 OpenAI 兼容端点，防止服务器被当作通用开放代理滥用。
# 环境变量 PROXY_ALLOWED_HOSTS 用英文逗号分隔的主机名可覆盖默认列表；
# 显式设为空字符串表示不限制（不推荐）。PROXY_ALLOW_PRIVATE=1 的测试模式同时跳过白名单。
DEFAULT_ALLOWED_UPSTREAMS = (
    'api.moonshot.cn',
    'api.deepseek.com',
    'api.siliconflow.cn',
    'api.openai.com',
    'open.bigmodel.cn',
    'dashscope.aliyuncs.com',
    'ai.ctaigw.cn',
)
_allowed_env = os.environ.get('PROXY_ALLOWED_HOSTS')
if _allowed_env is None:
    ALLOWED_UPSTREAM_HOSTS = frozenset(DEFAULT_ALLOWED_UPSTREAMS)
else:
    ALLOWED_UPSTREAM_HOSTS = frozenset(
        h.strip().lower() for h in _allowed_env.split(',') if h.strip())

_store_lock = threading.Lock()

EMPTY_STORE = {
    'samples': [],
    'profile': '',
    'enabled': False,
    'prompt': '',
    'updatedAt': 0
}


def read_store():
    with _store_lock:
        try:
            with open(STORE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                merged = dict(EMPTY_STORE)
                merged.update({k: v for k, v in data.items() if k in EMPTY_STORE})
                return merged
        except (OSError, ValueError):
            pass
        return dict(EMPTY_STORE)


def write_store(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    data['updatedAt'] = time.time()
    payload = {k: data[k] for k in EMPTY_STORE}
    tmp = STORE_FILE + '.tmp'
    with _store_lock:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, STORE_FILE)   # 原子替换，避免写一半断电损坏
    return payload


def validate_payload(data):
    """校验 PUT 提交的数据结构，返回错误信息（None 表示通过）"""
    if not isinstance(data, dict):
        return '请求体必须是 JSON 对象'
    samples = data.get('samples')
    if samples is not None:
        if not isinstance(samples, list):
            return 'samples 必须是数组'
        if len(samples) > MAX_SAMPLES:
            return '样本数量超过上限'
        for s in samples:
            if not isinstance(s, dict) or not isinstance(s.get('text', ''), str):
                return '样本格式不正确'
    for key in ('profile', 'prompt'):
        v = data.get(key)
        if v is not None and (not isinstance(v, str) or len(v) > MAX_TEXT_FIELD):
            return key + ' 字段不合法'
    if data.get('enabled') is not None and not isinstance(data.get('enabled'), bool):
        return 'enabled 必须是布尔值'
    return None


# ---------- 代码微调记忆库（/api/memory，结构与风格库一致） ----------

MAX_MEMORY_RULES = 30                  # 记忆规则数量上限
MEMORY_FEATURES = ('solution', 'template', 'convert')  # 合法的规则来源

EMPTY_MEMORY = {
    'enabled': False,
    'rules': [],
    'updatedAt': 0
}


def read_memory():
    with _store_lock:
        try:
            with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                merged = dict(EMPTY_MEMORY)
                merged.update({k: v for k, v in data.items() if k in EMPTY_MEMORY})
                return merged
        except (OSError, ValueError):
            pass
        return dict(EMPTY_MEMORY)


def write_memory(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    data['updatedAt'] = time.time()
    payload = {k: data[k] for k in EMPTY_MEMORY}
    tmp = MEMORY_FILE + '.tmp'
    with _store_lock:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, MEMORY_FILE)   # 原子替换，避免写一半断电损坏
    return payload


def validate_memory(data):
    """校验 PUT /api/memory 提交的数据结构，返回错误信息（None 表示通过）"""
    if not isinstance(data, dict):
        return '请求体必须是 JSON 对象'
    if data.get('enabled') is not None and not isinstance(data.get('enabled'), bool):
        return 'enabled 必须是布尔值'
    rules = data.get('rules')
    if rules is not None:
        if not isinstance(rules, list):
            return 'rules 必须是数组'
        if len(rules) > MAX_MEMORY_RULES:
            return '规则数量超过上限（30 条）'
        for r in rules:
            if not isinstance(r, dict):
                return '规则格式不正确'
            if not isinstance(r.get('id'), str) or len(r['id']) > 64:
                return '规则 id 不合法'
            if r.get('feature') not in MEMORY_FEATURES:
                return '规则 feature 不合法（必须为 solution/template/convert）'
            if not isinstance(r.get('lang'), str) or len(r['lang']) > 20:
                return '规则 lang 不合法'
            if not isinstance(r.get('text'), str) or len(r['text']) > 2000:
                return '规则 text 不合法'
            created = r.get('createdAt')
            if not isinstance(created, (int, float)) or isinstance(created, bool):
                return '规则 createdAt 必须是数字'
    return None


def _is_safe_upstream(base, check_whitelist=True):
    """校验上游地址：仅允许 https 公网地址（防 SSRF），且须命中白名单（防开放代理滥用）。
    check_whitelist=False 时跳过白名单判定，用于错误分支区分 400/403 原因。"""
    try:
        u = urlparse(base)
    except Exception:
        return False
    if u.scheme != 'https' and not (ALLOW_PRIVATE_UPSTREAM and u.scheme == 'http'):
        return False
    host = (u.hostname or '').lower()
    if not host:
        return False
    if not ALLOW_PRIVATE_UPSTREAM:
        if host == 'localhost' or host.endswith(('.local', '.internal', '.lan')):
            return False
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        except ValueError:
            pass  # 域名形式，交给上游 DNS
        # 上游主机白名单（开放代理防护）；测试模式（ALLOW_PRIVATE_UPSTREAM）跳过
        if check_whitelist and ALLOWED_UPSTREAM_HOSTS and host not in ALLOWED_UPSTREAM_HOSTS:
            return False
    return True


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    # ---------- 工具 ----------

    def _send_json(self, code, obj, proxied=False):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if proxied:
            self.send_header('X-Proxied', '1')
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if not SYNC_TOKEN:
            return True
        if self.headers.get('X-Sync-Token', '') == SYNC_TOKEN:
            return True
        self._send_json(401, {'ok': False, 'error': '同步密钥缺失或不正确'})
        return False

    # ---------- API 中转 ----------

    def _handle_proxy(self, method):
        """同源中转：浏览器 -> /api/proxy/chat/completions -> X-Upstream-Base 指定的上游。
        仅转发 Authorization/Content-Type，上游响应（含错误状态）原样回传并带 X-Proxied 头。"""
        if SYNC_TOKEN and self.headers.get('X-Sync-Token', '') != SYNC_TOKEN:
            # 带 X-Proxied 头返回，前端据此识别"中转可用但缺密钥"而非"中转不存在"
            self._send_json(401, {'ok': False, 'error': '同步密钥缺失或不正确'}, proxied=True)
            return
        base = self.headers.get('X-Upstream-Base', '').strip().rstrip('/') or UPSTREAM_BASE
        if not _is_safe_upstream(base):
            # 区分原因：地址本身合法（https 公网）只是不在白名单 → 403 并说明；其余 → 400
            if not ALLOW_PRIVATE_UPSTREAM and _is_safe_upstream(base, check_whitelist=False):
                host = (urlparse(base).hostname or '').lower()
                self._send_json(403, {'ok': False, 'error': '上游主机不在白名单：' + host
                                      + '（管理员可用环境变量 PROXY_ALLOWED_HOSTS 添加）'},
                                proxied=True)
            else:
                self._send_json(400, {'ok': False, 'error': '上游地址不合法（仅允许 https 公网地址）'}, proxied=True)
            return
        sub = self.path.split('?', 1)[0][len('/api/proxy'):]
        if not sub.startswith('/') or '..' in sub:
            self._send_json(404, {'ok': False, 'error': 'not found'}, proxied=True)
            return
        body = None
        if method in ('POST', 'PUT'):
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = 0
            if length > PROXY_MAX_BODY:
                self._send_json(413, {'ok': False, 'error': '请求体过大'}, proxied=True)
                return
            body = self.rfile.read(length) if length > 0 else None
        headers = {}
        for h in ('Authorization', 'Content-Type'):
            v = self.headers.get(h)
            if v:
                headers[h] = v
        # 访客未带 Key（浏览器端留空）时注入服务器内置 Key；自带 Key 的请求原样透传
        if 'Authorization' not in headers and UPSTREAM_API_KEY:
            headers['Authorization'] = 'Bearer ' + UPSTREAM_API_KEY
        req = urllib.request.Request(base + sub, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as resp:
                status, data = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()   # 上游业务错误（400/401/404/429…）原样回传
        except Exception as e:
            self._send_json(502, {'ok': False, 'error': '上游请求失败: ' + str(e)[:120]}, proxied=True)
            return
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Proxied', '1')
        self.end_headers()
        self.wfile.write(data)

    # ---------- 路由 ----------

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/proxy/'):
            self._handle_proxy('GET')
        elif path == '/api/health':
            self._send_json(200, {'ok': True, 'auth': bool(SYNC_TOKEN), 'proxy': True,
                                  'styleAuth': STYLE_AUTH, 'serverKey': bool(UPSTREAM_API_KEY),
                                  'memory': True})
        elif path == '/api/style':
            if not STYLE_AUTH or self._authed():
                self._send_json(200, read_store())
        elif path == '/api/memory':
            # 记忆库与风格库一致默认免密，不设鉴权分支
            self._send_json(200, read_memory())
        else:
            super().do_GET()

    def do_PUT(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/memory':
            self._handle_memory_put()
            return
        if path != '/api/style':
            self._send_json(404, {'ok': False, 'error': 'not found'})
            return
        if STYLE_AUTH and not self._authed():
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {'ok': False, 'error': '空请求体'})
            return
        if length > MAX_BODY:
            self._send_json(413, {'ok': False, 'error': '请求体过大（上限 96MB）'})
            return
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {'ok': False, 'error': 'JSON 解析失败'})
            return
        err = validate_payload(data)
        if err:
            self._send_json(400, {'ok': False, 'error': err})
            return
        # 整体覆盖：缺省字段回退为空值，保证服务器与浏览器状态一致（含清空操作）
        merged = dict(EMPTY_STORE)
        for k in ('samples', 'profile', 'enabled', 'prompt'):
            if data.get(k) is not None:
                merged[k] = data[k]
        saved = write_store(merged)
        self._send_json(200, {'ok': True, 'updatedAt': saved['updatedAt']})

    def _handle_memory_put(self):
        """PUT /api/memory：整体覆盖记忆库（免密，与 GET 一致）"""
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {'ok': False, 'error': '空请求体'})
            return
        if length > MAX_BODY:
            self._send_json(413, {'ok': False, 'error': '请求体过大（上限 96MB）'})
            return
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {'ok': False, 'error': 'JSON 解析失败'})
            return
        err = validate_memory(data)
        if err:
            self._send_json(400, {'ok': False, 'error': err})
            return
        # 整体覆盖：缺省字段回退为空值，服务器覆写 updatedAt 后原子写入
        merged = dict(EMPTY_MEMORY)
        for k in ('enabled', 'rules'):
            if data.get(k) is not None:
                merged[k] = data[k]
        saved = write_memory(merged)
        self._send_json(200, {'ok': True, 'updatedAt': saved['updatedAt']})

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/proxy/'):
            self._handle_proxy('POST')
        else:
            self._send_json(405, {'ok': False, 'error': 'method not allowed'})

    def do_DELETE(self):
        self._send_json(405, {'ok': False, 'error': 'method not allowed'})

    def log_message(self, fmt, *args):
        # 静态资源访问不记日志，API 与错误照常记录
        line = fmt % args
        if '/api/' in self.path or '" 4' in line or '" 5' in line:
            super().log_message(fmt, *args)


if __name__ == '__main__':
    if not os.path.isdir(APP_DIR):
        raise SystemExit('找不到 app 目录：' + APP_DIR)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('华为OD题解工作流已启动: http://%s:%d' % (HOST, PORT))
    print('风格数据存储: %s' % STORE_FILE)
    print('同步密钥: %s' % ('已启用（仅 /api/proxy 中转需要）' if SYNC_TOKEN else '未设置（/api/proxy 公开可访问，建议设置）'))
    print('风格接口: %s' % ('需要 SYNC_TOKEN（STYLE_AUTH=1）' if STYLE_AUTH else '免密（默认；设 STYLE_AUTH=1 开启鉴权）'))
    print('中转白名单: %s' % (', '.join(sorted(ALLOWED_UPSTREAM_HOSTS)) if ALLOWED_UPSTREAM_HOSTS
                              else '未限制（不推荐，请设置 PROXY_ALLOWED_HOSTS）'))
    print('内置 Key: %s' % ('已配置（%s...%s，上游 %s）' % (UPSTREAM_API_KEY[:4], UPSTREAM_API_KEY[-4:],
                              UPSTREAM_BASE or '由请求头指定') if UPSTREAM_API_KEY else '未配置（访客需自带 API Key）'))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
