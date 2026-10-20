// ============================================================
// Token 获取模块（完全自包含，可复制到任何 Worker）
// 使用方法：
// 1. 在 fetch 函数开头插入：
//    const path = new URL(request.url).pathname;
//    if (path === '/get-token' || path === '/token') {
//      return await handleGetToken(request, env);
//    }
// 2. 将本模块代码粘贴到文件末尾
// 3. 在环境变量中配置 API_KEY
// ============================================================


// ============================================================
// token-worker模块开始
// ============================================================
async function handleGetToken(request, env) {
  // ============ API Key 验证 ============
  const apiKey = request.headers.get('X-API-Key') || 
                 new URL(request.url).searchParams.get('api_key') || 
                 '';
  
  const expectedApiKey = env.API_KEY || '';
  
  if (!expectedApiKey) {
    console.log('⚠️ 未配置 API_KEY，允许所有请求');
  } else if (apiKey !== expectedApiKey) {
    console.warn('❌ API Key 验证失败');
    return new Response(JSON.stringify({
      success: false,
      error: '认证失败'
    }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  console.log('🔑 token服务API Key 验证通过');
  
  // ============ Token 优先级表 ============
  const TOKEN_PRIORITY = [
    { region: 'southeastasia', priority: 1 },
    { region: 'eastus', priority: 2 },
    { region: 'westeurope', priority: 3 },
    { region: 'westus2', priority: 4 },
    { region: 'eastasia', priority: 5 }
  ];
  
  // ============ 工具函数 ============
  
  function uuid() {
    return crypto.randomUUID().replace(/-/g, '')
  }
  
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  function generateUserId() {
    const chars = 'abcdef0123456789';
    let result = '';
    for (let i = 0; i < 16; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  }
  
  function dateFormat() {
    return new Date().toUTCString().replace(/GMT/, '').trim().toLowerCase() + 'gmt';
  }
  
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
      const decoded = atob(padded + padding);
      return JSON.parse(decoded);
    } catch (error) {
      return null;
    }
  }
  
  async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
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
  
  async function sign(urlStr) {
    const url = urlStr.split('://')[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = uuid();
    const formattedDate = dateFormat();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes('oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==');
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);
    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
  }
  
  // ============ 获取动态 token ============
  
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
        
        return { 
          region: actualRegion, 
          token: data.t, 
          expiry: tokenExpiry,
          priority: getPriority(actualRegion)
        };
      }
      return null;
    } catch (error) {
      console.error('获取动态token失败:', error.message);
      return null;
    }
  }
  
  // ============ 刷新 token（前5级直接返回，3次后返回当前token） ============
  
  async function refreshToken() {
    console.log('🔄 开始获取token（前5级优先）');
    
    const MAX_ATTEMPTS = 3;
    let lastToken = null;
    
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tokenData = await getDynamicToken();
      
      if (!tokenData) {
        console.log(`  第${attempt + 1}次: 获取失败`);
        await sleep(1000);
        continue;
      }
      
      lastToken = tokenData;
      
      const priority = tokenData.priority;
      const region = tokenData.region;
      const remainingMs = tokenData.expiry - Date.now();
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.round((remainingMs % 60000) / 1000);
      
      if (priority <= 5) {
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
      
      console.log(`  第${attempt + 1}次: 弃用 ${region}(P${priority})，不在前5级`);
      await sleep(1000);
    }
    
    if (lastToken) {
      const priority = lastToken.priority;
      const region = lastToken.region;
      const remainingMs = lastToken.expiry - Date.now();
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.round((remainingMs % 60000) / 1000);
      
      console.log(`  ⚠️ 3次后返回最后token: ${region}(P${priority}, ${remainingMinutes}分${remainingSeconds}秒)`);
      
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
    
    console.error('❌ 3次尝试后仍无可用token');
    return {
      success: false,
      error: '未获取可用的token',
      message: '无法从本地或远程获取匹配的token',
      timestamp: new Date().toISOString()
    };
  }
  
  // ============ 主逻辑 ============
  
  const result = await refreshToken();
  
  return new Response(JSON.stringify(result), {
    status: result.success ? 200 : 500,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

// ============================================================
// token-worker模块结束
// ============================================================
