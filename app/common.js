/* ============================================================
 * common.js —— 七个页面共享的公共逻辑
 * 涵盖：常量配置 / API 设置 / 提示 Toast / 代码高亮 / Markdown 渲染
 *       飞书富文本复制 / 标题层级筛选 / 个人风格注入 / 提示词持久化
 * ============================================================ */


/* ---------- 语言与高亮常量 ---------- */

const LANG_CONFIG = {
  python:     { ext: 'py',   name: 'Python' },
  java:       { ext: 'java', name: 'Java' },
  cpp:        { ext: 'cpp',  name: 'C++' },
  c:          { ext: 'c',    name: 'C' },
  javascript: { ext: 'js',   name: 'JavaScript' },
  go:         { ext: 'go',   name: 'Go' }
};

const KEYWORDS = {
  python: 'def class return if elif else for while import from as None True False self pass in not and or with lambda try except finally raise global nonlocal yield is async await del assert print int str list dict bool float len range',
  c: 'int char float double void return if else for while do switch case default break continue struct typedef const static unsigned signed long short sizeof enum union extern register volatile inline restrict NULL',
  cpp: 'int char float double void return if else for while do switch case default break continue struct typedef const static unsigned signed long short sizeof enum union class public private protected namespace using template typename new delete this virtual override auto bool true false nullptr constexpr const auto friend operator explicit mutable noexcept throw try catch',
  java: 'public private protected class void int long double float boolean char byte short return if else for while do switch case default break continue static final new this super null true false import package extends implements interface abstract synchronized instanceof throw throws try catch finally',
  javascript: 'function const let var return if else for while do switch case default break continue class new this super null undefined true false import export from default async await typeof instanceof of in try catch finally throw extends static get set',
  go: 'func package import return if else for range var const type struct interface map chan go defer select switch case default break continue fallthrough nil true false make new append len cap copy delete panic recover'
};

const TYPES_EXTRA = 'Solution List Dict Tuple Set Optional Node TreeNode ListNode Main Scanner System Math String Integer Arrays Collections vector string map pair stack queue set unordered_map StringBuilder';


/* ---------- 基础工具 ---------- */

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let toastTimer;
function showToast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

function toggleCollapse(header, id) {
  const el = $(id);
  header.classList.toggle('collapsed');
  el.classList.toggle('collapsed');
}


/* ---------- API 设置（localStorage: tc_config） ---------- */

function getApiConfig() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('tc_config') || '{}'); } catch (e) {}
  return {
    apiKey: cfg.apiKey || '',
    baseUrl: (cfg.baseUrl || 'https://api.moonshot.cn/v1').replace(/\/+$/, ''),
    model: cfg.model || 'kimi-k2.6',
    temperature: (cfg.temperature !== undefined && cfg.temperature !== '') ? parseFloat(cfg.temperature) : 0.6, // kimi-k2.6 非思考模式要求 0.6
    // 默认关闭思考：思考型模型推理耗时极长且可能耗尽输出预算导致空返回
    disableThinking: cfg.disableThinking !== false,
    // 风格数据服务器同步密钥（服务器设置了 SYNC_TOKEN 时需要）
    syncToken: cfg.syncToken || ''
  };
}

function openSettings() {
  const cfg = getApiConfig();
  $('cfgApiKey').value = cfg.apiKey;
  $('cfgBaseUrl').value = cfg.baseUrl;
  $('cfgModel').value = cfg.model;
  $('cfgTemperature').value = cfg.temperature;
  if ($('cfgDisableThinking')) $('cfgDisableThinking').checked = cfg.disableThinking;
  if ($('cfgSyncToken')) $('cfgSyncToken').value = cfg.syncToken;
  $('settingsOverlay').classList.remove('hidden');
}

function closeSettings() { $('settingsOverlay').classList.add('hidden'); }

function saveSettings() {
  const cfg = {
    apiKey: $('cfgApiKey').value.trim(),
    baseUrl: $('cfgBaseUrl').value.trim() || 'https://api.moonshot.cn/v1',
    model: $('cfgModel').value.trim() || 'kimi-k2.6',
    temperature: $('cfgTemperature').value !== '' ? $('cfgTemperature').value : '0.6',
    disableThinking: $('cfgDisableThinking') ? $('cfgDisableThinking').checked : true,
    syncToken: $('cfgSyncToken') ? $('cfgSyncToken').value.trim() : (getApiConfig().syncToken || '')
  };
  localStorage.setItem('tc_config', JSON.stringify(cfg));
  closeSettings();
  showToast('API 设置已保存');
  // 密钥可能刚填写，立即尝试从服务器拉取风格数据
  styleSyncPull(true);
}

function loadSettings() {
  openSettings();
  showToast('已恢复保存的设置');
}

// 测试连接：轻量请求 GET {baseUrl}/models，按响应给出精确诊断
async function testConnection() {
  const baseUrl = ($('cfgBaseUrl').value.trim() || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
  const apiKey = $('cfgApiKey').value.trim();
  showToast('正在测试连接 ' + baseUrl + ' ...');
  try {
    const resp = await fetchApi({ baseUrl: baseUrl, apiKey: apiKey, syncToken: getApiConfig().syncToken }, '/models', {
      method: 'GET',
      headers: apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}
    });
    if (resp.ok) {
      let n = '';
      try { n = '，端点返回 ' + ((await resp.json()).data || []).length + ' 个可用模型'; } catch (e) {}
      showToast('连接成功：' + (apiKey ? 'API Key 有效' : '服务器内置 Key 有效') + n + (resp.headers.get('X-Proxied') ? '（经服务器中转）' : ''));
    } else if (resp.status === 401) {
      const t = await resp.text();
      if (t.indexOf('同步密钥') !== -1) showToast('端点不支持浏览器直连，需在下方填写「同步密钥」后才能使用服务器中转', true);
      else if (!apiKey) showToast('服务器内置 Key 未配置或已失效（401），请联系管理员，或自行填写 API Key', true);
      else showToast('网络与端点正常，但 API Key 无效（401），请检查 Key 是否复制完整、与该平台匹配', true);
    } else if (resp.status === 404) {
      showToast('Base URL 路径不正确（404），正确格式如 https://api.moonshot.cn/v1', true);
    } else {
      const t = await resp.text();
      showToast('端点连通但返回 ' + resp.status + '：' + t.slice(0, 100), true);
    }
  } catch (e) {
    showToast('无法连接到 ' + baseUrl + '（网络层失败）。请依次排查：本机网络、代理/VPN、广告拦截插件、Base URL 是否填错', true);
  }
}


/* ---------- 代码处理（高亮 / 围栏剥离 / API 响应提取） ---------- */

function highlightCode(code, lang) {
  const kw = new Set((KEYWORDS[lang] || '').split(' ').filter(Boolean));
  const typ = new Set(TYPES_EXTRA.split(' '));
  const isC = lang !== 'python';
  const re = isC
    ? /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*")|('(?:[^'\\\n]|\\.)*')|(`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?[fFlLuU]*\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g
    : /(#[^\n]*)|("""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\')|("(?:[^"\\\n]|\\.)*")|('(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

  const idx = isC
    ? { com: [1, 2], str: [3, 4, 5], num: 6, word: 7 }
    : { com: [1], str: [2, 3, 4], num: 5, word: 6 };

  let html = '', last = 0, m;
  while ((m = re.exec(code)) !== null) {
    html += escapeHtml(code.slice(last, m.index));
    const tok = m[0];
    if (idx.com.some(g => m[g])) html += '<span class="tok-com">' + escapeHtml(tok) + '</span>';
    else if (idx.str.some(g => m[g])) html += '<span class="tok-str">' + escapeHtml(tok) + '</span>';
    else if (m[idx.num]) html += '<span class="tok-num">' + escapeHtml(tok) + '</span>';
    else if (kw.has(tok)) html += '<span class="tok-kw">' + escapeHtml(tok) + '</span>';
    else if (typ.has(tok) || /^[A-Z][A-Za-z0-9_]*$/.test(tok)) html += '<span class="tok-typ">' + escapeHtml(tok) + '</span>';
    else html += escapeHtml(tok);
    last = m.index + tok.length;
  }
  html += escapeHtml(code.slice(last));
  return html;
}

function stripCodeFences(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*```[a-zA-Z0-9#+]*[ \t]*$/gm, '')
    .replace(/```/g, '')
    .trim();
}

function extractCode(data) {
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message || typeof choice.message.content !== 'string') {
    throw new Error('模型未返回有效内容，请重试');
  }
  const code = stripCodeFences(choice.message.content);
  if (!code) throw new Error('模型返回了空内容，请重试');
  if (choice.finish_reason === 'length') {
    // 延迟到调用方的成功提示之后显示，确保截断警告不被覆盖
    setTimeout(() => showToast('代码已生成，但输出达到长度上限，内容可能不完整——可用 AI 微调要求续写补全', true), 60);
  }
  return code;
}


/* ---------- 通用文本复制（HTTP 环境自动降级） ---------- */
// navigator.clipboard 仅在 HTTPS 或 localhost 下可用；HTTP 部署（如 http://IP:4000）
// 直接调用会抛 TypeError 导致按钮"没反应"。此处统一封装：clipboard 不可用时
// 降级为隐藏 textarea + execCommand('copy')，并始终给出成功/失败提示。
async function copyText(text, successMsg, onDone) {
  successMsg = successMsg || '已复制到剪贴板';
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) { ok = false; }
  }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
  }
  if (ok) {
    showToast(successMsg);
    if (onDone) onDone();
  } else {
    showToast('复制失败，请长按/框选文本手动复制', true);
  }
}


/* ---------- 输入框工具：手动导入上游产物 / 删除单个输入框内容 ---------- */

// 写入输入框并触发 input 事件（走各页面既有的持久化与字数统计监听）
function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// 删除单个输入框内容（不影响其他输入框与缓存结果）
function clearInputValue(id, label) {
  setInputValue(id, '');
  showToast((label || '输入内容') + '已删除');
}

// 导入「文本乱码清理」页已清理的文本（tc_result）
function importCleanedText(id) {
  const t = localStorage.getItem('tc_result') || '';
  if (!t.trim()) { showToast('「文本乱码清理」页暂无已清理的文本，请先到该页清理', true); return; }
  setInputValue(id, t);
  showToast('已导入清理文本（' + t.length + ' 字符）');
}

// 导入已生成代码：sources 为 [{ label, codes, langs }]，按顺序取第一个非空
// 例：importGeneratedCode('sourceCode', [{ label: '题解代码生成', key: 'sol_codes', langs: [sourceLang] }])
function importGeneratedCode(id, sources) {
  for (const s of sources) {
    let codes = {};
    try { codes = JSON.parse(localStorage.getItem(s.key) || '{}'); } catch (e) {}
    for (const lang of s.langs) {
      if (codes[lang] && codes[lang].trim()) {
        setInputValue(id, codes[lang]);
        showToast('已导入「' + s.label + '」的 ' + LANG_CONFIG[lang].name + ' 代码（' + codes[lang].length + ' 字符）');
        return;
      }
    }
  }
  showToast('暂无可导入的已生成代码，请先在对应页面生成', true);
}

// 导入「题解说明生成」页已生成的题解说明（ex_texts，任意已生成语言）
function importExplanationText(id) {
  let texts = {};
  try { texts = JSON.parse(localStorage.getItem('ex_texts') || '{}'); } catch (e) {}
  const lang = Object.keys(LANG_CONFIG).find(l => texts[l] && texts[l].trim());
  if (!lang) { showToast('「题解说明生成」页暂无已生成的题解说明', true); return; }
  setInputValue(id, texts[lang]);
  showToast('已导入题解说明（' + texts[lang].length + ' 字符）');
}

/* ---------- API 请求通道：直连失败自动切换服务器中转 ----------
 * 第三方中转端点（如 ai.ctaigw.cn）不支持浏览器 CORS 预检时，直连 fetch 会抛
 * TypeError（Failed to fetch）。此时自动改走同源 /api/proxy（无跨域），由服务器
 * 转发到真实上游。会话内用 apiProxyMode 记忆，后续请求直接走中转。 */
let apiProxyMode = false;

async function fetchApi(apiCfg, path, init) {
  // 未填 API Key = 使用服务器内置 Key 模式：直接走同源中转，不带 Authorization 与
  // X-Upstream-Base，由服务器注入环境变量 UPSTREAM_API_KEY / UPSTREAM_BASE。
  // 填了 Key 则保持原逻辑：直连优先，失败自动切中转（BYO Key 原样透传）。
  const useServerKey = !apiCfg.apiKey;
  const proxyFetch = () => {
    const headers = Object.assign({}, init.headers, {
      'X-Sync-Token': apiCfg.syncToken || ''
    });
    if (useServerKey) {
      delete headers['Authorization'];
    } else {
      headers['X-Upstream-Base'] = apiCfg.baseUrl;
    }
    return fetch('/api/proxy' + path, {
      method: init.method,
      headers: headers,
      body: init.body,
      signal: init.signal
    });
  };
  if (apiProxyMode || useServerKey) return proxyFetch();
  try {
    return await fetch(apiCfg.baseUrl + path, init);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;   // AbortError 等原样上抛
    // 直连网络层失败（CORS 预检被拒/DNS/连接重置）：尝试服务器中转
    try {
      const resp = await proxyFetch();
      if (resp.headers.get('X-Proxied')) {
        apiProxyMode = true;
        showToast('当前端点不支持浏览器直连，已自动切换为服务器中转模式');
        return resp;
      }
    } catch (e2) { /* 无后端或中转也不可达，按原错误处理 */ }
    throw e;
  }
}


/* ---------- 带自动重试的底层请求 ---------- */

// fetch 本身抛出 TypeError（"Failed to fetch"）说明网络层失败：连接中断、
// 长连接被网关/代理重置（思考型模型长时间不返回字节时常见）、CORS 瞬时拦截等。
// 这类瞬时错误自动重试（最多 3 次，1.5s/3s 递增）；429/5xx 同样按瞬时错误重试。
async function postChatCompletion(apiCfg, messages, opts) {
  const maxTokens = (opts && opts.maxTokens) || 8192;
  const timeoutMs = (opts && opts.timeoutMs) || 120000; // 单请求超时：挂起快速失败进入重试
  const MAX_RETRY = 3;
  let lastErr = null;
  // 关闭思考：kimi 等思考型模型加 thinking:{type:'disabled'}；端点不支持（400）时自动回退不带该参数
  let thinkingOff = apiCfg.disableThinking !== false;
  let thinkingFallback = false;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const payload = {
        model: apiCfg.model,
        messages: messages,
        temperature: apiCfg.temperature,
        max_tokens: maxTokens
      };
      if (thinkingOff && !thinkingFallback) payload.thinking = { type: 'disabled' };
      const response = await fetchApi(apiCfg, '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiCfg.apiKey
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      if (!response.ok) {
        const err = await response.text();
        // 端点不认识 thinking 参数：去掉后立刻重发，不消耗重试次数
        if (response.status === 400 && !thinkingFallback && payload.thinking && /thinking|unknown|unrecognized|invalid/i.test(err)) {
          thinkingFallback = true;
          attempt--;
          continue;
        }
        lastErr = new Error('API 错误 (' + response.status + '): ' + err);
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRY - 1) {
          showToast('服务暂时不可用（' + response.status + '），正在自动重试...');
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
      return await response.json();
    } catch (e) {
      // TypeError（Failed to fetch）与 AbortError（超时）均为网络层错误，可重试
      if (e instanceof TypeError || e.name === 'AbortError') {
        lastErr = new Error(e.name === 'AbortError'
          ? '请求超过 ' + Math.round(timeoutMs / 1000) + ' 秒无响应，已自动重试仍超时。请检查网络，或在设置中更换响应更快的模型/端点'
          : '网络请求失败（' + e.message + '）。可能是连接中断、请求被重置或跨域限制，已自动重试仍失败时请检查网络或更换 API 端点');
        if (attempt < MAX_RETRY - 1) {
          showToast((e.name === 'AbortError' ? '请求超时' : '网络连接中断')
            + '，正在自动重试（' + (attempt + 1) + '/2）...');
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
      }
      throw lastErr || e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* ---------- 带自动续写的通用请求（推荐替代手写 fetch + extractCode） ---------- */

// finish_reason='length' 时自动把已生成部分作为 assistant 上下文请求续写并无缝拼接，
// 直到输出完整（默认首次 + 最多 3 次续写）。空内容（如思考型模型把长度预算
// 全部消耗在推理过程）会抛出明确的错误提示，而不是让调用方静默渲染空白。
async function fetchWithContinuation(apiCfg, messages, opts) {
  const MAX_ROUNDS = (opts && opts.maxRounds) || 4;
  const maxTokens = (opts && opts.maxTokens) || 8192;
  const msgs = messages.slice();
  let text = '', continued = false, emptyRetry = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await postChatCompletion(apiCfg, msgs, { maxTokens: maxTokens });
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      console.error('异常 API 响应:', data);
      throw new Error('模型未返回有效内容，请检查模型配置后重试');
    }
    const part = choice.message.content;
    if (!part.trim() && !text) {
      // 思考型模型把长度预算全部用于推理时返回空内容：自动换一轮重试（最多 2 次）
      if (choice.finish_reason === 'length' && emptyRetry < 2) {
        emptyRetry++;
        showToast('模型思考占满了输出预算，正在自动重试（' + emptyRetry + '/2）...');
        continue;
      }
      if (choice.finish_reason === 'length') {
        throw new Error('模型多次返回了空内容：输出长度预算被思考过程占满，请在设置中更换为非思考型模型后重试');
      }
      console.error('空响应:', data);
      throw new Error('模型返回了空内容，请重试或检查模型配置');
    }
    if (choice.finish_reason === 'length' && round < MAX_ROUNDS - 1) {
      // 被截断：记录已生成部分，请求从中断处续写（拼接处不加换行，截断可能在任意位置）
      text += part;
      continued = true;
      msgs.push({ role: 'assistant', content: part });
      msgs.push({ role: 'user', content: '输出因长度限制被截断。请从上一次输出的中断位置继续输出剩余内容，仅输出续写部分：不要重复已输出的任何内容，不要输出解释，不要使用 markdown 代码块标记。' });
      continue;
    }
    text += part;
    if (choice.finish_reason === 'length') {
      setTimeout(() => showToast('已自动续写 ' + (MAX_ROUNDS - 1) + ' 次仍达到长度上限，内容可能不完整', true), 60);
    } else if (continued) {
      setTimeout(() => showToast('内容较长，已自动续写补全'), 60);
    }
    break;
  }
  if (!text.trim()) throw new Error('模型返回了空内容，请重试或检查模型配置');
  return text;
}

// 去除模型输出整体外层的 markdown 围栏（仅当全文被单个围栏完整包裹时）
function stripWrappingFence(text) {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z0-9]*[ \t]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : t;
}


/* ---------- Markdown 渲染（全功能版）与飞书富文本复制 ---------- */

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0;
  const listStack = []; // {type, indent}

  function closeLists(toIndent) {
    while (listStack.length && listStack[listStack.length - 1].indent >= toIndent) {
      html += '</' + listStack.pop().type + '>';
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块（容忍前导空格与任意语言标识；模型/飞书输出的围栏常带缩进，
    // 若不识别，代码里的 # 注释会被当成标题渲染）
    const fence = line.match(/^\s*```+\s*([A-Za-z0-9#+._-]*)\s*$/);
    if (fence) {
      closeLists(-1);
      let buf = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html += '<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>';
      continue;
    }

    // 表格（表头 + 分隔行）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeLists(-1);
      const parseRow = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const headers = parseRow(line);
      i += 2;
      let rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      html += '<table><thead><tr>' + headers.map(h => '<th>' + renderInline(h) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + renderInline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists(-1);
      const level = Math.min(h[1].length, 3);
      html += '<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>';
      i++; continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeLists(-1);
      html += '<hr>'; i++; continue;
    }

    // 引用块
    if (/^\s*&gt;|^\s*>/.test(line)) {
      closeLists(-1);
      let buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += '<blockquote>' + buf.map(renderInline).join('<br>') + '</blockquote>';
      continue;
    }

    // 列表项（支持缩进嵌套）
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = li[1].length;
      const type = /^\d/.test(li[2]) ? 'ol' : 'ul';
      if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
        listStack.push({ type, indent });
        html += '<' + type + '>';
      } else if (listStack[listStack.length - 1].indent === indent && listStack[listStack.length - 1].type !== type) {
        html += '</' + listStack.pop().type + '>';
        listStack.push({ type, indent });
        html += '<' + type + '>';
      } else {
        closeLists(indent + 1);
        if (!listStack.length) { listStack.push({ type, indent }); html += '<' + type + '>'; }
      }
      html += '<li>' + renderInline(li[3]) + '</li>';
      i++; continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { closeLists(-1); i++; continue; }

    // 普通段落：合并连续行
    closeLists(-1);
    let para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !/^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+\.\s|\s*>|\s*\|)/.test(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    html += '<p>' + para.map(renderInline).join('<br>') + '</p>';
  }
  closeLists(-1);
  return html;
}

function buildRichHtml(md) {
  const wrap = document.createElement('div');
  wrap.innerHTML = renderMarkdown(md);

  // 行内代码：无色（继承正文颜色），保留浅灰底与等宽字体
  wrap.querySelectorAll('code').forEach(code => {
    if (code.closest('pre')) return;
    const span = document.createElement('span');
    span.textContent = code.textContent;
    span.style.cssText = 'font-family:Menlo,Consolas,monospace;font-size:0.9em;'
      + 'background:#f5f5f7;border-radius:4px;padding:1px 5px;color:inherit;';
    code.replaceWith(span);
  });

  // 代码块：深底 + 绿色文字
  wrap.querySelectorAll('pre').forEach(pre => {
    pre.style.cssText = 'background:#161616;color:#22c55e;padding:14px 16px;'
      + 'border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:13px;'
      + 'line-height:1.7;white-space:pre-wrap;word-break:break-all;margin:10px 0;';
    const code = pre.querySelector('code');
    if (code) pre.innerHTML = escapeHtml(code.textContent).replace(/\n/g, '<br>');
  });

  // 标题与正文的内联样式，保证粘贴后层级清晰
  wrap.querySelectorAll('h1').forEach(el => el.style.cssText = 'font-size:19px;font-weight:600;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid #e5e5ea;');
  wrap.querySelectorAll('h2').forEach(el => el.style.cssText = 'font-size:16px;font-weight:600;margin:16px 0 8px;');
  wrap.querySelectorAll('h3').forEach(el => el.style.cssText = 'font-size:15px;font-weight:600;margin:14px 0 6px;');
  wrap.querySelectorAll('p').forEach(el => el.style.cssText = 'margin:8px 0;line-height:1.8;');
  wrap.querySelectorAll('blockquote').forEach(el => el.style.cssText = 'border-left:3px solid #d2d2d7;padding-left:12px;margin:10px 0;color:#6e6e73;');
  wrap.querySelectorAll('ul,ol').forEach(el => el.style.cssText = 'margin:8px 0;padding-left:24px;');
  wrap.querySelectorAll('th').forEach(el => el.style.cssText = 'border:1px solid #e5e5ea;padding:6px 12px;background:#fafafa;font-weight:600;');
  wrap.querySelectorAll('td').forEach(el => el.style.cssText = 'border:1px solid #e5e5ea;padding:6px 12px;');

  const container = document.createElement('div');
  container.style.cssText = 'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
    + 'font-size:14px;line-height:1.8;color:#1d1d1f;';
  container.appendChild(wrap);
  return container;
}

async function copyRendered() {
  const md = $('sourceOutput').value;
  if (!md) { showToast('没有内容可复制'); return; }
  const container = buildRichHtml(md);
  const html = container.innerHTML;
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([md], { type: 'text/plain' })
    });
    await navigator.clipboard.write([item]);
    showToast('已复制渲染结果，可直接粘贴到飞书');
  } catch (e) {
    // 回退：选中临时节点后 execCommand 复制
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    document.body.appendChild(container);
    const range = document.createRange();
    range.selectNodeContents(container);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      document.execCommand('copy');
      showToast('已复制渲染结果，可直接粘贴到富文本编辑器');
    } catch (e2) {
      showToast('复制失败，请尝试「复制 Markdown」', true);
    }
    sel.removeAllRanges();
    document.body.removeChild(container);
  }
}


/* ---------- 标题层级筛选（index / explanation） ---------- */

function tagHeadingLevels() {
  const container = $('renderedOutput');
  let current = 1;
  Array.from(container.children).forEach(el => {
    const m = el.tagName && el.tagName.match(/^H([1-6])$/);
    if (m) current = parseInt(m[1], 10);
    el.dataset.lv = current;
  });
}

function setLevelFilter(level, btn) {
  document.querySelectorAll('.lf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const container = $('renderedOutput');
  Array.from(container.children).forEach(el => {
    if (el.classList.contains('empty-state')) { el.style.display = ''; return; }
    if (level === 0) { el.style.display = ''; return; }
    const m = el.tagName && el.tagName.match(/^H([1-6])$/);
    const ownLevel = m ? parseInt(m[1], 10) : null;
    const lv = parseInt(el.dataset.lv || '1', 10);
    // 标题：自身层级不超过筛选级别才显示；内容：所属章节层级不超过筛选级别才显示
    const visible = ownLevel !== null ? ownLevel <= level : lv <= level;
    el.style.display = visible ? '' : 'none';
  });
}

function afterRender() {
  tagHeadingLevels();
  $('levelFilter').classList.remove('hidden');
}


/* ---------- 语言选择按钮 ---------- */

function syncLangButtons() {
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
}

/* ---------- 风格数据服务器同步（后端保存，localStorage 兜底） ----------
 * 服务器为权威数据源：页面加载时从 GET /api/style 拉取并覆盖本地缓存；
 * 每次修改通过 styleSyncPush()（防抖）PUT 回服务器。
 * 服务器不可达（如离线/纯静态预览环境）时静默退回 localStorage，功能不受影响。
 * 同步密钥在设置面板填写（tc_config.syncToken），随 X-Sync-Token 头发送。 */

const STYLE_SYNC_KEYS = ['style_samples', 'style_profile', 'style_enabled', 'style_prompt'];
let styleSyncWarned = false;   // 401/失败提示每次会话只弹一次，避免刷屏

function styleSyncHeaders() {
  const t = getApiConfig().syncToken;
  return t ? { 'X-Sync-Token': t } : {};
}

// 收集当前本地风格数据（模板类约定：值等于默认时键不存在，统一转成空值上送）
function collectStyleData() {
  let samples = [];
  try { samples = JSON.parse(localStorage.getItem('style_samples') || '[]'); } catch (e) {}
  return {
    samples: Array.isArray(samples) ? samples : [],
    profile: localStorage.getItem('style_profile') || '',
    enabled: localStorage.getItem('style_enabled') === '1',
    prompt: localStorage.getItem('style_prompt') || ''
  };
}

// 把服务器数据写入本地缓存；prompt 为空时删除键以保留"默认值升级"约定
function applyStyleData(d) {
  if (Array.isArray(d.samples)) localStorage.setItem('style_samples', JSON.stringify(d.samples));
  if (typeof d.profile === 'string') {
    if (d.profile) localStorage.setItem('style_profile', d.profile);
    else localStorage.removeItem('style_profile');
  }
  localStorage.setItem('style_enabled', d.enabled ? '1' : '0');
  if (typeof d.prompt === 'string') {
    if (d.prompt) localStorage.setItem('style_prompt', d.prompt);
    else localStorage.removeItem('style_prompt');
  }
}

// 拉取：成功返回 true 并派发 style-synced 事件（style 页据此刷新界面）
async function styleSyncPull(verbose) {
  if (!/^https?:$/.test(location.protocol)) return false;
  try {
    const resp = await fetch('/api/style', { headers: styleSyncHeaders(), cache: 'no-store' });
    if (resp.status === 401) {
      if (!styleSyncWarned) {
        styleSyncWarned = true;
        showToast('风格数据同步需要密钥：请在右上角设置中填写「同步密钥」', true);
      }
      return false;
    }
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data || typeof data !== 'object') return false;
    // 免密同步下所有访客都会触发拉取：服务器从未写入过（updatedAt=0 的初始空库）
    // 而本地已有数据时，视为首次同步——上传本地数据，而不是用空库覆盖本地。
    // （服务器只要写过一次，updatedAt>0，即使是清空操作也按"服务器为准"正常覆盖本地）
    if (!data.updatedAt) {
      const local = collectStyleData();
      const hasLocal = (local.samples && local.samples.length) || local.profile || local.prompt || local.enabled;
      if (hasLocal) { styleSyncPush(); return true; }
    }
    applyStyleData(data);
    if (typeof refreshStyleRow === 'function' && $('styleToggle')) refreshStyleRow();
    window.dispatchEvent(new Event('style-synced'));
    return true;
  } catch (e) {
    if (verbose && !styleSyncWarned) {
      styleSyncWarned = true;
      showToast('无法连接同步服务器，风格数据仅保存在本浏览器', true);
    }
    return false;
  }
}

// 推送：防抖 600ms 合并连续修改；失败不影响本地已保存的数据
let styleSyncTimer = null;
function styleSyncPush() {
  if (!/^https?:$/.test(location.protocol)) return;
  clearTimeout(styleSyncTimer);
  styleSyncTimer = setTimeout(async () => {
    try {
      const resp = await fetch('/api/style', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, styleSyncHeaders()),
        body: JSON.stringify(collectStyleData())
      });
      if (resp.status === 401 && !styleSyncWarned) {
        styleSyncWarned = true;
        showToast('风格数据同步密钥不正确，本次仅保存在本浏览器', true);
      } else if (!resp.ok && resp.status !== 401 && !styleSyncWarned) {
        styleSyncWarned = true;
        showToast('风格数据同步失败（服务器错误），本次仅保存在本浏览器', true);
      }
    } catch (e) {
      if (!styleSyncWarned) {
        styleSyncWarned = true;
        showToast('无法连接同步服务器，风格数据仅保存在本浏览器', true);
      }
    }
  }, 600);
}

// 所有页面加载后自动从服务器拉取风格数据（异步，不阻塞页面渲染）
document.addEventListener('DOMContentLoaded', () => { styleSyncPull(false); });


/* ---------- 个人风格注入（solution 用 kind='code'，explanation 用 kind='text'） ---------- */

function getStyleInject(kind) {
  try {
    if (localStorage.getItem('style_enabled') !== '1') return '';
    const profile = (localStorage.getItem('style_profile') || '').trim();
    if (!profile) return '';
    const lead = kind === 'code'
      ? '你生成的代码必须在命名习惯、注释写法、代码结构等代码风格上严格模仿该档案；代码中的中文注释也要符合作者的文字风格：'
      : '你生成的题解说明必须在文字风格、讲解结构和标志性表达上严格模仿该档案，读起来要像作者本人写的：';
    return '\n\n## 作者个人风格（必须模仿）\n以下是作者过往题解文章提炼出的风格档案。' + lead + '\n' + profile;
  } catch (e) { return ''; }
}

let styleRowTexts = null;  // 页面可通过赋值 styleRowTexts = {on, none} 覆盖文案
function refreshStyleRow(onText, noneText) {
  const toggle = $('styleToggle');
  const status = $('styleStatus');
  if (!toggle) return;
  onText = onText || (styleRowTexts && styleRowTexts.on) || '已启用 · 将注入你的风格档案';
  noneText = noneText || (styleRowTexts && styleRowTexts.none) || '尚无风格档案，请先到「风格学习」页生成';
  const profile = (localStorage.getItem('style_profile') || '').trim();
  if (!profile) {
    toggle.checked = false;
    toggle.disabled = true;
    status.className = 'style-status';
    status.textContent = noneText;
    return;
  }
  toggle.disabled = false;
  const on = localStorage.getItem('style_enabled') === '1';
  toggle.checked = on;
  status.className = 'style-status' + (on ? ' on' : '');
  status.textContent = on ? onText : '未启用';
}

function toggleStyle(on) {
  localStorage.setItem('style_enabled', on ? '1' : '0');
  refreshStyleRow();
  styleSyncPush();
  showToast(on ? '已启用风格模仿' : '已停用风格模仿');
}


/* ---------- 系统提示词：编辑即持久化 + 恢复默认 ---------- */

function persistPromptOnInput(promptKey) {
  const el = $('systemPrompt');
  if (!el) return;
  el.addEventListener('input', () => {
    const v = el.value;
    if (v === DEFAULT_PROMPT) localStorage.removeItem(promptKey);
    else localStorage.setItem(promptKey, v);
    if (promptKey === 'style_prompt') styleSyncPush();
  });
}

function resetPrompt(promptKey) {
  $('systemPrompt').value = DEFAULT_PROMPT;
  if (promptKey) localStorage.removeItem(promptKey);
  if (promptKey === 'style_prompt') styleSyncPush();
  showToast('已恢复默认提示词');
}


/* ---------- 代码微调记忆（localStorage: memory_data + 服务器 /api/memory 同步） ----------
 * 用户在代码页面确认微调/转换结果后，调用 LLM 对比 AI 原版与确认版提炼偏好规则；
 * 后续生成的提示词通过 getMemoryInject(feature) 自动注入同 feature 的历史规则。
 * 同步模式完全仿照上方的风格数据同步：服务器为权威数据源，localStorage 兜底。 */

// 提炼偏好规则的提示词（占位符 {before} {after} 分别替换为 AI 原版与用户确认版）
const MEMORY_DISTILL_PROMPT = `对比以下两份代码：第一份是 AI 生成的原始版本，第二份是用户修改后确认的最终版本。请分析用户的修改，提炼出 1~3 条可复用的通用偏好规则（每条一句话，不超过 50 字，聚焦代码风格/结构/注释习惯等可迁移偏好），用于指导后续代码生成。仅逐行输出规则本身，不要编号、不要解释、不要输出其他内容。如果修改纯属题目业务逻辑变化、不具可复用性，只输出一个字：无

【AI 原始版本】
{before}

【用户确认版本】
{after}`;

// 读取本地记忆数据；解析失败返回默认值
function getMemoryData() {
  try {
    const d = JSON.parse(localStorage.getItem('memory_data') || 'null');
    if (d && typeof d === 'object') {
      return { enabled: !!d.enabled, rules: Array.isArray(d.rules) ? d.rules : [] };
    }
  } catch (e) {}
  return { enabled: false, rules: [] };
}

// 写入本地记忆数据（仅本地，不推送服务器）
function setMemoryData(d) {
  localStorage.setItem('memory_data', JSON.stringify({
    enabled: !!(d && d.enabled),
    rules: (d && Array.isArray(d.rules)) ? d.rules : []
  }));
}

// 拉取：成功则覆盖本地并派发 memory-synced 事件（记忆中心页据此刷新界面）；
// 空库守卫（仿 style）：服务器从未写入且本地有数据时，改为上传本地而非被空库覆盖。
// 失败（无后端）保留本地，manual 为 true 时给出提示，否则静默。
async function memorySyncPull(manual) {
  if (!/^https?:$/.test(location.protocol)) return false;
  try {
    const resp = await fetch('/api/memory', { cache: 'no-store' });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data || typeof data !== 'object') return false;
    if (!data.updatedAt) {
      const local = getMemoryData();
      if (local.enabled || local.rules.length) { memorySyncPush(); return true; }
    }
    setMemoryData(data);
    window.dispatchEvent(new Event('memory-synced'));
    return true;
  } catch (e) {
    if (manual) showToast('无法连接同步服务器，记忆数据仅保存在本浏览器', true);
    return false;
  }
}

// 推送：防抖 600ms 合并连续修改；失败静默（本地数据已保存）
let memorySyncTimer = null;
function memorySyncPush() {
  if (!/^https?:$/.test(location.protocol)) return;
  clearTimeout(memorySyncTimer);
  memorySyncTimer = setTimeout(async () => {
    try {
      await fetch('/api/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getMemoryData())
      });
    } catch (e) { /* 静默失败：本地数据已保存，下次同步时再上传 */ }
  }, 600);
}

// 所有页面加载后自动从服务器拉取记忆数据（异步，不阻塞页面渲染）
document.addEventListener('DOMContentLoaded', () => { memorySyncPull(false); });

// 提示词注入：开关关闭或无匹配规则返回 ''；否则取该 feature 最近 15 条规则
function getMemoryInject(feature) {
  try {
    const d = getMemoryData();
    if (!d.enabled) return '';
    const rules = d.rules.filter(r => r && r.feature === feature && r.text).slice(-15);
    if (!rules.length) return '';
    return '\n\n## 用户历史修正偏好（必须遵循）\n以下是该用户过往微调/转换中确认过的修改偏好，本次生成必须遵循：\n'
      + rules.map((r, i) => (i + 1) + '. ' + r.text).join('\n');
  } catch (e) { return ''; }
}

// 对比 AI 原版与用户确认版，调用 LLM 提炼 1~3 条偏好规则存入记忆库，返回新增条数
async function distillMemoryRule(feature, lang, before, after) {
  const prompt = MEMORY_DISTILL_PROMPT.replace('{before}', before).replace('{after}', after);
  const data = await postChatCompletion(getApiConfig(), [{ role: 'user', content: prompt }], { maxTokens: 1000 });
  const choice = data.choices && data.choices[0];
  const content = (choice && choice.message && typeof choice.message.content === 'string')
    ? choice.message.content : '';
  // 按行拆分、去序号、去空行
  const lines = content.split('\n')
    .map(l => l.replace(/^\s*\d+[.、)]\s*/, '').trim())
    .filter(Boolean);
  // 唯一非空行是「无」→ 不新增
  if (lines.length === 1 && lines[0] === '无') return 0;
  const picked = lines.filter(l => l !== '无').slice(0, 3);   // 最多取 3 条
  if (!picked.length) return 0;
  const mem = getMemoryData();
  const now = Date.now();
  picked.forEach((text, i) => {
    mem.rules.push({
      id: 'r' + now + '_' + i,
      feature: feature,
      lang: lang,
      text: text.slice(0, 2000),   // 每条截断 2000 字符
      createdAt: now / 1000
    });
  });
  while (mem.rules.length > 30) mem.rules.shift();   // 超 30 条丢最旧
  setMemoryData(mem);
  memorySyncPush();
  return picked.length;
}

// 模态代码编辑器（布局参照 settingsOverlay）：等宽大 textarea + 保存并返回/取消
function openCodeEditor(initialCode, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  panel.style.maxWidth = '860px';
  panel.innerHTML = '<div class="settings-header"><span>编辑代码</span>'
    + '<button class="settings-close" data-act="close" title="关闭">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    + '</button></div>'
    + '<textarea id="memoryEditorArea" style="width:100%;min-height:420px;box-sizing:border-box;'
    + 'font-family:Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;"></textarea>'
    + '<div class="btn-group" style="margin-top:12px;">'
    + '<button class="btn btn-primary" data-act="save">保存并返回</button>'
    + '<button class="btn btn-secondary" data-act="close">取消</button></div>';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const ta = panel.querySelector('#memoryEditorArea');
  ta.value = initialCode;
  ta.focus();
  const close = () => overlay.remove();
  // 点击遮罩空白处等同于取消
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  panel.querySelectorAll('[data-act="close"]').forEach(b => b.addEventListener('click', close));
  panel.querySelector('[data-act="save"]').addEventListener('click', () => {
    onSave(ta.value);
    close();
  });
}

// 确认操作条：AI 生成/转换/微调成功后由页面调用。
// opts = { feature, lang, aiCode, getCode, setCode, confirmed(可选，初始已确认), onConfirm(可选，确认后回调) }
function showConfirmBar(container, opts) {
  // 同一代码区域重复生成时，先移除旧操作条再插新的
  const old = container.querySelector('.memory-confirm-bar');
  if (old) old.remove();

  const bar = document.createElement('div');
  bar.className = 'memory-confirm-bar';
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
    + 'margin-top:10px;padding:8px 12px;border:1px solid var(--border-light);'
    + 'border-radius:8px;background:var(--bg);font-size:12.5px;';

  // 状态文字：待确认（灰）→ 确认后变 ✓ 已确认（绿）
  const status = document.createElement('span');
  function setStatus(confirmed) {
    status.textContent = confirmed ? '✓ 已确认' : '待确认';
    status.style.cssText = 'font-weight:600;color:' + (confirmed ? '#1a7f37' : '#8e8e93') + ';';
  }
  setStatus(!!opts.confirmed);

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-secondary';
  editBtn.style.cssText = 'padding:4px 12px;font-size:12px;';
  editBtn.textContent = '编辑';
  editBtn.onclick = () => {
    openCodeEditor(opts.getCode(), (newCode) => {
      opts.setCode(newCode);
      setStatus(false);   // 代码被改动，回到待确认（确认不锁定：可持续编辑-确认，逐轮提炼）
    });
  };

  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-secondary';
  okBtn.style.cssText = 'padding:4px 12px;font-size:12px;';
  okBtn.textContent = '确认无误';
  okBtn.onclick = async () => {
    // 确认完成：状态变绿、通知页面持久化确认状态（回传最终代码，供页面更新 diff 基准）。
    // 按钮不锁定：用户可继续编辑并再次确认，每轮与「最近一次确认版」对比提炼增量偏好。
    const finish = () => {
      const finalCode = opts.getCode();
      setStatus(true);
      okBtn.textContent = '确认无误';
      if (opts.onConfirm) opts.onConfirm(finalCode);
    };
    const mem = getMemoryData();
    if (!mem.enabled) {
      finish();
      showToast('已确认（记忆功能未开启，可在记忆中心开启）');
      return;
    }
    const finalCode = opts.getCode();
    // 无基准（aiCode 为空）时不走「一致」判断，直接提炼
    if (opts.aiCode && finalCode === opts.aiCode) {
      finish();
      showToast('已确认：与 AI 结果一致，无需记录偏好');
      return;
    }
    okBtn.disabled = true;
    okBtn.textContent = '提炼中...';
    try {
      const n = await distillMemoryRule(opts.feature, opts.lang, opts.aiCode, finalCode);
      finish();
      okBtn.disabled = false;
      showToast(n > 0 ? '已确认，已提炼 ' + n + ' 条偏好规则' : '已确认：修改属业务逻辑变化，无通用偏好可提炼');
    } catch (e) {
      // 提炼失败不阻塞确认
      console.error('偏好提炼失败', e);
      finish();
      okBtn.disabled = false;
      showToast('已确认，但偏好提炼失败：' + e.message, true);
    }
  };

  const ignoreBtn = document.createElement('button');
  ignoreBtn.className = 'btn btn-secondary';
  ignoreBtn.style.cssText = 'padding:4px 12px;font-size:12px;margin-left:auto;';
  ignoreBtn.textContent = '忽略';
  ignoreBtn.onclick = () => bar.remove();

  bar.appendChild(status);
  bar.appendChild(editBtn);
  bar.appendChild(okBtn);
  bar.appendChild(ignoreBtn);
  container.appendChild(bar);
}
