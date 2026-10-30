import assert from 'node:assert/strict';
import test from 'node:test';
import { routeIntent } from '../lib/intent.mjs';
import { createServer, validateCorrectionPayload, validateN8nUrl } from '../server.mjs';

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

test('aceita correções de fórmula em lote, inclusive fórmula ausente', () => {
  const id = 'AUD-8c201e90-9a70-440c-a5c2-b9bae13c0eff';
  const key = 'a'.repeat(64);
  const value = validateCorrectionPayload({
    id_auditoria: id,
    chave_acesso: key,
    correcoes: [
      { sheet: 'INT - JUL', cell: 'V27', before: '=T27*U27', after: '=T27*U27/1000', ruleId: 'INT-003' },
      { sheet: 'INT - JUL', cell: 'V28', before: '', after: '=T28*U28', ruleId: 'INT-004', wasMissing: true },
    ],
  });
  assert.equal(value.correcoes.length, 2);
  assert.equal(value.correcoes[1].wasMissing, true);
});

test('bloqueia célula duplicada e fórmula ausente sem marcação explícita', () => {
  const base = { id_auditoria: 'AUD-8c201e90-9a70-440c-a5c2-b9bae13c0eff', chave_acesso: 'b'.repeat(64) };
  assert.throws(() => validateCorrectionPayload({ ...base, correcoes: [
    { sheet: 'INT - JUL', cell: 'V27', before: '=1', after: '=2' },
    { sheet: 'INT - JUL', cell: 'V27', before: '=2', after: '=3' },
  ] }));
  assert.throws(() => validateCorrectionPayload({ ...base, correcoes: [
    { sheet: 'INT - JUL', cell: 'V28', before: '', after: '=T28*U28' },
  ] }));
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
  assert.deepEqual(health, { ok: true, service: 'agente-de-midia', audit: true, driveCorrection: false });

  const capabilities = await fetch(`http://127.0.0.1:${port}/api/capabilities`).then(r => r.json());
  assert.equal(capabilities.agent, 'Agente de Mídia');
  assert.equal(capabilities.audit, true);
  assert.equal(capabilities.driveCorrection, false);
  assert.equal(capabilities.slack, false);
});
