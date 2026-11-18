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
//   replicar-outro  nunca no curso, mas existe com o MESMO NOME em curso que compartilha conteúdo
//                   (hoje só Arquitetura ↔ Engenharia Civil — CURSOS_MESMO_CONTEUDO)
//   Mesmo nome em outro curso fora desses grupos NÃO é o mesmo conteúdo (05/11/2026: "a Optativa da Fisio
//   não é a mesma da Biomed") → fica "criar", com aviso da sala parecida; a TI só muda pra replicar se combinado.
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
// Cursos que compartilham conteúdo: disciplina com o mesmo nome na matriz é a mesma sala e pode ser copiada
// de um pro outro (05/11/2026 — Arquitetura e Engenharia Civil). Aumentar aqui se combinar outro par.
const CURSOS_MESMO_CONTEUDO = [['arquitetura-urbanismo', 'engenharia-civil']];
// Disciplinas COMUNS a todos os cursos (05/11/2026): o conteúdo é o mesmo e já há sala pronta — curso que nunca
// teve copia a sala mais recente de QUALQUER curso. Pelo nome normalizado (sem acento/pontuação).
// "Gestão e Empreendedorismo em Medicina Veterinária" é outra disciplina (não entra).
const DISCIPLINAS_COMUNS = [
    { id: 'empreendedorismo', re: /^EMPREENDEDORISMO$/ },
    { id: 'educacao-em-humanidades', re: /^EDUCACAO EM HUMANIDADES\b/ },
    // 06/11/2026 (pedido do usuário): também comuns — uma sala-mãe pra todos os cursos
    { id: 'metodologia-cientifica', re: /^METODOLOGIA CIENTIFICA$/ },
    { id: 'competencias-habilidades-linguisticas', re: /^COMPETENCIAS E HABILIDADES LINGUISTICAS?$/ }
];
const comumDe = (nome) => { const n = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); const c = DISCIPLINAS_COMUNS.find(d => d.re.test(n)); return c ? c.id : null; };
const grupoDoCurso = (c) => { const g = CURSOS_MESMO_CONTEUDO.find(x => x.includes(c)); return g ? g.join('+') : c; };
const mesmoConteudo = (a, b) => grupoDoCurso(a) === grupoDoCurso(b);
// nome da disciplina dentro do nome da sala ("EAD 2026 2 ARQUITETURA URBANISMO 6 PER HIDRAULICA SANEAMENTO" -> "HIDRAULICA SANEAMENTO")
const discDaSala = (a) => { const m = String(a.chave || '').match(/\bPER (.+)$/); return m ? m[1] : String(a.chave || ''); };
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
    if (doCurso.length) return { origem: 'replicar', a: ord(doCurso) };
    // outro curso: só copia se o curso compartilha conteúdo E o nome da disciplina é IGUAL
    // ("HIDRAULICA" não é "HIDRAULICA SANEAMENTO")
    const irmas = antes.filter(a => mesmoConteudo(a.cursoId, cursoId) && discDaSala(a) === k);
    if (irmas.length) return { origem: 'replicar-outro', a: ord(irmas) };
    return { origem: 'parecida', a: ord(antes) }; // só aviso: sala com nome parecido em outro curso
}

// Períodos que estudam juntos (05/11/2026): vêm dos arquivos de horário do módulo Matrizes
// (matrizes_grade/{semestre}__{curso}.grupos, ex.: [[2],[3,4],[5,6]]). Sem o horário do semestre, usa o do
// semestre anterior com todo mundo subindo um período ([5,6] de 2026.2 → [6,7] de 2027.1) e marca pra confirmar.
async function gruposQueEstudamJuntos(semestre) {
    const ler = async (sem) => {
        const snap = await db.collection('matrizes_grade').where('semestre', '==', sem).get();
        const m = new Map();
        snap.docs.forEach(d => { const x = d.data(); const g = (x.grupos || []).map(v => (Array.isArray(v) ? v : v.periodos || [])); if (g.length) m.set(x.cursoId || d.id.split('__')[1], g); });
        return m;
    };
    const atual = await ler(semestre);
    const antes = await ler(anteriores(semestre, 1)[0]);
    const out = new Map();
    atual.forEach((g, c) => out.set(c, { grupos: g, confirmado: true }));
    antes.forEach((g, c) => { if (!out.has(c)) out.set(c, { grupos: g.map(p => p.map(n => n + 1)), confirmado: false }); });
    return out;
}

// Períodos que estudam juntos pela GRADE do semestre no Edubox (06/11/2026): se dois períodos do mesmo curso
// têm 2+ disciplinas iguais no mesmo semestre, é porque estudam juntos (o par é fixo: 1º+2º, 3º+4º...; quem
// entrou no semestre anterior vira 2º e estuda com os calouros do 1º). Só junta períodos VIZINHOS (2º com 1º
// ou 3º): período distante que repete disciplinas é outra turma, em outra sala física (ex.: Enfermagem 10º —
// turma 2022/2 refazendo disciplinas do 1º — tem as salas dela; 06/11/2026).
function gruposDaGrade(salas) {
    const por = new Map();
    salas.forEach(s => {
        const c = cursoIdDe(String(s.codcur).trim());
        if (!por.has(c)) por.set(c, new Map());
        const m = por.get(c);
        if (!m.has(s.periodo)) m.set(s.periodo, new Set());
        m.get(s.periodo).add(chave(s.disciplina));
    });
    const out = new Map();
    por.forEach((m, c) => {
        const ps = [...m.keys()].sort((a, b) => a - b);
        const pai = new Map(ps.map(p => [p, p]));
        const raiz = (p) => pai.get(p) === p ? p : raiz(pai.get(p));
        ps.forEach((a, i) => ps.slice(i + 1).forEach(b => {
            let n = 0; m.get(a).forEach(k => { if (m.get(b).has(k)) n++; });
            if (n >= 2 && b - a === 1) pai.set(raiz(b), raiz(a));
        }));
        const g = new Map();
        ps.forEach(p => { const r = raiz(p); if (!g.has(r)) g.set(r, []); g.get(r).push(p); });
        const grupos = [...g.values()].filter(x => x.length > 1);
        if (grupos.length) out.set(c, { grupos, confirmado: true, fonte: 'grade' });
    });
    return out;
}

async function listaDoSemestre(semestre) {
    const [atual, antigos, salas, juntosPorCurso] = await Promise.all([
        dadosDe(formatosEdubox(semestre)),
        dadosDe(anteriores(semestre, 8).flatMap(formatosEdubox)),
        salasDoAva(),
        gruposQueEstudamJuntos(semestre)
    ]);
    // true/false = o horário diz; null = não há horário do curso pra saber
    const estudamJuntos = (cursoId, a, b) => {
        const j = juntosPorCurso.get(cursoId);
        if (!j) return { juntas: null, confirmado: false };
        return { juntas: j.grupos.some(g => a.some(p => g.includes(p)) && b.some(p => g.includes(p))), confirmado: j.confirmado };
    };
    const lista = eadDoSemestre(atual);
    const antes = eadDoSemestre(antigos);
    const porCod = new Map(), porNomeCurso = new Map(), porNomeGrupo = new Map(), porNome = new Map(), porComum = new Map();
    const maisNovo = (m, k, x) => { if (!m.has(k) || x.semestre > m.get(k).semestre) m.set(k, x); };
    antes.forEach(x => {
        maisNovo(porCod, `${x.cursoId}:${x.coddis}`, x);
        maisNovo(porNomeCurso, `${x.cursoId}:${chave(x.nome)}`, x);
        maisNovo(porNomeGrupo, `${grupoDoCurso(x.cursoId)}:${chave(x.nome)}`, x);
        maisNovo(porNome, chave(x.nome), x);
        const comum = comumDe(x.nome);
        if (comum) maisNovo(porComum, comum, x);
    });
    const de = (r) => ({ semestre: r.semestre, cursoId: r.cursoId, cursoNome: r.cursoNome, nome: r.nome });
    // mesma disciplina nova em 2 turmas do mesmo curso (ou de cursos que compartilham conteúdo) no mesmo
    // semestre: cria uma vez só
    const criadasAgora = new Map();
    [...lista.values()].sort((a, b) => a.cursoNome.localeCompare(b.cursoNome) || a.periodos[0] - b.periodos[0]).forEach(x => {
        const k = chave(x.nome);
        const kg = `${grupoDoCurso(x.cursoId)}:${k}`;
        const ref = porCod.get(`${x.cursoId}:${x.coddis}`) || porNomeCurso.get(`${x.cursoId}:${k}`);
        const irma = !ref && porNomeGrupo.get(kg);   // mesmo nome na matriz de um curso que compartilha conteúdo
        const comum = !ref && comumDe(x.nome) && porComum.get(comumDe(x.nome)); // disciplina comum: sala de qualquer curso
        const ava = noAva(salas, semestre, x.cursoId, k);
        const agora = criadasAgora.get(kg);
        if (ava && ava.origem === 'ja-existe') x.sugestao = { origem: 'ja-existe', de: { ...ava.a, ava: true } };
        else if (ref) x.sugestao = { origem: 'replicar', de: de(ref) };
        else if (ava && ava.origem === 'replicar') x.sugestao = { origem: 'replicar', de: { ...ava.a, ava: true } };
        else if (irma) x.sugestao = { origem: 'replicar-outro', de: de(irma) };
        else if (comum) x.sugestao = { origem: 'replicar-outro', de: de(comum), comum: true };
        else if (ava && ava.origem === 'replicar-outro') x.sugestao = { origem: 'replicar-outro', de: { ...ava.a, ava: true } };
        // mesma disciplina já "a criar" neste semestre em outro período do curso (ou no curso parceiro):
        // é a MESMA sala — cria uma vez só e esta turma usa a mesma (não é cópia do semestre anterior)
        else if (agora && (agora.cursoId !== x.cursoId || estudamJuntos(x.cursoId, agora.periodos, x.periodos).juntas !== false)) {
            // no mesmo curso só é a mesma sala se os períodos estudam juntos (horário); entre cursos parceiros, sim
            const j = agora.cursoId === x.cursoId ? estudamJuntos(x.cursoId, agora.periodos, x.periodos) : { juntas: true, confirmado: true };
            x.sugestao = { origem: agora.cursoId === x.cursoId ? 'replicar' : 'replicar-outro', de: { ...de(agora), periodos: agora.periodos }, mesmaSala: true,
                juntas: j.juntas, juntasConfirmado: j.confirmado };
        }
        else {
            // nome igual/parecido em OUTRO curso não é o mesmo conteúdo: cria, e só avisa onde tem sala parecida
            const outro = porNome.get(k);
            const parecida = outro && outro.cursoId !== x.cursoId ? de(outro) : (ava && ava.origem === 'parecida' ? { ...ava.a, ava: true } : null);
            x.sugestao = { origem: 'criar', de: null, ...(parecida ? { parecida } : {}) };
            criadasAgora.set(kg, x);
        }
        if (x.sugestao.de) delete x.sugestao.de.chave;
        if (x.sugestao.parecida) delete x.sugestao.parecida.chave;
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
        const [r, lista, snap, salasAva, juntos] = await Promise.all([
            relay(`/automacao-ava/salas?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}`, { timeoutMs: 45000 }),
            listaDoSemestre(semestre),
            db.collection(COL).where('semestre', '==', semestre).get(),
            salasDoAva(),
            gruposQueEstudamJuntos(semestre)
        ]);
        const salvos = new Map(snap.docs.map(d => [d.id, d.data()]));
        // quem estuda junto: a grade do semestre no Edubox; o horário do Matrizes só manda se for do próprio semestre
        const juntosGrade = gruposDaGrade(r.salas || []);
        juntos.forEach((v, c) => { if (v.confirmado) juntosGrade.set(c, v); });
        juntos.clear(); juntosGrade.forEach((v, c) => juntos.set(c, v));
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
                modelo: modelo ? { idAva: modelo.idAva, nome: modelo.nome, semestre: modelo.semestre, cursoId: modelo.cursoId, shortname: modelo.shortname || null } : null,
                mesmaSala: !!x.sugestao.mesmaSala
            });
        });
        linhas.sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || a.periodo - b.periodo || a.disciplina.localeCompare(b.disciplina, 'pt-BR'));
        // PERÍODOS QUE ESTUDAM JUNTOS (06/11/2026): a mesma disciplina em períodos do mesmo curso que têm aula
        // juntos (horário do Matrizes) é UMA sala só — a do período menor, nome "6° E 7° PER"; os diários dos
        // outros períodos entram nela pelo enroll (diarios). Sem horário do curso, cada período tem a sua sala.
        const salas = [], porDisc = new Map();
        linhas.forEach(l => {
            // tecnólogo: Projeto Integrador é UMA sala pro curso todo, mesmo com nomes diferentes por matriz
            // (ex.: "PI I" da turma antiga + "PI em …" das novas — 06/11/2026)
            const piTec = TECNOLOGOS.includes(l.codcur) && /^PROJETO INTEGRADOR/.test(norm(l.disciplina));
            const j = juntos.get(l.cursoId), k = `${l.cursoId}:${piTec ? 'PROJETO INTEGRADOR' : chave(l.disciplina)}`;
            const lst = porDisc.get(k) || []; porDisc.set(k, lst);
            // tecnólogo: o nome da sala não tem período e as turmas rodam juntas → sempre UMA sala por disciplina
            const tec = TECNOLOGOS.includes(l.codcur);
            const par = tec ? lst[0] : j && lst.find(s => j.grupos.some(g => g.includes(l.periodo) && s.periodos.some(p => g.includes(p))));
            if (par) {
                if (!par.periodos.includes(l.periodo)) par.periodos.push(l.periodo);
                par.diarios.push(l.coddtu);
                par.juntasConfirmado = tec || j.confirmado;
                return;
            }
            l.periodos = [l.periodo]; l.diarios = [l.coddtu];
            lst.push(l); salas.push(l);
        });
        salas.filter(l => l.periodos.length > 1 && !TECNOLOGOS.includes(l.codcur)).forEach(l => {
            const o = l.codcur === 'CI.CONT' ? 'º' : '°', ps = l.periodos.sort((a, b) => a - b).map(p => `${p}${o}`);
            const per = ps.length === 2 ? ps.join(' E ') : `${ps.slice(0, -1).join(', ')} E ${ps[ps.length - 1]}`;
            l.fullname = l.fullname.replace(` - ${l.periodo}${o} PER - `, ` - ${per} PER - `);
        });
        linhas.length = 0; linhas.push(...salas);
        // SALA-MÃE: a mesma disciplina (mesmo nome) em várias turmas DO MESMO CURSO (ou de cursos que compartilham
        // conteúdo — CURSOS_MESMO_CONTEUDO) tem o mesmo conteúdo. Uma sala é a
        // mãe — 1ª rodada: replica a sala do semestre anterior (ou é criada do zero) e a TI atualiza;
        // 2ª rodada: as outras replicam da mãe já atualizada.
        // DISCIPLINAS COMUNS (Empreendedorismo, Metodologia Científica, Educação em Humanidades, Competências e
        // Habilidades Linguísticas — 06/11/2026): UMA sala-mãe pra TODOS os cursos; a TI edita a mãe e depois as
        // outras (cada uma com o nome do seu curso e período) copiam dela na 2ª rodada.
        const grupos = new Map();
        linhas.filter(l => l.origem !== 'ja-existe').forEach(l => {
            const comum = comumDe(l.disciplina);
            if (comum) l.comum = comum;
            const k = comum ? `comum:${comum}` : `${grupoDoCurso(l.cursoId)}:${chave(l.disciplina)}`;
            if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(l);
        });
        // mãe que copia da sala mais recente (com shortname lido; empate: modelo do próprio curso)
        const melhor = (g) => g.filter(l => l.modelo).sort((p, q) => String(q.modelo.semestre).localeCompare(String(p.modelo.semestre))
            || !!q.modelo.shortname - !!p.modelo.shortname || (q.modelo.cursoId === q.cursoId) - (p.modelo.cursoId === p.cursoId))[0];
        grupos.forEach(g => {
            const mae = g.find(l => l.origem === 'criar') || melhor(g) || g[0];
            g.forEach(l => {
                l.grupo = g.length;
                if (l === mae) { l.mae = g.length > 1; l.rodada = l.origem === 'criar' ? 0 : 1; return; }
                // disciplina nova nos dois cursos parceiros (Arq ↔ Eng Civil): é a MESMA sala — os alunos do
                // parceiro entram na sala criada (enroll), sem sala própria (ex.: Patologia das Estruturas 2027.1)
                if (l.mesmaSala && !l.comum && mae.origem === 'criar' && mae.cursoId !== l.cursoId) {
                    mae.diarios.push(...l.diarios); l.juntoDe = mae.shortname; return;
                }
                l.rodada = 2;
                l.origem = l.origem === 'criar' ? 'replicar-outro' : l.origem;
                l.modelo = { nome: mae.fullname, shortname: mae.shortname, semestre, mae: true };
            });
        });
        res.json({ semestre, linhas: linhas.filter(l => !l.juntoDe), retratoAva: avaCache && avaCache.atualizadoEm });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ------------------------------ Unidades (UAs) por link ------------------------------
// 18/11/2026. Nas disciplinas "criar", o PROFESSOR escolhe as unidades do catálogo SAGAH (nº, código, título)
// e o COORDENADOR do curso valida cada uma; a TI marca a validação da sala no AVA. Professor e coordenador
// NÃO têm login no Órbita: cada um recebe um link próprio (token = autorização, como o enviar-questoes):
//   professor   → um link por semestre+professor, com todas as disciplinas "criar" dele
//   coordenador → um link por semestre+curso, com todas as disciplinas "criar" do curso
// Qtd de UAs: 12 (disciplina de 80/60 h: UA 01–06 no 1º bim, 07–12 no 2º) ou 6 (40/30 h). A TI pode trocar.
// Professor preenche tudo → etapa "Seleção das unidades" marca sozinha; coordenador valida todas →
// "Unidades validadas pelo coordenador" marca sozinha. UA validada (OK) fica travada pro professor;
// UA devolvida ("ajustar", com observação) volta a ficar editável.
// Coleção dos links: ava_unidades_links/{token}. Unidades em ava_criacao/{id}.unidades.
const crypto = require('crypto');
const COL_LINKS_UA = 'ava_unidades_links';
const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;
const qtdPadrao = (d) => ((d.chEad || d.chTotal || 0) >= 60 ? 12 : 6);
const qtdDe = (d) => (d.unidades && [6, 12].includes(d.unidades.qtd) ? d.unidades.qtd : qtdPadrao(d));
const origemDe = (d) => d.origem || d.sugestao?.origem || 'criar';

// o que sai pra fora (sem uid/e-mail de ninguém)
function discPublica(id, d) {
    const qtd = qtdDe(d);
    const itens = (d.unidades?.itens || []).filter(u => u.n >= 1 && u.n <= qtd);
    return {
        id, cursoId: d.cursoId, cursoNome: d.cursoNome, nome: d.nome, periodos: d.periodos || [], chEad: d.chEad || null,
        professor: d.professor || '', qtd,
        itens: itens.map(u => ({ n: u.n, codigo: u.codigo || '', titulo: u.titulo || '', coord: u.coord ? { status: u.coord.status, obs: u.coord.obs || '', em: u.coord.em } : null, ava: !!u.ava }))
    };
}

async function discCriarDoSemestre(semestre) {
    const snap = await db.collection(COL).where('semestre', '==', semestre).get();
    return snap.docs.map(s => ({ id: s.id, d: s.data() })).filter(x => origemDe(x.d) === 'criar' && texto(x.d.professor));
}
async function linksDoSemestre(semestre) {
    const snap = await db.collection(COL_LINKS_UA).where('semestre', '==', semestre).get();
    return snap.docs.map(s => ({ token: s.id, ...s.data() }));
}
const coordDoCurso = (links, cursoId) => (links.find(l => l.tipo === 'coordenador' && l.cursoId === cursoId && l.ativo !== false) || {}).coordenador || '';

// marca/desmarca sozinho as etapas "seleção" e "validação do coordenador" conforme as UAs
function etapasDasUnidades(d, quem) {
    const qtd = qtdDe(d);
    const itens = (d.unidades?.itens || []).filter(u => u.n >= 1 && u.n <= qtd);
    const preenchidas = itens.filter(u => u.codigo && u.titulo).length === qtd;
    const validadas = preenchidas && itens.filter(u => u.coord?.status === 'ok').length === qtd;
    const et = { ...(d.etapas || {}) };
    const marca = { em: agora(), por: quem, uid: 'link' };
    if (preenchidas && !et.selecao) et.selecao = marca;
    if (!preenchidas && et.selecao?.uid === 'link') et.selecao = null;
    if (validadas && !et.validacaoUnidades) et.validacaoUnidades = marca;
    if (!validadas && et.validacaoUnidades?.uid === 'link') et.validacaoUnidades = null;
    return et;
}

const soTi = (req, res) => { if (['ti', 'adm'].includes(papelDe(req))) return true; res.status(403).json({ error: 'Só a TI mexe nos links das unidades.' }); return false; };

// GET /unidades?semestre= — TI: disciplinas "criar" com professor, as UAs e os links já gerados
router.get('/unidades', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [discs, links] = await Promise.all([discCriarDoSemestre(semestre), linksDoSemestre(semestre)]);
        res.json({
            semestre,
            disciplinas: discs.map(x => ({ ...discPublica(x.id, x.d), coordenador: coordDoCurso(links, x.d.cursoId) }))
                .sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR')),
            links: links.filter(l => l.ativo !== false).map(l => ({ token: l.token, tipo: l.tipo, professor: l.professor || '', cursoId: l.cursoId || '', cursoNome: l.cursoNome || '', coordenador: l.coordenador || '' }))
        });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// POST /unidades/links { semestre, tipo:'professor', professor } | { semestre, tipo:'coordenador', cursoId, coordenador }
// Devolve o link que já existe (mesmo semestre + professor/curso) ou cria um. No coordenador, atualiza o nome.
router.post('/unidades/links', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const b = req.body || {};
        const semestre = b.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const links = await linksDoSemestre(semestre);
        let dados;
        if (b.tipo === 'professor') {
            const professor = texto(b.professor, 120);
            if (!professor) return res.status(400).json({ error: 'Informe o professor.' });
            const ja = links.find(l => l.tipo === 'professor' && l.ativo !== false && norm(l.professor) === norm(professor));
            if (ja) return res.json(ja);
            dados = { tipo: 'professor', semestre, professor };
        } else if (b.tipo === 'coordenador') {
            const cursoId = texto(b.cursoId, 60);
            if (!CURSOS_FATEC.includes(cursoId)) return res.status(400).json({ error: 'Curso inválido.' });
            const coordenador = texto(b.coordenador, 120);
            if (!coordenador) return res.status(400).json({ error: 'Informe o nome do coordenador.' });
            const ja = links.find(l => l.tipo === 'coordenador' && l.ativo !== false && l.cursoId === cursoId);
            if (ja) {
                if (ja.coordenador !== coordenador) await db.collection(COL_LINKS_UA).doc(ja.token).update({ coordenador, updatedAt: agora(), updatedBy: quemFez(req) });
                return res.json({ ...ja, coordenador });
            }
            dados = { tipo: 'coordenador', semestre, cursoId, cursoNome: texto(b.cursoNome, 80) || cursoId, coordenador };
        } else return res.status(400).json({ error: 'Tipo de link inválido.' });
        const token = crypto.randomBytes(18).toString('base64url');
        const novo = { ...dados, ativo: true, createdAt: agora(), createdBy: quemFez(req) };
        await db.collection(COL_LINKS_UA).doc(token).set(novo);
        res.status(201).json({ token, ...novo });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PATCH /unidades/:id { qtd: 6|12 } ou { n, ava: true|false } — TI
router.patch('/unidades/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const ref = db.collection(COL).doc(texto(req.params.id, 120));
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const d = snap.data();
        const b = req.body || {};
        const un = { ...(d.unidades || {}), qtd: qtdDe(d), itens: [...(d.unidades?.itens || [])] };
        if (b.qtd !== undefined) {
            if (![6, 12].includes(Number(b.qtd))) return res.status(400).json({ error: 'A disciplina tem 6 ou 12 unidades.' });
            un.qtd = Number(b.qtd);
        }
        if (b.n !== undefined) {
            const n = Number(b.n);
            const i = un.itens.findIndex(u => u.n === n);
            if (i < 0 || !un.itens[i].codigo) return res.status(400).json({ error: 'Essa unidade ainda não foi preenchida pelo professor.' });
            un.itens[i] = { ...un.itens[i], ava: b.ava ? { em: agora(), por: quemFez(req) } : null };
        }
        const final = { ...d, unidades: un };
        final.etapas = etapasDasUnidades(final, quemFez(req));
        await ref.set({ unidades: un, etapas: final.etapas, updatedAt: agora(), updatedBy: quemFez(req) }, { merge: true });
        res.json(discPublica(snap.id, final));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// --- público (sem login: o token do link é a autorização) ---
async function linkUa(token, res) {
    if (!TOKEN_RE.test(String(token || ''))) { res.status(404).json({ error: 'Link inválido. Confira se copiou o endereço inteiro.' }); return null; }
    const s = await db.collection(COL_LINKS_UA).doc(token).get();
    if (!s.exists || s.data().ativo === false) { res.status(404).json({ error: 'Link não encontrado ou desativado. Peça um novo ao setor de T.I.' }); return null; }
    return s.data();
}
const daProfessor = (l, d) => norm(d.professor) === norm(l.professor);
const doCoordenador = (l, d) => d.cursoId === l.cursoId;

// GET /publico/unidades/:token
router.get('/publico/unidades/:token', async (req, res) => {
    try {
        const l = await linkUa(req.params.token, res); if (!l) return;
        const [discs, links] = await Promise.all([discCriarDoSemestre(l.semestre), linksDoSemestre(l.semestre)]);
        const minhas = discs.filter(x => (l.tipo === 'professor' ? daProfessor(l, x.d) : doCoordenador(l, x.d)))
            .map(x => ({ ...discPublica(x.id, x.d), coordenador: coordDoCurso(links, x.d.cursoId) }))
            .sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ tipo: l.tipo, semestre: l.semestre, professor: l.professor || '', cursoNome: l.cursoNome || '', coordenador: l.coordenador || '', disciplinas: minhas });
    } catch (err) { res.status(500).json({ error: 'Não foi possível abrir o link agora. Tente de novo em instantes.' }); }
});

// POST /publico/unidades/:token/salvar { discId, itens:[{ n, codigo, titulo }] } — professor
router.post('/publico/unidades/:token/salvar', async (req, res) => {
    try {
        const l = await linkUa(req.params.token, res); if (!l) return;
        if (l.tipo !== 'professor') return res.status(403).json({ error: 'Este link é de validação do coordenador.' });
        const ref = db.collection(COL).doc(texto(req.body.discId, 120));
        const snap = await ref.get();
        if (!snap.exists || snap.data().semestre !== l.semestre || !daProfessor(l, snap.data())) return res.status(404).json({ error: 'Disciplina não encontrada no seu link.' });
        const d = snap.data();
        const qtd = qtdDe(d);
        const atuais = new Map((d.unidades?.itens || []).map(u => [u.n, u]));
        const recebidos = Array.isArray(req.body.itens) ? req.body.itens : [];
        const quem = `${l.professor} (link do professor)`;
        recebidos.forEach(r => {
            const n = Number(r.n);
            if (!(n >= 1 && n <= qtd)) return;
            const codigo = texto(r.codigo, 20).replace(/\D/g, '');
            const titulo = texto(r.titulo, 300);
            const a = atuais.get(n) || { n };
            if (a.coord?.status === 'ok') return; // validada: travada
            if (a.codigo === codigo && a.titulo === titulo) return;
            // mudou: volta a esperar a validação (mantém a observação do coordenador pra referência)
            atuais.set(n, { n, codigo, titulo, coord: a.coord?.status === 'ajustar' ? { ...a.coord, status: 'reenviada' } : null, ava: null, editadoEm: agora(), editadoPor: quem });
        });
        const itens = [...atuais.values()].sort((a, b) => a.n - b.n);
        const un = { ...(d.unidades || {}), qtd, itens, enviadoEm: agora() };
        const final = { ...d, unidades: un };
        final.etapas = etapasDasUnidades(final, quem);
        await ref.set({ unidades: un, etapas: final.etapas, updatedAt: agora(), updatedBy: quem }, { merge: true });
        res.json(discPublica(snap.id, final));
    } catch (err) { res.status(500).json({ error: 'Não foi possível salvar agora. Tente de novo em instantes.' }); }
});

// POST /publico/unidades/:token/validar { discId, n | 'todas', status:'ok'|'ajustar', obs } — coordenador
router.post('/publico/unidades/:token/validar', async (req, res) => {
    try {
        const l = await linkUa(req.params.token, res); if (!l) return;
        if (l.tipo !== 'coordenador') return res.status(403).json({ error: 'Este link é do professor.' });
        const ref = db.collection(COL).doc(texto(req.body.discId, 120));
        const snap = await ref.get();
        if (!snap.exists || snap.data().semestre !== l.semestre || !doCoordenador(l, snap.data())) return res.status(404).json({ error: 'Disciplina não encontrada no seu link.' });
        const status = req.body.status;
        if (!['ok', 'ajustar', 'limpar'].includes(status)) return res.status(400).json({ error: 'Escolha validar ou pedir ajuste.' });
        const obs = texto(req.body.obs, 600);
        if (status === 'ajustar' && !obs) return res.status(400).json({ error: 'Escreva o que o professor precisa ajustar.' });
        const d = snap.data();
        const qtd = qtdDe(d);
        const quem = `${l.coordenador} (link do coordenador)`;
        const alvo = req.body.n === 'todas' ? null : Number(req.body.n);
        let mexeu = 0;
        const itens = (d.unidades?.itens || []).map(u => {
            if (u.n > qtd || !u.codigo || !u.titulo) return u;
            if (alvo !== null && u.n !== alvo) return u;
            if (alvo === null && u.coord?.status === 'ok') return u;
            mexeu++;
            return { ...u, coord: status === 'limpar' ? null : { status, obs: status === 'ajustar' ? obs : '', em: agora(), por: quem } };
        });
        if (!mexeu) return res.status(400).json({ error: alvo === null ? 'Não há unidades preenchidas esperando validação.' : 'Essa unidade ainda não foi preenchida pelo professor.' });
        const un = { ...(d.unidades || {}), qtd, itens };
        const final = { ...d, unidades: un };
        final.etapas = etapasDasUnidades(final, quem);
        await ref.set({ unidades: un, etapas: final.etapas, updatedAt: agora(), updatedBy: quem }, { merge: true });
        res.json(discPublica(snap.id, final));
    } catch (err) { res.status(500).json({ error: 'Não foi possível salvar agora. Tente de novo em instantes.' }); }
});

module.exports = router;
module.exports._interno ={ eadDoSemestre, anteriores, chave, gruposDaGrade, TITULACOES, ETAPAS, AVALIACOES };
