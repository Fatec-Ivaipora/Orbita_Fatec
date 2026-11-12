// ==========================================================================
// FORMULÁRIOS (Docência, 12/11/2026) — a Direção (Roni, Laisa) e a assistente (Thalia) criam formulários
// pra coletar informação dos alunos e mandam um LINK: a pessoa responde do próprio celular/computador, sem
// login (página /formulario/?t=TOKEN). Quem cria escolhe se é anônimo ou identificado (nome, curso,
// período) e se aceita mais de uma resposta por pessoa.
//   formularios             { titulo, descricao, perguntas:[{id,tipo,texto,obrigatoria,opcoes}], identificacao,
//                             umaPorPessoa, abreEm, fechaEm, ativo, token, respostas (contador), createdBy... }
//   formularios_respostas   { formId, respostas:{ perguntaId: valor }, pessoa:{nome,curso,periodo}|null, chave, criadoEm }
// Permissão: módulo "formularios" (ADM N1 sempre; ADM N2 nível 3 pelo padrão).
// ==========================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('formularios');
const COL = 'formularios';
const COL_RESP = 'formularios_respostas';
const TIPOS = ['curta', 'longa', 'unica', 'multipla', 'escala', 'simnao', 'data'];
const CURSOS = ['Agronegócio', 'Agronomia', 'Arquitetura e Urbanismo', 'Biomedicina', 'Ciências Contábeis', 'Direito', 'Enfermagem',
    'Engenharia Civil', 'Fisioterapia', 'Gestão Comercial', 'Gestão Financeira', 'Medicina', 'Medicina Veterinária', 'Pedagogia',
    'Psicologia', 'Recursos Humanos'];
const txt = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const agoraISO = () => new Date().toISOString();

function limparFormulario(b) {
    const titulo = txt(b.titulo, 150);
    if (titulo.length < 3) throw new Error('Informe o título do formulário.');
    const perguntas = (Array.isArray(b.perguntas) ? b.perguntas : []).slice(0, 80).map((p, i) => {
        const tipo = TIPOS.includes(p.tipo) ? p.tipo : 'curta';
        const texto = String(p.texto || '').trim().slice(0, 600);
        if (!texto) throw new Error(`Pergunta ${i + 1}: escreva a pergunta.`);
        const opcoes = ['unica', 'multipla'].includes(tipo)
            ? [...new Set((Array.isArray(p.opcoes) ? p.opcoes : []).map(o => txt(o, 200)).filter(Boolean))].slice(0, 40) : [];
        if (['unica', 'multipla'].includes(tipo) && opcoes.length < 2) throw new Error(`Pergunta ${i + 1}: coloque pelo menos 2 opções.`);
        return { id: /^[a-z0-9]{4,16}$/.test(p.id || '') ? p.id : crypto.randomBytes(4).toString('hex'), tipo, texto, obrigatoria: !!p.obrigatoria, opcoes };
    });
    if (!perguntas.length) throw new Error('Coloque pelo menos uma pergunta.');
    const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
    // capa (arte do evento): imagem já reduzida no navegador, guardada no próprio formulário (até ~700 KB)
    let capa = b.capa === undefined ? undefined : null;
    if (typeof b.capa === 'string' && b.capa) {
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.capa)) throw new Error('Imagem da capa inválida.');
        if (b.capa.length > 950000) throw new Error('A imagem da capa ficou grande demais. Tente uma menor.');
        capa = b.capa;
    }
    return {
        ...(capa !== undefined ? { capa } : {}),
        titulo, descricao: String(b.descricao || '').trim().slice(0, 2000), perguntas,
        identificacao: b.identificacao === 'identificado' ? 'identificado' : 'anonimo',
        umaPorPessoa: !!b.umaPorPessoa, abreEm: data(b.abreEm), fechaEm: data(b.fechaEm), ativo: b.ativo !== false
    };
}
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
function situacao(f) {
    if (f.ativo === false) return 'encerrado';
    const h = hojeSP();
    if (f.abreEm && h < f.abreEm) return 'agendado';
    if (f.fechaEm && h > f.fechaEm) return 'encerrado';
    return 'aberto';
}
const resumoForm = (id, f) => ({ id, ...f, situacao: situacao(f) });

// ---------- Direção ----------
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL).orderBy('createdAt', 'desc').limit(200).get();
        res.json(snap.docs.map(d => { const f = d.data(); return { id: d.id, titulo: f.titulo, temCapa: !!f.capa, identificacao: f.identificacao, umaPorPessoa: f.umaPorPessoa, abreEm: f.abreEm, fechaEm: f.fechaEm, ativo: f.ativo, token: f.token, respostas: f.respostas || 0, perguntas: (f.perguntas || []).length, createdPorNome: f.createdPorNome, createdAt: f.createdAt, situacao: situacao(f) }; }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        let f;
        try { f = limparFormulario(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
        const token = crypto.randomBytes(15).toString('base64url');
        const dados = { ...f, token, respostas: 0, createdBy: req.user.uid, createdPorNome: req.user.name || req.user.email || '', createdAt: agoraISO() };
        const ref = await db.collection(COL).add(dados);
        res.status(201).json(resumoForm(ref.id, dados));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const s = await db.collection(COL).doc(req.params.id).get();
        if (!s.exists) return res.status(404).json({ error: 'Formulário não encontrado.' });
        res.json(resumoForm(s.id, s.data()));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Formulário não encontrado.' });
        let f;
        try { f = limparFormulario({ ...s.data(), ...req.body }); } catch (e) { return res.status(400).json({ error: e.message }); }
        // com respostas já recebidas, pergunta não some (o relatório ficaria sem o texto) — só dá pra acrescentar/editar
        const antigas = (s.data().perguntas || []).map(p => p.id);
        if ((s.data().respostas || 0) > 0 && antigas.some(id => !f.perguntas.some(p => p.id === id))) {
            return res.status(400).json({ error: 'Este formulário já tem respostas: não dá para apagar perguntas (pode editar o texto ou acrescentar novas).' });
        }
        const upd = { ...f, updatedAt: agoraISO(), updatedPorNome: req.user.name || req.user.email || '' };
        await ref.update(upd);
        res.json(resumoForm(s.id, { ...s.data(), ...upd }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const resp = await db.collection(COL_RESP).where('formId', '==', s.id).get();
        for (let i = 0; i < resp.docs.length; i += 400) {
            const b = db.batch();
            resp.docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
            await b.commit();
        }
        await ref.delete();
        res.json({ message: `Formulário excluído${resp.size ? ` com ${resp.size} resposta(s)` : ''}.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/respostas', verifyToken, checkPermission, async (req, res) => {
    try {
        const s = await db.collection(COL).doc(req.params.id).get();
        if (!s.exists) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const resp = await db.collection(COL_RESP).where('formId', '==', s.id).get();
        const lista = resp.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
        res.json({ formulario: resumoForm(s.id, s.data()), respostas: lista.map(r => ({ id: r.id, respostas: r.respostas, pessoa: r.pessoa || null, criadoEm: r.criadoEm, atualizadoEm: r.atualizadoEm || null })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Público (sem login: o token do link é a autorização) ----------
async function porToken(token) {
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(String(token || ''))) return null;
    const s = await db.collection(COL).where('token', '==', token).limit(1).get();
    return s.empty ? null : s.docs[0];
}

router.get('/publico/:token', async (req, res) => {
    try {
        const d = await porToken(req.params.token);
        if (!d) return res.status(404).json({ error: 'Formulário não encontrado. Confira se o link está completo.' });
        const f = d.data();
        res.json({
            titulo: f.titulo, descricao: f.descricao, capa: f.capa || null, perguntas: f.perguntas, identificacao: f.identificacao,
            umaPorPessoa: f.umaPorPessoa, abreEm: f.abreEm, fechaEm: f.fechaEm, situacao: situacao(f), cursos: CURSOS
        });
    } catch (err) { res.status(500).json({ error: 'Não foi possível abrir o formulário agora. Tente de novo em instantes.' }); }
});

router.post('/publico/:token/responder', async (req, res) => {
    try {
        const d = await porToken(req.params.token);
        if (!d) return res.status(404).json({ error: 'Formulário não encontrado.' });
        const f = d.data();
        const sit = situacao(f);
        if (sit !== 'aberto') return res.status(410).json({ error: sit === 'agendado' ? 'Este formulário ainda não está aberto.' : 'Este formulário já foi encerrado.' });

        // respostas: só das perguntas do formulário, no formato de cada tipo
        const entrada = req.body && typeof req.body.respostas === 'object' ? req.body.respostas : {};
        const respostas = {};
        const faltando = [];
        for (const p of f.perguntas || []) {
            let v = entrada[p.id];
            if (p.tipo === 'multipla') v = (Array.isArray(v) ? v : []).filter(o => p.opcoes.includes(o));
            else if (p.tipo === 'unica') v = p.opcoes.includes(v) ? v : '';
            else if (p.tipo === 'escala') v = [1, 2, 3, 4, 5].includes(Number(v)) ? Number(v) : '';
            else if (p.tipo === 'simnao') v = ['Sim', 'Não'].includes(v) ? v : '';
            else if (p.tipo === 'data') v = /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : '';
            else v = String(v == null ? '' : v).trim().slice(0, p.tipo === 'longa' ? 5000 : 500);
            const vazio = Array.isArray(v) ? !v.length : v === '';
            if (p.obrigatoria && vazio) faltando.push(p.texto);
            if (!vazio) respostas[p.id] = v;
        }
        let pessoa = null;
        if (f.identificacao === 'identificado') {
            const pe = req.body.pessoa || {};
            pessoa = { nome: txt(pe.nome, 150), curso: CURSOS.includes(pe.curso) ? pe.curso : txt(pe.curso, 80), periodo: txt(pe.periodo, 20) };
            if (pessoa.nome.split(' ').length < 2) faltando.unshift('Nome completo');
            if (!pessoa.curso) faltando.unshift('Curso');
        }
        if (faltando.length) return res.status(400).json({ error: `Responda: ${faltando.slice(0, 5).join('; ')}${faltando.length > 5 ? '…' : ''}.` });

        // 1 resposta por pessoa (se o formulário pedir): identificado pelo nome + curso; anônimo pelo aparelho
        const dispositivo = /^[A-Za-z0-9_-]{10,60}$/.test(String(req.body.dispositivo || '')) ? req.body.dispositivo : null;
        const chave = f.identificacao === 'identificado' ? `p:${norm(pessoa.nome)}|${norm(pessoa.curso)}` : (dispositivo ? `d:${dispositivo}` : null);
        const agora = agoraISO();
        if (f.umaPorPessoa && chave) {
            const ja = await db.collection(COL_RESP).where('formId', '==', d.id).where('chave', '==', chave).limit(1).get();
            if (!ja.empty) {
                // enquanto estiver aberto, quem já respondeu pode corrigir: a resposta nova substitui a anterior
                await ja.docs[0].ref.update({ respostas, pessoa, atualizadoEm: agora });
                return res.json({ message: 'Sua resposta foi atualizada.', atualizada: true });
            }
        }
        await db.collection(COL_RESP).add({ formId: d.id, respostas, pessoa, chave, criadoEm: agora });
        await d.ref.update({ respostas: admin.firestore.FieldValue.increment(1), ultimaRespostaEm: agora });
        res.status(201).json({ message: 'Resposta enviada. Obrigado!' });
    } catch (err) { res.status(500).json({ error: 'Não foi possível enviar agora. Suas respostas continuam na tela — tente de novo em instantes.' }); }
});

module.exports = router;
