import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';

// ==========================================================================
// Relatório CPA. Os números vêm de scripts/cpa-edubox-sync.js (Edubox -> Firestore) e batem com o
// que foi aplicado: mesmas dimensões, perguntas e opções de resposta, com a contagem de cada opção.
// Tudo que initApp usa de forma síncrona fica declarado aqui em cima (o initApp pode rodar antes do
// fim do arquivo quando há login em cache).
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'cpa';
const NIVEL_PADRAO = { adm_l2: 3, coordenador: 2, coord_medicina: 2 };
const ROT = ['Ótimo', 'Bom', 'Regular', 'Ruim', 'Não sei'];
const CORES = ['#15803d', '#84cc16', '#f59e0b', '#dc2626', '#cbd5e1'];
const EIXOS = { 1: 'Eixo 1 — Planejamento e avaliação institucional', 2: 'Eixo 2 — Desenvolvimento institucional', 3: 'Eixo 3 — Políticas acadêmicas', 4: 'Eixo 4 — Políticas de gestão', 5: 'Eixo 5 — Infraestrutura física' };
const SEGMENTOS = { GRA: 'Graduação', MED: 'Medicina' };
const PUBLICOS = { A: 'Alunos', P: 'Docentes', O: 'Funcionários (administrativo)' };
const MIN_AVALIACOES = 5;     // abaixo disso o resultado de um professor é pouco confiável
const CAPA_PADRAO = {
  ies: 'FATEC Ivaiporã (FATEC IVP)',
  mantenedora: 'União de Ensino Superior do Vale do Ivaí Ltda – UNESVI',
  endereco: 'Avenida Brasil, 45 – CEP 86870-000 – Ivaiporã/PR · Fone (43) 3472-0201 · www.fatecivaipora.com.br',
  atosLegais: 'Credenciamento EaD – Portaria nº 874, de 28 de novembro de 2025\nRecredenciamento – Portaria nº 878, de 28 de novembro de 2025',
  presidenteCpa: '', portariaCpa: '', membros: ''
};

let currentUser = null, currentUserNome = '', appInitialized = false, initializedRole = null;
let dados = null;            // resposta de /cpa/ciclos
let seg = 'GRA', cicloId = '', cursoSel = '', abaSel = 'resultado';
let rel = null, profs = null, profsPara = '';
let publicoSel = 'A', relPub = null;   // A = alunos, P = docentes, O = funcionários (administrativo)   // relatório do curso e professores carregados
let ordem = { campo: 'nome', dir: 1 }, filtroProf = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

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
    try { return await apiFetch(endpoint); } catch (err) { if (i === tentativas) throw err; await new Promise(r => setTimeout(r, 600)); }
  }
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('toast'); t.textContent = msg; t.className = `cpa-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- AUTH ----------
const cached = getCachedAuth();
if (cached) { currentUser = cached.user; initApp(cached.user, cached.role); }

onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); window.location.href = '../auth/login.html'; return; }
  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante', meuOverrides = null;
    try {
      const u = await apiFetchComRetentativa('/usuarios/me');
      role = u.role || 'visitante'; meuOverrides = u.permissoes || null; currentUserNome = u.name || user.displayName || '';
    } catch (e) { role = cached ? cached.role : 'visitante'; }
    setCachedAuth(user, role, token);
    let level = 1;
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
    if (!appInitialized || initializedRole !== role) { initializedRole = role; initApp(user, role); }
    if (!dados) carregar();
  } catch (err) { console.error('Erro na revalidação de auth:', err); }
});

function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true; initializedRole = role;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); window.location.href = '../auth/login.html'; });
  $('app').classList.remove('hidden');
  wireEventos();
}

// ---------- FORMATAÇÃO ----------
const fmt1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtPct = (n) => (n === null || n === undefined ? '–' : fmt1(n) + '%');
const fmtInt = (n) => Number(n || 0).toLocaleString('pt-BR');
const MINUSC = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'as', 'os', 'para', 'na', 'no', 'nas', 'nos', 'ao', 'aos', 'com', 'à']);
const SIGLAS = new Set(['EAD', 'TCC', 'PIE', 'CPA', 'AVA', 'FATEC', 'UTI', 'SINAES', 'PDI', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'MED']);
// o Edubox guarda tudo em MAIÚSCULAS: mostra em formato de título/frase sem mudar as palavras
function titulo(s) {
  return String(s || '').toLowerCase().split(/(\s+|[-–:/()])/).map((p, i) => {
    if (!p || /^\s+$/.test(p) || /^[-–:/()]$/.test(p)) return p;
    const u = p.toUpperCase();
    if (SIGLAS.has(u)) return u;
    if (i > 0 && MINUSC.has(p)) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join('');
}
const frase = (s) => String(s || '').toLowerCase().replace(/(^\s*[a-zà-ú])/, m => m.toUpperCase()).replace(/\b(cpa|ava|ead|fatec|tcc|sinaes|pdi)\b/gi, m => m.toUpperCase());
const somaDist = (lista) => [0, 1, 2, 3, 4].map(i => lista.reduce((s, d) => s + (d[i] || 0), 0));
const validas = (d) => d[0] + d[1] + d[2] + d[3];
const satDe = (d) => (validas(d) ? Math.round((d[0] + d[1]) / validas(d) * 1000) / 10 : null);
const semestreNorm = (s) => String(s).replace('/', '.').replace('-', '.');

// ---------- DADOS ----------
async function carregar() {
  try {
    await auth.authStateReady();
    if (auth.currentUser) currentUser = auth.currentUser;
    dados = await apiFetch('/cpa/ciclos');
    const temGRA = dados.ciclos.some(c => c.segmento === 'GRA');
    seg = temGRA ? 'GRA' : (dados.ciclos[0] ? dados.ciclos[0].segmento : 'GRA');
    escolherCiclo();
    renderTudo();
    if (cursoSel) await carregarCurso();
  } catch (err) {
    mostrarVazio(`Não foi possível carregar: ${esc(err.message)}`);
  }
}
const ciclosDoSegmento = () => dados.ciclos.filter(c => c.segmento === seg);
function escolherCiclo() {
  const lista = ciclosDoSegmento();
  if (!lista.find(c => c.id === cicloId)) cicloId = lista[0] ? lista[0].id : '';
  const c = lista.find(x => x.id === cicloId);
  const cursos = c ? c.cursos : [];
  cursoSel = dados.escopo === 'todos' ? 'IES' : (cursos[0] ? cursos[0].codcur : '');
}
const cicloAtual = () => dados && dados.ciclos.find(c => c.id === cicloId);
const capa = () => ({ ...CAPA_PADRAO, ...(dados && dados.capa ? dados.capa : {}) });

async function carregarCurso() {
  const c = cicloAtual();
  if (!c || !cursoSel) return;
  $('painel-resultado').innerHTML = '<p class="cpa-sub">Carregando…</p>';
  profs = null; profsPara = ''; relPub = null;
  try {
    rel = await apiFetch(`/cpa/relatorio/${c.codavaAluno}/${encodeURIComponent(cursoSel)}`);
    renderCorpo();
  } catch (err) {
    rel = null;
    $('painel-resultado').innerHTML = `<div class="cpa-aviso">${esc(err.message)}</div>`;
  }
}
async function carregarProfessores() {
  const c = cicloAtual();
  const chave = `${c.codavaAluno}|${cursoSel === 'IES' ? 'TODOS' : cursoSel}`;
  if (profs && profsPara === chave) return;
  $('painel-professores').innerHTML = '<p class="cpa-sub">Carregando professores…</p>';
  const r = await apiFetch(`/cpa/professores/${c.codavaAluno}/${cursoSel === 'IES' ? 'TODOS' : encodeURIComponent(cursoSel)}`);
  profs = r.professores; profsPara = chave;
}

function mostrarVazio(html) { $('conteudo').classList.add('hidden'); $('vazio').classList.remove('hidden'); $('vazio').innerHTML = html; }

// ---------- RENDER GERAL ----------
function renderTudo() {
  document.querySelectorAll('#seg-segmento button').forEach(b => {
    b.classList.toggle('ativo', b.dataset.seg === seg);
    b.disabled = !dados.ciclos.some(c => c.segmento === b.dataset.seg);
    b.title = b.disabled ? 'Sem campanha disponível para você neste segmento' : '';
  });
  const lista = ciclosDoSegmento();
  $('sel-ciclo').innerHTML = lista.map(c => `<option value="${esc(c.id)}" ${c.id === cicloId ? 'selected' : ''}>${esc(c.semestre.replace('-', '/'))}${c.aberta ? ' (aberta)' : ''}</option>`).join('');
  $('subtitulo').textContent = dados.escopo === 'todos'
    ? 'Resultado da avaliação aplicada no Edubox, por curso e por professor — Graduação e Medicina.'
    : 'Resultado da avaliação dos seus cursos aplicada no Edubox, com o desempenho de cada professor.';

  const maisNovo = dados.ciclos.map(c => semestreNorm(c.semestre)).sort().pop();
  const aviso = $('aviso-segmento');
  const c = cicloAtual();
  if (c && maisNovo && semestreNorm(c.semestre) < maisNovo) {
    aviso.classList.remove('hidden');
    aviso.innerHTML = `Não há campanha de <b>${SEGMENTOS[seg]}</b> em ${maisNovo.replace('.', '/')} no Edubox. O último ciclo disponível para este segmento é <b>${esc(c.semestre.replace('-', '/'))}</b>.`;
  } else aviso.classList.add('hidden');

  if (!c) { $('kpis').innerHTML = ''; $('cursos').innerHTML = ''; mostrarVazio(`Nenhuma campanha de ${SEGMENTOS[seg]} disponível.`); return; }
  $('vazio').classList.add('hidden'); $('conteudo').classList.remove('hidden');
  renderKpis(); renderCursos(); renderAbas();
}

function renderKpis() {
  const c = cicloAtual();
  const p = c.participacao || { ativos: 0, responderam: 0 };
  const pct = p.ativos ? Math.round(p.responderam / p.ativos * 1000) / 10 : 0;
  const d = rel ? rel.dimensoes : [];
  const perguntas = d.reduce((s, x) => s + x.perguntas.length, 0);
  const respostas = d.reduce((s, x) => s + x.perguntas.reduce((a, q) => a + q.dist.reduce((m, n) => m + n, 0), 0), 0);
  $('kpis').innerHTML = `
    <div class="cpa-kpi"><b>${fmtPct(pct)}</b><span>de participação (${fmtInt(p.responderam)} de ${fmtInt(p.ativos)} alunos ativos)</span><div class="cpa-barra"><i style="width:${Math.min(100, pct)}%"></i></div></div>
    <div class="cpa-kpi"><b>${c.cursos.length}</b><span>${c.cursos.length === 1 ? 'curso' : 'cursos'} no semestre ${esc(c.semestre.replace('-', '/'))}</span></div>
    <div class="cpa-kpi"><b>${rel ? fmtInt(respostas) : '–'}</b><span>respostas ${rel ? 'no recorte selecionado (' + perguntas + ' perguntas)' : ''}</span></div>
    <div class="cpa-kpi"><b style="font-size:1.05rem">${esc(c.campanhaAluno)}</b><span>campanha ${c.codavaAluno} · ${c.aberta ? 'ainda aberta' : 'encerrada'}</span></div>`;
}

function renderCursos() {
  const c = cicloAtual();
  const ies = dados.escopo === 'todos'
    ? `<button type="button" class="cpa-curso ${cursoSel === 'IES' ? 'ativo' : ''}" data-curso="IES">Visão geral — ${SEGMENTOS[seg]}</button>` : '';
  $('cursos').innerHTML = ies + c.cursos.map(x => `<button type="button" class="cpa-curso ${cursoSel === x.codcur ? 'ativo' : ''}" data-curso="${esc(x.codcur)}">${esc(nomeCurso(x.nome))}<small>${x.ativos ? Math.round(x.responderam / x.ativos * 100) : 0}%</small></button>`).join('');
}
const nomeCurso = (n) => titulo(String(n).replace(/^(BACHARELADO|LICENCIATURA|SUPERIOR DE TECNOLOGIA) EM /i, '').replace(/ - FORMAÇÃO.*/i, ''));

function renderAbas() {
  document.querySelectorAll('.cpa-aba').forEach(b => b.classList.toggle('ativa', b.dataset.aba === abaSel));
  $('painel-resultado').classList.toggle('ativo', abaSel === 'resultado');
  $('painel-professores').classList.toggle('ativo', abaSel === 'professores');
  if (abaSel === 'professores') renderProfessores();
}
function renderCorpo() {
  renderKpis();
  if (abaSel === 'resultado') renderResultado(); else renderProfessores();
}

// ---------- BLOCOS DE GRÁFICO ----------
function pilha(dist, marca) {
  const v = validas(dist);
  if (!v) return '<div class="cpa-pilha" aria-label="Sem respostas"></div>';
  const seg_ = [0, 1, 2, 3].map(i => {
    if (!dist[i]) return '';
    const p = dist[i] / v * 100;
    return `<span style="width:${p}%;background:${CORES[i]}" title="${ROT[i]}: ${fmtInt(dist[i])} (${fmt1(p)}%)">${p >= 9 ? Math.round(p) + '%' : ''}</span>`;
  }).join('');
  const m = marca === null || marca === undefined ? '' : `<i class="marca" style="left:${marca}%" title="Satisfação de referência: ${fmt1(marca)}%"></i>`;
  return `<div class="cpa-pilha" role="img" aria-label="Distribuição das respostas">${seg_}${m}</div>`;
}
function contagem(dist) {
  return `<div class="cpa-contagem">${ROT.map((r, i) => `<span>${r} <b>${fmtInt(dist[i])}</b></span>`).join('')}<span class="cpa-sat">Satisfação (Ótimo + Bom): ${fmtPct(satDe(dist))}</span></div>`;
}
const legenda = (comMarca) => `<div class="cpa-leg">${[0, 1, 2, 3].map(i => `<span><i style="background:${CORES[i]}"></i>${ROT[i]}</span>`).join('')}<span>“Não sei” fica fora da base</span>${comMarca ? '<span><i style="background:#0f172a;width:3px;height:12px;border-radius:0"></i>' + comMarca + '</span>' : ''}</div>`;
function perguntaHtml(p, marca) {
  return `<div class="cpa-perg"><div class="cpa-perg-txt">${esc(frase(p.texto))}</div>${pilha(p.dist, marca)}${contagem(p.dist)}</div>`;
}
function barraNota(rotulo, nota, n, ref) {
  const w = nota === null || nota === undefined ? 0 : Math.max(0, Math.min(10, nota)) * 10;
  return `<div class="cpa-nota"><span>${esc(rotulo)}</span><div class="trilho"><i style="width:${w}%"></i>${ref !== null && ref !== undefined ? `<em style="left:${ref * 10}%" title="Média do curso: ${fmt1(ref)}"></em>` : ''}</div><span class="v">${fmt1(nota)}${n ? `<small class="cpa-meta"> (${fmtInt(n)})</small>` : ''}</span></div>`;
}

// ---------- RESULTADO (curso / IES) ----------
function metodologiaHtml(c, r) {
  const p = r.participacao || { ativos: 0, responderam: 0 };
  const pub = r.publico || 'A';
  if (pub !== 'A') {
    const meta = pub === 'P' ? c.docentes : c.administrativo;
    const univ = p.universo ? `${fmtInt(p.responderam)} de ${fmtInt(p.universo)} professores avaliados pelos estudantes no semestre (${fmtPct(Math.round(p.responderam / p.universo * 1000) / 10)})` : `${fmtInt(p.responderam)} respondentes (universo de funcionários não informado pelo Edubox)`;
    const cargos = (p.porCargo || []).map(x => `${esc(titulo(x.cargo))}: ${fmtInt(x.n)}`).join(' · ');
    return `
    <h3>Metodologia</h3>
    <div class="cpa-ficha">
      <div><small>Instrumento</small>Questionário eletrônico aplicado pelo sistema acadêmico Edubox — campanha “${esc(r.campanha)}” (código ${r.codava})</div>
      <div><small>Público</small>${pub === 'P' ? 'Professores' : 'Funcionários do administrativo'} — ${esc(c.semestre.replace('-', '/'))} · ${SEGMENTOS[c.segmento]}${r.codcur === 'IES' ? '' : ' · avaliação do curso e do coordenador: ' + esc(nomeCurso(r.nome))}</div>
      <div><small>Participação</small>${univ}</div>
      <div><small>Situação da campanha</small>${meta && meta.aberta ? 'ainda aberta' : 'encerrada'}</div>
      ${cargos ? `<div><small>Respondentes por cargo (cadastro do Edubox)</small>${cargos}</div>` : ''}
    </div>
    <ul class="cpa-meta" style="margin-left:1.1rem">
      <li><b>Satisfação</b> = (Ótimo + Bom) ÷ (Ótimo + Bom + Regular + Ruim). “Não sei / não conheço” não entra na base.</li>
      <li><b>Nota (0–10)</b> é a que o próprio respondente atribuiu a cada dimensão, como registrada no Edubox; valores fora de 0–10 foram desconsiderados.</li>
      <li>A resposta é individual e o relatório não identifica quem respondeu: apenas contagens, notas e comentários.</li>
    </ul>`;
  }
  return `
    <h3>Metodologia</h3>
    <div class="cpa-ficha">
      <div><small>Instrumento</small>Questionário eletrônico aplicado pelo sistema acadêmico Edubox — campanha “${esc(c.campanhaAluno)}” (código ${c.codavaAluno})</div>
      <div><small>Público</small>Estudantes com matrícula ativa em ${esc(c.semestre.replace('-', '/'))} — ${SEGMENTOS[c.segmento]}${r.codcur === 'IES' ? '' : ' · ' + esc(nomeCurso(r.nome))}</div>
      <div><small>Participação</small>${fmtInt(p.responderam)} de ${fmtInt(p.ativos)} estudantes ativos (${fmtPct(p.ativos ? Math.round(p.responderam / p.ativos * 1000) / 10 : 0)})</div>
      <div><small>Escala das respostas</small>Ótimo · Bom · Regular · Ruim · Não sei / não conheço</div>
    </div>
    <ul class="cpa-meta" style="margin-left:1.1rem">
      <li><b>Satisfação</b> = (Ótimo + Bom) ÷ (Ótimo + Bom + Regular + Ruim). “Não sei / não conheço” não entra na base.</li>
      <li><b>Nota (0–10)</b> é a que o próprio respondente atribuiu a cada dimensão (ou disciplina), como registrada no Edubox; valores fora de 0–10 foram desconsiderados.</li>
      <li>A contagem de cada opção é a registrada no Edubox, sem ponderação. O relatório não contém identificação de estudantes.</li>
      <li>A classificação dos comentários (elogio, neutro, atenção) é automática, por palavras-chave, e serve só para organizar a leitura.</li>
    </ul>`;
}

function resumoEixos(r) {
  const linhas = [];
  const porEixo = new Map();
  r.dimensoes.forEach(d => { const k = d.eixo || 0; (porEixo.get(k) || porEixo.set(k, []).get(k)).push(d); });
  [...porEixo.keys()].sort().forEach(k => {
    linhas.push(`<tr><td colspan="5" style="background:#eff6ff;font-weight:700;color:#1e3a8a">${esc(EIXOS[k] || 'Outras dimensões')}</td></tr>`);
    porEixo.get(k).forEach(d => {
      const dist = somaDist(d.perguntas.map(p => p.dist));
      linhas.push(`<tr><td>${esc(titulo(d.nome))}</td><td class="num">${fmtInt(validas(dist))}</td><td class="num">${fmtPct(satDe(dist))}</td><td class="num">${fmt1(d.nota.media)}</td><td class="num">${fmtInt(d.nota.n)}</td></tr>`);
    });
  });
  return `<div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th>Dimensão</th><th class="num">Respostas válidas</th><th class="num">Satisfação</th><th class="num">Nota média (0–10)</th><th class="num">Notas atribuídas</th></tr></thead><tbody>${linhas.join('')}</tbody></table></div>`;
}

function destaquesHtml(r) {
  const todas = r.dimensoes.flatMap(d => d.perguntas.map(p => ({ ...p, dim: d.nome }))).filter(p => p.validas >= 30 && p.satisfacao !== null);
  if (todas.length < 6) return '';
  const ord = [...todas].sort((a, b) => b.satisfacao - a.satisfacao);
  const li = (p) => `<li>${esc(frase(p.texto).slice(0, 150))}${p.texto.length > 150 ? '…' : ''} — <b>${fmtPct(p.satisfacao)}</b></li>`;
  return `<h3>Pontos fortes e pontos de atenção</h3>
    <p class="cpa-meta">As três perguntas com maior e com menor satisfação (mínimo de 30 respostas válidas).</p>
    <div class="cpa-destaques"><div><h4>Maior satisfação</h4><ul>${ord.slice(0, 3).map(li).join('')}</ul></div><div><h4>Menor satisfação</h4><ul>${ord.slice(-3).reverse().map(li).join('')}</ul></div></div>`;
}

// comentários agrupados por cor/classe (atenção, neutros, elogios), sem misturar; com a disciplina de origem quando houver
function comentariosPorCor(cs, comDisciplina) {
  const grupos = [['atencao', 'Pontos de atenção'], ['neutro', 'Neutros'], ['bom', 'Elogios']];
  return grupos.map(([k, rot]) => {
    const l = cs.filter(c => c.classe === k);
    if (!l.length) return '';
    return `<h5 class="cpa-com-grupo ${k}">${rot} <span class="cpa-meta">(${l.length})</span></h5>${l.map(c => `<div class="cpa-coment ${c.classe}">${comDisciplina && c.disciplina ? `<small class="cpa-meta">${esc(titulo(c.disciplina))}</small><br>` : ''}${esc(c.texto)}</div>`).join('')}`;
  }).join('');
}
function comentariosHtml(d, limite, completo) {
  const cs = d.comentarios || [];
  if (!cs.length) return '';
  const n = (k) => cs.filter(c => c.classe === k).length;
  const chips = `<div class="cpa-chips"><span class="cpa-chip">${cs.length} comentários</span><span class="cpa-chip bom">${n('bom')} elogios</span><span class="cpa-chip">${n('neutro')} neutros</span><span class="cpa-chip atencao">${n('atencao')} de atenção</span></div>`;
  const itens = comentariosPorCor(cs, true);   // no PDF e na tela vão todos os comentários
  return completo
    ? `<details><summary class="cpa-meta" style="cursor:pointer">Comentários dos estudantes (${cs.length})</summary>${chips}${itens}</details>`
    : `<h4>Comentários dos estudantes</h4>${chips}${itens}`;
}

function dimensaoHtml(d, completo) {
  const dist = somaDist(d.perguntas.map(p => p.dist));
  return `<h3>${esc(titulo(d.nome))} <span class="cpa-meta">· nota média ${fmt1(d.nota.media)} (${fmtInt(d.nota.n)} notas) · satisfação ${fmtPct(satDe(dist))}</span></h3>
    ${d.perguntas.length ? legenda('') + d.perguntas.map(p => perguntaHtml(p, null)).join('') : '<p class="cpa-meta">Sem perguntas nesta dimensão.</p>'}
    ${comentariosHtml(d, 5, completo)}`;
}

function cabHtml(titulo_, sub) {
  return `<div class="cpa-cab"><img src="/img/fateclogoazul.png" alt="FATEC Ivaiporã"><div><h2>${esc(titulo_)}</h2><p>${esc(sub)}</p></div></div>`;
}

function relatorioHtml(r, { completo = true, comCapa = false } = {}) {
  const c = cicloAtual();
  const nome = r.codcur === 'IES' ? `${SEGMENTOS[c.segmento]} — todos os cursos` : nomeCurso(r.nome);
  const tabelaCursos = r.codcur === 'IES' && (r.publico || 'A') === 'A' ? `<h3>Participação por curso</h3><div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th>Curso</th><th class="num">Alunos ativos</th><th class="num">Responderam</th><th class="num">Participação</th></tr></thead><tbody>${
    c.cursos.map(x => `<tr><td>${esc(nomeCurso(x.nome))}</td><td class="num">${fmtInt(x.ativos)}</td><td class="num">${fmtInt(x.responderam)}</td><td class="num">${fmtPct(x.ativos ? Math.round(x.responderam / x.ativos * 1000) / 10 : 0)}</td></tr>`).join('')
  }<tr><td><b>Total</b></td><td class="num"><b>${fmtInt(r.participacao.ativos)}</b></td><td class="num"><b>${fmtInt(r.participacao.responderam)}</b></td><td class="num"><b>${fmtPct(r.participacao.ativos ? Math.round(r.participacao.responderam / r.participacao.ativos * 1000) / 10 : 0)}</b></td></tr></tbody></table></div>` : '';
  return `${comCapa ? `<div class="cpa-pagina">${capaHtml(c, `Relatório de autoavaliação — ${SEGMENTOS[c.segmento]}`)}</div>` : ''}
    <div class="cpa-folha ${comCapa ? '' : ''}">
      ${cabHtml(`Relatório CPA ${c.semestre.replace('-', '/')} — ${(r.publico || 'A') === 'A' ? '' : PUBLICOS[r.publico] + ' — '}${nome}`, `${r.campanha || c.campanhaAluno} · FATEC Ivaiporã`)}
      ${metodologiaHtml(c, r)}
      ${tabelaCursos}
      <h3>Resultado por eixo e dimensão</h3>
      ${resumoEixos(r)}
      ${destaquesHtml(r)}
      ${r.dimensoes.map(d => dimensaoHtml(d, completo)).join('')}
      <p class="cpa-meta" style="margin-top:1.5rem">Emitido em ${esc(new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }))}${currentUserNome ? ' por ' + esc(currentUserNome) : ''}. Dados: Edubox, campanha ${r.codava}, atualizados em ${esc(new Date(c.atualizadoEm).toLocaleString('pt-BR'))}.</p>
      ${comCapa ? assinaturaHtml() : ''}
    </div>`;
}

const temOutrosPublicos = (c) => dados.escopo === 'todos' && !!(c.docentes || c.administrativo);
function seletorPublico(c) {
  if (!temOutrosPublicos(c)) return '';
  return `<div class="cpa-seg cpa-no-print" id="seg-publico" role="tablist" aria-label="Público" style="margin-bottom:0.8rem">${Object.entries(PUBLICOS)
    .filter(([k]) => k === 'A' || (k === 'P' && c.docentes) || (k === 'O' && c.administrativo))
    .map(([k, v]) => `<button type="button" data-pub="${k}" class="${publicoSel === k ? 'ativo' : ''}" role="tab">${v}</button>`).join('')}</div>`;
}
async function carregarPublico() {
  const c = cicloAtual(); const meta = publicoSel === 'P' ? c.docentes : c.administrativo;
  relPub = undefined;
  try { relPub = await apiFetch(`/cpa/relatorio/${meta.codava}/${encodeURIComponent(cursoSel)}`); }
  catch (err) { relPub = { erro: cursoSel === 'IES' ? err.message : 'Este curso não tem respostas nesta campanha (o público respondeu apenas sobre a instituição).' }; }
  renderResultado();
}
function renderResultado() {
  if (!rel) return;
  const c = cicloAtual();
  const ehIES = rel.codcur === 'IES';
  if (publicoSel !== 'A' && !temOutrosPublicos(c)) publicoSel = 'A';
  if (publicoSel !== 'A') {
    if (relPub === null) { $('painel-resultado').innerHTML = seletorPublico(c) + '<p class="cpa-sub">Carregando…</p>'; carregarPublico(); return; }
    if (relPub === undefined) return;
    $('painel-resultado').innerHTML = seletorPublico(c) + (relPub.erro
      ? `<div class="cpa-aviso">${esc(relPub.erro)}</div>`
      : `<div class="cpa-acoes cpa-no-print"><button type="button" class="cpa-btn cpa-btn-pri" id="btn-imprimir-pub">Imprimir este resultado (PDF)</button></div>${relatorioHtml(relPub, { completo: true })}`);
    return;
  }
  $('painel-resultado').innerHTML = `
    ${seletorPublico(c)}
    <div class="cpa-acoes cpa-no-print">
      ${ehIES && dados.podeEditarCapa ? '<button type="button" class="cpa-btn cpa-btn-sec" id="btn-capa">Dados da capa</button>' : ''}
      <button type="button" class="cpa-btn cpa-btn-pri" id="btn-imprimir-rel">${ehIES ? 'Imprimir relatório institucional (PDF)' : 'Imprimir relatório do curso (PDF)'}</button>
      ${ehIES && temOutrosPublicos(c) ? '<button type="button" class="cpa-btn cpa-btn-pri" id="btn-imprimir-inst">Relatório institucional completo — alunos, docentes e funcionários (PDF)</button>' : ''}
    </div>
    ${relatorioHtml(rel, { completo: true })}`;
}

// satisfação por dimensão (número SINAES) somando os grupos de mesmo número
function porNumero(r) {
  const m = new Map();
  r.dimensoes.forEach(d => {
    if (!d.numero) return;
    const o = m.get(d.numero) || { nome: d.nome, dist: [0, 0, 0, 0, 0] };
    d.perguntas.forEach(p => p.dist.forEach((v, i) => { o.dist[i] += v; }));
    m.set(d.numero, o);
  });
  return m;
}
function quadroConsolidadoHtml(rels) {
  const mapas = rels.map(r => ({ pub: r.publico || 'A', m: porNumero(r) }));
  const nums = [...new Set(mapas.flatMap(x => [...x.m.keys()]))].sort((a, b) => a - b);
  const nomeDe = (n) => { for (const x of mapas) if (x.m.has(n)) return x.m.get(n).nome.replace(/^\d+\.\s*/, ''); return ''; };
  const cel = (x, n) => { const o = x.m.get(n); if (!o || !validas(o.dist)) return '<td class="num">—</td><td class="num">—</td>'; return `<td class="num">${fmtInt(validas(o.dist))}</td><td class="num">${fmtPct(satDe(o.dist))}</td>`; };
  return `<h3>Quadro consolidado por dimensão (SINAES)</h3>
    <p class="cpa-meta">Satisfação = (Ótimo + Bom) ÷ respostas válidas, por público. “—” indica que o público não foi perguntado sobre a dimensão. Cada público respondeu a um questionário próprio.</p>
    <div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th rowspan="2">Dimensão</th>${mapas.map(x => `<th colspan="2" class="num">${esc(PUBLICOS[x.pub])}</th>`).join('')}</tr><tr>${mapas.map(() => '<th class="num">Resp.</th><th class="num">Satisf.</th>').join('')}</tr></thead><tbody>${
      nums.map(n => `<tr><td>${n}. ${esc(titulo(nomeDe(n)))}</td>${mapas.map(x => cel(x, n)).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function imprimirInstitucional() {
  const c = cicloAtual();
  try {
    toast('Reunindo os resultados dos três públicos…');
    const rels = [rel];
    for (const meta of [c.docentes, c.administrativo]) if (meta) rels.push(await apiFetch(`/cpa/relatorio/${meta.codava}/IES`));
    const partes = rels.map(r => `<div class="cpa-pagina">${relatorioHtml(r, { completo: false, comCapa: false })}</div>`);
    const consolidado = `<div class="cpa-pagina"><div class="cpa-folha">${cabHtml(`Relatório CPA ${c.semestre.replace('-', '/')} — síntese institucional`, 'FATEC Ivaiporã')}${quadroConsolidadoHtml(rels)}</div></div>`;
    imprimir(`<div class="cpa-pagina">${capaHtml(c, `Relatório de autoavaliação — ${SEGMENTOS[c.segmento]}`)}</div>${consolidado}${partes.join('')}<div class="cpa-folha">${assinaturaHtml()}</div>`);
  } catch (err) { toast(err.message, 'erro'); }
}

// ---------- CAPA E ASSINATURA ----------
function capaHtml(c, subtitulo) {
  const k = capa();
  const membros = String(k.membros || '').split('\n').map(x => x.trim()).filter(Boolean);
  return `<div class="cpa-capa">
    <img src="/img/fateclogoazul.png" alt="FATEC Ivaiporã">
    <h2>${esc(k.ies)}</h2>
    <p class="peq">${esc(k.mantenedora)}</p>
    <h1 style="margin-top:2.5rem">Comissão Própria de Avaliação (CPA)</h1>
    <h2>${esc(subtitulo)}</h2>
    <h2>Ciclo ${esc(c.semestre.replace('-', '/'))}</h2>
    <p class="peq" style="margin-top:2rem">${esc(k.atosLegais).replace(/\n/g, '<br>')}</p>
    <p class="peq">${esc(k.endereco)}</p>
    ${k.presidenteCpa || k.portariaCpa || membros.length ? `<div class="peq" style="margin-top:2rem"><b>Comissão Própria de Avaliação</b>${k.portariaCpa ? '<br>' + esc(k.portariaCpa) : ''}${k.presidenteCpa ? '<br>Presidente: ' + esc(k.presidenteCpa) : ''}${membros.length ? '<br>' + membros.map(esc).join('<br>') : ''}</div>` : '<p class="peq" style="margin-top:2rem;color:#b45309">[Preencher a composição da CPA e a portaria de nomeação em “Dados da capa”]</p>'}
    <p class="peq" style="margin-top:2rem">Emitido em ${esc(new Date().toLocaleDateString('pt-BR', { dateStyle: 'long' }))}</p>
  </div>`;
}
function assinaturaHtml() {
  const k = capa();
  return `<div class="cpa-assina"><div>${esc(k.presidenteCpa || 'Presidente da CPA')}<br>Presidente da CPA</div><div>Direção da instituição</div></div>`;
}

// ---------- PROFESSORES ----------
const reprovaPoucas = (p) => (p.respondentes ?? p.avaliacoes) < MIN_AVALIACOES;
function renderProfessores() {
  const c = cicloAtual();
  if (!profs || profsPara !== `${c.codavaAluno}|${cursoSel === 'IES' ? 'TODOS' : cursoSel}`) {
    carregarProfessores().then(renderProfessores).catch(err => { $('painel-professores').innerHTML = `<div class="cpa-aviso">${esc(err.message)}</div>`; });
    return;
  }
  const todos = cursoSel === 'IES';
  const termo = filtroProf.trim().toLowerCase();
  let lista = profs.filter(p => !termo || p.nome.toLowerCase().includes(termo) || (p.curso || '').toLowerCase().includes(termo));
  const val = (p) => ({ nome: p.nome.toLowerCase(), curso: (p.curso || '').toLowerCase(), avaliacoes: p.respondentes ?? p.avaliacoes, nota: p.nota.media ?? -1, sat: p.satisfacao ?? -1 }[ordem.campo]);
  lista = [...lista].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * ordem.dir);
  const th = (campo, rot, cls = '') => `<th class="ord ${cls}" data-ord="${campo}">${rot}${ordem.campo === campo ? (ordem.dir === 1 ? ' ▲' : ' ▼') : ''}</th>`;
  const poucas = profs.filter(reprovaPoucas).length;
  $('painel-professores').innerHTML = `
    <div class="cpa-barra-filtros cpa-no-print">
      <input class="cpa-busca" id="busca-prof" type="search" placeholder="Buscar professor${todos ? ' ou curso' : ''}…" value="${esc(filtroProf)}" aria-label="Buscar professor">
      <span class="cpa-acoes" style="margin:0">
        <span class="cpa-meta">${lista.length} de ${profs.length} professores</span>
        <button type="button" class="cpa-btn cpa-btn-sec" id="btn-csv-prof">Baixar CSV</button>
        ${todos ? '' : `<button type="button" class="cpa-btn cpa-btn-sec" id="btn-pdf-todos">PDF único com todos (${profs.length})</button><button type="button" class="cpa-btn cpa-btn-pri" id="btn-zip-profs">Baixar PDFs separados (.zip)</button>`}
      </span>
    </div>
    ${poucas ? `<div class="cpa-aviso cpa-no-print">${poucas} professor(es) avaliado(s) por menos de ${MIN_AVALIACOES} estudantes: o resultado é pouco confiável e aparece marcado.</div>` : ''}
    <div class="cpa-folha" style="padding:0"><div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr>
      ${th('nome', 'Professor')}${todos ? th('curso', 'Curso') : ''}${th('avaliacoes', 'Estudantes que avaliaram', 'num')}${th('nota', 'Nota média (0–10)', 'num')}${th('sat', 'Satisfação', 'num')}<th>Distribuição</th><th></th></tr></thead><tbody>
      ${lista.map((p, i) => `<tr class="clicavel" data-prof="${esc(p.codcur + '|' + p.codpro)}"><td><b>${esc(titulo(p.nome))}</b> ${reprovaPoucas(p) ? '<span class="cpa-tag">poucos estudantes</span>' : ''}</td>${todos ? `<td>${esc(nomeCurso(p.curso))}</td>` : ''}<td class="num">${fmtInt(p.respondentes ?? p.avaliacoes)}</td><td class="num">${fmt1(p.nota.media)}</td><td class="num">${fmtPct(p.satisfacao)}</td><td style="min-width:180px">${pilha(p.dist, null)}</td><td class="num"><button type="button" class="cpa-btn cpa-btn-sec cpa-btn-mini" data-pdf="${esc(p.codcur + '|' + p.codpro)}">PDF</button></td></tr>`).join('') || `<tr><td colspan="7" class="cpa-meta">Nenhum professor encontrado.</td></tr>`}
    </tbody></table></div></div>`;
}

const achaProf = (chave) => profs.find(p => `${p.codcur}|${p.codpro}` === chave);

// referências do curso para comparar o professor: nota média e satisfação nas dimensões por disciplina
function baseDoCurso(p) {
  const r = (rel && rel.codcur === p.codcur) ? rel : null;
  if (!r) return { notaCurso: null, satCurso: null, notaPorDim: {} };
  const dd = r.dimensoes.filter(d => d.tipo === 'D' && d.nota.n);
  const n = dd.reduce((s, d) => s + d.nota.n, 0);
  const notaCurso = n ? Math.round(dd.reduce((s, d) => s + d.nota.media * d.nota.n, 0) / n * 100) / 100 : null;
  const satCurso = satDe(somaDist(r.dimensoes.filter(d => d.tipo === 'D').flatMap(d => d.perguntas.map(q => q.dist))));
  return { notaCurso, satCurso, notaPorDim: Object.fromEntries(dd.map(d => [d.codgru, d.nota.media])) };
}

function professorHtml(p) {
  const c = cicloAtual();
  const b = baseDoCurso(p);
  const grupos = [];
  p.perguntas.forEach(q => { let g = grupos.find(x => x.dim === q.dim); if (!g) { g = { dim: q.dim, itens: [] }; grupos.push(g); } g.itens.push(q); });
  const cs = p.comentarios || [];
  const nc = (k) => cs.filter(x => x.classe === k).length;
  return `<div class="cpa-folha">
    ${cabHtml(`Avaliação docente — CPA ${c.semestre.replace('-', '/')}`, `${c.campanhaAluno} · FATEC Ivaiporã`)}
    <h3 style="margin-top:0;font-size:1.25rem;color:var(--text-main)">${esc(titulo(p.nome))}</h3>
    <p class="cpa-meta">${esc(nomeCurso(p.curso))} · ${SEGMENTOS[p.segmento]}</p>
    <div class="cpa-ficha" style="margin-top:0.8rem">
      <div><small>Estudantes que avaliaram</small><b style="font-size:1.4rem">${fmtInt(p.respondentes ?? p.avaliacoes)}</b><span class="cpa-meta">${fmtInt(p.avaliacoes)} notas atribuídas</span>${reprovaPoucas(p) ? '<span class="cpa-tag" style="width:fit-content">poucos estudantes</span>' : ''}</div>
      <div><small>Nota média (0–10)</small><b style="font-size:1.4rem">${fmt1(p.nota.media)}</b><span class="cpa-meta">${b.notaCurso !== null ? 'média do curso: ' + fmt1(b.notaCurso) : ''}</span></div>
      <div><small>Satisfação (Ótimo + Bom)</small><b style="font-size:1.4rem">${fmtPct(p.satisfacao)}</b><span class="cpa-meta">${b.satCurso !== null ? 'média do curso: ' + fmtPct(b.satCurso) : ''}</span></div>
      <div><small>Disciplinas avaliadas</small><b style="font-size:1.4rem">${p.disciplinas.length}</b></div>
    </div>
    ${reprovaPoucas(p) ? `<div class="cpa-aviso">Menos de ${MIN_AVALIACOES} estudantes avaliaram: leia este resultado com cautela, pois uma ou duas respostas pesam muito.</div>` : ''}
    <h3>Distribuição de todas as respostas</h3>
    ${legenda(b.satCurso !== null ? 'média de satisfação do curso' : '')}${pilha(p.dist, b.satCurso)}${contagem(p.dist)}
    ${p.dimensoes.length ? `<h3>Nota por dimensão <span class="cpa-meta">· a marca é a média do curso</span></h3>${p.dimensoes.map(d => barraNota(titulo(d.nome.replace(/^\d+\.\s*/, '')), d.nota, d.n, b.notaPorDim[d.codgru] ?? null)).join('')}` : ''}
    <h3>Resultado por pergunta <span class="cpa-meta">· a marca indica a satisfação do curso na mesma pergunta</span></h3>
    ${legenda('')}
    ${grupos.map(g => `<h4>${esc(titulo(g.dim))}</h4>${g.itens.map(q => perguntaHtml(q, q.cursoSatisfacao)).join('')}`).join('')}
    <h3>Desempenho por disciplina</h3>
    <div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th>Disciplina</th><th class="num">Estudantes que avaliaram</th><th class="num">Nota média (0–10)</th><th class="num">Satisfação</th><th class="num">Ótimo</th><th class="num">Bom</th><th class="num">Regular</th><th class="num">Ruim</th></tr></thead><tbody>${p.disciplinas.map(d => `<tr><td>${esc(titulo(d.disciplina))}</td><td class="num">${fmtInt(d.respondentes ?? d.avaliacoes)}</td><td class="num">${fmt1(d.nota)}</td><td class="num">${fmtPct(d.satisfacao)}</td>${(d.dist || [0, 0, 0, 0]).slice(0, 4).map(v => `<td class="num">${fmtInt(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${cs.length ? `<h3>Comentários dos estudantes <span class="cpa-meta">· todos, agrupados pela disciplina de origem e separados por cor</span></h3><div class="cpa-chips"><span class="cpa-chip">${cs.length} comentários</span><span class="cpa-chip bom">${nc('bom')} elogios</span><span class="cpa-chip">${nc('neutro')} neutros</span><span class="cpa-chip atencao">${nc('atencao')} de atenção</span></div>${p.disciplinas.map(d => { const lista = cs.filter(x => (x.disciplina || '(sem disciplina)') === d.disciplina); if (!lista.length) return ''; return `<h4>${esc(titulo(d.disciplina))} <span class="cpa-meta">· ${lista.length} comentário(s)</span></h4>${comentariosPorCor(lista, false)}`; }).join('')}` : ''}
    <p class="cpa-meta" style="margin-top:1.4rem">Resultado da avaliação aplicada aos estudantes no Edubox (campanha ${c.codavaAluno}). Satisfação = (Ótimo + Bom) ÷ (Ótimo + Bom + Regular + Ruim); “Não sei” fora da base. Nota 0–10 atribuída pelos estudantes a cada disciplina. Sem identificação de estudantes. Emitido em ${esc(new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }))}.</p>
  </div>`;
}

// ---------- IMPRESSÃO / CSV ----------
function imprimir(html) {
  $('impressao').innerHTML = html;
  document.body.classList.add('cpa-imprimindo');
  const fim = () => { document.body.classList.remove('cpa-imprimindo'); $('impressao').innerHTML = ''; window.removeEventListener('afterprint', fim); };
  window.addEventListener('afterprint', fim);
  setTimeout(() => window.print(), 50);
}
// um PDF por professor do curso, nomeado "Professor - Curso.pdf", reunidos em um .zip
const nomeArquivo = (t) => String(t).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
async function baixarZipProfessores(btn) {
  if (!window.html2pdf || !window.JSZip) { toast('Não foi possível carregar o gerador de PDF. Verifique a conexão e tente de novo.', 'erro'); return; }
  const c = cicloAtual();
  const lista = [...profs].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const zip = new window.JSZip();
  const rotulo = btn.textContent; btn.disabled = true;
  const palco = document.createElement('div');
  palco.className = 'cpa-palco-pdf';
  palco.style.cssText = 'width:794px;background:#fff;';   // sem position: o html2pdf clona o elemento e, posicionado, ele colapsa a altura
  const fora = document.createElement('div');
  fora.style.cssText = 'position:fixed;left:-10000px;top:0;';
  fora.appendChild(palco); document.body.appendChild(fora);
  try {
    const usados = new Set();
    for (let i = 0; i < lista.length; i++) {
      const p = lista[i];
      btn.textContent = `Gerando ${i + 1} de ${lista.length}…`;
      palco.innerHTML = professorHtml(p);
      const blob = await window.html2pdf().from(palco).set({
        margin: [10, 8, 12, 8], image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale: 1.4, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.cpa-perg', '.cpa-coment', 'tr', 'h3', 'h4'] }
      }).outputPdf('blob');
      let nome = nomeArquivo(`${titulo(p.nome)} - ${nomeCurso(p.curso)}`);
      let k = 2; while (usados.has(nome.toLowerCase())) nome = nomeArquivo(`${titulo(p.nome)} - ${nomeCurso(p.curso)} (${k++})`);
      usados.add(nome.toLowerCase());
      zip.file(`${nome}.pdf`, blob);
    }
    btn.textContent = 'Compactando…';
    const out = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = nomeArquivo(`CPA ${c.semestre.replace('-', '.')} - ${nomeCurso(lista[0].curso)} - Professores`) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    toast(`${lista.length} PDFs gerados.`);
  } catch (err) { toast('Falha ao gerar os PDFs: ' + err.message, 'erro'); }
  finally { fora.remove(); btn.disabled = false; btn.textContent = rotulo; }
}
function baixarCsvProfessores() {
  const c = cicloAtual();
  const linhas = [['Professor', 'Curso', 'Estudantes que avaliaram', 'Nota média (0-10)', 'Satisfação (%)', 'Ótimo', 'Bom', 'Regular', 'Ruim', 'Não sei']];
  profs.forEach(p => linhas.push([titulo(p.nome), nomeCurso(p.curso), p.respondentes ?? p.avaliacoes, p.nota.media ?? '', p.satisfacao ?? '', ...p.dist]));
  const csv = linhas.map(l => l.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `cpa-professores-${c.id}-${cursoSel}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- EVENTOS ----------
function abrirProfessor(chave) {
  const p = achaProf(chave); if (!p) return;
  $('mp-titulo').textContent = titulo(p.nome);
  $('mp-corpo').innerHTML = professorHtml(p);
  $('mp-pdf').dataset.chave = chave;
  $('modal-prof').classList.remove('hidden');
}
function wireEventos() {
  $('seg-segmento').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-seg]'); if (!b || b.disabled) return;
    seg = b.dataset.seg; escolherCiclo(); rel = null; renderTudo(); await carregarCurso();
  });
  $('sel-ciclo').addEventListener('change', async (e) => { cicloId = e.target.value; escolherCiclo(); rel = null; renderTudo(); await carregarCurso(); });
  $('cursos').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-curso]'); if (!b) return;
    cursoSel = b.dataset.curso; renderCursos(); await carregarCurso(); renderAbas();
  });
  document.querySelector('.cpa-abas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]'); if (!b) return;
    abaSel = b.dataset.aba; renderAbas();
  });
  $('painel-resultado').addEventListener('click', (e) => {
    const pb = e.target.closest('[data-pub]');
    if (pb) { publicoSel = pb.dataset.pub; relPub = null; return renderResultado(); }
    if (e.target.id === 'btn-imprimir-pub' && relPub && !relPub.erro) imprimir(relatorioHtml(relPub, { completo: false }));
    if (e.target.id === 'btn-imprimir-inst') imprimirInstitucional();
    if (e.target.id === 'btn-imprimir-rel') imprimir(relatorioHtml(rel, { completo: false, comCapa: rel.codcur === 'IES' }));
    if (e.target.id === 'btn-capa') abrirCapa();
  });
  $('painel-professores').addEventListener('click', (e) => {
    const th = e.target.closest('[data-ord]');
    if (th) { ordem = { campo: th.dataset.ord, dir: ordem.campo === th.dataset.ord ? -ordem.dir : 1 }; return renderProfessores(); }
    const pdf = e.target.closest('[data-pdf]');
    if (pdf) { e.stopPropagation(); const p = achaProf(pdf.dataset.pdf); return imprimir(professorHtml(p)); }
    if (e.target.id === 'btn-csv-prof') return baixarCsvProfessores();
    if (e.target.id === 'btn-zip-profs') return baixarZipProfessores(e.target);
    if (e.target.id === 'btn-pdf-todos') return imprimir(profs.map(p => `<div class="cpa-pagina">${professorHtml(p)}</div>`).join(''));
    const tr = e.target.closest('[data-prof]'); if (tr) abrirProfessor(tr.dataset.prof);
  });
  $('painel-professores').addEventListener('input', (e) => {
    if (e.target.id !== 'busca-prof') return;
    filtroProf = e.target.value; const pos = e.target.selectionStart; renderProfessores();
    const n = $('busca-prof'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
  });
  $('mp-fechar').addEventListener('click', () => $('modal-prof').classList.add('hidden'));
  $('modal-prof').addEventListener('click', (e) => { if (e.target.id === 'modal-prof') $('modal-prof').classList.add('hidden'); });
  $('mp-pdf').addEventListener('click', () => { const p = achaProf($('mp-pdf').dataset.chave); if (p) imprimir(professorHtml(p)); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('modal-prof').classList.add('hidden'); $('modal-capa').classList.add('hidden'); } });
  $('c-cancelar').addEventListener('click', () => $('modal-capa').classList.add('hidden'));
  $('form-capa').addEventListener('submit', salvarCapa);
}

function abrirCapa() {
  const k = capa();
  $('c-ies').value = k.ies; $('c-mantenedora').value = k.mantenedora; $('c-endereco').value = k.endereco; $('c-atos').value = k.atosLegais;
  $('c-presidente').value = k.presidenteCpa; $('c-portaria').value = k.portariaCpa; $('c-membros').value = k.membros;
  $('modal-capa').classList.remove('hidden');
}
async function salvarCapa(ev) {
  ev.preventDefault();
  try {
    const body = { ies: $('c-ies').value, mantenedora: $('c-mantenedora').value, endereco: $('c-endereco').value, atosLegais: $('c-atos').value, presidenteCpa: $('c-presidente').value, portariaCpa: $('c-portaria').value, membros: $('c-membros').value };
    const r = await apiFetch('/cpa/capa', { method: 'PUT', body: JSON.stringify(body) });
    dados.capa = { ...(dados.capa || {}), ...r.capa };
    $('modal-capa').classList.add('hidden'); toast('Dados da capa salvos.');
  } catch (err) { toast(err.message, 'erro'); }
}
