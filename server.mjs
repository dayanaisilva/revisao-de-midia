import http from 'node:http';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { routeIntent } from './lib/intent.mjs';
import './xlsx-formula-patcher.js';

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
    correctionUrl: validateN8nUrl(env.N8N_CORRECTION_URL),
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

function validateCorrectionPayload(body) {
  const id = typeof body?.id_auditoria === 'string' ? body.id_auditoria.trim() : '';
  const key = typeof body?.chave_acesso === 'string' ? body.chave_acesso.trim().toLowerCase() : '';
  const correction = body?.correcao && typeof body.correcao === 'object' && !Array.isArray(body.correcao) ? body.correcao : {};
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const result = {
    id_auditoria: id,
    chave_acesso: key,
    correcao: {
      sheet: clean(correction.sheet).slice(0, 200),
      cell: clean(correction.cell).replace(/\$/g, '').toUpperCase().slice(0, 30),
      before: clean(correction.before).slice(0, 2000),
      after: clean(correction.after).slice(0, 2000),
      ruleId: clean(correction.ruleId).slice(0, 200),
    },
  };
  if (!/^AUD-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error('CORRECAO_INVALIDA');
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('CORRECAO_INVALIDA');
  if (!result.correcao.sheet || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(result.correcao.cell) || !result.correcao.before || !result.correcao.after) throw new Error('CORRECAO_INVALIDA');
  return result;
}

async function correctionRequest(target, fields, file = null, signal) {
  let body;
  if (file) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    body.set('arquivo', new Blob([file.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), file.name);
  } else {
    body = new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)]));
  }
  const response = await fetch(target, {
    method: 'POST',
    headers: { accept: 'application/json', 'x-agent-source': 'agente-de-midia-render' },
    body,
    redirect: 'manual',
    signal,
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data || data.ok !== true) {
    const error = new Error(data?.error || (response.status === 404 ? 'AUDITORIA_NAO_ENCONTRADA' : 'CORRECAO_INDISPONIVEL'));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function correctDrivePlan(req, res, config) {
  const cors = corsHeaders(req, config);
  if (!config.correctionUrl) return json(res, 503, { ok: false, error: 'CORRECAO_DRIVE_NAO_CONFIGURADA' }, cors);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125000);
  try {
    const input = validateCorrectionPayload(await readJson(req, 96 * 1024));
    const source = await correctionRequest(config.correctionUrl, {
      acao: 'baixar',
      id_auditoria: input.id_auditoria,
      chave_acesso: input.chave_acesso,
    }, null, controller.signal);
    const file = source.arquivo;
    if (!file || file.mime !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || typeof file.base64 !== 'string' || !/\.xlsx$/i.test(file.nome || '')) throw new Error('ARQUIVO_ORIGINAL_INVALIDO');
    const bytes = Buffer.from(file.base64, 'base64');
    if (!bytes.length || bytes.length > 50 * 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error('ARQUIVO_ORIGINAL_INVALIDO');
    const patcher = globalThis.XlsxFormulaPatcher;
    if (!patcher?.applyCorrections) throw new Error('CORRECAO_INDISPONIVEL');
    const sourceFile = { name: file.nome, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const output = await patcher.applyCorrections(sourceFile, [input.correcao], input.id_auditoria);
    if (source.sha256 && output.inputHash !== source.sha256) throw new Error('ARQUIVO_ORIGINAL_ATUALIZADO');
    const outputBytes = Buffer.from(await output.blob.arrayBuffer());
    const saved = await correctionRequest(config.correctionUrl, {
      acao: 'salvar',
      id_auditoria: input.id_auditoria,
      chave_acesso: input.chave_acesso,
      sha256_antes: output.inputHash,
      sha256_depois: output.outputHash,
      correcao_json: JSON.stringify({ ...input.correcao, timestamp: output.timestamp, historySheet: output.historySheet }),
    }, { name: output.fileName, bytes: outputBytes }, controller.signal);
    return json(res, 200, {
      ok: true,
      id_auditoria: input.id_auditoria,
      nome_arquivo: saved.nome_arquivo || output.fileName,
      sha256_antes: output.inputHash,
      sha256_depois: output.outputHash,
      link_drive: saved.link_drive,
      original_preservado: saved.original_preservado !== false,
      aplicado: output.applied,
      timestamp: output.timestamp,
    }, cors);
  } catch (error) {
    const status = error.message === 'CORRECAO_INVALIDA' ? 400 : error.status === 404 || error.message === 'AUDITORIA_NAO_ENCONTRADA' ? 404 : error.message === 'ARQUIVO_ORIGINAL_ATUALIZADO' ? 409 : 502;
    return json(res, status, { ok: false, error: error.name === 'AbortError' ? 'CORRECAO_DEMOROU_DEMAIS' : error.message || 'CORRECAO_INDISPONIVEL' }, cors);
  } finally {
    clearTimeout(timeout);
  }
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
      return json(res, 200, { ok: true, service: 'agente-de-midia', audit: Boolean(config.auditUrl && config.statusUrl), driveCorrection: Boolean(config.correctionUrl) }, cors);
    }

    if (req.method === 'GET' && url.pathname === '/api/capabilities') {
      return json(res, 200, {
        agent: 'Agente de Mídia',
        audit: Boolean(config.auditUrl && config.statusUrl),
        driveCorrection: Boolean(config.correctionUrl),
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

    if (req.method === 'POST' && url.pathname === '/api/audits/correct') {
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.startsWith('application/json')) return json(res, 415, { ok: false, error: 'FORMATO_DE_REQUISICAO_INVALIDO' }, cors);
      return correctDrivePlan(req, res, config);
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
