import assert from 'node:assert/strict';
import test from 'node:test';
import { routeIntent } from '../lib/intent.mjs';
import { createServer, validateN8nUrl } from '../server.mjs';

test('encaminha pedidos de auditoria ao n8n', () => {
  assert.deepEqual(routeIntent('Pode auditar este plano de mídia?'), { route: 'AUDIT', auditId: null });
});

test('reconhece consulta de resultado pelo identificador', () => {
  assert.deepEqual(routeIntent('Qual o status do AUD-abc-123?'), { route: 'AUDIT_STATUS', auditId: 'AUD-abc-123' });
});

test('mantém perguntas comuns fora do n8n', () => {
  assert.deepEqual(routeIntent('Quanto investimos em Meta ontem?'), { route: 'KNOWLEDGE', auditId: null });
});

test('aceita somente webhooks HTTPS do n8n cloud', () => {
  assert.equal(validateN8nUrl('https://loggiadigital.app.n8n.cloud/webhook/teste').hostname, 'loggiadigital.app.n8n.cloud');
  assert.throws(() => validateN8nUrl('http://example.com/webhook/teste'));
});

test('expõe saúde e capacidades sem transmitir dados', async t => {
  const server = createServer({
    PORT: '0',
    N8N_AUDIT_URL: 'https://loggiadigital.app.n8n.cloud/webhook/receber-plano-midia',
    N8N_STATUS_URL: 'https://loggiadigital.app.n8n.cloud/webhook/consultar-auditoria-sicoob',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  assert.deepEqual(health, { ok: true, service: 'agente-de-midia', audit: true });

  const capabilities = await fetch(`http://127.0.0.1:${port}/api/capabilities`).then(r => r.json());
  assert.equal(capabilities.agent, 'Agente de Mídia');
  assert.equal(capabilities.audit, true);
  assert.equal(capabilities.slack, false);
});
