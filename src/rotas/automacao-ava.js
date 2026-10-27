const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { relay } = require('../utils/edubox-relay');
const { montar, semestresPadrao, normSemestre, formatosEdubox, cursoIdDe } = require('../utils/matrizes-montar');

// ==========================================================================
// Automação AVA (TI) — 26/10/2026. Primeira parte: CRIAÇÃO DAS DISCIPLINAS EAD.
//
// Lista as disciplinas EAD do semestre (tipo "A Distância" no Edubox, lançadas
// nas turmas — mesma consulta do Matrizes, relay /matrizes/dados) e sugere:
//   replicar        já foi oferecida antes no mesmo curso (mesmo código ou mesmo nome)
//   replicar-outro  nunca no curso, mas existe com o mesmo nome em outro curso
//   criar           nunca oferecida → precisa ser criada do zero (com professor pago)
// A TI confirma/ajusta. As que são "criar" seguem o fluxo de criação:
//   1 treinamento (TI) · 2 seleção das unidades (TI) · 3 coordenador valida as
//   unidades (coordenador do curso) · 4 disciplina criada no AVA (TI) ·
//   5 AVA validado (TI — Paulo)
//   + entrega das avaliações (1º bim 1ª/2ª chamada, 2º bim 1ª/2ª chamada, exame —
//     5 questões discursivas cada — e as questões do simulado), recebidas pelo
//     coordenador do curso e pelo coordenador EAD (Carlos).
// Valor pago ao professor pela titulação: Especialista R$ 800 · Mestre R$ 900 · Doutor R$ 1.000.
// Cada um marca a sua parte (TI / coordenador / EAD); ADM N1 pode tudo.
//
// Coleção: ava_criacao/{AAAA.S}__{cursoId}__{coddis}
// ==========================================================================
const checkPermission = verifyToken.requireModulePermission('automacao-ava');
const COL = 'ava_criacao';
const SEMESTRE = /^\d{4}\.[12]$/;

const TITULACOES = {
    especialista: { rotulo: 'Especialista', valor: 800 },
    mestre: { rotulo: 'Mestre', valor: 900 },
    doutor: { rotulo: 'Doutor', valor: 1000 }
};
const ETAPAS = [
    { id: 'treinamento', rotulo: 'Treinamento', quem: 'ti' },
    { id: 'selecao', rotulo: 'Seleção das unidades', quem: 'ti' },
    { id: 'validacaoUnidades', rotulo: 'Unidades validadas pelo coordenador', quem: 'coordenador' },
    { id: 'criacaoAva', rotulo: 'Disciplina criada no AVA', quem: 'ti' },
    { id: 'validacaoAva', rotulo: 'AVA validado pela TI', quem: 'ti' }
];
const AVALIACOES = [
    { id: 'b1c1', rotulo: '1º bimestre · 1ª chamada' },
    { id: 'b1c2', rotulo: '1º bimestre · 2ª chamada' },
    { id: 'b2c1', rotulo: '2º bimestre · 1ª chamada' },
    { id: 'b2c2', rotulo: '2º bimestre · 2ª chamada' },
    { id: 'exame', rotulo: 'Exame' },
    { id: 'simulado', rotulo: 'Questões do simulado' }
];
const DESTINOS = ['coordenador', 'ead'];
const ORIGENS = ['criar', 'replicar', 'replicar-outro', 'ja-existe'];

// Só os cursos da FATEC (o banco do Edubox é compartilhado com outras instituições).
const CURSOS_FATEC = ['agronegocio', 'agronomia', 'arquitetura-urbanismo', 'biomedicina', 'contabeis', 'direito', 'enfermagem',
    'engenharia-civil', 'gestao-financeira', 'fisioterapia', 'gestao-comercial', 'logistica', 'medicina', 'medicina-veterinaria',
    'pedagogia', 'psicologia', 'rh'];

const texto = (v, max = 200) => (v ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const agora = () => new Date().toISOString();
const quemFez = (req) => req.user.name || req.user.email || '';

// Papel de quem está usando: decide o que pode marcar.
function papelDe(req) {
    if (req.user.role === 'adm_l1') return 'adm';
    if (['ti', 'adm_l2'].includes(req.user.role)) return 'ti';
    if (req.user.role === 'coordenador') return 'coordenador';
    if (req.user.role === 'ead') return 'ead';
    return 'leitura';
}
async function escopoDe(req) {
    if (req.user.role !== 'coordenador') return null;
    const s = await db.collection('users').doc(req.user.uid).get();
    const d = s.exists ? s.data() : {};
    return Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
}
function podeMarcar(papel, quem, cursoId, escopo) {
    if (papel === 'adm') return true;
    if (quem === 'ti') return papel === 'ti';
    if (quem === 'coordenador') return papel === 'coordenador' && (escopo === null || escopo.includes(cursoId));
    if (quem === 'ead') return papel === 'ead';
    return false;
}

// ---------------- dados do Edubox (relay), com cache de 10 min ----------------
const cache = new Map();
async function dadosDe(formatos) {
    const k = formatos.join(',');
    const c = cache.get(k);
    if (c && Date.now() - c.em < 10 * 60 * 1000) return c.docs;
    const docs = montar(await relay(`/matrizes/dados?formatos=${encodeURIComponent(k)}`, { timeoutMs: 45000 }))
        .filter(d => CURSOS_FATEC.includes(d.cursoId));
    cache.set(k, { em: Date.now(), docs });
    return docs;
}

// semestres anteriores (até n) pra saber o que já foi oferecido
function anteriores(semestre, n = 4) {
    let [ano, s] = semestre.split('.').map(Number);
    const out = [];
    for (let i = 0; i < n; i++) { if (s === 1) { s = 2; ano--; } else s = 1; out.push(`${ano}.${s}`); }
    return out;
}

// Disciplinas EAD lançadas no semestre, uma por curso+disciplina (turmas que
// estudam juntas viram uma linha só, com os períodos/turmas juntos).
// Síncrona não entra: tem formato de presencial (aula ao vivo), não é sala EAD.
// "A Distância" com carga EAD zerada também não é EAD (ex.: Projeto Integrador Extensionista).
function eadDoSemestre(docs) {
    const m = new Map();
    docs.forEach(d => d.turmas.forEach(t => t.disciplinas.forEach(x => {
        if (x.naoOfertada || !/dist/i.test(x.tipo) || x.ch.sincrona > 0 || !(x.ch.ead > 0)) return;
        const id = `${d.semestre}__${d.cursoId}__${x.codDisciplina}`;
        if (!m.has(id)) {
            m.set(id, {
                id, semestre: d.semestre, cursoId: d.cursoId, cursoNome: d.cursoNome, coddis: x.codDisciplina, nome: x.nome,
                chEad: x.ch.ead, chTotal: x.ch.total, periodos: [], turmas: []
            });
        }
        const r = m.get(id);
        if (!r.periodos.includes(t.periodo)) r.periodos.push(t.periodo);
        if (!r.turmas.includes(t.nome)) r.turmas.push(t.nome);
    })));
    m.forEach(r => r.periodos.sort((a, b) => a - b));
    return m;
}

// Chave do nome pra comparar: sem acento, sem "de/da/do/e", sem plural ("PATOLOGIAS" = "PATOLOGIA").
const PALAVRAS_VAZIAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'A', 'O', 'AS', 'OS', 'NA', 'NO', 'NAS', 'NOS']);
const chave = (s) => norm(s).split(' ').filter(w => w && !PALAVRAS_VAZIAS.has(w)).map(w => w.length > 3 ? w.replace(/S$/, '') : w).join(' ');

// Retrato das salas que já existem no AVA (UNESVI > Graduação), lido do Open LMS e
// gravado em ava_criacao_config/ava: { atualizadoEm, salas: [{ cursoId, semestre, nome, chave }] }.
let avaCache = null;
async function salasDoAva() {
    if (avaCache && Date.now() - avaCache.em < 10 * 60 * 1000) return avaCache.salas;
    const s = await db.collection('ava_criacao_config').doc('ava').get();
    const salas = s.exists ? (s.data().salas || []) : [];
    avaCache = { em: Date.now(), salas, atualizadoEm: s.exists ? s.data().atualizadoEm : null };
    return salas;
}
// procura no AVA uma sala com o nome da disciplina (o nome da sala tem prefixos: "EAD - 2026.2 - CURSO - 6° PER - NOME")
//   mesma sala já criada neste semestre no curso → ja-existe; semestre anterior → replicar / replicar-outro
function noAva(salas, semestre, cursoId, k) {
    const achadas = salas.filter(a => a.semestre <= semestre && (' ' + a.chave + ' ').includes(' ' + k + ' '));
    if (!achadas.length) return null;
    const ord = (l) => l.sort((x, y) => y.semestre.localeCompare(x.semestre))[0];
    const jaTem = achadas.filter(a => a.cursoId === cursoId && a.semestre === semestre);
    if (jaTem.length) return { origem: 'ja-existe', a: jaTem[0] };
    // de semestre anterior só serve de modelo a sala com "EAD" no nome (as antigas sem EAD eram de presencial)
    const antes = achadas.filter(a => a.semestre < semestre && /\bEAD\b/i.test(a.nome));
    if (!antes.length) return null;
    const doCurso = antes.filter(a => a.cursoId === cursoId);
    return doCurso.length ? { origem: 'replicar', a: ord(doCurso) } : { origem: 'replicar-outro', a: ord(antes) };
}

async function listaDoSemestre(semestre) {
    const [atual, antigos, salas] = await Promise.all([
        dadosDe(formatosEdubox(semestre)),
        dadosDe(anteriores(semestre, 8).flatMap(formatosEdubox)),
        salasDoAva()
    ]);
    const lista = eadDoSemestre(atual);
    const antes = eadDoSemestre(antigos);
    const porCod = new Map(), porNomeCurso = new Map(), porNome = new Map();
    const maisNovo = (m, k, x) => { if (!m.has(k) || x.semestre > m.get(k).semestre) m.set(k, x); };
    antes.forEach(x => {
        maisNovo(porCod, `${x.cursoId}:${x.coddis}`, x);
        maisNovo(porNomeCurso, `${x.cursoId}:${chave(x.nome)}`, x);
        maisNovo(porNome, chave(x.nome), x);
    });
    const de = (r) => ({ semestre: r.semestre, cursoId: r.cursoId, cursoNome: r.cursoNome, nome: r.nome });
    const criadasAgora = new Map(); // mesma disciplina nova em 2 cursos/turmas no mesmo semestre: cria uma vez só
    [...lista.values()].sort((a, b) => a.cursoNome.localeCompare(b.cursoNome) || a.periodos[0] - b.periodos[0]).forEach(x => {
        const k = chave(x.nome);
        const ref = porCod.get(`${x.cursoId}:${x.coddis}`) || porNomeCurso.get(`${x.cursoId}:${k}`);
        const ava = noAva(salas, semestre, x.cursoId, k);
        if (ava && ava.origem === 'ja-existe') x.sugestao = { origem: 'ja-existe', de: { ...ava.a, ava: true } };
        else if (ref) x.sugestao = { origem: 'replicar', de: de(ref) };
        else if (ava && ava.origem === 'replicar') x.sugestao = { origem: 'replicar', de: { ...ava.a, ava: true } };
        else if (porNome.get(k)) x.sugestao = { origem: 'replicar-outro', de: de(porNome.get(k)) };
        else if (ava) x.sugestao = { origem: 'replicar-outro', de: { ...ava.a, ava: true } };
        else if (criadasAgora.has(k)) x.sugestao = { origem: 'replicar-outro', de: de(criadasAgora.get(k)) };
        else { x.sugestao = { origem: 'criar', de: null }; criadasAgora.set(k, x); }
        if (x.sugestao.de) delete x.sugestao.de.chave;
    });
    return lista;
}

// --------------------------------- rotas ---------------------------------

// GET /semestres — semestre atual e os 2 próximos que já existem no Edubox
router.get('/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const candidatos = semestresPadrao();
        const { semestres } = await relay(`/matrizes/semestres?formatos=${encodeURIComponent(candidatos.flatMap(formatosEdubox).join(','))}`);
        res.json([...new Set(semestres.map(normSemestre))].filter(s => candidatos.includes(s)).sort());
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// GET /?semestre=2027.1 — disciplinas EAD + o andamento salvo
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [lista, snap, escopo] = await Promise.all([
            listaDoSemestre(semestre),
            db.collection(COL).where('semestre', '==', semestre).get(),
            escopoDe(req)
        ]);
        const salvos = new Map(snap.docs.map(d => [d.id, d.data()]));
        const saida = [];
        lista.forEach(x => { saida.push({ ...x, ...(salvos.get(x.id) || {}), edubox: true }); salvos.delete(x.id); });
        // salvo aqui mas não está mais lançado no Edubox: mostra, marcado
        salvos.forEach((v, id) => saida.push({ ...v, id, edubox: false }));
        const visiveis = saida.filter(x => escopo === null || escopo.includes(x.cursoId))
            .map(x => ({ ...x, origem: x.origem || x.sugestao?.origem || 'criar' }))
            .sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || (a.periodos[0] || 0) - (b.periodos[0] || 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ semestre, papel: papelDe(req), titulacoes: TITULACOES, etapas: ETAPAS, avaliacoes: AVALIACOES, disciplinas: visiveis });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

async function doc(req, res) {
    const id = texto(req.params.id, 120);
    const [semestre, cursoId] = id.split('__');
    if (!SEMESTRE.test(semestre || '')) { res.status(400).json({ error: 'Disciplina inválida.' }); return null; }
    const ref = db.collection(COL).doc(id);
    const snap = await ref.get();
    if (snap.exists) return { ref, d: snap.data(), id };
    // primeira vez: guarda o retrato da disciplina vindo do Edubox
    const x = (await listaDoSemestre(semestre)).get(id);
    if (!x) { res.status(404).json({ error: 'Disciplina não encontrada no Edubox neste semestre.' }); return null; }
    const base = {
        semestre: x.semestre, cursoId: x.cursoId, cursoNome: x.cursoNome, coddis: x.coddis, nome: x.nome, chEad: x.chEad,
        chTotal: x.chTotal, periodos: x.periodos, turmas: x.turmas, sugestao: x.sugestao,
        origem: x.sugestao.origem, etapas: {}, avaliacoes: {}, createdAt: agora(), createdBy: quemFez(req)
    };
    return { ref, d: base, id, novo: true };
}

// PUT /:id { origem, professor, titulacao, obs, pago } — TI/ADM
router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const papel = papelDe(req);
        if (!['ti', 'adm'].includes(papel)) return res.status(403).json({ error: 'Só a TI altera os dados da criação.' });
        const x = await doc(req, res); if (!x) return;
        const b = req.body || {};
        const upd = { updatedAt: agora(), updatedBy: quemFez(req) };
        if (b.origem !== undefined) {
            if (!ORIGENS.includes(b.origem)) return res.status(400).json({ error: 'Situação no AVA inválida.' });
            upd.origem = b.origem;
        }
        if (b.professor !== undefined) upd.professor = texto(b.professor, 120);
        if (b.titulacao !== undefined) {
            if (b.titulacao && !TITULACOES[b.titulacao]) return res.status(400).json({ error: 'Titulação inválida.' });
            upd.titulacao = b.titulacao || '';
            upd.valor = b.titulacao ? TITULACOES[b.titulacao].valor : 0;
        }
        if (b.obs !== undefined) upd.obs = texto(b.obs, 1000);
        if (b.pago !== undefined) upd.pagamento = b.pago ? { pago: true, em: agora(), por: quemFez(req) } : null;
        const final = { ...x.d, ...upd };
        await x.ref.set(final, { merge: true });
        res.json({ id: x.id, ...final });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PATCH /:id/marca { tipo: 'etapa'|'avaliacao', item, destino?, feito }
router.patch('/:id/marca', verifyToken, checkPermission, async (req, res) => {
    try {
        const papel = papelDe(req);
        const escopo = await escopoDe(req);
        const x = await doc(req, res); if (!x) return;
        const { tipo, item, destino } = req.body || {};
        const feito = !!(req.body || {}).feito;
        const marca = feito ? { em: agora(), por: quemFez(req), uid: req.user.uid } : null;
        let campo;
        if (tipo === 'etapa') {
            const e = ETAPAS.find(z => z.id === item);
            if (!e) return res.status(400).json({ error: 'Etapa inválida.' });
            if (!podeMarcar(papel, e.quem, x.d.cursoId, escopo)) {
                return res.status(403).json({ error: e.quem === 'coordenador' ? 'Essa etapa é do coordenador do curso.' : e.quem === 'ead' ? 'Essa etapa é do coordenador EAD.' : 'Essa etapa é da TI.' });
            }
            campo = { etapas: { ...(x.d.etapas || {}), [item]: marca } };
        } else if (tipo === 'avaliacao') {
            if (!AVALIACOES.some(z => z.id === item) || !DESTINOS.includes(destino)) return res.status(400).json({ error: 'Avaliação inválida.' });
            if (!podeMarcar(papel, destino, x.d.cursoId, escopo)) {
                return res.status(403).json({ error: destino === 'coordenador' ? 'Quem confirma o recebimento é o coordenador do curso.' : 'Quem confirma o recebimento é o coordenador EAD.' });
            }
            const atual = (x.d.avaliacoes || {})[item] || {};
            campo = { avaliacoes: { ...(x.d.avaliacoes || {}), [item]: { ...atual, [destino]: marca } } };
        } else return res.status(400).json({ error: 'Marcação inválida.' });
        const final = { ...x.d, ...campo, updatedAt: agora(), updatedBy: quemFez(req) };
        await x.ref.set(final, { merge: true });
        res.json({ id: x.id, ...final });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// GET /professores — nomes dos professores ativos (relay), pra sugerir no campo
// GET /professores — nomes do Edubox + titulação (tac_professor.titpro, a mais recente nos últimos
// 4 semestres) pra preencher a ficha. Relay /automacao-ava/titulacoes; se ainda não existir no
// servidor, cai pra lista só de nomes (/confirmacao/professores-ativos).
const NIVEL_TIT = (t) => /dout/i.test(t) ? 3 : /mestr/i.test(t) ? 2 : /especiali/i.test(t) ? 1 : 0; // no mesmo semestre vale a maior
const TIT_EDUBOX = (t) => /dout/i.test(t) ? 'doutor' : /mestr/i.test(t) ? 'mestre' : /especiali/i.test(t) ? 'especialista' : null;
router.get('/professores', verifyToken, checkPermission, async (req, res) => {
    try {
        const sems = [semestresPadrao()[0], ...anteriores(semestresPadrao()[0], 3)].flatMap(formatosEdubox);
        const r = await relay(`/automacao-ava/titulacoes?semestres=${encodeURIComponent(sems.join(','))}`);
        const m = new Map();
        (r.professores || []).forEach(p => {
            const nome = texto(p.nome, 120), sem = normSemestre(p.sem), k = norm(nome);
            const atual = m.get(k);
            if (!atual || sem > atual.sem || (sem === atual.sem && NIVEL_TIT(p.titulacao) > NIVEL_TIT(atual.titulacaoEdubox))) m.set(k, { nome, sem, titulacaoEdubox: texto(p.titulacao, 40) });
        });
        res.json([...m.values()].map(p => ({ nome: p.nome, titulacaoEdubox: p.titulacaoEdubox, titulacao: TIT_EDUBOX(p.titulacaoEdubox) }))
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
    } catch (err) {
        try {
            const r = await relay('/confirmacao/professores-ativos');
            res.json([...new Set((r.professores || []).map(p => texto(p.nome, 120)).filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, 'pt-BR')).map(nome => ({ nome, titulacao: null, titulacaoEdubox: null })));
        } catch (e) { res.json([]); }
    }
});

// ------------------------------ Arquivos do Conduit ------------------------------
// GET /conduit?semestre=2027.1 — uma linha por SALA EAD do semestre (coddtu), só pra TI/ADM:
//   course.csv do Conduit (todas as salas que ainda não existem no AVA: criar e replicar) e,
//   pras de replicar, a sala modelo do AVA (templatecourse do "Carregar cursos").
// Sala no AVA: shortname = sigla (tac_disciplina.noadis, com os espaços originais) + " - " + coddtu,
// idnumber = coddtu, categoria UNESVI\Graduação\<codcur>\2027/1 (Medicina 2027-1),
// nome "EAD - 2027.1 - CURSO - 7° PER - DISCIPLINA" (tecnólogos sem período). Dados via relay /automacao-ava/salas.
const ROTULO_AVA = { AGRO: 'AGRONEGOCIO', AGRON: 'AGRONOMIA', ARQUIT: 'ARQUITETURA E URBANISMO', BIOMED: 'BIOMEDICINA', 'CI.CONT': 'CIÊNCIAS CONTÁBEIS',
    DIR: 'DIREITO', ENFER: 'ENFERMAGEM', 'ENG.CIV': 'ENGENHARIA CIVIL', FISIO: 'FISIOTERAPIA', 'GEST.COM': 'GESTÃO COMERCIAL', FINAN: 'GESTÃO FINANCEIRA',
    LOG: 'LOGÍSTICA', MED: 'MEDICINA', 'MED.VET.': 'MEDICINA VETERINÁRIA', PED: 'PEDAGOGIA', PSICO: 'PSICOLOGIA', RH: 'R.H' };
const TECNOLOGOS = ['AGRO', 'GEST.COM', 'FINAN', 'RH', 'LOG'];

// sala modelo no AVA pra replicar (regra do usuário, 26/10): a sala EAD da disciplina no semestre MAIS
// RECENTE (pra 2027.1, a de 2026.2, que está mais atualizada); se não houver, a do semestre espelho (2026.1)
// e depois as mais antigas. No mesmo semestre, a do mesmo curso. Só salas com "EAD" no nome.
function modeloNoAva(salas, x) {
    const k = chave(x.nome);
    const ok = salas.filter(a => a.semestre < x.semestre && /\bEAD\b/i.test(a.nome) && (' ' + a.chave + ' ').includes(' ' + k + ' '));
    return ok.sort((p, q) => q.semestre.localeCompare(p.semestre) || (q.cursoId === x.cursoId) - (p.cursoId === x.cursoId) || !!q.shortname - !!p.shortname)[0] || null;
}

router.get('/conduit', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!['ti', 'adm'].includes(papelDe(req))) return res.status(403).json({ error: 'Só a TI gera os arquivos do Conduit.' });
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [r, lista, snap, salasAva] = await Promise.all([
            relay(`/automacao-ava/salas?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}`, { timeoutMs: 45000 }),
            listaDoSemestre(semestre),
            db.collection(COL).where('semestre', '==', semestre).get(),
            salasDoAva()
        ]);
        const salvos = new Map(snap.docs.map(d => [d.id, d.data()]));
        const [ano, sem] = semestre.split('.');
        const linhas = [];
        (r.salas || []).forEach(s => {
            const codcur = String(s.codcur).trim(), cursoId = cursoIdDe(codcur);
            if (!CURSOS_FATEC.includes(cursoId) || !/dist/i.test(s.tipdis) || !(s.chead > 0) || s.sinc > 0) return;
            const id = `${semestre}__${cursoId}__${s.coddis}`;
            const x = lista.get(id);
            if (!x) return;
            const origem = (salvos.get(id) || {}).origem || x.sugestao.origem;
            const sigla = String(s.noadis || '').replace(/[\r\n,]/g, ' ');
            const per = TECNOLOGOS.includes(codcur) ? '' : ` - ${s.periodo}${codcur === 'CI.CONT' ? 'º' : '°'} PER`;
            const modelo = /^replicar/.test(origem) ? modeloNoAva(salasAva, x) : null;
            linhas.push({
                id, cursoId, codcur, cursoNome: x.cursoNome, periodo: s.periodo, turma: s.turma, coddtu: s.coddtu, disciplina: texto(s.disciplina, 200), origem,
                semSigla: !sigla.trim(),
                shortname: `${sigla} - ${s.coddtu}`,
                idnumber: String(s.coddtu),
                category: `UNESVI\\Graduação\\${codcur}\\${ano}${codcur === 'MED' ? '-' : '/'}${sem}`,
                fullname: `EAD - ${semestre} - ${ROTULO_AVA[codcur] || codcur}${per} - ${texto(s.disciplina, 200)}`,
                modelo: modelo ? { idAva: modelo.idAva, nome: modelo.nome, semestre: modelo.semestre, shortname: modelo.shortname || null } : null
            });
        });
        linhas.sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || a.periodo - b.periodo || a.disciplina.localeCompare(b.disciplina, 'pt-BR'));
        // SALA-MÃE: a mesma disciplina (mesmo nome) em vários cursos/turmas tem o mesmo conteúdo. Uma sala é a
        // mãe — 1ª rodada: replica a sala do semestre anterior (ou é criada do zero) e a TI atualiza;
        // 2ª rodada: as outras replicam da mãe já atualizada.
        const grupos = new Map();
        linhas.filter(l => l.origem !== 'ja-existe').forEach(l => { const k = chave(l.disciplina); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(l); });
        grupos.forEach(g => {
            const mae = g.find(l => l.origem === 'criar') || g.find(l => l.origem === 'replicar' && l.modelo) || g.find(l => l.modelo) || g[0];
            g.forEach(l => {
                l.grupo = g.length;
                if (l === mae) { l.mae = g.length > 1; l.rodada = l.origem === 'criar' ? 0 : 1; return; }
                l.rodada = 2;
                l.origem = l.origem === 'criar' ? 'replicar-outro' : l.origem;
                l.modelo = { nome: mae.fullname, shortname: mae.shortname, semestre, mae: true };
            });
        });
        res.json({ semestre, linhas, retratoAva: avaCache && avaCache.atualizadoEm });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
module.exports._interno = { eadDoSemestre, anteriores, chave, TITULACOES, ETAPAS, AVALIACOES };
