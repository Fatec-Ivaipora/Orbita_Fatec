// Lê um .docx OU .doc (formato antigo) com questões objetivas E dissertativas
// (formato "prova pro aluno", sem gabarito visível — ver PRODUCT do módulo
// Banco de Provas) e devolve uma lista de questões cruas, pra depois casar
// com o gabarito das objetivas (arquivo/lista separada) e jogar na fila de
// revisão — as dissertativas não têm gabarito, entram direto marcadas como
// `tipo: 'dissertativa'`.
//
// Heurística de leitura (baseada em modelos reais fornecidos pelo usuário —
// um .docx moderno estilo "Simulado" e um .doc antigo estilo "Prova
// Bimestral", cada um com uma convenção de numeração diferente):
// - Cada questão é marcada OU por "Questão N" (Simulado) OU por um número
//   solto colado no início da linha ("1.Débora...", "2. Pedro...", Prova
//   Bimestral) — o parser tenta a primeira convenção primeiro; se não achar
//   nenhuma, tenta a segunda, exigindo que os números venham em sequência
//   (1, 2, 3...) pra não confundir uma citação de lei ("Lei nº 5.197") com
//   início de questão.
// - A linha "QUESTÕES DISSERTATIVAS" (pode ter texto depois, tipo "- 1,5
//   cada") é o divisor de seção: fecha o bloco de objetiva que estiver
//   aberto e troca pro modo dissertativa, que reinicia a numeração em 1 (é
//   assim que o modelo real numera) e NÃO tenta separar "últimas N linhas
//   = alternativas" — o bloco inteiro (enunciado + eventuais itens A/B/C
//   discursivos, que fazem parte do texto, não são opções de múltipla
//   escolha) vira o enunciado da dissertativa. Antes disso não existia essa
//   troca de modo: a numeração reiniciada em 1 nunca batia com o próximo
//   número esperado depois da última objetiva, então as linhas da
//   dissertativa simplesmente iam se acumulando dentro do bloco da ÚLTIMA
//   objetiva até o fim do arquivo — resultado: uma objetiva com um texto
//   gigante colado (enunciado + cabeçalho da seção + dissertativas inteiras)
//   e nenhuma dissertativa de fato extraída.
// - Uma linha em CAIXA ALTA sozinha (2+ palavras, só letra e espaço), fora de
//   qualquer questão, é o nome da disciplina daquele bloco (arquivo pode ter
//   várias disciplinas juntas, como o Simulado) — vira sugestão de
//   disciplina, não fixa.
// - Nas OBJETIVAS, as alternativas são sempre as ÚLTIMAS N linhas do bloco da
//   questão (N = parâmetro `alternativasPorQuestao`, 4 ou 5 — não dá pra
//   adivinhar isso sozinho, então quem importa informa antes). O prefixo
//   "A) "/"a."/etc, se existir, é só decorativo — a letra real é sempre por
//   POSIÇÃO (1ª alternativa remanescente = A, 2ª = B...), o que resolve o
//   caso do Word gerar a letra via lista numerada automática (não vem no
//   texto extraído).
// - Quando o Word concatena as alternativas numa única linha só
//   ("A) x.B) y.C) z...", sem quebra de parágrafo entre elas — visto no
//   modelo real), a linha é quebrada em várias antes de aplicar a regra
//   acima.
const mammoth = require('mammoth');
const JSZip = require('jszip');
const WordExtractor = require('word-extractor');

const { LETRAS_ALTERNATIVA, expandirLinhaConcatenada, marcadorPorPalavra, marcadorPorNumeroSolto, montarQuestoesDeLinhas } = require('../../docencia/banco-provas/parse-linhas');

// .docx é um .zip (assinatura "PK"); .doc antigo é um Compound File OLE
// (assinatura D0 CF 11 E0). Detecta pelo conteúdo, não pela extensão do
// nome do arquivo (mais confiável — o nome vem do cliente).
function ehDocxZip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4B;
}

// Caixa de texto repetida em toda página ("SIMULADO FATEC – 2º BIMESTRE – 8°PERÍODO", 13/11/2026) é título de
// página: o mammoth lia como parágrafo no meio do enunciado. Sai do texto quando aparece 3 vezes ou mais.
async function semCaixasDeTextoRepetidas(buffer) {
    try {
        const zip = await JSZip.loadAsync(buffer);
        const arq = zip.file('word/document.xml');
        if (!arq) return buffer;
        const doc = await arq.async('string');
        const textoDe = (x) => [...x.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('').replace(/\s+/g, ' ').trim();
        const conta = new Map();
        for (const [, corpo] of doc.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)) {
            const t = textoDe(corpo);
            if (t) conta.set(t, (conta.get(t) || 0) + 1);
        }
        const repetidas = new Set([...conta].filter(([, n]) => n >= 3).map(([t]) => t));
        if (!repetidas.size) return buffer;
        zip.file('word/document.xml', doc.replace(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g, (todo, corpo) => (repetidas.has(textoDe(corpo)) ? '<w:txbxContent><w:p/></w:txbxContent>' : todo)));
        return await zip.generateAsync({ type: 'nodebuffer' });
    } catch (e) { return buffer; }
}

// opcoes.marcarTitulos: parágrafo com estilo de Título do Word volta com TITULO_DO_WORD na frente (só o
// Banco de Provas usa; as Avaliações da Medicina leem sem marca)
const TITULO_DO_WORD = '\u0001';
async function extrairParagrafosDoArquivo(buffer, opcoes = {}) {
    if (ehDocxZip(buffer)) {
        const { value: html } = await mammoth.convertToHtml({ buffer: await escreverNumeracaoAutomatica(await semCaixasDeTextoRepetidas(buffer)) });
        return extrairParagrafosHtml(html, !!opcoes.marcarTitulos);
    }
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody().split('\n').map(l => l.replace(/\t+/g, ' ').trim()).filter(Boolean);
}

// Lista numerada automática do Word (o professor numera as questões com o
// botão de numeração, 1 - 2 - 3...): o número não faz parte do texto, fica
// em numbering.xml, e o mammoth devolve só o conteúdo do item. Sem número,
// nenhuma questão era encontrada (16/10/2026). Aqui o número de cada
// parágrafo de lista DECIMAL é calculado e escrito no começo do próprio
// texto ("1 - ..."), antes do mammoth ler. Listas de letra (a, b, c) ficam
// como estão: a letra da alternativa já vem da posição.
const FORMATOS_DECIMAIS = new Set(['decimal', 'decimalZero']);

function lerAtributo(xml, tag, atributo) {
    const m = new RegExp(`<w:${tag}\\b[^>]*\\bw:${atributo}="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
}

async function escreverNumeracaoAutomatica(buffer) {
    try {
        const zip = await JSZip.loadAsync(buffer);
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
        return await zip.generateAsync({ type: 'nodebuffer' });
    } catch (e) {
        console.error('[parseProvaDocx] numeração automática:', e.message);
        return buffer;
    }
}

// Tabela: cada LINHA da tabela vira uma linha de texto, células separadas por " | " (13/11/2026,
// simulado da Biomedicina com alternativas em tabela: cada célula virava uma linha solta e a última
// célula, "DNA", ainda era lida como título de disciplina). Célula que é só a letra ("a)") vai na frente.
const textoDeHtml = (bruto) => bruto
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
const paraHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function tabelasEmLinhas(html) {
    return html.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g, (_, corpo) => {
        const celulas = [...corpo.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => textoDeHtml(c[1])).filter(Boolean);
        if (!celulas.length) return '';
        const letra = /^\(?[A-Ea-e]\s*[\).\-–]?$/.test(celulas[0]) && celulas.length > 1;
        const linha = letra ? `${celulas[0]} ${celulas.slice(1).join(' | ')}` : celulas.join(' | ');
        return `<p>${paraHtml(linha)}</p>`;
    });
}

function extrairParagrafosHtml(html, marcarTitulos) {
    html = tabelasEmLinhas(html);
    const paragrafos = [];
    // Item de lista termina no próximo item ou numa sublista: em lista de
    // vários níveis (questão no nível 1, alternativas a/b/c no nível 2) o
    // mammoth põe a sublista DENTRO do item da questão, e ler até o </li>
    // juntava a questão com a 1ª alternativa (16/10/2026).
    // Parágrafo com estilo de Título no Word vira <h1>..<h6> (13/11/2026, simulados da Biomedicina com
    // "Questão 01" em Título 2 e a disciplina em Título 1): antes eles sumiam e só as 5 primeiras questões
    // (numeração automática) eram lidas.
    const regex = /<p[^>]*>([\s\S]*?)<\/p>|<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>|<li[^>]*>([\s\S]*?)(?=<\/?(?:li|ol|ul)\b)/g;
    let m;
    while ((m = regex.exec(html))) {
        const bruto = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
        const texto = bruto
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        if (texto) paragrafos.push(marcarTitulos && m[2] !== undefined ? TITULO_DO_WORD + texto : texto);
    }
    return paragrafos;
}

// As regras de leitura linha a linha (marcadores, títulos, alternativas) ficam em
// docencia/banco-provas/parse-linhas.js — o MESMO arquivo roda no navegador na página do professor
// (colar as questões, 10/11/2026), pra prévia sair igual ao que o servidor lê.

/**
 * @param {Buffer} buffer - conteúdo do .docx ou .doc
 * @param {number} alternativasPorQuestao - 4 ou 5
 * @returns {Promise<{numero:number, categoriaSugeridaTexto:string|null, enunciado:string, alternativas:string[]}[]>}
 */
async function parseProvaDocx(buffer, alternativasPorQuestao) {
    const linhasBrutas = (await extrairParagrafosDoArquivo(buffer, { marcarTitulos: true })).flatMap(expandirLinhaConcatenada);

    // Tenta primeiro a convenção "Questão N" (mais confiável, sem risco de
    // falso positivo); só cai pra número solto se não achar nenhuma.
    const temMarcadorPorPalavra = linhasBrutas.some(l => marcadorPorPalavra(l.replace(TITULO_DO_WORD, '')) !== null);
    if (temMarcadorPorPalavra) {
        return montarQuestoesDeLinhas(linhasBrutas, alternativasPorQuestao, (linha) => marcadorPorPalavra(linha));
    }
    return montarQuestoesDeLinhas(linhasBrutas, alternativasPorQuestao, (linha, proximoEsperado) => marcadorPorNumeroSolto(linha, proximoEsperado));
}

// extrairParagrafosDoArquivo: também usado pelas Avaliações da Medicina (leitor por letra a-e, 12/11/2026)
module.exports = { parseProvaDocx, extrairParagrafosDoArquivo };
