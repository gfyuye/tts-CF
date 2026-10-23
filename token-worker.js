// ============================================================
// Token 获取模块（独立自包含，可复制到任何 Worker）
//
// 使用方法：
// 1. 在 fetch 函数开头插入：
//    const path = new URL(request.url).pathname;
//    if (path === '/get-token' || path === '/token') {
//      return await handleGetToken(request, env);
//    }
// 2. 将本模块代码粘贴到文件末尾
// 3. 在环境变量中配置 API_KEY
//
// 设计说明：
//   - 仅保留前 5 级优先级（southeastasia/eastus/westeurope/westus2/eastasia）
//   - 后 4 级（westus/centralindia/northeurope/japaneast）不在此模块请求
//     原因：主 worker 若只拿到后 4 级，说明前 5 级不可用，
//           向远方获取同样只有后 4 级，无增量价值
//   - API Key 恒定时间比较
//   - API Key 未配置时拒绝（与主 worker.js 行为一致）
//   - 保留 CORS 与 Cache-Control（其他 Worker 可能需要）
// ============================================================

// ============================================================
// ============================================================
// token-worker模块开始
// ============================================================

// 超时（与主 worker.js 本地直连一致）
const TOKEN_WORKER_DYNAMIC_TIMEOUT_MS = 1000;  // 单次 1s
const TOKEN_WORKER_MAX_ATTEMPTS = 3;            // 最多 3 次

// Token 优先级（仅前 5 级）
const TOKEN_WORKER_PRIORITY = [
  { region: 'southeastasia', priority: 1 },
  { region: 'eastus', priority: 2 },
  { region: 'westeurope', priority: 3 },
  { region: 'westus2', priority: 4 },
  { region: 'eastasia', priority: 5 }
];

const TOKEN_WORKER_TOP_PRIORITY = 5;

function tokenWorkerTimingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleGetToken(request, env) {
  const corsHeaders = { ... };
  // ... CORS、API Key 验证不变 ...

  // ============ 工具函数 ============
  function uuid() { ... }
  function sleep(ms) { ... }
  function generateUserId() { ... }
  function dateFormat() { ... }
  function getPriority(region) { ... }
  function decodeJwtPayload(token) { ... }
  async function hmacSha256(key, data) { ... }
  async function base64ToBytes(base64) { ... }
  async function bytesToBase64(bytes) { ... }

  let _signKeyCache = null;
  async function sign(urlStr) { ... }

  // ============ 获取动态 token（加 1s 超时） ============
  async function getDynamicToken() {
    let timeout = null;
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

      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), TOKEN_WORKER_DYNAMIC_TIMEOUT_MS);

      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: headers,
        signal: controller.signal
      });

      clearTimeout(timeout);
      timeout = null;

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

        return {
          region: actualRegion,
          token: data.t,
          expiry: tokenExpiry,
          priority: getPriority(actualRegion)
        };
      }
      return null;
    } catch (error) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (error.name === 'AbortError') {
        console.error(`获取动态token超时 (${TOKEN_WORKER_DYNAMIC_TIMEOUT_MS}ms)`);
      } else {
        console.error('获取动态token失败:', error.message);
      }
      return null;
    }
  }

  // ============ 刷新 token（3 次，无退避） ============
  async function refreshToken() {
    console.log(`🔄 开始获取token（前${TOKEN_WORKER_TOP_PRIORITY}级优先）`);

    let lastToken = null;

    for (let attempt = 0; attempt < TOKEN_WORKER_MAX_ATTEMPTS; attempt++) {
      const tokenData = await getDynamicToken();

      if (!tokenData) {
        console.log(`  第${attempt + 1}次: 获取失败`);
        continue;
      }

      lastToken = tokenData;

      const priority = tokenData.priority;
      const region = tokenData.region;
      const remainingMs = Math.max(0, tokenData.expiry - Date.now());
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.min(59, Math.floor((remainingMs % 60000) / 1000));

      if (priority <= TOKEN_WORKER_TOP_PRIORITY) {
        console.log(`  ✅ 获取token: ${region}(P${priority}, ${remainingMinutes}分${remainingSeconds}秒)`);
        return {
          success: true,
          region: region,
          token: tokenData.token,
          expiry: tokenData.expiry,
          priority: priority,
          remainingMinutes,
          remainingSeconds
        };
      }

      console.log(`  第${attempt + 1}次: 弃用 ${region}(P${priority})，不在前${TOKEN_WORKER_TOP_PRIORITY}级`);
    }

    if (lastToken) {
      const priority = lastToken.priority;
      const region = lastToken.region;
      const remainingMs = Math.max(0, lastToken.expiry - Date.now());
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.min(59, Math.floor((remainingMs % 60000) / 1000));

      console.log(`  ⚠️ ${TOKEN_WORKER_MAX_ATTEMPTS}次后返回最后token: ${region}(P${priority}, ${remainingMinutes}分${remainingSeconds}秒)`);

      return {
        success: true,
        region: region,
        token: lastToken.token,
        expiry: lastToken.expiry,
        priority: priority,
        remainingMinutes,
        remainingSeconds
      };
    }

    console.error(`❌ ${TOKEN_WORKER_MAX_ATTEMPTS}次尝试后仍无可用token`);
    return {
      success: false,
      error: '未获取可用的token',
      message: '无法从微软接口获取 token',
      timestamp: new Date().toISOString()
    };
  }

  // ============ 主逻辑 ============
  const result = await refreshToken();

  return new Response(JSON.stringify(result), {
    status: result.success ? 200 : 500,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ============================================================
// token-worker模块结束
// ============================================================
