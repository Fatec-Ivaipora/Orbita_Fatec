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

// Resolve o período (1-12) da disciplina, pra gravar de forma denormalizada
// em cada questão — sem isso, filtrar o banco por período no GET /questoes
// exigiria ler a coleção inteira e cruzar com categorias no código (o custo
// de leitura que estávamos tentando evitar).
async function periodoDaCategoria(categoriaId) {
    if (!categoriaId) return null;
    const snap = await db.collection(COL_CATEGORIAS).doc(categoriaId).get();
    return snap.exists ? (snap.data().periodo ?? null) : null;
}

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

        // Contagem de questões publicadas por disciplina — usa count() agregado
        // (não lê os documentos, só o total), pra mostrar na lista sem quebrar a
        // economia de leitura do banco.
        await Promise.all(categorias.map(async (c) => {
            const agg = await db.collection(COL_QUESTOES)
                .where('categoriaId', '==', c.id)
                .where('status', '==', 'publicada')
                .count().get();
            c.totalQuestoes = agg.data().count;
        }));

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
            nomeBreve: req.body.nomeBreve ? String(req.body.nomeBreve).trim() : '',
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

// GET /questoes — SEMPRE espera pelo menos um filtro (periodo, categoriaId
// ou status) vindo do cliente. O banco pode crescer bastante (importação do
// AVA traz dezenas por vez), então nunca lemos a coleção inteira aqui — só o
// pedaço que a tela realmente precisa mostrar naquele momento.
router.get('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        let query = db.collection(COL_QUESTOES);
        if (req.query.periodo) query = query.where('periodo', '==', parseInt(req.query.periodo, 10));
        if (req.query.categoriaId) query = query.where('categoriaId', '==', req.query.categoriaId);
        if (req.query.status) query = query.where('status', '==', req.query.status);

        const snap = await query.get();
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
        const periodo = await periodoDaCategoria(categoriaId);

        const newDoc = db.collection(COL_QUESTOES).doc();
        await newDoc.set({
            titulo: String(titulo).trim(),
            categoriaId,
            periodo,
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
        const periodo = await periodoDaCategoria(categoriaId);

        await docRef.update({
            titulo: String(titulo).trim(),
            categoriaId,
            periodo,
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
// IMPORTAÇÃO DO AVA (Moodle XML já parseado no navegador)
// ==========================================
// O parsing do XML acontece no cliente (DOMParser) — aqui só recebemos as
// questões já normalizadas pro nosso formato. Toda questão importada entra
// com status 'revisao_importacao' (nunca aparece no banco/prova até alguém
// confirmar manualmente a disciplina correta — pedido do professor: "põe
// numa fila de revisão").

function validarQuestaoImportada(q) {
    if (!q.titulo || !String(q.titulo).trim()) return 'Questão sem título.';
    if (!TIPOS_VALIDOS.includes(q.tipoMoodle)) return `Tipo de questão inválido para "${q.titulo}".`;
    if (!Array.isArray(q.alternativas) || q.alternativas.length < 2) return `Alternativas insuficientes em "${q.titulo}".`;
    if (!q.alternativas.some(a => a.correta)) return `Nenhuma alternativa correta identificada em "${q.titulo}".`;
    if (q.imagem && q.imagem.dataUrl && q.imagem.dataUrl.length > MAX_IMG_BASE64) return `Imagem grande demais em "${q.titulo}".`;
    return null;
}

// Normaliza título+enunciado pra comparação de duplicata: tira tag HTML,
// acento e espaço extra. Duas questões só contam como "a mesma" se título E
// enunciado baterem depois dessa normalização — evita falso-positivo entre
// questões parecidas mas com enunciados diferentes.
function normalizarComparacao(str) {
    return String(str || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}
function chaveDuplicata(q) {
    return `${normalizarComparacao(q.titulo)}|${normalizarComparacao(q.enunciadoHtml)}`;
}

router.post('/questoes/importar-lote', verifyToken, checkPermission, async (req, res) => {
    try {
        const categoriaSugeridaTexto = String(req.body.categoriaSugeridaTexto || '').trim();
        const questoesRecebidas = Array.isArray(req.body.questoes) ? req.body.questoes : [];
        if (!questoesRecebidas.length) return res.status(400).json({ error: 'Nenhuma questão encontrada nesse arquivo.' });

        // Todo o banco (publicada ou ainda em revisão) entra na comparação —
        // não faz sentido reimportar uma questão que já está esperando revisão.
        const existentesSnap = await db.collection(COL_QUESTOES).get();
        const chavesExistentes = new Set(existentesSnap.docs.map(d => chaveDuplicata(d.data())));

        const loteId = db.collection(COL_QUESTOES).doc().id;
        const erros = [];
        const duplicadas = [];
        const validas = [];

        questoesRecebidas.forEach(q => {
            const erro = validarQuestaoImportada(q);
            if (erro) { erros.push({ titulo: q.titulo || '(sem título)', motivo: erro }); return; }

            const chave = chaveDuplicata(q);
            if (chavesExistentes.has(chave)) { duplicadas.push(q.titulo || '(sem título)'); return; }
            chavesExistentes.add(chave); // pega duplicata repetida dentro do próprio arquivo também

            validas.push(q);
        });

        // Firestore aceita no máx. 500 operações por batch — corta em pedaços
        // por segurança (um arquivo de disciplina real dificilmente chega perto disso).
        for (let i = 0; i < validas.length; i += 400) {
            const pedaco = validas.slice(i, i + 400);
            const batch = db.batch();
            pedaco.forEach(q => {
                const ref = db.collection(COL_QUESTOES).doc();
                batch.set(ref, {
                    titulo: String(q.titulo).trim(),
                    categoriaId: null,
                    categoriaSugeridaTexto,
                    loteId,
                    dificuldade: DIFICULDADES_VALIDAS.includes(q.dificuldade) ? q.dificuldade : 'media',
                    tipoMoodle: q.tipoMoodle,
                    enunciadoHtml: q.enunciadoHtml || '',
                    alternativas: q.alternativas.map(a => ({ texto: String(a.texto || ''), correta: !!a.correta })),
                    justificativa: q.justificativa || '',
                    fonte: q.fonte || '',
                    imagem: (q.imagem && q.imagem.dataUrl) ? { nome: q.imagem.nome || 'imagem', dataUrl: q.imagem.dataUrl } : null,
                    status: 'revisao_importacao',
                    elaboradoPor: q.elaboradoPor || 'Importado do AVA',
                    criadoPor: req.user.uid,
                    criadoPorNome: req.user.name || req.user.email || 'Professor',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            });
            await batch.commit();
        }

        res.status(201).json({ loteId, criadas: validas.length, duplicadas, erros });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /questoes/lote/:loteId/resolver — confirma a disciplina certa pra
// todas as questões daquele lote de importação de uma vez, e elas passam a
// aparecer no banco normal.
router.put('/questoes/lote/:loteId/resolver', verifyToken, checkPermission, async (req, res) => {
    try {
        const { categoriaId } = req.body;
        if (!categoriaId) return res.status(400).json({ error: 'Selecione a disciplina antes de confirmar.' });
        const periodo = await periodoDaCategoria(categoriaId);

        const snap = await db.collection(COL_QUESTOES)
            .where('loteId', '==', req.params.loteId)
            .where('status', '==', 'revisao_importacao')
            .get();
        if (snap.empty) return res.status(404).json({ error: 'Lote de importação não encontrado (ou já resolvido).' });

        const batch = db.batch();
        snap.docs.forEach(doc => batch.update(doc.ref, { categoriaId, periodo, status: 'publicada', updatedAt: new Date().toISOString() }));
        await batch.commit();

        res.json({ message: 'Disciplina confirmada!', atualizadas: snap.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /questoes/lote/:loteId — descarta o lote inteiro (o professor
// decidiu que essas questões importadas não devem entrar no banco).
router.delete('/questoes/lote/:loteId', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_QUESTOES)
            .where('loteId', '==', req.params.loteId)
            .where('status', '==', 'revisao_importacao')
            .get();
        if (snap.empty) return res.status(404).json({ error: 'Lote de importação não encontrado (ou já resolvido).' });

        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();

        res.json({ message: 'Lote descartado.', removidas: snap.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// PROVAS (privada por professor — só quem criou vê/mexe; o banco de
// questões continua compartilhado. Pedido do professor: "restrito a cada
// professor as provas que eu criei, só eu vejo, pra não ficar poluído a
// tela" — ADM N1 é a única exceção, mesmo bypass de todo módulo do sistema.)
// ==========================================

function apenasProprias(role) {
    return role !== 'adm_l1';
}

router.get('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        let query = db.collection(COL_PROVAS);
        if (apenasProprias(req.user.role)) {
            query = query.where('criadoPor', '==', req.user.uid);
        }
        const snap = await query.get();
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
        const semestre = String(req.body.semestre || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome da prova.' });
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre de aplicação da prova (ex: 2026.1).' });
        if (!req.body.categoriaId) return res.status(400).json({ error: 'Selecione a categoria/disciplina da prova.' });

        const newDoc = db.collection(COL_PROVAS).doc();
        await newDoc.set({
            nome,
            semestre,
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
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode editar as provas que você mesmo criou.' });
        }

        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome da prova.' });

        await docRef.update({
            nome,
            semestre: req.body.semestre !== undefined ? String(req.body.semestre).trim() : snap.data().semestre,
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
        const docRef = db.collection(COL_PROVAS).doc(req.params.id);
        if (apenasProprias(req.user.role)) {
            const snap = await docRef.get();
            if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
            if (snap.data().criadoPor !== req.user.uid) {
                return res.status(403).json({ error: 'Você só pode remover as provas que você mesmo criou.' });
            }
        }
        await docRef.delete();
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
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode exportar as provas que você mesmo criou.' });
        }
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
