const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { admin, db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { PLANOS, AVALIACAO, TIPOS, resultadosAvaliacao } = require('../utils/planoAcaoModelos');

// ==========================================
// PLANO DE AÇÃO — PARTE 2: DOCUMENTOS DA DIREÇÃO COM ASSINATURA (21/10/2026)
// A Direção Acadêmica preenche no Órbita os planos de ação (Equipe
// Multidisciplinar, Coordenação de Curso, Colegiado) e a Avaliação de
// Desempenho da Coordenação, e encaminha pro responsável assinar.
//
// Assinatura eletrônica (não é ICP-Brasil — combinado com o usuário):
//   - Diretor Acadêmico (Roni): aplicada automaticamente quando a Direção
//     envia o documento (assinante com `diretor: true` em plano_acao_assinantes)
//   - Responsável (coordenador / coordenação EAD): ele abre, confere e assina
//     confirmando a senha (o token precisa ser de login recente: auth_time)
//   - Ao assinar: data e hora, código de verificação e hash SHA-256 do
//     conteúdo; a página pública /docencia/plano-acao/verificar.html confere.
// Layout das assinaturas no PDF segue o do SIGMA (ASSINATURAS-CERTIFICADO.md).
// Imagens das assinaturas: Storage privado `assinaturas/{uid}.png`, só por
// link assinado de poucos minutos.
// ==========================================
const checkPermission = verifyToken.requireModulePermission('plano-acao');
const COL = 'plano_acao_documentos';
const COL_ASS = 'plano_acao_assinantes';
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'orbita-fatecivp.firebasestorage.app';
const DIRECAO = ['adm_l1', 'adm_l2'];
const SENHA_RECENTE_MS = 10 * 60 * 1000;

const bucket = () => admin.storage().bucket(BUCKET);
const ehDirecao = (req) => DIRECAO.includes(req.user.role);
const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const quemFez = (req) => req.user.name || req.user.email || '';
const agora = () => new Date().toISOString();

function soDirecao(req, res) {
    if (ehDirecao(req)) return true;
    res.status(403).json({ error: 'Só a Direção Acadêmica pode fazer isso.' });
    return false;
}

// Quem pode ser o responsável que assina: coordenadores de curso e a
// coordenação do EAD (Equipe Multidisciplinar). Auxiliar de coordenação (auxiliarDe) não assina.
async function signatarios() {
    const [coord, ead] = await Promise.all([
        db.collection('users').where('role', '==', 'coordenador').get(),
        db.collection('users').where('role', '==', 'ead').where('chefeDeSetor', '==', true).get()
    ]);
    return [...coord.docs, ...ead.docs].map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.ativo !== false && !u.auxiliarDe && !/teste/i.test(u.name || '') && (u.role === 'ead' || (u.cursos || []).length || u.curso))
        .map(u => ({ uid: u.uid, nome: u.name || u.email, cursos: u.cursos || (u.curso ? [u.curso] : []), ead: u.role === 'ead' }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function assinante(uid) {
    const s = await db.collection(COL_ASS).doc(uid).get();
    return s.exists ? { uid, ...s.data() } : null;
}
async function diretor() {
    const s = await db.collection(COL_ASS).where('diretor', '==', true).limit(1).get();
    return s.empty ? null : { uid: s.docs[0].id, ...s.docs[0].data() };
}
async function urlImagem(caminho) {
    if (!caminho) return null;
    const [url] = await bucket().file(caminho).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 15 * 60 * 1000 });
    return url;
}

// JSON com as chaves em ordem fixa — base do hash.
function estavel(v) {
    if (Array.isArray(v)) return `[${v.map(estavel).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${estavel(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}
const CAMPOS_CONTEUDO = ['tipo', 'semestre', 'curso', 'data', 'periodo', 'conteudo', 'respostas', 'notas', 'rdi', 'rdo', 'resultados', 'consideracoesDirecao', 'consideracoesResponsavel', 'signatario', 'assinaturaDirecao', 'assinaturaResponsavel', 'codigo'];
const hashDoc = (d) => crypto.createHash('sha256').update(estavel(Object.fromEntries(CAMPOS_CONTEUDO.map(k => [k, d[k] ?? null])))).digest('hex');

function novoCodigo() {
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = crypto.randomBytes(10);
    let c = '';
    for (let i = 0; i < 10; i++) c += letras[b[i] % letras.length];
    return `${c.slice(0, 5)}-${c.slice(5)}`;
}

function podeVer(req, d) {
    return ehDirecao(req) || (d.signatarioUid === req.user.uid && d.status !== 'rascunho');
}

// Documento completo pra preencher/enviar?
function faltando(d) {
    if (d.tipo === 'avaliacao') {
        const sem = AVALIACAO.blocos.flatMap(b => b.criterios).filter(c => ![1, 2, 3, 4, 5].includes(Number((d.notas || {})[c.id])));
        if (sem.length) return `Faltam notas em ${sem.length} critério(s).`;
        if (!Number.isFinite(Number(d.rdi)) || d.rdi === '' || d.rdi === null) return 'Informe o Resultado da Avaliação Discente (RDI).';
        if (!Number.isFinite(Number(d.rdo)) || d.rdo === '' || d.rdo === null) return 'Informe o Resultado da Avaliação Docente (RDO).';
        return null;
    }
    const inds = d.conteudo.itens.flatMap(i => i.indicadores);
    const sem = inds.filter(ind => !ind.opcoes.includes((d.respostas || {})[ind.id]));
    return sem.length ? `Faltam ${sem.length} indicador(es) sem resposta.` : null;
}

function resumoDoc(d) {
    return {
        id: d.id, tipo: d.tipo, titulo: TIPOS[d.tipo], semestre: d.semestre, curso: d.curso || '', data: d.data, status: d.status,
        signatario: d.signatario, codigo: d.codigo || null, motivoDevolucao: d.motivoDevolucao || '',
        enviadoEm: d.assinaturaDirecao ? d.assinaturaDirecao.em : null, assinadoEm: d.assinaturaResponsavel ? d.assinaturaResponsavel.em : null,
        atualizadoEm: d.updatedAt
    };
}

// ---------------- rotas ----------------

// GET /verificar/:codigo — PÚBLICA (sem login): confere um documento assinado
router.get('/verificar/:codigo', async (req, res) => {
    try {
        const codigo = texto(req.params.codigo, 20).toUpperCase();
        const snap = await db.collection(COL).where('codigo', '==', codigo).limit(1).get();
        if (snap.empty) return res.status(404).json({ error: 'Nenhum documento com esse código.' });
        const d = snap.docs[0].data();
        res.json({
            titulo: TIPOS[d.tipo], semestre: d.semestre, curso: d.curso || '', data: d.data, status: d.status, codigo: d.codigo,
            direcao: d.assinaturaDirecao ? { nome: d.assinaturaDirecao.nome, cargo: d.assinaturaDirecao.cargo, em: d.assinaturaDirecao.em } : null,
            responsavel: d.assinaturaResponsavel ? { nome: d.assinaturaResponsavel.nome, cargo: d.assinaturaResponsavel.cargo, em: d.assinaturaResponsavel.em } : null,
            hash: d.hash || null, integro: d.status === 'assinado' ? d.hash === hashDoc(d) : null
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /meta — modelos, tipos e (Direção) quem pode assinar
router.get('/meta', verifyToken, checkPermission, async (req, res) => {
    try {
        res.json({
            tipos: TIPOS, planos: PLANOS, avaliacao: AVALIACAO, direcao: ehDirecao(req), admN1: req.user.role === 'adm_l1',
            signatarios: ehDirecao(req) ? await signatarios() : null
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /?semestre= — Direção: todos do semestre; responsável: os dele (enviados/assinados)
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = texto(req.query.semestre, 6);
        const q = ehDirecao(req)
            ? db.collection(COL).where('semestre', '==', semestre)
            : db.collection(COL).where('signatarioUid', '==', req.user.uid);
        const snap = await q.get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => podeVer(req, d)).map(resumoDoc)
            .sort((a, b) => (b.atualizadoEm || '').localeCompare(a.atualizadoEm || '')));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- assinaturas cadastradas (Direção) ----------
router.get('/assinantes', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const [snap, sigs] = await Promise.all([db.collection(COL_ASS).get(), signatarios()]);
        const cad = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
        const lista = await Promise.all([
            ...snap.docs.filter(d => d.data().diretor).map(d => d.id),
            ...sigs.map(s => s.uid)
        ].filter((v, i, a) => a.indexOf(v) === i).map(async uid => {
            const c = cad[uid] || {};
            const sig = sigs.find(s => s.uid === uid);
            return { uid, nome: c.nome || (sig && sig.nome) || '', cargo: c.cargo || '', diretor: !!c.diretor, cadastrado: !!cad[uid], url: await urlImagem(c.imagem) };
        }));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /assinantes/:uid { nome, cargo, imagem?: "data:image/png;base64,..." }
router.put('/assinantes/:uid', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const uid = texto(req.params.uid, 60);
        const atual = await assinante(uid);
        const permitido = (atual && atual.diretor) || (await signatarios()).some(s => s.uid === uid);
        if (!permitido) return res.status(404).json({ error: 'Essa pessoa não assina documentos do Plano de Ação.' });
        const nome = texto(req.body.nome, 120), cargo = texto(req.body.cargo, 160);
        if (!nome || !cargo) return res.status(400).json({ error: 'Informe o nome e o cargo como devem sair no documento.' });
        const upd = { nome, cargo, atualizadoEm: agora(), atualizadoPor: quemFez(req) };
        if (req.body.imagem) {
            const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(req.body.imagem);
            if (!m) return res.status(400).json({ error: 'A assinatura precisa ser PNG ou JPG.' });
            const buf = Buffer.from(m[2], 'base64');
            if (buf.length > 1024 * 1024) return res.status(400).json({ error: 'Imagem grande demais (máx. 1 MB).' });
            upd.imagem = `assinaturas/${uid}.png`;
            await bucket().file(upd.imagem).save(buf, { contentType: `image/${m[1]}`, resumable: false });
        }
        await db.collection(COL_ASS).doc(uid).set(upd, { merge: true });
        res.json({ uid, ...upd, url: await urlImagem(upd.imagem || (atual && atual.imagem)) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /:id — documento completo (+ imagens das assinaturas já aplicadas)
router.get('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Documento não encontrado.' });
        const d = { id: snap.id, ...snap.data() };
        if (!podeVer(req, d)) return res.status(403).json({ error: 'Você não tem acesso a este documento.' });
        const [imgDir, imgResp] = await Promise.all([
            d.assinaturaDirecao ? assinante(d.assinaturaDirecao.uid).then(a => urlImagem(a && a.imagem)) : null,
            d.assinaturaResponsavel ? assinante(d.assinaturaResponsavel.uid).then(a => urlImagem(a && a.imagem)) : null
        ]);
        res.json({ ...d, titulo: TIPOS[d.tipo], resultados: d.tipo === 'avaliacao' ? resultadosAvaliacao(d.notas, d.rdi, d.rdo) : null, imagens: { direcao: imgDir, responsavel: imgResp } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST / { tipo, semestre, curso, signatarioUid, data, periodo } — Direção cria (rascunho)
router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const tipo = texto(req.body.tipo, 40);
        if (!TIPOS[tipo]) return res.status(400).json({ error: 'Escolha o tipo de documento.' });
        const sig = (await signatarios()).find(s => s.uid === req.body.signatarioUid);
        if (!sig) return res.status(400).json({ error: 'Escolha o responsável que vai assinar.' });
        const ass = await assinante(sig.uid);
        const doc = {
            tipo, semestre: texto(req.body.semestre, 6), curso: texto(req.body.curso, 60), data: data(req.body.data) || agora().slice(0, 10),
            periodo: texto(req.body.periodo, 80),
            conteudo: tipo === 'avaliacao' ? AVALIACAO : PLANOS[tipo],
            respostas: {}, notas: {}, rdi: null, rdo: null, consideracoesDirecao: '', consideracoesResponsavel: '',
            signatarioUid: sig.uid,
            signatario: { uid: sig.uid, nome: (ass && ass.nome) || sig.nome, cargo: (ass && ass.cargo) || '' },
            status: 'rascunho', historico: [{ em: agora(), quem: quemFez(req), acao: 'criou' }],
            createdAt: agora(), createdBy: quemFez(req), updatedAt: agora(), updatedBy: quemFez(req)
        };
        const ref = await db.collection(COL).add(doc);
        res.status(201).json({ id: ref.id, ...resumoDoc({ id: ref.id, ...doc }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function doc(req, res) {
    const ref = db.collection(COL).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Documento não encontrado.' }); return null; }
    return { ref, d: { id: snap.id, ...snap.data() } };
}

// PUT /:id — Direção salva o preenchimento (rascunho ou devolvido)
router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const x = await doc(req, res); if (!x) return;
        if (!['rascunho', 'devolvido'].includes(x.d.status)) return res.status(400).json({ error: 'Documento já enviado não pode ser editado.' });
        const b = req.body;
        const upd = { updatedAt: agora(), updatedBy: quemFez(req) };
        if (b.data !== undefined) upd.data = data(b.data) || x.d.data;
        if (b.periodo !== undefined) upd.periodo = texto(b.periodo, 80);
        if (b.curso !== undefined) upd.curso = texto(b.curso, 60);
        if (b.consideracoesDirecao !== undefined) upd.consideracoesDirecao = texto(b.consideracoesDirecao, 3000);
        if (b.respostas && typeof b.respostas === 'object') {
            const inds = x.d.conteudo.itens ? x.d.conteudo.itens.flatMap(i => i.indicadores) : [];
            upd.respostas = Object.fromEntries(inds.filter(i => i.opcoes.includes(b.respostas[i.id])).map(i => [i.id, b.respostas[i.id]]));
        }
        if (b.notas && typeof b.notas === 'object') {
            const crit = AVALIACAO.blocos.flatMap(bl => bl.criterios);
            upd.notas = Object.fromEntries(crit.filter(c => [1, 2, 3, 4, 5].includes(Number(b.notas[c.id]))).map(c => [c.id, Number(b.notas[c.id])]));
        }
        const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
        if (b.rdi !== undefined) upd.rdi = num(b.rdi);
        if (b.rdo !== undefined) upd.rdo = num(b.rdo);
        if (b.signatarioUid && b.signatarioUid !== x.d.signatarioUid) {
            const sig = (await signatarios()).find(s => s.uid === b.signatarioUid);
            if (!sig) return res.status(400).json({ error: 'Responsável inválido.' });
            const ass = await assinante(sig.uid);
            upd.signatarioUid = sig.uid;
            upd.signatario = { uid: sig.uid, nome: (ass && ass.nome) || sig.nome, cargo: (ass && ass.cargo) || '' };
        }
        await x.ref.update(upd);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/enviar — Direção envia: aplica a assinatura do Diretor Acadêmico
router.post('/:id/enviar', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const x = await doc(req, res); if (!x) return;
        if (!['rascunho', 'devolvido'].includes(x.d.status)) return res.status(400).json({ error: 'Esse documento já foi enviado.' });
        const falta = faltando(x.d);
        if (falta) return res.status(400).json({ error: falta });
        const dir = await diretor();
        if (!dir || !dir.imagem) return res.status(400).json({ error: 'Cadastre a assinatura do Diretor Acadêmico antes de enviar (aba Assinaturas).' });
        const respAss = await assinante(x.d.signatarioUid);
        const upd = {
            status: 'aguardando', motivoDevolucao: '',
            codigo: x.d.codigo || novoCodigo(),
            signatario: { ...x.d.signatario, nome: (respAss && respAss.nome) || x.d.signatario.nome, cargo: (respAss && respAss.cargo) || x.d.signatario.cargo },
            assinaturaDirecao: { uid: dir.uid, nome: dir.nome, cargo: dir.cargo, em: agora(), aplicadaPor: quemFez(req), aplicadaPorUid: req.user.uid },
            historico: [...(x.d.historico || []), { em: agora(), quem: quemFez(req), acao: 'enviou para assinatura' }],
            updatedAt: agora(), updatedBy: quemFez(req)
        };
        await x.ref.update(upd);
        res.json(resumoDoc({ ...x.d, ...upd }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/devolver { motivo } — o responsável devolve pra Direção corrigir
router.post('/:id/devolver', verifyToken, checkPermission, async (req, res) => {
    try {
        const x = await doc(req, res); if (!x) return;
        if (x.d.signatarioUid !== req.user.uid) return res.status(403).json({ error: 'Só o responsável pode devolver o documento.' });
        if (x.d.status !== 'aguardando') return res.status(400).json({ error: 'Esse documento não está aguardando a sua assinatura.' });
        const motivo = texto(req.body.motivo, 1000);
        if (!motivo) return res.status(400).json({ error: 'Explique o que precisa ser corrigido.' });
        await x.ref.update({
            status: 'devolvido', motivoDevolucao: motivo, assinaturaDirecao: null,
            historico: [...(x.d.historico || []), { em: agora(), quem: quemFez(req), acao: `devolveu: ${motivo}` }],
            updatedAt: agora(), updatedBy: quemFez(req)
        });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/assinar { consideracoes } — o responsável assina (senha confirmada há pouco)
router.post('/:id/assinar', verifyToken, checkPermission, async (req, res) => {
    try {
        const x = await doc(req, res); if (!x) return;
        if (x.d.signatarioUid !== req.user.uid) return res.status(403).json({ error: 'Só o responsável indicado pode assinar este documento.' });
        if (x.d.status !== 'aguardando') return res.status(400).json({ error: 'Esse documento não está aguardando a sua assinatura.' });
        if (!req.user.auth_time || Date.now() - req.user.auth_time * 1000 > SENHA_RECENTE_MS) {
            return res.status(401).json({ error: 'Confirme a sua senha para assinar.', confirmarSenha: true });
        }
        const ass = await assinante(req.user.uid);
        const upd = {
            status: 'assinado',
            consideracoesResponsavel: texto(req.body.consideracoes, 3000),
            assinaturaResponsavel: {
                uid: req.user.uid, nome: (ass && ass.nome) || x.d.signatario.nome, cargo: (ass && ass.cargo) || x.d.signatario.cargo,
                em: agora(), email: req.user.email || '', navegador: texto(req.headers['user-agent'], 200), comImagem: !!(ass && ass.imagem)
            },
            resultados: x.d.tipo === 'avaliacao' ? resultadosAvaliacao(x.d.notas, x.d.rdi, x.d.rdo) : null,
            historico: [...(x.d.historico || []), { em: agora(), quem: quemFez(req), acao: 'assinou' }],
            updatedAt: agora(), updatedBy: quemFez(req)
        };
        const final = { ...x.d, ...upd };
        upd.hash = hashDoc(final);
        await x.ref.update(upd);
        res.json(resumoDoc({ ...final, hash: upd.hash }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /:id — Direção exclui. Assinado só o ADM N1 exclui (22/10/2026: limpar
// os exemplos/testes pela tela); o código de verificação dele para de funcionar.
router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const x = await doc(req, res); if (!x) return;
        if (x.d.status === 'assinado' && req.user.role !== 'adm_l1') return res.status(400).json({ error: 'Documento assinado só pode ser excluído pelo ADM N1.' });
        await x.ref.delete();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports._interno = { hashDoc, faltando };
