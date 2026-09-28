const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

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
            semestre,
            status,
            createdAt: agora,
            createdBy: quemFez(req),
            updatedAt: agora,
            updatedBy: quemFez(req)
        };
        const ref = await db.collection(COL).add(doc);
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
        const upd = { ...campos, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        await ref.update(upd);
        res.json({ id: ref.id, ...snap.data(), ...upd });
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
        res.json({ id: ref.id, ...snap.data(), ...upd });
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
        await db.collection(COL).doc(req.params.id).delete();
        res.json({ message: 'Registro removido.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
