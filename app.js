'use strict';
const $ = id => document.getElementById(id);
const form = $('upload-form');
const fileInput = $('arquivo');
const driveLinkInput = $('link_drive');
const submit = $('submit-button');
const feedback = $('feedback');
let chosenFile = null;
let sending = false;
let uncertain = false;
let receiptId = '';
let receiptEmail = '';
let pollTimer = null;
let pollGeneration = 0;
let pollAttempts = 0;
let statusBusy = false;
let downloadBusy = false;
let sourceMode = 'upload';
const configuredEndpoint = window.MEDIA_UPLOAD_CONFIG?.endpoint || '';
let endpoint = null;
if (configuredEndpoint) {
  try {
    const url = new URL(configuredEndpoint);
    if (url.protocol === 'https:' && url.hostname === 'agente-de-midia.onrender.com' && url.pathname === '/api/audits' && !url.username && !url.password && !url.search && !url.hash) endpoint = url.href;
  } catch { /* Sem destino válido, nenhum dado é transmitido. */ }
}
if (endpoint) {
  $('setup-notice').hidden = true;
  submit.disabled = false;
  $('submit-label').textContent = 'Enviar para auditoria';
}
function showError(message) {
  feedback.textContent = message;
  feedback.hidden = false;
}
function selectFile(file) {
  if (sending || uncertain) return;
  feedback.hidden = true;
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) {
    showError('Selecione um arquivo Excel no formato .xlsx.');
    fileInput.value = '';
    chosenFile = null;
    $('selected-file').hidden = true;
    return;
  }
  if (file.size === 0) {
    showError('O arquivo está vazio. Confira o plano e selecione-o novamente.');
    fileInput.value = '';
    chosenFile = null;
    $('selected-file').hidden = true;
    return;
  }
  chosenFile = file;
  // A seleção por arrastar é validada aqui, sem depender do input de arquivo.
  fileInput.required = false;
  $('file-name').textContent = file.name;
  $('file-state').textContent = (file.size >= 1024 * 1024 ? (file.size / (1024 * 1024)).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + ' MB' : Math.ceil(file.size / 1024).toLocaleString('pt-BR') + ' KB') + ' · pronto para enviar';
  $('selected-file').hidden = false;
}
function parseGoogleDriveLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname)) return null;
    const fileMatch = url.hostname === 'drive.google.com'
      ? url.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]{10,})/)
      : url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/);
    const openId = url.hostname === 'drive.google.com' && url.pathname === '/open' ? url.searchParams.get('id') : '';
    const id = fileMatch?.[1] || (/^[a-zA-Z0-9_-]{10,}$/.test(openId || '') ? openId : '');
    return id ? { id, url: url.href } : null;
  } catch { return null; }
}
function setSourceMode(mode) {
  if (sending || uncertain) return;
  sourceMode = mode === 'drive_link' ? 'drive_link' : 'upload';
  const usingDrive = sourceMode === 'drive_link';
  $('upload-source').hidden = usingDrive;
  $('drive-source').hidden = !usingDrive;
  fileInput.required = !usingDrive && !chosenFile;
  driveLinkInput.required = usingDrive;
  feedback.hidden = true;
}
for (const control of form.elements.namedItem('origem_plano')) control.addEventListener('change', event => setSourceMode(event.target.value));
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 1) { showError('Envie apenas um plano por solicitação.'); return; }
  selectFile(fileInput.files[0]);
});
const dropzone = $('dropzone');
for (const event of ['dragenter', 'dragover']) dropzone.addEventListener(event, e => { e.preventDefault(); if (!sending && !uncertain) dropzone.classList.add('dragover'); });
for (const event of ['dragleave', 'drop']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
dropzone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length !== 1) { showError('Envie apenas um plano por solicitação.'); return; }
  selectFile(e.dataTransfer.files[0]);
});
$('remove-file').addEventListener('click', () => {
  if (sending || uncertain) return;
  chosenFile = null; fileInput.value = ''; fileInput.required = true;
  $('selected-file').hidden = true; feedback.hidden = true; fileInput.focus();
});
function lockForm(locked) {
  for (const control of form.querySelectorAll('input, textarea, button')) control.disabled = locked;
  submit.disabled = locked || !endpoint;
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (sending || uncertain || !endpoint) return;
  if (!form.reportValidity()) return;
  const driveFile = sourceMode === 'drive_link' ? parseGoogleDriveLink(driveLinkInput.value) : null;
  if (sourceMode === 'upload' && !chosenFile) { showError('Selecione o plano de mídia em .xlsx.'); fileInput.focus(); return; }
  if (sourceMode === 'drive_link' && !driveFile) { showError('Informe um link válido de arquivo do Google Drive ou Google Sheets. Links de pasta não podem ser auditados.'); driveLinkInput.focus(); return; }
  for (const name of ['nome', 'email', 'cliente', 'campanha_projeto', 'data_ultima_revisao', 'versao_plano', 'revisao_plano']) {
    const input = form.elements.namedItem(name);
    if (!input.value.trim()) { showError('Preencha todos os campos obrigatórios.'); input.focus(); return; }
  }
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test($('email').value.trim())) { showError('Informe um único endereço de e-mail válido.'); $('email').focus(); return; }
  sending = true; lockForm(true);
  if (sourceMode === 'upload') {
    let fileHeader;
    try { fileHeader = new Uint8Array(await chosenFile.slice(0, 4).arrayBuffer()); }
    catch { sending=false; lockForm(false); showError('Não foi possível ler o arquivo. Selecione-o novamente.'); return; }
    if (fileHeader[0] !== 0x50 || fileHeader[1] !== 0x4b || fileHeader[2] !== 0x03 || fileHeader[3] !== 0x04) { sending=false; lockForm(false); showError('O arquivo não tem o formato esperado para um XLSX. Abra o plano no Excel e salve-o como .xlsx.'); return; }
  }
  // O payload contém somente os campos do contrato de recepção.
  const payload = new FormData();
  for (const name of ['nome', 'email', 'cliente', 'campanha_projeto', 'parecer', 'observacao', 'data_ultima_revisao', 'versao_plano', 'revisao_plano']) payload.append(name, form.elements.namedItem(name).value.trim());
  payload.append('origem_plano', sourceMode);
  if (sourceMode === 'upload') payload.append('arquivo_plano', chosenFile, chosenFile.name);
  else {
    payload.append('link_drive', driveFile.url);
    payload.append('drive_file_id', driveFile.id);
  }
  const recipient = $('email').value.trim();
  sending = true; lockForm(true); feedback.hidden = true;
  $('submit-label').textContent = 'Enviando plano…';
  if (sourceMode === 'upload') $('file-state').textContent = 'Enviando. Aguarde a confirmação.';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: payload, signal: abort.signal, credentials: 'omit', redirect: 'error' });
    let result;
    try { result = await response.json(); } catch { throw new Error('UNCONFIRMED'); }
    // Falha definitiva só quando o servidor confirma que nada foi registrado.
    if ([400, 413, 422].includes(response.status) && result.recebido === false) {
      showError(response.status === 413 ? 'O arquivo excede o limite aceito pelo envio. Fale com a equipe responsável.' : 'O envio foi recusado. Confira os campos e o arquivo antes de tentar novamente.');
      lockForm(false); $('submit-label').textContent = 'Enviar para auditoria'; return;
    }
    if (!response.ok || result.recebido !== true || result.status_auditoria !== 'RECEBIDO' || !/^AUD-[a-zA-Z0-9-]+$/.test(result.id_auditoria || '')) throw new Error('UNCONFIRMED');
    receiptId = result.id_auditoria;
    receiptEmail = recipient;
    const summary=$('receipt-summary');summary.replaceChildren();
    for(const [key,label] of [['nome_solicitante','Solicitante'],['cliente','Cliente'],['campanha','Campanha'],['nome_arquivo','Arquivo'],['data_ultima_revisao','Última revisão'],['versao_plano','Versão'],['revisao_plano','Revisão']]){
      const group=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
      dt.textContent=label;dd.textContent=result.resumo?.[key]||'Não informado';group.append(dt,dd);summary.append(group);
    }
    $('receipt-link').href='resultado.html#id='+encodeURIComponent(receiptId);
    $('receipt-id').textContent = receiptId;
    $('confirmation-detail').textContent = result.status_email_confirmacao === 'ENVIADO_GMAIL' ? `A confirmação foi enviada para ${recipient}.` : `O registro foi concluído. A confirmação por e-mail está pendente; guarde este identificador.`;
    $('form-panel').hidden = true; $('success-panel').hidden = false; $('success-panel').focus();

  } catch {
    uncertain = true;
    showError('Não conseguimos confirmar o recebimento nesta página. O plano pode ter sido registrado. Confira seu e-mail e fale com a equipe antes de enviar novamente, para evitar duplicidade.');
    $('submit-label').textContent = 'Recebimento não confirmado';
    $('file-state').textContent = 'Aguardando conferência do recebimento.';
    // Não repetir automaticamente: o servidor pode ter gravado antes de a conexão falhar.
  } finally { clearTimeout(timer); sending = false; }
});
$('copy-id').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(receiptId); $('copy-id').textContent = 'Identificador copiado'; }
  catch { $('copy-id').textContent = 'Selecione e copie o identificador acima'; }
});
$('new-submission').addEventListener('click', () => {

  try { sessionStorage.removeItem('sicoob-receipt'); } catch {}
  receiptEmail = '';
  form.reset(); chosenFile = null; fileInput.value = ''; fileInput.required = true;
  driveLinkInput.value = ''; driveLinkInput.required = false; setSourceMode('upload');
  sending = false; uncertain = false; receiptId = '';
  $('selected-file').hidden = true; feedback.hidden = true;
  $('success-panel').hidden = true; $('form-panel').hidden = false;
  $('copy-id').textContent = 'Copiar identificador';
  $('submit-label').textContent = endpoint ? 'Enviar para auditoria' : 'Envio em preparação';
  lockForm(false); $('nome').focus();
});
window.addEventListener('beforeunload', e => { if (sending) { e.preventDefault(); e.returnValue = ''; } });

