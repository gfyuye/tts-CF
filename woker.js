// @ts-nocheck

const encoder = new TextEncoder();

// D1 表名
const TABLES = {
  ENDPOINT_TABLE: 'endpoint_table',
  TOKEN_CACHE: 'token_cache',
  VOICE_LIST: 'voice_list'
};

// 全局变量
let endpointTable = {};
let mergedVoiceListCache = null;
let tokenCache = new Map();
let isInitialized = false;
let initializationPromise = null;
let recentRequesters = new Map(); // 记录最近请求过我们的来源
const BLOCK_DURATION = 60 * 3000; // 阻断3分钟

// Token 优先级
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

// SSML 标签
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

// ============ 工具函数 ============

function uuid() {
  return crypto.randomUUID().replace(/-/g, '')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeSSML(ssml) {
  let placeholders = new Map();
  let processedSSML = ssml;
  let counter = 0;
  for (const tag of preserveTags) {
    processedSSML = processedSSML.replace(tag.pattern, function (match) {
      const placeholder = `__SSML_PLACEHOLDER_${tag.name}_${counter++}__`;
      placeholders.set(placeholder, match);
      return placeholder;
    });
  }
  let escapedContent = escapeBasicXml(processedSSML);
  placeholders.forEach((tag, placeholder) => {
    escapedContent = escapedContent.replace(placeholder, tag);
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
    }
  });
}

// 格式化剩余时间
function formatRemainingTime(expiry) {
  const remainingMs = expiry - Date.now();
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.round((remainingMs % 60000) / 1000);
  return { 
    ms: remainingMs, 
    minutes, 
    seconds, 
    text: `${minutes}分${seconds}秒` 
  };
}

// 创建 JSON 响应
function createJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// 创建音频响应
function createAudioResponse(response, download) {
  if (!download) return response;
  const resp = new Response(response.body, response);
  resp.headers.set('Content-Disposition', `attachment; filename="${uuid()}.mp3"`);
  return resp;
}

// 从远程服务获取 token
async function getTokenFromRemoteService(service) {
  let timeout = null;
  
  try {
    console.log(`尝试远程服务: ${service.marker}`);
    
    // 检查是否最近请求过我们
    const lastRequest = recentRequesters.get(service.marker);
    if (lastRequest && Date.now() - lastRequest < BLOCK_DURATION) {
      console.log(`⏭️ 跳过 ${service.marker}（最近请求过我们）`);
      return null;
    }
    
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(service.url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': service.apiKey,
        'X-Token-Requester': 'tts'
      },
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

// 获取远程服务列表
function getRemoteServices() {
  return [
    {
      url: 'https://url1',
      apiKey: 'apiKey1',
      marker: 'url1'
    },
    {
      url: 'http://url2',
      apiKey: 'apiKey2',
      marker: 'url2'
    }
  ];
}


// ============ D1 操作 ============

// 安全的 D1 查询包装器
async function safeD1Query(DB, table, processFn, errorMessage) {
  try {
    const result = await DB.prepare(`SELECT * FROM ${table}`).all();
    if (result.results && result.results.length > 0) {
      return processFn(result.results);
    }
    return null;
  } catch (error) {
    console.warn(`${errorMessage}:`, error.message);
    return null;
  }
}

async function loadEndpointTableFromD1(DB) {
  return await safeD1Query(
    DB, 
    TABLES.ENDPOINT_TABLE,
    (rows) => {
      const table = {};
      for (const row of rows) {
        table[row.region] = {
          priority: row.priority,
          voices: JSON.parse(row.voices_data)
        };
      }
      return table;
    },
    '从 D1 加载端点表失败'
  );
}

async function saveEndpointTableToD1(DB) {
  try {
    const now = Date.now();
    await DB.prepare(`DELETE FROM ${TABLES.ENDPOINT_TABLE}`).run();
    
    for (const [region, data] of Object.entries(endpointTable)) {
      await DB.prepare(
        `INSERT OR REPLACE INTO ${TABLES.ENDPOINT_TABLE} (region, priority, voices_data, updated_at) VALUES (?, ?, ?, ?)`
      ).bind(region, data.priority, JSON.stringify(data.voices), now).run();
    }
    console.log(`💾 端点表已保存到D1 (${Object.keys(endpointTable).length}个区域)`);
  } catch (error) {
    console.warn('保存端点表到D1失败:', error.message);
  }
}

async function loadTokenCacheFromD1(DB) {
  try {
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

// 保存单个 token 到 D1
async function saveTokenToD1(DB, region, data, now) {
  return await DB.prepare(
    `INSERT OR REPLACE INTO ${TABLES.TOKEN_CACHE} (region, token, expiry, priority, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(region, data.token, data.expiry, data.priority, now).run();
}

async function saveTokenCacheToD1(DB) {
  try {
    const now = Date.now();
    await DB.prepare(`DELETE FROM ${TABLES.TOKEN_CACHE} WHERE expiry < ?`).bind(now).run();
    
    let savedCount = 0;
    
    for (const [region, data] of tokenCache) {
      if (data.expiry > now) {
        await saveTokenToD1(DB, region, data, now);
        savedCount++;
      }
    }
    
    if (savedCount > 0) {
      console.log(`💾 保存${savedCount}个token到D1`);
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
    const now = Date.now();
    await DB.prepare(`DELETE FROM ${TABLES.VOICE_LIST}`).run();
    
    for (const voice of mergedVoiceListCache) {
      await DB.prepare(
        `INSERT OR REPLACE INTO ${TABLES.VOICE_LIST} (voice_name, voice_data, updated_at) VALUES (?, ?, ?)`
      ).bind(voice.ShortName, JSON.stringify(voice), now).run();
    }
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
    const decoded = atob(padded + padding);
    return JSON.parse(decoded);
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
    const response = await fetch(endpointUrl, { method: '', headers: headers });
    
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

// 刷新 token（分阶段获取）
async function refreshToken(DB, voiceName, style) {
  console.log('🔄 开始刷新token');
  // 备用 token 缓存（按优先级编号）
    const backupTokens = new Map(); // priority -> token    
    // ============ 第一轮：3次尝试 ============
    for (let i = 0; i < 3; i++) {
      const tokenData = await getDynamicToken();
      
      if (!tokenData) {
        await sleep(200);
        continue;
      }
      
      const priority = tokenData.priority;
      const region = tokenData.region;      
      const timeInfo = formatRemainingTime(tokenData.expiry);
      //匹配获取的token能否匹配需要的语言与风格
      const isMatch = checkVoiceStyle(region, voiceName, style);
      if (!isMatch) {
        console.log(`❌ 获取token: ${region}(优先级${priority}, 声音或风格与需求不匹配，弃用。)`);
        await sleep(200);
        continue;
      }
      else {
        console.log(`✅ token: ${region}(优先级${priority}, 有效期${timeInfo.text})，语言及风格匹配成功。`);
        return tokenData;
      }       
    }              
    // ============ 失败3次后远程获取（前5级） ============   
    console.log('❌ 无匹配语言及风格的token，从远程获取'); 
// 获取所有远程服务
const remoteServices = getRemoteServices();

for (let index = 0; index < remoteServices.length; index++) {
  const service = remoteServices[index];
  
  console.log(`尝试第 ${index + 1}/${remoteServices.length} 个远程服务`);
  
  const remoteToken = await getTokenFromRemoteService(service);
  
  if (!remoteToken) {
    console.log(`❌ 第${index + 1}个远程服务获取失败`);
    continue;
  }
  
  // ============ 检查语音/风格是否匹配 ============
  const isMatch = checkVoiceStyle(remoteToken.region, voiceName, style);
  
  if (isMatch) {
    const remoteTimeInfo = formatRemainingTime(remoteToken.expiry);
    console.log(`✅ 远程获取匹配token成功: ${remoteToken.region}(优先级${remoteToken.priority}, ${remoteTimeInfo.text})`);
    
    tokenCache.set(remoteToken.region, remoteToken);
    await saveTokenCacheToD1(DB);
    return remoteToken;
  }
  
  // 不匹配，缓存备用
  console.log(`❌ 远程token: ${remoteToken.region}(优先级${remoteToken.priority}, 不匹配，缓存备用)`);
  tokenCache.set(remoteToken.region, remoteToken);
  await saveTokenCacheToD1(DB);
  
  // 继续下一个远程服务
}

console.log('❌ 所有远程服务均无匹配token');
  console.log('❌ 未能获取匹配成功的token');  
  return null;   
}

// 获取最佳 token
let refreshPromise = null;

async function getBestToken(DB, voiceName, style) {
  const now = Date.now();
  const TOKEN_REFRESH_THRESHOLD = 5 * 60 * 1000;

  // 清理过期 token
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
  
  // 检查缓存中是否有可用的 token
  let bestMatch = null; 
  
  for (const [region, data] of tokenCache) {   
    // 匹配请求的语音和风格
    if (checkVoiceStyle(region, voiceName, style)) {    
      // 找到优先级最高的匹配 token
      if (!bestMatch || data.priority < bestMatch.priority) {
        bestMatch = { region, ...data };
      }  
    }
  } 
  
  if (bestMatch) {
    const timeInfo = formatRemainingTime(bestMatch.expiry);
    
    // 首先判断token是否即将过期，如果是则先使用，后台刷新    
    if (bestMatch.expiry < now + TOKEN_REFRESH_THRESHOLD) {
      console.log(`⚠️ Token即将过期(${timeInfo.text})，后台刷新`);
      
      if (!refreshPromise) {
        refreshPromise = refreshToken(DB, voiceName, style)
          .then(newToken => {
            if (newToken) {
              const newTimeInfo = formatRemainingTime(newToken.expiry);
              console.log(`✅ 后台刷新成功: ${newToken.region}(优先级${newToken.priority}, ${newTimeInfo.text})`);
            }
            return newToken;
          })
          .finally(() => { refreshPromise = null; });
      }
    } else {
      console.log(`✅ 使用缓存token: 区域=${bestMatch.region}, 优先级=${bestMatch.priority}, 有效期=${timeInfo.text}`);
    }
    
    return bestMatch;
  }
  
  // 缓存无可用 token
  console.log('📭 无可用token，获取新token');
  // 如果已有刷新在进行，等待同一个 Promise
  if (refreshPromise) {
    console.log('⏳ 刷新已在进行中，等待完成...');
    const newToken = await refreshPromise;    
    // 刷新完成后，重新检查缓存
    if (newToken && newToken.expiry > Date.now()) {
      return newToken;
    }    
    // 刷新失败，继续走正常流程
  }  
  // 创建新的刷新 Promise
  refreshPromise = refreshToken(DB, voiceName, style)
    .finally(() => { refreshPromise = null; });  
  return await refreshPromise;
}

// ============ 端点表生成 ============

async function generateEndpointTable(DB) {
  console.log('🔄 开始生成端点表');
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.26',
    'X-Ms-Useragent': 'SpeechStudio/2021.05.001',
    'Content-Type': 'application/json',
    'Origin': 'https://azure.microsoft.com',
    'Referer': 'https://azure.microsoft.com'
  };
  
  const newEndpointTable = {};
  
  for (const priorityItem of TOKEN_PRIORITY) {
    const region = priorityItem.region;
    const url = `https://${region}.api.speech.microsoft.com/cognitiveservices/voices/list`;
    
    let timeout = null; // 在 try 块外声明
    
    try {
      console.log(`获取 ${region} 的语音列表...`);
      
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeout);
      
      if (!response.ok) {
        console.warn(`${region}: HTTP ${response.status}`);
        continue;
      }
      
      const allVoices = await response.json();
      if (!Array.isArray(allVoices)) continue;
      
      const chineseVoices = allVoices.filter(v => 
        v && v.Locale && v.Locale.startsWith('zh-') && v.ShortName
      );
      
      if (chineseVoices.length > 0) {
        const voicesMap = {};
        for (const voice of chineseVoices) {
          voicesMap[voice.ShortName] = {
            LocalName: voice.LocalName || voice.ShortName,
            Gender: voice.Gender || 'Female',
            Locale: voice.Locale || 'zh-CN',
            StyleList: voice.StyleList || ['general']
          };
        }
        newEndpointTable[region] = { 
          priority: priorityItem.priority, 
          voices: voicesMap 
        };
        console.log(`  ${region}: ${chineseVoices.length}个语音`);
      }
    } catch (error) {
      if (timeout) {
        clearTimeout(timeout);
      }
      console.warn(`  ${region}: ${error.message}`);
    }
    
    await sleep(300);
  }
  
  if (Object.keys(newEndpointTable).length > 0) {
    endpointTable = newEndpointTable;
    await generateMergedVoiceList();
    await saveEndpointTableToD1(DB);
    await saveVoiceListToD1(DB);
    console.log(`✅ 端点表生成完成 (${Object.keys(endpointTable).length}个区域)`);
  }
  
  return endpointTable;
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

// 检查语音和风格是否在端点表中
function checkVoiceStyle(region, voiceName, style) {
  const endpointData = endpointTable[region];
  if (!endpointData) return false;
  
  const voiceData = endpointData.voices[voiceName];
  if (!voiceData) return false;
  
  return voiceData.StyleList.includes(style);
}

// ============ TTS 请求 ============

async function getVoice(DB, text, voiceName, rate, pitch, style, outputFormat, download) {
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
  const ssml = getSsml(text, voiceName, rate, pitch, style);
  
  console.log(`🎵 TTS请求: ${bestToken.region}(优先级${bestToken.priority}，有效期${timeInfo.text}), ${voiceName}, ${style}`);
  
  const response = await fetch(url, { method: '', headers, body: ssml });
  
  if (response.ok) {
    return createAudioResponse(response, download);
  } else {
    if (response.status === 401 || response.status === 403) {
      tokenCache.delete(bestToken.region);
      await saveTokenCacheToD1(DB);
      
      const newToken = await refreshToken(DB, voiceName, style);
      if (newToken) {
        const newTimeInfo = formatRemainingTime(newToken.expiry);
        console.log(`🔄 使用新token重试: ${newToken.region}(优先级${newToken.priority}, ${newTimeInfo.text})`);
        
        const newUrl = `https://${newToken.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
        const newHeaders = { ...headers, 'Authorization': newToken.token };
        const newResponse = await fetch(newUrl, { method: '', headers: newHeaders, body: ssml });
        if (newResponse.ok) {
          return createAudioResponse(newResponse, download);
        }
      }
    }
    
    const errorText = await response.text();
    return new Response(errorText || response.statusText, { status: response.status });
  }
}

// ============ 其他工具函数 ============

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
  const decode = await base64ToBytes('oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==');
  const signData = await hmacSha256(decode, bytesToSign);
  const signBase64 = await bytesToBase64(signData);
  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
  return new Date().toUTCString().replace(/GMT/, '').trim().toLowerCase() + ' gmt';
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, 
    { name: 'HMAC', hash: { name: 'SHA-256' } }, 
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
  const expectedApiKey = env.API_KEY || '';
  return apiKey === expectedApiKey;
}

function getSsml(text, voiceName, rate, pitch, style = 'general') {
  text = escapeSSML(text);
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> <voice name="${voiceName}"> <mstts:express-as style="${style}" styledegree="1.0" role="default"> <prosody rate="${rate}%" pitch="${pitch}%" volume="50">${text}</prosody> </mstts:express-as> </voice> </speak>`;
}

// ============ 初始化（使用初始化 Promise） ============

async function initialize(env) {
  // 如果已初始化，直接返回
  if (isInitialized) return;
  
  // 如果正在初始化，等待同一个 Promise
  if (initializationPromise) {
    console.log('⏳ 初始化进行中，等待完成...');
    return initializationPromise;
  }
  
  console.log('🚀 冷启动，开始初始化...');
  const startTime = Date.now();
  
  // 创建初始化 Promise
  initializationPromise = (async () => {
    try {
      // 并行加载数据以提高速度
      const [d1EndpointTable, d1Tokens, d1Voices] = await Promise.all([
        loadEndpointTableFromD1(env.DB),
        loadTokenCacheFromD1(env.DB),
        loadVoiceListFromD1(env.DB)
      ]);
      
      // 处理端点表
      if (d1EndpointTable && Object.keys(d1EndpointTable).length > 0) {
        endpointTable = d1EndpointTable;
        console.log(`📊 从D1加载端点表: ${Object.keys(endpointTable).length}个端点`);
      } else {
        console.log('📊 D1无端点表，生成新端点表');
        await generateEndpointTable(env.DB);
      }
      
      // 处理 token 缓存
      tokenCache = d1Tokens || new Map();
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
      
      // 处理语音列表
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
      isInitialized = true; // 即使失败也标记为已初始化，避免无限重试
      throw error; // 重新抛出错误
    } finally {
      initializationPromise = null; // 清理 Promise
    }
  })();
  
  return initializationPromise;
}

// ============ 请求处理 ============

async function parseTTSRequest(request) {
  const params = {};
  
  // 辅助函数：清理风格
  function cleanStyle(rawStyle) {
    return (rawStyle || '').replace(/[{}]/g, '').trim();
  }
  
  if (request.method === '') {
    const contentType = request.headers.get('Content-Type') || '';
    const bodyText = await request.text();
    
    console.log(`📥  请求: Content-Type: ${contentType}`);
    
    if (contentType.includes('application/json')) {
      // JSON 格式
      try {
        const data = JSON.parse(bodyText);
        Object.assign(params, {
          apiKey: data.api_key || '',
          text: data.text || data.t || '',
          voiceName: data.voice || data.v || '',
          rate: Number(data.rate || data.r) || 0,
          pitch: Number(data.pitch || data.p) || 0,
          style: cleanStyle(data.style || data.s || 'general'),  // ✅ 清理
          outputFormat: data.outputFormat || data.o || 'audio-24khz-48kbitrate-mono-mp3',
          download: data.download === true || data.d === 'true'
        });
      } catch (error) {
        console.error('  ❌ JSON 解析失败:', error.message);
      }
    } else {
      // 表单格式
      const formData = new URLSearchParams(bodyText);
      
      Object.assign(params, {
        apiKey: formData.get('api_key') || '',
        text: formData.get('t') || formData.get('text') || '',
        voiceName: formData.get('v') || formData.get('voice') || '',
        rate: Number(formData.get('r') || formData.get('rate')) || 0,
        pitch: Number(formData.get('p') || formData.get('pitch')) || 0,
        style: cleanStyle(formData.get('s') || formData.get('style') || 'general'),  // ✅ 清理
        outputFormat: formData.get('o') || 'audio-24khz-48kbitrate-mono-mp3',
        download: formData.get('d') === 'true'
      });
    }
  } else {
    // GET 方式
    const sp = new URL(request.url).searchParams;
    console.log('📥 GET 请求参数:', request.url);
    
    Object.assign(params, {
      apiKey: sp.get('api_key') || '',
      text: sp.get('t') || '',
      voiceName: sp.get('v') || '',
      rate: Number(sp.get('r')) || 0,
      pitch: Number(sp.get('p')) || 0,
      style: cleanStyle(sp.get('s') || 'general'),  // ✅ 清理
      outputFormat: sp.get('o') || 'audio-24khz-48kbitrate-mono-mp3',
      download: sp.get('d') === 'true'
    });
  }
  
  return params;
}

async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const path = requestUrl.pathname;


// 显示边缘节点  
  const colo = request.cf?.colo || 'unknown';
  console.log(`📍 边缘节点: ${colo}, 路径: ${path}`);
// 已知路由列表
  const routes = {
    '/tts': true,
    '/api/v1/tts': true,
    '/voices': true,
    '/api/v1/voices': true,
    '/endpoints': true,
    '/health': true,
    '/reader.json': true,
    '/reader-post.json': true,
    '/ifreetime.json': true,
    '/v1/audio/speech': true,
    '/audio/speech': true,
    '/get-token': true,    
    '/': true
  };

  // 未知路径返回 404
  if (!routes[path]) {
    console.warn(`🚫 未知路径: ${path}`);
    return new Response('Not Found', { status: 404 });
  }

// ============ 语音转换 ============
  if (path === '/tts' || path === '/api/v1/tts') {
    const params = await parseTTSRequest(request);
    
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
// ============ 健康查询 ============
  if (path === '/health') {
    return createJsonResponse({
      status: 'ok',
      endpointCount: Object.keys(endpointTable).length,
      mergedVoiceListSize: mergedVoiceListCache?.length || 0,
      tokenCacheSize: tokenCache.size
    });
  }
// ============ reader.json 路由 ============
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
    if (apiKey) urlParams.push(`api_key=${apiKey}`);

    const url = `${baseUrl}/tts?${urlParams.join('&')}`;

    return createJsonResponse({
      id: Date.now(),
      name: displayName,
      url: url
    });
  }

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
  
  // 构建 body
  const bodyParts = [
    't={{java.encodeURI(speakText)}}',
    `r={{speakSpeed}}`,
    `v=${voice}`,
    `p=${pitch}`,
    `s=${style}`
  ];
  
  if (apiKey) bodyParts.push(`api_key=${apiKey}`);
  
  const body = bodyParts.join('&');
  
  // 构建完整的 url 字段（包含 method 和 body）
  const fullUrl = `${ttsUrl},{\n    "method": "POST",\n    "body": "${body}"\n}`;

  return createJsonResponse({
    id: Date.now(),
    name: displayName,
    url: fullUrl
  });
}

  // ============ ifreetime.json 路由 ============
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
      httpConfigs: {
        useCookies: 1,
        headers: {}
      },
      voiceList: [],
      ttsHandles: [
        {
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
          httpConfigs: {
            useCookies: 1,
            headers: {}
          }
        }
      ]
    };

    return createJsonResponse(response);
  }

  // ============ OpenAI 兼容接口 ============
  if (path === '/v1/audio/speech' || path === '/audio/speech') {
    return await handleOpenAITTS(request, env);
  }
  
    // ============ 获取 Token 路由 ============
  if (path === '/get-token') {
  const requester = request.headers.get('X-Token-Requester') || 'unknown'; //获取访问者的请求头
  recentRequesters.set(requester, Date.now());  // 将请求者标记和时间戳保存到 Map 中
  // 清理过期记录
  for (const [key, timestamp] of recentRequesters) {
    if (Date.now() - timestamp > BLOCK_DURATION) {
      recentRequesters.delete(key);
    }
  }  
  console.log(`📝 远方服务器请求获取 token,请求来源: ${requester}`);

    const apiKey = requestUrl.searchParams.get('api_key') || 
                   request.headers.get('X-API-Key') || '';
    
    const expectedApiKey = env.API_KEY;
    
    // 验证 API Key
    if (apiKey !== expectedApiKey) {
      console.warn('❌ 获取token服务API Key 验证失败');
      return createJsonResponse({ 
        success: false, 
        error: 'Unauthorized: Invalid API key' 
      }, 401);
    }       
    console.log('🔑 token服务API Key 验证通过');    
        // 获取请求参数（语音和风格，可选）
    const voiceName = requestUrl.searchParams.get('v') || 'zh-CN-XiaoxiaoNeural';
    const style = requestUrl.searchParams.get('s') || 'general';
    
    console.log(`🔑 远方服务器请求获取: 语音=${voiceName}, 风格=${style}`);
    
    // 使用 getBestToken 获取最佳 token
    const bestToken = await getBestToken(env.DB, voiceName, style);
    
    if (bestToken) {
      const timeInfo = formatRemainingTime(bestToken.expiry);
      console.log(`🔑 远方服务器请求token成功: 区域=${bestToken.region}, 优先级=${bestToken.priority}, 有效期=${timeInfo.text}`);
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
    
    return createJsonResponse({ 
      success: false, 
      error: 'Failed to get token' 
    }, 500);
  }


  // ============ 默认返回主页 ============
  return new Response(getWebInterface(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============ OpenAI TTS 处理函数 ============
async function handleOpenAITTS(request, env) {
  if (request.method !== 'POST') {
    return createJsonResponse({ error: 'Method not allowed' }, 405);
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return createJsonResponse({ error: 'Unauthorized: Missing or invalid API key' }, 401);
  }

  const apiKey = authHeader.replace('Bearer ', '');
  if (!validateApiKey(apiKey, env)) {
    return createJsonResponse({ error: 'Unauthorized: Invalid API key' }, 401);
  }

  try {
    const requestData = await request.json();

    if (!requestData.input) {
      return createJsonResponse({ error: 'Bad request: Missing input' }, 400);
    }

    const text = requestData.input;
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
      voiceName = voiceMap[requestData.voice] || requestData.voice;
    }

    let rate = 0;
    if (requestData.speed) {
      rate = Math.round((requestData.speed - 1.0) * 100);
      rate = Math.max(-100, Math.min(100, rate));
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
    return createJsonResponse({ error: 'Internal server error: ' + error.message }, 500);
  }
}


// Web 界面（完整版）- 保持原有代码，只优化了部分重复
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
          throw new Error(errorData?.message || '请求失败');
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

// ============ 导出默认对象 ============

export default {
  async fetch(request, env) {
    // 确保初始化（初始化 Promise 防并发）
    if (!isInitialized) {
      try {
        await initialize(env);
      } catch (error) {
        // 初始化失败，返回错误响应
        console.error('❌ 服务初始化失败:', error);
        return createJsonResponse({ error: 'Service initialization failed' }, 500);
      }
    }
    
    return handleRequest(request, env);
  },
  
  async scheduled(event, env) {
    console.log('⏰ 定时任务触发，重新生成端点表');
    await generateEndpointTable(env.DB);
  }
};
