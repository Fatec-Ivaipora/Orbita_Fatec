const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('licitacao');

const COL_FORNECEDORES = 'financeiro_fornecedores';
const COL_ITENS = 'financeiro_itens';

// Coordenador tem nível de execução no módulo (cadastra/edita itens), mas não
// pode ver preços/fornecedores/relatório — isso é restrito ao financeiro/admin.
// Não dá pra expressar essa granularidade no nível view/execute genérico do
// RBAC, então bloqueia explicitamente por cargo aqui.
function bloquearCoordenador(req, res, next) {
    if (req.user.role === 'coordenador') {
        return res.status(403).json({ error: 'Coordenadores não têm acesso a preços, fornecedores ou relatórios — apenas ao cadastro de itens.' });
    }
    next();
}

const COL_CONFIG = 'config';
const DOC_CONFIG_FINANCEIRO = 'financeiro';

async function getSemestreAtivo() {
    const snap = await db.collection(COL_CONFIG).doc(DOC_CONFIG_FINANCEIRO).get();
    return (snap.exists && snap.data().semestreAtivoCoordenador) || null;
}

// ==========================================
// CONFIGURAÇÃO (semestre que os coordenadores enxergam)
// ==========================================
router.get('/config', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestreAtivoCoordenador = await getSemestreAtivo();
        res.json({ semestreAtivoCoordenador });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/config/semestre-ativo', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const semestre = (req.body.semestre || '').trim();
        if (!/^\d{4}\.\d$/.test(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });

        await db.collection(COL_CONFIG).doc(DOC_CONFIG_FINANCEIRO).set({ semestreAtivoCoordenador: semestre }, { merge: true });
        res.json({ message: 'Semestre ativo atualizado.', semestreAtivoCoordenador: semestre });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CURSOS (proxy somente-leitura de `courses`, já usada pelo Planejamento Acadêmico)
// ==========================================
router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    try {
        // Coleção pequena (dezenas de cursos) — filtra/ordena em memória em vez de
        // exigir índice composto do Firestore para where+orderBy em campos diferentes.
        const snap = await db.collection('courses').get();
        const cursos = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(c => c.active)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        res.json(cursos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// FORNECEDORES
// ==========================================
router.get('/fornecedores', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const snap = await db.collection(COL_FORNECEDORES).orderBy('nome').get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/fornecedores', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });

        const docRef = await db.collection(COL_FORNECEDORES).add({
            nome,
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid
        });
        res.status(201).json({ id: docRef.id, message: 'Fornecedor cadastrado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/fornecedores/:id', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });

        await db.collection(COL_FORNECEDORES).doc(req.params.id).update({ nome });
        res.json({ message: 'Fornecedor atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/fornecedores/:id', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        await db.collection(COL_FORNECEDORES).doc(req.params.id).delete();
        res.json({ message: 'Fornecedor excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ITENS (licitação/cotações)
// ==========================================

function calcularCotacoes(cotacoesInput, quantidade, fornecedoresPorId) {
    if (!Array.isArray(cotacoesInput)) return [];
    return cotacoesInput
        .filter(c => c && c.fornecedorId && c.valorUnitario !== null && c.valorUnitario !== undefined && c.valorUnitario !== '')
        .map(c => {
            const valorUnitario = parseFloat(c.valorUnitario);
            const fornecedor = fornecedoresPorId[c.fornecedorId];
            return {
                fornecedorId: c.fornecedorId,
                fornecedorNome: fornecedor ? fornecedor.nome : (c.fornecedorNome || ''),
                valorUnitario,
                valorTotal: Math.round(valorUnitario * quantidade * 100) / 100
            };
        })
        .filter(c => !isNaN(c.valorUnitario) && c.valorUnitario >= 0);
}

const ITENS_PAGE_SIZE_PADRAO = 30;

router.get('/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cursoId, cursorProduto, cursorId } = req.query;
        if (!cursoId) return res.status(400).json({ error: 'Informe o cursoId.' });

        // Coordenador só enxerga o semestre configurado como ativo — travado
        // aqui no servidor, ignorando qualquer semestre que venha na URL.
        let semestre = req.query.semestre;
        if (req.user.role === 'coordenador') {
            semestre = await getSemestreAtivo();
            if (!semestre) return res.status(409).json({ error: 'O financeiro ainda não configurou o semestre ativo.' });
        }
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });

        const pageSize = Math.min(parseInt(req.query.pageSize, 10) || ITENS_PAGE_SIZE_PADRAO, 200);

        // Pagina de verdade no Firestore (limit + startAfter) em vez de trazer o
        // curso inteiro numa tarada só — turmas com 150-200+ itens (ex.: Biomedicina,
        // Medicina) estavam gastando uma cota de leitura enorme só pra abrir a tela.
        // orderBy(produto) + orderBy(__name__) garante ordenação estável mesmo com
        // produtos de nome repetido (existem casos assim cadastrados).
        //
        // Item "fechado" não aparece nessa tela (já foi decidido, só atrapalha a
        // gestão do que ainda tá em cotação) — como isso exigiria mais um índice
        // composto pra filtrar direto no Firestore, busca em lotes e pula os
        // fechados até completar a página (ou acabar os dados do curso).
        let cursor = (cursorProduto && cursorId) ? { produto: cursorProduto, id: cursorId } : null;
        const docsPagina = [];
        let hasMore = false;

        while (docsPagina.length < pageSize) {
            let query = db.collection(COL_ITENS)
                .where('cursoId', '==', cursoId)
                .where('semestre', '==', semestre)
                .orderBy('produto')
                .orderBy(admin.firestore.FieldPath.documentId());

            if (cursor) query = query.startAfter(cursor.produto, cursor.id);

            const lote = await query.limit(pageSize + 1).get();
            if (lote.empty) break;

            const docsLote = lote.docs.slice(0, pageSize);
            hasMore = lote.docs.length > pageSize;

            // Percorre o lote parando exatamente no doc onde a página encheu — o
            // cursor tem que apontar pra esse doc (mesmo que tenha sido pulado
            // por ser "fechado"), nunca pro último do lote inteiro. Senão, os
            // docs que sobravam depois de a página encher no MEIO do lote
            // ficavam perdidos pra sempre (cursor pulava eles sem nunca voltar).
            let paradaNoMeio = false;
            for (const d of docsLote) {
                if (docsPagina.length >= pageSize) { paradaNoMeio = true; break; }
                if (d.data().status !== 'fechado') docsPagina.push(d);
                cursor = { produto: d.data().produto, id: d.id };
            }

            if (paradaNoMeio) { hasMore = true; break; }
            if (!hasMore) break;
        }

        let itens = docsPagina.map(d => ({ id: d.id, ...d.data() }));

        // Coordenador não pode ver preços/fornecedores — remove no servidor, não
        // só na tela (senão daria pra ver inspecionando a chamada da API).
        if (req.user.role === 'coordenador') {
            itens = itens.map(({ cotacoes, ...resto }) => ({ ...resto, temCotacao: (cotacoes || []).length > 0 }));
        }

        res.json({
            itens,
            hasMore,
            nextCursor: hasMore ? cursor : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Busca um item só — usado depois de salvar cotações, pra atualizar só aquele
// item na tela sem recarregar a lista inteira do curso de novo.
router.get('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const doc = await db.collection(COL_ITENS).doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Item não encontrado.' });

        let item = { id: doc.id, ...doc.data() };
        if (req.user.role === 'coordenador') {
            const { cotacoes, ...resto } = item;
            item = { ...resto, temCotacao: (cotacoes || []).length > 0 };
        }
        res.json(item);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cursoId, curso, produto, quantidade, unidade, periodicidade, professor, linkReferencia } = req.body;
        if (!cursoId || !curso) return res.status(400).json({ error: 'Informe o curso.' });
        if (!produto || !produto.trim()) return res.status(400).json({ error: 'Informe o produto.' });

        // Coordenador só cadastra no semestre ativo — travado no servidor,
        // ignorando qualquer semestre que venha do cliente.
        let semestre;
        if (req.user.role === 'coordenador') {
            semestre = await getSemestreAtivo();
            if (!semestre) return res.status(409).json({ error: 'O financeiro ainda não configurou o semestre ativo.' });
        } else {
            semestre = (req.body.semestre || '').trim();
            if (!/^\d{4}\.\d$/.test(semestre)) return res.status(400).json({ error: 'Informe o semestre no formato AAAA.N (ex.: 2026.2).' });
        }

        const qtd = parseFloat(quantidade);
        const docRef = await db.collection(COL_ITENS).add({
            cursoId,
            curso,
            semestre,
            produto: produto.trim(),
            quantidade: !isNaN(qtd) && qtd > 0 ? qtd : 1,
            unidade: (unidade || '').trim(),
            periodicidade: (periodicidade || '').trim(),
            professor: (professor || '').trim(),
            linkReferencia: (linkReferencia || '').trim(),
            status: 'pendente',
            cotacoes: [],
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid,
            updatedAt: new Date().toISOString()
        });
        res.status(201).json({ id: docRef.id, message: 'Item cadastrado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Coordenador só mexe em itens do semestre ativo — mesmo que ele tenha o id de
// um item de outro semestre (ex.: guardado de antes da troca), bloqueia aqui.
async function bloquearSeForaDoSemestreAtivo(req, itemId) {
    if (req.user.role !== 'coordenador') return null;
    const doc = await db.collection(COL_ITENS).doc(itemId).get();
    if (!doc.exists) return { status: 404, error: 'Item não encontrado.' };
    const semestreAtivo = await getSemestreAtivo();
    if (doc.data().semestre !== semestreAtivo) {
        return { status: 403, error: 'Este item não é do semestre ativo.' };
    }
    return null;
}

router.put('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const bloqueio = await bloquearSeForaDoSemestreAtivo(req, req.params.id);
        if (bloqueio) return res.status(bloqueio.status).json({ error: bloqueio.error });

        const { produto, quantidade, unidade, periodicidade, professor, linkReferencia, status } = req.body;
        const dados = { updatedAt: new Date().toISOString() };

        if (produto !== undefined) {
            if (!produto.trim()) return res.status(400).json({ error: 'Informe o produto.' });
            dados.produto = produto.trim();
        }
        if (quantidade !== undefined) {
            const qtd = parseFloat(quantidade);
            dados.quantidade = !isNaN(qtd) && qtd > 0 ? qtd : 1;
        }
        if (unidade !== undefined) dados.unidade = (unidade || '').trim();
        if (periodicidade !== undefined) dados.periodicidade = (periodicidade || '').trim();
        if (professor !== undefined) dados.professor = (professor || '').trim();
        if (linkReferencia !== undefined) dados.linkReferencia = (linkReferencia || '').trim();
        if (status !== undefined) {
            if (!['pendente', 'chegou'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
            dados.status = status;
        }

        // Se a quantidade mudou, recalcula o valorTotal das cotações já lançadas
        if (dados.quantidade !== undefined) {
            const doc = await db.collection(COL_ITENS).doc(req.params.id).get();
            if (!doc.exists) return res.status(404).json({ error: 'Item não encontrado.' });
            const cotacoesAtuais = doc.data().cotacoes || [];
            dados.cotacoes = cotacoesAtuais.map(c => ({
                ...c,
                valorTotal: Math.round(c.valorUnitario * dados.quantidade * 100) / 100
            }));
        }

        await db.collection(COL_ITENS).doc(req.params.id).update(dados);
        res.json({ message: 'Item atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const bloqueio = await bloquearSeForaDoSemestreAtivo(req, req.params.id);
        if (bloqueio) return res.status(bloqueio.status).json({ error: bloqueio.error });

        await db.collection(COL_ITENS).doc(req.params.id).delete();
        res.json({ message: 'Item excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /itens/:id/cotacoes — substitui o array de cotações inteiro de uma vez
// (a tela edita todos os fornecedores num modal só e salva junto). valorTotal
// é sempre recalculado aqui, nunca confiado do cliente.
router.put('/itens/:id/cotacoes', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const itemDoc = await db.collection(COL_ITENS).doc(req.params.id).get();
        if (!itemDoc.exists) return res.status(404).json({ error: 'Item não encontrado.' });
        const item = itemDoc.data();

        const fornecedoresSnap = await db.collection(COL_FORNECEDORES).get();
        const fornecedoresPorId = {};
        fornecedoresSnap.forEach(d => { fornecedoresPorId[d.id] = { id: d.id, ...d.data() }; });

        const cotacoes = calcularCotacoes(req.body.cotacoes, item.quantidade, fornecedoresPorId);
        await db.collection(COL_ITENS).doc(req.params.id).update({
            cotacoes,
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Cotações salvas.', cotacoes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// RELATÓRIO
// ==========================================
router.get('/relatorio', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { cursoId, semestre, periodicidade, cotacoesFiltro } = req.query;
        let query = db.collection(COL_ITENS);
        if (cursoId) query = query.where('cursoId', '==', cursoId);
        if (semestre) query = query.where('semestre', '==', semestre);
        const snap = await query.get();

        const porCurso = {}; // cursoId -> { curso, gastoTotal, economia, pendente, chegou }
        const rankingFornecedores = {}; // fornecedorNome -> vitórias
        let gastoTotalGeral = 0, economiaTotalGeral = 0, pendenteGeral = 0, chegouGeral = 0;

        // Mapa comparativo: pra cada item, o valor que CADA fornecedor cotou —
        // não só quem ganhou. É o "orçamento lado a lado" que o financeiro pediu
        // pra comparar preço entre empresas, não só ver o vencedor.
        const fornecedoresColunas = {}; // fornecedorId -> nome (define as colunas da tabela)
        const comparativoItens = [];

        snap.forEach(doc => {
            const item = doc.data();
            const cotacoes = item.cotacoes || [];

            // Filtros pedidos pelo financeiro: por periodicidade do produto (campo
            // livre, mas usado com "Mensal"/"Semestral"/"Anual") e por quantidade de
            // cotações — "única" = sem concorrência real (economia sempre zero ali),
            // "múltipla" = teve disputa entre fornecedores.
            if (periodicidade && (item.periodicidade || '').trim().toLowerCase() !== periodicidade.trim().toLowerCase()) {
                return;
            }
            if (cotacoesFiltro === 'unica' && cotacoes.length !== 1) return;
            if (cotacoesFiltro === 'multipla' && cotacoes.length < 2) return;

            if (!porCurso[item.cursoId]) {
                porCurso[item.cursoId] = { cursoId: item.cursoId, curso: item.curso, gastoTotal: 0, economia: 0, pendente: 0, chegou: 0 };
            }
            const c = porCurso[item.cursoId];

            if (item.status === 'chegou') { c.chegou++; chegouGeral++; }
            else { c.pendente++; pendenteGeral++; }

            if (cotacoes.length) {
                const valores = cotacoes.map(cot => cot.valorTotal);
                const menor = Math.min(...valores);
                const maior = Math.max(...valores);
                c.gastoTotal += menor;
                c.economia += (maior - menor);
                gastoTotalGeral += menor;
                economiaTotalGeral += (maior - menor);

                const vencedor = cotacoes.find(cot => cot.valorTotal === menor);
                if (vencedor) {
                    rankingFornecedores[vencedor.fornecedorNome] = (rankingFornecedores[vencedor.fornecedorNome] || 0) + 1;
                }

                const valoresPorFornecedor = {};
                cotacoes.forEach(cot => {
                    fornecedoresColunas[cot.fornecedorId] = cot.fornecedorNome;
                    valoresPorFornecedor[cot.fornecedorId] = cot.valorTotal;
                });
                comparativoItens.push({
                    itemId: doc.id,
                    cursoId: item.cursoId,
                    curso: item.curso,
                    produto: item.produto,
                    quantidade: item.quantidade,
                    unidade: item.unidade,
                    valoresPorFornecedor,
                    vencedorFornecedorId: vencedor ? vencedor.fornecedorId : null
                });
            }
        });

        res.json({
            porCurso: Object.values(porCurso).map(c => ({
                ...c,
                gastoTotal: Math.round(c.gastoTotal * 100) / 100,
                economia: Math.round(c.economia * 100) / 100
            })),
            rankingFornecedores: Object.entries(rankingFornecedores)
                .map(([nome, vitorias]) => ({ nome, vitorias }))
                .sort((a, b) => b.vitorias - a.vitorias),
            geral: {
                gastoTotal: Math.round(gastoTotalGeral * 100) / 100,
                economia: Math.round(economiaTotalGeral * 100) / 100,
                pendente: pendenteGeral,
                chegou: chegouGeral
            },
            comparativo: {
                fornecedores: Object.entries(fornecedoresColunas)
                    .map(([id, nome]) => ({ id, nome }))
                    .sort((a, b) => a.nome.localeCompare(b.nome)),
                itens: comparativoItens.sort((a, b) =>
                    (a.curso || '').localeCompare(b.curso || '') || (a.produto || '').localeCompare(b.produto || '')
                )
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// FECHAMENTO (fechar itens com um fornecedor a partir de um orçamento final
// negociado, mesmo que ele não seja o vencedor por preço em algum item)
// ==========================================

const PARADAS_MATCH = new Set(['p', 'c', 'de', 'da', 'do', 'com', 'para', 'uso', 'geral',
    'uni', 'und', 'unid', 'kit', 'pc', 'cx', 'mc', 'st', 'un']);

function normalizarTextoMatch(s) {
    return (s || '')
        .toString()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/(\d)[.,](\d)/g, '$1_$2')
        .replace(/[^a-z0-9_\s]/g, ' ')
        .replace(/(\d)([a-z])/g, '$1 $2')
        .replace(/([a-z])(\d)/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokensMatch(s) {
    return new Set(normalizarTextoMatch(s).split(' ').filter(t => t && !PARADAS_MATCH.has(t)));
}

// Coeficiente de sobreposição (Szymkiewicz-Simpson): quanto das palavras do
// nome MAIS CURTO aparece no mais longo. Nomes de orçamento de fornecedor
// costumam ser bem mais técnicos/longos (código, marca, medida) que os nomes
// simples cadastrados no sistema — Jaccard penaliza isso demais; aqui só
// importa se o nome curto está "contido" no longo.
function overlapMatch(a, b) {
    const ta = tokensMatch(a), tb = tokensMatch(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    ta.forEach(t => { if (tb.has(t)) inter++; });
    const menor = Math.min(ta.size, tb.size);
    return menor ? inter / menor : 0;
}

// GET /fechamento/pendentes — itens que ainda não têm nenhuma empresa
// fechada (status diferente de "fechado"), pra saber o que falta negociar.
router.get('/fechamento/pendentes', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { semestre, cursoId } = req.query;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });

        let query = db.collection(COL_ITENS).where('semestre', '==', semestre);
        if (cursoId) query = query.where('cursoId', '==', cursoId);
        const snap = await query.get();

        const pendentes = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(it => it.status !== 'fechado')
            .sort((a, b) => (a.curso || '').localeCompare(b.curso || '') || (a.produto || '').localeCompare(b.produto || ''));

        res.json(pendentes.map(it => {
            const cotacoes = it.cotacoes || [];
            let vencedorNome = null, vencedorValor = null;
            if (cotacoes.length) {
                const vencedor = cotacoes.reduce((menor, cot) => (cot.valorTotal < menor.valorTotal ? cot : menor));
                vencedorNome = vencedor.fornecedorNome;
                vencedorValor = vencedor.valorTotal;
            }
            return {
                id: it.id, curso: it.curso, produto: it.produto, quantidade: it.quantidade,
                unidade: it.unidade, totalCotacoes: cotacoes.length, vencedorNome, vencedorValor
            };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /fechamento/candidatos — recebe os itens de um orçamento final (nome,
// qtd, valor) e sugere, pra cada um, os itens já cadastrados no sistema mais
// parecidos (qualquer curso/semestre ativo), pra revisão visual na tela.
router.post('/fechamento/candidatos', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { itens, fornecedorId, semestre } = req.body;
        if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'Informe os itens do orçamento.' });
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });

        const snap = await db.collection(COL_ITENS).where('semestre', '==', semestre).get();
        // Item já fechado com outra empresa não entra como candidato — já foi
        // decidido, não faz sentido oferecer de novo num fechamento diferente
        // (se precisar mudar quem fechou, primeiro reabre na lista de fechados).
        const itensSistema = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(it => it.status !== 'fechado');

        const resultado = itens.map(itemOrcamento => {
            const candidatos = itensSistema
                .map(it => ({
                    id: it.id,
                    produto: it.produto,
                    curso: it.curso,
                    quantidade: it.quantidade,
                    unidade: it.unidade,
                    status: it.status,
                    temCotacaoDesteFornecedor: fornecedorId ? (it.cotacoes || []).some(c => c.fornecedorId === fornecedorId) : false,
                    score: normalizarTextoMatch(it.produto) === normalizarTextoMatch(itemOrcamento.produto)
                        ? 1 : overlapMatch(it.produto, itemOrcamento.produto)
                }))
                .filter(c => c.score >= 0.3)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);

            return { ...itemOrcamento, candidatos };
        });

        res.json({ itens: resultado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /fechamento/confirmar — aplica o fechamento: define o item como
// "fechado" com esse fornecedor e grava o valor final negociado na cotação
// dela (substitui/insere, mantendo as cotações das outras empresas intactas).
router.post('/fechamento/confirmar', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { fornecedorId, fechamentos } = req.body;
        if (!fornecedorId) return res.status(400).json({ error: 'Informe o fornecedor.' });
        if (!Array.isArray(fechamentos) || !fechamentos.length) return res.status(400).json({ error: 'Informe os itens a fechar.' });

        const fornDoc = await db.collection(COL_FORNECEDORES).doc(fornecedorId).get();
        if (!fornDoc.exists) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
        const fornecedorNome = fornDoc.data().nome;

        let atualizados = 0;
        const erros = [];
        for (const f of fechamentos) {
            const doc = await db.collection(COL_ITENS).doc(f.itemId).get();
            if (!doc.exists) { erros.push({ itemId: f.itemId, error: 'Item não encontrado.' }); continue; }
            const item = doc.data();

            const valorUnitario = parseFloat(f.valorUnitario);
            const valorTotal = parseFloat(f.valorTotal);
            if (isNaN(valorUnitario) || isNaN(valorTotal)) { erros.push({ itemId: f.itemId, error: 'Valor inválido.' }); continue; }

            const cotacoes = (item.cotacoes || []).filter(c => c.fornecedorId !== fornecedorId);
            cotacoes.push({ fornecedorId, fornecedorNome, valorUnitario, valorTotal });

            // Guarda o estado de ANTES do fechamento (cotações e status originais)
            // pra "reabrir" conseguir desfazer de verdade — sem isso, reabrir só
            // limpava os campos de fechado mas deixava a cotação nova (errada,
            // se o casamento automático tivesse acertado o item errado) intacta.
            await db.collection(COL_ITENS).doc(f.itemId).update({
                cotacoes,
                status: 'fechado',
                fornecedorFechadoId: fornecedorId,
                fornecedorFechadoNome: fornecedorNome,
                valorFechado: valorTotal,
                fechadoEm: new Date().toISOString(),
                estadoAntesDoFechamento: { cotacoes: item.cotacoes || [], status: item.status || 'pendente' },
                updatedAt: new Date().toISOString()
            });
            atualizados++;
        }

        res.json({ message: `${atualizados} item(ns) fechado(s) com ${fornecedorNome}.`, atualizados, erros });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /fechamento/:id/reabrir — desfaz um fechamento, restaurando as
// cotações e o status exatamente como estavam antes (guardado em
// estadoAntesDoFechamento no momento da confirmação) — não só limpa o status.
router.post('/fechamento/:id/reabrir', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const doc = await db.collection(COL_ITENS).doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Item não encontrado.' });
        const anterior = doc.data().estadoAntesDoFechamento;

        await db.collection(COL_ITENS).doc(req.params.id).update({
            status: anterior ? anterior.status : 'pendente',
            cotacoes: anterior ? anterior.cotacoes : (doc.data().cotacoes || []),
            fornecedorFechadoId: admin.firestore.FieldValue.delete(),
            fornecedorFechadoNome: admin.firestore.FieldValue.delete(),
            valorFechado: admin.firestore.FieldValue.delete(),
            fechadoEm: admin.firestore.FieldValue.delete(),
            estadoAntesDoFechamento: admin.firestore.FieldValue.delete(),
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Fechamento desfeito — item voltou ao estado de antes.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /fechamento/reabrir-lote — desfaz de uma vez todos os fechamentos de
// um fornecedor num semestre. Útil pra corrigir um lote inteiro que saiu
// errado (ex.: casamento automático ruim), sem precisar reabrir item por item.
router.post('/fechamento/reabrir-lote', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { fornecedorId, semestre } = req.body;
        if (!fornecedorId) return res.status(400).json({ error: 'Informe o fornecedor.' });
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });

        const snap = await db.collection(COL_ITENS)
            .where('semestre', '==', semestre)
            .where('fornecedorFechadoId', '==', fornecedorId)
            .get();

        let desfeitos = 0;
        for (const doc of snap.docs) {
            const item = doc.data();
            const anterior = item.estadoAntesDoFechamento;
            await doc.ref.update({
                status: anterior ? anterior.status : 'pendente',
                cotacoes: anterior ? anterior.cotacoes : (item.cotacoes || []),
                fornecedorFechadoId: admin.firestore.FieldValue.delete(),
                fornecedorFechadoNome: admin.firestore.FieldValue.delete(),
                valorFechado: admin.firestore.FieldValue.delete(),
                fechadoEm: admin.firestore.FieldValue.delete(),
                estadoAntesDoFechamento: admin.firestore.FieldValue.delete(),
                updatedAt: new Date().toISOString()
            });
            desfeitos++;
        }
        res.json({ message: `${desfeitos} fechamento(s) desfeito(s).`, desfeitos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /fechamento/fechados — lista o que já foi fechado com um fornecedor,
// com o valor, pra conferir contra o orçamento que a empresa mandou.
router.get('/fechamento/fechados', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { fornecedorId, semestre } = req.query;
        if (!fornecedorId) return res.status(400).json({ error: 'Informe o fornecedor.' });
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });

        const snap = await db.collection(COL_ITENS)
            .where('semestre', '==', semestre)
            .where('fornecedorFechadoId', '==', fornecedorId)
            .get();

        const fechados = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.curso || '').localeCompare(b.curso || '') || (a.produto || '').localeCompare(b.produto || ''));

        res.json({
            itens: fechados.map(it => ({
                id: it.id, curso: it.curso, produto: it.produto, quantidade: it.quantidade,
                unidade: it.unidade, valorFechado: it.valorFechado, fechadoEm: it.fechadoEm
            })),
            total: fechados.reduce((s, it) => s + (it.valorFechado || 0), 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /fechamento/fechados-geral — tudo que já foi fechado no semestre, com
// QUALQUER empresa — visão geral pra saber o que já está decidido no total,
// agrupado por fornecedor.
router.get('/fechamento/fechados-geral', verifyToken, checkPermission, bloquearCoordenador, async (req, res) => {
    try {
        const { semestre, cursoId } = req.query;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });

        let query = db.collection(COL_ITENS).where('semestre', '==', semestre);
        if (cursoId) query = query.where('cursoId', '==', cursoId);
        const snap = await query.get();

        const fechados = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(it => it.status === 'fechado')
            .sort((a, b) => (a.fornecedorFechadoNome || '').localeCompare(b.fornecedorFechadoNome || '') ||
                (a.curso || '').localeCompare(b.curso || '') || (a.produto || '').localeCompare(b.produto || ''));

        const porFornecedor = {};
        fechados.forEach(it => {
            const nome = it.fornecedorFechadoNome || '—';
            if (!porFornecedor[nome]) porFornecedor[nome] = { fornecedor: nome, itens: 0, total: 0 };
            porFornecedor[nome].itens++;
            porFornecedor[nome].total += it.valorFechado || 0;
        });

        res.json({
            itens: fechados.map(it => ({
                id: it.id, curso: it.curso, produto: it.produto, quantidade: it.quantidade,
                unidade: it.unidade, fornecedor: it.fornecedorFechadoNome, valorFechado: it.valorFechado, fechadoEm: it.fechadoEm
            })),
            resumoPorFornecedor: Object.values(porFornecedor).sort((a, b) => b.total - a.total),
            totalGeral: fechados.reduce((s, it) => s + (it.valorFechado || 0), 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
