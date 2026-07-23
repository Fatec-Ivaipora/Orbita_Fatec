const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// Middleware para verificar permissão do módulo (Gestão Saúde)
const checkPermission = verifyToken.requireModulePermission('almoxarifado-saude');

const COL_ITENS = 'almoxarifado_itens';
const COL_LOTES = 'almoxarifado_lotes';
const COL_MOV = 'almoxarifado_movimentacoes';

const CATEGORIAS = ['Permanente', 'Consumível'];

// Mesma lista de localizações já usada nos dados importados (planilha de
// conferência do setor de Saúde) — fixa para evitar duplicidade por erro de
// digitação (ex.: "Lab Microbiologia" vs "Laboratório de Microbiologia").
const LOCALIZACOES = [
    'Lab. Morfofuncionais',
    'Lab. Microscopia e Parasitologia',
    'Lab. Microbiologia',
    'Lab. Bioquímica/Fisiologia/Farmacologia',
    'Centro Cirúrgico/Obstétrico',
    'UTI/Sala de Observação',
    'Casa Simulada/Pré-Hospitalar',
    'Lab. Semiologia/Enfermaria',
    'Lab. Fisioterapia',
    'Lab. Topografia',
    'Lab. Engenharia',
    'Ambulatório de Feridas',
    'Lab. Morfo Veterinária',
    'Sala 8 - Centro de Distribuição',
    'Consumíveis - Biomedicina',
    'Consumíveis - Enfermagem',
    'Consumíveis - Medicina',
    'Consumíveis - Sala 8',
    'Consumíveis - Fisioterapia',
    'Consumíveis - Agronomia',
    'Consumíveis - Med. Veterinária'
];

// Nº de dias à frente considerados "vencendo" (ainda não vencido, mas perto)
const DIAS_VENCENDO = 60;

// GET /api/almoxarifado-saude/localizacoes - Lista fixa (pro <select> do front)
router.get('/localizacoes', verifyToken, checkPermission, (req, res) => {
    res.json(LOCALIZACOES);
});

// ==========================================
// ITENS
// ==========================================

const PAGE_SIZE_PADRAO = 40;
const PAGE_SIZE_MAX = 100;

// Anexa a validade mais próxima entre os lotes de cada item (1 única consulta,
// só pros itens já carregados nesta página — não a coleção de lotes inteira).
async function anexarProximaValidade(itens) {
    if (!itens.length) return;
    const ids = itens.map(it => it.id);
    const proximaPorItem = {};
    // Firestore limita "in" a 30 valores por consulta
    for (let i = 0; i < ids.length; i += 30) {
        const chunk = ids.slice(i, i + 30);
        const snap = await db.collection(COL_LOTES).where('itemId', 'in', chunk).where('validade', '!=', null).get();
        snap.forEach(doc => {
            const { itemId, validade } = doc.data();
            if (!proximaPorItem[itemId] || validade < proximaPorItem[itemId]) {
                proximaPorItem[itemId] = validade;
            }
        });
    }
    itens.forEach(it => { it.proximaValidade = proximaPorItem[it.id] || null; });
}

// GET /api/almoxarifado-saude/itens?categoria=&localizacao=&busca=&limit=&cursor=
// Paginado (evita carregar os 500-900+ itens da categoria de uma vez só, o
// que custava centenas de leituras do Firestore a cada abertura da tela).
router.get('/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const { categoria, localizacao, busca } = req.query;
        if (!categoria || !CATEGORIAS.includes(categoria)) {
            return res.status(400).json({ error: 'Informe uma categoria válida ("Permanente" ou "Consumível").' });
        }
        if (localizacao && !LOCALIZACOES.includes(localizacao)) {
            return res.status(400).json({ error: 'Localização inválida.' });
        }

        const limit = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.limit) || PAGE_SIZE_PADRAO));

        let query = db.collection(COL_ITENS).where('categoria', '==', categoria);
        if (localizacao) query = query.where('localizacao', '==', localizacao);

        // Busca por prefixo do nome (case-sensitive — os dados importados estão
        // em CAIXA ALTA; cadastros novos devem seguir o mesmo padrão pra busca funcionar bem)
        if (busca && busca.trim()) {
            const termo = busca.trim();
            query = query.orderBy('nome').startAt(termo).endAt(termo + '');
        } else {
            query = query.orderBy('nome');
            if (req.query.cursor) {
                query = query.startAfter(req.query.cursor);
            }
        }

        const snap = await query.limit(limit + 1).get();
        const docs = snap.docs.slice(0, limit);
        const hasMore = snap.docs.length > limit;

        const itens = docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (categoria === 'Consumível') {
            await anexarProximaValidade(itens);
        }

        res.json({
            itens,
            hasMore,
            proximoCursor: hasMore ? itens[itens.length - 1].nome : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/almoxarifado-saude/itens/alertas?categoria=&tipo=baixo|vencimento
// Modo separado da listagem paginada — usado pelos filtros "só estoque baixo"
// e "só vencendo/vencido". Como esses casos tendem a ser poucos itens (a
// maioria não tem estoqueMinimo/validade definidos), a consulta já sai
// pequena por natureza, sem precisar paginar.
router.get('/itens/alertas', verifyToken, checkPermission, async (req, res) => {
    try {
        const { categoria, tipo } = req.query;
        if (!categoria || !CATEGORIAS.includes(categoria)) {
            return res.status(400).json({ error: 'Informe uma categoria válida.' });
        }
        if (tipo !== 'baixo' && tipo !== 'vencimento') {
            return res.status(400).json({ error: 'Tipo de alerta inválido. Use "baixo" ou "vencimento".' });
        }

        if (tipo === 'baixo') {
            const snap = await db.collection(COL_ITENS)
                .where('categoria', '==', categoria)
                .where('estoqueMinimo', '>', 0)
                .get();
            const itens = snap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(it => it.quantidade <= it.estoqueMinimo)
                .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
            if (categoria === 'Consumível') await anexarProximaValidade(itens);
            return res.json({ itens, hasMore: false, proximoCursor: null });
        }

        // tipo === 'vencimento': só existe pra Consumível (Permanente não tem lote)
        if (categoria !== 'Consumível') {
            return res.json({ itens: [], hasMore: false, proximoCursor: null });
        }
        const hoje = new Date().toISOString().slice(0, 10);
        const limite = new Date(Date.now() + DIAS_VENCENDO * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const lotesSnap = await db.collection(COL_LOTES).where('validade', '<=', limite).get();
        const itemIds = [...new Set(lotesSnap.docs.map(d => d.data().itemId))];
        if (!itemIds.length) return res.json({ itens: [], hasMore: false, proximoCursor: null });

        const itensPorId = {};
        for (let i = 0; i < itemIds.length; i += 30) {
            const chunk = itemIds.slice(i, i + 30);
            const snap = await db.collection(COL_ITENS)
                .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
                .get();
            snap.forEach(doc => {
                if (doc.data().categoria === categoria) itensPorId[doc.id] = { id: doc.id, ...doc.data() };
            });
        }
        const itens = Object.values(itensPorId);
        await anexarProximaValidade(itens);
        itens.sort((a, b) => (a.proximaValidade || '9999').localeCompare(b.proximaValidade || '9999'));
        res.json({ itens, hasMore: false, proximoCursor: null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/almoxarifado-saude/itens - Cadastrar item (Consumível ou Permanente)
router.post('/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const { nome, categoria, unidade, localizacao, estoqueMinimo, observacao, quantidadeInicial, validadeInicial } = req.body;

        if (!nome || !nome.trim()) {
            return res.status(400).json({ error: 'O nome do item é obrigatório.' });
        }
        if (!CATEGORIAS.includes(categoria)) {
            return res.status(400).json({ error: 'Categoria inválida. Use "Permanente" ou "Consumível".' });
        }
        if (!unidade || !unidade.trim()) {
            return res.status(400).json({ error: 'A unidade de medida é obrigatória (ex.: unidade, caixa, frasco).' });
        }
        if (!localizacao || !LOCALIZACOES.includes(localizacao)) {
            return res.status(400).json({ error: 'Informe uma localização/sala válida.' });
        }
        if (validadeInicial && !/^\d{4}-\d{2}-\d{2}$/.test(validadeInicial)) {
            return res.status(400).json({ error: 'Data de validade inválida (use o formato AAAA-MM-DD).' });
        }

        const qtdInicial = Math.max(0, parseInt(quantidadeInicial) || 0);
        const now = new Date().toISOString();
        const newDoc = db.collection(COL_ITENS).doc();

        await newDoc.set({
            nome: nome.trim(),
            categoria,
            unidade: unidade.trim(),
            localizacao,
            estoqueMinimo: Math.max(0, parseInt(estoqueMinimo) || 0),
            observacao: (observacao || '').trim(),
            quantidade: qtdInicial,
            conferidoEm: categoria === 'Permanente' ? now : null,
            conferidoPor: categoria === 'Permanente' ? req.user.uid : null,
            ativo: true,
            criadoPor: req.user.uid,
            criadoEm: now
        });

        // Consumível ganha um lote (com validade opcional), rastreado desde a origem
        if (categoria === 'Consumível' && qtdInicial > 0) {
            const loteRef = db.collection(COL_LOTES).doc();
            await loteRef.set({
                itemId: newDoc.id,
                lote: 'Estoque inicial',
                validade: validadeInicial || null,
                quantidade: qtdInicial,
                criadoEm: now
            });
            await db.collection(COL_MOV).add({
                itemId: newDoc.id,
                itemNome: nome.trim(),
                loteId: loteRef.id,
                lote: 'Estoque inicial',
                tipo: 'entrada',
                quantidade: qtdInicial,
                motivo: 'Estoque inicial',
                realizadoPor: req.user.uid,
                realizadoEm: now
            });
        }

        res.status(201).json({ message: 'Item cadastrado com sucesso!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/almoxarifado-saude/itens/:id - Editar dados do item (não altera quantidade/categoria)
router.put('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { nome, unidade, localizacao, estoqueMinimo, observacao } = req.body;

        if (!nome || !nome.trim()) {
            return res.status(400).json({ error: 'O nome do item é obrigatório.' });
        }
        if (!unidade || !unidade.trim()) {
            return res.status(400).json({ error: 'A unidade de medida é obrigatória.' });
        }
        if (!localizacao || !LOCALIZACOES.includes(localizacao)) {
            return res.status(400).json({ error: 'Informe uma localização/sala válida.' });
        }

        await db.collection(COL_ITENS).doc(req.params.id).update({
            nome: nome.trim(),
            unidade: unidade.trim(),
            localizacao,
            estoqueMinimo: Math.max(0, parseInt(estoqueMinimo) || 0),
            observacao: (observacao || '').trim(),
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.uid
        });
        res.json({ message: 'Item atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/almoxarifado-saude/itens/:id/conferencia - Ajuste direto de quantidade (só Permanente)
router.patch('/itens/:id/conferencia', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ITENS).doc(req.params.id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Item não encontrado.' });
        }
        if (doc.data().categoria !== 'Permanente') {
            return res.status(400).json({ error: 'Conferência direta só se aplica a itens de Patrimônio (Permanente). Consumíveis usam entrada/saída.' });
        }

        const qtd = parseInt(req.body.quantidade);
        if (!Number.isInteger(qtd) || qtd < 0) {
            return res.status(400).json({ error: 'Informe uma quantidade válida (maior ou igual a zero).' });
        }

        const now = new Date().toISOString();
        await ref.update({
            quantidade: qtd,
            conferidoEm: now,
            conferidoPor: req.user.uid
        });
        res.json({ message: 'Conferência registrada com sucesso!', quantidade: qtd, conferidoEm: now });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/almoxarifado-saude/itens/:id - Excluir item (com lotes e movimentações)
router.delete('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ITENS).doc(req.params.id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Item não encontrado.' });
        }

        const [lotesSnap, movSnap] = await Promise.all([
            db.collection(COL_LOTES).where('itemId', '==', req.params.id).get(),
            db.collection(COL_MOV).where('itemId', '==', req.params.id).get()
        ]);

        const docs = [...lotesSnap.docs, ...movSnap.docs];
        while (docs.length) {
            const batch = db.batch();
            docs.splice(0, 400).forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
        await ref.delete();

        res.json({ message: 'Item excluído com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// LOTES (só Consumível)
// ==========================================

// GET /api/almoxarifado-saude/itens/:id/lotes - Lotes do item, mais próximo de vencer primeiro
router.get('/itens/:id/lotes', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_LOTES).where('itemId', '==', req.params.id).get();
        const lotes = [];
        snap.forEach(doc => lotes.push({ id: doc.id, ...doc.data() }));
        // Sem validade = nunca vence, então vai por último; com validade, ordem crescente (FEFO)
        lotes.sort((a, b) => {
            if (!a.validade && !b.validade) return 0;
            if (!a.validade) return 1;
            if (!b.validade) return -1;
            return a.validade.localeCompare(b.validade);
        });
        res.json(lotes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// MOVIMENTAÇÕES (entrada/saída, só Consumível)
// ==========================================

// GET /api/almoxarifado-saude/movimentacoes?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
router.get('/movimentacoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const { inicio, fim } = req.query;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(fim || '')) {
            return res.status(400).json({ error: 'Informe o período (inicio e fim, formato YYYY-MM-DD).' });
        }

        const snap = await db.collection(COL_MOV)
            .where('realizadoEm', '>=', `${inicio}T00:00:00.000Z`)
            .where('realizadoEm', '<=', `${fim}T23:59:59.999Z`)
            .orderBy('realizadoEm', 'desc')
            .get();

        const movimentacoes = [];
        snap.forEach(doc => movimentacoes.push({ id: doc.id, ...doc.data() }));
        res.json(movimentacoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/almoxarifado-saude/itens/:id/movimentacoes - Histórico do item (mais recente primeiro)
router.get('/itens/:id/movimentacoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_MOV)
            .where('itemId', '==', req.params.id)
            .orderBy('realizadoEm', 'desc')
            .get();
        const movimentacoes = [];
        snap.forEach(doc => movimentacoes.push({ id: doc.id, ...doc.data() }));
        res.json(movimentacoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/almoxarifado-saude/itens/:id/movimentacoes - Registrar entrada/saída
// Consumível: entrada informa loteId (soma num lote existente) OU loteNome/validade
// (cria lote novo); saída exige loteId (de qual lote está saindo).
// Permanente (Patrimônio): sem lote — só quantidade + motivo.
router.post('/itens/:id/movimentacoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const { tipo, quantidade, motivo, loteId, loteNome, validade } = req.body;

        if (tipo !== 'entrada' && tipo !== 'saida') {
            return res.status(400).json({ error: 'Tipo de movimentação inválido. Use "entrada" ou "saida".' });
        }
        const qtd = parseInt(quantidade);
        if (!Number.isInteger(qtd) || qtd <= 0) {
            return res.status(400).json({ error: 'Informe uma quantidade válida (maior que zero).' });
        }
        if (!motivo || !motivo.trim()) {
            return res.status(400).json({ error: 'Informe o motivo da movimentação.' });
        }
        if (tipo === 'entrada' && validade && !/^\d{4}-\d{2}-\d{2}$/.test(validade)) {
            return res.status(400).json({ error: 'Data de validade inválida (use o formato AAAA-MM-DD).' });
        }

        const itemRef = db.collection(COL_ITENS).doc(req.params.id);
        const now = new Date().toISOString();

        const resultado = await db.runTransaction(async (t) => {
            const itemDoc = await t.get(itemRef);
            if (!itemDoc.exists) {
                throw Object.assign(new Error('Item não encontrado.'), { status: 404 });
            }
            const item = itemDoc.data();

            // Patrimônio (Permanente) não usa lote/validade — só entrada/saída
            // direta com motivo, sem afetar almoxarifado_lotes.
            if (item.categoria === 'Permanente') {
                if (tipo === 'saida' && qtd > item.quantidade) {
                    throw Object.assign(new Error(
                        `Estoque insuficiente: há ${item.quantidade} ${item.unidade || 'unidade(s)'} disponível(is).`
                    ), { status: 400 });
                }
                const novaQuantidadeItem = tipo === 'entrada' ? item.quantidade + qtd : item.quantidade - qtd;
                t.update(itemRef, { quantidade: novaQuantidadeItem });

                const movRef = db.collection(COL_MOV).doc();
                t.set(movRef, {
                    itemId: req.params.id,
                    itemNome: item.nome,
                    loteId: null,
                    lote: null,
                    tipo,
                    quantidade: qtd,
                    motivo: motivo.trim(),
                    realizadoPor: req.user.uid,
                    realizadoEm: now
                });

                return { quantidadeItem: novaQuantidadeItem };
            }

            if (tipo === 'saida' && !loteId) {
                throw Object.assign(new Error('Informe de qual lote a saída deve ser descontada.'), { status: 400 });
            }

            let loteRef, loteData, loteNomeFinal;

            if (loteId) {
                loteRef = db.collection(COL_LOTES).doc(loteId);
                const loteDoc = await t.get(loteRef);
                if (!loteDoc.exists || loteDoc.data().itemId !== req.params.id) {
                    throw Object.assign(new Error('Lote não encontrado para este item.'), { status: 404 });
                }
                loteData = loteDoc.data();
                loteNomeFinal = loteData.lote;

                if (tipo === 'saida') {
                    if (qtd > loteData.quantidade) {
                        throw Object.assign(new Error(
                            `Estoque insuficiente no lote "${loteData.lote}": há ${loteData.quantidade} ${item.unidade || 'unidade(s)'} disponível(is).`
                        ), { status: 400 });
                    }
                    const restante = loteData.quantidade - qtd;
                    if (restante === 0) {
                        t.delete(loteRef);
                    } else {
                        t.update(loteRef, { quantidade: restante });
                    }
                } else {
                    t.update(loteRef, { quantidade: loteData.quantidade + qtd });
                }
            } else {
                // Só entrada chega aqui sem loteId — cria lote novo
                loteRef = db.collection(COL_LOTES).doc();
                loteNomeFinal = (loteNome || '').trim() || `Entrada ${now.slice(0, 10).split('-').reverse().join('/')}`;
                t.set(loteRef, {
                    itemId: req.params.id,
                    lote: loteNomeFinal,
                    validade: validade || null,
                    quantidade: qtd,
                    criadoEm: now
                });
            }

            const novaQuantidadeItem = tipo === 'entrada' ? item.quantidade + qtd : Math.max(0, item.quantidade - qtd);
            t.update(itemRef, { quantidade: novaQuantidadeItem });

            const movRef = db.collection(COL_MOV).doc();
            t.set(movRef, {
                itemId: req.params.id,
                itemNome: item.nome,
                loteId: loteRef.id,
                lote: loteNomeFinal,
                tipo,
                quantidade: qtd,
                motivo: motivo.trim(),
                realizadoPor: req.user.uid,
                realizadoEm: now
            });

            return { quantidadeItem: novaQuantidadeItem };
        });

        res.status(201).json({ message: 'Movimentação registrada com sucesso!', ...resultado });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ==========================================
// STATS (resumo/dashboard)
// ==========================================

// GET /api/almoxarifado-saude/stats
router.get('/stats', verifyToken, checkPermission, async (req, res) => {
    try {
        const hoje = new Date().toISOString().slice(0, 10);
        const limiteVencendo = new Date(Date.now() + DIAS_VENCENDO * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const [totalSnap, permanenteSnap, consumivelSnap, comMinimoSnap, vencidosSnap, vencendoSnap] = await Promise.all([
            db.collection(COL_ITENS).count().get(),
            db.collection(COL_ITENS).where('categoria', '==', 'Permanente').count().get(),
            db.collection(COL_ITENS).where('categoria', '==', 'Consumível').count().get(),
            db.collection(COL_ITENS).where('estoqueMinimo', '>', 0).get(),
            db.collection(COL_LOTES).where('validade', '<', hoje).count().get(),
            db.collection(COL_LOTES).where('validade', '>=', hoje).where('validade', '<=', limiteVencendo).count().get()
        ]);

        const abaixoMinimo = comMinimoSnap.docs.filter(d => d.data().quantidade <= d.data().estoqueMinimo).length;

        res.json({
            total: totalSnap.data().count,
            permanente: permanenteSnap.data().count,
            consumivel: consumivelSnap.data().count,
            abaixoMinimo,
            vencidos: vencidosSnap.data().count,
            vencendo: vencendoSnap.data().count,
            diasVencendo: DIAS_VENCENDO
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// RELATÓRIO DE ESTOQUE (snapshot completo, gerado sob demanda)
// ==========================================

// GET /api/almoxarifado-saude/relatorio-estoque?categoria=
// Ao contrário de GET /itens (paginado), aqui traz a categoria inteira de
// propósito — é uma ação explícita e ocasional (clicar em "Gerar relatório"),
// não algo disparado a cada abertura de tela/troca de aba.
router.get('/relatorio-estoque', verifyToken, checkPermission, async (req, res) => {
    try {
        const { categoria } = req.query;
        if (!categoria || !CATEGORIAS.includes(categoria)) {
            return res.status(400).json({ error: 'Informe uma categoria válida.' });
        }

        const snap = await db.collection(COL_ITENS).where('categoria', '==', categoria).orderBy('nome').get();
        const itens = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (categoria === 'Consumível') {
            await anexarProximaValidade(itens);
        }

        res.json(itens);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
