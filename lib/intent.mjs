const AUDIT_WORDS = /\b(audit(?:ar|oria)?|validar|revisar|conferir|bater|reconciliar)\b/i;
const STATUS_WORDS = /\b(status|resultado|andamento|relat[oó]rio)\b/i;
const AUDIT_ID = /\bAUD-[a-zA-Z0-9-]+\b/;

export function routeIntent(text) {
  const input = String(text || '').trim();
  const auditId = input.match(AUDIT_ID)?.[0] || null;

  if (auditId && STATUS_WORDS.test(input)) {
    return { route: 'AUDIT_STATUS', auditId };
  }

  if (AUDIT_WORDS.test(input)) {
    return { route: 'AUDIT', auditId };
  }

  return { route: 'KNOWLEDGE', auditId };
}
