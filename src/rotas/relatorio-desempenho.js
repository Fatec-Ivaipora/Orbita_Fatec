const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { parseEstatisticas, analisar, sugerirCabecalho, ErroDeLeitura, calibracao, CALIBRACAO_PADRAO, SITUACOES } = require('../utils/parseEstatisticasAva');

const COL = 'banco_med_relatorios';
const checkPermission = verifyToken.requireModulePermission('relatorio-desempenho');

// Limite seguro de documento do Firestore (1 MiB). Uma prova de 45 questões
// com as alternativas todas fica em torno de 40 KB, então só estoura com um
// export fora do comum — melhor recusar com mensagem clara do que deixar o
// Firestore rejeitar a escrita.
const MAX_DOC_BYTES = 950000;

// Mesma regra de visibilidade das provas do BANCO MED-FATEC: o relatório de
// desempenho é uma leitura da prova DAQUELE professor, então cada um enxerga
// só os seus. Coordenação da Medicina e ADM N1 enxergam todos, pra conseguir
// olhar a disciplina como um todo.
function apenasProprios(role, user) {
    // + a responsável pelas avaliações da Medicina (users.avaliacoesMed, 12/11/2026) vê todos
    return role !== 'adm_l1' && role !== 'coord_medicina' && !(user && user.avaliacoesMed);
}
const podeCalibrar = (user) => user.role === 'adm_l1' || user.role === 'coord_medicina' || user.avaliacoesMed === true;

// ---- Calibração da lista de revisão (12/11/2026) — cortes em banco_med_config/desempenho ----
// Padrão em src/utils/parseEstatisticasAva.js (CALIBRACAO_PADRAO). Ao salvar, os relatórios já gravados são
// recalculados (a classificação fica guardada no documento pra listagem não ler as questões).
const DOC_CAL = () => db.collection('banco_med_config').doc('desempenho');
let calCache = null;
async function lerCalibracao() {
    if (calCache && Date.now() - calCache.em < 60000) return calCache.valor;
    const s = await DOC_CAL().get();
    const valor = calibracao(s.exists ? s.data().calibracao : null);
    calCache = { em: Date.now(), valor, meta: s.exists ? { por: s.data().atualizadoPor, em: s.data().atualizadoEm } : null };
    return valor;
}

// Campos que o docente pode corrigir no cabeçalho depois de gerado
// ("IA prepara, humano confirma" — o export do AVA nem sempre traz o nome do
// professor nem a turma certa).
const CAMPOS_EDITAVEIS = [
    'titulo', 'cursoTurma', 'professor', 'aplicacao', 'encerramento',
    'disciplina', 'disciplinaId', 'periodo', 'semestre', 'turma'
];

// O resumo é o que a listagem mostra — guardado pronto no documento pra
// listar sem precisar ler as 45 questões de cada relatório.
function montarResumo(analise) {
    return {
        total: analise.resumo.total,
        contagens: analise.resumo.contagens,
        discriminacaoMedia: analise.resumo.discriminacaoMedia,
        facilidadeMedia: analise.resumo.facilidadeMedia,
        boasOuExcelentes: analise.resumo.boasOuExcelentes,
        paraRevisar: analise.resumo.paraRevisar,
        comAlternativas: analise.resumo.comAlternativas,
        porSituacao: analise.resumo.porSituacao,
        faceis: analise.resumo.faceis
    };
}

const CAMPOS_LISTA = [
    'titulo', 'cursoTurma', 'disciplina', 'disciplinaId', 'periodo', 'semestre',
    'turma', 'professor', 'aplicacao', 'encerramento', 'nAlunos', 'notaMedia',
    'desvioPadrao', 'consistenciaInterna', 'resumo', 'nomeArquivo',
    'criadoPor', 'criadoPorNome', 'createdAt', 'updatedAt'
];

// Base64 do corpo → Buffer; responde o erro e devolve null se não der.
function lerArquivoDoCorpo(req, res) {
    const { arquivoBase64, nomeArquivo } = req.body || {};
    if (!arquivoBase64 || !nomeArquivo) {
        res.status(400).json({ error: 'Envie o arquivo exportado do AVA.' });
        return null;
    }
    let buffer;
    try {
        // Aceita tanto o base64 puro quanto o data URL que o FileReader gera.
        const limpo = String(arquivoBase64).replace(/^data:[^;]*;base64,/, '');
        buffer = Buffer.from(limpo, 'base64');
    } catch (e) {
        res.status(400).json({ error: 'Arquivo inválido ou corrompido.' });
        return null;
    }
    if (!buffer.length) {
        res.status(400).json({ error: 'O arquivo enviado está vazio.' });
        return null;
    }
    return buffer;
}

// ---- POST /previa — lê o arquivo SEM gravar: devolve o cabeçalho que dá
// pra preencher sozinho (disciplina, turma, semestre...) e os avisos, pro
// professor conferir antes de gerar (25/09). ----
router.post('/previa', verifyToken, checkPermission, async (req, res) => {
    try {
        const buffer = lerArquivoDoCorpo(req, res);
        if (!buffer) return;
        const lido = await Promise.resolve(parseEstatisticas(buffer, req.body.nomeArquivo));
        const meta = lido.meta || {};
        res.json({
            sugestao: sugerirCabecalho(meta),
            aplicacao: meta.aplicacao || '',
            nAlunos: meta.nAlunos !== undefined ? meta.nAlunos : null,
            totalQuestoes: lido.questoes.length,
            comAlternativas: lido.questoes.filter(q => (q.alternativas || []).length).length,
            avisos: lido.avisos || []
        });
    } catch (err) {
        if (err instanceof ErroDeLeitura) return res.status(422).json({ error: err.message });
        console.error('Erro na prévia das estatísticas do AVA:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- POST /  — processa o export do AVA e grava o relatório ----
router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const { nomeArquivo } = req.body || {};
        const buffer = lerArquivoDoCorpo(req, res);
        if (!buffer) return;

        // O parser devolve uma Promise só no caminho do PDF (pdf-parse é async).
        const lido = await Promise.resolve(parseEstatisticas(buffer, nomeArquivo));
        const analise = analisar(lido.questoes, await lerCalibracao());

        const meta = lido.meta || {};
        const agora = new Date().toISOString();

        const doc = {
            // Cabeçalho: o que veio do AVA, com o que o docente informou na tela
            // por cima (o formulário vence o export, nunca o contrário).
            titulo: req.body.titulo || meta.titulo || 'Avaliação sem título',
            cursoTurma: req.body.cursoTurma || meta.cursoTurma || '',
            disciplina: req.body.disciplina || '',
            disciplinaId: req.body.disciplinaId || null,
            periodo: req.body.periodo || null,
            semestre: req.body.semestre || '',
            turma: req.body.turma || '',
            professor: req.body.professor || '',
            aplicacao: req.body.aplicacao || meta.aplicacao || '',
            encerramento: req.body.encerramento || meta.encerramento || '',
            nAlunos: meta.nAlunos !== undefined ? meta.nAlunos : null,
            notaMedia: meta.notaMedia !== undefined ? meta.notaMedia : null,
            desvioPadrao: meta.desvioPadrao !== undefined ? meta.desvioPadrao : null,
            consistenciaInterna: meta.consistenciaInterna !== undefined ? meta.consistenciaInterna : null,

            questoes: analise.questoes,
            resumo: montarResumo(analise),
            // Ex.: export cortado pelo AVA — aparece no topo do relatório.
            avisos: lido.avisos || [],

            nomeArquivo: String(nomeArquivo).slice(0, 180),
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: agora,
            updatedAt: agora
        };

        const tamanho = Buffer.byteLength(JSON.stringify(doc), 'utf8');
        if (tamanho > MAX_DOC_BYTES) {
            return res.status(413).json({
                error: `O relatório ficou grande demais para ser salvo (${Math.round(tamanho / 1024)} KB). ` +
                       'Gere o export do AVA por bloco de questões, ou avise a T.I.'
            });
        }

        const ref = db.collection(COL).doc();
        await ref.set(doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) {
        if (err instanceof ErroDeLeitura) return res.status(422).json({ error: err.message });
        console.error('Erro ao processar estatísticas do AVA:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- GET /  — listagem (sem as questões, só o cabeçalho e o resumo) ----
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        let query = db.collection(COL);
        if (apenasProprios(req.user.role, req.user)) {
            query = query.where('criadoPor', '==', req.user.uid);
        }
        const snap = await query.select(...CAMPOS_LISTA).get();
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        lista.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        res.json(lista);
    } catch (err) {
        console.error('Erro ao listar relatórios de desempenho:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- GET /calibracao — cortes atuais (e o padrão) ----
router.get('/calibracao', verifyToken, checkPermission, async (req, res) => {
    try {
        const valor = await lerCalibracao();
        res.json({ calibracao: valor, padrao: CALIBRACAO_PADRAO, situacoes: SITUACOES, podeEditar: podeCalibrar(req.user), atualizado: calCache && calCache.meta });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PUT /calibracao — só a responsável pelas avaliações / coordenação / ADM; recalcula os relatórios ----
router.put('/calibracao', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!podeCalibrar(req.user)) return res.status(403).json({ error: 'Só a responsável pelas avaliações e a coordenação de Medicina ajustam a calibração.' });
        const valor = calibracao(req.body && req.body.calibracao);
        const agora = new Date().toISOString();
        await DOC_CAL().set({ calibracao: valor, atualizadoPor: req.user.name || req.user.email || 'Usuário', atualizadoEm: agora });
        calCache = null;
        const snap = await db.collection(COL).get();
        let n = 0;
        for (let i = 0; i < snap.docs.length; i += 400) {
            const batch = db.batch();
            snap.docs.slice(i, i + 400).forEach(d => {
                const analise = analisar(d.data().questoes || [], valor);
                batch.update(d.ref, { questoes: analise.questoes, resumo: montarResumo(analise), recalculadoEm: agora });
                n++;
            });
            await batch.commit();
        }
        res.json({ message: `Calibração salva. ${n} relatório(s) recalculado(s).`, calibracao: valor });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET /:id  — relatório completo ----
router.get('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Relatório não encontrado.' });
        const dados = snap.data();
        if (apenasProprios(req.user.role, req.user) && dados.criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Este relatório é de outro professor.' });
        }
        res.json({ id: snap.id, ...dados });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- PUT /:id  — só o cabeçalho; os números vindos do AVA não se editam ----
router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Relatório não encontrado.' });
        if (apenasProprios(req.user.role, req.user) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Este relatório é de outro professor.' });
        }

        const dados = { updatedAt: new Date().toISOString() };
        for (const campo of CAMPOS_EDITAVEIS) {
            if (req.body[campo] !== undefined) dados[campo] = req.body[campo];
        }
        await ref.update(dados);
        res.json({ id: req.params.id, ...snap.data(), ...dados });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- DELETE /:id ----
router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Relatório não encontrado.' });
        if (apenasProprios(req.user.role, req.user) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Este relatório é de outro professor.' });
        }
        await ref.delete();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
