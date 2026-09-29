const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const agenda = require('./comercial-agenda');

// ==========================================
// CONTRATOS (Comercial) — controle de assinatura de contrato dos alunos
// matriculados, no mesmo formato da planilha "MATRÍCULAS FATEC - CONTROLE
// DE ASSINATURA" que o setor usava: uma aba por situação (sem assinatura /
// assinado / desistente), por semestre. Todo mundo do setor vê e edita tudo.
// Sempre filtrado por semestre (where simples, sem índice composto) — a tela
// só busca depois que a pessoa escolhe o semestre, pra não gastar leitura.
// ==========================================
const checkPermission = verifyToken.requireModulePermission('contratos');
const COL = 'comercial_contratos';
const STATUS = ['sem_assinatura', 'assinado', 'desistente'];

const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const maiusculo = (v, max = 200) => texto(v, max).toUpperCase();
// Datas sempre como string AAAA-MM-DD (input type=date) — nada de Date/ISO
// com hora, senão o fuso joga o dia pra trás na exibição.
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const semestreValido = (v) => /^\d{4}\.[12]$/.test(v || '');

function quemFez(req) {
    return req.user.name || req.user.email || '';
}

// Campos editáveis pelo formulário (nome/curso/cidade em MAIÚSCULO, igual
// à planilha).
function camposDoBody(body) {
    return {
        nome: maiusculo(body.nome, 150),
        dataMatricula: data(body.dataMatricula),
        curso: maiusculo(body.curso, 80),
        cidade: maiusculo(body.cidade, 80),
        contato: texto(body.contato, 60),
        observacoes: texto(body.observacoes, 4000),
        vencimentoBoleto: data(body.vencimentoBoleto),
        menor18: body.menor18 === true,
        assinadoPor: texto(body.assinadoPor, 60),
        assinadoEm: data(body.assinadoEm)
    };
}

// Coleta de assinatura: quem do Comercial vai coletar e quando. Vira
// compromisso na agenda de todo o setor (comercial-agenda.js) enquanto o
// aluno está "sem assinatura"; assinou → concluída; desistiu/excluído → sai.
async function coletaDoBody(body) {
    const [resp] = await agenda.validarResponsaveis(body.coletaResponsavelUid ? [body.coletaResponsavelUid] : []);
    const data = /^\d{4}-\d{2}-\d{2}$/.test(body.coletaData || '') ? body.coletaData : null;
    const hora = /^\d{2}:\d{2}$/.test(body.coletaHora || '') ? body.coletaHora : '';
    if (!resp || !data) return { coletaResponsavel: null, coletaData: null, coletaHora: '', coletaLocal: '' };
    return { coletaResponsavel: resp, coletaData: data, coletaHora: hora, coletaLocal: texto(body.coletaLocal, 120) };
}

async function sincronizarColeta(req, id, doc) {
    const detalhes = [
        doc.coletaHora ? `Horário: ${doc.coletaHora}` : 'Horário não definido',
        doc.coletaLocal && `Local: ${doc.coletaLocal}`,
        doc.curso && `Curso: ${doc.curso}`,
        doc.contato && `Telefone: ${doc.contato}`,
        doc.menor18 && 'Menor de 18 — contrato assinado pelo responsável',
        `Semestre ${doc.semestre} — Comercial › Contratos`
    ].filter(Boolean);
    const atividadeId = await agenda.sincronizarAtividade({
        atividadeId: doc.atividadeId || null,
        responsaveis: doc.coletaResponsavel ? [doc.coletaResponsavel] : [],
        ativo: doc.status !== 'desistente',
        concluido: doc.status === 'assinado',
        titulo: `✍️ Coleta de assinatura: ${doc.nome}`,
        descricao: detalhes.join('\n'),
        data: doc.coletaData,
        hora: doc.coletaHora || '08:00',
        origem: { modulo: 'contratos', id },
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

// Semestres que aparecem no seletor — lista controlada pelo próprio setor
// (botão "+ Novo semestre"), guardada num doc só. Começa em 2026.2/2027.1:
// os anteriores não aparecem, a pedido do usuário (29/09). 2026.2 fica porque
// há aluno lançado como 2027.1 que na verdade já estuda no 2026.2.
const DOC_SEMESTRES = db.collection('config').doc('comercial_contratos');
const SEMESTRES_INICIAIS = ['2027.1', '2026.2'];

async function listaSemestres() {
    const snap = await DOC_SEMESTRES.get();
    const lista = snap.exists && Array.isArray(snap.data().semestres) ? snap.data().semestres : SEMESTRES_INICIAIS;
    return [...new Set(lista)].sort((a, b) => b.localeCompare(a));
}

router.get('/semestres', verifyToken, checkPermission, async (req, res) => {
    try { res.json(await listaSemestres()); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = texto(req.body.semestre, 6);
        if (!semestreValido(semestre)) return res.status(400).json({ error: 'Use o formato AAAA.1 ou AAAA.2 (ex.: 2027.2).' });
        const atuais = await listaSemestres();
        if (atuais.includes(semestre)) return res.status(400).json({ error: `O semestre ${semestre} já existe.` });
        const semestres = [...atuais, semestre].sort((a, b) => b.localeCompare(a));
        await DOC_SEMESTRES.set({ semestres, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) }, { merge: true });
        res.status(201).json(semestres);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const { semestre } = req.query;
        if (!semestreValido(semestre)) return res.status(400).json({ error: 'Escolha o semestre.' });
        const snap = await db.collection(COL).where('semestre', '==', semestre).get();
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        lista.sort((a, b) => (a.dataMatricula || '').localeCompare(b.dataMatricula || '') || (a.nome || '').localeCompare(b.nome || ''));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const { semestre } = req.body;
        if (!semestreValido(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const campos = camposDoBody(req.body);
        if (!campos.nome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        const status = STATUS.includes(req.body.status) ? req.body.status : 'sem_assinatura';
        const agora = new Date().toISOString();
        const doc = {
            ...campos,
            ...(await coletaDoBody(req.body)),
            semestre,
            status,
            atividadeId: null,
            createdAt: agora,
            createdBy: quemFez(req),
            updatedAt: agora,
            updatedBy: quemFez(req)
        };
        const ref = await db.collection(COL).add(doc);
        doc.atividadeId = await sincronizarColeta(req, ref.id, doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Registro não encontrado.' });
        const campos = camposDoBody(req.body);
        if (!campos.nome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        const upd = { ...campos, ...(await coletaDoBody(req.body)), updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        // Mudar o aluno de semestre (ex.: matrícula passou pro semestre seguinte).
        if (req.body.semestre && req.body.semestre !== snap.data().semestre) {
            if (!(await listaSemestres()).includes(req.body.semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
            upd.semestre = req.body.semestre;
        }
        await ref.update(upd);
        const doc = { ...snap.data(), ...upd };
        doc.atividadeId = await sincronizarColeta(req, ref.id, doc);
        res.json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Troca de aba (situação). Marcar "assinado" grava quem registrou e a data
// (equivalente ao "CLEV 21/09" da planilha) — dá pra corrigir depois no
// formulário.
router.patch('/:id/status', verifyToken, checkPermission, async (req, res) => {
    try {
        const { status } = req.body;
        if (!STATUS.includes(status)) return res.status(400).json({ error: 'Situação inválida.' });
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Registro não encontrado.' });
        const upd = { status, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        if (status === 'assinado' && !snap.data().assinadoEm) {
            upd.assinadoPor = quemFez(req);
            upd.assinadoEm = data(req.body.hoje) || new Date().toISOString().slice(0, 10);
        }
        await ref.update(upd);
        const doc = { ...snap.data(), ...upd };
        doc.atividadeId = await sincronizarColeta(req, ref.id, doc);
        res.json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// "Registrar contato" — acrescenta uma linha no topo das observações
// (a planilha já era usada como histórico: "1º contato 17/09 - email").
router.post('/:id/contato', verifyToken, checkPermission, async (req, res) => {
    try {
        const nota = texto(req.body.texto, 500);
        if (!nota) return res.status(400).json({ error: 'Escreva o que foi feito no contato.' });
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Registro não encontrado.' });
        const dia = data(req.body.hoje) || new Date().toISOString().slice(0, 10);
        const [a, m, d] = dia.split('-');
        const primeiroNome = quemFez(req).split(/[\s@]/)[0].toUpperCase();
        const linha = `${d}/${m}/${a} - ${primeiroNome}: ${nota}`;
        const anteriores = snap.data().observacoes || '';
        const observacoes = (anteriores ? `${linha}\n${anteriores}` : linha).slice(0, 4000);
        const upd = { observacoes, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        await ref.update(upd);
        res.json({ id: ref.id, ...snap.data(), ...upd });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (snap.exists) await agenda.removerAtividade(snap.data().atividadeId);
        await ref.delete();
        res.json({ message: 'Registro removido.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
