import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';

// ==========================================================================
// Matrizes e Horários. As matrizes vêm do Edubox (sincronizadas por
// scripts/matrizes-edubox-sync.js). O coordenador define professor/dia/hora
// das disciplinas do próprio curso; ADM (N1/N2) e RH veem todos os cursos.
// Quem vê o quê é decidido no backend (src/rotas/matrizes.js) — a tela só
// mostra o que a API devolve.
// Tudo que initApp usa de forma síncrona fica declarado aqui em cima (o
// initApp roda antes do fim do arquivo quando há login em cache).
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'matrizes';
const NIVEL_PADRAO = { adm_l2: 3, rh: 3, coordenador: 3 };
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DIA_LONGO = { seg: 'Segunda-feira', ter: 'Terça-feira', qua: 'Quarta-feira', qui: 'Quinta-feira', sex: 'Sexta-feira', sab: 'Sábado' };
const DIA_CURTO = { seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb' };
// Horário padrão da Fatec: aula presencial 19:30–22:30; EAD em blocos de 1 h.
const PRESETS = [
  { rotulo: 'Presencial 19:30–22:30', ini: '19:30', fim: '22:30' },
  { rotulo: 'EAD 19:30–20:30', ini: '19:30', fim: '20:30' },
  { rotulo: 'EAD 20:30–21:30', ini: '20:30', fim: '21:30' },
  { rotulo: 'EAD 21:30–22:30', ini: '21:30', fim: '22:30' }
];

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;
let podeEditar = false;

let dados = null;          // resposta de GET /matrizes
let cursoSel = '';         // id do doc (semestre__cursoId)
let abaSel = 'semestre';
let emEdicao = null;       // { turma, disc } aberto no modal
let cmpA = '', cmpB = '';  // comparação de matrizes (códigos de grade)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try { return await apiFetch(endpoint); } catch (err) {
      if (i === tentativas) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

let toastTimer;
function toast(msg, tipo = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `mz-toast ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), tipo === 'aviso' ? 9000 : 3500);
}

// ---------- AUTH ----------
const cached = getCachedAuth();
if (cached) {
  currentUser = cached.user;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '../auth/login.html';
    return;
  }
  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante';
    let meuOverrides = null;
    try {
      const userData = await apiFetchComRetentativa('/usuarios/me');
      role = userData.role || 'visitante';
      meuOverrides = userData.permissoes || null;
      currentUserNome = userData.name || user.displayName || '';
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }
    setCachedAuth(user, role, token);
    let level = 2;
    if (role === 'adm_l1') level = 3;
    else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        const doCargo = perms[role] || {};
        const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
      } catch (e) { level = NIVEL_PADRAO[role] || 1; }
    }
    if (level < 2) { window.location.href = '../meu-espaco/index.html'; return; }
    podeEditar = level >= 3;
    if (!appInitialized || initializedRole !== role) {
      initializedRole = role;
      initApp(user, role);
    }
    if (!dados) carregar();
  } catch (err) {
    console.error('Erro na revalidação de auth:', err);
  }
});

function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;
  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });
  $('app').classList.remove('hidden');
  wireEventos();
}

// ---------- DADOS ----------
async function carregar(semestre) {
  try {
    await auth.authStateReady();
    if (auth.currentUser) currentUser = auth.currentUser;
    dados = await apiFetch('/matrizes' + (semestre ? `?semestre=${encodeURIComponent(semestre)}` : ''));
    if (!dados.cursos.some(c => c.id === cursoSel)) cursoSel = dados.cursos[0] ? dados.cursos[0].id : '';
    $('lista-professores').innerHTML = dados.professores.map(p => `<option value="${esc(p)}">`).join('');
    $('lista-salas').innerHTML = (dados.salas || []).map(x => `<option value="${esc(x)}">`).join('');
    renderTudo();
  } catch (err) {
    $('subtitulo').textContent = '';
    mostrarVazio(`Não foi possível carregar: ${esc(err.message)}`);
  }
}

const cursoAtual = () => dados && dados.cursos.find(c => c.id === cursoSel);
const chave = (t, d) => `${t.codTurma}:${d.codDisciplina}`;
const aulasDe = (c, t, d) => ((c.alocacoes[chave(t, d)] || {}).aulas) || [];
const fmtAula = (a) => `${DIA_CURTO[a.dia]} ${a.inicio}–${a.fim}`;
// sala: número puro vira "Sala 4"; nomes (M.A. 2, LAB INFORMATICA 12...) ficam como estão
const salaTxt = (s) => (/^\d+$/.test(String(s).trim()) ? `Sala ${String(s).trim()}` : String(s));
const TIPO_DIA = { ead: 'EAD', protegida: 'Protegida', sincrona: 'Síncrona', estagio: 'Estágio', vazio: '—', outro: '—' };
// quadro do ensalamento do grupo: por dia, a sala ou o que acontece (EAD, carga horária protegida...)
function faixaEnsalamento(c, g) {
  const e = (c.ensalamento || []).find(x => (x.periodos || []).some(p => g.periodos.includes(p)));
  if (!e) return '';
  const cel = ['seg', 'ter', 'qua', 'qui', 'sex'].map(d => {
    const x = (e.dias || {})[d] || { tipo: 'vazio' };
    const pres = x.tipo === 'presencial' && x.sala;
    return `<div class="mz-ens-dia ${pres ? 'pres' : ''}"><small>${DIA_CURTO[d]}</small><b>${esc(pres ? salaTxt(x.sala) : (TIPO_DIA[x.tipo] || '—'))}</b></div>`;
  }).join('');
  return `<div class="mz-ens" title="Ensalamento 2026.2"><span class="mz-ens-t">Ensalamento${e.alunos ? ` · ${e.alunos} alunos` : ''}</span>${cel}</div>`;
}

// ---------- MATRIZ ROTATIVA: GRUPOS DE TURMAS ----------
// Quem entra no meio do ano estuda junto com a turma do período seguinte, e no ano seguinte segue a própria
// matriz. No Edubox isso aparece como turmas diferentes com as mesmas disciplinas. A Fatec trata as duas
// como uma turma só ("Agronomia 1 e 2 – 2026/2"), então a tela também. Nos tecnólogos (e no Agronegócio)
// todos os períodos estudam as mesmas disciplinas: um grupo só, com todos os períodos.
const STOP = new Set(['e', 'de', 'da', 'do', 'das', 'dos', 'em', 'a', 'o', 'as', 'os', 'para', 'na', 'no', 'nas', 'nos', 'ao', 'aos', 'com']);
const tokensDe = (s) => norm(s).split(' ').filter(x => x && !STOP.has(x));
// O Edubox escreve a mesma disciplina de formas diferentes entre matrizes ("Estágio II"/"Estágio III",
// "Solo"/"Solos", "Projeto Integrador Extensionista I"/"em Gestão Ambiental"): compara sem numeração e
// tolerando plural e erro de digitação.
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const tokIgual = (x, y) => x === y
  || (Math.min(x.length, y.length) >= 4 && (x + 's' === y || y + 's' === x))
  || (Math.min(x.length, y.length) >= 6 && lev(x, y) <= (Math.max(x.length, y.length) >= 10 ? 2 : 1));
const NUMERAL = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|\d{1,2})$/;
function baseTokens(nome) {
  const t = tokensDe(nome);
  if (t.length > 1 && NUMERAL.test(t[t.length - 1])) t.pop();
  return t;
}
function mesmaDisc(a, b) {
  const A = baseTokens(a.nome), B = baseTokens(b.nome);
  if (!A.length || !B.length) return false;
  // Projeto Integrador muda de nome a cada período ("PIE I", "PIE em ..."): basta o início igual
  if (A.slice(0, 3).join(' ') === 'projeto integrador extensionista' && B.slice(0, 3).join(' ') === 'projeto integrador extensionista') return true;
  const usados = new Set();
  let i = 0;
  for (const x of A) {
    const j = B.findIndex((y, k) => !usados.has(k) && tokIgual(x, y));
    if (j >= 0) { usados.add(j); i++; }
  }
  return i / Math.max(A.length, B.length) >= 0.8;
}

// Exibição: o Edubox manda tudo em MAIÚSCULAS; mostra em formato de título, mantendo siglas e numerais romanos
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'as', 'os', 'para', 'na', 'no', 'nas', 'nos', 'ao', 'aos', 'com', 'à']);
const SIGLAS = new Set(['EAD', 'TCC', 'PIE', 'DP', 'ADP', 'LIBRAS', 'UTI', 'CH']);
function nomeBonito(s) {
  return String(s || '').toLowerCase().split(/(\s+|[-–:/()])/).map((p, i) => {
    if (!p || /^\s+$/.test(p) || /^[-–:/()]$/.test(p)) return p;
    const u = p.toUpperCase();
    if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/.test(u) || SIGLAS.has(u)) return u;
    if (i > 0 && MINUSCULAS.has(p)) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join('');
}
const ehDP = (t) => /^A?DP\b/i.test(t.nome);   // turmas de dependência ficam sozinhas

function montarLinhas(turmas) {
  const linhas = [];
  for (const t of turmas) for (const d of t.disciplinas) {
    let l = linhas.find(x => !x.porTurma[t.codTurma] && !!x.d.naoOfertada === !!d.naoOfertada && mesmaDisc(x.d, d));
    if (!l) { l = { d, porTurma: {} }; linhas.push(l); }
    l.porTurma[t.codTurma] = d;
  }
  return linhas.sort((a, b) => a.d.nome.localeCompare(b.d.nome, 'pt-BR'));
}

function numerosPeriodos(ps) {
  const u = [...new Set(ps)].sort((a, b) => a - b);
  if (u.length === 1) return `${u[0]}`;
  const seguidos = u.every((v, i) => i === 0 || v === u[i - 1] + 1);
  if (u.length >= 3 && seguidos) return `${u[0]} ao ${u[u.length - 1]}`;
  return u.length === 2 ? `${u[0]} e ${u[1]}` : `${u.slice(0, -1).join(', ')} e ${u[u.length - 1]}`;
}
const tituloCaso = (s) => s.toLowerCase().replace(/(^|\s)([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E|Em)\b/g, x => x.toLowerCase());
const cursoCurto = (c) => tituloCaso(c.cursoNome.replace(/^(BACHARELADO|LICENCIATURA|SUPERIOR DE TECNOLOGIA) EM /i, '').replace(/ - FORMAÇÃO.*/i, '').trim());

function grupos(c) {
  if (c._grupos) return c._grupos;
  const regulares = c.turmas.filter(t => !ehDP(t)).sort((a, b) => a.periodo - b.periodo);
  const dps = c.turmas.filter(ehDP);
  let blocos;
  if (/SUPERIOR DE TECNOLOGIA/i.test(c.cursoNome)) blocos = regulares.length ? [regulares] : [];
  else {
    const sets = regulares.map(t => t.disciplinas.filter(d => !d.naoOfertada));
    const pai = regulares.map((_, i) => i);
    const raiz = (i) => (pai[i] === i ? i : (pai[i] = raiz(pai[i])));
    // 1) o que os arquivos de horário dizem (c.grupos, ex.: [[1,2],[3,4],[5]]): períodos listados juntos estudam juntos
    const citados = new Set((c.grupos || []).flat());   // períodos que algum arquivo menciona
    (c.grupos || []).filter(g => g.length > 1).forEach(g => {
      const idx = regulares.map((t, i) => (g.includes(t.periodo) ? i : -1)).filter(i => i >= 0);
      idx.forEach(i => { pai[raiz(i)] = raiz(idx[0]); });
    });
    // 2) onde o arquivo não diz (ex.: PDF fala do "2º período" e o Edubox tem o 1º com as mesmas disciplinas):
    //    a matriz rotativa funciona em PARES de períodos vizinhos (1 e 2, 3 e 4... ou, em outros semestres,
    //    2 e 3, 4 e 5...: quem entrou no mesmo ano). Cada turma entra em no máximo um par (nunca encadeia
    //    "1 ao 3"); no empate, prefere 1 e 2 / 3 e 4.
    const emPar = new Set();
    const tamanho = new Map();
    regulares.forEach((_, i) => tamanho.set(raiz(i), (tamanho.get(raiz(i)) || 0) + 1));
    regulares.forEach((_, i) => { if (tamanho.get(raiz(i)) > 1) emPar.add(i); });   // já unidas pelo arquivo
    const arestas = [];
    regulares.forEach((a, i) => {
      const j = regulares.findIndex(t => t.periodo === a.periodo + 1);
      if (j < 0) return;
      if (citados.has(a.periodo) && citados.has(regulares[j].periodo)) return;   // o arquivo trata os dois explicitamente
      const livres = new Set();
      let inter = 0;
      sets[i].forEach(x => { const k = sets[j].findIndex((y, n) => !livres.has(n) && mesmaDisc(x, y)); if (k >= 0) { livres.add(k); inter++; } });
      const menor = Math.min(sets[i].length, sets[j].length);
      const score = menor >= 2 ? inter / menor : 0;
      if (score >= 0.6) arestas.push({ i, j, score, impar: a.periodo % 2 === 1, p: a.periodo });
    });
    arestas.sort((x, y) => y.score - x.score || Number(y.impar) - Number(x.impar) || x.p - y.p);
    arestas.forEach(e => {
      if (emPar.has(e.i) || emPar.has(e.j)) return;
      pai[raiz(e.j)] = raiz(e.i);
      emPar.add(e.i); emPar.add(e.j);
    });
    const por = new Map();
    regulares.forEach((t, i) => { const r = raiz(i); (por.get(r) || por.set(r, []).get(r)).push(t); });
    blocos = [...por.values()];
  }
  dps.forEach(t => blocos.push([t]));
  c._grupos = blocos.map(ts => {
    const periodos = [...new Set(ts.map(t => t.periodo))].sort((a, b) => a - b);
    return { turmas: ts, periodos, linhas: montarLinhas(ts), dp: ts.length === 1 && ehDP(ts[0]) };
  }).sort((a, b) => a.periodos[0] - b.periodos[0] || Number(a.dp) - Number(b.dp));
  return c._grupos;
}
function rotuloPeriodos(ps) {
  const n = numerosPeriodos(ps);
  return ps.length === 1 ? `${n}º período` : `${n.replace(/(\d+)/g, '$1º')} períodos`;
}
const tituloGrupo = (c, g) => g.dp
  ? `${g.turmas[0].nome}`
  : `${cursoCurto(c)} ${numerosPeriodos(g.periodos)} – ${dados.semestre.replace('.', '/')}`;
const aulasLinha = (c, g, l) => {
  for (const t of g.turmas) { const d = l.porTurma[t.codTurma]; if (d) { const a = aulasDe(c, t, d); if (a.length) return a; } }
  return [];
};

function mostrarVazio(html) {
  $('conteudo-curso').classList.add('hidden');
  $('vazio').classList.remove('hidden');
  $('vazio').innerHTML = html;
}

// ---------- RENDER ----------
function renderTudo() {
  const semestres = dados.semestres;
  $('sel-semestre').innerHTML = semestres.map(s => `<option value="${s}" ${s === dados.semestre ? 'selected' : ''}>${s.replace('.', '/')}</option>`).join('');
  $('subtitulo').textContent = dados.escopo === 'todos'
    ? 'Todos os cursos. O que cada turma estuda no semestre (vem do Edubox) e o horário de aula de cada curso.'
    : 'Seus cursos. Defina professor, dia e hora das disciplinas — o horário de aula do curso sai daqui.';

  if (!dados.cursos.length) {
    $('kpis').innerHTML = '';
    $('cursos').innerHTML = '';
    mostrarVazio(dados.escopo === 'todos'
      ? 'Nenhuma matriz sincronizada para este semestre ainda.'
      : 'Nenhum curso vinculado ao seu cadastro neste semestre. Peça à TI para vincular seus cursos em Usuários.');
    return;
  }
  $('vazio').classList.add('hidden');
  $('conteudo-curso').classList.remove('hidden');
  renderKpis();
  renderCursos();
  renderAbas();
}

function resumo(c) {
  let disc = 0, comHorario = 0, conferir = 0, ch = 0;
  const gs = grupos(c);
  gs.forEach(g => {
    conferir += g.turmas.filter(t => t.situacao === 'conferir').length;
    g.linhas.forEach(l => {
      if (l.d.naoOfertada) return;
      disc++; ch += l.d.ch.total;
      if (aulasLinha(c, g, l).length) comHorario++;
    });
  });
  return { disc, comHorario, conferir, ch, grupos: gs.length, turmas: c.turmas.length, matrizes: c.grades.length };
}

function renderKpis() {
  const c = cursoAtual();
  const r = resumo(c);
  const pct = r.disc ? Math.round(r.comHorario / r.disc * 100) : 0;
  const ult = dados.atualizadoEm ? new Date(dados.atualizadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  $('kpis').innerHTML = `
    <div class="mz-kpi"><b>${r.grupos}</b><span>${r.grupos === 1 ? 'turma' : 'turmas'} em ${esc(dados.semestre.replace('.', '/'))} <small title="Turmas que estudam juntas (matriz rotativa) contam como uma">(${r.turmas} no Edubox)</small></span></div>
    <div class="mz-kpi"><b>${r.matrizes}</b><span>${r.matrizes === 1 ? 'matriz em uso' : 'matrizes em uso'}</span></div>
    <div class="mz-kpi"><b>${r.disc}</b><span>disciplinas no semestre</span></div>
    <div class="mz-kpi"><b>${pct}%</b><span>com horário definido (${r.comHorario}/${r.disc})</span><div class="mz-barra"><i style="width:${pct}%"></i></div></div>
    <div class="mz-kpi ${r.conferir ? 'alerta' : ''}"><b>${r.conferir}</b><span>turma(s) p/ conferir no Edubox</span></div>
    <div class="mz-kpi"><b style="font-size:15px">${esc(ult)}</b><span>última carga do Edubox</span></div>`;
}

function renderCursos() {
  $('cursos').innerHTML = dados.cursos.map(c => {
    const r = resumo(c);
    return `<button type="button" class="mz-curso ${c.id === cursoSel ? 'ativo' : ''}" data-curso="${esc(c.id)}" role="tab" aria-selected="${c.id === cursoSel}">${esc(c.cursoNome.replace(/^(BACHARELADO|LICENCIATURA|SUPERIOR DE TECNOLOGIA) EM /i, '').replace(/ - FORMAÇÃO.*/i, ''))}<small>${r.comHorario}/${r.disc}</small></button>`;
  }).join('');
}

function renderAbas() {
  document.querySelectorAll('.mz-aba').forEach(b => b.classList.toggle('ativa', b.dataset.aba === abaSel));
  ['semestre', 'matrizes', 'horario', 'carga'].forEach(a => $(`painel-${a}`).classList.toggle('ativo', a === abaSel));
  if (abaSel === 'semestre') renderSemestre();
  else if (abaSel === 'matrizes') renderMatrizes();
  else if (abaSel === 'horario') renderHorario();
  else renderCarga();
}

const COLS_CH = '<col class="c-tipo"><col class="c-ch"><col class="c-ch"><col class="c-ch"><col class="c-ch"><col class="c-ch"><col class="c-ch">';
const COLGROUP = `<colgroup><col>${COLS_CH}</colgroup>`;
const COLGROUP_HOR = `<colgroup><col>${COLS_CH}<col class="c-hor"><col class="c-acao"></colgroup>`;
const CH_COLUNAS = `<th class="num">Teór.</th><th class="num">Prát.</th><th class="num">EAD</th><th class="num" title="Síncrona mediada">Sínc.</th><th class="num">Ext.</th><th class="num">Total</th>`;
const chCelulas = (d) => `<td class="num">${d.ch.teorica || '–'}</td><td class="num">${d.ch.pratica || '–'}</td><td class="num">${d.ch.ead || '–'}</td><td class="num">${d.ch.sincrona || '–'}</td><td class="num">${d.ch.extensao || '–'}</td><td class="num"><b>${d.ch.total}</b></td>`;
// "Síncrona mediada": disciplina a distância com aula ao vivo (CH em chosmedis no Edubox)
const ehSincrona = (d) => (d.ch.sincrona || 0) > 0;
const modalidade = (d) => (ehSincrona(d) ? 'Síncrona mediada' : (/dist/i.test(d.tipo) ? 'EAD' : 'Presencial'));
const tagTipo = (d) => `<span class="mz-tag ${ehSincrona(d) ? 'sinc' : (/dist/i.test(d.tipo) ? 'ead' : '')}">${esc(ehSincrona(d) ? 'Síncrona mediada' : d.tipo)}</span>`;

// ---- Aba 1: semestre por turma
function renderSemestre() {
  const c = cursoAtual();
  const nMat = c.grades.length;
  let html = `<div class="mz-info">${nMat > 1 ? `Este curso tem <b>${nMat} matrizes rodando ao mesmo tempo</b>. ` : ''}Cada turma continua com a <b>própria matriz</b> (etiquetas abaixo). Turmas que <b>estudam juntas</b> (matriz rotativa) aparecem num bloco só, e o horário definido vale para todas elas.</div>`;
  html += grupos(c).map((g, gi) => {
    const avisos = g.turmas.filter(t => t.situacao === 'conferir').map(t => {
      const nFora = t.disciplinas.filter(d => d.foraDaMatriz).length;
      const nNao = t.disciplinas.filter(d => d.naoOfertada).length;
      return `<div class="mz-aviso"><b>Conferir no Edubox — ${esc(t.nome)}:</b> ${nFora ? `${nFora} disciplina(s) lançada(s) que não são do ${t.periodo}º período da matriz “${esc(t.grade)}”` : ''}${nFora && nNao ? '; ' : ''}${nNao ? `${nNao} disciplina(s) do ${t.periodo}º período dessa matriz que não foram lançadas na turma` : ''}.</div>`;
    }).join('');
    const linhas = g.linhas.map((l, li) => {
      const d = l.d;
      const aulas = aulasLinha(c, g, l);
      const marca = d.foraDaMatriz ? '<span class="mz-tag conferir">fora da matriz</span>' : d.naoOfertada ? '<span class="mz-tag conferir">não lançada</span>' : '';
      const nomes = [...new Set(Object.values(l.porTurma).map(x => x.nome))];
      const dica = nomes.length > 1 ? ` title="No Edubox: ${esc(nomes.join(' | '))}"` : '';
      const horario = d.naoOfertada ? '<span class="mz-sem">—</span>'
        : (aulas.length ? `<div class="mz-aulas">${aulas.map(a => `<div class="mz-aula"><b>${esc(a.professor)}</b><span>${esc(DIA_LONGO[a.dia])} · ${esc(a.inicio)}–${esc(a.fim)}${a.sala ? ` · ${esc(salaTxt(a.sala))}` : ''}</span></div>`).join('')}</div>` : '<span class="mz-sem">sem horário</span>');
      const acao = (podeEditar && !d.naoOfertada)
        ? `<button type="button" class="mz-btn mz-btn-sec mz-btn-mini" data-editar="${gi}|${li}">${aulas.length ? 'Editar' : 'Definir'}</button>` : '';
      return `<tr class="${marca ? 'marcada' : ''}"><td class="disc"${dica}>${esc(nomeBonito(d.nome))} ${marca}</td><td>${tagTipo(d)}</td>${chCelulas(d)}<td>${horario}</td><td>${acao}</td></tr>`;
    }).join('');
    const tags = g.turmas.map(t => `<span class="mz-tag matriz" title="Matriz que o Edubox vincula à turma ${esc(t.nome)}">${t.periodo}º · matriz ${esc(t.grade || '—')}</span>`).join(' ');
    const ok = g.turmas.every(t => t.situacao === 'ok');
    return `<div class="mz-card">
      <div class="mz-card-topo"><div><h3>${esc(tituloGrupo(c, g))}</h3>
        <span class="mz-meta">${g.dp ? 'Turma de dependência' : `${esc(rotuloPeriodos(g.periodos))} · ${g.turmas.length > 1 ? 'estudam juntas: ' : ''}${esc(g.turmas.map(t => t.nome).join('  +  '))}`}</span></div>
        <div class="mz-tags">${tags} <span class="mz-tag ${ok ? 'ok' : 'conferir'}">${ok ? 'confere' : 'conferir'}</span></div></div>
      ${g.dp ? '' : faixaEnsalamento(c, g)}
      ${avisos}
      <div class="mz-tabela-wrap"><table class="mz-tabela">${COLGROUP_HOR}<thead><tr><th>Disciplina</th><th>Tipo</th>${CH_COLUNAS}<th>Professor e horário</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    </div>`;
  }).join('');
  $('painel-semestre').innerHTML = html;
}

// ---- Aba 2: matrizes em uso
function renderMatrizes() {
  const c = cursoAtual();
  const grades = c.grades;
  if (!cmpA || !grades.some(g => String(g.codGrade) === cmpA)) cmpA = grades[0] ? String(grades[0].codGrade) : '';
  if (!cmpB || !grades.some(g => String(g.codGrade) === cmpB) || cmpB === cmpA) {
    const outra = grades.find(g => String(g.codGrade) !== cmpA);
    cmpB = outra ? String(outra.codGrade) : '';
  }

  const cartoes = grades.map(g => {
    const seguem = c.turmas.filter(t => t.codGrade === g.codGrade);
    const periodos = g.periodos.map(p => `
      <h4 class="mz-matriz-per">${p.periodo}º período <span>(${p.disciplinas.length} disciplinas · ${p.disciplinas.reduce((s, d) => s + d.ch.total, 0)} h)</span></h4>
      <div class="mz-tabela-wrap"><table class="mz-tabela">${COLGROUP}<thead><tr><th>Disciplina</th><th>Tipo</th>${CH_COLUNAS}</tr></thead><tbody>
        ${p.disciplinas.map(d => `<tr><td class="disc">${esc(nomeBonito(d.nome))}</td><td>${tagTipo(d)}</td>${chCelulas(d)}</tr>`).join('')}
      </tbody></table></div>`).join('');
    return `<details class="mz-card">
      <summary class="mz-card-topo" style="cursor:pointer"><h3>${esc(g.nome)}</h3>
        <span class="mz-meta">${g.chTotal ? g.chTotal + ' h · ' : ''}${seguem.length ? 'seguida por: ' + seguem.map(t => `${t.periodo}º per. (${esc(t.nome)})`).join(', ') : 'nenhuma turma deste semestre'}</span></summary>
      ${periodos || '<p class="mz-aviso">Sem disciplinas cadastradas nesta matriz.</p>'}
    </details>`;
  }).join('');

  let comparacao = '';
  if (grades.length > 1) {
    const opts = (sel) => grades.map(g => `<option value="${g.codGrade}" ${String(g.codGrade) === sel ? 'selected' : ''}>${esc(g.nome)}</option>`).join('');
    comparacao = `<div class="mz-card"><div class="mz-card-topo"><h3>Comparar duas matrizes do curso</h3><span class="mz-meta">mostra o que muda disciplina a disciplina, período a período</span></div>
      <div class="mz-comparar">
        <label class="mz-campo">Matriz A<select id="cmp-a">${opts(cmpA)}</select></label>
        <label class="mz-campo">Matriz B<select id="cmp-b">${opts(cmpB)}</select></label>
      </div>${tabelaComparacao(c)}</div>`;
  }
  $('painel-matrizes').innerHTML = comparacao + `<p class="mz-sem" style="margin:0 0 10px">Clique numa matriz para ver todos os períodos e as disciplinas.</p>` + cartoes;
}

function tabelaComparacao(c) {
  const A = c.grades.find(g => String(g.codGrade) === cmpA);
  const B = c.grades.find(g => String(g.codGrade) === cmpB);
  if (!A || !B) return '';
  const periodos = [...new Set([...A.periodos.map(p => p.periodo), ...B.periodos.map(p => p.periodo)])].sort((x, y) => x - y);
  const nomesDe = (g, per) => { const p = g.periodos.find(x => x.periodo === per); return p ? p.disciplinas.map(d => d.nome) : []; };
  let igual = 0;
  const linhas = periodos.map(per => {
    const a = nomesDe(A, per), b = nomesDe(B, per);
    const setA = new Set(a.map(norm)), setB = new Set(b.map(norm));
    const soA = a.filter(n => !setB.has(norm(n))), soB = b.filter(n => !setA.has(norm(n)));
    igual += a.length - soA.length;
    if (!soA.length && !soB.length) return `<tr><td>${per}º</td><td colspan="2"><span class="mz-tag ok">igual (${a.length} disciplinas)</span></td></tr>`;
    return `<tr><td>${per}º</td>
      <td>${soA.length ? `<ul class="so">${soA.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<span class="mz-sem">—</span>'}</td>
      <td>${soB.length ? `<ul class="so">${soB.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<span class="mz-sem">—</span>'}</td></tr>`;
  }).join('');
  return `<div class="mz-tabela-wrap"><table class="mz-tabela"><thead><tr><th>Período</th><th>Só na matriz A</th><th>Só na matriz B</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
}

// ---- Aba 3: relatório padronizado
function renderHorario() {
  const c = cursoAtual();
  const emissao = new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  const ordem = (a) => DIAS.indexOf(a.dia) * 10000 + parseInt(a.inicio.replace(':', ''), 10);
  let semHorario = 0;
  const blocos = grupos(c).map(g => {
    const linhas = [];
    const pendentes = [];
    g.linhas.filter(l => !l.d.naoOfertada).forEach(l => {
      const d = l.d;
      const aulas = aulasLinha(c, g, l);
      if (!aulas.length) { pendentes.push(d); return; }
      aulas.forEach(a => linhas.push({ a, d }));
    });
    semHorario += pendentes.length;
    linhas.sort((x, y) => ordem(x.a) - ordem(y.a));
    const corpo = linhas.map(({ a, d }) => `<tr><td>${DIA_LONGO[a.dia]}</td><td>${esc(a.inicio)}–${esc(a.fim)}</td><td>${esc(nomeBonito(d.nome))}</td><td>${esc(a.professor)}</td><td>${a.sala ? esc(salaTxt(a.sala)) : '<span class="mz-sem">—</span>'}</td><td>${modalidade(d)}</td><td class="num">${d.ch.total} h</td></tr>`).join('')
      + pendentes.map(d => `<tr><td colspan="2" class="mz-sem">a definir</td><td>${esc(nomeBonito(d.nome))}</td><td class="mz-sem">a definir</td><td class="mz-sem">—</td><td>${modalidade(d)}</td><td class="num">${d.ch.total} h</td></tr>`).join('');
    return `<h3>${esc(tituloGrupo(c, g))}${g.dp ? '' : ` <span class="mz-rel-per">(${esc(rotuloPeriodos(g.periodos))})</span>`}</h3>
      <div class="mz-tabela-wrap"><table class="mz-tabela"><thead><tr><th>Dia</th><th>Horário</th><th>Disciplina</th><th>Professor</th><th>Sala</th><th>Modalidade</th><th class="num">CH</th></tr></thead><tbody>${corpo || '<tr><td colspan="7" class="mz-sem">Sem disciplinas.</td></tr>'}</tbody></table></div>`;
  }).join('');

  $('painel-horario').innerHTML = `
    <div class="mz-rel-acoes mz-no-print">
      ${semHorario ? `<span class="mz-sem" style="align-self:center">${semHorario} disciplina(s) ainda sem horário — saem como “a definir”.</span>` : ''}
      <button type="button" class="mz-btn mz-btn-pri" id="btn-imprimir">Imprimir / salvar PDF</button>
    </div>
    <div class="mz-rel">
      <div class="mz-rel-cab">
        <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã">
        <div><h2>Horário de Aulas — ${esc(c.cursoNome)}</h2><p>Semestre ${esc(dados.semestre.replace('.', '/'))} · Fatec Ivaiporã</p></div>
      </div>
      ${blocos}
      <div class="mz-rel-rodape"><div>Coordenação do curso</div><div>Direção Acadêmica</div></div>
      <p class="mz-rel-emissao">Emitido em ${esc(emissao)}${currentUserNome ? ' por ' + esc(currentUserNome) : ''}. Matriz curricular conforme Edubox.</p>
    </div>`;
}

// ---- Aba 4: carga horária por matriz (por modalidade; o total geral fecha com a carga do curso)
const MODS = [
  { k: 'teorica', rot: 'Presencial (teórica)' },
  { k: 'pratica', rot: 'Prática' },
  { k: 'ead', rot: 'EAD' },
  { k: 'sincrona', rot: 'Síncrona mediada' },
  { k: 'extensao', rot: 'Extensão' }
];
const somar = (disc) => {
  const t = { teorica: 0, pratica: 0, ead: 0, sincrona: 0, extensao: 0, total: 0, n: disc.length };
  disc.forEach(d => { MODS.forEach(m => { t[m.k] += d.ch[m.k] || 0; }); t.total += d.ch.total || 0; });
  t.soma = MODS.reduce((a, m) => a + t[m.k], 0);
  return t;
};
const pct = (n, tot) => (tot ? (Math.round(n / tot * 1000) / 10).toLocaleString('pt-BR') + '%' : '–');
const hh = (n) => n.toLocaleString('pt-BR');

function dadosCarga(c) {
  return c.grades.map(g => {
    const todas = g.periodos.flatMap(p => p.disciplinas);
    const tot = somar(todas);
    const semCategoria = tot.total - tot.soma;                       // CH que o Edubox não distribuiu em nenhuma modalidade
    const foraDisc = g.chTotal ? g.chTotal - tot.total : 0;          // CH da matriz que não está nas disciplinas (ex.: atividades complementares)
    const aberrantes = todas.filter(d => (d.ch.total || 0) !== MODS.reduce((a, m) => a + (d.ch[m.k] || 0), 0));
    return { g, tot, semCategoria, foraDisc, aberrantes, periodos: g.periodos.map(p => ({ periodo: p.periodo, ...somar(p.disciplinas) })) };
  });
}

function renderCarga() {
  const c = cursoAtual();
  const dados_ = dadosCarga(c);
  const emissao = new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  const blocos = dados_.map(({ g, tot, semCategoria, foraDisc, aberrantes, periodos }) => {
    const seguem = c.turmas.filter(t => t.codGrade === g.codGrade);
    const mostraSinc = tot.sincrona > 0;
    const linhasMod = MODS.filter(m => m.k !== 'sincrona' || mostraSinc).map(m => `<tr><td>${m.rot}</td><td class="num">${hh(tot[m.k])} h</td><td class="num">${pct(tot[m.k], tot.total)}</td></tr>`).join('');
    const linhaSemCat = semCategoria ? `<tr class="marcada"><td>Sem modalidade definida no Edubox <span class="mz-sem">(${aberrantes.length} disciplina(s))</span></td><td class="num">${hh(semCategoria)} h</td><td class="num">${pct(semCategoria, tot.total)}</td></tr>` : '';
    const linhaFora = foraDisc ? `<tr><td>Fora das disciplinas <span class="mz-sem">(CH da matriz − soma das disciplinas; ex.: atividades complementares)</span></td><td class="num">${hh(foraDisc)} h</td><td class="num">${pct(foraDisc, g.chTotal)}</td></tr>` : '';
    const porPeriodo = periodos.map(p => `<tr><td>${p.periodo}º período</td><td class="num">${p.n}</td><td class="num">${p.teorica || '–'}</td><td class="num">${p.pratica || '–'}</td><td class="num">${p.ead || '–'}</td>${mostraSinc ? `<td class="num">${p.sincrona || '–'}</td>` : ''}<td class="num">${p.extensao || '–'}</td><td class="num"><b>${p.total}</b></td></tr>`).join('');
    const rodape = `<tr class="mz-total"><td>Total</td><td class="num">${tot.n}</td><td class="num">${hh(tot.teorica)}</td><td class="num">${hh(tot.pratica)}</td><td class="num">${hh(tot.ead)}</td>${mostraSinc ? `<td class="num">${hh(tot.sincrona)}</td>` : ''}<td class="num">${hh(tot.extensao)}</td><td class="num">${hh(tot.total)}</td></tr>`;
    const aviso = aberrantes.length ? `<div class="mz-aviso"><b>Conferir no Edubox:</b> ${aberrantes.length} disciplina(s) com a soma das modalidades diferente do total (ex.: ${esc(nomeBonito(aberrantes[0].nome))}: ${MODS.reduce((a, m) => a + (aberrantes[0].ch[m.k] || 0), 0)} h nas modalidades, ${aberrantes[0].ch.total} h no total).</div>` : '';
    return `<div class="mz-carga-bloco">
      <h3>${esc(g.nome)} <span class="mz-rel-per">${seguem.length ? 'seguida por ' + seguem.map(t => t.periodo + 'º').join(', ') + ' período(s)' : ''}</span></h3>
      ${aviso}
      <table class="mz-tabela mz-resumo-ch"><thead><tr><th>Modalidade</th><th class="num">Carga horária</th><th class="num">% do total</th></tr></thead><tbody>
        ${linhasMod}
        <tr class="mz-total"><td>Total das disciplinas</td><td class="num">${hh(tot.total)} h</td><td class="num">100%</td></tr>
        ${linhaSemCat}${linhaFora}
        <tr class="mz-total mz-geral"><td>Carga horária total da matriz${g.chTotal ? '' : ' <span class="mz-sem">(sem total no Edubox)</span>'}</td><td class="num">${hh(g.chTotal || tot.total)} h</td><td class="num"></td></tr>
      </tbody></table>
      <table class="mz-tabela mz-por-periodo"><thead><tr><th>Período</th><th class="num">Disc.</th><th class="num">Presencial</th><th class="num">Prática</th><th class="num">EAD</th>${mostraSinc ? '<th class="num">Sínc. med.</th>' : ''}<th class="num">Extensão</th><th class="num">Total</th></tr></thead><tbody>${porPeriodo}${rodape}</tbody></table>
    </div>`;
  }).join('');
  $('painel-carga').innerHTML = `
    <div class="mz-rel-acoes mz-no-print">
      <button type="button" class="mz-btn mz-btn-sec" id="btn-csv-carga">Baixar CSV</button>
      <button type="button" class="mz-btn mz-btn-pri" id="btn-imprimir-carga">Imprimir / salvar PDF</button>
    </div>
    <div class="mz-rel">
      <div class="mz-rel-cab">
        <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã">
        <div><h2>Carga horária por matriz — ${esc(c.cursoNome)}</h2><p>Matrizes em uso no semestre ${esc(dados.semestre.replace('.', '/'))} · Fatec Ivaiporã</p></div>
      </div>
      ${blocos || '<p class="mz-sem">Sem matrizes para este curso.</p>'}
      <p class="mz-rel-emissao">Soma das cargas horárias das disciplinas de cada matriz, por modalidade, conforme o Edubox. Emitido em ${esc(emissao)}${currentUserNome ? ' por ' + esc(currentUserNome) : ''}.</p>
    </div>`;
}

function baixarCsvCarga() {
  const c = cursoAtual();
  const linhas = [['Curso', 'Matriz', 'Período', 'Disciplinas', 'Presencial (teórica)', 'Prática', 'EAD', 'Síncrona mediada', 'Extensão', 'Total']];
  dadosCarga(c).forEach(({ g, tot, periodos }) => {
    periodos.forEach(p => linhas.push([c.cursoNome, g.nome, p.periodo + 'º', p.n, p.teorica, p.pratica, p.ead, p.sincrona, p.extensao, p.total]));
    linhas.push([c.cursoNome, g.nome, 'TOTAL DAS DISCIPLINAS', tot.n, tot.teorica, tot.pratica, tot.ead, tot.sincrona, tot.extensao, tot.total]);
    linhas.push([c.cursoNome, g.nome, 'CARGA TOTAL DA MATRIZ (Edubox)', '', '', '', '', '', '', g.chTotal || '']);
  });
  const csv = linhas.map(l => l.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'carga-horaria-' + c.cursoId + '-' + dados.semestre + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- MODAL DE HORÁRIO ----------
function linhaHtml(a = {}) {
  return `<div class="mz-linha">
    <input type="text" list="lista-professores" class="f-prof" placeholder="Professor" value="${esc(a.professor || '')}" maxlength="120" aria-label="Professor">
    <select class="f-dia" aria-label="Dia da semana">${DIAS.map(d => `<option value="${d}" ${a.dia === d ? 'selected' : ''}>${DIA_LONGO[d]}</option>`).join('')}</select>
    <input type="time" class="f-ini" value="${esc(a.inicio || '')}" aria-label="Início">
    <input type="time" class="f-fim" value="${esc(a.fim || '')}" aria-label="Fim">
    <input type="text" list="lista-salas" class="f-sala" placeholder="Sala" value="${esc(a.sala || '')}" maxlength="80" aria-label="Sala">
    <button type="button" class="f-rem" title="Remover este horário" aria-label="Remover horário">×</button>
    <div class="mz-pre" aria-label="Horários padrão">
      ${PRESETS.map(p => `<button type="button" class="mz-btn mz-btn-sec mz-btn-mini f-pre" data-ini="${p.ini}" data-fim="${p.fim}">${p.rotulo}</button>`).join('')}
    </div>
  </div>`;
}

function abrirModal(gi, li) {
  const c = cursoAtual();
  const g = grupos(c)[Number(gi)];
  const l = g && g.linhas[Number(li)];
  if (!l) return;
  const d = l.d;
  emEdicao = { g, l };
  $('mh-titulo').textContent = d.nome;
  const n = Object.keys(l.porTurma).length;
  $('mh-sub').textContent = `${tituloGrupo(c, g)} · ${d.ch.total} h` + (n > 1 ? ` · vale para as ${n} turmas que estudam juntas` : '');
  const aulas = aulasLinha(c, g, l);
  $('mh-linhas').innerHTML = (aulas.length ? aulas : [{}]).map(linhaHtml).join('');
  $('mh-erro').classList.add('hidden');
  $('modal-horario').classList.remove('hidden');
  $('mh-linhas').querySelector('.f-prof').focus();
}
function fecharModal() { $('modal-horario').classList.add('hidden'); emEdicao = null; }

async function salvarHorario(ev) {
  ev.preventDefault();
  const erro = (m) => { $('mh-erro').textContent = m; $('mh-erro').classList.remove('hidden'); };
  const aulas = [...document.querySelectorAll('#mh-linhas .mz-linha')].map(l => ({
    professor: l.querySelector('.f-prof').value.trim(),
    dia: l.querySelector('.f-dia').value,
    inicio: l.querySelector('.f-ini').value,
    fim: l.querySelector('.f-fim').value,
    sala: l.querySelector('.f-sala').value.trim()
  })).filter(a => a.professor || a.inicio || a.fim); // linha totalmente vazia é ignorada
  for (const [i, a] of aulas.entries()) {
    if (!a.professor) return erro(`Horário ${i + 1}: informe o professor.`);
    if (!a.inicio || !a.fim) return erro(`Horário ${i + 1}: informe início e fim.`);
    if (a.fim <= a.inicio) return erro(`Horário ${i + 1}: o fim precisa ser depois do início.`);
  }
  const c = cursoAtual();
  const { g, l } = emEdicao;
  const btn = $('mh-salvar');
  btn.disabled = true;
  // O horário vale para todas as turmas do grupo (estudam juntas): grava uma vez em cada uma.
  const alvos = g.turmas.filter(t => l.porTurma[t.codTurma]).map(t => ({ t, d: l.porTurma[t.codTurma] }));
  const conflitos = [];
  let feitos = 0;
  try {
    for (const { t, d } of alvos) {
      const r = await apiFetch(`/matrizes/grade/${encodeURIComponent(dados.semestre)}/${encodeURIComponent(c.cursoId)}/${t.codTurma}/${d.codDisciplina}`, {
        method: 'PUT', body: JSON.stringify({ aulas })
      });
      if (r.aulas.length) c.alocacoes[r.key] = { disciplina: d.nome, turma: t.nome, periodo: t.periodo, aulas: r.aulas };
      else delete c.alocacoes[r.key];
      r.aulas.forEach(a => { if (!dados.professores.includes(a.professor)) dados.professores.push(a.professor); });
      (r.conflitos || []).forEach(x => { if (!conflitos.some(y => y.professor === x.professor && y.dia === x.dia && y.inicio === x.inicio && y.curso === x.curso && y.disciplina === x.disciplina)) conflitos.push(x); });
      feitos++;
    }
    $('lista-professores').innerHTML = dados.professores.map(p => `<option value="${esc(p)}">`).join('');
    fecharModal();
    renderKpis(); renderCursos(); renderAbas();
    const reais = conflitos.filter(x => !x.exato), iguais = conflitos.filter(x => x.exato);
    const desc = (x) => (x.tipo === 'sala'
      ? `a ${salaTxt(x.sala).toLowerCase()} já está ocupada ${DIA_LONGO[x.dia].toLowerCase()} ${x.inicio}–${x.fim} por ${x.professor} em ${x.curso}${x.disciplina ? ' (' + x.disciplina + ')' : ''}`
      : `${x.professor} já tem aula ${DIA_LONGO[x.dia].toLowerCase()} ${x.inicio}–${x.fim} em ${x.curso}${x.disciplina ? ' (' + x.disciplina + ')' : ''}`);
    if (reais.length) toast(`Salvo, mas atenção — conflito: ${desc(reais[0])}${reais.length > 1 ? ` e mais ${reais.length - 1}` : ''}.`, 'aviso');
    else if (iguais.length) toast(`Salvo. Obs.: ${desc(iguais[0])}, no mesmo horário (aula conjunta?).`, 'aviso');
    else toast(alvos.length > 1 ? `Horário salvo nas ${alvos.length} turmas do grupo.` : 'Horário salvo.');
  } catch (err) {
    if (feitos) { renderKpis(); renderCursos(); renderAbas(); }
    erro(feitos ? `Salvou em ${feitos} de ${alvos.length} turmas e parou: ${err.message}. Tente salvar de novo.` : err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- EVENTOS ----------
function wireEventos() {
  $('sel-semestre').addEventListener('change', (e) => carregar(e.target.value));
  $('cursos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-curso]');
    if (!b) return;
    cursoSel = b.dataset.curso;
    renderKpis(); renderCursos(); renderAbas();
  });
  document.querySelector('.mz-abas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (!b) return;
    abaSel = b.dataset.aba;
    renderAbas();
  });
  $('painel-semestre').addEventListener('click', (e) => {
    const b = e.target.closest('[data-editar]');
    if (b) { const [gi, li] = b.dataset.editar.split('|'); abrirModal(gi, li); }
  });
  $('painel-matrizes').addEventListener('change', (e) => {
    if (e.target.id === 'cmp-a') { cmpA = e.target.value; renderMatrizes(); }
    if (e.target.id === 'cmp-b') { cmpB = e.target.value; renderMatrizes(); }
  });
  $('painel-carga').addEventListener('click', (e) => {
    if (e.target.id === 'btn-csv-carga') return baixarCsvCarga();
    if (e.target.id !== 'btn-imprimir-carga') return;
    const p = $('painel-carga');
    p.classList.add('imprimir');
    const limpar = () => { p.classList.remove('imprimir'); window.removeEventListener('afterprint', limpar); };
    window.addEventListener('afterprint', limpar);
    window.print();
  });
  $('painel-horario').addEventListener('click', (e) => {
    if (e.target.id !== 'btn-imprimir') return;
    const p = $('painel-horario');
    p.classList.add('imprimir');
    const limpar = () => { p.classList.remove('imprimir'); window.removeEventListener('afterprint', limpar); };
    window.addEventListener('afterprint', limpar);
    window.print();
  });
  $('mh-add').addEventListener('click', () => {
    $('mh-linhas').insertAdjacentHTML('beforeend', linhaHtml());
  });
  $('mh-linhas').addEventListener('click', (e) => {
    const pre = e.target.closest('.f-pre');
    if (pre) {
      const l = pre.closest('.mz-linha');
      l.querySelector('.f-ini').value = pre.dataset.ini;
      l.querySelector('.f-fim').value = pre.dataset.fim;
      return;
    }
    if (!e.target.classList.contains('f-rem')) return;
    const l = e.target.closest('.mz-linha');
    if ($('mh-linhas').children.length > 1) l.remove();
    else { l.querySelectorAll('input').forEach(i => { i.value = ''; }); }
  });
  $('mh-cancelar').addEventListener('click', fecharModal);
  $('modal-horario').addEventListener('click', (e) => { if (e.target.id === 'modal-horario') fecharModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && emEdicao) fecharModal(); });
  $('form-horario').addEventListener('submit', salvarHorario);
}
