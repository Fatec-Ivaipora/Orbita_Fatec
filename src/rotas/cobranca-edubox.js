// ==========================================================================
// Cobrança com dados do Edubox (/api/cobranca/edubox). Os números vêm do
// agente que roda no servidor do relay (scripts/cobranca-edubox-agente.js, serviço orbita-cobranca-agente) e
// grava resumos prontos no Firestore — aqui só lemos esses resumos e
// guardamos o que é do Órbita: ações de cobrança (WhatsApp, ligação,
// promessa...), o controle de "quem já foi cobrado" e os modelos de mensagem.
// ==========================================================================
const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { relay } = require('../utils/edubox-relay');
const crypto = require('crypto');

const checkPermission = verifyToken.requireModulePermission('cobranca');

const COL_ACOES = 'financeiro_cobranca_acoes';           // mesmo histórico da Cobrança antiga (chave CPF)
const DOC_CONTROLE = db.collection('financeiro_cobranca_controle').doc('resumo');
const DOC_SYNC = db.collection('config').doc('cobranca_sync');
const DOC_MODELOS = db.collection('config').doc('cobranca_mensagens');

// Tipos que contam como "aluno cobrado" no controle da lista.
const TIPOS_COBRANCA = ['whatsapp', 'ligacao', 'email', 'contato', 'negociacao', 'promessa_pagamento'];
const TIPOS_VALIDOS = [...TIPOS_COBRANCA, 'enviado_advocacia', 'acordo_judicial', 'outro'];

// Textos do próprio Financeiro (02/10/2026). Sem valores nem lista de
// parcelas — o Financeiro não manda valor por mensagem. {saudacao} vira
// Bom dia / Boa tarde / Boa noite conforme a hora do envio.
const MODELOS_PADRAO = [
    {
        id: 'uma_parcela', nome: '1 mensalidade vencida',
        texto: 'Olá, {saudacao}!\nAqui é do FINANCEIRO DA FATEC.\nConsta em nosso sistema que você está com pendência financeira.\nPara pagar com o valor atualizado temos uma opção bem bacana.\nMe chama aqui que posso te ajudar!'
    },
    {
        id: 'semestre', nome: 'Mensalidades do semestre vencidas',
        texto: 'Olá, {saudacao}!\nVerificamos em nosso sistema que constam pendências financeiras em aberto.\nPodemos negociar o pagamento aqui mesmo, pelo WhatsApp. Para isso basta responder esta mensagem para que possamos chegar a um acordo ou procure o setor financeiro para possível regularização.\nAtenciosamente,\nDepartamento Financeiro Fatec Ivaiporã'
    },
    {
        id: 'acumulo', nome: 'Renegociação e semestres anteriores vencidos',
        texto: 'Olá, {saudacao}!\nAqui é do Departamento Financeiro da Fatec\nConsta em nosso sistema que você está com acúmulo de parcelas vencidas.\nAguardamos sua resposta ainda hoje, com o pagamento ou possível acordo para evitar medidas de cobranças cabíveis.\nMe chama aqui que posso te ajudar!'
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

// ---------- VISÃO CONSULTORIA ----------
// Ano inteiro na régua do painel da consultoria Fiasini (4 grupos somados).
// Doc separado do "atual": só é lido quando escolhem essa opção na tela.
router.get('/consultoria', verifyToken, checkPermission, async (req, res) => {
    try {
        const d = await db.collection('cobranca_edubox').doc('consultoria').get();
        res.json(d.exists ? d.data() : { vazio: true });
    } catch (err) {
        console.error('[cobranca-edubox] consultoria:', err);
        res.status(500).json({ error: err.message });
    }
});

// "Ao vivo" (04/11/2026): a tela chama ao abrir. Quem só visualiza (nível 2) também pode — o servidor é
// que decide: só pede nova busca no Edubox se os dados tiverem mais de AO_VIVO_MIN, se não houver
// atualização rodando e se ninguém pediu no último minuto (várias pessoas abrindo = 1 busca só).
const AO_VIVO_MIN = 10;
router.get('/ao-vivo', verifyToken, checkPermission, async (req, res) => {
    try {
        const st = (await DOC_SYNC.get()).data() || {};
        const agora = Date.now();
        const idade = (iso) => iso ? agora - new Date(iso).getTime() : Infinity;
        if (st.status === 'rodando' && idade(st.rodandoDesde) < 5 * 60000) return res.json({ acompanhar: st.rodandoDesde });
        if (idade(st.pedidoEm) < 60000) return res.json({ acompanhar: st.pedidoEm });
        if (idade(st.agenteVivoEm) > 15 * 60000) return res.json({ foraDoAr: true });
        if (idade(st.ultimaAtualizacao) <= AO_VIVO_MIN * 60000) return res.json({ emDia: true });
        const pedidoEm = new Date().toISOString();
        await DOC_SYNC.set({ pedidoEm, pedidoPor: req.user.uid, pedidoPorNome: `${nomeUsuario(req)} (ao abrir a tela)` }, { merge: true });
        res.json({ acompanhar: pedidoEm });
    } catch (err) {
        console.error('[cobranca-edubox] ao-vivo:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- CONFERÊNCIA AUTOMÁTICA COM O EDUBOX (04/11/2026) ----------
// Compara a lista da Cobrança (gravada pelo agente) com o Edubox AGORA, pelo relay
// (/cobranca-conferencia/vencidas): por aluno (CPF, via md5) e grupo, nº de parcelas vencidas, total em aberto,
// parte jurídica e parte "para enviar ao advogado". Só roda logo depois de uma atualização (dados com até
// CONF_JANELA_MIN); o resultado fica em cobranca_edubox/conferencia, ligado à atualização conferida —
// a mesma atualização não é conferida duas vezes (abrir a tela de novo só lê o resultado guardado).
const DOC_CONFERENCIA = db.collection('cobranca_edubox').doc('conferencia');
const CONF_JANELA_MIN = 15;
const dataBrasilia = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD

function somarLista(alunos, grupo) {
    const mapa = {};
    for (const a of alunos || []) {
        // mesma chave do relay: md5 da chave do aluno (CPF ou "cli<código>")
        const k = `${crypto.createHash('md5').update(String(a.chave)).digest('hex')}|${grupo === 'medicina' ? 1 : 0}`;
        const x = (mapa[k] = mapa[k] || { codcli: a.codcli, grupo, nome: a.nome, n: 0, t: 0, j: 0, e: 0 });
        for (const p of a.parcelas || []) {
            x.n += 1; x.t += p.valor;
            if (p.j) x.j += p.valor;
            if (p.e) x.e += p.valor;
        }
    }
    return mapa;
}

async function conferir(st) {
    const ate = dataBrasilia(st.ultimaAtualizacao);
    const [r, gSnap, mSnap] = await Promise.all([
        relay(`/cobranca-conferencia/vencidas?ate=${ate}`, { timeoutMs: 45000 }),
        db.collection('cobranca_edubox_alunos').doc('graduacao').get(),
        db.collection('cobranca_edubox_alunos').doc('medicina').get()
    ]);
    const nossa = { ...somarLista(gSnap.exists ? gSnap.data().alunos : [], 'graduacao'), ...somarLista(mSnap.exists ? mSnap.data().alunos : [], 'medicina') };
    const edubox = {};
    for (const c of r.clientes || []) edubox[`${c.c}|${c.m ? 1 : 0}`] = c;
    const dif = [];
    const tot = { edubox: { alunos: 0, parcelas: 0, total: 0 }, orbita: { alunos: 0, parcelas: 0, total: 0 } };
    const cent = (v) => Math.round((Number(v) || 0) * 100);
    for (const k of new Set([...Object.keys(nossa), ...Object.keys(edubox)])) {
        const o = nossa[k], e = edubox[k];
        if (e) { tot.edubox.alunos++; tot.edubox.parcelas += e.n; tot.edubox.total += e.t; }
        if (o) { tot.orbita.alunos++; tot.orbita.parcelas += o.n; tot.orbita.total += o.t; }
        const iguais = o && e && o.n === e.n && cent(o.t) === cent(e.t) && cent(o.j) === cent(e.j) && cent(o.e) === cent(e.e);
        if (iguais) continue;
        dif.push({
            codcli: o ? o.codcli : null, grupo: k.endsWith('|1') ? 'medicina' : 'graduacao', nome: o ? o.nome : '',
            tipo: !o ? 'so_edubox' : !e ? 'so_orbita' : 'valor',
            orbita: o ? { n: o.n, t: Math.round(o.t * 100) / 100, j: Math.round(o.j * 100) / 100, e: Math.round(o.e * 100) / 100 } : null,
            edubox: e ? { n: e.n, t: e.t, j: e.j, e: e.e } : null
        });
    }
    tot.edubox.total = Math.round(tot.edubox.total * 100) / 100;
    tot.orbita.total = Math.round(tot.orbita.total * 100) / 100;
    dif.sort((x, y) => Math.abs((y.edubox?.t || 0) - (y.orbita?.t || 0)) - Math.abs((x.edubox?.t || 0) - (x.orbita?.t || 0)));
    const resultado = {
        conferidoEm: new Date().toISOString(), atualizacao: st.ultimaAtualizacao, ate,
        ok: dif.length === 0, totais: tot, diferencas: dif.slice(0, 200), nDiferencas: dif.length
    };
    await DOC_CONFERENCIA.set(resultado);
    return resultado;
}

let conferenciaEmAndamento = null;   // várias pessoas abrindo juntas = 1 conferência só
router.get('/conferencia', verifyToken, checkPermission, async (req, res) => {
    try {
        const [st, salvo] = await Promise.all([DOC_SYNC.get().then(d => d.data() || {}), DOC_CONFERENCIA.get().then(d => d.exists ? d.data() : null)]);
        if (!st.ultimaAtualizacao) return res.json({ semDados: true });
        if (salvo && salvo.atualizacao === st.ultimaAtualizacao) return res.json(salvo);           // já conferida
        const idadeMin = (Date.now() - new Date(st.ultimaAtualizacao).getTime()) / 60000;
        if (st.status === 'rodando' || idadeMin > CONF_JANELA_MIN) return res.json({ ...(salvo || {}), aguardando: true }); // confere na próxima atualização
        if (!conferenciaEmAndamento) conferenciaEmAndamento = conferir(st).finally(() => { conferenciaEmAndamento = null; });
        res.json(await conferenciaEmAndamento);
    } catch (err) {
        console.error('[cobranca-edubox] conferência:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ---------- LISTA DE COBRANÇA ----------
// Primeiro acesso: monta o controle a partir do histórico que já existia.
async function lerControle(comBloqueios = false) {
    const d = await DOC_CONTROLE.get();
    if (d.exists) return comBloqueios ? { alunos: d.data().alunos || {}, bloqueios: d.data().bloqueios || {} } : (d.data().alunos || {});
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
    return comBloqueios ? { alunos, bloqueios: {} } : alunos;
}

// "Não cobrar" (04/11/2026): o Financeiro marca o aluno que NÃO pode ser cobrado (com motivo) e desmarca
// quando a situação muda — aí ele volta a poder ser cobrado. Fica em `bloqueios.<chave>` do mesmo doc do
// controle (campo separado: o recálculo do "cobrado" ao excluir ação não mexe nele). Vale por CPF.
async function bloqueioDe(chave) {
    const d = await DOC_CONTROLE.get();
    return (d.exists && (d.data().bloqueios || {})[chave]) || null;
}

router.get('/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        const grupo = req.query.grupo === 'medicina' ? 'medicina' : 'graduacao';
        const [lista, ctl] = await Promise.all([
            db.collection('cobranca_edubox_alunos').doc(grupo).get(),
            lerControle(true)
        ]);
        res.json({
            geradoEm: lista.exists ? lista.data().geradoEm : null,
            alunos: lista.exists ? lista.data().alunos : [],
            planos: lista.exists ? (lista.data().planos || []) : [],
            controle: ctl.alunos,
            bloqueios: ctl.bloqueios
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
        if (TIPOS_COBRANCA.includes(tipo)) {
            const bl = await bloqueioDe(chave);
            if (bl) return res.status(409).json({ error: `Este aluno está marcado como NÃO COBRAR${bl.motivo ? ` (${bl.motivo})` : ''}. Libere a cobrança antes de registrar.` });
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

// Marcar / liberar "Não cobrar". Registra também no histórico do aluno (tipo "outro", não conta como cobrança).
router.put('/bloqueio/:chave', verifyToken, checkPermission, async (req, res) => {
    try {
        const chave = req.params.chave;
        if (!/^(\d{11}|cli\d+)$/.test(chave)) return res.status(400).json({ error: 'Aluno inválido.' });
        const bloquear = req.body.bloquear === true;
        const motivo = (req.body.motivo || '').toString().trim().slice(0, 300);
        if (bloquear && !motivo) return res.status(400).json({ error: 'Informe o motivo de não cobrar.' });
        await lerControle(); // garante que o doc existe
        const agora = new Date().toISOString();
        const bloqueio = bloquear ? { motivo, por: nomeUsuario(req), porUid: req.user.uid, em: agora } : null;
        await DOC_CONTROLE.update({ [`bloqueios.${chave}`]: bloquear ? bloqueio : admin.firestore.FieldValue.delete() });
        await db.collection(COL_ACOES).add({
            chave, cpf: /^\d{11}$/.test(chave) ? chave : '',
            nomeAluno: (req.body.nomeAluno || '').toString().trim(),
            grupo: req.body.grupo === 'medicina' ? 'medicina' : 'graduacao',
            tipo: 'outro', escritorio: '',
            observacoes: bloquear ? `🚫 Marcado como NÃO COBRAR. Motivo: ${motivo}` : '✅ Liberado para cobrança (saiu do "Não cobrar").',
            mensagem: '', promessaData: null, promessaValor: null, origem: 'edubox',
            criadoPor: req.user.uid, criadoPorNome: nomeUsuario(req),
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ chave, bloqueio });
    } catch (err) {
        console.error('[cobranca-edubox] bloqueio:', err);
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
// Visão mensal (Painel e Visão do diretor): resumo das parcelas que vencem
// no mês + o que entrou no mês. Um doc por mês, lido só quando escolhem o mês.
router.get('/mes/:mes', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!/^\d{4}-\d{2}$/.test(req.params.mes)) return res.status(400).json({ error: 'Mês inválido (AAAA-MM).' });
        const d = await db.collection('cobranca_edubox_meses').doc(req.params.mes).get();
        res.json(d.exists ? d.data() : { vazio: true });
    } catch (err) {
        console.error('[cobranca-edubox] mes:', err);
        res.status(500).json({ error: err.message });
    }
});

// Dinheiro que entrou por mês e por semana (gráfico da Visão do diretor).
router.get('/recebido', verifyToken, checkPermission, async (req, res) => {
    try {
        const d = await db.collection('cobranca_edubox').doc('recebido').get();
        res.json(d.exists ? d.data() : {});
    } catch (err) {
        console.error('[cobranca-edubox] recebido:', err);
        res.status(500).json({ error: err.message });
    }
});

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
// ---------- RELATÓRIO GERAL DA COBRANÇA (impressão, 09/10/2026) ----------
// Todas as ações registradas no período (qualquer tipo), na ordem, e quanto cada aluno cobrado pagou
// depois da 1ª cobrança. Sem texto de mensagem (só se houve) e sem CPF.
router.get('/relatorio-geral', verifyToken, checkPermission, async (req, res) => {
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
        const acoes = [];
        acoesSnap.docs.forEach(d => {
            const a = d.data();
            const chave = a.chave || a.cpf;
            if (!chave) return;
            const em = a.criadoEm && a.criadoEm.toDate ? a.criadoEm.toDate().toISOString() : a.criadoEm;
            acoes.push({
                chave, nome: a.nomeAluno || '', grupo: a.grupo || 'graduacao', tipo: a.tipo, em, por: a.criadoPorNome || '',
                obs: a.observacoes || '', promessaData: a.promessaData || null, promessaValor: a.promessaValor || null, temMensagem: !!a.mensagem,
                mensagem: a.mensagem || ''
            });
        });
        acoes.sort((a, b) => (a.em || '').localeCompare(b.em || ''));
        // pagou depois da 1ª cobrança (dia da cobrança em diante, horário de Brasília) — só alunos que foram cobrados
        const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
        const primeira = {};
        acoes.forEach(x => { if (TIPOS_COBRANCA.includes(x.tipo) && (!primeira[x.chave] || x.em < primeira[x.chave])) primeira[x.chave] = x.em; });
        const pagouDepois = {}, pagamentosDepois = {};
        for (const [chave, em] of Object.entries(primeira)) {
            const desde = diaBR(em);
            const dias = pagamentos[chave] || {};
            const lista = Object.entries(dias).filter(([d]) => d >= desde).sort();
            pagouDepois[chave] = Math.round(lista.reduce((s2, [, v]) => s2 + v, 0) * 100) / 100;
            if (lista.length) pagamentosDepois[chave] = lista.map(([d, v]) => ({ d, v: Math.round(v * 100) / 100 }));
        }
        res.json({ acoes, pagouDepois, pagamentosDepois, pagamentosAte: pagSnap.exists ? pagSnap.data().geradoEm : null });
    } catch (err) {
        console.error('[cobranca-edubox] relatorio-geral:', err);
        res.status(500).json({ error: err.message });
    }
});

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
module.exports._interno = { conferir };
