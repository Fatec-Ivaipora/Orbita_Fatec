const { db } = require('../firebase');

// ==========================================
// Ligação dos módulos do Comercial (Aulões, Aula Experimental) com a agenda
// de cada colaborador no Meu Espaço (coleção `atividades`). Quem é marcado
// como responsável ganha uma atividade no dia/horário do agendamento; a
// atividade acompanha o agendamento (edição, realizado, cancelado, excluído).
// O agendamento guarda `atividadeId`; a atividade guarda `origem`
// ({ modulo, id }) — é por aí que uma acha a outra.
// ==========================================

const SETOR_COMERCIAL = 'comercial';

// Horário padrão quando o agendamento só tem turno (ou nada).
const HORA_POR_TURNO = { 'MANHÃ': '08:00', 'MANHÃ E TARDE': '08:00', 'DIA TODO': '08:00', 'TARDE': '13:30', 'TARDE E NOITE': '13:30', 'NOITE': '19:00' };

// Equipe do Comercial (quem pode ser marcado como responsável). Poucos docs.
async function equipeComercial() {
    const snap = await db.collection('users').where('setorId', '==', SETOR_COMERCIAL).get();
    return snap.docs
        .map(d => ({ uid: d.id, nome: d.data().name || d.data().email || '', ativo: d.data().ativo !== false }))
        .filter(p => p.ativo)
        .sort((a, b) => a.nome.localeCompare(b.nome));
}

// Só aceita uids que são mesmo da equipe; devolve [{uid, nome}] na ordem pedida.
async function validarResponsaveis(uids) {
    const lista = [...new Set((Array.isArray(uids) ? uids : []).filter(u => typeof u === 'string' && u))].slice(0, 20);
    if (!lista.length) return [];
    const snaps = await db.getAll(...lista.map(u => db.collection('users').doc(u)));
    return snaps
        .filter(s => s.exists && s.data().ativo !== false && s.data().setorId === SETOR_COMERCIAL)
        .map(s => ({ uid: s.id, nome: s.data().name || s.data().email || '' }));
}

// 'AAAA-MM-DD' + 'HH:MM' no horário de Brasília -> ISO (mesmo formato do
// `prazo` que o Meu Espaço grava).
function prazoIso(data, hora) {
    return new Date(`${data}T${hora || '08:00'}:00-03:00`).toISOString();
}

/**
 * Cria/atualiza/remove a atividade ligada a um agendamento.
 * @param {object} p
 *   p.atividadeId  id atual (ou null)
 *   p.responsaveis [{uid, nome}] — vazio => remove a atividade
 *   p.ativo        false (cancelado) => remove a atividade
 *   p.concluido    true => status 'concluido'
 *   p.titulo, p.descricao, p.data, p.hora, p.origem {modulo,id}, p.criadoPor {uid,nome}
 * @returns novo atividadeId (ou null)
 */
async function sincronizarAtividade(p) {
    const col = db.collection('atividades');
    const ref = p.atividadeId ? col.doc(p.atividadeId) : null;
    const existe = ref ? (await ref.get()).exists : false;

    if (!p.responsaveis.length || p.ativo === false || !p.data) {
        if (existe) await ref.delete();
        return null;
    }

    const agora = new Date().toISOString();
    const uids = p.responsaveis.map(r => r.uid);
    const quem = uids.length === 1
        ? { uid: uids[0], atribuidos: null, setorId: SETOR_COMERCIAL }
        : { uid: null, atribuidos: uids, setorId: null };
    const dados = {
        titulo: p.titulo,
        descricao: p.descricao,
        prazo: prazoIso(p.data, p.hora),
        status: p.concluido ? 'concluido' : 'a_fazer',
        concluidoEm: p.concluido ? agora : null,
        origem: p.origem,
        tipo: 'pontual',
        ...quem,
        updatedAt: agora
    };

    if (existe) {
        await ref.update(dados);
        return ref.id;
    }
    const novo = await col.add({
        ...dados,
        historico: [],
        criadoPor: p.criadoPor.uid,
        criadoPorNome: p.criadoPor.nome,
        createdAt: agora
    });
    return novo.id;
}

async function removerAtividade(atividadeId) {
    if (!atividadeId) return;
    const ref = db.collection('atividades').doc(atividadeId);
    if ((await ref.get()).exists) await ref.delete();
}

module.exports = { equipeComercial, validarResponsaveis, sincronizarAtividade, removerAtividade, HORA_POR_TURNO };
