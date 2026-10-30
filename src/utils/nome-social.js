// ==========================================
// Nome social (28/10/2026) — o Edubox só tem o nome de registro do aluno. Quem usa nome social
// fica cadastrado em config/nomes_sociais.alunos = [{ ra, nomeRegistro, nomeSocial, curso, em, por }]
// e o Órbita mostra o nome social em tudo: os robôs do CADD e da Cobrança trocam o nome ao copiar do
// Edubox (scripts/cad-edubox-sync.js e cobranca-edubox-sync.js, na função q), e o que busca no Edubox
// pelo nome (rota de coleta) volta pro nome de registro só na hora de consultar.
// Comparação sem acento/pontuação, nome completo — não troca nome parecido.
// ==========================================
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

let cache = null; // { em, social: Map(registro → social), registro: Map(social → registro) }

async function carregarNomesSociais() {
    if (cache && Date.now() - cache.em < 10 * 60 * 1000) return cache;
    const { db } = require('../firebase');
    const s = await db.collection('config').doc('nomes_sociais').get();
    const lista = s.exists && Array.isArray(s.data().alunos) ? s.data().alunos : [];
    cache = {
        em: Date.now(),
        social: new Map(lista.filter(a => a.nomeRegistro && a.nomeSocial).map(a => [norm(a.nomeRegistro), a.nomeSocial])),
        registro: new Map(lista.filter(a => a.nomeRegistro && a.nomeSocial).map(a => [norm(a.nomeSocial), a.nomeRegistro]))
    };
    return cache;
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

module.exports = { carregarNomesSociais, nomeSocial, nomeRegistro, aplicarNasLinhas };
