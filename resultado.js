'use strict';

const $ = id => document.getElementById(id);
const labels = {
  RECEBIDO: ['Na fila', 'Seu plano foi recebido e aguarda processamento.'],
  EM_PROCESSAMENTO: ['Em análise', 'A auditoria está verificando o plano e preparando o relatório.'],
  CONCLUIDO_SEM_ACHADOS: ['Concluída sem achados', 'Nenhum achado nas verificações executadas. Confira a cobertura abaixo.'],
  CONCLUIDO_COM_ACHADOS: ['Concluída com pontos para revisão', 'Veja os itens abaixo e confira as células indicadas no plano.'],
  INCONCLUSIVO: ['Análise parcial', 'Há resultados disponíveis, mas faltam informações para uma conclusão completa.'],
  ERRO_TECNICO: ['Processamento interrompido', 'O envio continua registrado. A equipe precisa conferir a ocorrência antes de retomar.'],
};

let credentials = null, result = null, busy = false, timer = null, generation = 0, attempts = 0;
let correctionBusy = false, pendingCorrections = [];
const selectedCorrections = new Set();
let endpoint = null, correctionEndpoint = null;
try {
  const url = new URL(window.MEDIA_UPLOAD_CONFIG?.statusEndpoint || 'https://agente-de-midia.onrender.com/api/audits/status');
  if (url.protocol === 'https:' && url.hostname === 'agente-de-midia.onrender.com' && url.pathname === '/api/audits/status' && !url.search && !url.hash && !url.username && !url.password) endpoint = url.href;
} catch {}
try {
  const url = new URL(window.MEDIA_UPLOAD_CONFIG?.correctionEndpoint || 'https://agente-de-midia.onrender.com/api/audits/correct');
  if (url.protocol === 'https:' && url.hostname === 'agente-de-midia.onrender.com' && url.pathname === '/api/audits/correct' && !url.search && !url.hash && !url.username && !url.password) correctionEndpoint = url.href;
} catch {}

const idPattern = /^AUD-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const element = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const findingValue = (...values) => { for (const value of values) if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '') return String(value).trim(); return ''; };
function message(text) { $('message').textContent = text; $('message').hidden = !text; }

function parsedFinding(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
function normalizeFinding(raw) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const embedded = parsedFinding(item.registro_original) || parsedFinding(item.detalhe) || parsedFinding(item.descricao);
  const original = parsedFinding(embedded?.registro_original) || embedded;
  if (!original) return item;
  const cleanDetail = findingValue(original.detalhe, original.descricao);
  return { ...item, ...original, detalhe: cleanDetail, descricao: cleanDetail };
}

function summary(meta) {
  const list = $('plan-summary'); list.replaceChildren();
  for (const [key, label] of [['cliente', 'Cliente'], ['campanha', 'Campanha'], ['nome_arquivo', 'Arquivo'], ['versao_plano', 'Versão do plano'], ['revisao_plano', 'Revisão do plano'], ['data_ultima_revisao', 'Última revisão'], ['versao_gabarito', 'Gabarito aplicado']]) {
    const group = document.createElement('div');
    group.append(element('dt', label), element('dd', meta?.[key] || 'Não informado'));
    list.append(group);
  }
}

const formulaNamesPtBr = new Map([
  ['SUMIFS', 'SOMASES'], ['SUMIF', 'SOMASE'], ['SUMPRODUCT', 'SOMARPRODUTO'], ['IFERROR', 'SEERRO'], ['IFNA', 'SENÃO.DISP'],
  ['AVERAGEIFS', 'MÉDIASES'], ['AVERAGEIF', 'MÉDIASE'], ['AVERAGE', 'MÉDIA'], ['COUNTIFS', 'CONT.SES'], ['COUNTIF', 'CONT.SE'],
  ['COUNTBLANK', 'CONTAR.VAZIO'], ['COUNTA', 'CONT.VALORES'], ['COUNT', 'CONT.NÚM'], ['XLOOKUP', 'PROCX'], ['VLOOKUP', 'PROCV'],
  ['HLOOKUP', 'PROCH'], ['INDEX', 'ÍNDICE'], ['MATCH', 'CORRESP'], ['ROUNDUP', 'ARREDONDAR.PARA.CIMA'], ['ROUNDDOWN', 'ARREDONDAR.PARA.BAIXO'],
  ['ROUND', 'ARRED'], ['CONCATENATE', 'CONCATENAR'], ['TEXTJOIN', 'TEXTO.JUNTAR'], ['LEFT', 'ESQUERDA'], ['RIGHT', 'DIREITA'],
  ['MID', 'EXT.TEXTO'], ['LEN', 'NÚM.CARACT'], ['TODAY', 'HOJE'], ['NOW', 'AGORA'], ['IFS', 'SES'], ['IF', 'SE'], ['AND', 'E'], ['OR', 'OU'], ['NOT', 'NÃO'],
]);
const formulaNamesPattern = new RegExp('\\b(' + [...formulaNamesPtBr.keys()].sort((a, b) => b.length - a.length).join('|') + ')\\s*(?=\\()', 'gi');
function formulaPtBr(value) {
  const formula = String(value ?? ''); if (!formula.trim().startsWith('=')) return formula;
  let converted = '', outside = '', quoted = false;
  const convert = part => part.replace(/_xlfn\./gi, '').replace(formulaNamesPattern, name => formulaNamesPtBr.get(name.toUpperCase()) || name).replace(/,/g, ';');
  for (let index = 0; index < formula.length; index++) {
    const char = formula[index];
    if (char === '"') {
      if (quoted) { converted += char; if (formula[index + 1] === '"') { converted += formula[++index]; continue; } quoted = false; }
      else { converted += convert(outside); outside = ''; converted += char; quoted = true; }
      continue;
    }
    if (quoted) converted += char; else outside += char;
  }
  return converted + convert(outside);
}

const financialFields = new Set(['TABELA_TOTAL_BRUTO', 'HONORARIOS', 'DEMAIS_ACRESCIMOS_DESCONTOS', 'VALOR_LIQUIDO', 'VALOR_100', 'INVESTIMENTO']);
const canonicalColumns = new Map([
  ['TOTAL_DE_INSERCOES', 'T'], ['TABELA_UNITARIO', 'U'], ['TABELA_TOTAL_BRUTO', 'V'],
  ['DESCONTO', 'W'], ['NEGOCIADO_UNITARIO', 'X'], ['HONORARIOS', 'Y'],
  ['DEMAIS_ACRESCIMOS_DESCONTOS', 'Z'], ['VALOR_LIQUIDO', 'AA'], ['VALOR_100', 'AB'],
]);
function isFinancial(item) { const field = norm(item.campo_canonico || item.campo), cell = findingValue(item.celula).toUpperCase(); return financialFields.has(field) || /^(V|Y|Z|AA|AB)\d+$/.test(cell); }
function displayValue(item, value) {
  if (!value || !isFinancial(item)) return value || '';
  let normalized = String(value).trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '').replace(',', '.'); else if (normalized.includes(',')) normalized = normalized.replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number) : value;
}

const findingKey = item => [item.id_achado, item.id_regra, item.aba, item.celula, item.tipo_achado || item.tipo].filter(Boolean).join('|').slice(0, 500);
const storageKey = () => result?.id_auditoria ? 'auditoria-decisoes-v1:' + result.id_auditoria : '';
function decisions() { try { const value = JSON.parse(localStorage.getItem(storageKey()) || '[]'); return Array.isArray(value) ? value.slice(0, 200) : []; } catch { return []; } }
function saveDecisions(entries) {
  const keys = new Set(entries.map(entry => entry.key));
  try { localStorage.setItem(storageKey(), JSON.stringify([...entries, ...decisions().filter(item => !keys.has(item.key))].slice(0, 200))); } catch {}
  renderDecisionHistory(); findings();
}
function decisionLabel(item) { return item.decision === 'RECUSADA' ? 'Correção não aplicada' : item.decision === 'DRIVE_ATUALIZADO' ? 'PM atualizado no Drive' : item.decision === 'ORIGINAL_SUBSTITUIDO' ? 'Arquivo original alterado' : 'Cópia corrigida gerada'; }
function renderDecisionHistory() {
  const root = $('decision-history'), section = $('decision-history-section'); if (!root || !section) return;
  const values = decisions(); root.replaceChildren(); section.hidden = !values.length;
  for (const item of values) {
    const entry = element('div', '', 'history-entry');
    entry.append(element('strong', decisionLabel(item)), element('span', [new Date(item.timestamp).toLocaleString('pt-BR'), item.sheet && item.cell ? `${item.sheet} · ${item.cell}` : '', item.outputHash ? `SHA-256: ${item.outputHash}` : ''].filter(Boolean).join(' · ')));
    root.append(entry);
  }
}

function isWarning(item) { return item.bloqueia_aprovacao === false || norm(item.classificacao) === 'AVISO'; }
function isPending(item) { return norm(item.classificacao).includes('PEND') || norm(item.tipo).includes('PEND') || norm(item.id_achado).startsWith('PEND-') || norm(item.acao_permitida).includes('REVISAR_GABARITO'); }
function severityLabel(value) {
  const key = norm(value);
  if (key.startsWith('CRIT')) return 'Crítica'; if (key.startsWith('ALT')) return 'Alta'; if (key.startsWith('MED')) return 'Média'; if (key.startsWith('BAIX')) return 'Baixa'; if (key.startsWith('INFO')) return 'Informativa';
  return value || 'Revisão';
}
function findingTitle(item) {
  const map = { TOTAL_DIVERGENTE: 'Total divergente', FORMULA_TOTAL_INADEQUADA: 'Fórmula do total', FORMULA_INADEQUADA: 'Fórmula inadequada', FORMULA_AUSENTE: 'Fórmula ausente', CAMPO_AUSENTE: 'Campo ausente', VALOR_DIVERGENTE: 'Valor divergente', AVISO_COMPOSICAO_KPI: 'Composição de compras e KPIs', AVISO_ARREDONDAMENTO: 'Diferença de arredondamento', PENDENCIA: 'Validação pendente' };
  return map[item.tipo_achado || item.tipo] || (isWarning(item) ? 'Aviso informativo' : isPending(item) ? 'Validação pendente' : 'Ponto para revisão');
}
function findingHeading(item) {
  const type = item.tipo_achado || item.tipo, field = findingValue(item.campo_canonico, item.campo);
  if ((type === 'FORMULA_TOTAL_INADEQUADA' || type === 'FORMULA_INADEQUADA') && norm(field) === 'INVESTIMENTO') return 'Total AVULSO · Investimento';
  return item.veiculo || field || (isWarning(item) ? 'Aviso informativo' : isPending(item) ? 'Item não concluído' : 'Item para revisão');
}

function formulaCandidate(item) {
  const cell = findingValue(item.celula).replace(/\$/g, '').toUpperCase();
  const row = Number(cell.match(/^[A-Z]{1,3}([1-9]\d*)$/)?.[1] || item.linha || 0);
  let formula = findingValue(item.formula_esperada, item.formula_referencia);
  const totalRule = norm(item.tipo_achado || item.tipo).includes('TOTAL_DIVERGENTE') || /^INT-01(3|6|7|8)$/.test(findingValue(item.id_regra));
  if (formula && row) formula = formula.replace(/\{linha\}/gi, String(row));
  const hasCanonicalNames = /TOTAL_DE_INSERCOES|TABELA_UNITARIO|TABELA_TOTAL_BRUTO/i.test(formula);
  if ((!formula || hasCanonicalNames) && !totalRule && row && /^V\d+$/.test(cell)) {
    const purchase = norm(item.tipo_compra);
    if (/\bCPM\b|\bCPPM\b/.test(purchase)) formula = `=T${row}*U${row}/1000`;
    else if (/\b(CPC|CPE|CPV|CPA|CPL|CPI|CPD|CPVTR|UNITARIO|UNIDADE|DIARIA|PACOTE)\b/.test(purchase)) formula = `=T${row}*U${row}`;
  }
  if (!formula || /\{[^}]+\}|TOTAL_DE_INSERCOES|TABELA_UNITARIO|TABELA_TOTAL_BRUTO/i.test(formula)) return '';
  if (!formula.startsWith('=')) {
    if (!/[A-Z]{1,3}\$?[1-9]\d*|[+\-*/()]|\b(SUM|IF|ROUND|COUNT|AVERAGE)/i.test(formula)) return '';
    formula = '=' + formula;
  }
  return formula;
}
function correctionObject(item) {
  const before = findingValue(item.formula_atual, item.formula_encontrada);
  return { key: findingKey(item), sheet: findingValue(item.aba), cell: findingValue(item.celula).replace(/\$/g, '').toUpperCase(), before, after: formulaCandidate(item), ruleId: findingValue(item.id_regra), wasMissing: !before };
}
function isSafeCorrection(item) {
  const correction = correctionObject(item), authorized = item.pode_corrigir === true || norm(item.pode_corrigir) === 'TRUE';
  return authorized && !!correction.sheet && /^[A-Z]{1,3}[1-9]\d*$/.test(correction.cell) && !!correction.after && !isWarning(item) && !isPending(item);
}
function eligibleCorrections() {
  const recorded = new Set(decisions().map(item => item.key)), unique = new Map();
  for (const item of Array.isArray(result?.detalhes) ? result.detalhes : []) {
    if (!isSafeCorrection(item) || recorded.has(findingKey(item))) continue;
    const correction = correctionObject(item);
    unique.set(`${norm(correction.sheet)}!${correction.cell}`, correction);
  }
  return [...unique.values()];
}

function findingExplanation(item) {
  const found = displayValue(item, findingValue(item.encontrado, item.valor_atual)), expected = displayValue(item, findingValue(item.esperado, item.valor_correto)), detail = findingValue(item.detalhe, item.descricao), parts = [], location = findingLocation(item);
  if (norm(item.tipo_achado || item.tipo).includes('TOTAL_DIVERGENTE') && location.cell !== '—') parts.push(`A divergência está na célula ${location.cell}, coluna ${location.column}, linha ${location.row}.`);
  if (detail) parts.push(detail);
  if (!detail && norm(item.tipo_achado || item.tipo) === 'FORMULA_RESULTADO_INCORRETO') {
    const purchase = norm(item.tipo_compra);
    const rule = /\b(CPM|CPPM)\b/.test(purchase) ? 'inserções × valor unitário ÷ 1.000' : 'inserções × valor unitário';
    parts.push(`Na célula ${location.cell}, o valor final não corresponde ao cálculo de ${rule} previsto para ${findingValue(item.tipo_compra) || 'esse tipo de compra'}. Mesmo quando a fórmula não é obrigatória para o veículo, o valor preenchido precisa fechar com esse cálculo.`);
  }
  if (found || expected) parts.push(`Valor encontrado: ${found || 'não informado'}. Valor esperado: ${expected || 'não informado'}.`);
  if (findingValue(item.veiculo).includes('|')) parts.push('As plataformas listadas mostram a composição do total; não representam um erro separado em cada plataforma.');
  if (isPending(item)) parts.push('Esta pendência indica limite de validação, não um erro confirmado no plano.');
  return parts.join(' ') || 'Confira o item indicado no plano.';
}
function findingLocation(item) {
  const rawCell = findingValue(item.celula).replace(/\$/g, '').toUpperCase();
  const rawColumn = findingValue(item.coluna).toUpperCase();
  const canonical = norm(item.campo_canonico || item.campo || rawColumn).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const row = findingValue(item.linha) || rawCell.match(/(\d+)$/)?.[1] || '—';
  const column = rawCell.match(/^([A-Z]+)\d+$/)?.[1] || (/^[A-Z]{1,3}$/.test(rawColumn) ? rawColumn : '') || canonicalColumns.get(canonical) || '—';
  const cell = rawCell || (column !== '—' && row !== '—' ? `${column}${row}` : '—');
  return { row, column, cell };
}
function findingAction(item) {
  const precise = findingLocation(item), sheet = findingValue(item.aba), expected = displayValue(item, findingValue(item.esperado, item.valor_correto));
  const location = [sheet ? `aba ${sheet}` : 'plano', precise.row !== '—' ? `linha ${precise.row}` : '', precise.column !== '—' ? `coluna ${precise.column}` : '', precise.cell !== '—' ? `célula ${precise.cell}` : ''].filter(Boolean).join(' · ');
  if (isWarning(item)) return item.tipo_achado === 'AVISO_COMPOSICAO_KPI' ? 'Nenhuma correção é necessária. A composição fica registrada apenas como aviso.' : item.tipo_achado === 'AVISO_ARREDONDAMENTO' ? findingValue(item.como_conferir) || 'A diferença de um centavo foi registrada, mas não reprova o plano.' : 'Este item é informativo e não reprova o plano.';
  if (isPending(item)) return 'Complete ou esclareça a informação indicada e execute uma nova auditoria. Não altere o plano apenas com base nesta pendência.';
  if (findingValue(item.como_conferir)) return findingValue(item.como_conferir);
  const formula = formulaCandidate(item);
  if (formula && !findingValue(item.formula_atual, item.formula_encontrada) && norm(item.tipo_achado || item.tipo) === 'FORMULA_RESULTADO_INCORRETO') return `A fórmula não é obrigatória para todos os veículos, mas o valor precisa fechar. Para corrigir automaticamente ${location}, use o cálculo de referência indicado abaixo.`;
  if (formula) return `${findingValue(item.formula_atual, item.formula_encontrada) ? 'Substitua a fórmula atual' : 'Insira a fórmula ausente'} em ${location} pela fórmula indicada abaixo.`;
  return `Confira ${location}.${expected ? ` Resultado esperado: ${expected}.` : ' O resultado esperado não foi informado; confira os dados de origem antes de alterar.'}`;
}
function appendFormulaComparison(card, item) {
  const expected = formulaCandidate(item) || findingValue(item.formula_esperada, item.formula_referencia), current = findingValue(item.formula_atual, item.formula_encontrada);
  const totalRule = norm(item.tipo_achado || item.tipo).includes('TOTAL_DIVERGENTE') || /^INT-01(3|6|7|8)$/.test(findingValue(item.id_regra));
  if (norm(item.tipo_achado || item.tipo) === 'AVISO_ARREDONDAMENTO') return;
  if (totalRule && !expected) return;
  if (!expected && !current && !norm(item.tipo_achado || item.tipo).includes('FORMULA')) return;
  const compare = element('div', '', 'formula-compare'), currentBox = element('div', '', 'formula-box formula-current'), expectedBox = element('div', '', 'formula-box formula-correct');
  currentBox.append(element('span', 'Fórmula atual'), element('code', current ? formulaPtBr(current) : 'Sem fórmula — foi encontrado um valor manual'));
  const referenceLabel = !current && norm(item.tipo_achado || item.tipo) === 'FORMULA_RESULTADO_INCORRETO' ? 'Cálculo de referência' : 'Fórmula correta';
  expectedBox.append(element('span', referenceLabel), element('code', expected ? formulaPtBr(expected) : 'O gabarito não forneceu uma fórmula aplicável'));
  compare.append(currentBox, expectedBox); card.append(compare);
}

function renderBatchControls() {
  const eligible = eligibleCorrections(), validKeys = new Set(eligible.map(item => item.key));
  for (const key of [...selectedCorrections]) if (!validKeys.has(key)) selectedCorrections.delete(key);
  const selected = eligible.filter(item => selectedCorrections.has(item.key));
  $('batch-toolbar').hidden = !eligible.length; $('automatic-count').textContent = String(eligible.length);
  $('selected-count').textContent = `${selected.length} ${selected.length === 1 ? 'selecionada' : 'selecionadas'}`;
  $('apply-selected').disabled = correctionBusy || !selected.length;
  $('select-all-corrections').checked = eligible.length > 0 && selected.length === eligible.length;
  $('select-all-corrections').indeterminate = selected.length > 0 && selected.length < eligible.length;
}

function findings() {
  const list = $('findings'); list.replaceChildren();
  const all = Array.isArray(result?.detalhes) ? result.detalhes : [], query = norm($('search').value), severityFilter = $('severity').value;
  const filtered = all.filter(item => (!severityFilter || norm(item.severidade).startsWith(severityFilter)) && (!query || norm([item.veiculo, item.aba, item.campo, item.campo_canonico, item.id_regra, item.descricao, item.kpi, item.tipo_compra].join(' ')).includes(query)));
  $('detail-count').textContent = `${filtered.length} de ${all.length} itens exibidos${result?.detalhes_truncados ? ' · lista parcial; consulte o Word.' : '.'}`;
  renderBatchControls();
  if (!all.length) { list.append(element('p', result?.finalizado ? 'Nenhum ponto para revisão nesta consulta. Confira a cobertura antes de interpretar o resultado.' : 'Os detalhes aparecerão após o processamento.', 'empty-state')); return; }
  const recordedDecisions = decisions();
  for (const item of filtered) {
    const warning = isWarning(item), pending = isPending(item), severity = severityLabel(item.severidade), severityClass = norm(severity).replace(/[^A-Z]/g, '').toLowerCase();
    const card = element('article', '', `finding-card${warning ? ' finding-card-warning' : ''}${pending ? ' finding-card-pending' : ''}`);
    const top = element('div', '', 'finding-top');
    top.append(element('span', warning ? 'Aviso · não reprova' : pending ? 'Pendência · não é erro confirmado' : `${severity} · ${findingTitle(item)}`, `finding-tag severity-${severityClass}`));
    if (item.id_regra) top.append(element('span', item.id_regra, 'rule-chip'));
    card.append(top, element('h4', findingHeading(item)));
    const { cell, column, row } = findingLocation(item);
    const location = element('div', '', 'location-grid');
    for (const [label, value] of [['Aba', findingValue(item.aba) || '—'], ['Linha', row], ['Coluna', column], ['Célula', cell || '—']]) { const field = element('div'); field.append(element('span', label), element('strong', value)); location.append(field); }
    card.append(location);
    if (item.tipo_compra || item.kpi) card.append(element('p', [item.tipo_compra && `Compra: ${item.tipo_compra}`, item.kpi && `Principal: ${item.kpi}`].filter(Boolean).join(' · '), 'finding-context'));
    appendFormulaComparison(card, item);
    const what = element('div', '', 'finding-explanation'); what.append(element('strong', pending ? 'Por que ficou pendente' : 'O que foi encontrado'), element('p', findingExplanation(item)));
    const how = element('div', '', 'finding-explanation finding-action'); how.append(element('strong', warning ? 'O que fazer' : pending ? 'Como concluir a validação' : 'Como corrigir'), element('p', findingAction(item)));
    card.append(what, how);
    const safe = isSafeCorrection(item), correction = correctionObject(item), recorded = recordedDecisions.find(decision => decision.key === findingKey(item));
    if (safe && !recorded) {
      const controls = element('div', '', 'finding-controls'), selector = element('label', '', 'correction-selector'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selectedCorrections.has(correction.key);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selectedCorrections.add(correction.key); else selectedCorrections.delete(correction.key); renderBatchControls(); });
      selector.append(checkbox, element('span', correction.wasMissing ? 'Selecionar para inserir a fórmula' : 'Selecionar para corrigir a fórmula'));
      const apply = element('button', correction.wasMissing ? 'Inserir esta fórmula no PM' : 'Corrigir esta fórmula no PM', 'secondary'); apply.type = 'button'; apply.addEventListener('click', () => startCorrection([correction]));
      const deny = element('button', 'Não aplicar', 'text-button'); deny.type = 'button'; deny.addEventListener('click', () => denyCorrection(item));
      controls.append(selector, apply, deny); card.append(controls);
    }
    if (recorded) card.append(element('p', `${decisionLabel(recorded)} em ${new Date(recorded.timestamp).toLocaleString('pt-BR')}.`, 'finding-decision'));
    list.append(card);
  }
}

function coverage() {
  const root = $('coverage'), data = result?.resumo || {}; root.replaceChildren();
  root.append(element('p', 'Resumo mensal: ' + (data.mensal?.status || data.mensal?.status_validacao || 'Consulte o relatório.')));
  for (const item of data.mensal?.divergencias || []) root.append(element('p', 'Divergência de valor: ' + (item.descricao || item.motivo || JSON.stringify(item))));
  for (const item of data.mensal?.avisos || []) root.append(element('p', 'Aviso: ' + (item.descricao || item.motivo || JSON.stringify(item))));
  for (const item of data.avisos || []) root.append(element('p', String(item)));
  if (result?.detalhes_disponiveis === false) root.append(element('p', 'Os detalhes não puderam ser carregados agora. Tente atualizar ou consulte o Word.'));
}
function auditCount(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function approvedCount(data) {
  const test = data?.resumo?.teste001 || {}, direct = auditCount(test.qtd_linhas_ok ?? test.linhas_ok); if (direct !== null) return direct;
  const evaluated = auditCount(test.qtd_linhas_avaliadas ?? test.linhas_avaliadas), divergent = auditCount(test.qtd_linhas_divergentes ?? test.linhas_divergentes), inconclusive = auditCount(test.qtd_linhas_inconclusivas ?? test.linhas_inconclusivas);
  return evaluated !== null && divergent !== null && inconclusive !== null ? Math.max(0, evaluated - divergent - inconclusive) : null;
}
function quickSummary(data) {
  const found = auditCount(data.qtd_achados), pending = auditCount(data.qtd_pendencias), status = data.status_auditoria;
  if (status === 'RECEBIDO' || status === 'EM_PROCESSAMENTO') return labels[status][1];
  if (status === 'ERRO_TECNICO') return 'A auditoria foi interrompida. Este resultado não representa aprovação do plano.';
  if (found === null || pending === null) return 'O resumo está incompleto. Atualize a consulta; os totais ainda não estão disponíveis.';
  const pendingText = pending > 0 ? ` Há ${pending} ${pending === 1 ? 'pendência de validação' : 'pendências de validação'} — pendência não é erro confirmado.` : '';
  if (status === 'INCONCLUSIVO') return `Análise parcial: ${found} ${found === 1 ? 'ponto identificado' : 'pontos identificados'}. Veja abaixo o que foi validado e o que ficou pendente.` + pendingText;
  if (found === 0) return 'Nenhum achado nas verificações realizadas. Confira a cobertura abaixo.' + pendingText;
  return `Foram encontrados ${found} ${found === 1 ? 'item para revisar' : 'itens para revisar'}. Cada cartão mostra o local e a correção recomendada.` + pendingText;
}
function render(data) {
  const normalizedDetails = Array.isArray(data.detalhes) ? data.detalhes.map(normalizeFinding) : [];
  result = { ...data, detalhes: normalizedDetails }; data = result; $('access-panel').hidden = true; $('result').hidden = false;
  const label = labels[data.status_auditoria]; $('status-label').textContent = label[0]; $('status-detail').textContent = quickSummary(data); $('result-id').textContent = data.id_auditoria; summary(data.meta);
  const processing = ['RECEBIDO', 'EM_PROCESSAMENTO'].includes(data.status_auditoria), details = Array.isArray(data.detalhes) ? data.detalhes : [], notices = details.filter(isWarning).length, approved = approvedCount(data);
  $('approved-count').textContent = approved ?? (processing ? 'Em apuração' : '—');
  $('finding-count').textContent = auditCount(data.qtd_achados) ?? (processing ? 'Em apuração' : '—');
  $('notice-count').textContent = auditCount(data.qtd_avisos) ?? (processing ? 'Em apuração' : notices);
  $('pending-count').textContent = auditCount(data.qtd_pendencias) ?? (processing ? 'Em apuração' : '—');
  $('download').hidden = !data.documento_disponivel; findings(); coverage(); renderDecisionHistory();
}

function correctionFeedback(text) { $('correction-feedback').textContent = text; $('correction-feedback').hidden = !text; }
function startCorrection(corrections) {
  if (correctionBusy || !Array.isArray(corrections) || !corrections.length) return; pendingCorrections = corrections; $('apply-correction').disabled = false;
  const summary = $('correction-summary'); summary.replaceChildren(element('p', `${corrections.length} ${corrections.length === 1 ? 'correção será aplicada' : 'correções serão aplicadas'} em uma única nova versão do PM.`));
  const list = element('ul', '', 'correction-preview');
  for (const correction of corrections.slice(0, 12)) list.append(element('li', `${correction.sheet}!${correction.cell}: ${correction.before ? formulaPtBr(correction.before) : 'sem fórmula'} → ${formulaPtBr(correction.after)}`));
  if (corrections.length > 12) list.append(element('li', `… e mais ${corrections.length - 12} correções.`));
  summary.append(list); $('correction-panel').hidden = false; correctionFeedback(''); $('correction-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeCorrection(force = false) { if (correctionBusy && !force) return; pendingCorrections = []; $('correction-panel').hidden = true; correctionFeedback(''); }
function denyCorrection(item) { const correction = correctionObject(item); saveDecisions([{ ...correction, decision: 'RECUSADA', timestamp: new Date().toISOString() }]); message('A correção foi marcada como não aplicada. Nenhum arquivo foi alterado.'); }
function correctionError(code) {
  const messages = { AUDITORIA_NAO_ENCONTRADA: 'Auditoria não encontrada ou chave inválida.', ARQUIVO_ORIGINAL_ATUALIZADO: 'O PM no Drive mudou depois da auditoria. Atualize a consulta antes de corrigir.', ARQUIVO_ORIGINAL_INVALIDO: 'O arquivo guardado no Drive não é um XLSX válido.', CORRECAO_INVALIDA: 'Uma das correções não tem aba, célula ou fórmula segura. Nenhuma alteração foi feita.', CORRECAO_DRIVE_NAO_CONFIGURADA: 'A correção direta no Drive ainda não está disponível.', CORRECAO_DEMOROU_DEMAIS: 'A correção demorou mais que o esperado. Confira o Drive antes de tentar novamente.' };
  return messages[code] || 'Não foi possível atualizar o PM no Drive. Nenhum vínculo da auditoria foi alterado.';
}
async function performDriveCorrection() {
  if (correctionBusy || !pendingCorrections.length || !credentials || !correctionEndpoint) return;
  const sample = pendingCorrections.slice(0, 8).map(item => `${item.sheet}!${item.cell}: ${item.before ? formulaPtBr(item.before) : 'sem fórmula'} → ${formulaPtBr(item.after)}`).join('\n');
  const approved = window.confirm(`CONFIRMAÇÃO FINAL\n\nO auditor criará uma nova versão corrigida do PM no Google Drive e preservará o original.\n\n${pendingCorrections.length} ${pendingCorrections.length === 1 ? 'correção selecionada' : 'correções selecionadas'}:\n${sample}${pendingCorrections.length > 8 ? `\n… e mais ${pendingCorrections.length - 8}.` : ''}\n\nDeseja aplicar?`);
  if (!approved) { correctionFeedback('Correção cancelada. Nenhum arquivo foi alterado.'); return; }
  correctionBusy = true; $('apply-correction').disabled = true; $('cancel-correction').disabled = true; renderBatchControls(); correctionFeedback('Conferindo cada célula e salvando uma nova versão rastreável no Drive…');
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 130000), submitted = pendingCorrections.slice();
  try {
    const response = await fetch(correctionEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_auditoria: credentials.id_auditoria, chave_acesso: credentials.chave_acesso, correcoes: submitted }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
    let data = null; try { data = await response.json(); } catch {}
    if (!response.ok || data?.ok !== true) throw Error(data?.error || 'CORRECAO_INDISPONIVEL');
    const timestamp = data.timestamp || new Date().toISOString();
    saveDecisions(submitted.map(correction => ({ ...correction, decision: 'DRIVE_ATUALIZADO', timestamp, inputHash: data.sha256_antes, outputHash: data.sha256_depois, fileName: data.nome_arquivo, driveLink: data.link_drive })));
    for (const correction of submitted) selectedCorrections.delete(correction.key);
    message(`${submitted.length} ${submitted.length === 1 ? 'fórmula atualizada' : 'fórmulas atualizadas'} no Drive. O original foi preservado e o histórico foi gravado no PM.`); closeCorrection(true);
  } catch (error) { correctionFeedback(error?.name === 'AbortError' ? correctionError('CORRECAO_DEMOROU_DEMAIS') : correctionError(error?.message)); }
  finally { clearTimeout(timeout); correctionBusy = false; $('cancel-correction').disabled = false; $('apply-correction').disabled = false; renderBatchControls(); }
}

async function request(download = false) {
  if (!endpoint || !credentials) throw Error('Consulta indisponível.');
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 45000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ ...credentials, baixar: String(download) }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
    if (response.status === 404) throw Error('Auditoria não encontrada ou chave inválida. Confira o e-mail de confirmação.');
    if (!response.ok) throw Error('Consulta temporariamente indisponível. Tente novamente em instantes.');
    const data = await response.json();
    if (data.disponivel !== true || data.id_auditoria !== credentials.id_auditoria || !labels[data.status_auditoria]) throw Error('Resposta inválida. Tente atualizar novamente.');
    return data;
  } finally { clearTimeout(timeout); }
}
function lock(value) { busy = value; for (const id of ['consult', 'refresh', 'download']) $(id).disabled = value; }
async function refresh() {
  if (busy) return; clearTimeout(timer); const currentGeneration = generation; lock(true); message('');
  try { const data = await request(); if (currentGeneration !== generation) return; render(data); if (!data.finalizado && attempts++ < 40) timer = setTimeout(refresh, 15000); }
  catch (error) { if (currentGeneration === generation) message(error.name === 'AbortError' ? 'A consulta demorou mais que o esperado. Tente atualizar.' : error.message); }
  finally { lock(false); }
}

$('access-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  const id = $('audit-id').value.trim(), key = $('access-key').value.trim().toLowerCase();
  if (!idPattern.test(id) || !/^[a-f0-9]{64}$/.test(key)) { message('Confira o identificador e a chave de 64 caracteres recebida por e-mail.'); return; }
  credentials = { id_auditoria: id, chave_acesso: key }; $('access-key').value = ''; generation++; attempts = 0; selectedCorrections.clear(); refresh();
});
$('refresh').addEventListener('click', () => { attempts = 0; refresh(); });
$('search').addEventListener('input', findings);
$('severity').addEventListener('change', findings);
$('select-all-corrections').addEventListener('change', event => { selectedCorrections.clear(); if (event.target.checked) for (const correction of eligibleCorrections()) selectedCorrections.add(correction.key); findings(); });
$('apply-selected').addEventListener('click', () => startCorrection(eligibleCorrections().filter(correction => selectedCorrections.has(correction.key))));
$('apply-correction').addEventListener('click', performDriveCorrection);
$('cancel-correction').addEventListener('click', () => closeCorrection());
$('exit').addEventListener('click', () => {
  generation++; clearTimeout(timer); credentials = null; result = null; selectedCorrections.clear(); closeCorrection(true); $('result').hidden = true; $('access-panel').hidden = false;
  for (const id of ['findings', 'plan-summary', 'coverage', 'decision-history']) $(id).replaceChildren();
  $('decision-history-section').hidden = true; $('access-key').value = ''; message('Consulta encerrada.');
});
$('download').addEventListener('click', async () => {
  if (busy) return; const currentGeneration = generation; lock(true); message('');
  try {
    const data = await request(true); if (currentGeneration !== generation) return; const documentData = data.documento;
    if (!documentData || documentData.mime !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || typeof documentData.base64 !== 'string') throw Error('Documento indisponível. Tente novamente.');
    const raw = atob(documentData.base64), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    if (bytes.length < 100 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw Error('Documento inválido. Fale com a equipe responsável.');
    const url = URL.createObjectURL(new Blob([bytes], { type: documentData.mime })), link = document.createElement('a');
    link.href = url; link.download = 'Auditoria_' + credentials.id_auditoria + '.docx'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); message('Download solicitado. Confira os downloads do navegador.');
  } catch (error) { if (currentGeneration === generation) message(error.name === 'AbortError' ? 'O download demorou mais que o esperado. Tente novamente.' : error.message); }
  finally { lock(false); }
});

const hash = new URLSearchParams(location.hash.slice(1)), id = hash.get('id') || '', key = hash.get('chave') || '';
history.replaceState(null, '', location.pathname + location.search);
if (idPattern.test(id)) $('audit-id').value = id;
if (/^[a-f0-9]{64}$/i.test(key)) { $('access-key').value = key; if (idPattern.test(id)) $('access-form').requestSubmit(); }
window.addEventListener('pagehide', () => { generation++; credentials = null; clearTimeout(timer); });
