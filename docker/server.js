import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonD1 } from './d1-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const mod = await import(path.join(__dirname, 'worker.js'));
  return mod.default;
}

function buildRequest(req, body) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const init = {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  };
  const request = new Request(url, init);
  Object.defineProperty(request, 'cf', { value: { colo: 'docker' }, enumerable: false });
  return request;
}

async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

async function main() {
  const worker = await loadWorker();

  const DB = new JsonD1(path.join(__dirname, 'data', 'db.json'));

  const env = {
    DB,
    API_KEY: process.env.API_KEY || '',
    WORKER_NODE_ID: process.env.WORKER_NODE_ID || 'node-a',
    WORKER_SHARED_SECRET: process.env.WORKER_SHARED_SECRET || '',
    REMOTETOKEN: process.env.REMOTETOKEN || ''
  };

  const port = Number(process.env.PORT) || 8787;

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);

      const request = buildRequest(req, body.length ? body : undefined);
      const response = await worker.fetch(request, env);
      await sendResponse(res, response);
    } catch (e) {
      console.error('请求处理异常:', e);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error: ' + e.message }));
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 TTS Worker 监听 0.0.0.0:${port}`);
    console.log(`   DB 文件: ${DB.filePath}`);
    console.log(`   API_KEY: ${env.API_KEY ? '已配置' : '未配置'}`);
  });

  const CRON_INTERVAL = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    console.log('⏰ 定时任务触发');
    try {
      await worker.scheduled({ scheduledTime: Date.now() }, env);
    } catch (e) {
      console.error('scheduled 失败:', e);
    }
  }, CRON_INTERVAL);
}

main().catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});
