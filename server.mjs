import http from 'node:http';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { routeIntent } from './lib/intent.mjs';

const DEFAULT_ALLOWED_ORIGINS = ['https://dayanaisilva.github.io'];
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function getConfig(env = process.env) {
  return {
    port: Number(env.PORT || 10000),
    auditUrl: validateN8nUrl(env.N8N_AUDIT_URL),
    statusUrl: validateN8nUrl(env.N8N_STATUS_URL),
    allowedOrigins: csv(env.ALLOWED_ORIGINS).length ? csv(env.ALLOWED_ORIGINS) : DEFAULT_ALLOWED_ORIGINS,
  };
}

function validateN8nUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.n8n.cloud') || !url.pathname.startsWith('/webhook/')) {
    throw new Error('Os destinos do n8n precisam usar HTTPS e um webhook *.n8n.cloud.');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url;
}

function corsHeaders(req, config) {
  const origin = req.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-request-id',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function limitedStream(req, limit = MAX_UPLOAD_BYTES) {
  let received = 0;
  return req.pipe(new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > limit) callback(new Error('PAYLOAD_TOO_LARGE'));
      else callback(null, chunk);
    },
  }));
}

async function proxy(req, res, target, config, options = {}) {
  const cors = corsHeaders(req, config);
  if (!target) return json(res, 503, { ok: false, error: 'INTEGRACAO_N8N_NAO_CONFIGURADA' }, cors);

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) return json(res, 413, { ok: false, error: 'ARQUIVO_MUITO_GRANDE' }, cors);

  const contentType = String(req.headers['content-type'] || '');
  if (options.contentTypes && !options.contentTypes.some(type => contentType.startsWith(type))) {
    return json(res, 415, { ok: false, error: 'FORMATO_DE_REQUISICAO_INVALIDO' }, cors);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125000);

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        accept: req.headers.accept || 'application/json',
        'x-agent-source': 'agente-de-midia-render',
      },
      body: limitedStream(req),
      duplex: 'half',
      redirect: 'manual',
      signal: controller.signal,
    });

    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      ...cors,
    });
    res.end(body);
  } catch (error) {
    const status = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 502;
    json(res, status, {
      ok: false,
      error: status === 413 ? 'ARQUIVO_MUITO_GRANDE' : 'N8N_TEMPORARIAMENTE_INDISPONIVEL',
    }, cors);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer(env = process.env) {
  const config = getConfig(env);

  return http.createServer(async (req, res) => {
    const cors = corsHeaders(req, config);
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'agente-de-midia', audit: Boolean(config.auditUrl && config.statusUrl) }, cors);
    }

    if (req.method === 'GET' && url.pathname === '/api/capabilities') {
      return json(res, 200, {
        agent: 'Agente de Mídia',
        audit: Boolean(config.auditUrl && config.statusUrl),
        knowledge: false,
        campaignData: false,
        slack: false,
      }, cors);
    }

    if (req.method === 'POST' && url.pathname === '/api/route') {
      try {
        const body = await readJson(req);
        return json(res, 200, routeIntent(body.text), cors);
      } catch (error) {
        return json(res, error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { ok: false, error: 'JSON_INVALIDO' }, cors);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/audits') {
      return proxy(req, res, config.auditUrl, config, { contentTypes: ['multipart/form-data'] });
    }

    if (req.method === 'POST' && url.pathname === '/api/audits/status') {
      return proxy(req, res, config.statusUrl, config, { contentTypes: ['application/x-www-form-urlencoded', 'application/json'] });
    }

    return json(res, 404, { ok: false, error: 'ROTA_NAO_ENCONTRADA' }, cors);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = getConfig();
  createServer().listen(config.port, '0.0.0.0', () => {
    console.log(`Agente de Mídia disponível na porta ${config.port}`);
  });
}

export { getConfig, validateN8nUrl };
