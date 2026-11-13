// ================================================================
//  BANCO MED-FATEC — AVALIAÇÕES (12/11/2026)
//  A responsável pelas avaliações da Medicina monta a prova de cada disciplina por semestre / bimestre /
//  chamada: escreve no modelo padrão, importa de Word/PDF/texto ou pega do banco da disciplina. Cada questão
//  é conferida pelas regras do padrão (banco-med-fatec/padrao.js, sem IA) e a avaliação é analisada contra o
//  plano de ensino do Edubox (unidades + carga horária + habilidades, relay /corpo-docente/plano). Ao
//  finalizar, as questões entram no banco da disciplina e sai o Moodle XML com a pasta
//  Disciplina / semestre / bimestre / chamada para importar no banco de questões do AVA.
//  Quem usa: adm_l1, coord_medicina e quem tem users.avaliacoesMed = true (Ana Beatriz).
// ================================================================
const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { relay } = require('../utils/edubox-relay');
const { formatosEdubox } = require('../utils/matrizes-montar');
const { gerarMoodleXml } = require('../utils/moodleXml');
const { classificarAreaEnamed } = require('../utils/classificarAreaEnamed');
const Padrao = require('../../banco-med-fatec/padrao');
const ParseLinhas = require('../../docencia/banco-provas/parse-linhas');

const COL_AV = 'banco_med_avaliacoes';
const COL_Q = 'banco_med_questoes';
const COL_CAT = 'banco_med_categorias';
const checkPermission = verifyToken.requireModulePermission('banco-med-fatec');
const SEMESTRE = /^\d{4}\.[12]$/;
const DIFICULDADES = ['facil', 'media', 'intermediaria', 'dificil'];
const MAX_IMG_BASE64 = 950000;

function podeAvaliacoes(user) {
    return user.role === 'adm_l1' || user.role === 'coord_medicina' || user.avaliacoesMed === true;
}
function exigeAcesso(req, res, next) {
    if (!podeAvaliacoes(req.user)) return res.status(403).json({ error: 'Só a responsável pelas avaliações e a coordenação de Medicina usam esta área.' });
    next();
}
router.use(verifyToken, checkPermission, exigeAcesso);

const agora = () => new Date().toISOString();
const quem = (req) => req.user.name || req.user.email || 'Usuário';
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const slug = (s) => normNome(s).toLowerCase().replace(/\s+/g, '-').slice(0, 60);
const titulo = (s) => String(s || '').toLowerCase().replace(/(^|[\s(/-])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E|Em)\b/g, w => w.toLowerCase());
function semestreAnterior(s) { const [a, p] = s.split('.').map(Number); return p === 2 ? `${a}.1` : `${a - 1}.2`; }

// ---------- cache em memória (Edubox via relay e categorias) ----------
const cache = new Map();
async function emCache(chave, ms, fn) {
    const c = cache.get(chave);
    if (c && Date.now() - c.em < ms) return c.valor;
    const valor = await fn();
    cache.set(chave, { em: Date.now(), valor });
    return valor;
}
const categorias = () => emCache('cats', 10 * 60000, async () => (await db.collection(COL_CAT).get()).docs.map(d => ({ id: d.id, ...d.data() })));

async function diariosMed(semestre) {
    return emCache(`diarios:${semestre}`, 15 * 60000, async () => {
        const r = await relay(`/corpo-docente/diarios?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}&curso=MED`, { timeoutMs: 30000 });
        if (!r || !r.ok) throw new Error('Não consegui buscar os professores no Edubox agora.');
        return r.diarios || [];
    });
}
async function planosMed(semestre) {
    return emCache(`plano:${semestre}`, 15 * 60000, async () => {
        const r = await relay(`/corpo-docente/plano?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}&curso=MED`, { timeoutMs: 45000 });
        if (!r || !r.ok) throw new Error('Não consegui buscar o plano de ensino no Edubox agora.');
        return r;
    });
}
// Semestre sem diário lançado (ex.: 2027.1 em planejamento) usa o anterior que tiver.
async function semestreComDados(semestre) {
    let s = semestre;
    for (let i = 0; i < 3; i++) {
        if ((await diariosMed(s)).length) return s;
        s = semestreAnterior(s);
    }
    return semestre;
}

async function listaDisciplinas(semestre) {
    const fonte = await semestreComDados(semestre);
    const [diarios, cats] = await Promise.all([diariosMed(fonte), categorias()]);
    const porNome = new Map();
    diarios.forEach(d => {
        const k = normNome(d.disciplina);
        if (!porNome.has(k)) {
            const cat = cats.find(c => normNome(c.nome) === k);
            porNome.set(k, { chave: slug(d.disciplina), nome: d.disciplina.replace(/\s+/g, ' '), sigla: d.sigla, periodo: cat ? cat.periodo : d.periodo, categoriaId: cat ? cat.id : null, professores: new Set(), coddtus: new Set() });
        }
        const x = porNome.get(k);
        x.professores.add(titulo(d.nome).replace(/\s+/g, ' '));
        x.coddtus.add(d.coddtu);
    });
    return {
        fonte,
        disciplinas: [...porNome.values()].map(x => ({ ...x, professores: [...x.professores].sort(), coddtus: [...x.coddtus] }))
            .sort((a, b) => (a.periodo - b.periodo) || a.nome.localeCompare(b.nome))
    };
}

// ---------- plano de ensino ----------
const limparTexto = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function itens(textoPlano) {
    const t = String(textoPlano || '').replace(/<\/(p|li|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    let partes = t.split(/\n|•|;|\s(?:-|–)\s(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/);
    if (partes.filter(p => p.trim().length > 8).length <= 1) partes = t.split(/(?<=\.)\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/);
    const vistos = new Set();
    return partes.map(p => p.replace(/\s+/g, ' ').replace(/^[\s\-–•·*\d.)]+/, '').replace(/[.;,\s]+$/, '').trim())
        .filter(p => p.length > 8 && !vistos.has(p.toLowerCase()) && vistos.add(p.toLowerCase()));
}
function referencias(txt) {
    const t = limparTexto(txt);
    if (!t) return [];
    return t.split(/(?<=\(Biblioteca Digital\)\.?)\s+|(?<=\.)\s+(?=[A-ZÁÉÍÓÚ]{2,}[A-ZÁÉÍÓÚ' -]*,\s)/).map(s => s.trim()).filter(s => s.length > 10);
}
function tituloUnidade(c) {
    const t = limparTexto(c).replace(/^[-–•\s]+/, '');
    let corte = t.split(/(?<=\.)\s|\s-\s/)[0];
    if (corte.length < 25) corte = t;
    if (corte.length > 90) corte = corte.slice(0, 90).replace(/\s+\S*$/, '') + '…';
    return corte.replace(/[:;,]$/, '') || 'Unidade';
}
async function planoDaDisciplina(semestre, nomeDisciplina) {
    const fonte = await semestreComDados(semestre);
    const r = await planosMed(fonte);
    const nomeCampo = Object.fromEntries((r.campos || []).map(c => [c.codpef, String(c.nome || '').trim()]));
    const k = normNome(nomeDisciplina);
    const diarios = (r.diarios || []).filter(d => normNome(d.disciplina) === k);
    if (!diarios.length) return { semestreFonte: fonte, encontrado: false, unidades: [], objetivos: [], referencias: [] };
    // diário com o plano mais completo (mais conteúdos + campos preenchidos)
    const nota = (id) => (r.conteudos || []).filter(c => c.coddtu === id).length * 10 + (r.dados || []).filter(x => x.coddtu === id && limparTexto(x.texto)).length;
    const melhor = diarios.map(d => d.coddtu).sort((a, b) => nota(b) - nota(a))[0];
    const campo = (re) => (r.dados || []).filter(x => x.coddtu === melhor && re.test(nomeCampo[x.codpef] || '')).map(x => x.texto).join('\n');
    const conts = (r.conteudos || []).filter(c => c.coddtu === melhor)
        .sort((a, b) => (parseInt(a.unidade, 10) || 0) - (parseInt(b.unidade, 10) || 0) || a.codpco - b.codpco);
    const metade = Math.ceil(conts.length / 2);
    const unidades = conts.map((c, i) => ({
        numero: parseInt(c.unidade, 10) || i + 1, ch: Number(String(c.ch || '').replace(',', '.')) || 0,
        bimestre: i < metade ? 1 : 2, titulo: tituloUnidade(c.conteudo), conteudo: limparTexto(c.conteudo)
    }));
    let objetivos = itens(campo(/^Habilidades/i));
    if (!objetivos.length) objetivos = itens(campo(/^Compet/i));
    if (!objetivos.length) objetivos = itens(campo(/^Objetivos/i));
    return {
        semestreFonte: fonte, encontrado: true, coddtu: melhor,
        ementa: limparTexto(campo(/^Ementa/i)), objetivoGeral: limparTexto(campo(/^Objetivos/i)),
        unidades, objetivos,
        referencias: [...referencias(campo(/Bibliografia B/i)), ...referencias(campo(/Bibliografia C/i))]
    };
}

// leitor de questões (Word / PDF / texto): Padrao.lerQuestoesDeLinhas (banco-med-fatec/padrao.js), o mesmo do navegador
const lerQuestoesDeLinhas = Padrao.lerQuestoesDeLinhas;

// ---------- imagens das questões (12/11/2026) ----------
// Imagens e GIFs (Libras!) vão pro Firebase Storage SEM compressão — no documento do Firestore (1 MiB) não cabem e
// o canvas transformava GIF em foto parada. Upload direto do navegador por link assinado (mesmo padrão dos ofícios
// do Comercial); a questão guarda imagens: [{ caminho, nome, mimeType, tamanho }]. O campo antigo imagem
// ({ dataUrl }) continua valendo nas questões que já tinham.
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'orbita-fatecivp.firebasestorage.app';
const bucket = () => admin.storage().bucket(BUCKET);
const TIPOS_IMG = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMG = 25 * 1024 * 1024;
const PASTA_IMG = 'banco-med/imagens/';
const MAX_IMGS_QUESTAO = 8;
const nomeArquivo = (v) => String(v || 'imagem').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'imagem';
async function confirmarImagens(lista) {
    const out = [];
    for (const it of (Array.isArray(lista) ? lista : []).slice(0, MAX_IMGS_QUESTAO)) {
        const caminho = String((it && it.caminho) || '');
        if (!caminho.startsWith(PASTA_IMG) || caminho.includes('..')) continue;
        const arq = bucket().file(caminho);
        const [existe] = await arq.exists();
        if (!existe) continue;
        const [meta] = await arq.getMetadata();
        const tamanho = Number(meta.size);
        if (!TIPOS_IMG.includes(meta.contentType) || tamanho > MAX_IMG) { await arq.delete({ ignoreNotFound: true }); continue; }
        out.push({ caminho, nome: String(it.nome || nomeArquivo(caminho.split('/').pop())).slice(0, 120), mimeType: meta.contentType, tamanho });
    }
    return out;
}
async function comLinks(imagens, minutos = 60) {
    return Promise.all((imagens || []).map(async im => {
        const [url] = await bucket().file(im.caminho).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + minutos * 60000 });
        return { ...im, url };
    }));
}

// ---------- questão ----------
function montarEnunciado(caso, pergunta) {
    const c = String(caso || '').trim(), p = String(pergunta || '').trim();
    return [c, p ? `<p><strong>${p.replace(/</g, '&lt;')}</strong></p>` : ''].filter(Boolean).join('\n');
}
function questaoDoBody(b, av) {
    const alternativas = (Array.isArray(b.alternativas) ? b.alternativas : []).slice(0, 6).map(a => ({
        texto: String(a.texto || '').trim(), correta: !!a.correta, feedback: String(a.feedback || '').trim()
    }));
    const q = {
        professorNome: String(b.professorNome || '').trim().slice(0, 120),
        objetivo: String(b.objetivo || '').trim().slice(0, 400),
        unidade: parseInt(b.unidade, 10) || null,
        casoClinico: String(b.casoClinico || ''),
        pergunta: String(b.pergunta || '').trim().slice(0, 600),
        alternativas,
        justificativa: String(b.justificativa || ''),
        fonte: String(b.fonte || '').trim().slice(0, 600),
        dificuldade: DIFICULDADES.includes(b.dificuldade) ? b.dificuldade : 'media',
        tipoMoodle: 'multichoice_unica',
        imagem: (b.imagem && b.imagem.dataUrl && b.imagem.dataUrl.length <= MAX_IMG_BASE64) ? { nome: b.imagem.nome || 'imagem', dataUrl: b.imagem.dataUrl } : null
    };
    q.enunciadoHtml = montarEnunciado(q.casoClinico, q.pergunta);
    q.titulo = Padrao.tituloPadrao(q.professorNome || 'a definir', av.sigla, q.objetivo || 'objetivo a definir');
    q.padrao = Padrao.avaliarQuestao(q);
    return q;
}
const tokens = (...t) => [...new Set(t.filter(Boolean).flatMap(x => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)).filter(w => w.length >= 2))].slice(0, 120);

async function lerAvaliacao(id) {
    const snap = await db.collection(COL_AV).doc(id).get();
    if (!snap.exists) { const e = new Error('Avaliação não encontrada.'); e.status = 404; throw e; }
    return { id: snap.id, ...snap.data() };
}
async function lerQuestoes(ids) {
    if (!ids || !ids.length) return [];
    const refs = ids.map(id => db.collection(COL_Q).doc(id));
    const docs = await db.getAll(...refs);
    return docs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() }));
}
function resumoQuestao(q) {
    // padrão sempre recalculado (questões antigas não têm o campo)
    const { imagem, tituloBusca, tituloBuscaTokens, ...resto } = q;
    if (!resto.casoClinico && !resto.pergunta && resto.enunciadoHtml) resto.casoClinico = resto.enunciadoHtml;
    // com a imagem ORIGINAL (Storage) a antiga comprimida é ignorada — ela só fica no documento pra aba Provas antiga
    return { ...resto, temImagem: !!(imagem && imagem.dataUrl) && !(resto.imagens || []).length, padrao: Padrao.avaliarQuestao(q) };
}
async function resumoComImagens(q) {
    const r = resumoQuestao(q);
    if (r.imagens && r.imagens.length) r.imagens = await comLinks(r.imagens);
    return r;
}
const erro = (res, e) => res.status(e.status || 500).json({ error: e.message });
function exigeRascunho(av) { if (av.status === 'finalizada') { const e = new Error('Esta avaliação está finalizada. Reabra para alterar.'); e.status = 409; throw e; } }

// ---------- critérios por disciplina (12/11/2026) ----------
// A responsável pelas avaliações (Ana Beatriz) define por disciplina: bimestre de cada unidade, peso de cada unidade
// (padrão = CH), % mínimo de caso clínico e tolerância. Sem critério salvo, a análise usa o padrão
// (Padrao.CRITERIOS_PADRAO). Doc banco_med_criterios/{chave da disciplina}: bimestres, pesos, limites, definidoPor/Em.
const COL_CRIT = 'banco_med_criterios';
async function lerCriterios(chave) {
    const s = await db.collection(COL_CRIT).doc(chave).get();
    return s.exists ? s.data() : null;
}
async function todosCriterios() {
    const s = await db.collection(COL_CRIT).get();
    return new Map(s.docs.map(d => [d.id, d.data()]));
}
function resumoCriterios(c) {
    if (!c) return { definidos: false };
    return {
        definidos: !!c.definidoEm,
        bimestres: c.bimestres || {}, pesos: c.pesos || {}, limites: c.limites || {},
        definidoPor: c.definidoPor || '', definidoEm: c.definidoEm || null
    };
}
function limparCriterios(b) {
    const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
    const bimestres = {}, pesos = {};
    Object.entries(b.bimestres || {}).forEach(([u, v]) => { if (/^\d{1,2}$/.test(u) && [1, 2].includes(Number(v))) bimestres[u] = Number(v); });
    Object.entries(b.pesos || {}).forEach(([u, v]) => { const n = num(v, 0, 1000); if (/^\d{1,2}$/.test(u) && n !== null) pesos[u] = n; });
    const l = b.limites || {}, P0 = Padrao.CRITERIOS_PADRAO;
    const limites = {
        minCaso: num(l.minCaso, 0, 100) ?? P0.minCaso,
        abaixo: num(l.abaixo, 0, 100) ?? P0.abaixo,
        acima: num(l.acima, 100, 500) ?? P0.acima
    };
    return { bimestres, pesos, limites };
}

// ==========================================================================================
// ROTAS
// ==========================================================================================
router.get('/eu', (req, res) => res.json({ pode: true }));



// ---------- critérios da disciplina (só Ana / coordenação / ADM — o router inteiro já exige isso) ----------
router.get('/criterios/:chave', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '2026.2';
        const [{ disciplinas }, crit] = await Promise.all([listaDisciplinas(semestre), lerCriterios(req.params.chave)]);
        const d = disciplinas.find(x => x.chave === req.params.chave);
        const nome = d ? d.nome : (crit && crit.disciplina);
        if (!nome) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const plano = await planoDaDisciplina(semestre, nome);
        res.json({
            chave: req.params.chave, disciplina: nome, sigla: d ? d.sigla : (crit && crit.sigla), padrao: Padrao.CRITERIOS_PADRAO,
            unidades: plano.unidades || [], semestreFonte: plano.semestreFonte, planoEncontrado: !!plano.encontrado,
            criterios: resumoCriterios(crit)
        });
    } catch (e) { erro(res, e); }
});
router.put('/criterios/:chave', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.body.semestre || '') ? req.body.semestre : '2026.2';
        const { disciplinas } = await listaDisciplinas(semestre);
        const d = disciplinas.find(x => x.chave === req.params.chave);
        const c = limparCriterios(req.body);
        await db.collection(COL_CRIT).doc(req.params.chave).set({
            ...c, ...(d ? { disciplina: d.nome, sigla: d.sigla } : {}), definidoPor: quem(req), definidoPorUid: req.user.uid, definidoEm: agora()
        }, { merge: true });
        res.json({ message: 'Critérios salvos. As avaliações desta disciplina já usam estes critérios.', criterios: c });
    } catch (e) { erro(res, e); }
});

router.get('/disciplinas', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : null;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const [l, crits] = await Promise.all([listaDisciplinas(semestre), todosCriterios()]);
        res.json({ ...l, disciplinas: l.disciplinas.map(d => { const c = crits.get(d.chave); return { ...d, criteriosDefinidos: !!(c && c.definidoEm) }; }) });
    } catch (e) { erro(res, e); }
});

router.get('/', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : null;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const snap = await db.collection(COL_AV).where('semestre', '==', semestre).get();
        const lista = snap.docs.map(d => { const x = d.data(); return { id: d.id, ...x, totalQuestoes: (x.questoesIds || []).length }; })
            .sort((a, b) => (a.periodo - b.periodo) || a.disciplina.localeCompare(b.disciplina) || a.bimestre - b.bimestre || a.chamada - b.chamada);
        res.json(lista);
    } catch (e) { erro(res, e); }
});

router.post('/', async (req, res) => {
    try {
        const { semestre, chave } = req.body;
        const bimestre = parseInt(req.body.bimestre, 10), chamada = parseInt(req.body.chamada, 10);
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Informe o semestre.' });
        if (![1, 2].includes(bimestre) || ![1, 2].includes(chamada)) return res.status(400).json({ error: 'Escolha o bimestre e a chamada.' });
        const { disciplinas } = await listaDisciplinas(semestre);
        const d = disciplinas.find(x => x.chave === chave);
        if (!d) return res.status(400).json({ error: 'Escolha a disciplina.' });
        const id = `${semestre}__${d.chave}__b${bimestre}__c${chamada}`;
        const ref = db.collection(COL_AV).doc(id);
        if ((await ref.get()).exists) return res.status(409).json({ error: 'Essa avaliação já existe — abra pela lista.', id });
        await ref.set({
            semestre, chave: d.chave, disciplina: d.nome, sigla: d.sigla, periodo: d.periodo, categoriaId: d.categoriaId,
            bimestre, chamada, status: 'rascunho', questoesIds: [],
            criadoPor: req.user.uid, criadoPorNome: quem(req), createdAt: agora(), updatedAt: agora(), exportacoes: []
        });
        res.status(201).json({ id, message: 'Avaliação criada.' });
    } catch (e) { erro(res, e); }
});

router.get('/:id', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        const [questoes, planoEdubox, discs, crit] = await Promise.all([
            lerQuestoes(av.questoesIds),
            planoDaDisciplina(av.semestre, av.disciplina).catch(e => ({ erro: e.message, unidades: [], objetivos: [], referencias: [] })),
            listaDisciplinas(av.semestre).catch(() => ({ disciplinas: [] })),
            lerCriterios(av.chave)
        ]);
        const ordem = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        questoes.sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const d = discs.disciplinas.find(x => x.chave === av.chave);
        const resumo = await Promise.all(questoes.map(resumoComImagens));
        const plano = Padrao.aplicarCriterios(planoEdubox, crit);
        res.json({ avaliacao: av, questoes: resumo, plano, professores: d ? d.professores : [], criterios: resumoCriterios(crit), analise: Padrao.analisarAvaliacao(resumo, plano, av.bimestre, crit) });
    } catch (e) { erro(res, e); }
});

router.delete('/:id', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const proprias = await db.collection(COL_Q).where('avaliacaoId', '==', av.id).get();
        const batch = db.batch();
        proprias.docs.filter(d => d.data().status === 'rascunho_avaliacao').forEach(d => batch.delete(d.ref));
        batch.delete(db.collection(COL_AV).doc(av.id));
        await batch.commit();
        res.json({ message: 'Avaliação excluída.' });
    } catch (e) { erro(res, e); }
});

// link assinado pra subir UMA imagem direto pro Storage (o navegador faz o PUT)
router.post('/imagens/envio', async (req, res) => {
    try {
        const { mimeType } = req.body;
        const tamanho = Number(req.body.tamanho);
        if (!TIPOS_IMG.includes(mimeType)) return res.status(400).json({ error: 'Envie imagem PNG, JPG, GIF ou WEBP.' });
        if (!(tamanho > 0) || tamanho > MAX_IMG) return res.status(400).json({ error: 'Imagem muito grande (máx. 25 MB).' });
        const caminho = `${PASTA_IMG}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nomeArquivo(req.body.nome)}`;
        const [url] = await bucket().file(caminho).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60000, contentType: mimeType });
        res.json({ url, caminho });
    } catch (e) { erro(res, e); }
});

// imagem antiga (comprimida, dentro do documento) — só quando o editor abre a questão
router.get('/:id/questoes/:qid/imagem-antiga', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        if (!(av.questoesIds || []).includes(req.params.qid)) return res.status(404).json({ error: 'Essa questão não está nesta avaliação.' });
        const s = await db.collection(COL_Q).doc(req.params.qid).get();
        const im = s.exists && s.data().imagem;
        res.json(im && im.dataUrl ? { nome: im.nome || 'imagem', dataUrl: im.dataUrl } : {});
    } catch (e) { erro(res, e); }
});

// dados pro Moodle XML montado no NAVEGADOR (GIF grande não passa pelo limite de resposta do servidor)
router.get('/:id/exportar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        if (av.status !== 'finalizada') return res.status(409).json({ error: 'Finalize a avaliação antes de baixar o arquivo do AVA.' });
        const questoes = await lerQuestoes(av.questoesIds);
        const ordem = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        questoes.sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const pasta = [av.disciplina, av.semestre, `${av.bimestre}º Bimestre`, `${av.chamada}ª chamada`].map(x => String(x).replace(/\//g, '-')).join('/');
        const lista = await Promise.all(questoes.map(async q => ({
            id: q.id, titulo: q.titulo, tipoMoodle: q.tipoMoodle, casoClinico: q.casoClinico || '', pergunta: q.pergunta || '',
            enunciadoHtml: q.enunciadoHtml || '', alternativas: q.alternativas || [], justificativa: q.justificativa || '', fonte: q.fonte || '',
            dificuldade: q.dificuldade, elaboradoPor: q.elaboradoPor || q.professorNome || '',
            temImagemAntiga: !!(q.imagem && q.imagem.dataUrl) && !(q.imagens || []).length, imagens: await comLinks(q.imagens, 30)
        })));
        await db.collection(COL_AV).doc(av.id).update({ exportacoes: admin.firestore.FieldValue.arrayUnion({ por: req.user.uid, porNome: quem(req), em: agora() }) });
        const nome = `${av.sigla || av.disciplina} ${av.semestre} ${av.bimestre}o bim ${av.chamada}a chamada`.replace(/[^a-zA-Z0-9._ -]/g, '_');
        res.json({ pasta, nomeArquivo: `${nome}.xml`, questoes: lista });
    } catch (e) { erro(res, e); }
});

// nova questão escrita no modelo padrão
router.post('/:id/questoes', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const q = questaoDoBody(req.body, av);
        if (q.enunciadoHtml.replace(/<[^>]+>/g, '').trim().length < 5) return res.status(400).json({ error: 'Escreva o caso clínico e a pergunta.' });
        q.imagens = await confirmarImagens(req.body.imagens);
        const cats = await categorias();
        const cat = cats.find(c => c.id === av.categoriaId);
        const ref = db.collection(COL_Q).doc();
        await ref.set({
            ...q, status: 'rascunho_avaliacao', avaliacaoId: av.id,
            categoriaId: av.categoriaId, periodo: av.periodo, semestre: av.semestre, bimestre: av.bimestre, chamada: av.chamada, sigla: av.sigla,
            areaEnamed: (cat && cat.areaEnamedPadrao) || classificarAreaEnamed(q.titulo, q.enunciadoHtml, q.justificativa),
            tituloBusca: q.titulo.toLowerCase(), tituloBuscaTokens: tokens(q.titulo, av.disciplina),
            elaboradoPor: q.professorNome || quem(req), criadoPor: req.user.uid, criadoPorNome: quem(req), createdAt: agora(), updatedAt: agora()
        });
        await db.collection(COL_AV).doc(av.id).update({ questoesIds: admin.firestore.FieldValue.arrayUnion(ref.id), updatedAt: agora() });
        res.status(201).json({ id: ref.id, padrao: q.padrao, message: 'Questão salva na avaliação.' });
    } catch (e) { erro(res, e); }
});

// editar (questão nova da avaliação OU questão do banco sendo padronizada)
router.put('/:id/questoes/:qid', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        if (!(av.questoesIds || []).includes(req.params.qid)) return res.status(404).json({ error: 'Essa questão não está nesta avaliação.' });
        const ref = db.collection(COL_Q).doc(req.params.qid);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
        const antes = snap.data();
        const q = questaoDoBody(req.body, av);
        if (!req.body.imagem && antes.imagem && req.body.manterImagem !== false) q.imagem = antes.imagem;
        q.imagens = req.body.imagens === undefined ? (antes.imagens || []) : await confirmarImagens(req.body.imagens);
        const ficam = new Set(q.imagens.map(i => i.caminho));
        await Promise.all((antes.imagens || []).filter(i => !ficam.has(i.caminho)).map(i => bucket().file(i.caminho).delete({ ignoreNotFound: true })));
        await ref.update({
            ...q, elaboradoPor: q.professorNome || antes.elaboradoPor || quem(req),
            tituloBusca: q.titulo.toLowerCase(), tituloBuscaTokens: tokens(q.titulo, av.disciplina),
            padronizadaEm: q.padrao.ok ? agora() : null, padronizadaPor: q.padrao.ok ? quem(req) : null, updatedAt: agora()
        });
        // gabarito mudou numa questão já usada na Correção de Provas → mesma propagação do PUT /questoes/:id
        let avs = 0;
        if (antes.status === 'publicada') {
            const { gabaritoMed, propagarGabarito } = require('./correcao-provas')._interno;
            const gNovo = gabaritoMed({ alternativas: q.alternativas });
            if (gNovo && gNovo !== gabaritoMed(antes)) avs = await propagarGabarito(req.params.qid, gNovo, quem(req));
        }
        res.json({ padrao: q.padrao, message: avs ? `Questão atualizada (gabarito novo também em ${avs} avaliação(ões) da Correção de Provas).` : 'Questão atualizada.' });
    } catch (e) { erro(res, e); }
});

router.delete('/:id/questoes/:qid', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const ref = db.collection(COL_Q).doc(req.params.qid);
        const snap = await ref.get();
        const batch = db.batch();
        if (snap.exists && snap.data().status === 'rascunho_avaliacao' && snap.data().avaliacaoId === av.id) batch.delete(ref);
        batch.update(db.collection(COL_AV).doc(av.id), { questoesIds: admin.firestore.FieldValue.arrayRemove(req.params.qid), updatedAt: agora() });
        await batch.commit();
        res.json({ message: 'Questão retirada da avaliação.' });
    } catch (e) { erro(res, e); }
});

router.put('/:id/ordem', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const ids = Array.isArray(req.body.questoesIds) ? req.body.questoesIds : [];
        const atuais = new Set(av.questoesIds || []);
        if (ids.length !== atuais.size || ids.some(i => !atuais.has(i))) return res.status(400).json({ error: 'A lista de questões mudou. Recarregue a página.' });
        await db.collection(COL_AV).doc(av.id).update({ questoesIds: ids, updatedAt: agora() });
        res.json({ message: 'Ordem salva.' });
    } catch (e) { erro(res, e); }
});

// questões do banco da disciplina (para reaproveitar) — só quando a pessoa abre "Pegar do banco"
router.get('/:id/banco', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        if (!av.categoriaId) return res.json({ questoes: [], aviso: 'Esta disciplina ainda não tem categoria no banco.' });
        const snap = await db.collection(COL_Q).where('categoriaId', '==', av.categoriaId).where('status', '==', 'publicada').get();
        const ja = new Set(av.questoesIds || []);
        const questoes = snap.docs.map(d => {
            const q = { id: d.id, ...d.data() };
            const p = Padrao.avaliarQuestao(q);
            return {
                id: q.id, titulo: q.titulo, enunciado: Padrao.texto(q.enunciadoHtml).slice(0, 400), professorNome: q.professorNome || q.elaboradoPor || '',
                semestre: q.semestre || '', bimestre: q.bimestre || null, unidade: q.unidade || null, dificuldade: q.dificuldade,
                padronizada: p.ok, bloqueios: p.bloqueios.length, avisos: p.avisos.length, aplicacao: p.aplicacao, naAvaliacao: ja.has(q.id)
            };
        }).sort((a, b) => (b.padronizada - a.padronizada) || (b.aplicacao - a.aplicacao) || String(a.titulo).localeCompare(String(b.titulo)));
        res.json({ questoes });
    } catch (e) { erro(res, e); }
});

router.post('/:id/banco', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(x => typeof x === 'string').slice(0, 100);
        if (!ids.length) return res.status(400).json({ error: 'Escolha ao menos uma questão.' });
        const qs = await lerQuestoes(ids);
        const validas = qs.filter(q => q.categoriaId === av.categoriaId && q.status === 'publicada').map(q => q.id);
        if (!validas.length) return res.status(400).json({ error: 'Nenhuma dessas questões é do banco desta disciplina.' });
        await db.collection(COL_AV).doc(av.id).update({ questoesIds: admin.firestore.FieldValue.arrayUnion(...validas), updatedAt: agora() });
        res.json({ adicionadas: validas.length, message: `${validas.length} questão(ões) adicionada(s). As que estão fora do padrão precisam ser padronizadas antes de finalizar.` });
    } catch (e) { erro(res, e); }
});

// importar de Word / PDF / texto colado → só a PRÉVIA (nada é salvo aqui)
router.post('/:id/importar/analisar', async (req, res) => {
    try {
        await lerAvaliacao(req.params.id);
        const alt = [4, 5].includes(parseInt(req.body.alternativasPorQuestao, 10)) ? parseInt(req.body.alternativasPorQuestao, 10) : null;
        let linhas = [];
        const nome = String(req.body.nomeArquivo || '').toLowerCase();
        if (req.body.arquivoBase64) {
            const buffer = Buffer.from(req.body.arquivoBase64, 'base64');
            if (buffer.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo grande demais (máx. 15 MB).' });
            try {
                if (nome.endsWith('.pdf') || buffer.slice(0, 4).toString() === '%PDF') linhas = String((await require('pdf-parse')(buffer)).text || '').split(/\r?\n/);
                else linhas = await require('../utils/parseProvaDocx').extrairParagrafosDoArquivo(buffer);
            } catch (e) { return res.status(400).json({ error: 'Não consegui ler esse arquivo — envie Word (.docx/.doc) ou PDF.' }); }
        } else if (req.body.texto) linhas = String(req.body.texto).split(/\r?\n/);
        else return res.status(400).json({ error: 'Envie o arquivo ou cole o texto das questões.' });
        const questoes = lerQuestoesDeLinhas(linhas.flatMap(ParseLinhas.expandirLinhaConcatenada));
        if (!questoes.length) return res.status(400).json({ error: 'Não encontrei questões objetivas. As questões precisam estar numeradas ("Questão 1", "1.", "2)") com as alternativas a), b), c)...' });
        res.json({ questoes, aviso: '' });
    } catch (e) { erro(res, e); }
});

router.post('/:id/importar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const lista = (Array.isArray(req.body.questoes) ? req.body.questoes : []).slice(0, 120);
        if (!lista.length) return res.status(400).json({ error: 'Nenhuma questão para importar.' });
        const cats = await categorias();
        const cat = cats.find(c => c.id === av.categoriaId);
        const comuns = { professorNome: req.body.professorNome, unidade: req.body.unidade, dificuldade: req.body.dificuldade };
        const batch = db.batch();
        const ids = [];
        const imagensPorQuestao = await Promise.all(lista.map(x => confirmarImagens(x.imagens)));
        lista.forEach((x, ix) => {
            const letra = String(x.gabarito || '').toUpperCase();
            const q = questaoDoBody({
                ...comuns, casoClinico: String(x.enunciado || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'), pergunta: '',
                alternativas: (x.alternativas || []).map((t, i) => ({ texto: String(t || ''), correta: Padrao.LETRAS[i] === letra })),
                justificativa: '', fonte: ''
            }, av);
            const ref = db.collection(COL_Q).doc();
            ids.push(ref.id);
            batch.set(ref, {
                ...q, imagens: imagensPorQuestao[ix], status: 'rascunho_avaliacao', avaliacaoId: av.id, importada: true,
                categoriaId: av.categoriaId, periodo: av.periodo, semestre: av.semestre, bimestre: av.bimestre, chamada: av.chamada, sigla: av.sigla,
                areaEnamed: (cat && cat.areaEnamedPadrao) || classificarAreaEnamed(q.titulo, q.enunciadoHtml, ''),
                tituloBusca: q.titulo.toLowerCase(), tituloBuscaTokens: tokens(q.titulo, av.disciplina),
                elaboradoPor: q.professorNome || quem(req), criadoPor: req.user.uid, criadoPorNome: quem(req), createdAt: agora(), updatedAt: agora()
            });
        });
        batch.update(db.collection(COL_AV).doc(av.id), { questoesIds: admin.firestore.FieldValue.arrayUnion(...ids), updatedAt: agora() });
        await batch.commit();
        res.status(201).json({ criadas: ids.length, message: `${ids.length} questão(ões) importada(s). Complete objetivo, pergunta e feedback de cada uma.` });
    } catch (e) { erro(res, e); }
});

router.post('/:id/finalizar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeRascunho(av);
        const questoes = await lerQuestoes(av.questoesIds);
        if (!questoes.length) return res.status(400).json({ error: 'A avaliação não tem questões.' });
        const fora = questoes.map((q, i) => ({ n: (av.questoesIds || []).indexOf(q.id) + 1, p: Padrao.avaliarQuestao(q) })).filter(x => !x.p.ok);
        if (fora.length) return res.status(400).json({ error: `Ainda há ${fora.length} questão(ões) fora do padrão (nº ${fora.map(x => x.n).sort((a, b) => a - b).join(', ')}). Corrija antes de finalizar.` });
        const batch = db.batch();
        questoes.forEach(q => {
            const upd = { usadaEm: admin.firestore.FieldValue.arrayUnion(av.id), updatedAt: agora() };
            if (q.status === 'rascunho_avaliacao') Object.assign(upd, { status: 'publicada', padronizadaEm: agora(), padronizadaPor: quem(req) });
            batch.update(db.collection(COL_Q).doc(q.id), upd);
        });
        batch.update(db.collection(COL_AV).doc(av.id), { status: 'finalizada', finalizadaEm: agora(), finalizadaPor: quem(req), updatedAt: agora() });
        await batch.commit();
        res.json({ message: `Avaliação finalizada: ${questoes.length} questões no banco de ${av.disciplina}. Agora baixe o arquivo para o AVA.` });
    } catch (e) { erro(res, e); }
});

router.post('/:id/reabrir', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        await db.collection(COL_AV).doc(av.id).update({ status: 'rascunho', reabertaEm: agora(), reabertaPor: quem(req), updatedAt: agora() });
        res.json({ message: 'Avaliação reaberta para ajustes.' });
    } catch (e) { erro(res, e); }
});

// Moodle XML com a pasta Disciplina / semestre / bimestre / chamada
router.get('/:id/xml', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        if (av.status !== 'finalizada') return res.status(409).json({ error: 'Finalize a avaliação antes de baixar o arquivo do AVA.' });
        const questoes = await lerQuestoes(av.questoesIds);
        const ordem = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        questoes.sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const pasta = [av.disciplina, av.semestre, `${av.bimestre}º Bimestre`, `${av.chamada}ª chamada`].map(s => String(s).replace(/\//g, '-')).join('/');
        const xml = gerarMoodleXml(pasta, questoes, { semTagAutor: false });
        await db.collection(COL_AV).doc(av.id).update({ exportacoes: admin.firestore.FieldValue.arrayUnion({ por: req.user.uid, porNome: quem(req), em: agora() }) });
        const nome = `${av.sigla || av.disciplina} ${av.semestre} ${av.bimestre}o bim ${av.chamada}a chamada`.replace(/[^a-zA-Z0-9._ -]/g, '_');
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nome}.xml"`);
        res.send(xml);
    } catch (e) { erro(res, e); }
});



router._interno = { planoDaDisciplina, listaDisciplinas, itens, referencias, lerQuestoesDeLinhas };
module.exports = router;
