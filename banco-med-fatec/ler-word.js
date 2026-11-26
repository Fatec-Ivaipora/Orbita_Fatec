// Leitura de Word (.docx) NO NAVEGADOR para a aba Avaliações do Banco MED (12/11/2026): texto + IMAGENS/GIFs
// na ordem em que aparecem. Fica no navegador porque um Word com GIFs de Libras passa do limite de envio do
// servidor. Numeração automática do Word ("1 - 2 - 3" pelo botão de lista) copiada de src/utils/parseProvaDocx.js
// (escreverNumeracaoAutomatica). Precisa de vendor/jszip e vendor/mammoth carregados antes. Expõe window.LerWord.
(function () {
'use strict';
const FORMATOS_DECIMAIS = new Set(['decimal', 'decimalZero']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function lerAtributo(xml, tag, atributo) {
    const m = new RegExp(`<w:${tag}\\b[^>]*\\bw:${atributo}="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
}

function paraRomano(n, minusculo) {
    const tab = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let r = ''; for (const [v, s] of tab) while (n >= v) { r += s; n -= v; }
    return minusculo ? r.toLowerCase() : r;
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

            // afirmativas I, II, III, IV em lista automática romana (16/11/2026): sem escrever o número, "Apenas I e II" perde o sentido
            const romano = /^(upper|lower)Roman$/.test(nivel.formato || '');
            if (!FORMATOS_DECIMAIS.has(nivel.formato) && !romano) return paragrafo;
            mudou = true;
            const rotulo = romano ? `${paraRomano(cont[ilvl], nivel.formato === 'lowerRoman')}. ` : `${cont[ilvl]} - `;
            const run = `<w:r><w:t xml:space="preserve">${rotulo}</w:t></w:r>`;
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
  const original = await sombreamentoComoMarcaTexto(await file.arrayBuffer());
  const numerado = await escreverNumeracaoAutomatica(original);
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: numerado });
  return itensDoHtml(html);
}
// ---------------------------------------------------------------------------------------------------------
// MODELO DE PROVA DA MEDICINA (13/11/2026) — o padrão do arquivo "Avaliação 2º Bimestre - 2026-1":
//   Questão 01                                   (início)
//   TBL Disciplina – Tema – Dificuldade          (linha de título)
//   Enunciado                                    (rótulo) → imagem(ns) + caso + pergunta
//   alternativas (com ou sem "A." / "A)")        → a CORRETA vem com MARCA-TEXTO AMARELO
//   Feedback da Questão                          (rótulo) → feedback geral (mantém negrito/listas)
//   Referência Bibliográfica                     (rótulo) → referência
// Questão sem amarelo fica sem gabarito (a pessoa marca na prévia) — nunca supor "a primeira é a certa".
// ---------------------------------------------------------------------------------------------------------
const RE_INICIO = /^quest(?:ã|a)o\s*(\d{1,3})\b/i;
const RE_ENUN = /^enunciado\s*:?$/i;
const RE_FEED = /^(feedback|justificativa|coment[áa]rio)(\s+d[ao]\s+quest[ãa]o)?\s*:?$/i;
const RE_REF = /^refer[êe]ncias?(\s+bibliogr[áa]ficas?)?\s*:?$/i;
const RE_LETRA = /^\s*\(?([A-Ea-e])\s*[).\-–]\s+/;
const DIFIC = [[/f[áa]cil/i, 'facil'], [/intermedi[áa]ria/i, 'intermediaria'], [/dif[íi]cil/i, 'dificil'], [/m[ée]dia/i, 'media']];
// Erros comuns dos professores no modelo (23/11/2026 — Saúde Mental, 12 questões do ENAMED não carregavam):
// o texto na MESMA linha do rótulo ("Enunciado: (ENAMED 2025-77) Uma equipe…", "Feedback da Questão: A questão…",
// "Referência Bibliográfica: BRASIL…") e rótulo sobrando colado ("Objetivo:Enunciado: …"). O arquivo inteiro deixava
// de ser reconhecido como modelo e caía no leitor genérico. Agora o rótulo abre a seção e o resto da linha vira o
// 1º parágrafo dela. "Gabarito: B" numa linha à parte vale como correta quando nenhuma alternativa está pintada.
const ROTULOS_INLINE = [
  ['enun', /^(?:(?:objetivo|unidade|prova)\s*:\s*)*enunciado\s*[:\-–]\s*(?=\S)/i],
  ['feedback', /^(?:feedback|justificativa|coment[áa]rio)(?:\s+d[ao]\s+quest[ãa]o)?\s*[:\-–]\s*(?=\S)/i],
  ['ref', /^refer[êe]ncias?(?:\s+bibliogr[áa]ficas?)?\s*[:\-–]\s*(?=\S)/i]
];
const RE_GABARITO = /^(?:gabarito|resposta(?:\s+correta)?|alternativa\s+correta)\s*[:\-–]?\s*\(?([A-Ea-e])\)?\s*[.)]?\s*$/i;
const RE_ROTULO_SOBRANDO = /^(?:(?:objetivo|unidade|prova)\s*:\s*)+(?=enunciado\b)/i;
// tira o rótulo do começo do html, mesmo dentro de <strong>/<em> ("<strong>Enunciado:</strong> texto").
// Cada tag vira um marcador (caractere de uso privado) para contar só as letras do rótulo.
const MARCA_TAG = '';
function htmlSemRotulo(html, re) {
  const tags = [];
  const plano = html.replace(/<[^>]+>/g, (t) => { tags.push(t); return MARCA_TAG; });
  const m = re.exec(plano.split(MARCA_TAG).join(''));
  if (!m) return html;
  let tirar = m[0].length, out = '', k = 0;
  for (const c of plano) {
    if (c === MARCA_TAG) { out += tags[k++]; continue; }
    if (tirar > 0) { tirar--; continue; }
    out += c;
  }
  return out.replace(/<(strong|b|em|i|u)>\s*<\/\1>/g, '').trim();
}
function separarRotulo(b) {
  for (const [sec, re] of ROTULOS_INLINE) {
    const m = re.exec(b.texto);
    if (!m) continue;
    const texto = b.texto.slice(m[0].length).trim();
    return { sec, resto: { ...b, texto, html: htmlSemRotulo(b.html, re) || texto } };
  }
  return null;
}

function blocosDoHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocos = [];
  const add = (orig) => {
    // item de lista com outra lista dentro (16/11/2026 — ex.: afirmativas I–IV e as alternativas numa sublista):
    // o item vale só pelo texto dele; cada item da sublista vira um bloco à parte (addLista)
    const el = orig.tagName === 'LI' ? orig.cloneNode(true) : orig;
    if (orig.tagName === 'LI') el.querySelectorAll('ol, ul').forEach(x => x.remove());
    const imgs = [...el.querySelectorAll('img')].map(i => i.getAttribute('src')).filter(src => /^data:image\//.test(src || ''));
    const marcado = !!el.querySelector('mark');
    const limpo = el.cloneNode(true);
    limpo.querySelectorAll('img').forEach(i => i.remove());
    limpo.querySelectorAll('mark').forEach(m => m.replaceWith(...m.childNodes));
    const texto = limpo.textContent.replace(/\s+/g, ' ').trim();
    if (orig.tagName === 'LI' && !texto && !imgs.length) return;
    blocos.push({ texto, html: limpo.innerHTML.trim(), imgs, marcado, tag: orig.tagName });
  };
  const addLista = (lista) => lista.querySelectorAll(':scope > li').forEach(li => {
    add(li);
    li.querySelectorAll(':scope > ol, :scope > ul').forEach(addLista);
  });
  [...doc.body.children].forEach(el => {
    if (el.tagName === 'OL' || el.tagName === 'UL') addLista(el);
    else if (el.tagName === 'TABLE') el.querySelectorAll('tr').forEach(add);
    else add(el);
  });
  return blocos;
}

function lerModeloDeBlocos(blocos) {
  const qs = [];
  let q = null, sec = null;
  for (const b of blocos) {
    const m = RE_INICIO.exec(b.texto);
    if (m && b.texto.length < 30) { q = { numero: Number(m[1]), titulo: '', enun: [], feedback: [], ref: [], ajustes: new Set() }; qs.push(q); sec = 'titulo'; continue; }
    if (!q) continue;
    if (RE_ROTULO_SOBRANDO.test(b.texto) && RE_ENUN.test(b.texto.replace(RE_ROTULO_SOBRANDO, ''))) { q.ajustes.add('rótulo sobrando antes do "Enunciado"'); sec = 'enun'; continue; }
    const mG = RE_GABARITO.exec(b.texto);
    if (mG) { q.gabaritoWord = mG[1].toUpperCase(); continue; }
    const inline = separarRotulo(b);
    if (inline) {
      q.ajustes.add(RE_ROTULO_SOBRANDO.test(b.texto) ? 'rótulo sobrando antes do "Enunciado"' : 'texto na mesma linha do rótulo');
      sec = inline.sec;
      if (sec === 'ref') q.ref.push(inline.resto.texto);
      else q[sec].push(inline.resto);
      continue;
    }
    if (RE_ENUN.test(b.texto)) { sec = 'enun'; continue; }
    if (RE_FEED.test(b.texto)) { sec = 'feedback'; continue; }
    if (RE_REF.test(b.texto)) { sec = 'ref'; continue; }
    const mU = /^unidade\s*:?\s*(.+)$/i.exec(b.texto), mO = /^objetivo\s*:?\s*(.+)$/i.exec(b.texto), mP = /^prova\s*:\s*(.+)$/i.exec(b.texto);
    if ((sec === 'titulo' || sec === 'enun') && mP && b.texto.length < 80) { q.provaWord = mP[1].trim(); continue; }
    if ((sec === 'titulo' || sec === 'enun') && mU && b.texto.length < 200) { q.unidadeWord = mU[1].trim(); continue; }
    if ((sec === 'titulo' || sec === 'enun') && mO && b.texto.length < 600) { q.objetivoWord = mO[1].trim(); continue; }
    if (sec === 'titulo') { if (b.texto) { if (!q.titulo) q.titulo = b.texto; else q.enun.push(b); } continue; }
    if (sec === 'enun') { if (b.texto || b.imgs.length) q.enun.push(b); continue; }
    if (sec === 'feedback') { if (b.texto || b.imgs.length) q.feedback.push(b); continue; }
    if (sec === 'ref') { if (b.texto) q.ref.push(b.texto); }
  }
  const lidas = qs.map(q => {
    const imagens = q.enun.flatMap(b => b.imgs).map((dataUrl, i) => ({ dataUrl, nome: `questao-${q.numero}-${i + 1}` }));
    const linhas = q.enun.filter(b => b.texto);
    // alternativas escritas com letra ("A) …", "B) …") no fim: a pergunta é o parágrafo logo antes delas (17/11/2026).
    // Antes procurava a pergunta pela palavra "qual" e achava "na qual" dentro da alternativa C ("Hipersensibilidade
    // do tipo III, na qual…"): a questão ficava com 1 alternativa e sumia da prévia (Milene, questões 4 a 6).
    let ip = -1;
    let k = linhas.length;
    while (k > 0 && RE_LETRA.test(linhas[k - 1].texto)) k--;
    if (linhas.length - k >= 2 && k > 0) ip = k - 1;
    // sem letras: último parágrafo que pergunta (?, :, assinale/marque/indique…); as alternativas vêm depois dele
    for (let i = linhas.length - 2; ip < 0 && i >= 0; i--) {
      if (RE_LETRA.test(linhas[i].texto)) continue;
      if (/[?:]\s*$/.test(linhas[i].texto) || /\b(assinale|marque|indique|aponte|qual|quais)\b/i.test(linhas[i].texto)) { ip = i; break; }
    }
    if (ip < 0) ip = Math.max(0, linhas.length - 5);
    let alts = linhas.slice(ip + 1);
    if (alts.length > 5) { alts = alts.slice(-5); }
    const antes = linhas.slice(0, ip + 1);
    let pergunta = antes.length ? antes[antes.length - 1].texto : '';
    let caso = antes.slice(0, -1).map(b => `<p>${b.html}</p>`).join('');
    // pergunta no fim do parágrafo do caso, sem linha própria (24/11/2026, Saúde Mental Q33): "…ruídos aumentados.
    // Considerando a hipótese, qual é a conduta?" — a última frase que termina em ? ou : vira a pergunta.
    if (antes.length === 1 && !caso) {
      const mPerg = /^([\s\S]{40,}?[.!])\s+([^.!?]{10,}[?:])\s*$/.exec(pergunta);
      if (mPerg) {
        caso = `<p>${esc(mPerg[1].trim())}</p>`;
        pergunta = mPerg[2].trim();
        q.ajustes.add('pergunta separada do caso clínico');
      }
    }
    let icorreta = alts.findIndex(a => a.marcado);
    if (icorreta < 0 && q.gabaritoWord && 'ABCDE'.indexOf(q.gabaritoWord) < alts.length) { icorreta = 'ABCDE'.indexOf(q.gabaritoWord); q.ajustes.add('correta pela linha "Gabarito:"'); }
    const partes = String(q.titulo || '').split(/\s+[–—-]\s+/).map(x => x.trim()).filter(Boolean);
    let dificuldade = 'media';
    const ehDific = (p) => DIFIC.some(([re]) => re.test(p)) && p.split(' ').length <= 2;
    partes.filter(ehDific).forEach(p => DIFIC.forEach(([re, v]) => { if (re.test(p)) dificuldade = v; }));
    // tira semestre (2026.2), professor (Prof./Profa.) e dificuldade; sobra disciplina e tema
    const resto = partes.filter(p => !/^\d{4}[.\/-][12]$/.test(p) && !/^prof(a|\.|essor|essora)?\b/i.test(p) && !ehDific(p));
    const tema = resto.length >= 2 ? resto.slice(1).join(' – ') : (resto[0] || '');
    return {
      numero: q.numero, tituloOriginal: q.titulo, tema, dificuldade,
      casoHtml: caso, pergunta,
      enunciado: [antes.map(b => b.texto).join('\n')].join(''),
      alternativas: alts.map(a => a.texto.replace(RE_LETRA, '').replace(/^\t+/, '').trim()),
      gabarito: icorreta >= 0 ? 'ABCDE'[icorreta] : null,
      imagens,
      justificativa: q.feedback.filter(b => b.texto).map(b => b.tag === 'LI' ? `<p>• ${b.html}</p>` : `<p>${b.html}</p>`).join(''),
      imagensFeedback: q.feedback.flatMap(b => b.imgs).map((dataUrl, i) => ({ dataUrl, nome: `feedback-${q.numero}-${i + 1}` })),
      unidadeWord: q.unidadeWord || '', objetivoWord: q.objetivoWord || '', provaWord: q.provaWord || '',
      fonte: q.ref.join(' '),
      ajustes: [...q.ajustes]
    };
  });
  // questão que não deu pra ler direito continua na prévia, com o problema escrito (17/11/2026): antes ela sumia
  // sem aviso. Vem desmarcada; o professor vê e marca "Importar esta questão" se quiser subir mesmo assim.
  const todas = lidas.filter(q => q.enunciado || q.alternativas.length);
  todas.forEach(q => {
    if (q.alternativas.length < 2) q.problema = `Achei ${q.alternativas.length ? 'só 1 alternativa' : 'nenhuma alternativa'}. Confira se as alternativas começam com A), B), C)… logo depois da pergunta.`;
    else if (!q.pergunta && !q.casoHtml) q.problema = 'Não achei o enunciado/pergunta antes das alternativas.';
  });
  todas.comProblema = todas.filter(q => q.problema).map(q => q.numero);
  // o que o Órbita acertou sozinho, para a prévia avisar o professor (24/11/2026)
  todas.ajustadas = todas.filter(q => q.ajustes.length).map(q => q.numero);
  todas.tiposDeAjuste = [...new Set(todas.flatMap(q => q.ajustes))];
  return todas;
}

// Sombreamento amarelo/verde vale como marca-texto (17/11/2026): tem professor que pinta a correta com
// Sombreamento (w:shd fill="FFF200") em vez do marca-texto (w:highlight). O Word mostra igual, mas o mammoth só
// enxerga o marca-texto — a correta não era reconhecida (Mariana, Morfo DP). Aqui troca o sombreamento do texto
// (ou do parágrafo inteiro) por marca-texto amarelo antes da leitura.
function corDeMarcaTexto(hex) {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return false;
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
  const amarelo = r >= 200 && g >= 180 && b <= 140;
  const verde = g >= 180 && r <= 190 && b <= 160 && g - b >= 40;
  return amarelo || verde;
}
async function sombreamentoComoMarcaTexto(buffer) {
  try {
    const zip = await window.JSZip.loadAsync(buffer);
    const arq = zip.file('word/document.xml');
    if (!arq) return buffer;
    const doc = await arq.async('string');
    const RE_SHD = /<w:shd\b[^>]*\bw:fill="([0-9A-Fa-f]{6})"[^>]*\/>/;
    const MARCA = '<w:highlight w:val="yellow"/>';
    let mudou = false;
    // parágrafo inteiro sombreado: cada trecho dele ganha o marca-texto
    let novo = doc.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => {
      const ppr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p);
      const shd = ppr && RE_SHD.exec(ppr[0].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ''));
      if (!shd || !corDeMarcaTexto(shd[1])) return p;
      mudou = true;
      return p.replace(/<w:r>(?!\s*<w:rPr>)/g, `<w:r><w:rPr>${MARCA}</w:rPr>`).replace(/(<w:r\b[^>]*>\s*<w:rPr>)/g, `$1${MARCA}`);
    });
    // trecho sombreado (propriedade do texto)
    novo = novo.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (rpr, dentro) => {
      const shd = RE_SHD.exec(dentro);
      if (!shd || !corDeMarcaTexto(shd[1]) || /<w:highlight\b/.test(dentro)) return rpr;
      mudou = true;
      return `<w:rPr>${MARCA}${dentro}</w:rPr>`;
    });
    if (!mudou) return buffer;
    zip.file('word/document.xml', novo);
    return await zip.generateAsync({ type: 'arraybuffer' });
  } catch (e) {
    return buffer;
  }
}

async function lerModelo(file) {
  if (!window.JSZip || !window.mammoth) throw new Error('Leitor de Word não carregou. Recarregue a página.');
  if (!/\.docx$/i.test(file.name)) throw new Error('No navegador só dá pra ler Word .docx (salve o .doc como .docx).');
  const numerado = await escreverNumeracaoAutomatica(await sombreamentoComoMarcaTexto(await file.arrayBuffer()));
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: numerado }, { styleMap: ["highlight[color='yellow'] => mark", "highlight[color='green'] => mark"] });
  const blocos = blocosDoHtml(html);
  const temModelo = blocos.some(b => RE_ENUN.test(b.texto) || ROTULOS_INLINE[0][1].test(b.texto) ||
    (RE_ROTULO_SOBRANDO.test(b.texto) && RE_ENUN.test(b.texto.replace(RE_ROTULO_SOBRANDO, '')))) && blocos.some(b => RE_INICIO.test(b.texto));
  if (temModelo) return lerModeloDeBlocos(blocos);
  // questões sem número, cada uma aberta por "NÍVEL DE DIFICULDADE:" (16/11/2026) — o Órbita numera 1, 2, 3…
  const P = window.PadraoMed;
  if (P && P.ehFormatoNivel && P.ehFormatoNivel(blocos)) return P.lerPorNivel(blocos);
  return null;
}
window.LerWord = { ler, itensDoHtml, lerModelo, lerModeloDeBlocos, blocosDoHtml };
})();
