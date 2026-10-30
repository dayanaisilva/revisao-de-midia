'use strict';
(function (root) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 180 * 1024 * 1024;

  function fail(message) { throw new Error(message); }
  function u16(view, offset) { return view.getUint16(offset, true); }
  function u32(view, offset) { return view.getUint32(offset, true); }
  function set16(view, offset, value) { view.setUint16(offset, value, true); }
  function set32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
  function concat(parts) {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  function xmlEscape(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function xmlDecode(value) {
    return String(value ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10))).replace(/&amp;/g, '&');
  }
  function attribute(tag, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = tag.match(new RegExp('(?:^|\\s)' + escaped + '\\s*=\\s*(["\\\'])([\\s\\S]*?)\\1', 'i'));
    return match ? xmlDecode(match[2]) : '';
  }
  function normalizeFormula(value) {
    return String(value ?? '').trim().replace(/^=/, '').replace(/\s+/g, '').toUpperCase();
  }
  function normalizePath(value) {
    const parts = [];
    for (const part of String(value).replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  }
  function resolveTarget(base, target) {
    if (target.startsWith('/')) return normalizePath(target.slice(1));
    const directory = base.split('/').slice(0, -1).join('/');
    return normalizePath(directory + '/' + target);
  }
  function relsPath(path) {
    const parts = path.split('/');
    const name = parts.pop();
    return [...parts, '_rels', name + '.rels'].join('/');
  }
  function crcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }
  const CRC_TABLE = crcTable();
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') fail('Este navegador não oferece o recurso necessário para abrir o XLSX. Use uma versão atual do Chrome ou Edge.');
    let stream;
    try { stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
    catch { fail('Não foi possível abrir a compactação do XLSX neste navegador.'); }
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function deflateRaw(bytes) {
    if (!bytes.length) return bytes;
    if (typeof CompressionStream !== 'function') fail('Este navegador não oferece o recurso necessário para salvar o XLSX. Use uma versão atual do Chrome ou Edge.');
    let stream;
    try { stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')); }
    catch { fail('Não foi possível compactar o XLSX neste navegador.'); }
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function findEocd(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= start; i--) if (u32(view, i) === 0x06054b50) return i;
    fail('O arquivo não contém uma estrutura XLSX válida.');
  }
  async function readZip(source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (bytes.length < 22) fail('O arquivo XLSX está vazio ou incompleto.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(bytes);
    if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) fail('Arquivos XLSX divididos em vários volumes não são aceitos.');
    const count = u16(view, eocd + 10);
    const centralOffset = u32(view, eocd + 16);
    const entries = new Map();
    let cursor = centralOffset;
    let expanded = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > bytes.length || u32(view, cursor) !== 0x02014b50) fail('O índice interno do XLSX está corrompido.');
      const flags = u16(view, cursor + 8), method = u16(view, cursor + 10), expectedCrc = u32(view, cursor + 16);
      const compressedSize = u32(view, cursor + 20), uncompressedSize = u32(view, cursor + 24);
      const nameLength = u16(view, cursor + 28), extraLength = u16(view, cursor + 30), commentLength = u16(view, cursor + 32);
      const localOffset = u32(view, cursor + 42);
      if (flags & 1) fail('O XLSX está protegido por senha. Remova a senha antes de corrigir.');
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (localOffset + 30 > bytes.length || u32(view, localOffset) !== 0x04034b50) fail('Uma parte interna do XLSX está corrompida.');
      const localNameLength = u16(view, localOffset + 26), localExtraLength = u16(view, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const packed = bytes.slice(dataOffset, dataOffset + compressedSize);
      let data;
      if (method === 0) data = packed;
      else if (method === 8) data = await inflateRaw(packed);
      else fail('O XLSX usa um método de compactação não aceito.');
      if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) fail('O XLSX falhou na verificação de integridade. Selecione novamente o arquivo original.');
      expanded += data.length;
      if (expanded > MAX_EXPANDED_BYTES) fail('O XLSX é grande demais para uma correção segura no navegador.');
      entries.set(normalizePath(name), data);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }
  async function writeZip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    const timestamp = dosDateTime();
    for (const [name, data] of entries) {
      const method = name.endsWith('/') || !data.length ? 0 : 8;
      const packed = method === 8 ? await deflateRaw(data) : data;
      const fileName = encoder.encode(name), crc = crc32(data);
      const local = new Uint8Array(30 + fileName.length), lv = new DataView(local.buffer);
      set32(lv, 0, 0x04034b50); set16(lv, 4, 20); set16(lv, 6, 0x0800); set16(lv, 8, method);
      set16(lv, 10, timestamp.time); set16(lv, 12, timestamp.date); set32(lv, 14, crc);
      set32(lv, 18, packed.length); set32(lv, 22, data.length); set16(lv, 26, fileName.length); set16(lv, 28, 0);
      local.set(fileName, 30); locals.push(local, packed);
      const central = new Uint8Array(46 + fileName.length), cv = new DataView(central.buffer);
      set32(cv, 0, 0x02014b50); set16(cv, 4, 20); set16(cv, 6, 20); set16(cv, 8, 0x0800); set16(cv, 10, method);
      set16(cv, 12, timestamp.time); set16(cv, 14, timestamp.date); set32(cv, 16, crc);
      set32(cv, 20, packed.length); set32(cv, 24, data.length); set16(cv, 28, fileName.length);
      set16(cv, 30, 0); set16(cv, 32, 0); set16(cv, 34, 0); set16(cv, 36, 0); set32(cv, 38, name.endsWith('/') ? 0x10 : 0); set32(cv, 42, offset);
      central.set(fileName, 46); centrals.push(central);
      offset += local.length + packed.length;
    }
    const centralSize = centrals.reduce((total, part) => total + part.length, 0);
    const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    set32(ev, 0, 0x06054b50); set16(ev, 4, 0); set16(ev, 6, 0); set16(ev, 8, entries.size); set16(ev, 10, entries.size);
    set32(ev, 12, centralSize); set32(ev, 16, offset); set16(ev, 20, 0);
    return concat([...locals, ...centrals, eocd]);
  }
  function text(entries, path) {
    const bytes = entries.get(path);
    if (!bytes) fail('O XLSX não contém a parte obrigatória ' + path + '.');
    return decoder.decode(bytes);
  }
  function putText(entries, path, value) { entries.set(path, encoder.encode(value)); }
  function workbookMap(entries) {
    const workbookPath = 'xl/workbook.xml', relationshipsPath = relsPath(workbookPath);
    const workbook = text(entries, workbookPath), relationships = text(entries, relationshipsPath);
    const relations = new Map();
    for (const match of relationships.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*\/?\s*>/gi)) {
      const id = attribute(match[0], 'Id'), target = attribute(match[0], 'Target'), type = attribute(match[0], 'Type');
      if (id && target) relations.set(id, { target: resolveTarget(workbookPath, target), type });
    }
    const sheets = [];
    for (const match of workbook.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*\/?\s*>/gi)) {
      const id = attribute(match[0], 'r:id') || attribute(match[0], 'id');
      const rel = relations.get(id);
      if (rel) sheets.push({ name: attribute(match[0], 'name'), id, sheetId: Number(attribute(match[0], 'sheetId')) || 0, path: rel.target });
    }
    return { workbookPath, relationshipsPath, workbook, relationships, sheets };
  }
  function findSheet(map, name) {
    const exact = map.sheets.find(sheet => sheet.name === name);
    if (exact) return exact;
    const folded = String(name).trim().toLocaleUpperCase('pt-BR');
    return map.sheets.find(sheet => sheet.name.trim().toLocaleUpperCase('pt-BR') === folded) || null;
  }
  function patchFormula(xml, cell, before, after) {
    const target = String(cell).replace(/\$/g, '').toUpperCase();
    let changed = false, actual = '';
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\/>|<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?c>/gi;
    const result = xml.replace(cellPattern, block => {
      const opening = block.match(/^<((?:[A-Za-z_][\w.-]*:)?c)\b[^>]*>/i)?.[0] || '';
      if (changed || String(attribute(opening, 'r')).replace(/\$/g, '').toUpperCase() !== target) return block;
      const cellTag = opening.match(/^<((?:[A-Za-z_][\w.-]*:)?c)\b/i)?.[1] || 'c';
      const prefix = cellTag.includes(':') ? cellTag.slice(0, cellTag.indexOf(':') + 1) : '';
      const formula = block.match(/<((?:[A-Za-z_][\w.-]*:)?f)\b([^>]*)>([\s\S]*?)<\/\1>/i);
      if (!formula) {
        if (String(before ?? '').trim()) fail('A célula ' + target + ' não contém a fórmula auditada. Nenhuma alteração foi feita.');
        const type = attribute(opening, 't').toLowerCase();
        if (type === 's' || type === 'inlinestr' || /<(?:[A-Za-z_][\w.-]*:)?is\b/i.test(block)) fail('A célula ' + target + ' contém texto e não pode receber fórmula automaticamente.');
        changed = true;
        const formulaXml = '<' + prefix + 'f>' + xmlEscape(String(after).replace(/^=/, '')) + '</' + prefix + 'f>';
        if (/\/>\s*$/i.test(block)) return block.replace(/\/>\s*$/i, '>' + formulaXml + '<' + prefix + 'v></' + prefix + 'v></' + cellTag + '>');
        let updated = block.replace(new RegExp('^<' + cellTag.replace(':', '\\:') + '\\b[^>]*>', 'i'), match => match + formulaXml);
        updated = updated.replace(/<((?:[A-Za-z_][\w.-]*:)?v)\b[^>]*>[\s\S]*?<\/\1>/i, '<' + prefix + 'v></' + prefix + 'v>');
        if (!/<(?:[A-Za-z_][\w.-]*:)?v\b/i.test(updated)) updated = updated.replace(new RegExp('</' + cellTag.replace(':', '\\:') + '>\\s*$', 'i'), '<' + prefix + 'v></' + prefix + 'v></' + cellTag + '>');
        return updated;
      }
      if (/\bt\s*=\s*(["'])shared\1/i.test(formula[2])) fail('A célula ' + target + ' usa uma fórmula compartilhada e exige revisão manual.');
      actual = xmlDecode(formula[3]);
      if (normalizeFormula(actual) !== normalizeFormula(before)) fail('A fórmula de ' + target + ' não corresponde à versão auditada. Nenhuma alteração foi feita.');
      changed = true;
      let updated = block.replace(formula[0], '<' + formula[1] + formula[2] + '>' + xmlEscape(String(after).replace(/^=/, '')) + '</' + formula[1] + '>');
      updated = updated.replace(/<((?:[A-Za-z_][\w.-]*:)?v)\b[^>]*>[\s\S]*?<\/\1>/i, '<' + prefix + 'v></' + prefix + 'v>');
      return updated;
    });
    if (!changed) fail('A célula ' + target + ' não foi encontrada na aba informada. Nenhuma alteração foi feita.');
    return { xml: result, actual };
  }
  function forceRecalculation(workbook) {
    if (/<(?:[A-Za-z_][\w.-]*:)?calcPr\b/i.test(workbook)) return workbook.replace(/<((?:[A-Za-z_][\w.-]*:)?calcPr)\b[^>]*\/?\s*>/i, (match, tag) => {
      const attrs = match.replace(new RegExp('^<' + tag.replace(':', '\\:') + '\\b', 'i'), '').replace(/\/?\s*>$/i, '').replace(/\s+(?:calcMode|fullCalcOnLoad|forceFullCalc)\s*=\s*(["'])[\s\S]*?\1/gi, '');
      return '<' + tag + attrs + ' calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>';
    });
    return workbook.replace(/<\/((?:[A-Za-z_][\w.-]*:)?workbook)>\s*$/i, (match, tag) => {
      const prefix = tag.includes(':') ? tag.slice(0, tag.indexOf(':') + 1) : '';
      return '<' + prefix + 'calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></' + tag + '>';
    });
  }
  function nextWorksheetPath(entries) {
    let max = 0;
    for (const key of entries.keys()) {
      const match = key.match(/^xl\/worksheets\/sheet(\d+)\.xml$/i);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return 'xl/worksheets/sheet' + (max + 1) + '.xml';
  }
  function inlineCell(ref, value) { return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>'; }
  function historyWorksheet(auditId, corrections, inputHash, now) {
    const rows = [];
    corrections.forEach((item, index) => {
      const start = index * 11 + 1;
      const values = [
        ['HISTÓRICO DE ALTERAÇÃO AUTOMÁTICA', ''],
        ['Data e hora', now], ['Auditoria', auditId], ['Decisão', 'APLICADA NO ARQUIVO SELECIONADO'],
        ['Regra', item.ruleId || ''], ['Aba', item.sheet], ['Célula', item.cell],
        ['Fórmula anterior', item.before], ['Fórmula aplicada', item.after], ['SHA-256 do arquivo de entrada', inputHash],
      ];
      values.forEach(([label, value], offset) => {
        const row = start + offset;
        rows.push('<row r="' + row + '">' + inlineCell('A' + row, label) + (value ? inlineCell('B' + row, value) : '') + '</row>');
      });
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="2" width="72" customWidth="1"/></cols><sheetData>' + rows.join('') + '</sheetData><pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  }
  function addHistorySheet(entries, map, auditId, corrections, inputHash, now) {
    let name = 'HISTORICO_AUDITORIA', suffix = 2;
    while (map.sheets.some(sheet => sheet.name.toLocaleUpperCase('pt-BR') === name.toLocaleUpperCase('pt-BR'))) name = 'HISTORICO_AUDITORIA_' + suffix++;
    const path = nextWorksheetPath(entries), maxSheetId = Math.max(0, ...map.sheets.map(sheet => sheet.sheetId));
    const usedRelIds = new Set([...map.relationships.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*\/?\s*>/gi)].map(match => attribute(match[0], 'Id')));
    let relNumber = 1; while (usedRelIds.has('rId' + relNumber)) relNumber++;
    const relId = 'rId' + relNumber;
    const target = path.replace(/^xl\//, '');
    const relRoot = map.relationships.match(/<((?:[A-Za-z_][\w.-]*:)?Relationships)\b/i)?.[1] || 'Relationships';
    const relPrefix = relRoot.includes(':') ? relRoot.slice(0, relRoot.indexOf(':') + 1) : '';
    const relationship = '<' + relPrefix + 'Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="' + xmlEscape(target) + '"/>';
    const relationships = map.relationships.replace(new RegExp('</' + relRoot.replace(':', '\\:') + '>\\s*$', 'i'), relationship + '</' + relRoot + '>');
    const sheetsTag = map.workbook.match(/<((?:[A-Za-z_][\w.-]*:)?sheets)\b/i)?.[1] || 'sheets';
    const workbookPrefix = sheetsTag.includes(':') ? sheetsTag.slice(0, sheetsTag.indexOf(':') + 1) : '';
    const sheet = '<' + workbookPrefix + 'sheet name="' + xmlEscape(name) + '" sheetId="' + (maxSheetId + 1) + '" r:id="' + relId + '"/>';
    const workbook = map.workbook.replace(new RegExp('</' + sheetsTag.replace(':', '\\:') + '>', 'i'), sheet + '</' + sheetsTag + '>');
    let contentTypes = text(entries, '[Content_Types].xml');
    const typesRoot = contentTypes.match(/<((?:[A-Za-z_][\w.-]*:)?Types)\b/i)?.[1] || 'Types';
    const typesPrefix = typesRoot.includes(':') ? typesRoot.slice(0, typesRoot.indexOf(':') + 1) : '';
    contentTypes = contentTypes.replace(new RegExp('</' + typesRoot.replace(':', '\\:') + '>\\s*$', 'i'), '<' + typesPrefix + 'Override PartName="/' + xmlEscape(path) + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></' + typesRoot + '>');
    putText(entries, map.relationshipsPath, relationships);
    putText(entries, map.workbookPath, workbook);
    putText(entries, '[Content_Types].xml', contentTypes);
    putText(entries, path, historyWorksheet(auditId, corrections, inputHash, now));
    return name;
  }
  async function sha256(bytes) {
    if (!root.crypto?.subtle) fail('O navegador não oferece verificação criptográfica do arquivo.');
    const hash = await root.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function officialName(name) {
    const value = String(name || 'plano.xlsx').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160);
    return /\.xlsx$/i.test(value) ? value : value + '.xlsx';
  }
  async function applyCorrections(file, corrections, auditId) {
    if (!file || typeof file.arrayBuffer !== 'function') fail('Selecione o PM original em formato XLSX.');
    if (!/\.xlsx$/i.test(file.name || '')) fail('Selecione um arquivo com extensão .xlsx.');
    if (!file.size || file.size > MAX_FILE_BYTES) fail('O arquivo deve ter entre 1 byte e 50 MB.');
    if (!Array.isArray(corrections) || !corrections.length) fail('Nenhuma correção segura foi selecionada.');
    const input = new Uint8Array(await file.arrayBuffer());
    if (input[0] !== 0x50 || input[1] !== 0x4b || input[2] !== 0x03 || input[3] !== 0x04) fail('O arquivo selecionado não tem a estrutura de um XLSX.');
    const inputHash = await sha256(input);
    const entries = await readZip(input);
    let map = workbookMap(entries);
    const applied = [];
    for (const correction of corrections) {
      const sheet = findSheet(map, correction.sheet);
      if (!sheet) fail('A aba “' + correction.sheet + '” não existe no arquivo selecionado. Nenhuma alteração foi feita.');
      const originalXml = text(entries, sheet.path);
      const patched = patchFormula(originalXml, correction.cell, correction.before, correction.after);
      putText(entries, sheet.path, patched.xml);
      applied.push({ sheet: sheet.name, cell: String(correction.cell).replace(/\$/g, '').toUpperCase(), before: '=' + patched.actual.replace(/^=/, ''), after: '=' + String(correction.after).replace(/^=/, ''), ruleId: correction.ruleId || '' });
    }
    const now = new Date().toISOString();
    const historySheet = addHistorySheet(entries, map, auditId, applied, inputHash, now);
    map = workbookMap(entries);
    putText(entries, map.workbookPath, forceRecalculation(map.workbook));
    const output = await writeZip(entries);
    const outputHash = await sha256(output);
    return {
      blob: new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      // O n8n substitui o conteúdo do arquivo oficial no Drive. Manter o
      // nome evita criar uma segunda versão como se fosse outro PM.
      fileName: officialName(file.name),
      inputHash,
      outputHash,
      historySheet,
      applied,
      timestamp: now,
    };
  }
  root.XlsxFormulaPatcher = Object.freeze({ applyCorrections });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.XlsxFormulaPatcher;
})(typeof globalThis !== 'undefined' ? globalThis : window);
