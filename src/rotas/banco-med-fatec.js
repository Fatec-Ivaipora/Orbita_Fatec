const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { gerarMoodleXml } = require('../utils/moodleXml');

const COL_CATEGORIAS = 'banco_med_categorias';
const COL_QUESTOES = 'banco_med_questoes';
const COL_PROVAS = 'banco_med_provas';

const checkPermission = verifyToken.requireModulePermission('banco-med-fatec');

const DIFICULDADES_VALIDAS = ['facil', 'media', 'intermediaria', 'dificil'];
const TIPOS_VALIDOS = ['multichoice_unica', 'multichoice_multipla', 'verdadeiro_falso'];

// Limite seguro de documento do Firestore (1 MiB) — mesmo padrão já usado
// no módulo Ferida para imagens comprimidas no navegador.
const MAX_IMG_BASE64 = 950000;

function validarQuestao(body) {
    if (!body.titulo || !String(body.titulo).trim()) return 'Informe o título da questão.';
    if (!body.categoriaId) return 'Selecione a categoria/disciplina da questão.';
    if (!DIFICULDADES_VALIDAS.includes(body.dificuldade)) return 'Selecione uma dificuldade válida.';
    if (!TIPOS_VALIDOS.includes(body.tipoMoodle)) return 'Selecione um tipo de questão válido.';
    if (!body.enunciadoHtml || !String(body.enunciadoHtml).trim()) return 'Informe o enunciado da questão.';
    if (!Array.isArray(body.alternativas) || body.alternativas.length < 2) return 'Informe pelo menos duas alternativas.';
    if (!body.alternativas.some(a => a.correta)) return 'Marque ao menos uma alternativa como correta.';
    if (body.tipoMoodle === 'multichoice_unica' && body.alternativas.filter(a => a.correta).length !== 1) {
        return 'Questão de alternativa única precisa ter exatamente uma alternativa correta.';
    }
    if (body.tipoMoodle === 'verdadeiro_falso' && body.alternativas.length !== 2) {
        return 'Questão Verdadeiro/Falso precisa ter exatamente duas alternativas (Verdadeiro e Falso).';
    }
    if (body.imagem && body.imagem.dataUrl && body.imagem.dataUrl.length > MAX_IMG_BASE64) {
        return 'Imagem grande demais mesmo após compressão. Tente uma imagem menor.';
    }
    return null;
}

// ==========================================
// CATEGORIAS (disciplina / prova-modelo)
// ==========================================

router.get('/categorias', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_CATEGORIAS).get();
        const categorias = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Ordena por período (1º a 12º) e, dentro do mesmo período, por nome —
        // reflete a grade real do curso (série/semestre), não ordem alfabética solta.
        categorias.sort((a, b) => (a.periodo - b.periodo) || a.nome.localeCompare(b.nome));
        res.json(categorias);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/categorias', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = String(req.body.nome || '').trim();
        const periodo = parseInt(req.body.periodo, 10);
        if (!nome) return res.status(400).json({ error: 'Informe o nome da disciplina.' });
        if (!Number.isInteger(periodo) || periodo < 1 || periodo > 12) {
            return res.status(400).json({ error: 'Selecione o período (1º a 12º) da disciplina.' });
        }

        const newDoc = db.collection(COL_CATEGORIAS).doc();
        await newDoc.set({
            nome,
            periodo,
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: new Date().toISOString()
        });
        res.status(201).json({ message: 'Categoria criada!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// QUESTÕES (banco compartilhado)
// ==========================================

router.get('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_QUESTOES).get();
        const questoes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        questoes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(questoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const erro = validarQuestao(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const { titulo, categoriaId, dificuldade, tipoMoodle, enunciadoHtml, alternativas, justificativa, fonte, imagem } = req.body;

        const newDoc = db.collection(COL_QUESTOES).doc();
        await newDoc.set({
            titulo: String(titulo).trim(),
            categoriaId,
            dificuldade,
            tipoMoodle,
            enunciadoHtml,
            alternativas: alternativas.map(a => ({ texto: String(a.texto || ''), correta: !!a.correta })),
            justificativa: justificativa || '',
            fonte: fonte || '',
            imagem: (imagem && imagem.dataUrl) ? { nome: imagem.nome || 'imagem', dataUrl: imagem.dataUrl } : null,
            status: 'publicada',
            elaboradoPor: req.user.name || req.user.email || 'Professor',
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        res.status(201).json({ message: 'Questão salva no banco!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_QUESTOES).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });

        const erro = validarQuestao(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const { titulo, categoriaId, dificuldade, tipoMoodle, enunciadoHtml, alternativas, justificativa, fonte, imagem } = req.body;

        await docRef.update({
            titulo: String(titulo).trim(),
            categoriaId,
            dificuldade,
            tipoMoodle,
            enunciadoHtml,
            alternativas: alternativas.map(a => ({ texto: String(a.texto || ''), correta: !!a.correta })),
            justificativa: justificativa || '',
            fonte: fonte || '',
            imagem: (imagem && imagem.dataUrl) ? { nome: imagem.nome || 'imagem', dataUrl: imagem.dataUrl } : null,
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Questão atualizada!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_QUESTOES).doc(req.params.id).delete();
        res.json({ message: 'Questão removida do banco.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// PROVAS (conjunto de questões salvo, exportável)
// ==========================================

router.get('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_PROVAS).get();
        const provas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        provas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(provas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome da prova.' });
        if (!req.body.categoriaId) return res.status(400).json({ error: 'Selecione a categoria/disciplina da prova.' });

        const newDoc = db.collection(COL_PROVAS).doc();
        await newDoc.set({
            nome,
            categoriaId: req.body.categoriaId,
            questoesIds: Array.isArray(req.body.questoesIds) ? req.body.questoesIds : [],
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            exportacoes: []
        });
        res.status(201).json({ message: 'Prova criada!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/provas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_PROVAS).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });

        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome da prova.' });

        await docRef.update({
            nome,
            categoriaId: req.body.categoriaId || snap.data().categoriaId,
            questoesIds: Array.isArray(req.body.questoesIds) ? req.body.questoesIds : snap.data().questoesIds,
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Prova atualizada!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/provas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_PROVAS).doc(req.params.id).delete();
        res.json({ message: 'Prova removida.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/banco-med-fatec/provas/:id/exportar — gera o Moodle XML com as
// questões da prova, na ordem salva, e devolve como arquivo pra download.
router.get('/provas/:id/exportar', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_PROVAS).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        const prova = snap.data();

        if (!prova.questoesIds || !prova.questoesIds.length) {
            return res.status(400).json({ error: 'Esta prova ainda não tem nenhuma questão selecionada.' });
        }

        const questaoDocs = await Promise.all(
            prova.questoesIds.map(qid => db.collection(COL_QUESTOES).doc(qid).get())
        );
        const questoes = questaoDocs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() }));

        if (!questoes.length) {
            return res.status(400).json({ error: 'Nenhuma das questões desta prova foi encontrada no banco (podem ter sido removidas).' });
        }

        const xml = gerarMoodleXml(prova.nome, questoes);

        await docRef.update({
            exportacoes: [...(prova.exportacoes || []), {
                por: req.user.uid,
                porNome: req.user.name || req.user.email || 'Professor',
                em: new Date().toISOString()
            }]
        });

        const nomeArquivo = `${prova.nome.replace(/[^a-zA-Z0-9._ -]/g, '_')}.xml`;
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
        res.send(xml);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
