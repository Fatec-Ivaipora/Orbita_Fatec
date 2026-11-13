// Leitura de Word (.docx) NO NAVEGADOR para a aba Avaliações do Banco MED (12/11/2026): texto + IMAGENS/GIFs
// na ordem em que aparecem. Fica no navegador porque um Word com GIFs de Libras passa do limite de envio do
// servidor. Numeração automática do Word ("1 - 2 - 3" pelo botão de lista) copiada de src/utils/parseProvaDocx.js
// (escreverNumeracaoAutomatica). Precisa de vendor/jszip e vendor/mammoth carregados antes. Expõe window.LerWord.
(function () {
'use strict';
const FORMATOS_DECIMAIS = new Set(['decimal', 'decimalZero']);

function lerAtributo(xml, tag, atributo) {
    const m = new RegExp(`<w:${tag}\\b[^>]*\\bw:${atributo}="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
}

async function escreverNumeracaoAutomatica(buffer) {
    try {
        const zip = await window.JSZip.loadAsync(buffer);
        const arqDocumento = zip.file('word/document.xml');
        const arqNumeracao = zip.file('word/numbering.xml');
        if (!arqDocumento || !arqNumeracao) return buffer;
        const [documento, numeracao] = await Promise.all([arqDocumento.async('string'), arqNumeracao.async('string')]);
        const estilos = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';

        // abstractNumId -> ilvl -> { formato, inicio }
        const abstratos = {};
        for (const [, id, corpo] of numeracao.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
            abstratos[id] = {};
            for (const [, ilvl, lvl] of corpo.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
                abstratos[id][ilvl] = { formato: lerAtributo(lvl, 'numFmt', 'val'), inicio: parseInt(lerAtributo(lvl, 'start', 'val') || '1', 10) };
            }
        }
        // numId -> { abstrato, reinicios: { ilvl: inicio } }
        const nums = {};
        for (const [, numId, corpo] of numeracao.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
            const reinicios = {};
            for (const [, ilvl, ov] of corpo.matchAll(/<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)) {
                const inicio = lerAtributo(ov, 'startOverride', 'val');
                if (inicio !== null) reinicios[ilvl] = parseInt(inicio, 10);
            }
            nums[numId] = { abstrato: lerAtributo(corpo, 'abstractNumId', 'val'), reinicios };
        }
        // Estilo de parágrafo com numeração própria (ex.: "Lista Numerada")
        const numeracaoDoEstilo = {};
        for (const [, estiloId, corpo] of estilos.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
            const numId = lerAtributo(corpo, 'numId', 'val');
            if (numId) numeracaoDoEstilo[estiloId] = { numId, ilvl: lerAtributo(corpo, 'ilvl', 'val') || '0' };
        }

        const contadores = {}; // abstrato -> ilvl -> último número
        const numIdsVistos = new Set();
        let mudou = false;
        const novoDocumento = documento.replace(/<w:p\b(?!Pr)[^>]*>[\s\S]*?<\/w:p>/g, (paragrafo) => {
            const pPr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragrafo) || [''])[0];
            let numId = lerAtributo(pPr, 'numId', 'val');
            let ilvl = lerAtributo(pPr, 'ilvl', 'val');
            if (!numId) {
                const doEstilo = numeracaoDoEstilo[lerAtributo(pPr, 'pStyle', 'val')];
                if (doEstilo) { numId = doEstilo.numId; ilvl = ilvl || doEstilo.ilvl; }
            }
            ilvl = ilvl || '0';
            const num = nums[numId];
            if (!numId || numId === '0' || !num || !abstratos[num.abstrato]) return paragrafo;
            const nivel = abstratos[num.abstrato][ilvl];
            if (!nivel) return paragrafo;

            const cont = contadores[num.abstrato] = contadores[num.abstrato] || {};
            if (!numIdsVistos.has(numId) && num.reinicios[ilvl] !== undefined) {
                cont[ilvl] = num.reinicios[ilvl] - 1;
            }
            numIdsVistos.add(numId);
            cont[ilvl] = (cont[ilvl] === undefined ? nivel.inicio - 1 : cont[ilvl]) + 1;
            // Subníveis recomeçam quando o nível de cima avança
            for (const k of Object.keys(cont)) if (parseInt(k, 10) > parseInt(ilvl, 10)) delete cont[k];

            if (!FORMATOS_DECIMAIS.has(nivel.formato)) return paragrafo;
            mudou = true;
            const run = `<w:r><w:t xml:space="preserve">${cont[ilvl]} - </w:t></w:r>`;
            return pPr ? paragrafo.replace(pPr, pPr + run) : paragrafo.replace(/^<w:p\b[^>]*>/, (abre) => abre + run);
        });
        if (!mudou) return buffer;
        zip.file('word/document.xml', novoDocumento);
        return await zip.generateAsync({ type: 'arraybuffer' });
    } catch (e) {
        console.warn('[ler-word] numeração automática:', e.message);
        return buffer;
    }
}

// HTML do mammoth -> itens em ordem: texto de cada parágrafo/item de lista e { imagem } de cada <img>.
function itensDoHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const itens = [];
  let nImg = 0;
  const textoProprio = (el) => {
    let t = '';
    el.childNodes.forEach(n => {
      if (n.nodeType === 3) t += n.textContent;
      else if (n.nodeType === 1 && !/^(OL|UL|IMG)$/.test(n.tagName)) t += n.tagName === 'BR' ? ' ' : textoProprio(n);
    });
    return t;
  };
  (function andar(el) {
    el.childNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'P' || n.tagName === 'LI' || /^H[1-6]$/.test(n.tagName)) {
        const t = textoProprio(n).replace(/\s+/g, ' ').trim();
        if (t) itens.push(t);
        n.querySelectorAll(':scope img, :scope > *:not(ol):not(ul) img').forEach(img => { if (img.closest('li,p') === n || img.parentElement === n) itens.push({ imagem: { dataUrl: img.getAttribute('src'), nome: 'imagem-' + (++nImg) } }); });
        n.querySelectorAll(':scope > ol, :scope > ul').forEach(andar);
        return;
      }
      if (n.tagName === 'IMG') { itens.push({ imagem: { dataUrl: n.getAttribute('src'), nome: 'imagem-' + (++nImg) } }); return; }
      andar(n);
    });
  })(doc.body);
  return itens.filter(i => typeof i === 'string' || (i.imagem && /^data:image\//.test(i.imagem.dataUrl || '')));
}

async function ler(file) {
  if (!window.JSZip || !window.mammoth) throw new Error('Leitor de Word não carregou. Recarregue a página.');
  if (!/\.docx$/i.test(file.name)) throw new Error('No navegador só dá pra ler Word .docx (salve o .doc como .docx).');
  const original = await file.arrayBuffer();
  const numerado = await escreverNumeracaoAutomatica(original);
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: numerado });
  return itensDoHtml(html);
}
window.LerWord = { ler, itensDoHtml };
})();
