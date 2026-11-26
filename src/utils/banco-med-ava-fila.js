// ==========================================================================
// Fila do Banco MED → banco de questões do AVA, por QUESTÃO (25/11/2026).
//
// O processo do professor termina no Órbita: ele escreve ou importa as questões dele na prova e pronto.
// Quem leva para o AVA é a secretaria (agente automático + tela "Envio ao AVA").
//
// Uma questão está PRONTA para o AVA quando:
//   - a prova foi finalizada (vai tudo o que ainda não foi); ou
//   - o professor dela cumpriu a parte dele na prova, mesmo com a prova em montagem: tem pelo menos a cota
//     definida para ele nos critérios da disciplina (porProfessor) e todas as questões dele estão no padrão.
//     Professor sem cota definida só vai quando a prova for finalizada.
// Já está NO AVA quando está em avaliacao.avaBanco.enviadas, ou quando o professor marcou antes (fluxo antigo)
// "Subi no banco de questões do AVA" (envios[professor].bancoAva) — essas não voltam para a fila.
//
// Questões de reserva (2ª chamada / exame / DP no banco, fora de uma avaliação) não entram: só o que está montado na prova.
// ==========================================================================
const { db } = require('../firebase');
const Padrao = require('../../banco-med-fatec/padrao');

const COL_AV = 'banco_med_avaliacoes';
const COL_Q = 'banco_med_questoes';
const COL_CRIT = 'banco_med_criterios';

const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const chaveEnvio = (nome) => normNome(nome).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
const semestreAtual = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };
const rotuloProva = (a) => (a.tipo === 'exame' ? 'Exame semestral' : `${a.bimestre}º bimestre · ${a.chamada}ª chamada`);

async function lerQuestoes(ids) {
    if (!ids || !ids.length) return [];
    const docs = await db.getAll(...ids.map(id => db.collection(COL_Q).doc(id)));
    return docs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() }));
}

// situação de UMA avaliação: o que já está no AVA, o que está pronto e quem ainda falta
async function situacaoDaAvaliacao(av, critCache = new Map()) {
    if (!critCache.has(av.chave)) critCache.set(av.chave, db.collection(COL_CRIT).doc(String(av.chave || '-')).get().then(s => (s.exists ? s.data() : {})).catch(() => ({})));
    const crit = await critCache.get(av.chave);
    const metaDe = (nome) => { const e = Object.entries(crit.porProfessor || {}).find(([n]) => normNome(n) === normNome(nome)); return e ? Number(e[1]) : null; };
    const fin = av.status === 'finalizada';
    const questoes = await lerQuestoes(av.questoesIds || []);
    const ab = av.avaBanco || {};
    // questão trazida do AVA (Trazer do AVA, 26/11/2026) já está lá: conta como enviada e nunca volta para a fila —
    // senão, com a prova finalizada, o envio poderia importar de novo no banco do questionário (duplicada)
    const enviadas = new Set([...(ab.enviadas || []), ...questoes.filter(q => q.avaOrigem && q.avaOrigem.id).map(q => q.id)]);

    // por professor
    const grupos = new Map();
    for (const q of questoes) {
        const nome = q.professorNome || q.elaboradoPor || 'Sem professor';
        const k = normNome(nome);
        if (!grupos.has(k)) grupos.set(k, { nome, questoes: [] });
        grupos.get(k).questoes.push(q);
    }
    const professores = [];
    const prontas = [];
    for (const [k, g] of grupos) {
        const marcou = (av.envios || {})[chaveEnvio(g.nome)];
        const subiuSozinho = !!(marcou && marcou.bancoAva && marcou.bancoAva.feito);
        const meta = metaDe(g.nome);
        const aCorrigir = g.questoes.filter(q => !Padrao.avaliarQuestao(q).ok).length;
        const cumpriu = !!meta && g.questoes.length >= meta && !aCorrigir;
        const noAva = g.questoes.filter(q => enviadas.has(q.id) || subiuSozinho);
        const faltam = g.questoes.filter(q => !enviadas.has(q.id) && !subiuSozinho);
        const pronto = fin || cumpriu;
        if (pronto) prontas.push(...faltam.map(q => q.id));
        professores.push({
            nome: g.nome, chave: k, feitas: g.questoes.length, meta, aCorrigir, cumpriu, subiuSozinho,
            noAva: noAva.length, prontas: pronto ? faltam.length : 0,
            aguardando: pronto ? 0 : faltam.length
        });
    }
    professores.sort((a, b) => a.nome.localeCompare(b.nome));
    // já no AVA = enviadas registradas + as dos professores que marcaram sozinhos (só as que ainda estão na prova)
    const jaNoAva = questoes.filter(q => enviadas.has(q.id) || professores.find(p => p.chave === normNome(q.professorNome || q.elaboradoPor || 'Sem professor')).subiuSozinho).map(q => q.id);
    // ordem da prova (o número no AVA é a posição na prova: [2ºB 1ªCH 07])
    const pos = new Map((av.questoesIds || []).map((id, i) => [id, i]));
    prontas.sort((a, b) => pos.get(a) - pos.get(b));
    let situacao;
    if (!questoes.length) situacao = 'vazia';
    else if (ab.status === 'conferir' && prontas.length) situacao = 'conferir';
    else if (ab.status === 'erro' && prontas.length) situacao = 'erro';
    else if (prontas.length) situacao = 'pronta';
    else if (jaNoAva.length === questoes.length) situacao = 'no_ava';
    else situacao = 'aguardando';
    return {
        id: av.id, chave: av.chave, disciplina: av.disciplina, sigla: av.sigla || '', semestre: av.semestre, tipo: av.tipo || '',
        bimestre: av.bimestre || 0, chamada: av.chamada || 0, prova: rotuloProva(av), status: av.status,
        total: questoes.length, qtdProva: crit.qtdQuestoes || null, jaNoAva: jaNoAva.length, prontas, situacao, professores,
        ava: { status: ab.status || null, msg: ab.msg || '', em: ab.em || null, curso: ab.curso || '', cursoId: ab.cursoId || null, quiz: ab.quiz || '', cmid: ab.cmid || null, por: ab.por || '', quadro: ab.quadro || null, colocar: ab.colocar || null }
    };
}

// todas as avaliações do semestre
async function situacaoDoSemestre(semestre = semestreAtual()) {
    const snap = await db.collection(COL_AV).where('semestre', '==', semestre).get();
    const critCache = new Map();
    const lista = await Promise.all(snap.docs.map(d => situacaoDaAvaliacao({ id: d.id, ...d.data() }, critCache)));
    const ordem = (a) => (a.tipo === 'exame' ? 99 : a.bimestre * 10 + a.chamada);
    return lista.sort((a, b) => String(a.disciplina).localeCompare(String(b.disciplina)) || ordem(a) - ordem(b));
}

// Questão que foi para o AVA entra no banco da disciplina (rascunho da prova → publicada). Antes (17/11/2026) isso
// acontecia quando o professor baixava o arquivo dele; agora acontece quando o envio ao AVA é registrado.
async function publicarNoBanco(ids, por) {
    const qs = await lerQuestoes(ids);
    const agora = new Date().toISOString();
    const lote = db.batch();
    const paraPublicar = qs.filter(q => q.status === 'rascunho_avaliacao');
    paraPublicar.forEach(q => lote.update(db.collection(COL_Q).doc(q.id), { status: 'publicada', publicadaNoEnvio: true, publicadaEm: agora, padronizadaEm: agora, padronizadaPor: por, updatedAt: agora }));
    if (paraPublicar.length) await lote.commit();
    return paraPublicar.length;
}

module.exports = { publicarNoBanco, situacaoDaAvaliacao, situacaoDoSemestre, semestreAtual, normNome, chaveEnvio, COL_AV };
