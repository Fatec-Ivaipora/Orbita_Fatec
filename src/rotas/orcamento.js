const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('orcamento');

const COL_ORCAMENTOS = 'financeiro_orcamentos';
const COL_LANCAMENTOS = 'financeiro_orcamento_lancamentos';
const COL_CATALOGO = 'financeiro_orcamento_catalogo_itens';

function validarTexto(v, max = 120) {
    return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

function normalizarTexto(v) {
    return (v || '').toString().trim();
}

// Item e fornecedor sempre em MAIÚSCULO (mesma regra do módulo Licitação) —
// senão "Açúcar" e "açúcar" viram duas entradas diferentes no catálogo e
// quebram o agrupamento por fornecedor.
function normalizarMaiusculo(v) {
    return (v || '').toString().trim().toUpperCase();
}

// Nem todo orçamento tem um teto definido de antemão (na prática do setor,
// às vezes só se registra o que foi comprado sem um valor previsto — ver
// planilhas de referência). Sem previsto, não existe "saldo" a calcular.
function calcularSaldo(valorPrevisto, totalGasto) {
    return valorPrevisto === null || valorPrevisto === undefined ? null : valorPrevisto - totalGasto;
}

// Chefe de Setor (ex.: Lisa no Financeiro) ou Administrador vê/mexe nos
// orçamentos de todo mundo do setor — as outras colaboradoras só veem e
// editam os próprios (cada uma cuida da sua verba, sem misturar). Mesmo
// flag `chefeDeSetor` já usado pra restringir exclusão de orçamento.
function ehChefeOuAdmin(req) {
    return req.user.role === 'adm_l1' || req.user.role === 'adm_l2' || req.user.chefeDeSetor === true;
}

// ==========================================
// ORÇAMENTOS — verba prevista por setor/projeto (ex.: "Zeladoria 2026.2",
// "Medicina Veterinária - Equipamentos"), com totalGasto/saldo denormalizados
// no próprio doc e recalculados a cada lançamento — lista sem precisar somar
// lançamentos toda hora (mesmo motivo do incidente de cota do Licitação).
// Sem where() combinado com orderBy() de propósito — evita depender de
// índice composto novo no Firestore; filtro de status/setor/dono é em
// memória sobre uma coleção pequena (dezenas de orçamentos por semestre).
// ==========================================
router.get('/orcamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { status, setor } = req.query;
        const snap = await db.collection(COL_ORCAMENTOS).orderBy('createdAt', 'desc').get();
        let orcamentos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (!ehChefeOuAdmin(req)) orcamentos = orcamentos.filter(o => o.createdBy === req.user.uid);
        if (status && status !== 'todos') orcamentos = orcamentos.filter(o => o.status === status);
        if (setor) orcamentos = orcamentos.filter(o => o.setor === setor);
        res.json(orcamentos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/orcamentos/setores', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_ORCAMENTOS).get();
        const vejaTodos = ehChefeOuAdmin(req);
        const set = new Set();
        snap.forEach(doc => {
            const dados = doc.data();
            if (!vejaTodos && dados.createdBy !== req.user.uid) return;
            if (dados.setor) set.add(dados.setor);
        });
        res.json([...set].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/orcamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = normalizarTexto(req.body.nome);
        const setor = normalizarTexto(req.body.setor);
        const semestre = normalizarTexto(req.body.semestre);
        const observacoes = normalizarTexto(req.body.observacoes);
        const temPrevisto = req.body.valorPrevisto !== undefined && req.body.valorPrevisto !== null && req.body.valorPrevisto !== '';
        const valorPrevisto = temPrevisto ? Number(req.body.valorPrevisto) : null;

        if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe um nome para o orçamento.' });
        if (!validarTexto(setor, 60)) return res.status(400).json({ error: 'Informe o setor/departamento.' });
        if (temPrevisto && (!Number.isFinite(valorPrevisto) || valorPrevisto <= 0)) return res.status(400).json({ error: 'Informe um valor previsto válido, maior que zero (ou deixe em branco).' });

        const docRef = await db.collection(COL_ORCAMENTOS).add({
            nome,
            setor,
            semestre: semestre || null,
            observacoes: observacoes || null,
            valorPrevisto,
            totalGasto: 0,
            saldo: calcularSaldo(valorPrevisto, 0),
            status: 'aberto',
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid,
            createdByNome: req.user.name || req.user.email || ''
        });
        res.status(201).json({ id: docRef.id, message: 'Orçamento criado com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/orcamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ORCAMENTOS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Orçamento não encontrado.' });

        const atual = snap.data();
        if (atual.createdBy !== req.user.uid && !ehChefeOuAdmin(req)) {
            return res.status(403).json({ error: 'Este orçamento é de outra colaboradora — só ela, o Chefe de Setor ou o Administrador podem editar.' });
        }
        const update = {};

        if (req.body.nome !== undefined) {
            const nome = normalizarTexto(req.body.nome);
            if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe um nome válido.' });
            update.nome = nome;
        }
        if (req.body.setor !== undefined) {
            const setor = normalizarTexto(req.body.setor);
            if (!validarTexto(setor, 60)) return res.status(400).json({ error: 'Informe o setor/departamento.' });
            update.setor = setor;
        }
        if (req.body.semestre !== undefined) update.semestre = normalizarTexto(req.body.semestre) || null;
        if (req.body.observacoes !== undefined) update.observacoes = normalizarTexto(req.body.observacoes) || null;
        if (req.body.status !== undefined) {
            if (!['aberto', 'encerrado'].includes(req.body.status)) return res.status(400).json({ error: 'Status inválido.' });
            update.status = req.body.status;
        }
        if (req.body.valorPrevisto !== undefined) {
            const limpo = req.body.valorPrevisto === null || req.body.valorPrevisto === '';
            const valorPrevisto = limpo ? null : Number(req.body.valorPrevisto);
            if (!limpo && (!Number.isFinite(valorPrevisto) || valorPrevisto <= 0)) return res.status(400).json({ error: 'Informe um valor previsto válido, maior que zero (ou deixe em branco).' });
            update.valorPrevisto = valorPrevisto;
            update.saldo = calcularSaldo(valorPrevisto, atual.totalGasto || 0);
        }

        await ref.update(update);
        res.json({ message: 'Orçamento atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Excluir o orçamento é mais restrito que cadastrar/editar/lançar gasto
// (nível 3 do módulo, que Financeiro/ADM N2 já têm por padrão): só ADM N1/N2
// ou quem é Chefe de Setor (users/{uid}.chefeDeSetor) pode apagar. O campo
// "setor" do orçamento é texto livre (a pessoa escreve do que se trata, ex.
// "Zeladoria 2026.2") — não bate com nenhum cadastro formal de setor do
// sistema, então não dá pra restringir ao chefe de UM setor específico;
// qualquer Chefe de Setor pode excluir qualquer orçamento.
router.delete('/orcamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ORCAMENTOS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Orçamento não encontrado.' });

        const ehAdmin = req.user.role === 'adm_l1' || req.user.role === 'adm_l2';
        const ehChefeDoSetor = req.user.chefeDeSetor === true;
        if (!ehAdmin && !ehChefeDoSetor) {
            return res.status(403).json({ error: 'Só o Administrador ou um Chefe de Setor podem excluir orçamentos.' });
        }

        const lancSnap = await db.collection(COL_LANCAMENTOS).where('orcamentoId', '==', req.params.id).limit(1).get();
        if (!lancSnap.empty) return res.status(400).json({ error: 'Este orçamento já tem gastos lançados — feche-o em vez de excluir.' });

        await ref.delete();
        res.json({ message: 'Orçamento excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CATÁLOGO DE ITENS — produtos que se repetem mês a mês (ex.: "Açúcar",
// "Material de limpeza"), reaproveitados em qualquer orçamento — evita
// redigitar/inconsistência de nome toda vez que ela lança o mesmo item de
// novo. Cresce sozinho: ao lançar um item com nome novo, ele é cadastrado
// aqui automaticamente (ver upsertItemCatalogo), além de poder ser mantido
// manualmente por aqui.
// ==========================================
router.get('/catalogo-itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_CATALOGO).orderBy('nome').get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/catalogo-itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = normalizarMaiusculo(req.body.nome);
        const unidade = normalizarTexto(req.body.unidade);
        if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe o nome do item.' });

        const existente = await db.collection(COL_CATALOGO).where('nome', '==', nome).limit(1).get();
        if (!existente.empty) return res.status(400).json({ error: 'Já existe um item com esse nome no catálogo.' });

        const docRef = await db.collection(COL_CATALOGO).add({
            nome, unidade: unidade || null,
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid
        });
        res.status(201).json({ id: docRef.id, message: 'Item cadastrado no catálogo.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/catalogo-itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = normalizarMaiusculo(req.body.nome);
        const unidade = normalizarTexto(req.body.unidade);
        if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe o nome do item.' });

        await db.collection(COL_CATALOGO).doc(req.params.id).update({ nome, unidade: unidade || null });
        res.json({ message: 'Item atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/catalogo-itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_CATALOGO).doc(req.params.id).delete();
        res.json({ message: 'Item removido do catálogo.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cadastra automaticamente no catálogo um item digitado que ainda não existe
// lá (comparação case-insensitive pra "Açúcar" e "açúcar" não virarem dois
// registros). Best-effort — nunca derruba o lançamento por causa disso.
async function upsertItemCatalogo(nome) {
    try {
        const snap = await db.collection(COL_CATALOGO).get();
        const jaExiste = snap.docs.some(d => (d.data().nome || '').toLowerCase() === nome.toLowerCase());
        if (!jaExiste) {
            await db.collection(COL_CATALOGO).add({ nome, unidade: null, createdAt: new Date().toISOString() });
        }
    } catch (err) {
        // silencioso — o catálogo é só uma conveniência de autocomplete
    }
}

// Cotação mais barata = a que fecha (regra fixa, sem escolha manual: "o mais
// barato é o que vai fechar"). Empate pega a primeira cotação informada.
function escolherMaisBarata(cotacoes) {
    return cotacoes.reduce((menor, atual) => (atual.valorUnitario < menor.valorUnitario ? atual : menor));
}

function validarCotacoes(cotacoesInput) {
    if (!Array.isArray(cotacoesInput) || !cotacoesInput.length) return { erro: 'Informe ao menos uma cotação (fornecedor + valor).' };
    const cotacoes = [];
    for (const c of cotacoesInput) {
        const fornecedor = normalizarMaiusculo(c.fornecedor);
        const valorUnitario = Number(c.valorUnitario);
        if (!validarTexto(fornecedor, 120)) return { erro: 'Informe o fornecedor de cada cotação.' };
        if (!Number.isFinite(valorUnitario) || valorUnitario < 0) return { erro: `Valor unitário inválido para "${fornecedor}".` };
        cotacoes.push({ fornecedor, valorUnitario });
    }
    return { cotacoes };
}

// ==========================================
// LANÇAMENTOS — dentro de um orçamento, cada item pode ter cotações de
// vários fornecedores (ex.: açúcar cotado em 3 mercados); a mais barata
// fecha automaticamente e é o que conta pro totalGasto/saldo do orçamento.
// Parecido com a comparação de fornecedores da Licitação, só que interno ao
// orçamento (sem processo formal de licitação por trás). Cada
// criação/edição/remoção atualiza totalGasto/saldo numa transação.
// where('orcamentoId') sem orderBy combinado — não precisa de índice
// composto; ordenação por data é feita em memória (lista pequena por
// orçamento).
// ==========================================
router.get('/orcamentos/:id/lancamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const orcSnap = await db.collection(COL_ORCAMENTOS).doc(req.params.id).get();
        if (!orcSnap.exists) return res.status(404).json({ error: 'Orçamento não encontrado.' });
        if (orcSnap.data().createdBy !== req.user.uid && !ehChefeOuAdmin(req)) {
            return res.status(403).json({ error: 'Este orçamento é de outra colaboradora.' });
        }

        const snap = await db.collection(COL_LANCAMENTOS).where('orcamentoId', '==', req.params.id).get();
        const lancamentos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
        res.json(lancamentos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/orcamentos/:id/lancamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const orcamentoId = req.params.id;
        const itemNome = normalizarMaiusculo(req.body.itemNome);
        const unidade = normalizarTexto(req.body.unidade);
        const quantidade = req.body.quantidade !== undefined && req.body.quantidade !== '' ? Number(req.body.quantidade) : 1;
        const data = normalizarTexto(req.body.data) || new Date().toISOString().slice(0, 10);

        if (!validarTexto(itemNome, 150)) return res.status(400).json({ error: 'Informe o nome do item.' });
        if (!Number.isFinite(quantidade) || quantidade <= 0) return res.status(400).json({ error: 'Quantidade deve ser maior que zero.' });

        const { erro, cotacoes } = validarCotacoes(req.body.cotacoes);
        if (erro) return res.status(400).json({ error: erro });

        const cotacoesComTotal = cotacoes.map(c => ({ ...c, valorTotal: Math.round(quantidade * c.valorUnitario * 100) / 100 }));
        const vencedora = escolherMaisBarata(cotacoesComTotal);

        const orcamentoRef = db.collection(COL_ORCAMENTOS).doc(orcamentoId);
        const lancamentoRef = db.collection(COL_LANCAMENTOS).doc();

        await db.runTransaction(async (tx) => {
            const orcSnap = await tx.get(orcamentoRef);
            if (!orcSnap.exists) throw new Error('Orçamento não encontrado.');
            const orc = orcSnap.data();
            if (orc.createdBy !== req.user.uid && !ehChefeOuAdmin(req)) throw new Error('Este orçamento é de outra colaboradora.');
            const novoTotalGasto = (orc.totalGasto || 0) + vencedora.valorTotal;

            tx.set(lancamentoRef, {
                orcamentoId, itemNome, unidade: unidade || null, quantidade,
                cotacoes: cotacoesComTotal,
                fornecedorFechado: vencedora.fornecedor,
                valorUnitarioFechado: vencedora.valorUnitario,
                valorTotalFechado: vencedora.valorTotal,
                data,
                createdAt: new Date().toISOString(),
                createdBy: req.user.uid
            });
            tx.update(orcamentoRef, {
                totalGasto: novoTotalGasto,
                saldo: calcularSaldo(orc.valorPrevisto, novoTotalGasto)
            });
        });

        upsertItemCatalogo(itemNome);
        res.status(201).json({ id: lancamentoRef.id, message: 'Gasto lançado com sucesso.' });
    } catch (err) {
        const status = err.message === 'Orçamento não encontrado.' ? 404 : (err.message.includes('outra colaboradora') ? 403 : 500);
        res.status(status).json({ error: err.message });
    }
});

router.put('/lancamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const lancamentoRef = db.collection(COL_LANCAMENTOS).doc(req.params.id);
        let itemNomeParaCatalogo = null;

        await db.runTransaction(async (tx) => {
            const lancSnap = await tx.get(lancamentoRef);
            if (!lancSnap.exists) throw new Error('Lançamento não encontrado.');
            const lanc = lancSnap.data();

            const orcamentoRef = db.collection(COL_ORCAMENTOS).doc(lanc.orcamentoId);
            const orcSnap = await tx.get(orcamentoRef);
            if (!orcSnap.exists) throw new Error('Orçamento não encontrado.');
            const orc = orcSnap.data();
            if (orc.createdBy !== req.user.uid && !ehChefeOuAdmin(req)) throw new Error('Este orçamento é de outra colaboradora.');

            const itemNome = req.body.itemNome !== undefined ? normalizarMaiusculo(req.body.itemNome) : lanc.itemNome;
            const unidade = req.body.unidade !== undefined ? normalizarTexto(req.body.unidade) : (lanc.unidade || '');
            const quantidade = req.body.quantidade !== undefined ? Number(req.body.quantidade) : lanc.quantidade;
            const data = req.body.data !== undefined ? normalizarTexto(req.body.data) : lanc.data;

            if (!validarTexto(itemNome, 150)) throw new Error('Informe o nome do item.');
            if (!Number.isFinite(quantidade) || quantidade <= 0) throw new Error('Quantidade deve ser maior que zero.');

            const cotacoesInput = req.body.cotacoes !== undefined ? req.body.cotacoes : lanc.cotacoes;
            const { erro, cotacoes } = validarCotacoes(cotacoesInput);
            if (erro) throw new Error(erro);

            const cotacoesComTotal = cotacoes.map(c => ({ ...c, valorTotal: Math.round(quantidade * c.valorUnitario * 100) / 100 }));
            const vencedora = escolherMaisBarata(cotacoesComTotal);

            const novoTotalGasto = (orc.totalGasto || 0) - (lanc.valorTotalFechado || 0) + vencedora.valorTotal;

            tx.update(lancamentoRef, {
                itemNome, unidade: unidade || null, quantidade,
                cotacoes: cotacoesComTotal,
                fornecedorFechado: vencedora.fornecedor,
                valorUnitarioFechado: vencedora.valorUnitario,
                valorTotalFechado: vencedora.valorTotal,
                data
            });
            tx.update(orcamentoRef, { totalGasto: novoTotalGasto, saldo: calcularSaldo(orc.valorPrevisto, novoTotalGasto) });

            itemNomeParaCatalogo = itemNome;
        });

        if (itemNomeParaCatalogo) upsertItemCatalogo(itemNomeParaCatalogo);
        res.json({ message: 'Lançamento atualizado.' });
    } catch (err) {
        const status = err.message.includes('não encontrado') ? 404 : (err.message.includes('outra colaboradora') ? 403 : 400);
        res.status(status).json({ error: err.message });
    }
});

router.delete('/lancamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const lancamentoRef = db.collection(COL_LANCAMENTOS).doc(req.params.id);

        await db.runTransaction(async (tx) => {
            const lancSnap = await tx.get(lancamentoRef);
            if (!lancSnap.exists) throw new Error('Lançamento não encontrado.');
            const lanc = lancSnap.data();

            const orcamentoRef = db.collection(COL_ORCAMENTOS).doc(lanc.orcamentoId);
            const orcSnap = await tx.get(orcamentoRef);
            if (orcSnap.exists) {
                const orc = orcSnap.data();
                if (orc.createdBy !== req.user.uid && !ehChefeOuAdmin(req)) throw new Error('Este orçamento é de outra colaboradora.');
                const novoTotalGasto = Math.max(0, (orc.totalGasto || 0) - (lanc.valorTotalFechado || 0));
                tx.update(orcamentoRef, { totalGasto: novoTotalGasto, saldo: calcularSaldo(orc.valorPrevisto, novoTotalGasto) });
            }
            tx.delete(lancamentoRef);
        });

        res.json({ message: 'Lançamento removido.' });
    } catch (err) {
        const status = err.message.includes('não encontrado') ? 404 : (err.message.includes('outra colaboradora') ? 403 : 500);
        res.status(status).json({ error: err.message });
    }
});

module.exports = router;
