const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================================================
// Relatório CPA (Comissão Própria de Avaliação). Lê do Firestore os resultados que
// scripts/cpa-edubox-sync.js agrega a partir do Edubox (o Edubox só aceita conexão do IP
// da Fatec). Nenhum dado que identifique aluno é guardado: só contagens, notas e comentários.
//
// Quem vê o quê:
//   adm_l1 / adm_l2       todos os cursos, a visão da IES (com comentários) e o resultado de cada professor
//   coordenador           só os cursos do próprio cadastro (users.cursos)
//   coord_medicina        só Medicina
//   Na visão da IES, quem não é ADM recebe só os números (sem comentários de outros cursos).
// ==========================================================================
const checkPermission = verifyToken.requireModulePermission('cpa');
const VE_TUDO = ['adm_l1', 'adm_l2'];

// id do curso no cadastro de Usuários (users.cursos) -> código do curso no Edubox
const CODCUR = {
    'agronegocio': 'AGRO', 'agronomia': 'AGRON', 'arquitetura-urbanismo': 'ARQUIT', 'biomedicina': 'BIOMED',
    'contabeis': 'CI.CONT', 'direito': 'DIR', 'enfermagem': 'ENFER', 'engenharia-civil': 'ENG.CIV',
    'fisioterapia': 'FISIO', 'gestao-comercial': 'GEST.COM', 'gestao-financeira': 'FINAN', 'logistica': 'LOG',
    'medicina': 'MED', 'medicina-veterinaria': 'MED.VET.', 'pedagogia': 'PED', 'psicologia': 'PSICO', 'rh': 'RH'
};

// null = todos; array = só esses códigos
async function escopoDe(req) {
    if (VE_TUDO.includes(req.user.role)) return null;
    if (req.user.role === 'coord_medicina') return ['MED'];
    const snap = await db.collection('users').doc(req.user.uid).get();
    const d = snap.exists ? snap.data() : {};
    const ids = Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
    return ids.map(i => CODCUR[i]).filter(Boolean);
}
const podeVer = (escopo, codcur) => escopo === null || escopo.includes(codcur);

// GET /api/cpa/ciclos — semestres/segmentos disponíveis, com os cursos que a pessoa pode ver
router.get('/ciclos', verifyToken, checkPermission, async (req, res) => {
    try {
        const escopo = await escopoDe(req);
        const [snap, cfg] = await Promise.all([db.collection('cpa_ciclos').get(), db.collection('config').doc('cpa').get()]);
        const ciclos = snap.docs.map(d => d.data()).map(c => ({
            ...c,
            cursos: (c.cursos || []).filter(x => podeVer(escopo, x.codcur)),
            // participação da IES inteira só para quem vê tudo; coordenador vê a dos próprios cursos
            participacao: escopo === null ? c.participacao : {
                ativos: (c.cursos || []).filter(x => podeVer(escopo, x.codcur)).reduce((s, x) => s + x.ativos, 0),
                responderam: (c.cursos || []).filter(x => podeVer(escopo, x.codcur)).reduce((s, x) => s + x.responderam, 0)
            }
        })).filter(c => c.cursos.length || escopo === null)
            .sort((a, b) => String(b.semestre).localeCompare(String(a.semestre)) || a.segmento.localeCompare(b.segmento));
        res.json({ ciclos, escopo: escopo === null ? 'todos' : 'cursos', podeEditarCapa: VE_TUDO.includes(req.user.role), capa: cfg.exists ? cfg.data() : {} });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cpa/relatorio/:codava/:curso — resultado dos alunos (curso ou "IES")
router.get('/relatorio/:codava/:curso', verifyToken, checkPermission, async (req, res) => {
    try {
        const { codava, curso } = req.params;
        const escopo = await escopoDe(req);
        if (curso === 'IES' ? false : !podeVer(escopo, curso)) return res.status(403).json({ error: 'Você não tem acesso a este curso.' });
        const snap = await db.collection('cpa_relatorios').doc(`${Number(codava)}__${curso}`).get();
        if (!snap.exists) return res.status(404).json({ error: 'Relatório não encontrado. Rode a sincronização da CPA.' });
        const r = snap.data();
        // Docentes/Administrativo (e a avaliação do coordenador) só para a direção
        if ((r.publico || 'A') !== 'A' && escopo !== null) return res.status(403).json({ error: 'Este resultado é restrito à direção.' });
        if (curso === 'IES' && escopo !== null) r.dimensoes.forEach(d => { d.comentarios = []; });   // comentários de outros cursos não vão para coordenador
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cpa/professores/:codava/:curso — avaliação de cada professor naquele curso (ou de todos os cursos: curso = "TODOS", só ADM)
router.get('/professores/:codava/:curso', verifyToken, checkPermission, async (req, res) => {
    try {
        const { codava, curso } = req.params;
        const escopo = await escopoDe(req);
        let q = db.collection('cpa_professores').where('codava', '==', Number(codava));
        if (curso !== 'TODOS') {
            if (!podeVer(escopo, curso)) return res.status(403).json({ error: 'Você não tem acesso a este curso.' });
            q = q.where('codcur', '==', curso);
        } else if (escopo !== null) {
            return res.status(403).json({ error: 'A visão de todos os cursos é restrita à direção.' });
        }
        const snap = await q.get();
        const professores = snap.docs.map(d => d.data()).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ professores });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/cpa/capa — dados de identificação que saem na capa do relatório (só ADM)
router.put('/capa', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!VE_TUDO.includes(req.user.role)) return res.status(403).json({ error: 'Só a direção edita os dados da capa.' });
        const campos = ['ies', 'mantenedora', 'endereco', 'atosLegais', 'presidenteCpa', 'portariaCpa', 'membros'];
        const dado = {};
        campos.forEach(c => { if (req.body[c] !== undefined) dado[c] = String(req.body[c]).slice(0, 2000); });
        await db.collection('config').doc('cpa').set(dado, { merge: true });
        res.json({ message: 'Dados da capa salvos.', capa: dado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports._interno = { escopoDe, podeVer, CODCUR };
