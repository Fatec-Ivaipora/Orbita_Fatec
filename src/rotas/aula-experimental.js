const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const confirmacaoEvento = require('./confirmacao-evento');
const agenda = require('./comercial-agenda');

// ==========================================
// AULA EXPERIMENTAL (Comercial) — agenda de quem vem assistir uma aula antes
// de se matricular: aluno, curso, dia/hora, quem do Comercial recebe e qual
// professor dá a aula. A tela monta as mensagens prontas (pro professor e pro
// aluno) a partir desses dados. Todo o setor vê e edita.
// Busca sempre por intervalo de datas no MESMO campo (`data`), sem orderBy
// de outro campo — não precisa de índice composto.
// ==========================================
const checkPermission = verifyToken.requireModulePermission('aula-experimental');
const COL = 'comercial_aulas_experimentais';
const STATUS = ['agendada', 'realizada', 'faltou', 'cancelada'];

const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const maiusculo = (v, max = 200) => texto(v, max).toUpperCase();
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const hora = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : '');

function quemFez(req) {
    return req.user.name || req.user.email || '';
}

function camposDoBody(body) {
    return {
        alunoNome: maiusculo(body.alunoNome, 150),
        alunoContato: texto(body.alunoContato, 60),
        curso: texto(body.curso, 80),
        data: data(body.data),
        horario: hora(body.horario),
        sala: texto(body.sala, 80),
        professor: texto(body.professor, 120),
        observacoes: texto(body.observacoes, 2000)
    };
}

// Quem recebe = pessoa(s) do Comercial marcada(s). `recebidoPor` (texto)
// fica com o(s) nome(s) pra exibir/filtrar e montar as mensagens.
async function recebeDoBody(body) {
    const responsaveis = await agenda.validarResponsaveis(body.responsaveisUids);
    return { responsaveis, recebidoPor: responsaveis.length ? responsaveis.map(r => r.nome).join(', ') : texto(body.recebidoPor, 80) };
}

// Mantém a atividade "receber aluno" na agenda (Meu Espaço) de quem recebe.
async function sincronizar(req, id, doc) {
    const detalhes = [
        doc.horario ? `Horário: ${doc.horario}` : 'Horário não definido',
        doc.professor && `Professor: ${doc.professor}`,
        doc.sala && `Sala: ${doc.sala}`,
        doc.alunoContato && `Telefone do aluno: ${doc.alunoContato}`,
        doc.observacoes && `Obs.: ${doc.observacoes}`,
        'Agendado em Comercial › Aula Experimental'
    ].filter(Boolean);
    const atividadeId = await agenda.sincronizarAtividade({
        atividadeId: doc.atividadeId || null,
        responsaveis: doc.responsaveis || [],
        ativo: doc.status !== 'cancelada',
        concluido: doc.status === 'realizada' || doc.status === 'faltou',
        titulo: `🎓 Receber aluno (aula experimental): ${doc.alunoNome}${doc.curso ? ` – ${doc.curso}` : ''}`,
        descricao: detalhes.join('\n'),
        data: doc.data,
        hora: doc.horario || '08:00',
        origem: { modulo: 'aula-experimental', id },
        criadoPor: { uid: req.user.uid, nome: quemFez(req) }
    });
    if (atividadeId !== (doc.atividadeId || null)) {
        await db.collection(COL).doc(id).update({ atividadeId });
    }
    return atividadeId;
}

router.get('/equipe', verifyToken, checkPermission, async (req, res) => {
    try { res.json(await agenda.equipeComercial()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista de cursos (mesma da Confirmação de Presença) + professores ativos no
// Edubox. O Edubox fora do ar não pode travar o cadastro — devolve só os
// cursos e a tela deixa digitar o professor à mão.
//
// Em produção (Vercel) o Edubox, que fica na rede da Fatec, não responde —
// sem limite a rota ficava ~16s pendurada esperando a conexão desistir, e a
// tela parecia travada ao abrir "Agendar aula" (29/09). Por isso: cursos têm
// rota própria e instantânea, e o Edubox tem no máximo 4s.
const EDUBOX_TIMEOUT_MS = 4000;

router.get('/cursos', verifyToken, checkPermission, (req, res) => {
    res.json(confirmacaoEvento.CURSOS);
});

router.get('/apoio', verifyToken, checkPermission, async (req, res) => {
    const cursos = confirmacaoEvento.CURSOS;
    try {
        const limite = new Promise((_, rej) => setTimeout(() => rej(new Error(`sem resposta em ${EDUBOX_TIMEOUT_MS / 1000}s`)), EDUBOX_TIMEOUT_MS));
        const { professores } = await Promise.race([confirmacaoEvento.buscarProfessoresAtivosEdubox(), limite]);
        res.json({ cursos, professores: professores.map(p => ({ nome: p.nome, cursoIds: p.cursoIds })), eduboxOk: true });
    } catch (err) {
        console.error('[aula-experimental] Edubox indisponível:', err.message);
        res.json({ cursos, professores: [], eduboxOk: false });
    }
});

// ?de=AAAA-MM-DD&ate=AAAA-MM-DD (ate opcional = "daqui pra frente")
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const de = data(req.query.de);
        const ate = data(req.query.ate);
        if (!de) return res.status(400).json({ error: 'Escolha o período.' });
        let q = db.collection(COL).where('data', '>=', de);
        if (ate) q = q.where('data', '<=', ate);
        const snap = await q.get();
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        lista.sort((a, b) => (a.data || '').localeCompare(b.data || '') || (a.horario || '').localeCompare(b.horario || ''));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const campos = camposDoBody(req.body);
        if (!campos.alunoNome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        if (!campos.data) return res.status(400).json({ error: 'Informe o dia da aula.' });
        const agora = new Date().toISOString();
        const doc = { ...campos, ...(await recebeDoBody(req.body)), status: 'agendada', atividadeId: null, createdAt: agora, createdBy: quemFez(req), updatedAt: agora, updatedBy: quemFez(req) };
        const ref = await db.collection(COL).add(doc);
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Agendamento não encontrado.' });
        const campos = camposDoBody(req.body);
        if (!campos.alunoNome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        if (!campos.data) return res.status(400).json({ error: 'Informe o dia da aula.' });
        const upd = { ...campos, ...(await recebeDoBody(req.body)), updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        if (STATUS.includes(req.body.status)) upd.status = req.body.status;
        await ref.update(upd);
        const doc = { ...snap.data(), ...upd };
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/status', verifyToken, checkPermission, async (req, res) => {
    try {
        const { status } = req.body;
        if (!STATUS.includes(status)) return res.status(400).json({ error: 'Situação inválida.' });
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Agendamento não encontrado.' });
        const upd = { status, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        await ref.update(upd);
        const doc = { ...snap.data(), ...upd };
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (snap.exists) await agenda.removerAtividade(snap.data().atividadeId);
        await ref.delete();
        res.json({ message: 'Agendamento removido.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
