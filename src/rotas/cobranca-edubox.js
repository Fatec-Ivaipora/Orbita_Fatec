// ==========================================================================
// Cobrança com dados do Edubox (/api/cobranca/edubox). Os números vêm do
// agente que roda num PC da Fatec (scripts/cobranca-edubox-agente.js) e
// grava resumos prontos no Firestore — aqui só lemos esses resumos e
// guardamos o que é do Órbita: ações de cobrança (WhatsApp, ligação,
// promessa...), o controle de "quem já foi cobrado" e os modelos de mensagem.
// ==========================================================================
const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('cobranca');

const COL_ACOES = 'financeiro_cobranca_acoes';           // mesmo histórico da Cobrança antiga (chave CPF)
const DOC_CONTROLE = db.collection('financeiro_cobranca_controle').doc('resumo');
const DOC_SYNC = db.collection('config').doc('cobranca_sync');
const DOC_MODELOS = db.collection('config').doc('cobranca_mensagens');

// Tipos que contam como "aluno cobrado" no controle da lista.
const TIPOS_COBRANCA = ['whatsapp', 'ligacao', 'email', 'contato', 'negociacao', 'promessa_pagamento'];
const TIPOS_VALIDOS = [...TIPOS_COBRANCA, 'enviado_advocacia', 'acordo_judicial', 'outro'];

const MODELOS_PADRAO = [
    {
        id: 'lembrete', nome: 'Lembrete (até 30 dias)',
        texto: 'Olá, {primeiro_nome}! Tudo bem? 😊\n\nAqui é do Financeiro da Fatec Ivaiporã. Consta em nosso sistema {qtd_parcelas} em aberto. Com multa e juros, o valor para pagamento hoje é de {valor_a_pagar}:\n{lista_parcelas}\n\nSe já realizou o pagamento, por favor desconsidere esta mensagem. Precisando da 2ª via do boleto ou de alguma condição, é só responder por aqui!'
    },
    {
        id: 'cobranca', nome: 'Cobrança (mais de 30 dias)',
        texto: 'Olá, {primeiro_nome}! Aqui é do Financeiro da Fatec Ivaiporã.\n\nIdentificamos {qtd_parcelas} em atraso desde {vencimento_mais_antigo}. Com multa e juros, o valor para pagamento hoje é de {valor_a_pagar}:\n{lista_parcelas}\n\nPrecisamos regularizar essa pendência. Podemos conversar sobre uma forma de pagamento que caiba no seu orçamento? Responda esta mensagem ou venha até o Financeiro.'
    },
    {
        id: 'negociacao', nome: 'Proposta de negociação',
        texto: 'Olá, {primeiro_nome}! Tudo bem?\n\nO Financeiro da Fatec Ivaiporã está com condições especiais para negociação de débitos. Hoje o seu débito é de {valor_a_pagar} com multa e juros ({qtd_parcelas}).\n\nQuer que eu faça uma simulação de parcelamento pra você? É só responder por aqui.'
    }
];

function nomeUsuario(req) {
    return req.user.name || req.user.email || '';
}

// ---------- STATUS / ATUALIZAR AGORA ----------
router.get('/status', verifyToken, checkPermission, async (req, res) => {
    try {
        const d = await DOC_SYNC.get();
        res.json(d.exists ? d.data() : {});
    } catch (err) {
        console.error('[cobranca-edubox] status:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/atualizar', verifyToken, checkPermission, async (req, res) => {
    try {
        const pedidoEm = new Date().toISOString();
        await DOC_SYNC.set({ pedidoEm, pedidoPor: req.user.uid, pedidoPorNome: nomeUsuario(req) }, { merge: true });
        res.json({ pedidoEm });
    } catch (err) {
        console.error('[cobranca-edubox] atualizar:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- PAINEL ----------
// Resumo atual + fechamento da semana (segunda a domingo) de ?semana=AAAA-MM-DD
// (qualquer dia da semana; padrão: semana atual).
function segundaDe(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    const x = new Date(a, m - 1, d, 12);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
}
function isoData(x) {
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

router.get('/painel', verifyToken, checkPermission, async (req, res) => {
    try {
        const hoje = isoData(new Date());
        const ref = /^\d{4}-\d{2}-\d{2}$/.test(req.query.semana || '') ? req.query.semana : hoje;
        const seg = segundaDe(ref);
        const dom = new Date(seg); dom.setDate(dom.getDate() + 6);
        const ini = isoData(seg), fim = isoData(dom);
        const antes = new Date(seg); antes.setDate(antes.getDate() - 3);

        const [atual, baixasSnap, fotosSnap, fotoAnterior, sync] = await Promise.all([
            db.collection('cobranca_edubox').doc('atual').get(),
            db.collection('cobranca_edubox_baixas').where('data', '>=', ini).where('data', '<=', fim).get(),
            db.collection('cobranca_edubox_historico').where('data', '>=', ini).where('data', '<=', fim).get(),
            // se o PC não rodou na segunda, o "início da semana" é a última foto antes dela
            db.collection('cobranca_edubox_historico').where('data', '>=', isoData(antes)).where('data', '<', ini).get(),
            DOC_SYNC.get()
        ]);
        if (!atual.exists) return res.json({ vazio: true, status: sync.exists ? sync.data() : {} });

        const fotos = fotosSnap.docs.map(d => d.data()).sort((a, b) => a.geradoEm.localeCompare(b.geradoEm));
        const anteriores = fotoAnterior.docs.map(d => d.data()).sort((a, b) => a.geradoEm.localeCompare(b.geradoEm));
        const inicio = anteriores.length ? anteriores[anteriores.length - 1] : (fotos[0] || null);
        const ultima = fotos.length ? fotos[fotos.length - 1] : null;

        res.json({
            ...atual.data(),
            status: sync.exists ? sync.data() : {},
            semana: {
                inicio: ini, fim,
                fotoInicio: inicio,           // vencido no começo da semana
                fotoFim: ultima,              // última foto da semana (ou a atual)
                baixas: baixasSnap.docs.map(d => d.data()).sort((a, b) => a.data.localeCompare(b.data))
            }
        });
    } catch (err) {
        console.error('[cobranca-edubox] painel:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- LISTA DE COBRANÇA ----------
// Primeiro acesso: monta o controle a partir do histórico que já existia.
async function lerControle() {
    const d = await DOC_CONTROLE.get();
    if (d.exists) return d.data().alunos || {};
    const snap = await db.collection(COL_ACOES).get();
    const alunos = {};
    snap.docs.forEach(doc => {
        const a = doc.data();
        const chave = a.chave || a.cpf;
        if (!chave || !TIPOS_COBRANCA.includes(a.tipo) || !a.criadoEm) return;
        const em = a.criadoEm.toDate ? a.criadoEm.toDate().toISOString() : a.criadoEm;
        const atual = alunos[chave] || { n: 0 };
        atual.n += 1;
        if (!atual.em || em > atual.em) Object.assign(atual, { em, por: a.criadoPorNome || '', tipo: a.tipo });
        alunos[chave] = atual;
    });
    await DOC_CONTROLE.set({ alunos });
    return alunos;
}

router.get('/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        const grupo = req.query.grupo === 'medicina' ? 'medicina' : 'graduacao';
        const [lista, controle] = await Promise.all([
            db.collection('cobranca_edubox_alunos').doc(grupo).get(),
            lerControle()
        ]);
        res.json({
            geradoEm: lista.exists ? lista.data().geradoEm : null,
            alunos: lista.exists ? lista.data().alunos : [],
            planos: lista.exists ? (lista.data().planos || []) : [],
            controle
        });
    } catch (err) {
        console.error('[cobranca-edubox] alunos:', err);
        res.status(500).json({ error: err.message });
    }
});

// Histórico de ações de um aluno (chave = CPF, ou "cli<código>" sem CPF).
router.get('/acoes/:chave', verifyToken, checkPermission, async (req, res) => {
    try {
        const chave = req.params.chave;
        const campo = /^\d{11}$/.test(chave) ? 'cpf' : 'chave';
        const snap = await db.collection(COL_ACOES).where(campo, '==', chave).get();
        const lista = snap.docs.map(d => {
            const a = d.data();
            return { id: d.id, ...a, criadoEm: a.criadoEm && a.criadoEm.toDate ? a.criadoEm.toDate().toISOString() : a.criadoEm };
        }).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
        res.json(lista);
    } catch (err) {
        console.error('[cobranca-edubox] histórico:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/acoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const { chave, nomeAluno, tipo, observacoes, mensagem, promessaData, promessaValor, grupo } = req.body;
        if (!chave || !/^(\d{11}|cli\d+)$/.test(chave)) return res.status(400).json({ error: 'Aluno inválido.' });
        if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de ação inválido.' });
        if (tipo === 'promessa_pagamento' && !/^\d{4}-\d{2}-\d{2}$/.test(promessaData || '')) {
            return res.status(400).json({ error: 'Informe a data prometida.' });
        }
        const agora = new Date().toISOString();
        const doc = {
            chave,
            cpf: /^\d{11}$/.test(chave) ? chave : '',
            nomeAluno: (nomeAluno || '').toString().trim(),
            grupo: grupo === 'medicina' ? 'medicina' : 'graduacao',
            tipo,
            escritorio: '',
            observacoes: (observacoes || '').toString().trim().slice(0, 2000),
            mensagem: (mensagem || '').toString().slice(0, 4000),
            promessaData: tipo === 'promessa_pagamento' ? promessaData : null,
            promessaValor: tipo === 'promessa_pagamento' ? Math.round((Number(promessaValor) || 0) * 100) / 100 : null,
            origem: 'edubox',
            criadoPor: req.user.uid,
            criadoPorNome: nomeUsuario(req),
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
        };
        const ref = await db.collection(COL_ACOES).add(doc);

        if (TIPOS_COBRANCA.includes(tipo)) {
            await lerControle(); // garante que o doc existe
            const upd = {
                [`alunos.${chave}.em`]: agora,
                [`alunos.${chave}.por`]: doc.criadoPorNome,
                [`alunos.${chave}.tipo`]: tipo,
                [`alunos.${chave}.n`]: admin.firestore.FieldValue.increment(1)
            };
            if (tipo === 'promessa_pagamento') {
                upd[`alunos.${chave}.promessa`] = { data: promessaData, valor: doc.promessaValor };
            }
            await DOC_CONTROLE.update(upd);
        }
        res.status(201).json({ id: ref.id, ...doc, criadoEm: agora });
    } catch (err) {
        console.error('[cobranca-edubox] registrar ação:', err);
        res.status(500).json({ error: err.message });
    }
});

// Excluir ação lançada errado. O controle ("cobrado em") é recalculado
// para o aluno a partir do que sobrou no histórico.
router.delete('/acoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ACOES).doc(req.params.id);
        const d = await ref.get();
        if (!d.exists) return res.status(404).json({ error: 'Ação não encontrada.' });
        const a = d.data();
        await ref.delete();
        const chave = a.chave || a.cpf;
        if (chave && TIPOS_COBRANCA.includes(a.tipo)) {
            await lerControle();
            const campo = /^\d{11}$/.test(chave) ? 'cpf' : 'chave';
            const resto = (await db.collection(COL_ACOES).where(campo, '==', chave).get()).docs
                .map(x => x.data())
                .filter(x => TIPOS_COBRANCA.includes(x.tipo) && x.criadoEm)
                .map(x => ({ ...x, em: x.criadoEm.toDate ? x.criadoEm.toDate().toISOString() : x.criadoEm }))
                .sort((x, y) => y.em.localeCompare(x.em));
            const promessa = resto.find(x => x.tipo === 'promessa_pagamento');
            await DOC_CONTROLE.update({
                [`alunos.${chave}`]: resto.length
                    ? { em: resto[0].em, por: resto[0].criadoPorNome || '', tipo: resto[0].tipo, n: resto.length, ...(promessa ? { promessa: { data: promessa.promessaData, valor: promessa.promessaValor } } : {}) }
                    : admin.firestore.FieldValue.delete()
            });
        }
        res.json({ message: 'Ação removida.' });
    } catch (err) {
        console.error('[cobranca-edubox] excluir ação:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- VISÃO DO DIRETOR: resumo por semana (gráfico) ----------
router.get('/semanas', verifyToken, checkPermission, async (req, res) => {
    try {
        const d = await db.collection('cobranca_edubox').doc('semanas').get();
        res.json(d.exists ? d.data() : { semanas: {} });
    } catch (err) {
        console.error('[cobranca-edubox] semanas:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- RETORNO DA SEMANA (relatório pro Fábio) ----------
// Ações de cobrança registradas entre ?inicio e ?fim (AAAA-MM-DD) e quem,
// dos cobrados, pagou alguma coisa no Edubox DEPOIS da 1ª cobrança da semana
// (pagamentos dos últimos 60 dias, gravados pelo agente).
router.get('/retorno', verifyToken, checkPermission, async (req, res) => {
    try {
        const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
        if (!ok(req.query.inicio) || !ok(req.query.fim)) return res.status(400).json({ error: 'Informe o período.' });
        const de = new Date(`${req.query.inicio}T00:00:00-03:00`);
        const ate = new Date(`${req.query.fim}T23:59:59-03:00`);
        const [acoesSnap, pagSnap] = await Promise.all([
            db.collection(COL_ACOES).where('criadoEm', '>=', de).where('criadoEm', '<=', ate).get(),
            db.collection('cobranca_edubox_pagamentos').doc('recentes').get()
        ]);
        const pagamentos = pagSnap.exists ? (pagSnap.data().porAluno || {}) : {};
        const alunos = {};
        acoesSnap.docs.forEach(d => {
            const a = d.data();
            if (!TIPOS_COBRANCA.includes(a.tipo)) return;
            const chave = a.chave || a.cpf;
            if (!chave) return;
            const em = a.criadoEm && a.criadoEm.toDate ? a.criadoEm.toDate().toISOString() : a.criadoEm;
            const x = (alunos[chave] = alunos[chave] || { chave, nome: a.nomeAluno || '', grupo: a.grupo || 'graduacao', acoes: [], primeiraEm: em, promessa: null });
            x.acoes.push({ tipo: a.tipo, em, por: a.criadoPorNome || '' });
            if (em < x.primeiraEm) x.primeiraEm = em;
            if (a.tipo === 'promessa_pagamento') x.promessa = { data: a.promessaData, valor: a.promessaValor };
        });
        // pagou depois da 1ª cobrança (dia da cobrança em diante, horário de Brasília)
        const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
        for (const x of Object.values(alunos)) {
            const desde = diaBR(x.primeiraEm);
            const dias = pagamentos[x.chave] || {};
            x.pagouDepois = Math.round(Object.entries(dias).filter(([d]) => d >= desde).reduce((s2, [, v]) => s2 + v, 0) * 100) / 100;
            x.acoes.sort((a, b) => a.em.localeCompare(b.em));
        }
        res.json({ alunos: Object.values(alunos), pagamentosAte: pagSnap.exists ? pagSnap.data().geradoEm : null });
    } catch (err) {
        console.error('[cobranca-edubox] retorno:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- MODELOS DE MENSAGEM ----------
router.get('/modelos', verifyToken, checkPermission, async (req, res) => {
    try {
        const d = await DOC_MODELOS.get();
        res.json(d.exists && Array.isArray(d.data().modelos) && d.data().modelos.length ? d.data().modelos : MODELOS_PADRAO);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/modelos', verifyToken, checkPermission, async (req, res) => {
    try {
        const modelos = (Array.isArray(req.body.modelos) ? req.body.modelos : [])
            .map((m, i) => ({
                id: (m.id || `m${Date.now()}${i}`).toString().slice(0, 40),
                nome: (m.nome || '').toString().trim().slice(0, 80),
                texto: (m.texto || '').toString().slice(0, 3000)
            }))
            .filter(m => m.nome && m.texto.trim());
        if (!modelos.length) return res.status(400).json({ error: 'Deixe pelo menos um modelo.' });
        await DOC_MODELOS.set({ modelos, atualizadoEm: new Date().toISOString(), atualizadoPor: nomeUsuario(req) });
        res.json(modelos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
