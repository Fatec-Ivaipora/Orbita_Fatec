// Padrão das questões e análise da avaliação — Medicina (12/11/2026). Só regras, sem IA.
// Base: guia de elaboração de itens do NBME (Case & Swanson) e Guia de Elaboração de Itens do INEP
// (mesma linha do ENAMED/Revalida): caso clínico + pergunta direta + 4 ou 5 alternativas homogêneas,
// UMA resposta correta, sem "nenhuma/todas", sem enunciado negativo, sem pista na correta.
// Compartilhado entre o servidor (require) e a tela (window.PadraoMed) — sem nada de Node aqui.
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica();
    else raiz.PadraoMed = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const LETRAS = ['A', 'B', 'C', 'D', 'E'];

function texto(html) {
    return String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li)>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
}
function norm(s) { return texto(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

const RE_NENHUMA_TODAS = /\b(nenhuma (das )?(alternativas?|anteriores|acima)|nenhuma (alternativa )?esta correta|todas (as )?(alternativas )?(anteriores|acima|estao (in)?corretas|sao (in)?corretas|corretas|incorretas))\b/;
const RE_NEGATIVO = /\b(exceto|incorret[ao]s?|fals[ao]s?|nao (e|esta|sao|estao|corresponde|constitui|representa|apresenta|se aplica|faz parte)\b)/;
const RE_PERGUNTA = /(\?\s*$)|\b(assinale|marque|indique|aponte|qual|quais|identifique|escolha|selecione|conduta|diagnostico mais provavel|proximo passo)\b/;
const RE_CASO = /\b(paciente|anos de idade|\d+\s*anos|\d+\s*meses|\d+\s*dias de vida|sexo|masculino|feminino|homem|mulher|gestante|crianca|lactente|recem-nascido|idos[ao]|adolescente|procura|comparece|chega|admitid[ao]|atendid[ao]|refere|relata|queixa|apresenta-se|ao exame)\b/;
const RE_ABSOLUTO = /\b(sempre|nunca|jamais|exclusivamente)\b/;
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
    const alts = (q.alternativas || []).map(a => ({ ...a, t: texto(a.texto), n: norm(a.texto) }));
    const corretas = alts.filter(a => a.correta);
    const enunciado = norm(q.enunciadoHtml);
    const pergunta = norm(q.pergunta || q.enunciadoHtml);

    if (q.tipoMoodle && q.tipoMoodle !== 'multichoice_unica') B('tipo', 'O tipo precisa ser "Múltipla escolha – uma resposta".');
    if (corretas.length !== 1) B('gabarito', corretas.length ? 'Marque só UMA alternativa correta.' : 'Marque a alternativa correta.');
    if (alts.length < 4 || alts.length > 5) B('qtd', `A questão tem ${alts.length} alternativa(s); o padrão é 4 ou 5.`);
    if (alts.some(a => !a.t)) B('vazia', 'Há alternativa sem texto.');
    const vistas = new Set();
    alts.forEach((a, i) => { if (a.n && vistas.has(a.n)) B('repetida', `A alternativa ${LETRAS[i]} repete outra.`); vistas.add(a.n); });
    alts.forEach((a, i) => { if (RE_NENHUMA_TODAS.test(a.n)) B('nenhuma', `Alternativa ${LETRAS[i]}: "nenhuma/todas as alternativas" não é usado no padrão.`); });
    if (enunciado.length < 40) B('enunciado', 'O enunciado está curto demais.');
    if (!texto(q.justificativa)) B('feedback', 'Escreva o feedback geral (explicação da resposta correta).');
    if (!opts.semMetadados) {
        if (!String(q.professorNome || '').trim()) B('professor', 'Informe o professor que elaborou a questão.');
        if (!String(q.objetivo || '').trim()) B('objetivo', 'Escolha o objetivo do plano de ensino que a questão avalia.');
        if (!q.unidade) B('unidade', 'Escolha a unidade do plano de ensino.');
    }

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
    const semFeedback = alts.filter(a => !texto(a.feedback)).length;
    if (alts.length && semFeedback) A('feedback-alt', semFeedback === alts.length ? 'Nenhuma alternativa tem feedback próprio.' : `${semFeedback} alternativa(s) sem feedback próprio.`);
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

function tituloPadrao(professor, sigla, objetivo) {
    const curto = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
    return `Prof. ${curto(professor, 60)} – ${String(sigla || '').trim()} – ${curto(objetivo, 140)}`;
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
    const unidadesBim = ((plano && plano.unidades) || []).filter(u => !bimestre || u.bimestre === bimestre);
    const pesoDe = (u) => (u.peso !== undefined ? Number(u.peso) : Number(u.ch)) || 0;
    const pesoTotal = unidadesBim.reduce((s, u) => s + pesoDe(u), 0);
    const porUnidade = unidadesBim.map(u => {
        const qtd = questoes.filter(q => Number(q.unidade) === u.numero).length;
        const esperado = pesoTotal ? total * pesoDe(u) / pesoTotal : total / (unidadesBim.length || 1);
        let situacao = 'ok';
        if (total >= 4 && esperado > 0) {
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
    questoes.forEach((q, i) => { const k = norm(q.enunciadoHtml); if (k) (enunciados[k] = enunciados[k] || []).push(i + 1); });
    const repetidas = Object.values(enunciados).filter(l => l.length > 1);
    const peloPeso = (criterios && criterios.pesos && Object.keys(criterios.pesos).length) ? 'pelo peso definido' : 'pela carga horária';
    const pendencias = [];
    if (!total) pendencias.push('A avaliação ainda não tem questões.');
    porUnidade.filter(u => u.situacao === 'sem').forEach(u => pendencias.push(`Unidade ${u.numero} não tem nenhuma questão.`));
    porUnidade.filter(u => u.situacao === 'abaixo').forEach(u => pendencias.push(`Unidade ${u.numero} tem ${u.qtd} questão(ões); ${peloPeso} seriam cerca de ${Math.round(u.esperado)}.`));
    porUnidade.filter(u => u.situacao === 'acima').forEach(u => pendencias.push(`Unidade ${u.numero} concentra ${u.qtd} questões; ${peloPeso} seriam cerca de ${Math.round(u.esperado)}.`));
    if (foraDoBimestre) pendencias.push(`${foraDoBimestre} questão(ões) de unidade de outro bimestre.`);
    if (total && lim.minCaso > 0 && 100 * aplicacao / total < lim.minCaso) pendencias.push(`Só ${aplicacao} de ${total} questões são de caso clínico; o mínimo da disciplina é ${lim.minCaso}%.`);
    repetidas.forEach(l => pendencias.push(`Questões ${l.join(', ')} têm o mesmo enunciado.`));
    return {
        total, porUnidade, foraDoBimestre, objetivos, professores, dificuldade,
        aplicacao, memorizacao: total - aplicacao, limites: lim,
        comBloqueio: avaliacoes.filter(a => !a.ok).length,
        avisos: avaliacoes.reduce((s, a) => s + a.avisos.length, 0),
        repetidas, pendencias
    };
}

return { LETRAS, texto, norm, lerQuestoesDeLinhas, avaliarQuestao, analisarAvaliacao, aplicarCriterios, CRITERIOS_PADRAO, tituloPadrao, ehAplicacao };
}));
