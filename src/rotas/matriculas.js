const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('matriculas');

const COL_ALUNOS = 'matriculas_alunos';

// Situação e Plano/Confissão são SELECT fixo (não texto livre) — é exatamente
// isso que substitui a bagunça de digitação da planilha original (variações
// como "Cancelou2025.2", "Trancou.2026.1", "Matrícula Nova – Assinada" com
// travessão diferente). Semestre já é campo próprio, então não entra aqui.
const SITUACOES = [
    'Matrícula Nova', 'Matrícula Nova - Assinada', 'Rematrícula Assinada',
    'Pendência Financeira', 'Não Assinou', 'Cancelou', 'Trancou',
    '1ª Evasão', '2ª Evasão', 'Transferência', 'Retorno', 'Reprovado',
    'Mudança de Curso', 'Formando', 'Desistente'
];

// Mesma lógica: o valor não carrega o semestre (a própria planilha original
// prova que isso quebra — a aba "Matriz Fatec 2026.2" ainda tem cotas de
// PROUNI escritas como "PROUNI INTEGRAL 2026.1", esquecidas na duplicação da aba).
const PLANOS_CONFISSAO = [
    'Não', 'Sim', 'PROUNI Integral', 'PROUNI Parcial',
    'PROUNI Integral (Anos Anteriores)', 'PROUNI Parcial (Anos Anteriores)', 'Pravaler'
];

const MODULOS = ['fatec', 'medicina'];

const ALUNOS_PAGE_SIZE_PADRAO = 30;

function validarSemestre(semestre) {
    return /^\d{4}\.\d$/.test(semestre || '');
}

// ==========================================
// ALUNOS (matrículas)
// ==========================================

// Sempre exige módulo+semestre (e curso, quando módulo = fatec) antes de
// buscar — mesma regra de economia de leitura já usada em Licitação: nunca
// listar sem filtro, e paginar de verdade no Firestore (limit + startAfter)
// em vez de trazer o módulo inteiro de uma vez (Fatec tem ~2000 alunos/semestre).
router.get('/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { modulo, semestre, cursoId, situacao, planoConfissao, periodo } = req.query;
        if (!MODULOS.includes(modulo)) return res.status(400).json({ error: 'Informe o módulo (fatec ou medicina).' });
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });
        if (modulo === 'fatec' && !cursoId) return res.status(400).json({ error: 'Informe o curso.' });

        const pageSize = Math.min(parseInt(req.query.pageSize, 10) || ALUNOS_PAGE_SIZE_PADRAO, 200);

        // Filtros de situação/plano são aplicados em memória durante a paginação
        // (mesmo padrão do "pula item fechado" já usado em /financeiro/itens) —
        // evita precisar de um índice composto novo pra cada combinação possível
        // de filtro, já que a query-base (módulo+semestre[+curso]) já é enxuta.
        const passaNoFiltro = (a) =>
            (!situacao || a.situacao === situacao) &&
            (!planoConfissao || a.planoConfissao === planoConfissao) &&
            (!periodo || a.periodo === periodo);

        let cursor = (req.query.cursorNome && req.query.cursorId)
            ? { nome: req.query.cursorNome, id: req.query.cursorId }
            : null;
        const docsPagina = [];
        let hasMore = false;

        while (docsPagina.length < pageSize) {
            let query = db.collection(COL_ALUNOS)
                .where('modulo', '==', modulo)
                .where('semestre', '==', semestre);
            if (modulo === 'fatec') query = query.where('cursoId', '==', cursoId);
            query = query.orderBy('nome').orderBy(admin.firestore.FieldPath.documentId());

            if (cursor) query = query.startAfter(cursor.nome, cursor.id);

            const lote = await query.limit(pageSize + 1).get();
            if (lote.empty) break;

            const docsLote = lote.docs.slice(0, pageSize);
            hasMore = lote.docs.length > pageSize;

            let paradaNoMeio = false;
            for (const d of docsLote) {
                if (docsPagina.length >= pageSize) { paradaNoMeio = true; break; }
                if (passaNoFiltro(d.data())) docsPagina.push(d);
                cursor = { nome: d.data().nome, id: d.id };
            }

            if (paradaNoMeio) { hasMore = true; break; }
            if (!hasMore) break;
        }

        res.json({
            alunos: docsPagina.map(d => ({ id: d.id, ...d.data() })),
            hasMore,
            nextCursor: hasMore ? cursor : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { modulo, cursoId, curso, periodo, nome, cidade, telefone, situacao, planoConfissao, observacoes } = req.body;
        const semestre = (req.body.semestre || '').trim();

        if (!MODULOS.includes(modulo)) return res.status(400).json({ error: 'Informe o módulo (fatec ou medicina).' });
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });
        if (!nome || !nome.trim()) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        if (!SITUACOES.includes(situacao)) return res.status(400).json({ error: 'Situação inválida.' });
        if (planoConfissao !== undefined && planoConfissao !== '' && !PLANOS_CONFISSAO.includes(planoConfissao)) {
            return res.status(400).json({ error: 'Plano/Confissão inválido.' });
        }
        if (modulo === 'fatec' && (!cursoId || !curso)) return res.status(400).json({ error: 'Informe o curso.' });

        const dados = {
            modulo,
            cursoId: modulo === 'fatec' ? cursoId : null,
            curso: modulo === 'fatec' ? curso : 'Medicina',
            periodo: (periodo || '').trim(),
            nome: nome.trim(),
            cidade: (cidade || '').trim(),
            telefone: (telefone || '').trim(),
            situacao,
            planoConfissao: planoConfissao || 'Não',
            observacoes: (observacoes || '').trim(),
            semestre,
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid,
            updatedAt: new Date().toISOString()
        };
        const docRef = await db.collection(COL_ALUNOS).add(dados);
        res.status(201).json({ id: docRef.id, message: 'Aluno cadastrado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/alunos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cursoId, curso, periodo, nome, cidade, telefone, situacao, planoConfissao, observacoes } = req.body;
        const dados = { updatedAt: new Date().toISOString() };

        if (nome !== undefined) {
            if (!nome.trim()) return res.status(400).json({ error: 'Informe o nome do aluno.' });
            dados.nome = nome.trim();
        }
        if (situacao !== undefined) {
            if (!SITUACOES.includes(situacao)) return res.status(400).json({ error: 'Situação inválida.' });
            dados.situacao = situacao;
        }
        if (planoConfissao !== undefined) {
            if (planoConfissao !== '' && !PLANOS_CONFISSAO.includes(planoConfissao)) {
                return res.status(400).json({ error: 'Plano/Confissão inválido.' });
            }
            dados.planoConfissao = planoConfissao || 'Não';
        }
        if (periodo !== undefined) dados.periodo = (periodo || '').trim();
        if (cidade !== undefined) dados.cidade = (cidade || '').trim();
        if (telefone !== undefined) dados.telefone = (telefone || '').trim();
        if (observacoes !== undefined) dados.observacoes = (observacoes || '').trim();
        if (cursoId !== undefined && curso !== undefined) {
            dados.cursoId = cursoId;
            dados.curso = curso;
        }

        // Depois que a linha migrada da planilha ganha uma situação/plano válido
        // (revisão manual feita), some da lista de "pendente de revisão".
        if (dados.situacao !== undefined && dados.planoConfissao !== undefined) {
            dados.revisarManualmente = false;
        }

        await db.collection(COL_ALUNOS).doc(req.params.id).update(dados);
        res.json({ message: 'Aluno atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/alunos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_ALUNOS).doc(req.params.id).delete();
        res.json({ message: 'Aluno excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// RELATÓRIO — calculado a partir do que foi lançado, nunca digitado à mão.
// Uma única query filtrada (módulo+semestre) e agregação em memória, mesmo
// padrão do /financeiro/relatorio já existente.
// ==========================================
router.get('/relatorio', verifyToken, checkPermission, async (req, res) => {
    try {
        const { modulo, semestre } = req.query;
        if (!MODULOS.includes(modulo)) return res.status(400).json({ error: 'Informe o módulo (fatec ou medicina).' });
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });

        const snap = await db.collection(COL_ALUNOS)
            .where('modulo', '==', modulo)
            .where('semestre', '==', semestre)
            .get();

        const porCursoSituacao = {}; // curso -> situacao -> contagem
        const porSituacaoTotal = {};
        const porPlano = {};
        let total = 0;
        let pendentesRevisao = 0;

        snap.forEach(doc => {
            const a = doc.data();
            total++;
            if (a.revisarManualmente) pendentesRevisao++;

            const curso = a.curso || '—';
            if (!porCursoSituacao[curso]) porCursoSituacao[curso] = {};
            porCursoSituacao[curso][a.situacao] = (porCursoSituacao[curso][a.situacao] || 0) + 1;
            porSituacaoTotal[a.situacao] = (porSituacaoTotal[a.situacao] || 0) + 1;
            porPlano[a.planoConfissao] = (porPlano[a.planoConfissao] || 0) + 1;
        });

        res.json({
            total,
            pendentesRevisao,
            cursos: Object.keys(porCursoSituacao).sort((a, b) => a.localeCompare(b)),
            porCursoSituacao,
            porSituacaoTotal,
            porPlano,
            situacoes: SITUACOES,
            planosConfissao: PLANOS_CONFISSAO
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/config/opcoes', verifyToken, checkPermission, async (req, res) => {
    res.json({ situacoes: SITUACOES, planosConfissao: PLANOS_CONFISSAO });
});

module.exports = router;
