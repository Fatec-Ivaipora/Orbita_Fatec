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
// Professores da Medicina na aba Avaliações (16/11/2026): cada um só nas disciplinas que dá no semestre (Edubox).
// TITULAR (ou o responsável escolhido nos Critérios) vê e mexe na prova inteira; ADJUNTO só nas próprias questões.
// Critérios e reabrir continuam só com os editores (Ana Beatriz / coordenação / ADM).
const semestreAtualAv = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };
function ehProfessorMed(user) { return (user.role === 'professor_medicina' || user.professorMedicina === true) && !podeAvaliacoes(user); }
async function perfilAv(req) {
    const snap = await db.collection('users').doc(req.user.uid).get();
    const u = snap.exists ? snap.data() : {};
    const nome = String(u.nomeEdubox || u.name || u.nome || req.user.name || '').replace(/\s+/g, ' ').trim();
    const { disciplinas } = await listaDisciplinas(semestreAtualAv(), { comTurmasEspeciais: true });
    const minhas = nome ? disciplinas.filter(d => d.professores.some(x => normNome(x) === normNome(nome))) : [];
    const crits = await Promise.all(minhas.map(d => lerCriterios(d.chave).catch(() => null)));
    const titulares = new Set(minhas.filter((d, i) => {
        const c = crits[i];
        return c && c.responsavel ? normNome(c.responsavel) === normNome(nome) : (d.titulares || []).some(x => normNome(x) === normNome(nome));
    }).map(d => d.chave));
    return { nome, uid: req.user.uid, chaves: new Set(minhas.map(d => d.chave)), titulares };
}
function negar(msg) { const e = new Error(msg); e.status = 403; return e; }
// lança 403 se o professor não dá aula na disciplina
function exigeDisc(req, chave) { if (req.prof && !req.prof.chaves.has(chave)) throw negar('Esta disciplina não é sua neste semestre.'); }
const ehTitularAv = (req, chave) => !req.prof || req.prof.titulares.has(chave);
function exigeTitularAv(req, chave, oque) { exigeDisc(req, chave); if (!ehTitularAv(req, chave)) throw negar(`Só o professor titular da disciplina ${oque}.`); }
function exigeEditorAv(req, oque) { if (req.prof) throw negar(`Só a responsável pelas avaliações e a coordenação ${oque}.`); }
const minhaQ = (req, q) => !req.prof || normNome(q.professorNome || q.elaboradoPor) === normNome(req.prof.nome) || (!q.professorNome && q.criadoPor === req.prof.uid);
// o que a pessoa vê da prova: titular/editor tudo; adjunto só as próprias
const visiveis = (req, av, qs) => (ehTitularAv(req, av.chave) ? qs : qs.filter(q => minhaQ(req, q)));
// professor: a questão sai sempre no nome dele (adjunto); o titular pode lançar por um colega da disciplina
function professorDoBody(req, av, nome) {
    if (!req.prof) return nome;
    if (!ehTitularAv(req, av.chave) || !String(nome || '').trim()) return req.prof.nome;
    return nome;
}
async function exigeAcesso(req, res, next) {
    if (podeAvaliacoes(req.user)) return next();
    if (!ehProfessorMed(req.user)) return res.status(403).json({ error: 'Só a responsável pelas avaliações, a coordenação e os professores de Medicina usam esta área.' });
    try {
        req.prof = await perfilAv(req);
        if (!req.prof.chaves.size) return res.status(403).json({ error: 'Não encontrei disciplinas suas da Medicina neste semestre no Edubox.' });
        next();
    } catch (e) { erro(res, e); }
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

let demoCache = { em: 0, lista: [] };
async function usuariosDemo() {
    if (Date.now() - demoCache.em < 5 * 60000) return demoCache.lista;
    const snap = await db.collection('users').where('demoMedicina.ativo', '==', true).get().catch(() => ({ docs: [] }));
    // demoMedicina.disciplinas (lista) ou .disciplina (uma só)
    demoCache = { em: Date.now(), lista: snap.docs.flatMap(d => {
        const dm = d.data().demoMedicina || {}, nome = String(d.data().name || '').replace(/\s+/g, ' ').trim();
        const discs = Array.isArray(dm.disciplinas) ? dm.disciplinas : (dm.disciplina ? [dm.disciplina] : []);
        return discs.map(disciplina => ({ nome, disciplina, titular: dm.titular === true }));
    }).filter(u => u.nome && u.disciplina) };
    return demoCache.lista;
}
// Turmas de ADAPTAÇÃO e DEPENDÊNCIA (26/11/2026): no Edubox o diário vem com turma "ADP - MEDICINA" / "DP - MEDICINA".
// Quando a disciplina também tem turma regular (ex.: Oncogênese — 4º período e ADP), a turma ADP/DP tem as MESMAS
// provas (1º/2º bimestre, 1ª/2ª chamada, exame), montadas pelos professores DELA e enviadas ao curso ADP/DP do AVA.
// Com { comTurmasEspeciais: true } (só nas provas do Banco MED) ela vira uma disciplina à parte:
//   nome "ONCOGÊNESE E TOXICOLOGIA · ADAPTAÇÃO", chave "oncogenese-e-toxicologia-adp", mesma categoria (banco de questões).
// Disciplina que só existe como ADP/DP no semestre (ex.: Habilidades Clínicas I) continua como antes, sem sufixo.
const turmaEspecialDo = (turma) => { const m = /^\s*(A?DP)\b/i.exec(String(turma || '')); return m ? m[1].toLowerCase() : null; };
const ROTULO_TURMA_ESPECIAL = { adp: 'ADAPTAÇÃO', dp: 'DEPENDÊNCIA' };
const SUFIXO_TURMA_ESPECIAL = /\s*·\s*(ADAPTAÇÃO|DEPENDÊNCIA)$/i;
const nomeBaseDisciplina = (nome) => String(nome || '').replace(SUFIXO_TURMA_ESPECIAL, '');
async function listaDisciplinas(semestre, { comTurmasEspeciais = false } = {}) {
    const fonte = await semestreComDados(semestre);
    const [diarios, cats] = await Promise.all([diariosMed(fonte), categorias()]);
    const comRegular = new Set(diarios.filter(d => !turmaEspecialDo(d.turma)).map(d => normNome(d.disciplina)));
    const porNome = new Map();
    diarios.forEach(d => {
        const base = normNome(d.disciplina);
        const esp = comTurmasEspeciais && comRegular.has(base) ? turmaEspecialDo(d.turma) : null;
        const k = esp ? `${base}|${esp}` : base;
        if (!porNome.has(k)) {
            const cat = cats.find(c => normNome(c.nome) === base);
            porNome.set(k, {
                chave: slug(d.disciplina) + (esp ? `-${esp}` : ''), nome: d.disciplina.replace(/\s+/g, ' ') + (esp ? ` · ${ROTULO_TURMA_ESPECIAL[esp]}` : ''),
                ...(esp ? { turmaEspecial: esp } : {}),
                sigla: d.sigla, periodo: cat ? cat.periodo : d.periodo, categoriaId: cat ? cat.id : null, professores: new Set(), titulares: new Set(), coddtus: new Set()
            });
        }
        const x = porNome.get(k);
        x.professores.add(titulo(d.nome).replace(/\s+/g, ' '));
        // professor TITULAR da disciplina no Edubox (tac_professor.tippro, relay v4 — 16/11/2026); os demais são adjuntos
        if (d.vinculo && /titular/i.test(String(d.vinculo.tippro || ''))) x.titulares.add(titulo(d.nome).replace(/\s+/g, ' '));
        x.coddtus.add(d.coddtu);
    });
    // usuários de DEMONSTRAÇÃO (16/11/2026 — tutorial): users.demoMedicina = { ativo, disciplina, titular } entram como
    // professor (titular ou adjunto) da disciplina, como se viessem do Edubox. Apagar as contas tira da lista.
    (await usuariosDemo()).forEach(u => {
        const x = porNome.get(normNome(u.disciplina));
        if (!x) return;
        x.professores.add(u.nome);
        if (u.titular) x.titulares.add(u.nome);
    });
    return {
        fonte,
        disciplinas: [...porNome.values()].map(x => ({ ...x, professores: [...x.professores].sort(), titulares: [...x.titulares].sort(), coddtus: [...x.coddtus] }))
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
    const k = normNome(nomeBaseDisciplina(nomeDisciplina));
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
// feedback em imagem (16/11/2026): às vezes o feedback é um gráfico. Mantém as que já estavam quando o corpo não manda
// a lista e apaga do Storage as que saíram.
async function imagensFeedbackDe(body, antes) {
    const novas = body.imagensFeedback === undefined ? ((antes && antes.imagensFeedback) || []) : await confirmarImagens(body.imagensFeedback);
    const ficam = new Set(novas.map(i => i.caminho));
    if (antes) await Promise.all((antes.imagensFeedback || []).filter(i => !ficam.has(i.caminho)).map(i => bucket().file(i.caminho).delete({ ignoreNotFound: true })));
    return novas;
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
// Para qual prova a questão foi feita (16/11/2026): 1ª chamada (padrão), 2ª chamada, exame, dependência, adaptação.
// As "a mais" (fora da prova que está sendo montada) ficam no banco da disciplina, separadas, e vão ao AVA na
// subcategoria do tipo de prova.
const USOS_PROVA = { c1: '1ª chamada', c2: '2ª chamada', exame: 'Exame semestral', dp: 'Dependência', adp: 'Adaptação' };
// "Prova: 2º bimestre – 2ª chamada" → { uso: 'c2', bimestre: 2 }; "Prova: Exame" → { uso: 'exame', bimestre: null }
function destinoDoTexto(t) {
    const s = normNome(t).toLowerCase();
    if (!s) return null;
    const mb = /\b([12])\s*(?:o\s*)?bim/.exec(s) || /\b(primeiro|segundo)\s+bim/.exec(s);
    const bimestre = mb ? (/^(1|primeiro)$/.test(mb[1]) ? 1 : 2) : null;
    if (/exame/.test(s)) return { uso: 'exame', bimestre: null };
    if (/depend|^dp$/.test(s)) return { uso: 'dp', bimestre };
    if (/adapta|^adp$/.test(s)) return { uso: 'adp', bimestre };
    if (/\b(2|segunda)\s*(?:a\s*)?ch/.test(s) || /^c2$/.test(s)) return { uso: 'c2', bimestre };
    if (/\b(1|primeira)\s*(?:a\s*)?ch/.test(s) || /^c1$/.test(s)) return { uso: 'c1', bimestre };
    return bimestre ? { uso: 'c1', bimestre } : null;
}
// a pasta da prova no AVA: "2º Bimestre/1ª chamada" ou "Exame"
const pastaProva = (av) => (av.tipo === 'exame' ? ['Exame semestral'] : [`${av.bimestre}º Bimestre`, `${av.chamada}ª chamada`]);
const usoDaAvaliacao = (av) => (av.tipo === 'exame' ? 'exame' : av.chamada === 2 ? 'c2' : 'c1');
function usoDoTexto(t) {
    const s = normNome(t).toLowerCase();
    if (!s) return '';
    if (/\b(2|segunda)\b.*chamada|^2a? ?ch|^c2$/.test(s)) return 'c2';
    if (/\b(1|primeira)\b.*chamada|^1a? ?ch|^c1$/.test(s)) return 'c1';
    if (/exame|^ex$/.test(s)) return 'exame';
    if (/depend|^dp$/.test(s)) return 'dp';
    if (/adapta|^adp$/.test(s)) return 'adp';
    return '';
}
function questaoDoBody(b, av) {
    const alternativas = (Array.isArray(b.alternativas) ? b.alternativas : []).slice(0, 6).map(a => ({
        texto: String(a.texto || '').trim(), correta: !!a.correta, feedback: String(a.feedback || '').trim()
    }));
    const q = {
        professorNome: String(b.professorNome || '').trim().slice(0, 120),
        objetivo: String(b.objetivo || '').trim().slice(0, 400),
        usoProva: USOS_PROVA[b.usoProva] ? b.usoProva : 'c1',
        ...([1, 2].includes(Number(b.bimestreDestino)) ? { bimestre: Number(b.bimestreDestino) } : (b.usoProva === 'exame' ? { bimestre: null } : {})),
        // 13/11/2026: o professor dá o nome da questão; o "Prof. Nome –" do título vem pronto (não é digitado)
        nomeQuestao: String(b.nomeQuestao || '').replace(/\s+/g, ' ').trim().slice(0, 160),
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
    q.titulo = Padrao.tituloPadrao(q.professorNome || 'a definir', av.sigla, q.nomeQuestao || q.objetivo || 'objetivo a definir');
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
    if (r.imagensFeedback && r.imagensFeedback.length) r.imagensFeedback = await comLinks(r.imagensFeedback);
    return r;
}
const erro = (res, e) => res.status(e.status || 500).json({ error: e.message });
// questão que nasceu nesta prova: ainda em montagem, ou publicada só pelo envio ao AVA e sem uso em prova finalizada (17/11/2026)
const apagavelDeVez = (q, av) => q.avaliacaoId === av.id && (q.status === 'rascunho_avaliacao' || (q.publicadaNoEnvio === true && !(q.usadaEm || []).length));
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
        bimestres: c.bimestres || {}, pesos: c.pesos || {}, limites: c.limites || {}, qtdQuestoes: c.qtdQuestoes || null, porProfessor: c.porProfessor || {},
        definidoPor: c.definidoPor || '', definidoEm: c.definidoEm || null,
        responsavel: c.responsavel || '', divisaoPor: c.divisaoPor || '', divisaoEm: c.divisaoEm || null
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
    const qtd = num(b.qtdQuestoes, 0, 300);
    const porProfessor = {};
    Object.entries(b.porProfessor || {}).forEach(([nome, n]) => { const k = String(nome).trim().slice(0, 120); const x = num(n, 0, 300); if (k && x) porProfessor[k] = x; });
    // professor responsável pela disciplina (16/11/2026): é quem divide as questões entre os colegas
    const responsavel = String(b.responsavel || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { bimestres, pesos, limites, qtdQuestoes: qtd || null, porProfessor, responsavel };
}

// ==========================================================================================
// ROTAS
// ==========================================================================================
router.get('/eu', (req, res) => res.json(req.prof
    ? { pode: true, editor: false, professor: { nome: req.prof.nome, chaves: [...req.prof.chaves], titulares: [...req.prof.titulares] } }
    : { pode: true, editor: true }));



// ---------- critérios da disciplina (só Ana / coordenação / ADM — o router inteiro já exige isso) ----------
router.get('/criterios/:chave', async (req, res) => {
    try {
        exigeDisc(req, req.params.chave);
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '2026.2';
        const [{ disciplinas }, crit] = await Promise.all([listaDisciplinas(semestre, { comTurmasEspeciais: true }), lerCriterios(req.params.chave)]);
        const d = disciplinas.find(x => x.chave === req.params.chave);
        const nome = d ? d.nome : (crit && crit.disciplina);
        if (!nome) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const plano = await planoDaDisciplina(semestre, nome);
        res.json({
            chave: req.params.chave, disciplina: nome, sigla: d ? d.sigla : (crit && crit.sigla), padrao: Padrao.CRITERIOS_PADRAO, professores: d ? d.professores : [], titulares: d ? d.titulares : [],
            unidades: plano.unidades || [], semestreFonte: plano.semestreFonte, planoEncontrado: !!plano.encontrado,
            criterios: resumoCriterios(crit)
        });
    } catch (e) { erro(res, e); }
});
router.put('/criterios/:chave', async (req, res) => {
    try {
        exigeEditorAv(req, 'definem os critérios. O titular divide as questões em "Divisão das questões"');
        const semestre = SEMESTRE.test(req.body.semestre || '') ? req.body.semestre : '2026.2';
        const { disciplinas } = await listaDisciplinas(semestre, { comTurmasEspeciais: true });
        const d = disciplinas.find(x => x.chave === req.params.chave);
        const c = limparCriterios(req.body);
        const ref = db.collection(COL_CRIT).doc(req.params.chave);
        await ref.set({
            ...c, ...(d ? { disciplina: d.nome, sigla: d.sigla } : {}), definidoPor: quem(req), definidoPorUid: req.user.uid, definidoEm: agora()
        }, { merge: true });
        await ref.update({ porProfessor: c.porProfessor });
        res.json({ message: 'Critérios salvos. As avaliações desta disciplina já usam estes critérios.', criterios: c });
    } catch (e) { erro(res, e); }
});

router.get('/disciplinas', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : null;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const [l, crits] = await Promise.all([listaDisciplinas(semestre, { comTurmasEspeciais: true }), todosCriterios()]);
        res.json({ ...l, disciplinas: l.disciplinas.filter(d => !req.prof || req.prof.chaves.has(d.chave)).map(d => { const c = crits.get(d.chave); return { ...d, criteriosDefinidos: !!(c && c.definidoEm), qtdQuestoes: (c && c.qtdQuestoes) || null, cotas: c && c.porProfessor ? Object.keys(c.porProfessor).length : 0 }; }) });
    } catch (e) { erro(res, e); }
});

router.get('/', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : null;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const snap = await db.collection(COL_AV).where('semestre', '==', semestre).get();
        const lista = snap.docs.map(d => { const x = d.data(); return { id: d.id, ...x, totalQuestoes: (x.questoesIds || []).length }; })
            .filter(a => !req.prof || req.prof.chaves.has(a.chave))
            .sort((a, b) => (a.periodo - b.periodo) || a.disciplina.localeCompare(b.disciplina) || a.bimestre - b.bimestre || a.chamada - b.chamada);
        res.json(lista);
    } catch (e) { erro(res, e); }
});

// Progresso da disciplina (13/11/2026): cada professor × cada prova do semestre — quantas fez da cota dele.
// Só quando a pessoa pede (lê as questões das provas daquela disciplina).
// chave das marcações do AVA por professor (16/11/2026)
const chaveEnvio = (nome) => normNome(nome).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
async function progressoDisciplina(chave, semestre) {
        const [{ disciplinas }, crit, snap] = await Promise.all([
            listaDisciplinas(semestre, { comTurmasEspeciais: true }), lerCriterios(chave),
            db.collection(COL_AV).where('chave', '==', chave).get()
        ]);
        const d = disciplinas.find(x => x.chave === chave);
        const avs = snap.docs.map(x => ({ id: x.id, ...x.data() })).filter(a => a.semestre === semestre)
            .sort((a, b) => a.bimestre - b.bimestre || a.chamada - b.chamada);
        const metas = (crit && crit.porProfessor) || {};
        const nomes = new Map();
        const addNome = (n) => { if (n && !nomes.has(normNome(n))) nomes.set(normNome(n), n); };
        Object.keys(metas).forEach(addNome);
        (d ? d.professores : []).forEach(addNome);
        // questões marcadas "2ª chamada" que estão no banco da disciplina (ainda fora de uma avaliação)
        const reservas = d && d.categoriaId ? (await db.collection(COL_Q).where('categoriaId', '==', d.categoriaId).where('usoProva', 'in', ['c2', 'exame']).get()).docs
            .map(x => ({ id: x.id, ...x.data() })).filter(q => q.status === 'publicada' && (!q.semestre || q.semestre === semestre)) : [];
        // toda prova pode ter 2ª chamada e exame: sem a avaliação criada, ganham coluna "no banco"
        avs.filter(a => a.tipo !== 'exame' && a.chamada !== 2 && !avs.some(x => x.tipo !== 'exame' && x.bimestre === a.bimestre && x.chamada === 2)).forEach(a => avs.push({ id: null, virtual: true, bimestre: a.bimestre, chamada: 2, status: 'banco', questoesIds: [] }));
        if (avs.length && !avs.some(a => a.tipo === 'exame')) avs.push({ id: null, virtual: true, tipo: 'exame', bimestre: 0, chamada: 0, status: 'banco', questoesIds: [] });
        const ordem = (a) => (a.tipo === 'exame' ? 99 : a.bimestre * 10 + a.chamada);
        avs.sort((a, b) => ordem(a) - ordem(b));
        const provas = await Promise.all(avs.map(async a => {
            const qs = await lerQuestoes(a.questoesIds || []);
            const porProf = {};
            let sem = 0;
            const ids = new Set(a.questoesIds || []);
            const extras = a.tipo === 'exame' ? reservas.filter(q => q.usoProva === 'exame' && !ids.has(q.id))
                : a.chamada === 2 ? reservas.filter(q => q.usoProva === 'c2' && !ids.has(q.id) && (!q.bimestre || q.bimestre === a.bimestre)) : [];
            [...qs, ...extras].forEach(q => { const n = q.professorNome || q.elaboradoPor; if (!n) { sem++; return; } addNome(n); porProf[normNome(n)] = (porProf[normNome(n)] || 0) + 1; });
            return { id: a.id, tipo: a.tipo || '', bimestre: a.bimestre, chamada: a.chamada, status: a.status, total: qs.length + extras.length, porProf, semProfessor: sem, envios: a.envios || {}, virtual: !!a.virtual };
        }));
        const metaDe = (k) => { const e = Object.entries(metas).find(([n]) => normNome(n) === k); return e ? Number(e[1]) : null; };
        const professores = [...nomes.entries()].map(([k, nome]) => ({ nome, meta: metaDe(k), feitas: provas.map(p => p.porProf[k] || 0),
            envios: provas.map(p => p.envios[chaveEnvio(nome)] || null) }))
            .sort((a, b) => (b.meta || 0) - (a.meta || 0) || a.nome.localeCompare(b.nome));
        return {
            disciplina: d ? d.nome : (crit && crit.disciplina) || chave, semestre, qtdQuestoes: (crit && crit.qtdQuestoes) || null,
            responsavel: (crit && crit.responsavel) || (d && d.titulares.length ? d.titulares.join(' / ') : ''), titulares: d ? d.titulares : [], provas: provas.map(({ porProf, envios, ...p }) => p), professores
        };
}
router.get('/progresso/:chave', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : null;
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        exigeTitularAv(req, req.params.chave, 'acompanha o progresso de todos');
        res.json(await progressoDisciplina(req.params.chave, semestre));
    } catch (e) { erro(res, e); }
});

router.post('/', async (req, res) => {
    try {
        const { semestre, chave } = req.body;
        const exame = req.body.tipo === 'exame';
        const bimestre = exame ? 0 : parseInt(req.body.bimestre, 10), chamada = exame ? 0 : parseInt(req.body.chamada, 10);
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Informe o semestre.' });
        if (!exame && (![1, 2].includes(bimestre) || ![1, 2].includes(chamada))) return res.status(400).json({ error: 'Escolha o bimestre e a chamada.' });
        const { disciplinas } = await listaDisciplinas(semestre, { comTurmasEspeciais: true });
        const d = disciplinas.find(x => x.chave === chave);
        if (!d) return res.status(400).json({ error: 'Escolha a disciplina.' });
        exigeDisc(req, d.chave);
        const id = exame ? `${semestre}__${d.chave}__exame` : `${semestre}__${d.chave}__b${bimestre}__c${chamada}`;
        const ref = db.collection(COL_AV).doc(id);
        if ((await ref.get()).exists) return res.status(409).json({ error: 'Essa avaliação já existe — abra pela lista.', id });
        await ref.set({
            semestre, chave: d.chave, disciplina: d.nome, sigla: d.sigla, periodo: d.periodo, categoriaId: d.categoriaId,
            bimestre, chamada, ...(exame ? { tipo: 'exame' } : {}), status: 'rascunho', questoesIds: [],
            criadoPor: req.user.uid, criadoPorNome: quem(req), createdAt: agora(), updatedAt: agora(), exportacoes: []
        });
        res.status(201).json({ id, message: 'Avaliação criada.' });
    } catch (e) { erro(res, e); }
});

// ---------- Envio ao AVA (25/11/2026) — tela da secretaria / coordenação ----------
// O professor termina no Órbita; o agente do droplet (scripts/ava-banco-med-agente.js) importa no banco do AVA o
// que a fila marca como pronto (src/utils/banco-med-ava-fila.js). Aqui a secretaria acompanha, pede "Enviar agora",
// baixa o arquivo do que está pronto (se precisar importar à mão) e registra "já está no AVA".
const FilaAva = require('../utils/banco-med-ava-fila');
const { pedirAoAgente, estadoDoAgente } = require('../utils/ava-pedidos');
const cfgAva = () => db.collection('config').doc('ava_banco_sync');
router.get('/envio-ava', async (req, res) => {
    try {
        exigeEditorAv(req, 'acompanham o envio ao AVA');
        const sem = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : FilaAva.semestreAtual();
        const [provas, agente] = await Promise.all([FilaAva.situacaoDoSemestre(sem), estadoDoAgente()]);
        res.json({ semestre: sem, agente, provas });
    } catch (e) { erro(res, e); }
});
router.post('/envio-ava/agora', async (req, res) => {
    try {
        exigeEditorAv(req, 'pedem o envio ao AVA');
        // 26/11/2026: com { id } é só aquela prova ("Enviar esta prova"); sem id, a conferência completa ("Conferir todas")
        const id = req.body && req.body.id ? String(req.body.id) : null;
        if (id) await lerAvaliacao(id);
        const p = await pedirAoAgente({ tipo: id ? 'envio' : 'tudo', alvo: id, por: quem(req) });
        res.json({ ...p, message: id ? (p.jaNaFila ? 'Esta prova já está na fila do AVA.' : `Pedido enviado: o Órbita confere esta prova no AVA${p.naFrente ? ` (${p.naFrente} pedido(s) na frente)` : ''}.`)
            : 'Pedido enviado: o Órbita confere todas as provas no AVA. Pode levar de 5 a 15 minutos.' });
    } catch (e) { erro(res, e); }
});
// "Colocar no questionário" (26/11/2026): o agente põe dentro do questionário as questões do Órbita que já estão
// na pasta da prova no banco do AVA e ainda não estão nele
router.post('/envio-ava/colocar', async (req, res) => {
    try {
        exigeEditorAv(req, 'colocam as questões no questionário do AVA');
        const id = req.body && req.body.id ? String(req.body.id) : '';
        if (!id) return res.status(400).json({ error: 'Informe a prova.' });
        await lerAvaliacao(id);
        const p = await pedirAoAgente({ tipo: 'colocar', alvo: id, por: quem(req) });
        res.json({ ...p, message: p.jaNaFila ? 'Esta prova já está na fila do AVA.' : `Pedido enviado: o Órbita coloca as questões dentro do questionário${p.naFrente ? ` (${p.naFrente} pedido(s) na frente)` : ''}.` });
    } catch (e) { erro(res, e); }
});
// dados para montar no navegador o XML só do que está pronto (igual ao /exportar; GIF grande não passa pelo servidor)
router.get('/envio-ava/:id/exportar', async (req, res) => {
    try {
        exigeEditorAv(req, 'baixam o arquivo do AVA');
        const av = await lerAvaliacao(req.params.id);
        const sit = await FilaAva.situacaoDaAvaliacao(av);
        if (!sit.prontas.length) return res.status(409).json({ error: 'Esta prova não tem questões prontas para o AVA agora.' });
        const pos = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        const questoes = (await lerQuestoes(sit.prontas)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
        const pasta = [av.disciplina, av.semestre, ...pastaProva(av)].map(x => String(x).replace(/\//g, '-')).join('/');
        const lista = await Promise.all(questoes.map(async q => ({
            id: q.id, numero: pos.get(q.id) + 1, titulo: q.titulo, tipoMoodle: q.tipoMoodle, casoClinico: q.casoClinico || '', pergunta: q.pergunta || '',
            enunciadoHtml: q.enunciadoHtml || '', alternativas: q.alternativas || [], justificativa: q.justificativa || '', fonte: q.fonte || '',
            dificuldade: q.dificuldade, elaboradoPor: q.elaboradoPor || q.professorNome || '',
            temImagemAntiga: !!(q.imagem && q.imagem.dataUrl) && !(q.imagens || []).length, imagemAntiga: (q.imagem && q.imagem.dataUrl && !(q.imagens || []).length) ? { nome: q.imagem.nome || 'imagem', dataUrl: q.imagem.dataUrl } : null,
            imagens: await comLinks(q.imagens, 30), imagensFeedback: await comLinks(q.imagensFeedback, 30), usoProva: q.usoProva || 'c1'
        })));
        const nome = `${av.sigla || av.disciplina} ${av.semestre} ${av.tipo === 'exame' ? 'exame' : `${av.bimestre}o bim ${av.chamada}a chamada`} - ${lista.length} questoes`.replace(/[^a-zA-Z0-9._ -]/g, '_');
        res.json({ pasta, nomeArquivo: `${nome}.xml`, prefixo: av.tipo === 'exame' ? 'EXAME' : `${av.bimestre}ºB ${av.chamada === 2 ? '2ª' : '1ª'}CH`, ids: sit.prontas, questoes: lista });
    } catch (e) { erro(res, e); }
});
// a secretaria registra que as questões prontas já estão no AVA (importou à mão, ou o "conferir" era isso mesmo)
router.post('/envio-ava/:id/marcar', async (req, res) => {
    try {
        exigeEditorAv(req, 'registram o envio ao AVA');
        const av = await lerAvaliacao(req.params.id);
        const sit = await FilaAva.situacaoDaAvaliacao(av);
        const pedidos = new Set(Array.isArray(req.body.ids) ? req.body.ids.map(String) : []);
        const ids = sit.prontas.filter(id => pedidos.has(id));
        if (!ids.length) return res.status(400).json({ error: 'Nada para marcar: as questões prontas mudaram. Recarregue a tela.' });
        const em = agora();
        await db.collection(COL_AV).doc(av.id).update({
            'avaBanco.enviadas': admin.firestore.FieldValue.arrayUnion(...ids), 'avaBanco.status': 'ok', 'avaBanco.em': em, 'avaBanco.por': quem(req), 'avaBanco.tentativa': null,
            'avaBanco.msg': `${ids.length} questão(ões) registrada(s) como já no AVA por ${quem(req)}`,
            'avaBanco.historico': admin.firestore.FieldValue.arrayUnion({ em, status: 'manual', qtd: ids.length, msg: 'registrado na tela Envio ao AVA', por: quem(req) })
        });
        await FilaAva.publicarNoBanco(ids, quem(req));
        res.json({ message: `${ids.length} questão(ões) registrada(s) como já no AVA.` });
    } catch (e) { erro(res, e); }
});

router.get('/:id', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        const [todasQ, planoEdubox, discs, crit] = await Promise.all([
            lerQuestoes(av.questoesIds),
            planoDaDisciplina(av.semestre, av.disciplina).catch(e => ({ erro: e.message, unidades: [], objetivos: [], referencias: [] })),
            listaDisciplinas(av.semestre, { comTurmasEspeciais: true }).catch(() => ({ disciplinas: [] })),
            lerCriterios(av.chave)
        ]);
        const questoes = visiveis(req, av, todasQ);
        const ordem = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        questoes.sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const d = discs.disciplinas.find(x => x.chave === av.chave);
        const resumo = await Promise.all(questoes.map(resumoComImagens));
        const plano = Padrao.aplicarCriterios(planoEdubox, crit);
        const papel = !req.prof ? 'editor' : (ehTitularAv(req, av.chave) ? 'titular' : 'adjunto');
        const meuEnvio = req.prof ? ((av.envios || {})[chaveEnvio(req.prof.nome)] || {}) : null;
        res.json({ avaliacao: av, papel, eu: req.prof ? req.prof.nome : null, meuEnvio, totalNaProva: todasQ.length, questoes: resumo, plano, professores: d ? d.professores : [], criterios: resumoCriterios(crit), analise: Padrao.analisarAvaliacao(resumo, plano, av.bimestre, crit) });
    } catch (e) { erro(res, e); }
});

router.delete('/:id', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeTitularAv(req, av.chave, 'exclui a prova');
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
async function linkEnvioImagem(body) {
    const mimeType = body && body.mimeType;
    const tamanho = Number(body && body.tamanho);
    const falha = (m) => { const e = new Error(m); e.status = 400; return e; };
    if (!TIPOS_IMG.includes(mimeType)) throw falha('Envie imagem PNG, JPG, GIF ou WEBP.');
    if (!(tamanho > 0) || tamanho > MAX_IMG) throw falha('Imagem muito grande (máx. 25 MB).');
    const caminho = `${PASTA_IMG}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nomeArquivo(body.nome)}`;
    const [url] = await bucket().file(caminho).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60000, contentType: mimeType });
    return { url, caminho };
}
router.post('/imagens/envio', async (req, res) => {
    try { res.json(await linkEnvioImagem(req.body)); } catch (e) { erro(res, e); }
});

// imagem antiga (comprimida, dentro do documento) — só quando o editor abre a questão
router.get('/:id/questoes/:qid/imagem-antiga', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        if (!(av.questoesIds || []).includes(req.params.qid)) return res.status(404).json({ error: 'Essa questão não está nesta avaliação.' });
        const s = await db.collection(COL_Q).doc(req.params.qid).get();
        if (s.exists && !visiveis(req, av, [{ id: s.id, ...s.data() }]).length) throw negar('Você mexe só nas suas questões.');
        const im = s.exists && s.data().imagem;
        res.json(im && im.dataUrl ? { nome: im.nome || 'imagem', dataUrl: im.dataUrl } : {});
    } catch (e) { erro(res, e); }
});

// dados pro Moodle XML montado no NAVEGADOR (GIF grande não passa pelo limite de resposta do servidor)
router.get('/:id/exportar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        // 16/11/2026: a responsável / coordenação / TI baixam a prova COMO ESTÁ (sem finalizar e sem padronizar),
        // para importar as questões do professor e subir no AVA sem alteração. Professor continua com a trava CADAM.
        const comoEsta = req.query.rascunho === '1' && !req.prof;
        if (av.status !== 'finalizada' && !comoEsta) return res.status(409).json({ error: 'Finalize a avaliação antes de baixar o arquivo do AVA.' });
        const questoes = visiveis(req, av, await lerQuestoes(av.questoesIds));
        const ordem = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        questoes.sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const pasta = [av.disciplina, av.semestre, ...pastaProva(av)].map(x => String(x).replace(/\//g, '-')).join('/');
        const lista = await Promise.all(questoes.map(async q => ({
            id: q.id, titulo: q.titulo, tipoMoodle: q.tipoMoodle, casoClinico: q.casoClinico || '', pergunta: q.pergunta || '',
            enunciadoHtml: q.enunciadoHtml || '', alternativas: q.alternativas || [], justificativa: q.justificativa || '', fonte: q.fonte || '',
            dificuldade: q.dificuldade, elaboradoPor: q.elaboradoPor || q.professorNome || '',
            temImagemAntiga: !!(q.imagem && q.imagem.dataUrl) && !(q.imagens || []).length, imagens: await comLinks(q.imagens, 30),
            imagensFeedback: await comLinks(q.imagensFeedback, 30), usoProva: q.usoProva || 'c1'
        })));
        await db.collection(COL_AV).doc(av.id).update({ exportacoes: admin.firestore.FieldValue.arrayUnion({ por: req.user.uid, porNome: quem(req), em: agora() }) });
        const nome = `${av.sigla || av.disciplina} ${av.semestre} ${av.tipo === 'exame' ? 'exame' : `${av.bimestre}o bim ${av.chamada}a chamada`}`.replace(/[^a-zA-Z0-9._ -]/g, '_');
        res.json({ pasta, nomeArquivo: `${nome}.xml`, questoes: lista });
    } catch (e) { erro(res, e); }
});

// nova questão escrita no modelo padrão
router.post('/:id/questoes', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        exigeRascunho(av);
        const q = questaoDoBody({ ...req.body, professorNome: professorDoBody(req, av, req.body.professorNome) }, av);
        if (q.enunciadoHtml.replace(/<[^>]+>/g, '').trim().length < 5) return res.status(400).json({ error: 'Escreva o caso clínico e a pergunta.' });
        q.imagens = await confirmarImagens(req.body.imagens);
        q.imagensFeedback = await imagensFeedbackDe(req.body, null);
        q.padrao = Padrao.avaliarQuestao(q);
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
        exigeDisc(req, av.chave);
        if (!(av.questoesIds || []).includes(req.params.qid)) return res.status(404).json({ error: 'Essa questão não está nesta avaliação.' });
        const ref = db.collection(COL_Q).doc(req.params.qid);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
        const antes = snap.data();
        if (!visiveis(req, av, [{ id: snap.id, ...antes }]).length) throw negar('Você mexe só nas suas questões. O titular da disciplina mexe em todas.');
        const q = questaoDoBody({ ...req.body, professorNome: professorDoBody(req, av, req.body.professorNome) }, av);
        if (!req.body.imagem && antes.imagem && req.body.manterImagem !== false) q.imagem = antes.imagem;
        q.imagens = req.body.imagens === undefined ? (antes.imagens || []) : await confirmarImagens(req.body.imagens);
        const ficam = new Set(q.imagens.map(i => i.caminho));
        await Promise.all((antes.imagens || []).filter(i => !ficam.has(i.caminho)).map(i => bucket().file(i.caminho).delete({ ignoreNotFound: true })));
        q.imagensFeedback = await imagensFeedbackDe(req.body, antes);
        q.padrao = Padrao.avaliarQuestao(q);
        await ref.update({
            ...q, elaboradoPor: q.professorNome || antes.elaboradoPor || quem(req),
            tituloBusca: q.titulo.toLowerCase(), tituloBuscaTokens: tokens(q.titulo, av.disciplina),
            padronizadaEm: q.padrao.ok ? agora() : null, padronizadaPor: q.padrao.ok ? quem(req) : null, updatedAt: agora(),
            // veio do AVA (Trazer do AVA): a alteração fica esperando o "Levar alterações para o AVA" (26/11/2026)
            ...(antes.avaOrigem && antes.avaOrigem.id ? { avaPendente: true, avaPendenteEm: agora(), avaPendentePor: quem(req) } : {})
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
        exigeDisc(req, av.chave);
        const ref = db.collection(COL_Q).doc(req.params.qid);
        const snap = await ref.get();
        if (snap.exists && !visiveis(req, av, [{ id: snap.id, ...snap.data() }]).length) throw negar('Você retira só as suas questões.');
        const batch = db.batch();
        if (snap.exists && apagavelDeVez(snap.data(), av)) batch.delete(ref);
        batch.update(db.collection(COL_AV).doc(av.id), { questoesIds: admin.firestore.FieldValue.arrayRemove(req.params.qid), updatedAt: agora() });
        await batch.commit();
        res.json({ message: 'Questão retirada da avaliação.' });
    } catch (e) { erro(res, e); }
});

// apagar várias questões de uma vez (16/11/2026): as escritas/importadas nesta prova são apagadas de vez;
// as que vieram do banco só saem da prova. Professor adjunto só apaga as próprias.
router.post('/:id/questoes/apagar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        exigeRascunho(av);
        const pedidas = new Set((Array.isArray(req.body.ids) ? req.body.ids : []).filter(id => (av.questoesIds || []).includes(id)));
        if (!pedidas.size) return res.status(400).json({ error: 'Selecione ao menos uma questão desta prova.' });
        const qs = await lerQuestoes([...pedidas]);
        const podem = visiveis(req, av, qs);
        if (podem.length < qs.length) throw negar('Você apaga só as suas questões. O titular da disciplina apaga as de todos.');
        const batch = db.batch();
        let apagadas = 0, retiradas = 0;
        podem.forEach(q => {
            if (apagavelDeVez(q, av)) { batch.delete(db.collection(COL_Q).doc(q.id)); apagadas++; } else retiradas++;
        });
        batch.update(db.collection(COL_AV).doc(av.id), { questoesIds: admin.firestore.FieldValue.arrayRemove(...podem.map(q => q.id)), updatedAt: agora() });
        await batch.commit();
        const partes = [apagadas ? `${apagadas} apagada(s)` : '', retiradas ? `${retiradas} retirada(s) da prova (continuam no banco)` : ''].filter(Boolean).join(' e ');
        res.json({ apagadas, retiradas, message: `Pronto: ${partes}.` });
    } catch (e) { erro(res, e); }
});

router.put('/:id/ordem', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeTitularAv(req, av.chave, 'muda a ordem da prova');
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
        exigeDisc(req, av.chave);
        if (!av.categoriaId) return res.json({ questoes: [], aviso: 'Esta disciplina ainda não tem categoria no banco.' });
        const snap = await db.collection(COL_Q).where('categoriaId', '==', av.categoriaId).where('status', '==', 'publicada').get();
        const ja = new Set(av.questoesIds || []);
        const questoes = visiveis(req, av, snap.docs.map(d => ({ id: d.id, ...d.data() }))).map(x => ({ data: () => x, id: x.id })).map(d => {
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
        exigeDisc(req, av.chave);
        const qs = visiveis(req, av, await lerQuestoes(ids));
        const validas = qs.filter(q => q.categoriaId === av.categoriaId && q.status === 'publicada').map(q => q.id);
        if (!validas.length) return res.status(400).json({ error: 'Nenhuma dessas questões é do banco desta disciplina.' });
        await db.collection(COL_AV).doc(av.id).update({ questoesIds: admin.firestore.FieldValue.arrayUnion(...validas), updatedAt: agora() });
        res.json({ adicionadas: validas.length, message: `${validas.length} questão(ões) adicionada(s). As que estão fora do padrão precisam ser padronizadas antes de finalizar.` });
    } catch (e) { erro(res, e); }
});

// repetidas (16/11/2026): mesma questão no arquivo, na prova ou no banco da disciplina neste semestre
// (sem diferenciar maiúscula/minúscula, acento e pontuação). chaves = Padrao.chaveComparar do enunciado de cada questão.
const chaveImportada = (x) => Padrao.chaveComparar(x.casoHtml !== undefined || x.pergunta ? `${x.casoHtml || ''} ${x.pergunta || ''}` : (x.enunciado || ''));
async function marcarRepetidas(av, chaves) {
    const ja = new Map();
    const pos = new Map((av.questoesIds || []).map((id, i) => [id, i + 1]));
    (await lerQuestoes(av.questoesIds || [])).forEach(q => { const k = Padrao.chaveComparar(q.enunciadoHtml); if (k) ja.set(k, `já está nesta prova (questão ${pos.get(q.id)})`); });
    if (av.categoriaId) {
        const banco = await db.collection(COL_Q).where('categoriaId', '==', av.categoriaId).where('semestre', '==', av.semestre).get();
        banco.docs.forEach(d => { const k = Padrao.chaveComparar(d.data().enunciadoHtml); if (k && !ja.has(k)) ja.set(k, 'já está no banco da disciplina neste semestre'); });
    }
    const noArquivo = new Map();
    return chaves.map((k, i) => {
        if (!k) return null;
        if (ja.has(k)) return ja.get(k);
        if (noArquivo.has(k)) return `repete a questão ${noArquivo.get(k)} deste arquivo`;
        noArquivo.set(k, i + 1); return null;
    });
}
// o Word é lido no navegador: ele manda só as chaves para conferir as repetidas
router.post('/:id/importar/repetidas', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        const chaves = (Array.isArray(req.body.chaves) ? req.body.chaves : []).slice(0, 200).map(k => String(k || '').slice(0, 4000));
        res.json({ repetidas: await marcarRepetidas(av, chaves) });
    } catch (e) { erro(res, e); }
});

// ---------- trazer do AVA para validar (26/11/2026) ----------
// Prova que o professor montou direto no AVA, sem passar pelo Órbita. O pedido acorda o agente do droplet
// (config/ava_banco_sync.pedidoEm, escutado ao vivo); ele exporta o banco do questionário em Moodle-XML e guarda
// em banco-med/ava-trazer/<id>.xml. A tela baixa pelo link assinado, mostra a prévia e importa pelo /importar.
router.post('/:id/ava-trazer', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        exigeRascunho(av);
        const agoraIso = agora();
        await db.collection(COL_AV).doc(av.id).set({ avaTrazer: { status: 'pedido', pedidoEm: agoraIso, pedidoPor: quem(req) } }, { merge: true });
        await pedirAoAgente({ tipo: 'trazer', alvo: av.id, por: quem(req) });
        res.json({ message: 'Pedido enviado: o Órbita busca as questões no AVA em instantes.' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.get('/:id/ava-trazer', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        const t = av.avaTrazer || null;
        let url = null;
        if (t && t.status === 'pronto' && t.arquivo && t.arquivo.startsWith('banco-med/ava-trazer/')) {
            [url] = await bucket().file(t.arquivo).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 15 * 60000 });
        }
        res.json({ ...(t || { status: null }), url });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- levar para o AVA as alterações das questões trazidas de lá (26/11/2026) ----------
// Questão com avaOrigem alterada no Órbita fica avaPendente. O pedido acorda o agente, que abre o editor de cada uma
// no AVA, troca enunciado, alternativas, correta e feedback (mantém as imagens que já estavam lá) e salva. O AVA
// guarda como versão nova da questão: quem já fez a prova continua com a versão antiga.
router.post('/:id/ava-levar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        const pend = (await lerQuestoes(av.questoesIds || [])).filter(q => q.avaPendente && q.avaOrigem && q.avaOrigem.id);
        if (!pend.length) return res.status(400).json({ error: 'Nenhuma questão alterada esperando ir para o AVA.' });
        const agoraIso = agora();
        await db.collection(COL_AV).doc(av.id).set({ avaLevar: { status: 'pedido', pedidoEm: agoraIso, pedidoPor: quem(req), total: pend.length } }, { merge: true });
        await pedirAoAgente({ tipo: 'levar', alvo: av.id, por: quem(req) });
        res.json({ message: `Pedido enviado: ${pend.length} questão(ões) vão ser alteradas no AVA em instantes.`, total: pend.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.get('/:id/ava-levar', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        res.json(av.avaLevar || { status: null });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// importar de Word / PDF / texto colado → só a PRÉVIA (nada é salvo aqui)
router.post('/:id/importar/analisar', async (req, res) => {
    try {
        const avImp = await lerAvaliacao(req.params.id);
        exigeDisc(req, avImp.chave);
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
        // questões sem número, abertas por "NÍVEL DE DIFICULDADE:" (16/11/2026): numera 1, 2, 3… e já lê correta, justificativa e referência
        const ehPdf = nome.endsWith('.pdf') || (req.body.arquivoBase64 && Buffer.from(req.body.arquivoBase64.slice(0, 8), 'base64').toString().startsWith('%PDF'));
        const questoes = Padrao.ehFormatoNivel(linhas)
            ? Padrao.lerPorNivel(linhas, { pdf: ehPdf || !req.body.arquivoBase64 })
            : lerQuestoesDeLinhas(linhas.flatMap(ParseLinhas.expandirLinhaConcatenada));
        if (!questoes.length) return res.status(400).json({ error: 'Não encontrei questões objetivas. As questões precisam estar numeradas ("Questão 1", "1.", "2)") ou começar em "NÍVEL DE DIFICULDADE:", com as alternativas A), B), C), D).' });
        const rep = await marcarRepetidas(avImp, questoes.map(chaveImportada));
        rep.forEach((r, i) => { if (r) questoes[i].repetida = r; });
        const nRep = rep.filter(Boolean).length;
        res.json({ questoes, aviso: nRep ? `${nRep} questão(ões) repetida(s): veja a marca em cada uma.` : '' });
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
        exigeDisc(req, av.chave);
        const comuns = { professorNome: professorDoBody(req, av, req.body.professorNome), unidade: req.body.unidade, dificuldade: req.body.dificuldade };
        const batch = db.batch();
        const ids = [];
        const imagensPorQuestao = await Promise.all(lista.map(x => confirmarImagens(x.imagens)));
        const imagensFeedbackPorQuestao = await Promise.all(lista.map(x => confirmarImagens(x.imagensFeedback)));
        const aMais = {};
        // modelo de prova da Medicina (13/11/2026): o arquivo já traz caso, pergunta, feedback, referência, dificuldade
        // e o tema da linha de título. O tema sugere a unidade e o objetivo do plano de ensino.
        const plano = lista.some(x => x.tema || x.unidadeWord || x.objetivoWord) ? await planoDaDisciplina(av.semestre, av.disciplina).catch(() => null) : null;
        // modelo por disciplina (16/11/2026): "Unidade: 3" e "Objetivo: O2" (ou o texto do objetivo) escritos pelo professor
        const unidadeDoWord = (v) => { const n = parseInt(String(v || '').replace(/\D+/g, ' ').trim(), 10); return n && plano && (plano.unidades || []).some(u => u.numero === n) ? n : (n || null); };
        const objetivoDoWord = (v) => {
            const t = String(v || '').trim(); if (!t || !plano) return null;
            const m = /^o?\s*(\d{1,2})\b/i.exec(t);
            const objs = plano.objetivos || [];
            if (m && objs[Number(m[1]) - 1]) return objs[Number(m[1]) - 1];
            return objs.find(o => normNome(o) === normNome(t)) || null;
        };
        const palavras = (t) => normNome(t).toLowerCase().split(' ').filter(w => w.length >= 4);
        const pelaTema = (tema, itens, texto) => {
            const ws = palavras(tema); if (!ws.length || !itens.length) return null;
            const nota = (it) => ws.filter(w => normNome(texto(it)).toLowerCase().includes(w)).length;
            const melhor = itens.map(it => ({ it, n: nota(it) })).sort((a, b) => b.n - a.n)[0];
            return melhor && melhor.n >= Math.ceil(ws.length / 2) ? melhor.it : null;
        };
        lista.forEach((x, ix) => {
            const letra = String(x.gabarito || '').toUpperCase();
            const doModelo = !!(x.casoHtml !== undefined || x.pergunta);
            const unid = x.tema && plano ? pelaTema(x.tema, (plano.unidades || []).filter(u => u.bimestre === av.bimestre).concat((plano.unidades || []).filter(u => u.bimestre !== av.bimestre)), u => `${u.titulo} ${u.conteudo}`) : null;
            const obj = x.tema && plano ? pelaTema(x.tema, plano.objetivos || [], o => o) : null;
            const q = questaoDoBody({
                ...comuns,
                dificuldade: x.dificuldade || comuns.dificuldade,
                unidade: unidadeDoWord(x.unidadeWord) || comuns.unidade || (unid && unid.numero) || '',
                objetivo: objetivoDoWord(x.objetivoWord) || obj || x.tema || '',
                nomeQuestao: String(x.tema || '').slice(0, 160),
                casoClinico: doModelo ? String(x.casoHtml || '') : String(x.enunciado || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'),
                pergunta: doModelo ? String(x.pergunta || '') : '',
                alternativas: (x.alternativas || []).map((t, i) => ({ texto: String(t || ''), correta: Padrao.LETRAS[i] === letra })),
                justificativa: doModelo ? String(x.justificativa || '') : '',
                fonte: doModelo ? String(x.fonte || '').slice(0, 600) : ''
            }, av);
            q.imagensFeedback = imagensFeedbackPorQuestao[ix];
            const dest = destinoDoTexto(x.provaWord);
            const usoDaProva = usoDaAvaliacao(av);
            q.usoProva = dest ? dest.uso : usoDaProva;
            const bimQ = q.usoProva === 'exame' ? null : ((dest && dest.bimestre) || av.bimestre || null);
            q.padrao = Padrao.avaliarQuestao(q);
            const ref = db.collection(COL_Q).doc();
            const naProva = q.usoProva === usoDaProva && (usoDaProva === 'exame' || !bimQ || bimQ === av.bimestre);
            const rotA = q.usoProva === 'exame' ? 'Exame semestral' : `${bimQ ? `${bimQ}º bimestre – ` : ''}${USOS_PROVA[q.usoProva]}`;
            if (naProva) ids.push(ref.id); else { aMais[rotA] = (aMais[rotA] || 0) + 1; }
            batch.set(ref, {
                ...q, imagens: imagensPorQuestao[ix], ...(naProva ? { status: 'rascunho_avaliacao', avaliacaoId: av.id } : { status: 'publicada', reservaDe: av.id }), importada: true,
                // Trazer do AVA (26/11/2026): questão que já existe no AVA — o "Levar alterações para o AVA" edita esta
                ...(Number(x.avaId) > 0 ? { avaOrigem: { id: Number(x.avaId), cmid: Number(x.avaCmid) || null, nome: String(x.nomeAva || '').slice(0, 300) } } : {}),
                categoriaId: av.categoriaId, periodo: av.periodo, semestre: av.semestre, bimestre: naProva ? av.bimestre : bimQ, chamada: av.chamada, sigla: av.sigla,
                areaEnamed: (cat && cat.areaEnamedPadrao) || classificarAreaEnamed(q.titulo, q.enunciadoHtml, ''),
                tituloBusca: q.titulo.toLowerCase(), tituloBuscaTokens: tokens(q.titulo, av.disciplina),
                elaboradoPor: q.professorNome || quem(req), criadoPor: req.user.uid, criadoPorNome: quem(req), createdAt: agora(), updatedAt: agora()
            });
        });
        if (ids.length) batch.update(db.collection(COL_AV).doc(av.id), { questoesIds: admin.firestore.FieldValue.arrayUnion(...ids), updatedAt: agora() });
        await batch.commit();
        const extras = Object.entries(aMais).map(([k, n]) => `${n} de ${k}`).join(', ');
        res.status(201).json({ criadas: ids.length, aMais, message: `${ids.length} questão(ões) na prova.${extras ? ` Foram para o banco da disciplina, separadas: ${extras}.` : ''} Confira no checklist o que falta em cada uma.` });
    } catch (e) { erro(res, e); }
});

// "Corrigir tudo" de português e ABNT (16/11/2026): aplica de uma vez as correções que o revisor sabe fazer sozinho
// (revisao-pt.js — as mesmas do editor) na questão salva. Não mexe na correta nem em nada além do texto;
// os avisos sem correção automática (ex.: referência sem ano) continuam para a pessoa resolver.
const RV = require('../../banco-med-fatec/revisao-pt.js');
function corrigirHtmlPt(html, opts) {
    let k = 0;
    return String(html || '').split(/(<[^>]+>)/).map(seg => {
        if (!seg || seg[0] === '<' || !seg.trim()) return seg;
        // &nbsp; (espaço do Word) conta como espaço: senão ".&nbsp;O" parece "falta espaço depois do ponto"
        return RV.corrigirTudo(seg.replace(/&nbsp;/g, ' '), { ...(opts || {}), maiuscula: k++ === 0 }).replace(/ /g, '&nbsp;');
    }).join('')
        // espaço antes da pontuação que fica entre uma marcação e o ponto: "(DSM-5-TR)</em> ." → "(DSM-5-TR)</em>."
        .replace(/([^\s>])((?:<\/?(?:em|strong|b|i|u|span|sup|sub)\b[^>]*>)*)(?:\s|&nbsp;)+([.,;:!?])(?=\s|<|&nbsp;|$)/g, '$1$2$3');
}
function corrigirFonte(f) { let v = String(f || ''); for (let i = 0; i < 3; i++) { const a = RV.abnt(v).filter(x => x.para); if (!a.length) break; v = RV.aplicarTodos(v, a); } return v; }
function questaoCorrigidaPt(q) {
    const upd = {};
    const temPartes = !!(q.casoClinico || q.pergunta);
    if (temPartes) {
        const caso = corrigirHtmlPt(q.casoClinico || ''), perg = q.pergunta ? RV.corrigirTudo(String(q.pergunta), { pergunta: true }) : '';
        if (caso !== (q.casoClinico || '')) upd.casoClinico = caso;
        if (perg !== (q.pergunta || '')) upd.pergunta = perg;
        if (upd.casoClinico !== undefined || upd.pergunta !== undefined) upd.enunciadoHtml = montarEnunciado(caso, perg);
    } else if (q.enunciadoHtml) {
        const e = corrigirHtmlPt(q.enunciadoHtml); if (e !== q.enunciadoHtml) upd.enunciadoHtml = e;
    }
    const alts = (q.alternativas || []).map(a => ({ ...a, texto: RV.corrigirTudo(String(a.texto || '')) }));
    if (alts.some((a, i) => a.texto !== (q.alternativas[i].texto || ''))) upd.alternativas = alts;
    const just = corrigirHtmlPt(q.justificativa || ''); if (just !== (q.justificativa || '')) upd.justificativa = just;
    const fonte = corrigirFonte(q.fonte); if (q.fonte && fonte !== q.fonte) upd.fonte = fonte;
    if (!Object.keys(upd).length) return null;
    upd.padrao = Padrao.avaliarQuestao({ ...q, ...upd });
    return upd;
}
async function corrigirPtNaProva(req, av, ids) {
    const qs = visiveis(req, av, await lerQuestoes(ids));
    let n = 0; const batch = db.batch();
    qs.forEach(q => { const cv = correcaoVisivel(q); if (!cv) return; n++; batch.update(db.collection(COL_Q).doc(q.id), { ...cv.upd, corrigidaPtEm: agora(), corrigidaPtPor: quem(req), updatedAt: agora() }); });
    if (n) await batch.commit();
    return n;
}
// o que cada correção muda, campo a campo (achados com correção antes que não existem mais depois)
const txt = (h) => Padrao.texto(h);
function mudancasPt(q, upd) {
    const campos = [];
    const comparar = (campo, antes, depois, achar, k) => {
        if (antes === depois) return;
        const chave = (a) => `${a.de}→${a.para}`;
        const fica = new Map(); achar(depois).filter(a => a.para).forEach(a => fica.set(chave(a), (fica.get(chave(a)) || 0) + 1));
        const mud = [];
        achar(antes).filter(a => a.para).forEach(a => { const k = chave(a); if (fica.get(k)) fica.set(k, fica.get(k) - 1); else mud.push({ de: a.de, para: a.para, motivo: a.motivo }); });
        // mudança que não aparece na prévia não entra (correcaoVisivel desfaz o campo)
        if (mud.length) campos.push({ campo, k, mudancas: mud });
    };
    const ach = (t) => RV.achar(t), achP = (t) => RV.achar(t, { pergunta: true });
    if (q.casoClinico || q.pergunta) {
        comparar('Caso clínico', txt(q.casoClinico), txt(upd.casoClinico !== undefined ? upd.casoClinico : q.casoClinico), ach, 'caso');
        comparar('Pergunta', String(q.pergunta || ''), String(upd.pergunta !== undefined ? upd.pergunta : q.pergunta || ''), achP, 'perg');
    } else comparar('Enunciado', txt(q.enunciadoHtml), txt(upd.enunciadoHtml !== undefined ? upd.enunciadoHtml : q.enunciadoHtml), ach, 'enun');
    (q.alternativas || []).forEach((a, i) => comparar(`Alternativa ${Padrao.LETRAS[i]}`, String(a.texto || ''), String(upd.alternativas ? upd.alternativas[i].texto : a.texto || ''), ach, 'alt' + i));
    comparar('Feedback', txt(q.justificativa), txt(upd.justificativa !== undefined ? upd.justificativa : q.justificativa), ach, 'fb');
    comparar('Referência', String(q.fonte || ''), String(upd.fonte !== undefined ? upd.fonte : q.fonte || ''), (t) => RV.abnt(t), 'ref');
    return campos;
}
// só o que aparece na prévia é aplicado (16/11/2026): campo que mudaria sem mostrar nada fica como estava
function correcaoVisivel(q) {
    const upd = questaoCorrigidaPt(q); if (!upd) return null;
    const campos = mudancasPt(q, upd); if (!campos.length) return null;
    const k = new Set(campos.map(c => c.k)), f = {};
    if (k.has('caso')) f.casoClinico = upd.casoClinico;
    if (k.has('perg')) f.pergunta = upd.pergunta;
    if (k.has('caso') || k.has('perg')) f.enunciadoHtml = montarEnunciado(f.casoClinico !== undefined ? f.casoClinico : q.casoClinico, f.pergunta !== undefined ? f.pergunta : q.pergunta);
    if (k.has('enun')) f.enunciadoHtml = upd.enunciadoHtml;
    if ((q.alternativas || []).some((a, i) => k.has('alt' + i))) f.alternativas = q.alternativas.map((a, i) => (k.has('alt' + i) ? upd.alternativas[i] : a));
    if (k.has('fb')) f.justificativa = upd.justificativa;
    if (k.has('ref')) f.fonte = upd.fonte;
    f.padrao = Padrao.avaliarQuestao({ ...q, ...f });
    // veio do AVA: a correção também precisa ser levada para lá (26/11/2026)
    if (q.avaOrigem && q.avaOrigem.id) { f.avaPendente = true; f.avaPendenteEm = new Date().toISOString(); }
    return { upd: f, campos };
}
router.post('/:id/corrigir-pt/previa', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave); exigeRascunho(av);
        const so = Array.isArray(req.body.ids) && req.body.ids.length ? new Set(req.body.ids) : null;
        const pos = new Map((av.questoesIds || []).map((id, i) => [id, i + 1]));
        const qs = visiveis(req, av, await lerQuestoes((av.questoesIds || []).filter(id => !so || so.has(id))));
        const itens = qs.map(q => { const cv = correcaoVisivel(q); return cv ? { id: q.id, numero: pos.get(q.id), professor: q.professorNome || '', campos: cv.campos } : null; })
            .filter(Boolean).sort((a, b) => a.numero - b.numero);
        res.json({ itens });
    } catch (e) { erro(res, e); }
});
router.post('/:id/corrigir-pt', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave); exigeRascunho(av);
        // só as questões que a pessoa conferiu na prévia e deixou marcadas
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(id => (av.questoesIds || []).includes(id));
        if (!ids.length) return res.status(400).json({ error: 'Marque ao menos uma questão na prévia.' });
        const n = await corrigirPtNaProva(req, av, ids);
        res.json({ corrigidas: n, message: n ? `Português e ABNT corrigidos em ${n} questão(ões). O que precisa de decisão continua apontado.` : 'Não havia correção automática para fazer.' });
    } catch (e) { erro(res, e); }
});

router.post('/:id/finalizar', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeTitularAv(req, av.chave, 'finaliza a prova');
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
        // 25/11/2026: a prova finalizada entra na fila de importação do banco do AVA (scripts/banco-med-ava-fila.js)
        res.json({ message: `Avaliação finalizada: ${questoes.length} questões no banco de ${av.disciplina}. Ela vai para o banco de questões do AVA na próxima importação do Suporte AVA.` });
    } catch (e) { erro(res, e); }
});

router.post('/:id/reabrir', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        // o titular também reabre a prova da disciplina dele (16/11/2026): o professor corrige sem depender de ninguém
        exigeTitularAv(req, av.chave, 'reabre a prova');
        await db.collection(COL_AV).doc(av.id).update({ status: 'rascunho', reabertaEm: agora(), reabertaPor: quem(req), updatedAt: agora() });
        res.json({ message: 'Avaliação reaberta para ajustes.' });
    } catch (e) { erro(res, e); }
});

// Moodle XML com a pasta Disciplina / semestre / bimestre / chamada
router.get('/:id/xml', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        if (av.status !== 'finalizada') return res.status(409).json({ error: 'Finalize a avaliação antes de baixar o arquivo do AVA.' });
        const questoes = visiveis(req, av, await lerQuestoes(av.questoesIds));
        const ordem = new Map((av.questoesIds || []).map((id, i) => [id, i]));
        questoes.sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const pasta = [av.disciplina, av.semestre, ...pastaProva(av)].map(s => String(s).replace(/\//g, '-')).join('/');
        const xml = gerarMoodleXml(pasta, questoes, { semTagAutor: false });
        await db.collection(COL_AV).doc(av.id).update({ exportacoes: admin.firestore.FieldValue.arrayUnion({ por: req.user.uid, porNome: quem(req), em: agora() }) });
        const nome = `${av.sigla || av.disciplina} ${av.semestre} ${av.tipo === 'exame' ? 'exame' : `${av.bimestre}o bim ${av.chamada}a chamada`}`.replace(/[^a-zA-Z0-9._ -]/g, '_');
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nome}.xml"`);
        res.send(xml);
    } catch (e) { erro(res, e); }
});



// ---------- modelo de questões em Word, por disciplina (16/11/2026) ----------
// Sai com as unidades do bimestre e os objetivos do plano de ensino (Edubox), numerados, para o professor
// preencher "Unidade:" e "Objetivo:" em cada questão antes de mandar o arquivo para importar.
// Monta o Word. Usado pela avaliação (Bia/coordenação) e pelo Banco (o professor baixa o da disciplina dele).
// bimestres fechados (fim de 2026.2): o modelo não oferece o 1º bimestre. No próximo semestre: [].
const BIMESTRES_FECHADOS = [1];
async function montarModeloDocx({ disciplina, sigla, semestre, bimestre, chamada, professor, plano, prova }) {
    if (bimestre && BIMESTRES_FECHADOS.includes(bimestre)) bimestre = [1, 2].find(b => !BIMESTRES_FECHADOS.includes(b)) || bimestre;
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle } = require('docx');
    const AZUL = '0052B8', LARANJA = 'B45309';
    const n = (text, o = {}) => new TextRun({ text, font: 'Arial', size: 22, ...o });
    const P = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { after: 100 }, ...o });
    const B = (t) => P(n(t, { bold: true }));
    const caixa = (t, o = {}) => new Paragraph({ children: Array.isArray(t) ? t : [n(t, { size: 20, color: '1F3A5F', ...o })], spacing: { after: 50 }, shading: { type: ShadingType.CLEAR, fill: 'EAF1FB', color: 'auto' }, indent: { left: 200, right: 200 } });
    const alerta = (runs) => new Paragraph({ children: runs, spacing: { before: 120, after: 120 }, shading: { type: ShadingType.CLEAR, fill: 'FFF4E0', color: 'auto' }, indent: { left: 200, right: 200 },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: LARANJA, space: 8 } } });
    const cel = (t, o = {}) => new TableCell({ children: [new Paragraph({ children: [n(t, { size: 20, ...o })] })], shading: o.fundo ? { type: ShadingType.CLEAR, fill: o.fundo, color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 } });
    const tabela = (cab, linhas, larg) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: larg, rows: [
        new TableRow({ tableHeader: true, children: cab.map(c => cel(c, { bold: true, color: 'FFFFFF', fundo: AZUL })) }),
        ...linhas.map(l => new TableRow({ children: l.map((c, i) => cel(c, i === 0 ? { bold: true, color: AZUL } : {})) }))] });
    const doBim = ((plano && plano.unidades) || []).filter(u => !bimestre || u.bimestre === bimestre);
    const unidades = doBim.length ? doBim : ((plano && plano.unidades) || []);
    const objetivos = (plano && plano.objetivos) || [];
    const exemploU = unidades[0] ? String(unidades[0].numero) : '1';
    // prova deste arquivo: "Exame semestral" ou "2º bimestre – 1ª chamada" (sem chamada, o professor escreve)
    const provaDoArquivo = prova || (bimestre && chamada ? `${bimestre}º bimestre – ${chamada}ª chamada` : '');
    const filhos = [
        // CABEÇALHO (16/11/2026): o mais claro possível — de que disciplina e de qual prova é este arquivo e onde importar
        new Paragraph({ children: [n('MODELO DE QUESTÕES – ' + disciplina, { bold: true, size: 30, color: AZUL })], spacing: { after: 80 } }),
        tabela(['Este arquivo', ''], [
            ['Disciplina', disciplina],
            ['Semestre', String(semestre || '')],
            ['Prova', provaDoArquivo || 'escreva aqui a prova: 2º bimestre – 1ª chamada, 2º bimestre – 2ª chamada ou Exame semestral'],
            ['Professor(a)', professor || '(seu nome)'],
            ['Onde importar', `Órbita → Banco MED → aba Avaliações → ${disciplina} → ${provaDoArquivo || 'a prova'} → "Importar Word"`]
        ], [2200, 7100]),
        alerta([
            n('UM ARQUIVO PARA CADA PROVA. ', { bold: true, color: LARANJA }),
            n(`Este arquivo é só da prova "${provaDoArquivo || 'indicada acima'}". Para as outras provas (1ª chamada, 2ª chamada, Exame semestral), baixe o modelo de cada uma e importe na própria prova.`, { size: 21 })
        ]),
        alerta([
            n('OS OBJETIVOS SÃO OBRIGATÓRIOS. ', { bold: true, color: LARANJA }),
            n('Cada questão avalia UM objetivo do plano de ensino (tabela "Objetivos", mais abaixo). Na linha "Objetivo:" copie o código E o texto (ex.: O2 – Identificar e manejar…). ', { size: 21 }),
            n('Questão sem objetivo do plano, ou com conteúdo fora dele, não entra na prova.', { bold: true, size: 21 })
        ]),
        new Paragraph({ children: [n('COMO PREENCHER CADA QUESTÃO (este cabeçalho e as tabelas podem ficar: o Órbita só lê a partir de "Questão 01")', { bold: true, size: 20, color: AZUL })], shading: { type: ShadingType.CLEAR, fill: 'EAF1FB', color: 'auto' }, indent: { left: 200, right: 200 }, spacing: { before: 120, after: 50 } }),
        caixa('1. "Questão 01", "Questão 02"… — uma linha para começar cada questão.'),
        caixa('2. Título: Tema – Dificuldade (Fácil, Intermediária ou Difícil).'),
        caixa('3. "Unidade:" o NÚMERO da unidade (tabela "Unidades"). Use só unidades desta prova.'),
        caixa('4. "Objetivo:" o CÓDIGO e o TEXTO do objetivo, copiados da tabela (ex.: O2 – Identificar e manejar…). Um objetivo por questão.'),
        caixa(`5. "Prova:" ${provaDoArquivo ? `deixe "${provaDoArquivo}" (a prova deste arquivo).` : 'a prova deste arquivo (2º bimestre – 1ª chamada, 2º bimestre – 2ª chamada ou Exame semestral).'}`),
        caixa('6. "Enunciado" e, embaixo: imagem (se houver), o caso clínico e por último a pergunta terminando em "?" ou ":".'),
        caixa('7. Quatro alternativas, uma por linha, começando com A), B), C) e D). Pinte a CORRETA com marca-texto AMARELO. Sem "todas/nenhuma das alternativas" e sem enunciado negativo.'),
        caixa('8. "Feedback da Questão": por que a correta é a correta — texto, imagem (gráfico, tabela, figura) ou os dois.'),
        caixa('9. "Referência Bibliográfica" em ABNT: SOBRENOME, Nome. Título. Edição. Local: Editora, ano.'),
        new Paragraph({ children: [n(`Objetivos do plano de ensino — escolha um por questão`, { bold: true, color: AZUL, size: 24 })], spacing: { before: 260, after: 80 } }),
        objetivos.length ? tabela(['Código', 'Objetivo de aprendizagem'], objetivos.map((o, i) => [`O${i + 1}`, String(o)]), [1100, 8200]) : P(n('O plano de ensino desta disciplina não tem objetivos cadastrados no Edubox: fale com a coordenação antes de montar as questões.', { italics: true, color: LARANJA })),
        new Paragraph({ children: [n(`Unidades do plano de ensino${doBim.length && bimestre ? ` (${bimestre}º bimestre)` : ''}`, { bold: true, color: AZUL, size: 24 })], spacing: { before: 240, after: 80 } }),
        unidades.length ? tabela(['Nº', 'Unidade'], unidades.map(u => [String(u.numero), String(u.titulo || '')]), [1100, 8200]) : P(n('O plano de ensino desta disciplina não foi encontrado no Edubox: escreva o número da unidade combinado com a coordenação.', { italics: true })),
        new Paragraph({ children: [], spacing: { after: 240 } }),
        B('Questão 01'),
        B('Tema da questão – Intermediária'),
        P([n('Unidade: ', { bold: true }), n(exemploU)]),
        P([n('Objetivo: ', { bold: true }), n(objetivos.length ? `O1 – ${objetivos[0]}` : 'objetivo por extenso')]),
        P([n('Prova: ', { bold: true }), n(provaDoArquivo || `${bimestre || 2}º bimestre – 1ª chamada`)]),
        B('Enunciado'),
        P(n('(cole aqui a imagem, se houver)', { italics: true, color: '777777' })),
        P(n('Caso clínico: paciente, idade, queixa, história e achados do exame.')),
        P(n('Pergunta direta terminando com ponto de interrogação?')),
        // alternativas com a letra (16/11/2026): fica mais claro para o professor; a importação tira a letra e usa o amarelo
        P(n('A) Alternativa')),
        P(n('B) Alternativa correta — pintada de amarelo', { highlight: 'yellow' })),
        P(n('C) Alternativa')),
        P(n('D) Alternativa')),
        B('Feedback da Questão'),
        P(n('Explique por que a alternativa correta é a correta (ou cole aqui o gráfico/figura).')),
        B('Referência Bibliográfica'),
        P(n('SOBRENOME, Nome. Título. 8. ed. Cidade: Editora, ano.'))
    ];
    const doc = new Document({ creator: 'Órbita · Fatec Ivaiporã', title: `Modelo de questões — ${disciplina}`, sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children: filhos }] });
    const buf = await Packer.toBuffer(doc);
    const nome = `modelo-questoes-${sigla || disciplina}-${semestre}${bimestre ? `-${bimestre}bim` : ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-') + '.docx';
    return { buf, nome };
}
function enviarDocx(res, { buf, nome }) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(buf);
}
// ---------- modelo de questões em Word, por disciplina (16/11/2026) ----------
// Sai com os objetivos e as unidades do bimestre do plano de ensino (Edubox), numerados, para o professor
// preencher "Unidade:" e "Objetivo:" em cada questão antes de mandar o arquivo para importar.
router.get('/:id/modelo', async (req, res) => {
    try {
        const av = await lerAvaliacao(req.params.id);
        exigeDisc(req, av.chave);
        const plano = Padrao.aplicarCriterios(await planoDaDisciplina(av.semestre, av.disciplina).catch(() => ({ unidades: [], objetivos: [] })), (await lerCriterios(av.chave).catch(() => null)) || {});
        enviarDocx(res, await montarModeloDocx({ disciplina: av.disciplina, sigla: av.sigla, semestre: av.semestre, bimestre: av.bimestre, chamada: av.chamada, plano, prova: av.tipo === 'exame' ? 'Exame semestral' : '' }));
    } catch (e) { erro(res, e); }
});

router._interno = { nomeBaseDisciplina, turmaEspecialDo, USOS_PROVA, usoDoTexto, destinoDoTexto, pastaProva, usoDaAvaliacao, chaveEnvio, progressoDisciplina, lerCriterios, limparCriterios, COL_CRIT, montarModeloDocx, enviarDocx, planoDaDisciplina, listaDisciplinas, itens, referencias, lerQuestoesDeLinhas, questaoDoBody, confirmarImagens, comLinks, linkEnvioImagem, resumoComImagens, tokens, normNome, bucket };
router._ptCorrigir = { questaoCorrigidaPt, corrigirHtmlPt, mudancasPt, correcaoVisivel };
module.exports = router;
