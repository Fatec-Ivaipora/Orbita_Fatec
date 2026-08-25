const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('matriculas');

const COL_ALUNOS = 'matriculas_alunos';
const COL_CONFIG = 'matriculas_config';
const DOC_SEMESTRES = 'semestres';
const SEMESTRES_PADRAO = ['2026.1', '2026.2'];

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

// Sempre exige módulo+semestre antes de buscar — nunca lista sem filtro
// nenhum. Curso é opcional (permite ver "todos os cursos" pra filtrar por
// período/situação através do módulo inteiro) — mesmo com curso vazio, a
// paginação real no Firestore (limit + startAfter) evita trazer o módulo
// inteiro de uma vez (Fatec tem ~1500-1800 alunos/semestre).
router.get('/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { modulo, semestre, cursoId, situacao, planoConfissao, periodo } = req.query;
        if (!MODULOS.includes(modulo)) return res.status(400).json({ error: 'Informe o módulo (fatec ou medicina).' });
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });

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
            if (cursoId) query = query.where('cursoId', '==', cursoId);
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
        const { modulo, semestre, cursoId } = req.query;
        if (!MODULOS.includes(modulo)) return res.status(400).json({ error: 'Informe o módulo (fatec ou medicina).' });
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });

        let query = db.collection(COL_ALUNOS)
            .where('modulo', '==', modulo)
            .where('semestre', '==', semestre);
        if (cursoId) query = query.where('cursoId', '==', cursoId);
        const snap = await query.get();

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

// Lista de semestres pro seletor — sempre inclui os padrão + o que já foi
// criado via /virar-semestre, união (não substituição) pra nunca sumir
// semestre antigo do dropdown por causa de doc de config ainda não existir
// ou estar desatualizado.
router.get('/config/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const doc = await db.collection(COL_CONFIG).doc(DOC_SEMESTRES).get();
        const daBase = (doc.exists && Array.isArray(doc.data().lista)) ? doc.data().lista : [];
        const semestres = [...new Set([...SEMESTRES_PADRAO, ...daBase])].sort();
        res.json({ semestres });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// VIRADA DE SEMESTRE — copia pro próximo semestre só os alunos que a
// coordenação/financeiro escolheu manualmente na tela (não existe regra
// automática por situação decidindo quem continua — a pessoa que sabe quem
// vai ficar). O sistema só ajuda avançando o período (+1) e deixando a
// situação nova como "Não Assinou" (pendente de confirmar rematrícula ao
// longo do semestre que está abrindo). Os registros de origem não são
// tocados — continuam intactos como histórico/relatório do semestre que fechou.
// ==========================================
function avancarPeriodo(periodoOriginal) {
    const m = (periodoOriginal || '').trim().match(/^(\d+)º$/);
    if (!m) return periodoOriginal || ''; // "DP", vazio ou fora do padrão — não mexe, fica pra revisão manual
    return `${parseInt(m[1], 10) + 1}º`;
}

router.post('/virar-semestre', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestreOrigem = (req.body.semestreOrigem || '').trim();
        const semestreDestino = (req.body.semestreDestino || '').trim();
        const alunoIds = Array.isArray(req.body.alunoIds) ? [...new Set(req.body.alunoIds)] : [];
        // Overrides opcionais vindos da tela (período/situação editados linha a
        // linha antes de confirmar) — quem não vier aqui usa o padrão sugerido.
        const overrides = (req.body.overrides && typeof req.body.overrides === 'object') ? req.body.overrides : {};

        if (!validarSemestre(semestreOrigem)) return res.status(400).json({ error: 'Semestre de origem inválido.' });
        if (!validarSemestre(semestreDestino)) return res.status(400).json({ error: 'Informe o semestre de destino no formato AAAA.N (ex.: 2027.1).' });
        if (semestreDestino === semestreOrigem) return res.status(400).json({ error: 'O semestre de destino precisa ser diferente do de origem.' });
        if (!alunoIds.length) return res.status(400).json({ error: 'Selecione pelo menos um aluno.' });
        if (alunoIds.length > 3000) return res.status(400).json({ error: 'Selecione no máximo 3000 alunos por vez.' });

        const refs = alunoIds.map(id => db.collection(COL_ALUNOS).doc(id));
        const snaps = [];
        for (let i = 0; i < refs.length; i += 300) {
            const lote = await db.getAll(...refs.slice(i, i + 300));
            snaps.push(...lote);
        }

        const avisosPeriodo = [];
        const docsParaGravar = [];
        for (const snap of snaps) {
            if (!snap.exists) continue; // pode ter sido excluído entre carregar a tela e confirmar
            const origem = snap.data();
            if (origem.semestre !== semestreOrigem) continue; // proteção: só copia quem é realmente do semestre de origem informado

            const override = overrides[snap.id] || {};
            const periodoSugerido = avancarPeriodo(origem.periodo);
            if (periodoSugerido === origem.periodo && origem.periodo && override.periodo === undefined) avisosPeriodo.push(origem.nome);

            const periodoNovo = (override.periodo !== undefined && override.periodo !== null) ? override.periodo.toString().trim() : periodoSugerido;
            const situacaoNovaBruta = override.situacao;
            const situacaoNova = SITUACOES.includes(situacaoNovaBruta) ? situacaoNovaBruta : 'Não Assinou';

            docsParaGravar.push({
                modulo: origem.modulo,
                cursoId: origem.cursoId || null,
                curso: origem.curso,
                periodo: periodoNovo,
                nome: origem.nome,
                cidade: origem.cidade || '',
                telefone: origem.telefone || '',
                situacao: situacaoNova,
                planoConfissao: origem.planoConfissao || 'Não',
                observacoes: origem.observacoes || '',
                semestre: semestreDestino,
                origemAlunoId: snap.id,
                createdAt: new Date().toISOString(),
                createdBy: req.user.uid,
                updatedAt: new Date().toISOString()
            });
        }

        if (!docsParaGravar.length) return res.status(400).json({ error: 'Nenhum dos alunos selecionados pertence ao semestre de origem informado (recarregue a tela e tente de novo).' });

        for (let i = 0; i < docsParaGravar.length; i += 400) {
            const chunk = docsParaGravar.slice(i, i + 400);
            const batch = db.batch();
            chunk.forEach(dados => batch.set(db.collection(COL_ALUNOS).doc(), dados));
            await batch.commit();
        }

        await db.collection(COL_CONFIG).doc(DOC_SEMESTRES).set({
            lista: admin.firestore.FieldValue.arrayUnion(semestreOrigem, semestreDestino)
        }, { merge: true });

        res.json({ copiados: docsParaGravar.length, avisosPeriodo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
