// ==========================================
// Nome social (28/10/2026) — o Edubox só tem o nome de registro do aluno. Quem usa nome social
// fica cadastrado em config/nomes_sociais.alunos = [{ ra, nomeRegistro, nomeSocial, curso, em, por }]
// e o Órbita mostra o nome social em tudo: os robôs do CADD e da Cobrança trocam o nome ao copiar do
// Edubox (scripts/cad-edubox-sync.js e cobranca-edubox-sync.js, na função q), e o que busca no Edubox
// pelo nome (rota de coleta) volta pro nome de registro só na hora de consultar.
// Comparação sem acento/pontuação, nome completo — não troca nome parecido.
// ==========================================
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

let cache = null; // { em, social: Map(registro → social), registro: Map(social → registro), trocas: [{ re, social }] }

// nome de registro como expressão: sem diferença de maiúscula, acento e espaço (o Edubox às vezes tem espaço duplo)
const VARIANTES = { A: '[AÁÀÂÃÄaáàâãä]', E: '[EÉÈÊËeéèêë]', I: '[IÍÌÎÏiíìîï]', O: '[OÓÒÔÕÖoóòôõö]', U: '[UÚÙÛÜuúùûü]', C: '[CÇcç]', N: '[NÑnñ]' };
function expressaoDoNome(nome) {
    const partes = norm(nome).split(' ').filter(Boolean)
        .map(p => [...p].map(ch => VARIANTES[ch] || (/[A-Z]/.test(ch) ? `[${ch}${ch.toLowerCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join(''));
    return partes.length >= 2 ? new RegExp(`(?<![\\p{L}])${partes.join('[\\s.]+')}(?![\\p{L}])`, 'gu') : null;
}

async function carregarNomesSociais() {
    if (cache && Date.now() - cache.em < 10 * 60 * 1000) return cache;
    const { db } = require('../firebase');
    const s = await db.collection('config').doc('nomes_sociais').get();
    const lista = s.exists && Array.isArray(s.data().alunos) ? s.data().alunos : [];
    cache = {
        em: Date.now(),
        social: new Map(lista.filter(a => a.nomeRegistro && a.nomeSocial).map(a => [norm(a.nomeRegistro), a.nomeSocial])),
        registro: new Map(lista.filter(a => a.nomeRegistro && a.nomeSocial).map(a => [norm(a.nomeSocial), a.nomeRegistro])),
        trocas: lista.filter(a => a.nomeRegistro && a.nomeSocial).map(a => ({ re: expressaoDoNome(a.nomeRegistro), social: a.nomeSocial })).filter(t => t.re)
    };
    return cache;
}

// NOME SOCIAL EM TODO O ÓRBITA (26/11/2026): troca o nome de registro pelo nome social em QUALQUER texto — campo
// inteiro ("nome": "...") ou dentro de uma frase ("Fulano de Tal tirou 8,0"). Nome completo, sem diferença de
// maiúscula/acento/espaço. Usado na saída de TODA a API (api/index.js) e onde o servidor monta arquivo (Excel).
function trocarNoTexto(s) {
    if (!cache || !cache.trocas.length || typeof s !== 'string' || s.length < 5) return s;
    let out = s;
    for (const t of cache.trocas) { t.re.lastIndex = 0; if (t.re.test(out)) { t.re.lastIndex = 0; out = out.replace(t.re, t.social); } }
    return out;
}
function trocarNoObjeto(v, prof = 0) {
    if (!cache || !cache.trocas.length || prof > 40) return v;
    if (typeof v === 'string') return trocarNoTexto(v);
    if (Array.isArray(v)) { let mudou = false; const a = v.map(x => { const y = trocarNoObjeto(x, prof + 1); if (y !== x) mudou = true; return y; }); return mudou ? a : v; }
    if (v && typeof v === 'object' && (v.constructor === Object || !v.constructor)) {
        let mudou = false; const o = {};
        for (const k of Object.keys(v)) { const y = trocarNoObjeto(v[k], prof + 1); if (y !== v[k]) mudou = true; o[k] = y; }
        return mudou ? o : v;
    }
    return v;
}

// nome de registro (como vem do Edubox) → nome social, se o aluno tiver
function nomeSocial(nome) {
    return (cache && nome && cache.social.get(norm(nome))) || nome;
}
// nome social (como está no Órbita) → nome de registro, pra consultar o Edubox
function nomeRegistro(nome) {
    return (cache && nome && cache.registro.get(norm(nome))) || nome;
}
// troca o campo "nome" das linhas que vieram do Edubox
async function aplicarNasLinhas(linhas) {
    await carregarNomesSociais();
    if (!cache.social.size) return linhas;
    return linhas.map(l => (l && typeof l.nome === 'string' && cache.social.has(norm(l.nome)) ? { ...l, nome: cache.social.get(norm(l.nome)) } : l));
}

module.exports = { carregarNomesSociais, nomeSocial, nomeRegistro, aplicarNasLinhas, trocarNoTexto, trocarNoObjeto };
