// @ts-nocheck

const encoder = new TextEncoder();

// D1 表名
const TABLES = {
  ENDPOINT_TABLE: 'endpoint_table',
  TOKEN_CACHE: 'token_cache',
  VOICE_LIST: 'voice_list'
};

// ============ 全局变量 ============
let endpointTable = {};
let mergedVoiceListCache = null;
let tokenCache = new Map();
let isInitialized = false;
let initializationPromise = null;
let remoteServicesCache = null;
let lastInitFailureAt = 0;
const INIT_RETRY_COOLDOWN = 30 * 1000;

let recentRequesters = new Map();
const BLOCK_DURATION = 3 * 60 * 1000;

let remoteTokenConfig = '';
let workerNodeId = '';
let nodeSharedSecret = '';

let endpointGenerating = null;

const NODE_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;
const NODE_RATE_LIMIT = 30;
const NODE_RATE_WINDOW_MS = 60 * 1000;
const RECENT_REQUESTERS_MAX = 1000;
const NODE_RATE_MAP_MAX = 1000;
let nodeRateLimitMap = new Map();

const MAX_TEXT_LENGTH = 4096;

// 端点表并发生成每批数量 + 单区域超时
const REGION_CONCURRENCY = 5;
const REGION_TIMEOUT_MS = 10000;

// outputFormat 白名单正则
const OUTPUT_FORMAT_PATTERN = /^audio-\d+khz-\d+kbitrate-mono-(mp3|opus)$/;

// rate/pitch 范围
const RATE_MIN = -100, RATE_MAX = 100;
const PITCH_MIN = -100, PITCH_MAX = 100;

const TOKEN_PRIORITY = [
  { region: 'southeastasia', priority: 1 },
  { region: 'eastus', priority: 2 },
  { region: 'westeurope', priority: 3 },
  { region: 'westus2', priority: 4 },
  { region: 'eastasia', priority: 5 },
  { region: 'westus', priority: 6 },
  { region: 'centralindia', priority: 7 },
  { region: 'northeurope', priority: 8 },
  { region: 'japaneast', priority: 9 }
];

const preserveTags = [
  { name: 'break', pattern: /<break\s+[^>]*\/>/g },
  { name: 'speak', pattern: /<speak>|<\/speak>/g },
  { name: 'prosody', pattern: /<prosody\s+[^>]*>|<\/prosody>/g },
  { name: 'emphasis', pattern: /<emphasis\s+[^>]*>|<\/emphasis>/g },
  { name: 'voice', pattern: /<voice\s+[^>]*>|<\/voice>/g },
  { name: 'say-as', pattern: /<say-as\s+[^>]*>|<\/say-as>/g },
  { name: 'phoneme', pattern: /<phoneme\s+[^>]*>|<\/phoneme>/g },
  { name: 'audio', pattern: /<audio\s+[^>]*>|<\/audio>/g },
  { name: 'p', pattern: /<p>|<\/p>/g },
  { name: 's', pattern: /<s>|<\/s>/g },
  { name: 'sub', pattern: /<sub\s+[^>]*>|<\/sub>/g },
  { name: 'mstts', pattern: /<mstts:[^>]*>|<\/mstts:[^>]*>/g }
];

const VOICE_STYLE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

// sign 的 HMAC key 缓存
let _signKeyCache = null;

// ============ 工具函数 ============

function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeSSML(ssml) {
  let placeholders = new Map();
  let processedSSML = ssml;
  let counter = 0;
  const salt = uuid();

  for (const tag of preserveTags) {
    processedSSML = processedSSML.replace(tag.pattern, function (match) {
      const placeholder = `__SSML_${salt}_${tag.name}_${counter++}__`;
      placeholders.set(placeholder, match);
      return placeholder;
    });
  }

  let escapedContent = escapeBasicXml(processedSSML);
  placeholders.forEach((value, key) => {
    escapedContent = escapedContent.replace(key, () => value);
  });
  return escapedContent;
}

function escapeBasicXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function formatRemainingTime(expiry) {
  const remainingMs = Math.max(0, expiry - Date.now());
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.min(59, Math.floor((remainingMs % 60000) / 1000));
  return { ms: remainingMs, minutes, seconds, text: `${minutes}分${seconds}秒` };
}

function createJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createOpenAIError(message, status = 400, type = 'invalid_request_error', code = null) {
  return createJsonResponse({ error: { message, type, code } }, status);
}

function createAudioResponse(response, download) {
  if (!download) return response;
  if (!response.body) return response;
  const resp = new Response(response.body, response);
  resp.headers.set('Content-Disposition', `attachment; filename="${uuid()}.mp3"`);
  return resp;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ============ 节点鉴权工具 ============

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function computeNodeAuth(secret, nodeId, ts) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${nodeId}\n${ts}`));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function getAllowedNodeIds() {
  return new Set(getRemoteServices().map(s => s.marker));
}

function checkNodeRateLimit(nodeId) {
  const now = Date.now();
  const entry = nodeRateLimitMap.get(nodeId);
  if (!entry || now - entry.windowStart >= NODE_RATE_WINDOW_MS) {
    if (nodeRateLimitMap.size >= NODE_RATE_MAP_MAX && !nodeRateLimitMap.has(nodeId)) {
      nodeRateLimitMap.delete(nodeRateLimitMap.keys().next().value);
    }
    nodeRateLimitMap.set(nodeId, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= NODE_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function cleanupNodeRateLimit() {
  const now = Date.now();
  for (const [k, v] of nodeRateLimitMap) {
    if (now - v.windowStart > 2 * NODE_RATE_WINDOW_MS) nodeRateLimitMap.delete(k);
  }
  if (nodeRateLimitMap.size > NODE_RATE_MAP_MAX) {
    const excess = nodeRateLimitMap.size - NODE_RATE_MAP_MAX;
    let removed = 0;
    for (const k of nodeRateLimitMap.keys()) {
      nodeRateLimitMap.delete(k);
      if (++removed >= excess) break;
    }
  }
}

// ============ 远程服务列表 ============

function getRemoteServices() {
  if (remoteServicesCache) return remoteServicesCache;

  const services = [];
  if (!remoteTokenConfig) {
    remoteServicesCache = services;
    return services;
  }

  let raw = remoteTokenConfig;

  // 容错 1：字面量 \n 转真实换行
  if (raw.includes('\\n') && !raw.includes('\n')) {
    console.warn('⚠️ REMOTETOKEN 含字面量 \\n，自动转换');
    raw = raw.replace(/\\n/g, '\n');
  }

  // 容错 2：单行含多个 url 时按边界拆分（每节点必有 apiKey，正则可靠）
  const urlCount = (raw.match(/https?:\/\//g) || []).length;
  let lines;

  if (urlCount > 1 && !raw.includes('\n')) {
    console.warn(`⚠️ REMOTETOKEN 单行含 ${urlCount} 个 url 但无换行，配置可能被吞换行，尝试拆分`);
    const re = /(\S+)\s+(https?:\/\/\S+)\s+(\S+)/g;
    lines = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
      lines.push(`${m[1]} ${m[2]} ${m[3]}`);
    }
    if (lines.length !== urlCount) {
      console.warn(`⚠️ 正则拆分数量(${lines.length})与 url 数量(${urlCount})不一致，回退逐行处理。请检查配置，每行一条。`);
      lines = raw.split(/\r?\n/);
    }
  } else {
    lines = raw.split(/\r?\n/);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      console.warn(`⚠️ REMOTETOKEN 行格式无效，已跳过: "${trimmed}"`);
      continue;
    }

    const [name, url, apiKey = ''] = parts;

    if (!/^https?:\/\//i.test(url)) {
      console.warn(`⚠️ REMOTETOKEN url 非法（需 http:// 或 https://），已跳过: "${trimmed}"`);
      continue;
    }
    try {
      new URL(url);
    } catch {
      console.warn(`⚠️ REMOTETOKEN url 无法解析，已跳过: "${url}"`);
      continue;
    }

    if (/^https?:\/\//i.test(name)) {
      console.warn(`⚠️ REMOTETOKEN name 异常（疑似拆分错误），已跳过: "${trimmed}"`);
      continue;
    }

    if (!apiKey) {
      console.warn(`⚠️ REMOTETOKEN 节点 "${name}" 缺少 apiKey，鉴权将失败`);
    }

    services.push({ url, apiKey: apiKey.trim(), marker: name });
  }

  console.log(`📋 REMOTETOKEN 解析完成: ${services.length} 个远程节点`);
  services.forEach((s, i) => {
    console.log(`  [${i + 1}] ${s.marker} -> ${s.url} (apiKey: ${s.apiKey ? '***' : '空'})`);
  });

  remoteServicesCache = services;
  return services;
}
// ============ 远程获取 token ============

async function getTokenFromRemoteService(service) {
  let timeout = null;

  try {
    console.log(`尝试远程服务: ${service.marker}`);

    const lastRequest = recentRequesters.get(service.marker);
    if (lastRequest && Date.now() - lastRequest < BLOCK_DURATION) {
      console.log(`⏭️ 跳过 ${service.marker}（最近请求过我们）`);
      return null;
    }

    if (!nodeSharedSecret) {
      console.warn('❌ 本节点未配置 WORKER_SHARED_SECRET，跳过远程获取');
      return null;
    }

    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 10000);

    const ts = Date.now().toString();
    const headers = {
      'Content-Type': 'application/json',
      'X-Node-Id': workerNodeId,
      'X-TS': ts,
      'X-Auth': await computeNodeAuth(nodeSharedSecret, workerNodeId, ts)
    };
    if (service.apiKey) headers['X-API-Key'] = service.apiKey;

    const response = await fetch(service.url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });

    clearTimeout(timeout);
    timeout = null;

    if (!response.ok) {
      try {
        const errorData = await response.json();
        console.warn(` ${service.marker} 返回错误: HTTP ${response.status}, 错误: ${errorData.error || 'unknown'}`);
      } catch (e) {
        console.warn(` ${service.marker} 错误: HTTP ${response.status}`);
      }
      return null;
    }

    const data = await response.json();

    if (data.success && data.token) {
      const timeInfo = formatRemainingTime(data.expiry);
      console.log(`📡 从 ${service.marker} 获取token成功: ${data.region}(优先级${data.priority}, ${timeInfo.text})`);
      return {
        region: data.region,
        token: data.token,
        expiry: data.expiry,
        priority: data.priority
      };
    }

    console.warn(`远程服务返回失败: ${data.error || 'unknown'}`);
    return null;
  } catch (error) {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (error.name === 'AbortError') {
      console.warn(`远程服务超时: ${service.marker}`);
    } else {
      console.warn(`远程服务不可用: ${service.marker}`, error.message);
    }
    return null;
  }
}

// ============ D1 操作 ============

async function safeD1Query(DB, table, processFn, errorMessage) {
  try {
    if (!DB) throw new Error('DB 未绑定');
    if (!Object.values(TABLES).includes(table)) throw new Error(`非法表名: ${table}`);
    const result = await DB.prepare(`SELECT * FROM ${table}`).all();
    if (result.results && result.results.length > 0) return processFn(result.results);
    return null;
  } catch (error) {
    console.warn(`${errorMessage}:`, error.message);
    return null;
  }
}

async function loadEndpointTableFromD1(DB) {
  return await safeD1Query(DB, TABLES.ENDPOINT_TABLE, (rows) => {
    const table = {};
    for (const row of rows) {
      table[row.region] = { priority: row.priority, voices: JSON.parse(row.voices_data) };
    }
    return table;
  }, '从 D1 加载端点表失败');
}

async function saveEndpointTableToD1(DB) {
  try {
    if (!DB) return;
    const now = Date.now();
    const entries = Object.entries(endpointTable);
    if (entries.length === 0) {
      console.warn('⚠️ 端点表为空，跳过保存');
      return;
    }
    await DB.batch([
      DB.prepare(`DELETE FROM ${TABLES.ENDPOINT_TABLE}`),
      ...entries.map(([region, data]) =>
        DB.prepare(
          `INSERT OR REPLACE INTO ${TABLES.ENDPOINT_TABLE} (region, priority, voices_data, updated_at) VALUES (?, ?, ?, ?)`
        ).bind(region, data.priority, JSON.stringify(data.voices), now)
      )
    ]);
    console.log(`💾 端点表已保存到D1 (${entries.length}个区域)`);
  } catch (error) {
    console.warn('保存端点表到D1失败:', error.message);
  }
}

async function loadTokenCacheFromD1(DB) {
  try {
    if (!DB) return new Map();
    const now = Date.now();
    const result = await DB.prepare(`SELECT * FROM ${TABLES.TOKEN_CACHE} WHERE expiry > ?`).bind(now).all();
    const cache = new Map();
    if (result.results) {
      for (const row of result.results) {
        cache.set(row.region, {
          token: row.token,
          expiry: row.expiry,
          priority: row.priority
        });
      }
    }
    return cache;
  } catch (error) {
    console.warn('从D1加载token缓存失败:', error.message);
    return new Map();
  }
}

async function saveTokenCacheToD1(DB) {
  try {
    if (!DB) return;
    const now = Date.now();
    const validEntries = [...tokenCache].filter(([, data]) => data.expiry > now);

    const statements = [
      DB.prepare(`DELETE FROM ${TABLES.TOKEN_CACHE} WHERE expiry < ?`).bind(now)
    ];
    for (const [region, data] of validEntries) {
      statements.push(
        DB.prepare(
          `INSERT OR REPLACE INTO ${TABLES.TOKEN_CACHE} (region, token, expiry, priority, updated_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(region, data.token, data.expiry, data.priority, now)
      );
    }

    await DB.batch(statements);
    if (validEntries.length > 0) {
      console.log(`💾 保存${validEntries.length}个token到D1`);
    }
  } catch (error) {
    console.warn('保存token缓存到D1失败:', error.message);
  }
}

async function loadVoiceListFromD1(DB) {
  return await safeD1Query(
    DB,
    TABLES.VOICE_LIST,
    (rows) => rows.map(row => JSON.parse(row.voice_data)),
    '从D1加载语音列表失败'
  );
}

async function saveVoiceListToD1(DB) {
  try {
    if (!DB) return;
    const now = Date.now();
    if (!mergedVoiceListCache || mergedVoiceListCache.length === 0) {
      console.warn('⚠️ 语音列表为空，跳过保存');
      return;
    }
    await DB.batch([
      DB.prepare(`DELETE FROM ${TABLES.VOICE_LIST}`),
      ...mergedVoiceListCache.map(voice =>
        DB.prepare(
          `INSERT OR REPLACE INTO ${TABLES.VOICE_LIST} (voice_name, voice_data, updated_at) VALUES (?, ?, ?)`
        ).bind(voice.ShortName, JSON.stringify(voice), now)
      )
    ]);
    console.log(`💾 语音列表已保存到D1 (${mergedVoiceListCache.length}个语音)`);
  } catch (error) {
    console.warn('保存语音列表到D1失败:', error.message);
  }
}

// ============ Token 相关 ============

function getPriority(region) {
  const item = TOKEN_PRIORITY.find(p => p.region === region);
  return item ? item.priority : 99;
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - padded.length % 4) % 4);
    return JSON.parse(atob(padded + padding));
  } catch (error) {
    return null;
  }
}

async function getDynamicToken() {
  try {
    const endpointUrl = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
    const headers = {
      'Accept-Language': 'zh-Hans',
      'X-ClientVersion': '4.0.530a 5fe1dc6c',
      'X-UserId': generateUserId(),
      'X-HomeGeographicRegion': 'zh-Hans-CN',
      'X-ClientTraceId': uuid(),
      'X-MT-Signature': await sign(endpointUrl),
      'User-Agent': 'okhttp/4.5.0',
      'Content-Type': 'application/json',
      'Content-Length': '0',
      'Accept-Encoding': 'gzip'
    };
    const response = await fetch(endpointUrl, { method: 'POST', headers: headers });

    if (response.ok) {
      const data = await response.json();
      const jwtPayload = decodeJwtPayload(data.t);

      let actualRegion = data.r || 'unknown';
      let tokenExpiry = Date.now() + 20 * 60 * 1000;

      if (jwtPayload) {
        if (jwtPayload.exp) tokenExpiry = jwtPayload.exp * 1000;
        if (jwtPayload.aud) {
          const audMatch = jwtPayload.aud.match(/urn:ms\.speechservices\.(.+)/);
          if (audMatch) actualRegion = audMatch[1];
        }
      }

      const priority = getPriority(actualRegion);

      return {
        region: actualRegion,
        token: data.t,
        expiry: tokenExpiry,
        priority: priority
      };
    }
    return null;
  } catch (error) {
    console.error('获取动态token失败:', error.message);
    return null;
  }
}

// 刷新 token（内部实现，不做单飞；调用方负责单飞）
// 设计：无论本地直连还是远程，匹配成功均写 tokenCache + D1，供后续复用
async function refreshToken(DB, voiceName, style) {
  console.log('🔄 开始刷新token');

  // ============ 阶段 1：本地直连微软（3 次） ============
  for (let i = 0; i < 3; i++) {
    const tokenData = await getDynamicToken();

    if (!tokenData) {
      await sleep(200);
      continue;
    }

    const priority = tokenData.priority;
    const region = tokenData.region;
    const timeInfo = formatRemainingTime(tokenData.expiry);

    const isMatch = checkVoiceStyle(region, voiceName, style);
    if (!isMatch) {
      console.log(`❌ 获取token: ${region}(优先级${priority}, 声音或风格与需求不匹配，弃用。)`);
      await sleep(200);
      continue;
    }

    // 匹配成功：写入缓存 + D1，供后续复用（与阶段 2 行为一致）
    console.log(`✅ token: ${region}(优先级${priority}, 有效期${timeInfo.text})，语言及风格匹配成功，已缓存。`);
    tokenCache.set(region, tokenData);
    await saveTokenCacheToD1(DB);
    return tokenData;
  }

  // ============ 阶段 2：远程节点（按 REMOTETOKEN 顺序） ============
  console.log('❌ 无匹配语言及风格的token，从远程获取');

  const remoteServices = getRemoteServices();
  let cacheDirty = false;

  for (let index = 0; index < remoteServices.length; index++) {
    const service = remoteServices[index];
    console.log(`尝试第 ${index + 1}/${remoteServices.length} 个远程服务`);

    const remoteToken = await getTokenFromRemoteService(service);

    if (!remoteToken) {
      console.log(`❌ 第${index + 1}个远程服务获取失败`);
      continue;
    }

    const isMatch = checkVoiceStyle(remoteToken.region, voiceName, style);

    if (isMatch) {
      const remoteTimeInfo = formatRemainingTime(remoteToken.expiry);
      console.log(`✅ 远程获取匹配token成功: ${remoteToken.region}(优先级${remoteToken.priority}, ${remoteTimeInfo.text})，已缓存。`);
      tokenCache.set(remoteToken.region, remoteToken);
      await saveTokenCacheToD1(DB);
      return remoteToken;
    }

    console.log(`❌ 远程token: ${remoteToken.region}(优先级${remoteToken.priority}, 不匹配，缓存备用)`);
    tokenCache.set(remoteToken.region, remoteToken);
    cacheDirty = true;
  }

  if (cacheDirty) {
    await saveTokenCacheToD1(DB);
  }

  console.log('❌ 所有远程服务均无匹配token');
  return null;
}

// 单飞刷新：同一时刻只有一个 refreshToken 在执行
let refreshPromise = null;

function ensureRefresh(DB, voiceName, style) {
  if (!refreshPromise) {
    refreshPromise = refreshToken(DB, voiceName, style)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

// 获取最佳 token
async function getBestToken(DB, voiceName, style) {
  const now = Date.now();
  const TOKEN_REFRESH_THRESHOLD = 5 * 60 * 1000;

  let expiredCount = 0;
  for (const [region, data] of tokenCache) {
    if (!data.expiry || data.expiry < now) {
      tokenCache.delete(region);
      expiredCount++;
    }
  }
  if (expiredCount > 0) {
    console.log(`🧹 清理${expiredCount}个过期token`);
  }

  let bestMatch = null;
  for (const [region, data] of tokenCache) {
    if (checkVoiceStyle(region, voiceName, style)) {
      if (!bestMatch || data.priority < bestMatch.priority) {
        bestMatch = { region, ...data };
      }
    }
  }

  if (bestMatch) {
    const timeInfo = formatRemainingTime(bestMatch.expiry);

    if (bestMatch.expiry < now + TOKEN_REFRESH_THRESHOLD) {
      console.log(`⚠️ Token即将过期(${timeInfo.text})，后台刷新`);
      ensureRefresh(DB, voiceName, style)
        .then(newToken => {
          if (newToken) {
            const newTimeInfo = formatRemainingTime(newToken.expiry);
            console.log(`✅ 后台刷新成功: ${newToken.region}(优先级${newToken.priority}, ${newTimeInfo.text})`);
          }
        })
        .catch(e => console.warn('后台刷新失败:', e.message));
    } else {
      console.log(`✅ 使用缓存token: 区域=${bestMatch.region}, 优先级=${bestMatch.priority}, 有效期=${timeInfo.text}`);
    }

    return bestMatch;
  }

  console.log('📭 无可用token，获取新token');
  if (refreshPromise) {
    console.log('⏳ 刷新已在进行中，等待完成...');
    const newToken = await refreshPromise;
    if (newToken && newToken.expiry > Date.now() && checkVoiceStyle(newToken.region, voiceName, style)) {
      return newToken;
    }
    console.warn('⚠️ 等待的刷新结果不匹配当前 voice/style，返回 null');
    return null;
  }

  return await ensureRefresh(DB, voiceName, style);
}

// ============ 端点表生成（单飞锁 + 分批并发） ============

async function generateEndpointTable(DB) {
  if (endpointGenerating) {
    console.log('⏳ 端点表生成进行中，等待完成...');
    return await endpointGenerating;
  }

  endpointGenerating = (async () => {
    console.log('🔄 开始生成端点表');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.26',
      'X-Ms-Useragent': 'SpeechStudio/2021.05.001',
      'Content-Type': 'application/json',
      'Origin': 'https://azure.microsoft.com',
      'Referer': 'https://azure.microsoft.com'
    };

    const fetchRegion = async (priorityItem) => {
      const region = priorityItem.region;
      const url = `https://${region}.api.speech.microsoft.com/cognitiveservices/voices/list`;
      let timeout = null;

      try {
        console.log(`获取 ${region} 的语音列表...`);
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), REGION_TIMEOUT_MS);
        const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        clearTimeout(timeout);
        timeout = null;

        if (!response.ok) {
          console.warn(`${region}: HTTP ${response.status}`);
          return null;
        }

        const allVoices = await response.json();
        if (!Array.isArray(allVoices)) return null;

        const chineseVoices = allVoices.filter(v =>
          v && v.Locale && v.Locale.startsWith('zh-') && v.ShortName
        );
        if (chineseVoices.length === 0) return null;

        const voicesMap = {};
        for (const voice of chineseVoices) {
          voicesMap[voice.ShortName] = {
            LocalName: voice.LocalName || voice.ShortName,
            Gender: voice.Gender || 'Female',
            Locale: voice.Locale || 'zh-CN',
            StyleList: voice.StyleList || ['general']
          };
        }
        console.log(`  ${region}: ${chineseVoices.length}个语音`);
        return {
          region,
          data: { priority: priorityItem.priority, voices: voicesMap }
        };
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        if (error.name === 'AbortError') {
          console.warn(`  ${region}: 超时`);
        } else {
          console.warn(`  ${region}: ${error.message}`);
        }
        return null;
      }
    };

    const newEndpointTable = {};
    for (let i = 0; i < TOKEN_PRIORITY.length; i += REGION_CONCURRENCY) {
      const batch = TOKEN_PRIORITY.slice(i, i + REGION_CONCURRENCY);
      const results = await Promise.all(batch.map(fetchRegion));
      for (const r of results) {
        if (r) newEndpointTable[r.region] = r.data;
      }
    }

    if (Object.keys(newEndpointTable).length > 0) {
      endpointTable = newEndpointTable;
      await generateMergedVoiceList();
      await saveEndpointTableToD1(DB);
      await saveVoiceListToD1(DB);
      console.log(`✅ 端点表生成完成 (${Object.keys(endpointTable).length}个区域)`);
    } else {
      console.warn('⚠️ 本次生成未获得任何区域数据，保留原端点表');
    }

    return endpointTable;
  })().finally(() => { endpointGenerating = null; });

  return await endpointGenerating;
}

async function generateMergedVoiceList() {
  const mergedVoices = new Map();

  for (const [region, data] of Object.entries(endpointTable)) {
    for (const [voiceName, voiceData] of Object.entries(data.voices)) {
      if (!mergedVoices.has(voiceName)) {
        mergedVoices.set(voiceName, {
          ShortName: voiceName,
          LocalName: voiceData.LocalName,
          Gender: voiceData.Gender,
          Locale: voiceData.Locale,
          StyleList: new Set()
        });
      }
      for (const style of voiceData.StyleList) {
        mergedVoices.get(voiceName).StyleList.add(style);
      }
    }
  }

  const result = [];
  for (const [voiceName, data] of mergedVoices) {
    result.push({
      ShortName: voiceName,
      LocalName: data.LocalName,
      Gender: data.Gender,
      Locale: data.Locale,
      StyleList: [...data.StyleList]
    });
  }

  mergedVoiceListCache = result;
  return result;
}

async function getMergedVoiceList(DB) {
  if (mergedVoiceListCache && mergedVoiceListCache.length > 0) return mergedVoiceListCache;

  const cached = await loadVoiceListFromD1(DB);
  if (cached && cached.length > 0) {
    mergedVoiceListCache = cached;
    return cached;
  }

  return await generateMergedVoiceList();
}

function checkVoiceStyle(region, voiceName, style) {
  const endpointData = endpointTable[region];
  if (!endpointData) return false;

  const voiceData = endpointData.voices[voiceName];
  if (!voiceData) return false;

  return voiceData.StyleList.includes(style);
}

// ============ TTS 请求 ============

async function getVoice(DB, text, voiceName, rate, pitch, style, outputFormat, download) {
  const mergedVoices = await getMergedVoiceList(DB);

  if (!mergedVoices || mergedVoices.length === 0) {
    console.warn('❌ 语音列表为空，服务未就绪');
    return createJsonResponse({ error: 'Service not ready: no voices loaded' }, 503);
  }

  if (!VOICE_STYLE_PATTERN.test(voiceName)) {
    console.warn(`❌ 非法 voiceName 格式: ${voiceName}`);
    return createOpenAIError(`Invalid voice format: ${voiceName}`, 400, 'invalid_request_error', 'invalid_voice_format');
  }
  if (!VOICE_STYLE_PATTERN.test(style)) {
    console.warn(`❌ 非法 style 格式: ${style}`);
    return createOpenAIError(`Invalid style format: ${style}`, 400, 'invalid_request_error', 'invalid_style_format');
  }

  const voice = mergedVoices.find(v => v.ShortName === voiceName);
  if (!voice) {
    console.warn(`❌ 未知语音: ${voiceName}`);
    return createOpenAIError(`Unknown voice: ${voiceName}`, 400, 'invalid_request_error', 'unknown_voice');
  }
  if (!voice.StyleList.includes(style)) {
    console.warn(`❌ 未知风格: ${style} (voice=${voiceName})`);
    return createOpenAIError(`Unknown style for voice ${voiceName}: ${style}`, 400, 'invalid_request_error', 'unknown_style');
  }

  if (!OUTPUT_FORMAT_PATTERN.test(outputFormat)) {
    console.warn(`❌ 非法 outputFormat: ${outputFormat}`);
    return createOpenAIError(`Invalid outputFormat: ${outputFormat}`, 400, 'invalid_request_error', 'invalid_output_format');
  }

  const bestToken = await getBestToken(DB, voiceName, style);

  if (!bestToken) {
    return createJsonResponse({ error: '无法获取 TTS token' }, 500);
  }

  const timeInfo = formatRemainingTime(bestToken.expiry);
  const url = `https://${bestToken.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const headers = {
    'Authorization': bestToken.token,
    'Content-Type': 'application/ssml+xml',
    'User-Agent': 'okhttp/4.5.0',
    'X-Microsoft-OutputFormat': outputFormat
  };

  let ssml;
  try {
    ssml = getSsml(text, voiceName, rate, pitch, style);
  } catch (e) {
    console.error('❌ 生成 SSML 失败:', e.message);
    return createOpenAIError(`Invalid SSML parameters: ${e.message}`, 400, 'invalid_request_error', 'invalid_ssml_params');
  }

  console.log(`🎵 TTS请求: ${bestToken.region}(优先级${bestToken.priority}，有效期${timeInfo.text}), ${voiceName}, ${style}`);

  const response = await fetch(url, { method: 'POST', headers, body: ssml });

  if (response.ok) {
    return createAudioResponse(response, download);
  }

  if (response.status === 401 || response.status === 403) {
    const firstStatus = response.status;

    let firstError = await response.text();
    try {
      const j = JSON.parse(firstError);
      if (j.error?.message) firstError = j.error.message;
    } catch {}

    console.warn(`⚠️ TTS 首次失败: HTTP ${firstStatus}, 尝试刷新token重试${firstError ? `, 错误: ${firstError}` : ''}`);

    tokenCache.delete(bestToken.region);
    await saveTokenCacheToD1(DB);

    const newToken = await ensureRefresh(DB, voiceName, style);
    if (newToken) {
      const newTimeInfo = formatRemainingTime(newToken.expiry);
      console.log(`🔄 使用新token重试: ${newToken.region}(优先级${newToken.priority}, ${newTimeInfo.text})`);

      const newUrl = `https://${newToken.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const newHeaders = { ...headers, 'Authorization': newToken.token };
      const newResponse = await fetch(newUrl, { method: 'POST', headers: newHeaders, body: ssml });
      if (newResponse.ok) {
        return createAudioResponse(newResponse, download);
      }

      const retryStatus = newResponse.status;
      let retryError = await newResponse.text();
      try {
        const j = JSON.parse(retryError);
        if (j.error?.message) retryError = j.error.message;
      } catch {}

      console.error(`❌ TTS 重试仍失败: HTTP ${retryStatus} (首次 ${firstStatus})${retryError ? `, 错误: ${retryError}` : ''}`);
      return new Response(retryError || newResponse.statusText, { status: retryStatus });
    }

    console.error(`❌ TTS 首次失败 HTTP ${firstStatus}，且 token 刷新失败${firstError ? `, 首次错误: ${firstError}` : ''}`);
    return new Response(firstError || 'TTS failed and token refresh failed', { status: firstStatus });
  }

  const errorText = await response.text();
  return new Response(errorText || response.statusText, { status: response.status });
}

// ============ 其他工具 ============

function generateUserId() {
  const chars = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

async function sign(urlStr) {
  const url = urlStr.split('://')[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = uuid();
  const formattedDate = dateFormat();
  const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();

  if (!_signKeyCache) {
    _signKeyCache = await base64ToBytes('oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==');
  }
  const signData = await hmacSha256(_signKeyCache, bytesToSign);
  const signBase64 = await bytesToBase64(signData);
  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
  return new Date().toUTCString().replace(/GMT/, '').trim().toLowerCase() + ' gmt';
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

function validateApiKey(apiKey, env) {
  const expected = env.API_KEY || '';
  if (!expected) return false;
  if (typeof apiKey !== 'string') return false;
  return timingSafeEqualStr(apiKey, expected);
}

function getSsml(text, voiceName, rate, pitch, style = 'general') {
  if (!VOICE_STYLE_PATTERN.test(voiceName)) {
    throw new Error(`Invalid voiceName format: ${voiceName}`);
  }
  if (!VOICE_STYLE_PATTERN.test(style)) {
    throw new Error(`Invalid style format: ${style}`);
  }
  text = escapeSSML(text);
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> <voice name="${voiceName}"> <mstts:express-as style="${style}" styledegree="1.0" role="default"> <prosody rate="${rate}%" pitch="${pitch}%" volume="50">${text}</prosody> </mstts:express-as> </voice> </speak>`;
}

// ============ 初始化 ============

async function initialize(env) {
  if (isInitialized) return;
  if (initializationPromise) {
    console.log('⏳ 初始化进行中，等待完成...');
    return initializationPromise;
  }
  if (Date.now() - lastInitFailureAt < INIT_RETRY_COOLDOWN) {
    const err = new Error('Initialization recently failed, cooldown');
    err.code = 'INIT_COOLDOWN';
    throw err;
  }
  if (!env.DB) {
    throw new Error('env.DB not bound');
  }

  console.log('🚀 冷启动，开始初始化...');
  const startTime = Date.now();

  initializationPromise = (async () => {
    try {
      remoteTokenConfig = env.REMOTETOKEN || '';
      remoteServicesCache = null;
      workerNodeId = env.WORKER_NODE_ID || '';
      nodeSharedSecret = env.WORKER_SHARED_SECRET || '';
      if (!workerNodeId) console.warn('⚠️ WORKER_NODE_ID 未配置，/get-token 将拒绝所有请求');
      if (!nodeSharedSecret) console.warn('⚠️ WORKER_SHARED_SECRET 未配置，/get-token 将返回 500');
      if (!env.API_KEY) console.warn('⚠️ API_KEY 未配置，所有 /tts 请求将 401');

      const [d1EndpointTable, d1Tokens, d1Voices] = await Promise.all([
        loadEndpointTableFromD1(env.DB),
        loadTokenCacheFromD1(env.DB),
        loadVoiceListFromD1(env.DB)
      ]);

      if (d1EndpointTable && Object.keys(d1EndpointTable).length > 0) {
        endpointTable = d1EndpointTable;
        console.log(`📊 从D1加载端点表: ${Object.keys(endpointTable).length}个端点`);
      } else {
        console.log('📊 D1无端点表，生成新端点表');
        await generateEndpointTable(env.DB);
      }

      tokenCache.clear();
      if (d1Tokens) {
        for (const [region, data] of d1Tokens) {
          tokenCache.set(region, data);
        }
      }
      const now = Date.now();
      let validTokenCount = 0;
      for (const [region, data] of tokenCache) {
        if (data.expiry && data.expiry > now) {
          const timeInfo = formatRemainingTime(data.expiry);
          console.log(`🎫 从D1加载token: ${region}(优先级${data.priority}, 有效期${timeInfo.text})`);
          validTokenCount++;
        }
      }
      if (validTokenCount > 0) {
        console.log(`🎫 共${validTokenCount}个有效token`);
      } else {
        console.log('🎫 无有效token缓存');
      }

      if (d1Voices && d1Voices.length > 0) {
        mergedVoiceListCache = d1Voices;
        console.log(`🎤 从D1加载语音列表: ${d1Voices.length}个语音`);
      } else {
        console.log('🎤 D1无语音列表，将从端点表生成');
        await generateMergedVoiceList();
      }

      isInitialized = true;
      console.log(`✅ 初始化完成: ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error('❌ 初始化失败:', error);
      lastInitFailureAt = Date.now();
      throw error;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

// ============ 请求解析 ============

async function parseTTSRequest(request) {
  const params = {};

  function cleanStyle(rawStyle) {
    return (rawStyle || '').replace(/[{}]/g, '').trim();
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('Content-Type') || '';
    const bodyText = await request.text();

    console.log(`📥 POST 请求: Content-Type: ${contentType}`);

    if (contentType.includes('application/json')) {
      try {
        const data = JSON.parse(bodyText);
        const rawRate = Number(data.rate || data.r) || 0;
        const rawPitch = Number(data.pitch || data.p) || 0;
        const rawFormat = data.outputFormat || data.o || 'audio-24khz-48kbitrate-mono-mp3';
        Object.assign(params, {
          apiKey: data.api_key || '',
          text: data.text || data.t || '',
          voiceName: data.voice || data.v || '',
          rate: clamp(rawRate, RATE_MIN, RATE_MAX),
          pitch: clamp(rawPitch, PITCH_MIN, PITCH_MAX),
          style: cleanStyle(data.style || data.s || 'general'),
          outputFormat: OUTPUT_FORMAT_PATTERN.test(rawFormat) ? rawFormat : 'audio-24khz-48kbitrate-mono-mp3',
          download: data.download === true || data.d === 'true' || data.download === 'true'
        });
      } catch (error) {
        console.error('  ❌ JSON 解析失败:', error.message);
      }
    } else {
      const formData = new URLSearchParams(bodyText); 
        // 调试日志（确认后可删）
  console.log('POST 表单 text 前 20 字符:', String(formData.get('t') || formData.get('text') || '').slice(0, 20));
      const rawRate = Number(formData.get('r') || formData.get('rate')) || 0;
      const rawPitch = Number(formData.get('p') || formData.get('pitch')) || 0;
      const rawFormat = formData.get('o') || 'audio-24khz-48kbitrate-mono-mp3';

      Object.assign(params, {
        apiKey: formData.get('api_key') || '',
        text: formData.get('t') || formData.get('text') || '',
        voiceName: formData.get('v') || formData.get('voice') || '',
        rate: clamp(rawRate, RATE_MIN, RATE_MAX),
        pitch: clamp(rawPitch, PITCH_MIN, PITCH_MAX),
        style: cleanStyle(formData.get('s') || formData.get('style') || 'general'),
        outputFormat: OUTPUT_FORMAT_PATTERN.test(rawFormat) ? rawFormat : 'audio-24khz-48kbitrate-mono-mp3',
        download: formData.get('d') === 'true' || formData.get('download') === 'true'
      });
    }
  } else {
    const sp = new URL(request.url).searchParams;
    console.log('📥 GET 请求参数:', request.url);
    const rawRate = Number(sp.get('r')) || 0;
    const rawPitch = Number(sp.get('p')) || 0;
    const rawFormat = sp.get('o') || 'audio-24khz-48kbitrate-mono-mp3';

    Object.assign(params, {
      apiKey: sp.get('api_key') || '',
      text: sp.get('t') || '',
      voiceName: sp.get('v') || '',
      rate: clamp(rawRate, RATE_MIN, RATE_MAX),
      pitch: clamp(rawPitch, PITCH_MIN, PITCH_MAX),
      style: cleanStyle(sp.get('s') || 'general'),
      outputFormat: OUTPUT_FORMAT_PATTERN.test(rawFormat) ? rawFormat : 'audio-24khz-48kbitrate-mono-mp3',
      download: sp.get('d') === 'true'
    });
  }

  return params;
}

// ============ 主请求处理 ============

async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const path = requestUrl.pathname;

  const colo = request.cf?.colo || 'unknown';
  console.log(`📍 边缘节点: ${colo}, 路径: ${path}`);

  const routes = new Set([
    '/tts', '/api/v1/tts', '/voices', '/api/v1/voices',
    '/endpoints', '/health', '/reader.json', '/reader-post.json',
    '/ifreetime.json', '/v1/audio/speech', '/audio/speech',
    '/get-token', '/'
  ]);

  if (!routes.has(path)) {
    console.warn(`🚫 未知路径: ${path}`);
    return new Response('Not Found', { status: 404 });
  }

  // ============ TTS ============
  if (path === '/tts' || path === '/api/v1/tts') {
    const params = await parseTTSRequest(request);

    if (!params.text) {
      return createJsonResponse({ error: 'Missing required field: text' }, 400);
    }
    if (params.text.length > MAX_TEXT_LENGTH) {
      return createJsonResponse({ error: `Text too long: ${params.text.length} (max ${MAX_TEXT_LENGTH})` }, 400);
    }

    if (!params.voiceName || !params.style) {
      const mergedVoices = await getMergedVoiceList(env.DB);
      if (mergedVoices.length > 0) {
        if (!params.voiceName) params.voiceName = mergedVoices[0].ShortName;
        if (!params.style) {
          const voice = mergedVoices.find(v => v.ShortName === params.voiceName);
          params.style = voice?.StyleList?.[0] || 'general';
        }
      }
    }

    if (!validateApiKey(params.apiKey, env)) {
      return createJsonResponse({ error: 'Unauthorized' }, 401);
    }

    return await getVoice(
      env.DB,
      params.text,
      params.voiceName,
      params.rate,
      params.pitch,
      params.style,
      params.outputFormat,
      params.download
    );
  }

  // ============ 语音列表 ============
  if (path === '/voices' || path === '/api/v1/voices') {
    const voices = await getMergedVoiceList(env.DB);
    return createJsonResponse(voices);
  }

  // ============ 端点表 ============
  if (path === '/endpoints') {
    return createJsonResponse({
      endpointCount: Object.keys(endpointTable).length,
      endpoints: Object.entries(endpointTable).map(([region, data]) => ({
        region: region,
        priority: data.priority,
        voiceCount: Object.keys(data.voices).length
      }))
    });
  }

  // ============ 健康 ============
  if (path === '/health') {
    return createJsonResponse({
      status: 'ok',
      endpointCount: Object.keys(endpointTable).length,
      mergedVoiceListSize: mergedVoiceListCache?.length || 0,
      tokenCacheSize: tokenCache.size
    });
  }

  // ============ reader.json ============
  if (path === '/reader.json') {
    const apiKey = requestUrl.searchParams.get('api_key');
    if (!validateApiKey(apiKey, env)) {
      return createJsonResponse({
        error: 'Unauthorized',
        message: '无效的 API 密钥，请确保您提供了正确的密钥。',
        status: 401
      }, 401);
    }

    const voice = requestUrl.searchParams.get('v') || '';
    const rate = requestUrl.searchParams.get('r') || '';
    const pitch = requestUrl.searchParams.get('p') || '';
    const style = requestUrl.searchParams.get('s') || '';
    const displayName = requestUrl.searchParams.get('n') || 'Microsoft TTS';

    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    const urlParams = ["t={{java.encodeURI(speakText)}}", "r={{speakSpeed*4}}"];
    if (voice) urlParams.push(`v=${voice}`);
    if (pitch) urlParams.push(`p=${pitch}`);
    if (style) urlParams.push(`s=${style}`);
    if (apiKey) urlParams.push(`api_key=${encodeURIComponent(apiKey)}`);

    const url = `${baseUrl}/tts?${urlParams.join('&')}`;
    return createJsonResponse({ id: Date.now(), name: displayName, url: url });
  }

  // ============ reader-post.json ============
  if (path === '/reader-post.json') {
    const apiKey = requestUrl.searchParams.get('api_key');
    if (!validateApiKey(apiKey, env)) {
      return createJsonResponse({ error: 'Unauthorized' }, 401);
    }

    const voice = requestUrl.searchParams.get('v') || '';
    const rate = requestUrl.searchParams.get('r') || '0';
    const pitch = requestUrl.searchParams.get('p') || '0';
    const style = requestUrl.searchParams.get('s') || 'general';
    const displayName = requestUrl.searchParams.get('n') || 'Microsoft TTS';
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    const ttsUrl = `${baseUrl}/tts`;

    const bodyParts = [
      't={{java.encodeURI(speakText)}}',
      `r={{speakSpeed}}`,
      `v=${voice}`,
      `p=${pitch}`,
      `s=${style}`
    ];
    if (apiKey) bodyParts.push(`api_key=${encodeURIComponent(apiKey)}`);
    const body = bodyParts.join('&');
    const fullUrl = `${ttsUrl},{\n    "method": "POST",\n    "body": "${body}"\n}`;

    return createJsonResponse({ id: Date.now(), name: displayName, url: fullUrl });
  }

  // ============ ifreetime.json ============
  if (path === '/ifreetime.json') {
    const apiKey = requestUrl.searchParams.get('api_key');
    if (!validateApiKey(apiKey, env)) {
      return createJsonResponse({
        error: 'Unauthorized',
        message: '无效的 API 密钥，请确保您提供了正确的密钥。',
        status: 401
      }, 401);
    }

    const voice = requestUrl.searchParams.get('v') || '';
    const rate = requestUrl.searchParams.get('r') || '';
    const pitch = requestUrl.searchParams.get('p') || '';
    const style = requestUrl.searchParams.get('s') || '';
    const displayName = requestUrl.searchParams.get('n') || 'Microsoft TTS';

    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    const url = `${baseUrl}/tts`;
    const ttsConfigID = crypto.randomUUID();

    const params = {
      "t": "%@",
      "v": voice,
      "r": rate,
      "p": pitch,
      "s": style
    };
    if (apiKey) params["api_key"] = apiKey;

    const response = {
      loginUrl: "",
      maxWordCount: "",
      customRules: {},
      ttsConfigGroup: "Azure",
      _TTSName: displayName,
      _ClassName: "JxdAdvCustomTTS",
      _TTSConfigID: ttsConfigID,
      httpConfigs: { useCookies: 1, headers: {} },
      voiceList: [],
      ttsHandles: [{
        paramsEx: "",
        processType: 1,
        maxPageCount: 1,
        nextPageMethod: 1,
        method: 1,
        requestByWebView: 0,
        parser: {},
        nextPageParams: {},
        url: url,
        params: params,
        httpConfigs: { useCookies: 1, headers: {} }
      }]
    };

    return createJsonResponse(response);
  }

  // ============ OpenAI 兼容 ============
  if (path === '/v1/audio/speech' || path === '/audio/speech') {
    return await handleOpenAITTS(request, env);
  }

  // ============ /get-token（严格模式） ============
  if (path === '/get-token') {
    const requester = request.headers.get('X-Node-Id') || '';

    const allowed = getAllowedNodeIds();
    if (!requester || !allowed.has(requester)) {
      console.warn(`❌ /get-token 拒绝未知节点: "${requester}"`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Unknown node' }, 401);
    }

    const secret = env.WORKER_SHARED_SECRET;
    if (!secret) {
      console.error('❌ WORKER_SHARED_SECRET 未配置，/get-token 不可用');
      return createJsonResponse({ success: false, error: 'Server misconfigured' }, 500);
    }

    const ts = request.headers.get('X-TS');
    const auth = request.headers.get('X-Auth');
    if (!ts || !auth) {
      console.warn(`❌ /get-token 缺少 X-TS / X-Auth (node=${requester})`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Missing auth' }, 401);
    }

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > NODE_AUTH_MAX_SKEW_MS) {
      console.warn(`❌ /get-token 时间戳超出窗口 (node=${requester}, ts=${ts})`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Timestamp out of window' }, 401);
    }

    const expectedAuth = await computeNodeAuth(secret, requester, ts);
    if (!timingSafeEqualStr(expectedAuth, auth)) {
      console.warn(`❌ /get-token X-Auth 校验失败 (node=${requester})`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Bad auth' }, 401);
    }

    const apiKey = request.headers.get('X-API-Key') || '';
    if (!apiKey || !validateApiKey(apiKey, env)) {
      console.warn(`❌ /get-token API Key 校验失败 (node=${requester})`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Invalid API key' }, 401);
    }

    cleanupNodeRateLimit();
    if (!checkNodeRateLimit(requester)) {
      console.warn(`🚦 节点 ${requester} 触发限流`);
      return createJsonResponse({ success: false, error: 'Too Many Requests' }, 429);
    }

    recentRequesters.set(requester, Date.now());
    for (const [key, timestamp] of recentRequesters) {
      if (Date.now() - timestamp > BLOCK_DURATION) recentRequesters.delete(key);
    }
    if (recentRequesters.size > RECENT_REQUESTERS_MAX) {
      recentRequesters.delete(recentRequesters.keys().next().value);
    }

    console.log(`📝 节点 ${requester} 请求获取 token`);

    const voiceName = requestUrl.searchParams.get('v') || 'zh-CN-XiaoxiaoNeural';
    const style = requestUrl.searchParams.get('s') || 'general';

    if (!VOICE_STYLE_PATTERN.test(voiceName)) {
      console.warn(`❌ /get-token 非法 voiceName 格式: ${voiceName} (node=${requester})`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Invalid voice format' }, 400);
    }
    if (!VOICE_STYLE_PATTERN.test(style)) {
      console.warn(`❌ /get-token 非法 style 格式: ${style} (node=${requester})`);
      return createJsonResponse({ success: false, error: 'Unauthorized: Invalid style format' }, 400);
    }

    const bestToken = await getBestToken(env.DB, voiceName, style);
    if (bestToken) {
      const timeInfo = formatRemainingTime(bestToken.expiry);
      console.log(`🔑 节点 ${requester} 获取token成功: 区域=${bestToken.region}, 优先级=${bestToken.priority}, 有效期=${timeInfo.text}`);
      return createJsonResponse({
        success: true,
        region: bestToken.region,
        token: bestToken.token,
        expiry: bestToken.expiry,
        priority: bestToken.priority,
        remainingMinutes: timeInfo.minutes,
        remainingSeconds: timeInfo.seconds
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'No matching token available, retry later'
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '10'
      }
    });
  }

  // ============ 默认主页 ============
  return new Response(getWebInterface(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============ OpenAI TTS ============

async function handleOpenAITTS(request, env) {
  if (request.method !== 'POST') {
    return createOpenAIError('Method not allowed', 405, 'invalid_request_error', 'method_not_allowed');
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return createOpenAIError('Missing or invalid Authorization header', 401, 'invalid_request_error', 'invalid_api_key');
  }

  const apiKey = authHeader.replace('Bearer ', '');
  if (!validateApiKey(apiKey, env)) {
    return createOpenAIError('Invalid API key', 401, 'invalid_request_error', 'invalid_api_key');
  }

  try {
    const requestData = await request.json();

    if (!requestData.input) {
      return createOpenAIError('Missing required field: input', 400, 'invalid_request_error', 'missing_input');
    }

    const text = requestData.input;

    if (text.length > MAX_TEXT_LENGTH) {
      console.warn(`⚠️ OpenAI TTS input 超长: ${text.length} > ${MAX_TEXT_LENGTH}`);
      return createOpenAIError(
        `Input too long: ${text.length} chars (max ${MAX_TEXT_LENGTH})`,
        400,
        'invalid_request_error',
        'input_too_long'
      );
    }

    let voiceName = 'zh-CN-XiaoxiaoNeural';

    if (requestData.voice) {
      const voiceMap = {
        'alloy': 'zh-CN-XiaoxiaoNeural',
        'echo': 'zh-CN-YunxiNeural',
        'fable': 'zh-CN-XiaomoNeural',
        'onyx': 'zh-CN-YunjianNeural',
        'nova': 'zh-CN-XiaochenNeural',
        'shimmer': 'zh-CN-XiaoxiaoMultilingualNeural'
      };
      const mapped = voiceMap[requestData.voice] || requestData.voice;
      const merged = await getMergedVoiceList(env.DB);
      if (merged.find(v => v.ShortName === mapped)) {
        voiceName = mapped;
      } else {
        console.warn(`⚠️ OpenAI voice "${requestData.voice}" 映射到 ${mapped} 不存在，回退默认`);
        voiceName = 'zh-CN-XiaoxiaoNeural';
      }
    }

    let rate = 0;
    if (requestData.speed) {
      rate = Math.round((requestData.speed - 1.0) * 100);
      rate = clamp(rate, RATE_MIN, RATE_MAX);
    }

    const outputFormat = requestData.response_format === 'opus' ?
      'audio-48khz-192kbitrate-mono-opus' :
      'audio-24khz-48kbitrate-mono-mp3';

    return await getVoice(
      env.DB,
      text,
      voiceName,
      rate,
      0,
      'general',
      outputFormat,
      false
    );
  } catch (error) {
    console.error('OpenAI TTS error:', error);
    return createOpenAIError('Internal server error: ' + error.message, 500, 'server_error', 'internal_error');
  }
}

// ============ Web 界面 ============

function getWebInterface() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Microsoft TTS API</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            'ms-blue': '#0078d4',
            'ms-dark-blue': '#005a9e',
          }
        }
      }
    }
  </script>
</head>
<body class="bg-gray-50 text-gray-800">
  <nav class="bg-ms-blue shadow-2xl">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-16">
        <div class="flex items-center">
          <svg class="w-8 h-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <span class="ml-2 font-bold text-white text-xl">Microsoft TTS API</span>
        </div>
      </div>
    </div>
  </nav>

  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <div class="flex flex-col lg:flex-row gap-8">
      <div class="lg:w-3/4 mx-auto">
        <div class="bg-white overflow-hidden shadow rounded-lg divide-y divide-gray-200">
          <div class="px-4 py-5 sm:px-6">
            <h2 class="text-lg font-medium text-gray-900">在线文本转语音</h2>
            <p class="mt-1 text-sm text-gray-500">输入文本并选择语音进行转换</p>
          </div>
          <div class="px-4 py-5 sm:p-6">
            <form id="ttsForm" class="space-y-6">
              <div id="apiErrorAlert" class="rounded-md bg-red-50 p-4" style="display: none;">
                <div class="flex">
                  <div class="ml-3">
                    <h3 class="text-sm font-medium text-red-800" id="apiErrorTitle">错误</h3>
                    <div class="mt-2 text-sm text-red-700">
                      <p id="apiErrorMessage"></p>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label for="apiKey" class="block text-sm font-medium text-gray-700">API Key</label>
                <div class="mt-1 flex rounded-md shadow-sm">
                  <div id="apiKeyInputGroup" class="flex-grow flex relative">
                    <input type="password" id="apiKey" name="apiKey"
                      class="block w-full shadow-sm sm:text-sm border-gray-300 rounded-md focus:ring-ms-blue focus:border-ms-blue"
                      placeholder="输入API Key" />
                    <button type="button" id="toggleApiKeyVisibility" class="absolute inset-y-0 right-0 px-3 flex items-center">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 06 0z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                  </div>
                  <button type="button" id="saveApiKey" class="ml-2 inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-white bg-ms-blue hover:bg-ms-dark-blue">
                    保存
                  </button>
                </div>
                <div id="savedApiKeyInfo" style="display:none;" class="mt-2 flex items-center justify-between">
                  <span class="text-sm text-green-600">API Key 已保存</span>
                  <button type="button" id="editApiKey" class="text-sm text-ms-blue hover:text-ms-dark-blue">编辑</button>
                </div>
              </div>

              <div>
                <label for="text" class="block text-sm font-medium text-gray-700">输入文本</label>
                <textarea id="text" name="text" rows="4"
                  class="mt-1 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md focus:ring-ms-blue focus:border-ms-blue"
                  placeholder="请输入要转换的文本"></textarea>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label for="voice" class="block text-sm font-medium text-gray-700">选择语音</label>
                  <select id="voice" name="voice"
                    class="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-ms-blue focus:border-ms-blue sm:text-sm">
                  </select>
                </div>
                <div>
                  <label for="style" class="block text-sm font-medium text-gray-700">语音风格</label>
                  <select id="style" name="style"
                    class="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-ms-blue focus:border-ms-blue sm:text-sm">
                  </select>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label for="rate" class="block text-sm font-medium text-gray-700">语速调整</label>
                  <div class="flex items-center mt-2">
                    <span id="rateValue" class="w-8 text-sm text-gray-500">0</span>
                    <input type="range" id="rate" name="rate" min="-100" max="100" value="0"
                      class="mt-1 block w-full" oninput="document.getElementById('rateValue').textContent=this.value" />
                  </div>
                </div>
                <div>
                  <label for="pitch" class="block text-sm font-medium text-gray-700">音调调整</label>
                  <div class="flex items-center mt-2">
                    <span id="pitchValue" class="w-8 text-sm text-gray-500">0</span>
                    <input type="range" id="pitch" name="pitch" min="-100" max="100" value="0"
                      class="mt-1 block w-full" oninput="document.getElementById('pitchValue').textContent=this.value" />
                  </div>
                </div>
              </div>

              <div class="flex flex-col sm:flex-row gap-3">
                <button type="submit"
                  class="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-ms-blue hover:bg-ms-dark-blue">
                  生成语音
                </button>
                <button type="button" id="downloadBtn" style="display:none;"
                  class="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700">
                  下载音频
                </button>
                <button type="button" id="getReaderLinkBtn"
                  class="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">
                  导入阅读
                </button>
                <button type="button" id="getIFreeTimeLinkBtn"
                  class="inline-flex justify-center py-2 px-4 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">
                  导入爱阅记
                </button>
              </div>
            </form>

            <div id="audioContainer" class="mt-6 rounded-md bg-gray-50 p-4 border border-gray-200" style="display: none;">
              <audio id="audioPlayer" controls class="w-full"></audio>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <footer class="bg-gray-100 border-t border-gray-200">
    <div class="max-w-7xl mx-auto py-6 px-4">
      <p class="text-center text-gray-500 text-sm">&copy; ${new Date().getFullYear()} TTS</p>
    </div>
  </footer>

  <script>
    let allVoices = [];
    let audioUrl = null;

    function cleanupAudioUrl() {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        audioUrl = null;
      }
    }

    function generateReaderLink(endpoint) {
      const params = new URLSearchParams();
      const apiKey = document.getElementById('apiKey').value || localStorage.getItem('tts_api_key') || '';
      const voice = document.getElementById('voice').value;
      const rate = document.getElementById('rate').value;
      const pitch = document.getElementById('pitch').value;
      const style = document.getElementById('style').value;
      const displayName = document.getElementById('voice').options[document.getElementById('voice').selectedIndex].text || '微软TTS';

      if (apiKey) params.append('api_key', apiKey);
      if (voice) params.append('v', voice);
      if (rate) params.append('r', rate);
      if (pitch) params.append('p', pitch);
      if (style) params.append('s', style);
      params.append('n', displayName);

      return window.location.origin + '/' + endpoint + '?' + params.toString();
    }

    function updateStyleOptions(voiceName) {
      const styleSelect = document.getElementById('style');
      styleSelect.innerHTML = '';
      const selectedVoice = allVoices.find(v => v.ShortName === voiceName);
      if (selectedVoice && selectedVoice.StyleList && selectedVoice.StyleList.length > 0) {
        selectedVoice.StyleList.forEach(style => {
          const option = document.createElement('option');
          option.value = style;
          option.text = getStyleName(style);
          styleSelect.appendChild(option);
        });
      } else {
        const option = document.createElement('option');
        option.value = 'general';
        option.text = '标准';
        styleSelect.appendChild(option);
      }
    }

    function getStyleName(style) {
      const styleMap = {
        'general': '标准', 'assistant': '助理', 'chat': '聊天',
        'customerservice': '客服',
        'newscast': '新闻播报', 'affectionate': '深情',
        'angry': '愤怒', 'calm': '平静', 'cheerful': '欢快',
        'sad': '悲伤', 'serious': '严肃', 'gentle': '温柔',
        'friendly': '友好', 'hopeful': '希望', 'lyrical': '抒情',
        'poetry-reading': '诗歌朗诵', 'whispering': '低语',
        'excited': '兴奋', 'fearful': '恐惧', 'embarrassed': '尴尬',
        'envious': '羡慕', 'disgruntled': '不满', 'depressed': '沮丧',
        'narration-relaxed': '轻松叙述', 'narration-professional': '专业叙述',
        'sports-commentary': '体育解说', 'sports-commentary-excited': '激动体育解说',
        'documentary-narration': '纪录片解说', 'livecommercial': '直播广告',
        'live-commercial': '直播广告', 'chat-casual': '随意聊天',
        'story-telling': '故事讲述', 'story': '故事',
        'voice-assistant': '语音助手', 'comforting': '安慰',
        'debating': '辩论', 'disappointed': '失望', 'shy': '害羞',
        'sorry': '抱歉', 'strict': '严格', 'anxious': '焦虑',
        'curious': '好奇', 'empathetic': '共情', 'encouraging': '鼓励',
        'guilty': '内疚', 'lonely': '孤独', 'surprised': '惊讶',
        'sentimental': '感性', 'tired': '疲惫', 'assassin': '刺客',
        'captain': '队长', 'cavalier': '骑士', 'prince': '王子',
        'game-narrator': '游戏旁白', 'geomancer': '风水师', 'poet': '诗人',
        'complaining': '抱怨', 'cute': '可爱', 'nervous': '紧张',
        'happy': '开心', 'confused': '困惑', 'determined': '坚定',
        'disgusted': '厌恶', 'jealous': '嫉妒', 'joyful': '喜悦',
        'regretful': '后悔', 'relieved': '如释重负', 'shouting': '喊叫',
        'softvoice': '轻柔'
      };
      return styleMap[style] || style;
    }

    function addVoiceOption(group, voice) {
      const option = document.createElement('option');
      option.value = voice.ShortName;
      option.text = voice.LocalName + ' (' + (voice.Gender === 'Female' ? '女' : '男') + ')';
      group.appendChild(option);
    }

    async function loadVoices() {
      try {
        const response = await fetch('/voices');
        if (response.ok) {
          allVoices = await response.json();
          const voiceSelect = document.getElementById('voice');
          voiceSelect.innerHTML = '';

          const voiceGroups = [
            { name: 'MAI 系列', filter: v => v.ShortName.includes('MAI-Voice') },
            { name: 'Dragon HD 系列', filter: v => v.ShortName.includes('Dragon') && !v.ShortName.includes('MAI') },
            { name: '标准系列', filter: v => !v.ShortName.includes('Dragon') && !v.ShortName.includes('MAI') }
          ];

          voiceGroups.forEach(group => {
            const voices = allVoices.filter(group.filter);
            if (voices.length > 0) {
              const optgroup = document.createElement('optgroup');
              optgroup.label = group.name;
              voices.forEach(voice => addVoiceOption(optgroup, voice));
              voiceSelect.appendChild(optgroup);
            }
          });

          if (allVoices.length > 0) {
            voiceSelect.value = allVoices[0].ShortName;
            updateStyleOptions(allVoices[0].ShortName);
          }
          voiceSelect.addEventListener('change', function() { updateStyleOptions(this.value); });
        }
      } catch (error) {
        console.error('加载语音列表失败:', error);
      }
    }

    async function handleTTSSubmit(e) {
      e.preventDefault();
      document.getElementById('apiErrorAlert').style.display = 'none';

      const apiKey = document.getElementById('apiKey').value || localStorage.getItem('tts_api_key') || '';
      const text = document.getElementById('text').value;
      const voice = document.getElementById('voice').value;
      const rate = document.getElementById('rate').value;
      const pitch = document.getElementById('pitch').value;
      const style = document.getElementById('style').value;

      if (!text) {
        document.getElementById('apiErrorTitle').textContent = '错误';
        document.getElementById('apiErrorMessage').textContent = '请输入文本内容';
        document.getElementById('apiErrorAlert').style.display = 'block';
        return;
      }

      try {
        cleanupAudioUrl();

        const response = await fetch('/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey, text: text, voice: voice,
            rate: rate, pitch: pitch, style: style,
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => null);
          throw new Error(errorData?.error?.message || errorData?.message || '请求失败');
        }

        const audioBlob = await response.blob();
        audioUrl = URL.createObjectURL(audioBlob);
        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = audioUrl;
        audioPlayer.play();
        document.getElementById('audioContainer').style.display = 'block';
        document.getElementById('downloadBtn').style.display = 'inline-block';
        document.getElementById('downloadBtn').onclick = function() {
          const a = document.createElement('a');
          a.href = audioUrl;
          a.download = 'tts-audio.mp3';
          a.click();
        };
      } catch (error) {
        document.getElementById('apiErrorTitle').textContent = '请求失败';
        document.getElementById('apiErrorMessage').textContent = error.message;
        document.getElementById('apiErrorAlert').style.display = 'block';
      }
    }

    window.addEventListener('beforeunload', cleanupAudioUrl);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        cleanupAudioUrl();
      }
    });

    document.addEventListener('DOMContentLoaded', function() {
      document.getElementById('voice').addEventListener('change', function() {
        updateStyleOptions(this.value);
      });

      document.getElementById('getReaderLinkBtn').addEventListener('click', function() {
        window.open(generateReaderLink('reader-post.json'), '_blank');
      });

      document.getElementById('getIFreeTimeLinkBtn').addEventListener('click', function() {
        window.open(generateReaderLink('ifreetime.json'), '_blank');
      });

      document.getElementById('ttsForm').addEventListener('submit', handleTTSSubmit);

      document.getElementById('saveApiKey').addEventListener('click', function() {
        const apiKey = document.getElementById('apiKey').value.trim();
        if (apiKey) {
          localStorage.setItem('tts_api_key', apiKey);
          document.getElementById('apiKeyInputGroup').style.display = 'none';
          document.getElementById('saveApiKey').style.display = 'none';
          document.getElementById('savedApiKeyInfo').style.display = 'flex';
        }
      });

      document.getElementById('editApiKey').addEventListener('click', function() {
        document.getElementById('apiKeyInputGroup').style.display = 'flex';
        document.getElementById('saveApiKey').style.display = 'inline-flex';
        document.getElementById('savedApiKeyInfo').style.display = 'none';
      });

      document.getElementById('toggleApiKeyVisibility').addEventListener('click', function() {
        const input = document.getElementById('apiKey');
        input.type = input.type === 'password' ? 'text' : 'password';
      });

      loadVoices();
      const savedApiKey = localStorage.getItem('tts_api_key');
      if (savedApiKey) {
        document.getElementById('apiKey').value = savedApiKey;
        document.getElementById('apiKeyInputGroup').style.display = 'none';
        document.getElementById('saveApiKey').style.display = 'none';
        document.getElementById('savedApiKeyInfo').style.display = 'flex';
      }
    });
  </script>
</body>
</html>`;
}

// ============ 导出 ============

export default {
  async fetch(request, env) {
    if (!isInitialized) {
      try {
        await initialize(env);
      } catch (error) {
        if (error.code === 'INIT_COOLDOWN') {
          return createJsonResponse({ error: 'Service temporarily unavailable' }, 503);
        }
        console.error('❌ 服务初始化失败:', error);
        return createJsonResponse({ error: 'Service initialization failed' }, 500);
      }
    }

    return handleRequest(request, env);
  },

  async scheduled(event, env) {
    if (!env.DB) {
      console.error('⏰ scheduled: env.DB 未绑定，跳过');
      return;
    }
    console.log('⏰ 定时任务触发，重新生成端点表');
    try {
      await generateEndpointTable(env.DB);
    } catch (error) {
      console.error('⏰ scheduled 生成端点表失败:', error);
    }
  }
};
