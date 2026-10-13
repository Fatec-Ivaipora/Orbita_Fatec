import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';

// ==========================================================================
// CAD — Conselho Acadêmico de Desempenho Discente (13/10/2026). Os números vêm de
// scripts/cad-edubox-sync.js (Edubox -> Firestore): nota do bimestre (soma das avaliações lançadas)
// e faltas por aluno e disciplina. Aqui o coordenador filtra quem entra em atenção (notas vermelhas
// e/ou faltas — filtros separados, ajustáveis), registra a observação e a intervenção de cada aluno
// e imprime a ata. Nota vermelha = abaixo de 7,0.
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (['127.0.0.1', 'localhost'].includes(location.hostname) || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
  ? `http://${location.hostname}:3000/api` : '/api';

const MODULO = 'cad';
const NIVEL_PADRAO = { adm_l2: 3, coordenador: 3, coord_medicina: 3 };
const MEDIA = 7;                 // nota vermelha: abaixo disso
const DISC_CRITICA = 0.4;        // disciplina "pede atenção" a partir de 40% de notas vermelhas

let currentUser = null, appInitialized = false, initializedRole = null, podeEditar = false, meuUid = '', souAdm = false;
let ciclos = [], seg = 'GRA', semSel = '', faseSel = '', cursoSel = '', turmaSel = '';
let turma = null;                // /cad/turma/:id
let modo = 'ou';
const abertos = new Set();       // alunos com o detalhe aberto

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNota = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const MINUSC = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'para', 'na', 'no', 'com', 'à']);
// o Edubox guarda tudo em MAIÚSCULAS: mostra em formato de título
// Nas disciplinas EAD a avaliação "TRILHA(S) EAD" é a nota das unidades de aprendizagem do AVA
const ehUA = (nome) => /^TRILHAS? EAD$/i.test(String(nome || '').trim());
const nomeAvaliacao = (nome) => (ehUA(nome) ? 'Unidades de aprendizagem (Trilhas EAD)' : frase(nome));
const frase = (s) => { const t = String(s || '').toLowerCase().replace(/ead/g, 'EAD').replace(/av\./g, 'Av.'); return t.charAt(0).toUpperCase() + t.slice(1); };
const titulo = (s) => String(s || '').toLowerCase().split(/(\s+)/).map((p, i) => (/^\s+$/.test(p) || (i > 0 && MINUSC.has(p))) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('toast'); t.textContent = msg; t.className = `cad-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- AUTH ----------
const cached = getCachedAuth();
if (cached) { currentUser = cached.user; initApp(cached.user, cached.role); }

onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../auth/login.html'; return; }
  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante', meuOverrides = null;
    try { const u = await apiFetch('/usuarios/me'); role = u.role || 'visitante'; meuOverrides = u.permissoes || null; }
    catch (e) { role = cached ? cached.role : 'visitante'; }
    setCachedAuth(user, role, token);
    let level = 1;
    if (role === 'adm_l1') level = 3;
    else {
      try {
        const perms = await apiFetch('/usuarios/config/permissions');
        const doCargo = perms[role] || {};
        const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
      } catch (e) { level = NIVEL_PADRAO[role] || 1; }
    }
    if (level < 2) { location.href = '../meu-espaco/index.html'; return; }
    podeEditar = level >= 3;
    if (!appInitialized || initializedRole !== role) initApp(user, role);
    if (!ciclos.length) carregarCiclos();
  } catch (err) { console.error('Erro na revalidação de auth:', err); }
});

function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true; initializedRole = role;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../auth/login.html'; });
  $('app').classList.remove('hidden');
  wireEventos();
}

// ---------- CARGA ----------
async function carregarCiclos() {
  try {
    const r = await apiFetch('/cad/ciclos');
    ciclos = r.ciclos || []; meuUid = r.uid || ''; souAdm = !!r.adm;
    if (!ciclos.some(c => c.segmento === seg) && ciclos.length) seg = ciclos[0].segmento;
    document.querySelectorAll('#seg .aba').forEach(b => {
      b.classList.toggle('ativa', b.dataset.seg === seg);
      b.classList.toggle('hidden', !ciclos.some(c => c.segmento === b.dataset.seg));
    });
    montarSemestres();
  } catch (err) {
    $('vazio').textContent = `Não foi possível carregar o CAD: ${err.message}`;
  }
}
const cicloAtual = () => ciclos.find(c => c.id === semSel);

function montarSemestres() {
  const lista = ciclos.filter(c => c.segmento === seg);
  const sel = $('sel-sem');
  if (!lista.length) { sel.innerHTML = ''; $('vazio').textContent = 'Ainda não há dados do CAD. Rode a sincronização com o Edubox.'; return; }
  if (!lista.some(c => c.id === semSel)) semSel = lista[0].id;
  sel.innerHTML = lista.map(c => `<option value="${esc(c.id)}">${esc(c.semestre.replace('-', '.'))}</option>`).join('');
  sel.value = semSel;
  montarFases(); montarCursos();
}
function montarFases() {
  const c = cicloAtual(); const sel = $('sel-fase');
  const fases = (c && c.fases) || [];
  // padrão: o último bimestre que já terminou (é sobre ele que o conselho se reúne); senão o primeiro
  const hoje = new Date().toISOString().slice(0, 10);
  if (!fases.some(f => String(f.id) === String(faseSel))) {
    const fechados = fases.filter(f => f.fim < hoje);
    faseSel = String((fechados[fechados.length - 1] || fases[0] || {}).id || '');
  }
  sel.innerHTML = fases.map(f => `<option value="${f.id}">${esc(titulo(f.nome))}</option>`).join('');
  sel.value = faseSel;
}
function montarCursos() {
  const c = cicloAtual(); const sel = $('sel-curso');
  const cursos = [...new Map(((c && c.turmas) || []).map(t => [t.codcur, t.curso])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  if (!cursos.some(([k]) => k === cursoSel)) cursoSel = cursos.length === 1 ? cursos[0][0] : '';
  sel.innerHTML = '<option value="">Escolha o curso</option>' + cursos.map(([k, n]) => `<option value="${esc(k)}">${esc(titulo(n))}</option>`).join('');
  sel.value = cursoSel;
  montarTurmas();
}
function montarTurmas() {
  const c = cicloAtual(); const sel = $('sel-turma');
  const turmas = ((c && c.turmas) || []).filter(t => t.codcur === cursoSel).sort((a, b) => (a.periodo - b.periodo) || a.turma.localeCompare(b.turma, 'pt-BR'));
  if (!turmas.some(t => t.id === turmaSel)) turmaSel = turmas.length === 1 ? turmas[0].id : '';
  sel.innerHTML = `<option value="">${cursoSel ? 'Escolha a turma' : '—'}</option>` + turmas.map(t => `<option value="${esc(t.id)}">${esc(titulo(t.turma))} · ${plural(t.alunos, 'aluno', 'alunos')}</option>`).join('');
  sel.value = turmaSel;
  sel.disabled = !cursoSel;
  carregarTurma();
}
async function carregarTurma() {
  turma = null; abertos.clear();
  $('btn-ata').disabled = true;
  if (!turmaSel) { $('conteudo').classList.add('hidden'); $('vazio').classList.remove('hidden'); $('vazio').textContent = 'Escolha o curso e a turma para ver o desempenho do bimestre.'; return; }
  $('vazio').textContent = 'Carregando a turma…';
  try {
    turma = await apiFetch(`/cad/turma/${encodeURIComponent(turmaSel)}`);
    $('vazio').classList.add('hidden'); $('conteudo').classList.remove('hidden');
    $('btn-ata').disabled = false;
    render();
  } catch (err) {
    $('vazio').textContent = `Não foi possível carregar a turma: ${err.message}`;
  }
}

// ---------- CÁLCULO ----------
function filtros() {
  return { notas: Math.max(1, Number($('f-notas').value) || 2), faltas: Math.max(1, Number($('f-faltas').value) || 5), modo, todos: $('f-todos').checked };
}
function situacaoAluno(a, fase) {
  const discs = a.d.map(x => {
    const disc = turma.disciplinas.find(d => d.id === x.id) || { nome: '—', professor: '', aulas: {} };
    const f = x.f[fase] || { n: null, p: null, l: 0, t: 0, c: [] };
    // faltas = total da disciplina no semestre até hoje (campo do Edubox, coluna FT da Planilha de Notas)
    const aulasSem = Object.values(disc.aulas || {}).reduce((s2, v) => s2 + v, 0);
    // composição: de qual avaliação veio cada parte da nota (nomes como o professor lançou no Edubox)
    const comp = ((disc.avs || {})[fase] || []).map((nome, i) => ({ nome, v: (f.c || [])[i] ?? null }));
    return { ...disc, n: f.n, p: f.p, l: f.l, t: f.t, comp, fa: x.ft || 0, aulas: aulasSem, vermelha: f.n !== null && f.n < MEDIA };
  }).sort((x, y) => (y.vermelha - x.vermelha) || (y.fa - x.fa) || x.nome.localeCompare(y.nome, 'pt-BR'));
  const vermelhas = discs.filter(d => d.vermelha).length;
  const semUA = discs.filter(d => d.comp.some(c => ehUA(c.nome) && c.v === 0));   // tirou 0 nas unidades de aprendizagem
  const maiorFalta = Math.max(0, ...discs.map(d => d.fa));
  const totalFaltas = discs.reduce((s, d) => s + d.fa, 0);
  return { aluno: a, discs, vermelhas, maiorFalta, totalFaltas, semUA };
}
function emAtencao(s, f) {
  const porNota = s.vermelhas >= f.notas, porFalta = s.maiorFalta >= f.faltas;
  return f.modo === 'e' ? (porNota && porFalta) : (porNota || porFalta);
}
// Histórico de atendimento por aluno (chave = código do aluno: acompanha o aluno entre semestres).
const chaveAluno = (a) => String(a.alu || a.id);
const atendDoBimestre = (a) => (turma.atendimentosLista || []).filter(x => String(x.alu) === chaveAluno(a) && String(x.fase) === String(faseSel));
const alunoCache = {};          // alu -> { historico, atendimentos } de /cad/aluno/:alu
let editando = null;            // id do atendimento em edição
const MODAIS = { ead: 'EAD', sincrona: 'Síncrona', estagio: 'Estágio', presencial: 'Presencial' };
const tagModal = (m) => (m ? `<span class="cad-modal ${m}" title="${m === 'ead' ? 'Disciplina EAD: não tem falta' : 'Tem controle de falta'}">${MODAIS[m] || ''}</span>` : '');

async function carregarAluno(alu, forcar = false) {
  if (alunoCache[alu] && !forcar) return;
  alunoCache[alu] = { carregando: true };
  try { alunoCache[alu] = await apiFetch(`/cad/aluno/${encodeURIComponent(alu)}`); }
  catch (err) { alunoCache[alu] = { erro: err.message }; }
  render();
}

// ---------- TELA ----------
function render() {
  // guarda o que o coordenador está digitando (abrir outro aluno ou mexer no filtro redesenha a lista)
  const rascunhos = {};
  document.querySelectorAll('#lista textarea, #lista input[type=date]').forEach(t => { rascunhos[t.id] = t.value; });
  const f = filtros();
  const fase = faseSel;
  const nomeFase = titulo((cicloAtual().fases.find(x => String(x.id) === String(fase)) || {}).nome || '');
  const todos = turma.alunos.map(a => situacaoAluno(a, fase));
  const atencao = todos.filter(s => emAtencao(s, f));
  const ordemAlfa = (x, y) => x.aluno.nome.localeCompare(y.aluno.nome, 'pt-BR');
  // marcado: a turma inteira em ordem alfabética, sem filtro; desmarcado: só quem está em atenção, os mais graves primeiro
  const lista = f.todos ? todos.slice().sort(ordemAlfa) : atencao.sort((x, y) => (y.vermelhas - x.vermelhas) || (y.maiorFalta - x.maiorFalta) || x.aluno.nome.localeCompare(y.aluno.nome, 'pt-BR'));
  const semNota = turma.disciplinas.length && todos.every(s => s.discs.every(d => d.n === null));

  $('ata-cab').innerHTML = `<div class="cad-ata-marca">FATEC Ivaiporã · Conselho Acadêmico de Desempenho Discente (CAD)</div>
    <h1>${esc(titulo(turma.turma))} — ${esc(nomeFase)} de ${esc(turma.semestre.replace('-', '.'))}</h1>
    <p>Critério: nota vermelha abaixo de ${fmtNota(MEDIA)} · em atenção com ${f.notas}+ notas vermelhas ${f.modo === 'e' ? 'e' : 'ou'} ${f.faltas}+ faltas numa disciplina (EAD não tem falta) · emitida em ${new Date().toLocaleDateString('pt-BR')}</p>`;

  const crit = todos.filter(s => s.vermelhas >= 3).length;
  const faltosos = todos.filter(s => s.maiorFalta >= f.faltas).length;
  const comAtend = atencao.filter(s => atendDoBimestre(s.aluno).length).length;
  const kpi = (cls, rot, val, dica) => `<div class="kpi-card ${cls}"><div class="kpi-label">${rot}</div><div class="kpi-value">${val}</div><div class="kpi-hint">${dica}</div></div>`;
  $('kpis').innerHTML =
    kpi('kpi-azul', 'Alunos ativos na turma', turma.alunos.length, `${plural(turma.disciplinas.length, 'disciplina', 'disciplinas')}`) +
    kpi('kpi-perda', 'Em atenção', atencao.length, turma.alunos.length ? `${fmtPct(atencao.length / turma.alunos.length)} da turma, pelo critério acima` : '') +
    kpi('kpi-perda', 'Com 3 ou mais notas vermelhas', crit, 'risco alto de reprovação') +
    kpi('kpi-sem', `Com ${f.faltas}+ faltas numa disciplina`, faltosos, 'no semestre até hoje; EAD não conta') +
    kpi('kpi-verde', 'Atendidos neste bimestre', `${comAtend} de ${atencao.length}`, 'alunos em atenção com registro');

  renderPanorama(todos, semNota);
  $('lista-tit').innerHTML = f.todos ? `Todos os alunos da turma <small>— ${plural(lista.length, 'aluno', 'alunos')}, em ordem alfabética</small>` : `Alunos em atenção <small>— ${plural(lista.length, 'aluno', 'alunos')}</small>`;
  $('lista').innerHTML = semNota
    ? `<div class="cad-aviso">Ainda não há nota lançada no Edubox neste bimestre para esta turma.</div>`
    : lista.length ? lista.map(s => linhaAluno(s, f)).join('') : `<div class="cad-aviso">Nenhum aluno entra em atenção com este critério. Ajuste os números acima para ampliar.</div>`;
  for (const [id, v] of Object.entries(rascunhos)) { const t = $(id); if (t) t.value = v; }
}

function renderPanorama(todos, semNota) {
  const fase = faseSel;
  const linhas = turma.disciplinas.map(d => {
    const notas = turma.alunos.map(a => ((a.d.find(x => x.id === d.id) || {}).f || {})[fase]).filter(x => x && x.n !== null);
    const verm = notas.filter(x => x.n < MEDIA).length;
    const media = notas.length ? notas.reduce((s, x) => s + x.n, 0) / notas.length : null;
    return { ...d, lancadas: notas.length, verm, pct: notas.length ? verm / notas.length : 0, media };
  }).sort((a, b) => (b.pct - a.pct) || (b.verm - a.verm));
  if (semNota || !linhas.some(l => l.lancadas)) { $('panorama').innerHTML = '<div class="cad-aviso">Sem notas lançadas neste bimestre.</div>'; return; }
  $('panorama').innerHTML = `<div class="cad-pan">${linhas.map(l => `
    <div class="cad-pan-linha ${l.pct >= DISC_CRITICA ? 'critica' : ''}" data-dica="${esc(`${titulo(l.nome)}|${l.verm} de ${l.lancadas} alunos com nota vermelha|média ${fmtNota(l.media)}${l.professor ? ` · ${titulo(l.professor)}` : ''}`)}">
      <div class="cad-pan-nome"><b>${esc(titulo(l.nome))}</b> ${tagModal(l.modal)}${l.dp ? ' <span class="cad-tag">DP</span>' : ''}<small>${l.professor ? esc(titulo(l.professor)) : 'professor não informado'}</small></div>
      <div class="cad-pan-barra"><span style="width:${Math.max(l.pct * 100, l.verm ? 2 : 0)}%"></span></div>
      <div class="cad-pan-val"><b>${l.lancadas ? fmtPct(l.pct) : '–'}</b><small>${l.lancadas ? `${l.verm}/${l.lancadas} · média ${fmtNota(l.media)}` : 'sem nota lançada'}</small></div>
    </div>`).join('')}</div>
    <p class="cad-legenda">Em vermelho: ${fmtPct(DISC_CRITICA)} ou mais dos alunos abaixo de ${fmtNota(MEDIA)} — vale olhar o processo avaliativo da disciplina.</p>`;
}

function linhaAluno(s, f) {
  const a = s.aluno;
  const nivel = s.vermelhas >= 3 ? 'crit' : s.vermelhas >= f.notas ? 'ruim' : s.maiorFalta >= f.faltas ? 'falta' : 'ok';
  const nAt = ((turma.atendimentos || {})[chaveAluno(a)] || { n: 0 }).n;
  const aberto = abertos.has(String(a.id));
  const chipsVerm = s.discs.filter(d => d.vermelha).map(d => `<span class="cad-chip verm">${esc(titulo(d.nome))} ${fmtNota(d.n)}</span>`).join('')
    + s.semUA.map(d => `<span class="cad-chip ua" title="Nota 0 nas unidades de aprendizagem (Trilhas EAD)">Não fez as UAs: ${esc(titulo(d.nome))}</span>`).join('');
  return `<article class="cad-aluno ${nivel}" data-aluno="${esc(a.id)}">
    <button type="button" class="cad-aluno-cab" data-abrir="${esc(a.id)}" aria-expanded="${aberto}">
      <span class="cad-aluno-nome">${esc(titulo(a.nome))}</span>
      <span class="cad-badges">
        <span class="cad-badge ${s.vermelhas >= 3 ? 'crit' : s.vermelhas ? 'ruim' : 'ok'}">${plural(s.vermelhas, 'nota vermelha', 'notas vermelhas')}</span>
        <span class="cad-badge ${s.maiorFalta >= f.faltas ? 'falta' : 'ok'}">até ${plural(s.maiorFalta, 'falta', 'faltas')} numa disciplina</span>
        ${nAt ? `<span class="cad-badge obs">${plural(nAt, 'atendimento', 'atendimentos')}</span>` : ''}
      </span>
      <span class="cad-chips">${chipsVerm}</span>
    </button>
    ${aberto ? detalheAluno(s) : ''}
  </article>`;
}

// Gráfico do desempenho do aluno: média das notas de cada bimestre (linha) e quantas vermelhas,
// em todos os semestres sincronizados. Linha tracejada = 7,0.
function graficoAluno(hist) {
  const pts = Object.values((hist && hist.p) || {}).sort((a, b) => (a.sem.replace('-', '.').localeCompare(b.sem.replace('-', '.'))) || (a.fase - b.fase));
  if (pts.length < 1) return '<div class="cad-aviso">Sem notas completas em bimestres anteriores para montar o gráfico.</div>';
  const W = 640, H = 190, M = { t: 18, r: 30, b: 46, l: 30 };
  const x = (i) => M.l + (pts.length === 1 ? (W - M.l - M.r) / 2 : i * (W - M.l - M.r) / (pts.length - 1));
  const y = (v) => H - M.b - (v / 10) * (H - M.t - M.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Média por bimestre">`;
  for (const v of [0, 5, 10]) svg += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eef2f7"/><text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#5b6a80">${v}</text>`;
  svg += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(MEDIA)}" y2="${y(MEDIA)}" stroke="#c8392f" stroke-dasharray="4 4"/><text x="${M.l - 6}" y="${y(MEDIA) + 4}" text-anchor="end" font-size="10" font-weight="700" fill="#c8392f">7</text>`;
  svg += `<polyline points="${pts.map((p, i) => `${x(i)},${y(p.media)}`).join(' ')}" fill="none" stroke="#1f6fb2" stroke-width="2.5" stroke-linejoin="round"/>`;
  pts.forEach((p, i) => {
    const ruim = p.media < MEDIA;
    svg += `<circle cx="${x(i)}" cy="${y(p.media)}" r="5" fill="${ruim ? '#c8392f' : '#1f6fb2'}" data-dica="${esc(`${p.sem.replace('-', '.')} · ${titulo(p.nome)}|média ${fmtNota(p.media)}|${plural(p.vermelhas, 'nota vermelha', 'notas vermelhas')} de ${p.comNota} · ${plural(p.faltas, 'falta', 'faltas')} no semestre`)}"/>`;
    svg += `<text x="${x(i)}" y="${y(p.media) - 9}" text-anchor="middle" font-size="11" font-weight="700" fill="${ruim ? '#c8392f' : '#0d1b33'}">${fmtNota(p.media)}</text>`;
    svg += `<text x="${x(i)}" y="${H - 28}" text-anchor="middle" font-size="10" fill="#44536b">${esc(p.sem.replace('-', '.'))}</text>`;
    svg += `<text x="${x(i)}" y="${H - 16}" text-anchor="middle" font-size="10" fill="#5b6a80">${p.fase % 2 ? '' : ''}${esc(titulo(p.nome).replace(' Bimestre', 'º bim').replace('ºº', 'º'))}</text>`;
    if (p.vermelhas) svg += `<text x="${x(i)}" y="${H - 3}" text-anchor="middle" font-size="10" font-weight="700" fill="#c8392f">${p.vermelhas} verm.</text>`;
  });
  return `<div class="cad-graf">${svg}</svg></div>`;
}

// Vida acadêmica desde o ingresso atual: média final de cada semestre (Edubox) e reprovações; o semestre
// que ainda não fechou entra como parcial (média dos bimestres com nota completa).
const FORMAS = { V: 'vestibular', T: 'transferência' };
function graficoVida(hist) {
  const sems = Object.entries((hist && hist.s) || {}).map(([sem, x]) => ({ sem, ...x })).sort((a, b) => a.sem.localeCompare(b.sem));
  const bims = Object.values((hist && hist.p) || {});
  const pts = sems.map(x => {
    if (x.media !== null && x.media !== undefined && x.comMedia) return { ...x, v: x.media, parcial: false };
    const bs = bims.filter(b => b.sem.replace('.', '/').replace('-', '/') === x.sem);
    if (!bs.length) return null;
    return { ...x, v: Math.round(bs.reduce((s2, b) => s2 + b.media, 0) / bs.length * 100) / 100, parcial: true };
  }).filter(Boolean);
  if (!pts.length) return '';
  const ing = hist.ingresso;
  const bimsDe = (sem) => bims.filter(b => b.sem.replace('.', '/').replace('-', '/') === sem).sort((a, b) => a.fase - b.fase);
  const W = 640, H = 190, M = { t: 20, r: 30, b: 40, l: 30 };
  const x = (i) => M.l + (pts.length === 1 ? (W - M.l - M.r) / 2 : i * (W - M.l - M.r) / (pts.length - 1));
  const y = (v) => H - M.b - (v / 10) * (H - M.t - M.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vida acadêmica">`;
  for (const v of [0, 5, 10]) svg += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eef2f7"/><text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#5b6a80">${v}</text>`;
  svg += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(MEDIA)}" y2="${y(MEDIA)}" stroke="#c8392f" stroke-dasharray="4 4"/><text x="${M.l - 6}" y="${y(MEDIA) + 4}" text-anchor="end" font-size="10" font-weight="700" fill="#c8392f">7</text>`;
  const fechados = pts.filter(p => !p.parcial);
  if (fechados.length > 1) svg += `<polyline points="${pts.map((p, i) => p.parcial ? null : `${x(i)},${y(p.v)}`).filter(Boolean).join(' ')}" fill="none" stroke="#12294d" stroke-width="2.5" stroke-linejoin="round"/>`;
  const ultimoFechado = pts.map(p => !p.parcial).lastIndexOf(true);
  pts.forEach((p, i) => {
    if (p.parcial && ultimoFechado >= 0 && i === ultimoFechado + 1) svg += `<line x1="${x(ultimoFechado)}" y1="${y(pts[ultimoFechado].v)}" x2="${x(i)}" y2="${y(p.v)}" stroke="#12294d" stroke-width="2" stroke-dasharray="5 4"/>`;
    const ruim = p.v < MEDIA;
    const cor = ruim ? '#c8392f' : '#12294d';
    svg += `<circle cx="${x(i)}" cy="${y(p.v)}" r="5.5" fill="${p.parcial ? '#fff' : cor}" stroke="${cor}" stroke-width="2" data-dica="${esc(`${p.sem.replace('/', '.')}${p.parcial ? ' (em andamento)' : ''}|média ${fmtNota(p.v)}${p.parcial ? ' dos bimestres' : ' final'}|${plural(p.disciplinas, 'disciplina', 'disciplinas')} · ${plural(p.reprov, 'reprovação', 'reprovações')}${bimsDe(p.sem).map(b => `|${titulo(b.nome).replace(' Bimestre', 'º bim').replace('ºº', 'º')}: média ${fmtNota(b.media)} · ${plural(b.vermelhas, 'vermelha', 'vermelhas')}`).join('')}`)}"/>`;
    svg += `<text x="${x(i)}" y="${y(p.v) - 10}" text-anchor="middle" font-size="11" font-weight="700" fill="${cor}">${fmtNota(p.v)}</text>`;
    svg += `<text x="${x(i)}" y="${H - 22}" text-anchor="middle" font-size="10" fill="#44536b">${esc(p.sem.replace('/', '.'))}${p.parcial ? '*' : ''}</text>`;
    const vermAnd = p.parcial ? bimsDe(p.sem).reduce((m, b) => Math.max(m, b.vermelhas), 0) : 0;
    if (p.reprov && !p.parcial) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#c8392f">${plural(p.reprov, 'reprov.', 'reprov.')}</text>`;
    else if (vermAnd) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#c8392f">${vermAnd} verm.</text>`;
  });
  const reprovTotal = pts.reduce((s2, p) => s2 + (p.reprov || 0), 0);
  return `<div class="cad-sub">Vida acadêmica <small>— desde o ingresso ${ing && ing.sem ? `em ${esc(ing.sem.replace('/', '.'))}${FORMAS[ing.forma] ? ` (${FORMAS[ing.forma]})` : ''}` : 'atual'} · média final de cada semestre (passe o mouse para ver os bimestres) · ${plural(reprovTotal, 'reprovação', 'reprovações')} no total${pts.some(p => p.parcial) ? ' · * semestre em andamento (média dos bimestres)' : ''}</small></div>
    <div class="cad-graf">${svg}</svg></div>`;
}

function detalheAluno(s) {
  const a = s.aluno, alu = chaveAluno(a);
  const dados = alunoCache[alu];
  if (!dados) carregarAluno(alu);
  const linhas = s.discs.map(d => `<tr class="${d.vermelha ? 'verm' : ''}">
      <td>${esc(titulo(d.nome))} ${tagModal(d.modal)}${d.dp ? ' <span class="cad-tag">DP</span>' : ''}<small>${d.professor ? esc(titulo(d.professor)) : ''}</small>
        ${d.comp.length ? `<span class="cad-comp">${d.comp.map(c => `<span class="${c.v === null ? 'falta' : ''}">${esc(nomeAvaliacao(c.nome))} <b>${c.v === null ? 'não lançada' : fmtNota(c.v)}</b></span>`).join('<i>+</i>')}</span>` : ''}</td>
      <td class="num">${d.n !== null ? fmtNota(d.n) : d.p !== null ? `<span class="cad-mudo" title="Ainda falta lançar avaliação deste bimestre">parcial ${fmtNota(d.p)} <small>(${d.l} de ${d.t} lançadas)</small></span>` : '<span class="cad-mudo">sem nota</span>'}</td>
      <td class="num">${d.modal === 'ead' ? '<span class="cad-mudo">EAD</span>' : d.fa}</td>
      <td class="num">${d.modal === 'ead' ? '–' : (d.aulas || '–')}</td>
    </tr>`).join('');
  const hoje = new Date().toISOString().slice(0, 10);
  const lista = dados && dados.atendimentos ? dados.atendimentos : [];
  const historico = !dados || dados.carregando ? '<div class="cad-mudo">Carregando o histórico…</div>'
    : dados.erro ? `<div class="cad-aviso">Não foi possível carregar o histórico: ${esc(dados.erro)}</div>`
    : lista.length ? `<ol class="cad-hist">${lista.map(at => atendimentoItem(at, a)).join('')}</ol>` : '<div class="cad-mudo">Nenhum atendimento registrado ainda.</div>';
  return `<div class="cad-detalhe">
    <table class="data-table cad-tab"><thead><tr><th>Disciplina</th><th class="num">Nota do bimestre</th><th class="num">Faltas no semestre</th><th class="num">Aulas registradas</th></tr></thead><tbody>${linhas}</tbody></table>
    <div class="cad-ficha-bar"><button type="button" class="btn-secondary" data-ficha="${esc(a.id)}" ${dados && !dados.carregando && !dados.erro ? '' : 'disabled'}>Imprimir ficha deste aluno</button></div>
    ${dados && dados.historico !== undefined ? (graficoVida(dados.historico) || `<div class="cad-sub">Desempenho</div>${graficoAluno(dados.historico)}`) : '<div class="cad-mudo">Carregando o gráfico…</div>'}
    <div class="cad-sub">Histórico de atendimento <small>— acompanha o aluno em todos os semestres</small></div>
    ${historico}
    ${podeEditar ? `<div class="cad-obs cad-novo">
      <div class="cad-novo-tit">Novo atendimento</div>
      <label class="cad-data">Data <input type="date" id="dt-${esc(a.id)}" value="${hoje}" max="${hoje}"></label>
      <label>Observação <small>(como tem acompanhado o aluno, o que os professores relatam)</small>
        <textarea id="obs-${esc(a.id)}" rows="3"></textarea></label>
      <label>Intervenção combinada <small>(conversa, monitoria, contato com a família, encaminhamento…)</small>
        <textarea id="int-${esc(a.id)}" rows="2"></textarea></label>
      <div class="cad-obs-rodape"><span></span><button type="button" class="btn-primary" data-registrar="${esc(a.id)}">Registrar atendimento</button></div>
    </div>` : ''}
  </div>`;
}

function atendimentoItem(at, a) {
  const podeMexer = podeEditar && (at.porUid === meuUid || souAdm);
  const quando = new Date(`${at.data || String(at.em).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
  const onde = `${titulo(at.turma || '')}${at.semestre ? ` · ${String(at.semestre).replace('-', '.')}` : ''}`;
  if (editando === at.id) {
    return `<li class="cad-hist-item editando">
      <label class="cad-data">Data <input type="date" id="ed-dt-${esc(at.id)}" value="${esc(at.data || '')}"></label>
      <label>Observação<textarea id="ed-obs-${esc(at.id)}" rows="3">${esc(at.observacao)}</textarea></label>
      <label>Intervenção combinada<textarea id="ed-int-${esc(at.id)}" rows="2">${esc(at.intervencao)}</textarea></label>
      <div class="cad-obs-rodape"><button type="button" class="btn-secondary" data-cancelar="1">Cancelar</button><button type="button" class="btn-primary" data-gravar="${esc(at.id)}" data-aluno="${esc(a.id)}">Salvar alteração</button></div>
    </li>`;
  }
  return `<li class="cad-hist-item">
    <div class="cad-hist-cab"><b>${quando}</b><span>${esc(at.por || '—')} · ${esc(onde)}</span>
      ${podeMexer ? `<span class="cad-hist-acoes"><button type="button" class="cad-link" data-editar="${esc(at.id)}">Editar</button><button type="button" class="cad-link perigo" data-excluir="${esc(at.id)}" data-aluno="${esc(a.id)}">Excluir</button></span>` : ''}</div>
    ${at.observacao ? `<p>${esc(at.observacao)}</p>` : ''}
    ${at.intervencao ? `<p class="cad-hist-int"><b>Intervenção:</b> ${esc(at.intervencao)}</p>` : ''}
    ${at.editadoEm ? `<small class="cad-mudo">Editado por ${esc(at.editadoPor || '—')} em ${new Date(at.editadoEm).toLocaleString('pt-BR')}</small>` : ''}
  </li>`;
}

function alunoPorMatricula(id) { return turma.alunos.find(x => String(x.id) === String(id)); }
function aposMudar(a, at, removido) {
  const alu = chaveAluno(a);
  const c = alunoCache[alu];
  if (c && c.atendimentos) {
    c.atendimentos = c.atendimentos.filter(x => x.id !== (at ? at.id : removido));
    if (at) c.atendimentos.push(at);
    c.atendimentos.sort((x, y) => String(y.data || y.em).localeCompare(String(x.data || x.em)));
  }
  turma.atendimentosLista = (turma.atendimentosLista || []).filter(x => x.id !== (at ? at.id : removido));
  if (at && at.turmaId === turma.id) turma.atendimentosLista.push(at);
  const k = alu, m = (turma.atendimentos = turma.atendimentos || {});
  m[k] = { n: turma.atendimentosLista.filter(x => String(x.alu) === k).length };
}
async function registrar(alunoId, btn) {
  const a = alunoPorMatricula(alunoId);
  const body = { turmaId: turma.id, fase: faseSel, alunoId, data: $(`dt-${alunoId}`).value, observacao: $(`obs-${alunoId}`).value, intervencao: $(`int-${alunoId}`).value };
  btn.disabled = true; btn.textContent = 'Registrando…';
  try {
    const r = await apiFetch('/cad/atendimento', { method: 'POST', body: JSON.stringify(body) });
    $(`obs-${alunoId}`).value = ''; $(`int-${alunoId}`).value = '';
    aposMudar(a, r.atendimento); toast('Atendimento registrado.'); render();
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; btn.textContent = 'Registrar atendimento'; }
}
async function gravarEdicao(id, alunoId, btn) {
  const a = alunoPorMatricula(alunoId);
  btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    const r = await apiFetch(`/cad/atendimento/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data: $(`ed-dt-${id}`).value, observacao: $(`ed-obs-${id}`).value, intervencao: $(`ed-int-${id}`).value }) });
    editando = null; aposMudar(a, r.atendimento); toast('Atendimento atualizado.'); render();
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; btn.textContent = 'Salvar alteração'; }
}
async function excluir(id, alunoId) {
  const a = alunoPorMatricula(alunoId);
  if (!window.confirm('Excluir este atendimento? Não dá para desfazer.')) return;
  try {
    await apiFetch(`/cad/atendimento/${encodeURIComponent(id)}`, { method: 'DELETE' });
    aposMudar(a, null, id); toast('Atendimento excluído.'); render();
  } catch (err) { toast(err.message, 'erro'); }
}

// ---------- FICHA DO ALUNO (impressão no padrão FATEC) ----------
// Só o aluno aberto: identificação, situação no bimestre, notas e faltas, vida acadêmica e o histórico de
// atendimento. Abre numa janela A4 (mesmo modelo da Ficha de cobrança) e chama a impressão.
function imprimirFicha(alunoId) {
  const a = alunoPorMatricula(alunoId); if (!a) return;
  const dados = alunoCache[chaveAluno(a)] || {};
  const janela = window.open('', '_blank');
  if (!janela) { toast('O navegador bloqueou a janela de impressão. Libere pop-ups para o Órbita.', 'erro'); return; }
  const f = filtros(), st = situacaoAluno(a, faseSel);
  const nomeFase = titulo((cicloAtual().fases.find(x => String(x.id) === String(faseSel)) || {}).nome || '');
  const hist = dados.historico || {}, ing = hist.ingresso;
  const atend = dados.atendimentos || [];
  const quebra = (t) => esc(t).replace(/\n/g, '<br>');
  const ident = [
    ['Aluno', esc(titulo(a.nome))],
    ['Curso', esc(titulo(turma.curso || '')) || '—'],
    ['Turma', esc(titulo(turma.turma))],
    ['Semestre / bimestre', `${esc(turma.semestre.replace('-', '.'))} · ${esc(nomeFase)}`],
    ['Ingresso', ing && ing.sem ? `${esc(ing.sem.replace('/', '.'))}${FORMAS[ing.forma] ? ` (${FORMAS[ing.forma]})` : ''}` : '—'],
    ['Matrícula', esc(a.id)]
  ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  const linhasD = st.discs.map(d => `<tr class="${d.vermelha ? 'verm' : ''}"><td>${esc(titulo(d.nome))}${d.dp ? ' (DP)' : ''}<div class="msg">${esc(MODAIS[d.modal] || '')}${d.professor ? ` · ${esc(titulo(d.professor))}` : ''}</div></td>
    <td class="n">${d.n !== null ? fmtNota(d.n) : d.p !== null ? `parcial ${fmtNota(d.p)}` : '—'}</td><td class="n">${d.modal === 'ead' ? 'EAD' : d.fa}</td></tr>`).join('');
  const linhasH = atend.length ? atend.slice().sort((x, y) => String(x.data || x.em).localeCompare(String(y.data || y.em))).map(at => `<tr>
    <td class="nw">${new Date(`${at.data || String(at.em).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR')}</td>
    <td>${at.observacao ? quebra(at.observacao) : ''}${at.intervencao ? `<div class="int"><b>Intervenção:</b> ${quebra(at.intervencao)}</div>` : ''}</td>
    <td>${esc(at.por || '—')}<div class="msg">${esc(titulo(at.turma || ''))}${at.semestre ? ` · ${esc(String(at.semestre).replace('-', '.'))}` : ''}</div></td></tr>`).join('')
    : '<tr><td colspan="3" class="vazio">Nenhum atendimento registrado.</td></tr>';
  // só o SVG do gráfico (sem o título da tela e sem as dicas do mouse)
  const m = (graficoVida(hist) || '').match(/<svg[\s\S]*<\/svg>/);
  const grafico = m ? m[0].replace(/ data-dica="[^"]*"/g, '') : '';
  const emitido = new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  const quem = (currentUser && (currentUser.displayName || currentUser.email)) || '';
  const html = `<!DOCTYPE html><html lang="pt-br"><head><meta charset="utf-8"><title>Ficha de acompanhamento — ${esc(titulo(a.nome))}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0b1f33; font-size: 10.5pt; margin: 0; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #1B3A4B; padding-bottom: 8px; margin-bottom: 12px; }
  header img { height: 46px; }
  header h1 { font-size: 16pt; margin: 0; color: #1B3A4B; }
  header p { margin: 2px 0 0; color: #475569; font-size: 9pt; }
  h2 { font-size: 11pt; color: #1B3A4B; margin: 16px 0 6px; border-left: 4px solid #34B3A0; padding-left: 8px; break-after: avoid; }
  .dados { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px 14px; }
  .dados div { border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 9px; }
  .dados small, .resumo small { display: block; color: #64748b; font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; }
  .resumo { display: flex; gap: 10px; }
  .resumo div { flex: 1; border: 1px solid #cbd5e1; border-radius: 6px; padding: 7px 10px; background: #f8fafc; }
  .resumo b { font-size: 13pt; color: #1B3A4B; } .resumo b.ruim { color: #c8392f; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { background: #1B3A4B; color: #fff; text-align: left; padding: 5px 6px; font-weight: 600; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  tr { break-inside: avoid; } tr.verm td { color: #b42318; font-weight: 600; } tr.verm .msg { font-weight: 400; }
  .n { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; }
  .msg { color: #64748b; font-size: 8pt; margin-top: 2px; }
  .int { margin-top: 3px; color: #334155; }
  .vazio { text-align: center; color: #64748b; padding: 10px; }
  .graf { border: 1px solid #e2e8f0; border-radius: 6px; padding: 4px; break-inside: avoid; } .graf svg { width: 100%; height: auto; display: block; }
  .nota { color: #64748b; font-size: 8.5pt; margin-top: 8px; line-height: 1.4; }
  .assina { display: flex; gap: 40px; margin-top: 44px; break-inside: avoid; }
  .assina div { flex: 1; border-top: 1px solid #0b1f33; padding-top: 4px; text-align: center; font-size: 9pt; }
  @media screen { body { max-width: 190mm; margin: 12px auto; padding: 0 10px; } }
</style></head><body>
<header><img src="${location.origin}/img/fateclogoazul.png" alt="FATEC Ivaiporã"><div><h1>Ficha de acompanhamento do aluno</h1><p>FATEC Ivaiporã · Conselho Acadêmico de Desempenho Discente (CAD) · emitida em ${esc(emitido)}${quem ? ' por ' + esc(quem) : ''}</p></div></header>
<h2>Identificação</h2><div class="dados">${ident}</div>
<h2>Situação no ${esc(nomeFase.toLowerCase())}</h2>
<div class="resumo"><div><small>Notas vermelhas (abaixo de ${fmtNota(MEDIA)})</small><b class="${st.vermelhas >= f.notas ? 'ruim' : ''}">${st.vermelhas}</b></div><div><small>Maior nº de faltas numa disciplina</small><b class="${st.maiorFalta >= f.faltas ? 'ruim' : ''}">${st.maiorFalta}</b></div><div><small>Disciplinas</small><b>${st.discs.length}</b></div><div><small>Atendimentos registrados</small><b>${atend.length}</b></div></div>
<h2>Notas e faltas</h2>
<table><thead><tr><th>Disciplina</th><th class="n">Nota do bimestre</th><th class="n">Faltas no semestre</th></tr></thead><tbody>${linhasD}</tbody></table>
${grafico ? `<h2>Vida acadêmica — média final por semestre desde o ingresso</h2><div class="graf">${grafico}</div>` : ''}
<h2>Histórico de atendimento</h2>
<table><thead><tr><th>Data</th><th>Observação e intervenção</th><th>Registrado por</th></tr></thead><tbody>${linhasH}</tbody></table>
<div class="assina"><div>Coordenação do curso</div><div>Aluno(a) — ciente</div></div>
<p class="nota">Documento gerado pelo Órbita com dados do sistema acadêmico (Edubox). Contém dados pessoais protegidos pela LGPD: uso interno da coordenação; entregar somente ao titular ou a quem tenha autorização para recebê-lo.</p>
</body></html>`;
  janela.document.open(); janela.document.write(html); janela.document.close();
  const logo = janela.document.querySelector('header img');
  const imprimirAgora = () => { janela.focus(); janela.print(); };
  if (logo && !logo.complete) { logo.onload = logo.onerror = () => setTimeout(imprimirAgora, 150); } else setTimeout(imprimirAgora, 250);
}

// ---------- ATA ----------
async function imprimirAta() {
  // a ata leva todos os alunos em atenção abertos, com notas, gráfico e histórico de atendimento
  const f = filtros();
  const lista = turma.alunos.map(a => situacaoAluno(a, faseSel)).filter(s => emAtencao(s, f));
  lista.forEach(s => abertos.add(String(s.aluno.id)));
  $('btn-ata').disabled = true;
  await Promise.all(lista.map(s => carregarAluno(chaveAluno(s.aluno))));
  $('btn-ata').disabled = false;
  render();
  setTimeout(() => window.print(), 200);
}

// ---------- DICA (mesmo padrão da Cobrança) ----------
function ligarDicas() {
  const d = document.createElement('div'); d.className = 'cad-dica'; document.body.appendChild(d);
  const mostrar = (alvo, x, y) => {
    const [t, ...l] = alvo.dataset.dica.split('|');
    d.innerHTML = `<div class="t">${esc(t)}</div>${l.map((x, i) => i === 0 ? `<b>${esc(x)}</b>` : `<div>${esc(x)}</div>`).join('')}`;
    d.style.opacity = 1;
    let L = x + 14, T = y + 14;
    if (L + d.offsetWidth > innerWidth - 8) L = x - d.offsetWidth - 14;
    if (T + d.offsetHeight > innerHeight - 8) T = y - d.offsetHeight - 14;
    d.style.left = `${L}px`; d.style.top = `${T}px`;
  };
  document.addEventListener('mousemove', (e) => { const a = e.target.closest && e.target.closest('[data-dica]'); if (a) mostrar(a, e.clientX, e.clientY); else d.style.opacity = 0; });
}

function wireEventos() {
  ligarDicas();
  $('seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]'); if (!b) return;
    seg = b.dataset.seg; document.querySelectorAll('#seg .aba').forEach(x => x.classList.toggle('ativa', x === b));
    semSel = ''; cursoSel = ''; turmaSel = ''; montarSemestres();
  });
  $('sel-sem').addEventListener('change', (e) => { semSel = e.target.value; montarFases(); montarCursos(); });
  $('sel-fase').addEventListener('change', (e) => { faseSel = e.target.value; abertos.clear(); if (turma) render(); });
  $('sel-curso').addEventListener('change', (e) => { cursoSel = e.target.value; turmaSel = ''; montarTurmas(); });
  $('sel-turma').addEventListener('change', (e) => { turmaSel = e.target.value; carregarTurma(); });
  $('f-todos').checked = false;   // o navegador às vezes lembra a caixa marcada ao recarregar
  for (const id of ['f-notas', 'f-faltas', 'f-todos']) $(id).addEventListener('input', () => turma && render());
  $('f-modo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-modo]'); if (!b) return;
    modo = b.dataset.modo;
    document.querySelectorAll('#f-modo .aba').forEach(x => { x.classList.toggle('ativa', x === b); x.setAttribute('aria-checked', x === b); });
    if (turma) render();
  });
  $('lista').addEventListener('click', (e) => {
    const g = e.target.closest('[data-registrar]'); if (g) { registrar(g.dataset.registrar, g); return; }
    const ed = e.target.closest('[data-editar]'); if (ed) { editando = ed.dataset.editar; render(); return; }
    const ca = e.target.closest('[data-cancelar]'); if (ca) { editando = null; render(); return; }
    const gr = e.target.closest('[data-gravar]'); if (gr) { gravarEdicao(gr.dataset.gravar, gr.dataset.aluno, gr); return; }
    const fi = e.target.closest('[data-ficha]'); if (fi) { imprimirFicha(fi.dataset.ficha); return; }
    const ex = e.target.closest('[data-excluir]'); if (ex) { excluir(ex.dataset.excluir, ex.dataset.aluno); return; }
    const c = e.target.closest('[data-abrir]'); if (!c) return;
    const id = String(c.dataset.abrir);
    abertos.has(id) ? abertos.delete(id) : abertos.add(id);
    render();
  });
  $('btn-ata').addEventListener('click', imprimirAta);
}
