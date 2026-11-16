// Padrão das questões e análise da avaliação — Medicina (12/11/2026). Só regras, sem IA.
// Base: guia de elaboração de itens do NBME (Case & Swanson) e Guia de Elaboração de Itens do INEP
// (mesma linha do ENAMED/Revalida): caso clínico + pergunta direta + 4 alternativas homogêneas (A a D — padrão da Medicina, 16/11/2026),
// UMA resposta correta, sem "nenhuma/todas", sem enunciado negativo, sem pista na correta.
// Compartilhado entre o servidor (require) e a tela (window.PadraoMed) — sem nada de Node aqui.
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica();
    else raiz.PadraoMed = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const LETRAS = ['A', 'B', 'C', 'D', 'E'];

function texto(html) {
    return String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li)>/gi, ' ')
        // 16/11/2026: marcação dentro da frase (itálico, negrito…) some sem virar espaço — senão "(DSM-5-TR)</i>." vira "(DSM-5-TR) ."
        .replace(/<\/?(i|em|b|strong|u|s|span|sup|sub|a|mark|font|small)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
}
function norm(s) { return texto(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
// repetidas (16/11/2026): "Dopamina;" = "dopamina." = "DOPAMINA" — ignora caixa, acento, pontuação e espaços
function chaveComparar(s) { return norm(s).replace(/[^a-z0-9]+/g, ' ').trim(); }

const RE_NENHUMA_TODAS = /\b(nenhuma (das )?(alternativas?|anteriores|acima)|nenhuma (alternativa )?esta correta|todas (as )?(alternativas )?(anteriores|acima|estao (in)?corretas|sao (in)?corretas|corretas|incorretas))\b/;
const RE_NEGATIVO = /\b(exceto|incorret[ao]s?|fals[ao]s?|nao (e|esta|sao|estao|corresponde|constitui|representa|apresenta|se aplica|faz parte)\b)/;
const RE_PERGUNTA = /(\?\s*$)|\b(assinale|marque|indique|aponte|qual|quais|identifique|escolha|selecione|conduta|diagnostico mais provavel|proximo passo)\b/;
const RE_CASO = /\b(paciente|anos de idade|\d+\s*anos|\d+\s*meses|\d+\s*dias de vida|sexo|masculino|feminino|homem|mulher|gestante|crianca|lactente|recem-nascido|idos[ao]|adolescente|procura|comparece|chega|admitid[ao]|atendid[ao]|refere|relata|queixa|apresenta-se|ao exame)\b/;
const RE_ABSOLUTO = /\b(sempre|nunca|jamais|exclusivamente)\b/;
// aula CADAM (13/11/2026): sem opinião/interpretação e sem "pode"/"é possível" (pistas)
const RE_OPINIAO = /\b(deveria|deveriam|poderia|poderiam|seria|seriam|na (sua|tua) opiniao|em sua opiniao|segundo (os )?especialistas|voce acha|acredita-se)\b/;
const RE_PODE = /\b(pode|podem|podera|poderao|e possivel|sao possiveis|eventualmente|geralmente|frequentemente|raramente)\b/;
const RE_REFERENCIA = /\b(19|20)\d{2}\b|\bed\.|editora|disponivel em|https?:|\bet al\b/;
const RE_AFIRMATIVAS = /^(apenas |somente )?(i|ii|iii|iv|v)(\s*(,|e)\s*(i|ii|iii|iv|v))*\.?( (esta|estao) corretas?\.?)?$/;
const PALAVRAS_COMUNS = new Set(['paciente', 'pacientes', 'alternativa', 'alternativas', 'correta', 'corretas', 'seguinte', 'seguintes', 'apresenta', 'segundo', 'quadro', 'clinico', 'clinica', 'sobre', 'quanto', 'considerando', 'durante', 'atendimento', 'medico', 'medica', 'presenca', 'relacao', 'possivel', 'principal', 'principais', 'devido', 'importante', 'tambem', 'pode', 'podem', 'deve', 'devem', 'sendo', 'quando', 'entre', 'outros', 'outras', 'atraves', 'acordo']);

// Classifica: questão de APLICAÇÃO (situação clínica/caso) x MEMORIZAÇÃO (pergunta direta de conceito).
function ehAplicacao(q) {
    const t = norm(q.casoClinico || q.enunciadoHtml);
    return t.length >= 160 && RE_CASO.test(t);
}

// Avalia UMA questão. bloqueios = impedem finalizar; avisos = orientações (não travam).
function avaliarQuestao(q, opts) {
    opts = opts || {};
    const bloqueios = [], avisos = [];
    const B = (cod, msg) => bloqueios.push({ cod, msg });
    const A = (cod, msg) => avisos.push({ cod, msg });
    const alts = (q.alternativas || []).map(a => ({ ...a, t: texto(a.texto), n: norm(a.texto), k: chaveComparar(a.texto) }));
    const corretas = alts.filter(a => a.correta);
    const enunciado = norm(q.enunciadoHtml);
    const pergunta = norm(q.pergunta || q.enunciadoHtml);

    if (q.tipoMoodle && q.tipoMoodle !== 'multichoice_unica') B('tipo', 'O tipo precisa ser "Múltipla escolha – uma resposta".');
    if (corretas.length !== 1) B('gabarito', corretas.length ? 'Marque só UMA alternativa correta.' : 'Marque a alternativa correta.');
    // Medicina: sempre 4 alternativas, A a D (16/11/2026)
    if (alts.length !== 4) B('qtd', alts.length > 4 ? `A questão tem ${alts.length} alternativas; na Medicina são 4 (A a D). Tire a que sobra.` : `A questão tem ${alts.length} alternativa(s); na Medicina são 4 (A a D).`);
    if (alts.some(a => !a.t)) B('vazia', 'Há alternativa sem texto.');
    const vistas = new Set();
    alts.forEach((a, i) => { const j = alts.findIndex((b, x) => x < i && b.k && b.k === a.k); if (a.k && j >= 0) B('repetida', `A alternativa ${LETRAS[i]} repete a ${LETRAS[j]} (mesmo texto, mesmo com maiúscula/minúscula ou pontuação diferente).`); vistas.add(a.k); });
    alts.forEach((a, i) => { if (RE_NENHUMA_TODAS.test(a.n)) B('nenhuma', `Alternativa ${LETRAS[i]}: "nenhuma/todas as alternativas" não é usado no padrão.`); });
    if (enunciado.length < 40) B('enunciado', 'O enunciado está curto demais.');
    // 16/11/2026: o feedback pode ser só uma imagem (gráfico, tabela, figura)
    if (!texto(q.justificativa) && !(q.imagensFeedback || []).length) B('feedback', 'Escreva o feedback geral (explicação da resposta correta) ou coloque uma imagem.');
    if (!opts.semMetadados) {
        if (!String(q.professorNome || '').trim()) B('professor', 'Informe o professor que elaborou a questão.');
        if (!String(q.objetivo || '').trim()) B('objetivo', 'Escolha o objetivo do plano de ensino que a questão avalia.');
        if (!q.unidade) B('unidade', 'Escolha a unidade do plano de ensino.');
    }

    if (RE_OPINIAO.test(enunciado)) A('opiniao', `Pergunta de opinião/interpretação ("${enunciado.match(RE_OPINIAO)[1]}"). Pergunte o que é correto, não o que "seria".`);
    const comPode = alts.map((a, i) => RE_PODE.test(a.n) ? `${LETRAS[i]} ("${a.n.match(RE_PODE)[1]}")` : null).filter(Boolean);
    if (comPode.length) A('pode', `Termo vago nas alternativas (${comPode.join(', ')}): "pode", "é possível", "geralmente" viram pista. Afirme com precisão.`);
    if ((pergunta.match(/\?/g) || []).length >= 2 || /\?.*\b(e|alem disso|tambem)\b.*\?/.test(pergunta) || /\b(qual|quais)\b[^?]*\be (qual|quais|como|por que)\b/.test(pergunta)) A('dois-assuntos', 'A pergunta cobra duas coisas. Um aspecto por questão (divida em duas).');
    if (RE_NEGATIVO.test(enunciado)) A('negativo', 'Enunciado negativo (EXCETO / INCORRETA / NÃO). Prefira perguntar pela alternativa correta.');
    if (enunciado.length >= 40 && !RE_PERGUNTA.test(pergunta)) A('pergunta', 'Termine o enunciado com uma pergunta direta (ex.: "Qual a conduta mais adequada?").');
    if (!ehAplicacao(q)) A('memorizacao', 'Questão de memorização: não há situação clínica. O padrão da Medicina prioriza caso clínico.');
    if (corretas.length === 1 && alts.length >= 3) {
        const c = corretas[0];
        const outras = alts.filter(a => a !== c).map(a => a.t.length).sort((x, y) => y - x);
        if (c.t.length > outras[0] * 1.5 && c.t.length - outras[0] > 25) A('longa', 'A alternativa correta é bem mais longa que as outras — isso entrega a resposta.');
        // pista de repetição: palavra do enunciado que só a correta repete
        const palavrasEnun = new Set(enunciado.split(/[^a-z0-9-]+/).filter(w => w.length >= 6 && !PALAVRAS_COMUNS.has(w)));
        const repete = (a) => a.n.split(/[^a-z0-9-]+/).filter(w => palavrasEnun.has(w));
        const naCorreta = repete(c);
        if (naCorreta.length && alts.filter(a => a !== c).every(a => !repete(a).length)) A('pista', `Só a alternativa correta repete palavra do enunciado ("${naCorreta[0]}") — é uma pista.`);
        const absolutas = alts.map((a, i) => (a !== c && RE_ABSOLUTO.test(a.n)) ? `${LETRAS[i]} ("${a.n.match(RE_ABSOLUTO)[1]}")` : null).filter(Boolean);
        if (absolutas.length && !RE_ABSOLUTO.test(c.n)) A('absoluto', `Termo absoluto nas erradas (${absolutas.join(', ')}) — denuncia que estão erradas.`);
    }
    if (alts.filter(a => RE_AFIRMATIVAS.test(a.n)).length >= 2) A('afirmativas', 'Formato de afirmativas combinadas (I, II, III). O padrão recomenda resposta direta.');
    // 13/11/2026: feedback é só o geral da questão — sem feedback por alternativa
    if (!String(q.fonte || '').trim() && !RE_REFERENCIA.test(norm(q.justificativa))) A('referencia', 'Sem referência bibliográfica.');
    return { ok: !bloqueios.length, bloqueios, avisos, aplicacao: ehAplicacao(q) };
}

// ---- Leitor de questões a partir de linhas (Word / PDF / texto colado) — servidor e navegador (12/11/2026) ----
// Guiado pelas LETRAS das alternativas (a) b) c)...), então 4 e 5 alternativas convivem no mesmo arquivo.
// Questão começa em "Questão 7", "7.", "7)", "7 -" (em sequência). Bloco sem letra nenhuma (letras automáticas do
// Word) cai no palpite: as últimas 5 (ou 4) linhas são as alternativas. Itens { imagem } (Word lido no navegador)
// grudam na questão em que aparecem. "Gabarito: C" / "Resposta: c)" marca a correta.
const RE_QUESTAO = /^(?:quest(?:ã|a)o\s*)?(\d{1,3})\s*(?:[.)\-–:]|\s(?=[A-ZÀ-Ú]))\s*(.*)$/i;
const RE_ALT = /^\(?([a-eA-E])\s*[).\-–]\s+(.*)$/;
const RE_GABARITO = /^(?:gabarito|resposta|resp\.?|alternativa correta)\s*[:\-–]?\s*\(?([A-Ea-e])\)?\s*\.?$/i;
function expandirLinha(linha) {
    const m = linha.match(/[A-E]\)/g);
    if (!m || m.length < 2) return [linha];
    return linha.split(/(?=[A-E]\))/).map(x => x.trim()).filter(Boolean);
}
function lerQuestoesDeLinhas(itens) {
    const qs = [];
    let atual = null, esperado = null;
    const fechar = () => { if (atual) qs.push(atual); atual = null; };
    const linhas = [];
    (itens || []).forEach(it => {
        if (it && typeof it === 'object') linhas.push(it);
        else expandirLinha(String(it || '').replace(/\s+/g, ' ').trim()).forEach(l => { if (l) linhas.push(l); });
    });
    linhas.forEach(l => {
        if (typeof l === 'object') { if (atual && l.imagem) atual.imagens.push(l.imagem); return; }
        const m = RE_QUESTAO.exec(l);
        const n = m ? parseInt(m[1], 10) : null;
        const ehInicio = m && (esperado === null ? n <= 3 : n === esperado) && !(atual && RE_ALT.test(l));
        if (ehInicio) { fechar(); atual = { numero: n, linhas: m[2] ? [m[2]] : [], alternativas: [], gabarito: null, imagens: [] }; esperado = n + 1; return; }
        if (!atual) return;
        const g = RE_GABARITO.exec(l);
        if (g) { atual.gabarito = g[1].toUpperCase(); return; }
        const a = RE_ALT.exec(l);
        if (a && a[1].toUpperCase() === LETRAS[atual.alternativas.length]) { atual.alternativas.push(a[2]); return; }
        if (atual.alternativas.length) atual.alternativas[atual.alternativas.length - 1] += ' ' + l;
        else atual.linhas.push(l);
    });
    fechar();
    return qs.map(q => {
        if (q.alternativas.length < 2 && q.linhas.length >= 5) {
            const k = q.linhas.length >= 6 ? 5 : 4;
            q.alternativas = q.linhas.splice(q.linhas.length - k, k);
        }
        return {
            numero: q.numero, enunciado: q.linhas.join('\n'), alternativas: q.alternativas.slice(0, 5), imagens: q.imagens,
            gabarito: q.gabarito && LETRAS.indexOf(q.gabarito) < q.alternativas.length ? q.gabarito : null
        };
    }).filter(q => q.enunciado && q.alternativas.length >= 2);
}

// ---------------------------------------------------------------------------------------------------------
// FORMATO "NÍVEL DE DIFICULDADE" (16/11/2026 — ex.: prova de Neurociências do Prof. Paulo Vitor): as questões NÃO
// são numeradas; cada uma começa em "NÍVEL DE DIFICULDADE: FÁCIL/MÉDIO/DIFÍCIL" e o Órbita numera em sequência
// (1, 2, 3…). Depois vêm enunciado, alternativas A) a D), "ALTERNATIVA CORRETA: B" (ou RESPOSTA CORRETA, "C.",
// "C) texto"), JUSTIFICATIVA: (feedback) e REFERÊNCIA(S): (fonte). Serve ao Word (blocos = parágrafos, com
// imagens e marca-texto) e ao PDF (blocos = linhas quebradas; opts.pdf junta as linhas em parágrafos).
// ---------------------------------------------------------------------------------------------------------
const RE_NIVEL = /^n[íi]vel\s+de\s+dificuldade\s*:?\s*(.*)$/i;
const RE_CORRETA = /^[A-Za-zÀ-ú]{0,14}\s*corret[ao]\s*:\s*\(?([A-Ea-e])(?=$|[\s).:;-])/i;
const RE_JUST = /^(justificativa|feedback|coment[áa]rio)(\s+d[ao]\s+quest[ãa]o)?\s*:?\s*(.*)$/i;
const RE_REFS = /^refer[êe]ncias?(\s+bibliogr[áa]ficas?)?\s*:?\s*(.*)$/i;
function ehFormatoNivel(textos) { return (textos || []).filter(t => RE_NIVEL.test(String((t && t.texto !== undefined ? t.texto : t) || '').trim())).length >= 2; }
function dificuldadeDe(t) {
    const x = norm(t);
    return /facil/.test(x) ? 'facil' : /intermedi/.test(x) ? 'intermediaria' : /dificil/.test(x) ? 'dificil' : 'media';
}
function escHtml(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// PDF: junta as linhas quebradas em parágrafos (quebra quando a linha termina em . : ? ! e é mais curta que as cheias)
function paragrafosPdf(blocos) {
    const max = Math.max(1, ...blocos.map(b => b.texto.length));
    const out = []; let cur = null;
    blocos.forEach(b => {
        if (!cur) cur = { texto: '', imgs: [], marcado: false };
        cur.texto = (cur.texto ? cur.texto + ' ' : '') + b.texto; cur.imgs.push(...(b.imgs || []));
        if (/[.:?!]\s*$/.test(b.texto) && b.texto.length < max * 0.85) { out.push(cur); cur = null; }
    });
    if (cur) out.push(cur);
    return out.map(b => ({ ...b, html: escHtml(b.texto) }));
}
function lerPorNivel(blocosIn, opts) {
    opts = opts || {};
    const blocos = (blocosIn || []).map(b => (typeof b === 'string' ? { texto: b } : b))
        .map(b => ({ texto: String(b.texto || '').replace(/\s+/g, ' ').trim(), html: b.html, imgs: b.imgs || [], marcado: !!b.marcado, tag: b.tag || '' }))
        .filter(b => b.texto || b.imgs.length);
    const qs = []; let q = null, sec = null;
    for (const b of blocos) {
        const t = b.texto;
        const mN = RE_NIVEL.exec(t);
        if (mN && t.length < 60) { q = { numero: qs.length + 1, dificuldade: dificuldadeDe(mN[1]), dificTexto: mN[1].trim(), enun: [], alts: [], marcada: -1, gabarito: null, fb: [], ref: [] }; qs.push(q); sec = 'enun'; continue; }
        if (!q) continue;
        const mC = RE_CORRETA.exec(t);
        if (mC && t.length < 200 && sec !== 'fb' && sec !== 'ref') { q.gabarito = mC[1].toUpperCase(); sec = 'pos'; continue; }
        const mJ = RE_JUST.exec(t);
        if (mJ && sec !== 'ref') {
            sec = 'fb';
            if (mJ[3] || b.imgs.length) q.fb.push({ ...b, texto: mJ[3] || '', html: mJ[3] ? escHtml(mJ[3]) : '' });
            continue;
        }
        const mR = RE_REFS.exec(t);
        if (mR) { sec = 'ref'; if (mR[2]) q.ref.push(mR[2]); continue; }
        if (sec === 'enun' || sec === 'alts') {
            const mU = /^unidade\s*:?\s*(.+)$/i.exec(t), mO = /^objetivo\s*:?\s*(.+)$/i.exec(t), mP = /^prova\s*:\s*(.+)$/i.exec(t);
            if (sec === 'enun' && mP && t.length < 80) { q.provaWord = mP[1].trim(); continue; }
            if (sec === 'enun' && mU && t.length < 200) { q.unidadeWord = mU[1].trim(); continue; }
            if (sec === 'enun' && mO && t.length < 600) { q.objetivoWord = mO[1].trim(); continue; }
            const a = RE_ALT.exec(t);
            if (a && a[1].toUpperCase() === LETRAS[q.alts.length]) { q.alts.push(a[2]); if (b.marcado) q.marcada = q.alts.length - 1; sec = 'alts'; continue; }
            if (sec === 'alts') { if (t) q.alts[q.alts.length - 1] += ' ' + t; if (b.marcado) q.marcada = q.alts.length - 1; continue; }
            q.enun.push(b); continue;
        }
        if (sec === 'fb') { q.fb.push(b); continue; }
        if (sec === 'ref') { if (t) q.ref.push(t); }
    }
    // Word com alternativas em LISTA AUTOMÁTICA (a, b, c, d do botão de lista, sem a letra no texto): os itens de lista
    // no fim do enunciado são as alternativas, na ordem; a marcada com marca-texto é a correta se não houver a linha.
    qs.forEach(q => {
        if (q.alts.length >= 2) return;
        let i = q.enun.length;
        while (i > 0 && q.enun[i - 1].tag === 'LI' && q.enun[i - 1].texto) i--;
        const lista = q.enun.slice(i);
        if (lista.length < 2 || lista.length > 5) return;
        q.enun = q.enun.slice(0, i);
        q.alts = lista.map(b => b.texto);
        const m = lista.findIndex(b => b.marcado);
        if (m >= 0) q.marcada = m;
    });
    return qs.map(q => {
        const enun = opts.pdf ? paragrafosPdf(q.enun) : q.enun.map(b => ({ ...b, html: b.html || escHtml(b.texto) }));
        const fb = opts.pdf ? paragrafosPdf(q.fb.filter(b => b.texto)) : q.fb.filter(b => b.texto).map(b => ({ ...b, html: b.html || escHtml(b.texto) }));
        const comTexto = enun.filter(b => b.texto);
        // pergunta = último parágrafo; se o enunciado for um parágrafo só, a última frase dele
        let pergunta = comTexto.length ? comTexto[comTexto.length - 1].texto : '';
        let caso = comTexto.slice(0, -1).map(b => '<p>' + b.html + '</p>').join('');
        if (comTexto.length === 1) {
            const frases = pergunta.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú])/);
            if (frases.length > 1) { const ult = frases.pop(); caso = '<p>' + escHtml(frases.join(' ')) + '</p>'; pergunta = ult; }
        }
        const gabarito = q.gabarito || (q.marcada >= 0 ? LETRAS[q.marcada] : null);
        return {
            numero: q.numero, tituloOriginal: 'Nível de dificuldade: ' + q.dificTexto, tema: '', dificuldade: q.dificuldade,
            casoHtml: caso, pergunta,
            enunciado: comTexto.map(b => b.texto).join('\n'),
            alternativas: q.alts.map(a => String(a).trim()),
            gabarito: gabarito && LETRAS.indexOf(gabarito) >= 0 && LETRAS.indexOf(gabarito) < q.alts.length ? gabarito : null,
            imagens: q.enun.flatMap(b => b.imgs).map((dataUrl, i) => ({ dataUrl, nome: 'questao-' + q.numero + '-' + (i + 1) })),
            justificativa: fb.map(b => '<p>' + b.html + '</p>').join(''),
            imagensFeedback: q.fb.flatMap(b => b.imgs).map((dataUrl, i) => ({ dataUrl, nome: 'feedback-' + q.numero + '-' + (i + 1) })),
            unidadeWord: q.unidadeWord || '', objetivoWord: q.objetivoWord || '', provaWord: q.provaWord || '',
            fonte: q.ref.join(' ')
        };
    }).filter(q => q.alternativas.length >= 2 && (q.pergunta || q.casoHtml));
}

// Título no AVA (13/11/2026): "Prof. Nome – título do objetivo" (a disciplina já é a pasta do banco no AVA).
// O parâmetro sigla ficou só pra não quebrar quem chama.
function tituloPadrao(professor, sigla, objetivo) {
    const curto = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
    return `Prof. ${curto(professor, 60)} – ${curto(objetivo, 160)}`;
}

// Análise da avaliação inteira contra o plano de ensino (unidades do bimestre + objetivos).
// criterios (por disciplina, definidos pelo professor responsável — banco_med_criterios): peso de cada unidade
// (padrão = carga horária), bimestre de cada unidade, % mínimo de caso clínico e tolerância. Sem critério = padrão.
const CRITERIOS_PADRAO = { minCaso: 50, abaixo: 50, acima: 175 };
function aplicarCriterios(plano, crit) {
    crit = crit || {};
    const unidades = ((plano && plano.unidades) || []).map(u => ({
        ...u,
        bimestre: crit.bimestres && crit.bimestres[u.numero] ? Number(crit.bimestres[u.numero]) : u.bimestre,
        peso: crit.pesos && crit.pesos[u.numero] !== undefined && crit.pesos[u.numero] !== '' ? Number(crit.pesos[u.numero]) : (Number(u.ch) || 0)
    }));
    return { ...plano, unidades };
}
function analisarAvaliacao(questoes, plano, bimestre, criterios) {
    const lim = { ...CRITERIOS_PADRAO, ...((criterios && criterios.limites) || {}) };
    const total = questoes.length;
    // 13/11/2026: tamanho da prova e divisão entre os professores (os professores da disciplina dividem a prova).
    // Com o total definido, o esperado de cada unidade sai dele (e não das questões que já entraram).
    const planejado = Number(criterios && criterios.qtdQuestoes) > 0 ? Number(criterios.qtdQuestoes) : 0;
    const base = planejado || total;
    const unidadesBim = ((plano && plano.unidades) || []).filter(u => !bimestre || u.bimestre === bimestre);
    const pesoDe = (u) => (u.peso !== undefined ? Number(u.peso) : Number(u.ch)) || 0;
    const pesoTotal = unidadesBim.reduce((s, u) => s + pesoDe(u), 0);
    const porUnidade = unidadesBim.map(u => {
        const qtd = questoes.filter(q => Number(q.unidade) === u.numero).length;
        const esperado = pesoTotal ? base * pesoDe(u) / pesoTotal : base / (unidadesBim.length || 1);
        let situacao = 'ok';
        if (base >= 4 && esperado > 0) {
            if (qtd === 0 && esperado >= 1) situacao = 'sem';
            else if (qtd < esperado * lim.abaixo / 100) situacao = 'abaixo';
            else if (qtd > esperado * lim.acima / 100 && qtd - esperado >= 2) situacao = 'acima';
        }
        return { numero: u.numero, ch: u.ch, peso: pesoDe(u), titulo: u.titulo, qtd, esperado: Math.round(esperado * 10) / 10, situacao };
    });
    const numsBim = new Set(unidadesBim.map(u => u.numero));
    const foraDoBimestre = questoes.filter(q => q.unidade && unidadesBim.length && !numsBim.has(Number(q.unidade))).length;
    const objetivos = ((plano && plano.objetivos) || []).map(o => ({ objetivo: o, qtd: questoes.filter(q => norm(q.objetivo) === norm(o)).length }));
    const professores = {};
    questoes.forEach(q => { const p = q.professorNome || 'Sem professor'; professores[p] = (professores[p] || 0) + 1; });
    const dificuldade = {};
    questoes.forEach(q => { const d = q.dificuldade || 'media'; dificuldade[d] = (dificuldade[d] || 0) + 1; });
    const avaliacoes = questoes.map(q => avaliarQuestao(q));
    const aplicacao = avaliacoes.filter(a => a.aplicacao).length;
    const enunciados = {};
    questoes.forEach((q, i) => { const k = chaveComparar(q.enunciadoHtml); if (k) (enunciados[k] = enunciados[k] || []).push(i + 1); });
    const repetidas = Object.values(enunciados).filter(l => l.length > 1);
    const peloPeso = (criterios && criterios.pesos && Object.keys(criterios.pesos).length) ? 'pelo peso definido' : 'pela carga horária';
    const pendencias = [];
    if (!total) pendencias.push(planejado ? `A avaliação ainda não tem questões (a prova é de ${planejado}).` : 'A avaliação ainda não tem questões.');
    else if (planejado && total < planejado) pendencias.push(`Faltam ${planejado - total} questão(ões) para completar as ${planejado} da prova.`);
    else if (planejado && total > planejado) pendencias.push(`A prova tem ${total - planejado} questão(ões) a mais que as ${planejado} combinadas.`);
    // cota de cada professor
    const metas = (criterios && criterios.porProfessor) || {};
    const porProfessor = Object.entries(metas).filter(([, n]) => Number(n) > 0).map(([nome, n]) => ({ nome, meta: Number(n), feitas: questoes.filter(q => norm(q.professorNome) === norm(nome)).length }));
    porProfessor.filter(x => x.feitas < x.meta).forEach(x => pendencias.push(`${x.nome}: ${x.feitas} de ${x.meta} questões.`));
    porProfessor.filter(x => x.feitas > x.meta).forEach(x => pendencias.push(`${x.nome} passou da cota: ${x.feitas} de ${x.meta}.`));
    porUnidade.filter(u => u.situacao === 'sem').forEach(u => pendencias.push(`Unidade ${u.numero} não tem nenhuma questão.`));
    porUnidade.filter(u => u.situacao === 'abaixo').forEach(u => pendencias.push(`Unidade ${u.numero} tem ${u.qtd} questão(ões); ${peloPeso} seriam cerca de ${Math.round(u.esperado)}.`));
    porUnidade.filter(u => u.situacao === 'acima').forEach(u => pendencias.push(`Unidade ${u.numero} concentra ${u.qtd} questões; ${peloPeso} seriam cerca de ${Math.round(u.esperado)}.`));
    if (foraDoBimestre) pendencias.push(`${foraDoBimestre} questão(ões) de unidade de outro bimestre.`);
    if (total && lim.minCaso > 0 && 100 * aplicacao / total < lim.minCaso) pendencias.push(`Só ${aplicacao} de ${total} questões são de caso clínico; o mínimo da disciplina é ${lim.minCaso}%.`);
    repetidas.forEach(l => pendencias.push(`Questões ${l.join(', ')} têm o mesmo enunciado.`));
    return {
        total, porUnidade, foraDoBimestre, objetivos, professores, dificuldade,
        aplicacao, memorizacao: total - aplicacao, limites: lim, planejado, porProfessor,
        comBloqueio: avaliacoes.filter(a => !a.ok).length,
        avisos: avaliacoes.reduce((s, a) => s + a.avisos.length, 0),
        repetidas, pendencias
    };
}

return { LETRAS, texto, norm, chaveComparar, lerQuestoesDeLinhas, lerPorNivel, ehFormatoNivel, avaliarQuestao, analisarAvaliacao, aplicarCriterios, CRITERIOS_PADRAO, tituloPadrao, ehAplicacao };
}));
