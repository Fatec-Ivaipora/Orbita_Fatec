import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';
import { lerFolha, LETRAS, MAX_QUESTOES } from './leitor.js';
import { htmlFolhas, faixas, codigoLegivel } from './folha.js';
import { pdfDasFolhas } from './pdf.js';

// ==========================================================================
// Correção de Provas (13/10/2026) — como o Evalbee: o coordenador cria a avaliação, escolhe as turmas
// (vêm do Edubox pelo CADD, com quem estuda junto), define o gabarito (digitado ou de uma prova do Banco
// de Provas / Banco MED-FATEC), imprime uma folha por aluno (só frente) e lê as folhas com a câmera do
// celular. Aluno e professor não usam. Ver src/rotas/correcao-provas.js e leitor.js.
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (['127.0.0.1', 'localhost'].includes(location.hostname) || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
  ? `http://${location.hostname}:3000/api` : '/api';
const MODULO = 'correcao-provas';
const NIVEL_PADRAO = { adm_l2: 3, coordenador: 3, coord_medicina: 3 };

let currentUser = null, appInitialized = false, initializedRole = null, podeCriar = false;
let view = 'lista';
let avaliacoes = null, turmas = null, provasBanco = null;
let av = null, leituras = {}, podeEditarAv = false;   // avaliação aberta
let aba = 'alunos', filtroTurma = '', busca = '', abertoAluno = null;
let form = null;                                      // nova avaliação / editar gabarito

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const pct = (v) => `${Math.round(v * 100)}%`;
const fmtData = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR') : '');
const MINUSC = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'para', 'na', 'no', 'com']);
const titulo = (s) => String(s || '').toLowerCase().split(/(\s+)/).map((p, i) => (/^\s+$/.test(p) || (i > 0 && MINUSC.has(p))) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
const cursoCurto = (c) => titulo(String(c || '').replace(/^(BACHARELADO|LICENCIATURA|SUPERIOR DE TECNOLOGIA) EM /i, '').replace(/ - FORMA[ÇC][ÃA]O.*/i, ''));

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('toast'); t.textContent = msg; t.className = `cp-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
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
    podeCriar = level >= 3;
    if (!appInitialized || initializedRole !== role) initApp(user, role);
    if (avaliacoes === null) irPara(location.hash);
  } catch (err) { console.error('Erro na revalidação de auth:', err); }
});
function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true; initializedRole = role;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../auth/login.html'; });
  $('app').classList.remove('hidden');
  wireEventos();
}

// ---------- NAVEGAÇÃO (#nova, #av/<id>) ----------
async function irPara(hash) {
  const [, rota, id] = String(hash || '').match(/^#?([a-z]*)\/?(.*)$/) || [];
  if (rota === 'nova') return abrirNova(id);
  if (rota === 'av' && id) return abrirAvaliacao(id);
  return abrirLista();
}
function navegar(h) { if (location.hash !== h) history.pushState(null, '', h || location.pathname); irPara(h); }

const cabecalho = (tit, sub, acoes = '', voltar = false) => `
  <div class="page-header">
    <div>
      ${voltar ? '<button type="button" class="cp-voltar" data-voltar="1">← Avaliações</button>' : ''}
      <h1 class="page-title"><span class="cm-titulo-icone"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><circle cx="9" cy="14.5" r="1.6"/><path d="M13 9h4M13 14.5h4"/></svg></span>${esc(tit)}</h1>
      <p class="page-subtitle">${sub}</p>
    </div>
    <div class="page-header-actions">${acoes}</div>
  </div>`;

// ---------- LISTA ----------
// Organizada por semestre e disciplina (rastreabilidade). Filtros: semestre, de quem, tipo e busca.
let meuUid = '', souAdm = false, filtroSem = '', filtroQuem = '', filtroTipo = '', buscaLista = '';
async function abrirLista() {
  view = 'lista';
  const acoes = podeCriar ? '<button type="button" class="btn-primary" data-nova="1">+ Nova avaliação</button>' : '';
  const sub = 'Folha de respostas por aluno e correção pela câmera do celular. Organizadas por semestre e disciplina.';
  if (!avaliacoes) {
    $('tela').innerHTML = cabecalho('Correção de Provas', sub, acoes) + '<div class="card cp-vazio">Carregando…</div>';
    try { const r = await apiFetch('/correcao/avaliacoes'); avaliacoes = r.avaliacoes || []; meuUid = r.uid || ''; souAdm = !!r.adm; }
    catch (err) { $('tela').querySelector('.cp-vazio').textContent = `Não foi possível carregar: ${err.message}`; return; }
    if (view !== 'lista') return;
  }
  const semestres = [...new Set(avaliacoes.map(a => a.semestre || '').filter(Boolean))].sort().reverse();
  if (!filtroSem || (filtroSem !== 'todos' && !semestres.includes(filtroSem))) filtroSem = semestres[0] || 'todos';
  if (!filtroQuem) filtroQuem = avaliacoes.some(a => a.criadoPorUid === meuUid) ? 'minhas' : 'todas';
  const lista = avaliacoes.filter(a => (filtroSem === 'todos' || a.semestre === filtroSem)
    && (filtroQuem === 'todas' || a.criadoPorUid === meuUid)
    && (!filtroTipo || a.tipo === filtroTipo)
    && (!buscaLista || `${a.nome} ${a.disciplina || ''} ${(a.turmas || []).map(t => t.turma).join(' ')}`.toLowerCase().includes(buscaLista.toLowerCase())));
  const porDisc = new Map();
  lista.forEach(a => { const k = a.disciplina || 'Sem disciplina informada'; (porDisc.get(k) || porDisc.set(k, []).get(k)).push(a); });
  const grupos = [...porDisc.entries()].sort((x, y) => x[0].localeCompare(y[0], 'pt-BR'));
  const filtros = `<section class="card cp-filtros-lista">
      <label class="cp-campo">Semestre <select id="ls-sem"><option value="todos">Todos</option>${semestres.map(x => `<option value="${esc(x)}" ${filtroSem === x ? 'selected' : ''}>${esc(x.replace('-', '.'))}</option>`).join('')}</select></label>
      <label class="cp-campo">De quem <select id="ls-quem"><option value="minhas" ${filtroQuem === 'minhas' ? 'selected' : ''}>Criadas por mim</option><option value="todas" ${filtroQuem === 'todas' ? 'selected' : ''}>Todas do meu curso</option></select></label>
      <label class="cp-campo">Tipo <select id="ls-tipo"><option value="">Todos</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${filtroTipo === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="cp-campo cp-campo-grande">Buscar <input id="ls-busca" type="search" value="${esc(buscaLista)}" placeholder="Nome, disciplina ou turma"></label>
    </section>`;
  const corpo = !avaliacoes.length
    ? `<div class="card cp-vazio"><b>Nenhuma avaliação ainda.</b><br>${podeCriar ? 'Clique em <b>+ Nova avaliação</b> para começar: escolha as turmas, a disciplina, o gabarito e imprima as folhas.' : ''}</div>`
    : !lista.length ? '<div class="card cp-vazio">Nenhuma avaliação com esses filtros.</div>'
    : grupos.map(([disc, avs]) => `<section class="cp-disc-grupo">
        <h2 class="cp-disc-tit">${esc(disc === VARIAS ? 'Simulados (várias disciplinas)' : titulo(disc))} <small>${plural(avs.length, 'avaliação', 'avaliações')}</small></h2>
        <div class="cp-lista">${avs.sort((x, y) => String(y.data || y.criadoEm).localeCompare(String(x.data || x.criadoEm))).map(a => `
          <div class="cp-item-wrap">
          ${a.criadoPorUid === meuUid || souAdm ? `<button type="button" class="cp-item-excluir" data-excluir-lista="${esc(a.id)}" title="Excluir esta avaliação" aria-label="Excluir ${esc(a.nome)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button>` : ''}
          <button type="button" class="card cp-item" data-abrir="${esc(a.id)}">
            <div class="cp-item-cod">${String(a.codigo).padStart(4, '0')}</div>
            <div class="cp-item-txt"><b>${esc(a.nome)}</b>
              <small>${[rotuloAv(a), a.data ? fmtData(a.data) : '', plural(a.questoes.length, 'questão', 'questões'), (a.turmas || []).map(t => nomeTurma(t)).join(', ')].filter(Boolean).map(esc).join(' · ')}</small>
              <small class="cp-item-quem">${a.semestre && filtroSem === 'todos' ? `${esc(a.semestre.replace('-', '.'))} · ` : ''}criada por ${esc(a.criadoPorUid === meuUid ? 'você' : (a.criadoPor || '—'))}</small></div>
            <div class="cp-item-n"><b>${a.nAlunos}</b><small>alunos</small></div>
          </button></div>`).join('')}</div></section>`).join('');
  $('tela').innerHTML = cabecalho('Correção de Provas', sub, acoes) + (avaliacoes.length ? filtros : '') + corpo;
}

// ---------- NOVA AVALIAÇÃO ----------
const novaQuestao = () => ({ g: '', d: '' });
const TIPOS = { bimestral: 'Prova bimestral', exame: 'Exame', simulado: 'Simulado', ead: 'Prova EAD', dp: 'Prova de DP', outra: 'Outra avaliação' };
const VARIAS = 'Várias (simulado)';
const rotuloAv = (a) => [TIPOS[a.tipo] || '', a.bimestre ? `${a.bimestre}º bimestre` : ''].filter(Boolean).join(' · ');
const nomeAuto = (f) => [TIPOS[f.tipo] || 'Avaliação', f.bimestre ? `${f.bimestre}º bimestre` : '', f.tipo === 'simulado' ? (f.turmasNomes ? `— ${f.turmasNomes}` : '') : f.disciplina ? `— ${titulo(f.disciplina)}` : ''].filter(Boolean).join(' ');
async function abrirNova(prova = '') {
  view = 'nova';
  form = { nome: '', data: new Date().toISOString().slice(0, 10), valorTotal: '', turmasSel: new Set(), curso: '', nAlt: 5, questoes: Array.from({ length: 10 }, novaQuestao), origem: 'manual', provaId: '', faixasD: [], modo: 'turmas', dp: null, tipo: 'bimestral', bimestre: '', disciplina: '', discOutra: false, professor: '', discLista: null, comp: null, totalSim: 40 };
  $('tela').innerHTML = cabecalho('Nova avaliação', 'Escolha as turmas, defina o gabarito e salve. Depois é só imprimir as folhas.', '', true) + '<div class="card cp-vazio">Carregando as turmas…</div>';
  if (!turmas) {
    try { turmas = (await apiFetch('/correcao/turmas')).turmas || []; }
    catch (err) { $('tela').querySelector('.cp-vazio').textContent = `Não foi possível carregar as turmas: ${err.message}`; return; }
  }
  if (view !== 'nova') return;
  const cursos = [...new Set(turmas.map(t => t.curso))];
  if (cursos.length === 1) form.curso = cursos[0];
  renderNova();
  // veio do Banco de Provas / MED-FATEC: já carrega o gabarito da prova
  const m = String(prova || '').match(/^(bp|med):(.+)$/);
  if (m) { form.origem = 'banco'; await carregarProvasBanco(); await escolherProva(`${m[1]}|${decodeURIComponent(m[2])}`); }
}
const nomeTurma = (t) => titulo(String(t.turma).replace(/ - \d{4}.\d$/, ''));
const parceiras = (t) => turmas.filter(x => x.grupo && x.grupo === t.grupo && x.id !== t.id);

function renderNova() {
  const f = form;
  const cursos = [...new Set(turmas.map(t => t.curso))].sort((a, b) => cursoCurto(a).localeCompare(cursoCurto(b), 'pt-BR'));
  const lista = turmas.filter(t => !f.curso || t.curso === f.curso);
  // agrupa por "estudam juntas"
  const grupos = new Map();
  lista.forEach(t => { const k = t.grupo || t.id; (grupos.get(k) || grupos.set(k, []).get(k)).push(t); });
  const nSel = turmas.filter(t => f.turmasSel.has(t.id)).reduce((s, t) => s + (t.alunos || 0), 0);
  const fx = faixas(f.questoes);
  $('tela').innerHTML = cabecalho('Nova avaliação', 'Escolha as turmas, defina o gabarito e salve. Depois é só imprimir as folhas.', '', true) + `
  <section class="card cp-bloco">
    <h2 class="card-secao-titulo"><span class="cp-passo">1</span> Quem faz a prova <small>— ${f.modo === 'dp' ? (f.dp ? `DP de ${esc(titulo(f.dp.nome))}, ${plural(f.dp.alunos, 'aluno', 'alunos')}` : 'escolha a disciplina de DP') : `${plural(f.turmasSel.size, 'turma escolhida', 'turmas escolhidas')}, ${plural(nSel, 'aluno', 'alunos')}`} (uma folha por aluno)</small></h2>
    <div class="abas" role="tablist" style="margin-bottom:12px">
      <button type="button" class="aba ${f.modo !== 'dp' ? 'ativa' : ''}" data-modo="turmas">Turmas</button>
      <button type="button" class="aba ${f.modo === 'dp' ? 'ativa' : ''}" data-modo="dp">Prova de DP</button>
    </div>
    ${cursos.length > 1 || f.modo === 'dp' ? `<label class="cp-campo">Curso <select id="f-curso"><option value="">${f.modo === 'dp' ? 'Escolha o curso…' : 'Todos os cursos'}</option>${cursos.map(c => `<option value="${esc(c)}" ${c === f.curso ? 'selected' : ''}>${esc(cursoCurto(c))}</option>`).join('')}</select></label>` : ''}
    ${f.modo === 'dp' ? blocoDP() : `<p class="cp-dica">Turmas que estudam juntas aparecem no mesmo quadro e são marcadas juntas.</p>
    <div class="cp-turmas">${[...grupos.values()].map(g => `
      <div class="cp-grupo ${g.length > 1 ? 'junto' : ''}">
        ${g.length > 1 ? '<span class="cp-grupo-tag">estudam juntas</span>' : ''}
        ${g.map(t => `<label class="cp-turma"><input type="checkbox" data-turma="${esc(t.id)}" ${f.turmasSel.has(t.id) ? 'checked' : ''}>
          <span><b>${esc(nomeTurma(t))}</b>${t.teste ? ' <span class="cp-extra">teste</span>' : ''}<small>${esc(cursoCurto(t.curso))} · ${plural(t.alunos || 0, 'aluno', 'alunos')}</small></span></label>`).join('')}
      </div>`).join('') || '<div class="cp-vazio">Nenhuma turma no CADD para o seu curso.</div>'}</div>`}
  </section>

  ${blocoIdent()}

  <section class="card cp-bloco">
    <h2 class="card-secao-titulo"><span class="cp-passo">3</span> Gabarito</h2>
    <div class="abas" role="tablist">
      <button type="button" class="aba ${f.origem === 'manual' ? 'ativa' : ''}" data-origem="manual">Digitar o gabarito</button>
      <button type="button" class="aba ${f.origem !== 'manual' ? 'ativa' : ''}" data-origem="banco">Puxar de uma prova do banco</button>
    </div>
    ${f.origem !== 'manual' ? `<div class="cp-campos" style="margin-top:12px">
      <label class="cp-campo cp-campo-grande">Prova montada no Banco de Provas / Banco MED-FATEC
        <select id="f-prova"><option value="">${provasBanco ? (provasBanco.length ? 'Escolha a prova…' : 'Nenhuma prova montada nos bancos') : 'Carregando…'}</option>${(provasBanco || []).map(p => `<option value="${p.origem}|${esc(p.id)}" ${f.provaId === p.id ? 'selected' : ''}>${p.origem === 'med' ? 'MED-FATEC · ' : ''}${esc(p.nome)} (${p.n} questões)</option>`).join('')}</select></label></div>` : ''}
    <div class="cp-campos" style="margin-top:12px">
      <label class="cp-campo">Nº de questões <input type="number" id="f-n" min="1" max="${MAX_QUESTOES}" value="${f.questoes.length}" ${f.tipo === 'simulado' && f.modo !== 'dp' ? 'disabled title="No simulado, o total vem da composição acima"' : ''}></label>
      <label class="cp-campo">Alternativas <select id="f-nalt"><option value="5" ${f.nAlt === 5 ? 'selected' : ''}>A a E</option><option value="4" ${f.nAlt === 4 ? 'selected' : ''}>A a D</option></select></label>
      <label class="cp-campo cp-campo-grande">Colar o gabarito <small>(opcional — ex.: ABCDA BECDA…)</small><input id="f-colar" placeholder="Digite as letras em sequência e saia do campo"></label>
    </div>
    ${f.tipo === 'simulado' && f.modo !== 'dp' ? `<p class="cp-dica">As disciplinas de cada faixa de questões vêm da composição do simulado (passo 2).</p>` : `    <h3 class="cp-sub">Disciplinas <small>— aparecem na folha do aluno e no resultado por disciplina (no simulado, uma faixa por disciplina)</small></h3>
    <div class="cp-faixas">${f.faixasD.map((x, k) => `<div class="cp-faixa">
        <label>De <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="de" value="${x.de}"></label>
        <label>até <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="ate" value="${x.ate}"></label>
        <input class="cp-faixa-nome" data-fx="${k}" data-campo="nome" value="${esc(x.nome)}" placeholder="Nome da disciplina">
        <button type="button" class="cp-link perigo" data-fx-del="${k}">remover</button></div>`).join('')}
      <button type="button" class="cp-link" data-fx-add="1">+ adicionar disciplina</button>
      ${!f.faixasD.length && fx.length ? '' : ''}</div>
`}
    <h3 class="cp-sub">Resposta certa de cada questão <small>— toque na letra; "anular" vale a questão para todos</small></h3>
    <div class="cp-gab">${f.questoes.map((q, i) => `<div class="cp-gab-q ${q.g ? '' : 'falta'}"><span class="cp-gab-n">${i + 1}</span>${LETRAS.slice(0, f.nAlt).split('').map(l => `<button type="button" class="cp-gab-l ${q.g === l ? 'on' : ''}" data-q="${i}" data-l="${l}" aria-pressed="${q.g === l}">${l}</button>`).join('')}<button type="button" class="cp-gab-x ${q.g === 'X' ? 'on' : ''}" data-q="${i}" data-l="X" title="Anular a questão (vale para todos)">anular</button></div>`).join('')}</div>
  </section>

  <div class="cp-salvar"><span class="cp-dica" id="f-aviso"></span><button type="button" class="btn-primary" id="f-salvar">Salvar avaliação</button></div>`;
  avisoForm();
}
// Identificação: tipo, bimestre e disciplina (rastreabilidade: a lista se organiza por semestre e disciplina)
function blocoIdent() {
  const f = form, dpFixo = f.modo === 'dp';
  const lista = f.discLista || [];
  const nTurmas = f.turmasSel.size;
  const opcoes = lista.map(d => `<option value="${esc(d.nome)}" ${!f.discOutra && f.disciplina === d.nome ? 'selected' : ''}>${esc(titulo(d.nome))}${nTurmas > 1 && d.turmas.length < nTurmas ? ` (${d.turmas.length} de ${nTurmas} turmas)` : ''}</option>`).join('');
  const conhecida = f.disciplina === VARIAS || lista.some(d => d.nome === f.disciplina);
  const outra = f.discOutra || (f.disciplina && !conhecida);
  return `<section class="card cp-bloco">
    <h2 class="card-secao-titulo"><span class="cp-passo">2</span> Identificação <small>— fica guardada por semestre e disciplina, para achar depois</small></h2>
    <div class="cp-campos">
      <label class="cp-campo">Tipo <select id="f-tipo" ${dpFixo ? 'disabled' : ''}>${Object.entries(TIPOS).filter(([k]) => dpFixo || k !== 'dp').map(([k, v]) => `<option value="${k}" ${(dpFixo ? 'dp' : f.tipo) === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="cp-campo">Bimestre <select id="f-bim"><option value="">—</option><option value="1" ${String(f.bimestre) === '1' ? 'selected' : ''}>1º bimestre</option><option value="2" ${String(f.bimestre) === '2' ? 'selected' : ''}>2º bimestre</option></select></label>
      ${f.tipo === 'simulado' && !dpFixo ? '' : dpFixo ? `<label class="cp-campo cp-campo-grande">Disciplina <input value="${esc(f.dp ? titulo(f.dp.nome) : 'escolha a disciplina de DP acima')}" disabled></label>`
        : `<label class="cp-campo cp-campo-grande">Disciplina
        <select id="f-disc"><option value="">${nTurmas ? (f.discLista ? 'Escolha a disciplina…' : 'Carregando as disciplinas das turmas…') : 'Escolha as turmas primeiro'}</option>${opcoes}
          <option value="${VARIAS}" ${f.disciplina === VARIAS ? 'selected' : ''}>${VARIAS}</option>
          <option value="__outra" ${outra ? 'selected' : ''}>Outra (digitar)</option></select></label>
      ${outra ? `<label class="cp-campo cp-campo-grande">Nome da disciplina <input id="f-disc-outra" maxlength="120" value="${esc(conhecida ? '' : f.disciplina)}"></label>` : ''}`}
    </div>
    ${f.tipo === 'simulado' && !dpFixo ? blocoSimulado() : ''}
    <div class="cp-campos">
      <label class="cp-campo cp-campo-grande">Nome da avaliação <small>(opcional — se ficar vazio, usa o tipo e a disciplina)</small><input id="f-nome" maxlength="120" value="${esc(f.nome)}" placeholder="${esc(nomeAuto({ ...f, tipo: dpFixo ? 'dp' : f.tipo, disciplina: dpFixo && f.dp ? f.dp.nome : f.disciplina }))}"></label>
      <label class="cp-campo">Data da aplicação <input type="date" id="f-data" value="${esc(f.data)}"></label>
      <label class="cp-campo">Valor da prova <small>(opcional)</small><input type="number" id="f-valor" min="0" max="100" step="0.1" value="${esc(f.valorTotal)}" placeholder="Ex.: 2,0"></label>
    </div>
  </section>`;
}
// ---------- SIMULADO: composição (14/10/2026) ----------
// O simulado cobre as disciplinas do bimestre: normalmente 40 questões, 5 de Conhecimentos Gerais e o resto
// dividido entre as disciplinas — quem decide quantas de cada é o coordenador. As faixas da folha saem daqui.
const CG = 'Conhecimentos Gerais';
function compPadrao() {
  const discs = (form.discLista || []).map(d => d.nome);
  const comp = [{ nome: CG, qtd: Math.min(5, form.totalSim) }, ...discs.map(n => ({ nome: n, qtd: 0 }))];
  dividirResto(comp);
  return comp;
}
// reparte o que falta entre as disciplinas que o coordenador ainda não definiu (as que ele digitou ficam)
function dividirResto(comp) {
  let alvo = comp.filter(c => c.nome !== CG && !c.fixo);
  if (!alvo.length) { comp.forEach(c => { c.fixo = false; }); alvo = comp.filter(c => c.nome !== CG); }
  if (!alvo.length) return;
  const fixos = comp.filter(c => c.nome === CG || c.fixo).reduce((t, c) => t + (Number(c.qtd) || 0), 0);
  const resto = Math.max(0, form.totalSim - fixos);
  const base = Math.floor(resto / alvo.length); let sobra = resto - base * alvo.length;
  alvo.forEach(c => { c.qtd = base + (sobra-- > 0 ? 1 : 0); });
}
function aplicarComp() {
  const comp = form.comp || [];
  const n = comp.reduce((t, c) => t + (Number(c.qtd) || 0), 0);
  const tam = Math.max(1, Math.min(MAX_QUESTOES, n));
  while (form.questoes.length < tam) form.questoes.push(novaQuestao());
  form.questoes.length = tam;
  let de = 1;
  form.faixasD = comp.filter(c => c.qtd > 0 && c.nome).map(c => { const f = { de, ate: Math.min(tam, de + c.qtd - 1), nome: c.nome }; de += c.qtd; return f; }).filter(f => f.de <= tam);
  aplicarFaixas();
}
function blocoSimulado() {
  const f = form;
  if (f.compBanco && f.comp) {
    return `<h3 class="cp-sub">Composição do simulado <small>— veio da prova do banco, na mesma sequência do caderno impresso</small></h3>
      <div class="cp-comp">${f.comp.map(c => `<div class="cp-comp-linha banco"><span class="cp-comp-nome">${c.nome === CG ? `<b>${CG}</b>` : esc(titulo(c.nome))}</span><b class="cp-comp-q">${c.qtd}</b>
        <span class="cp-comp-faixa">${(() => { const fx = f.faixasD.find(x => x.nome === c.nome); return fx ? (fx.de === fx.ate ? `questão ${fx.de}` : `questões ${fx.de} a ${fx.ate}`) : ''; })()}</span><span></span></div>`).join('')}</div>
      <p class="cp-comp-soma ok">${f.questoes.length} questões. Para mudar a composição, altere a prova no Banco de Provas (ou use "Digitar o gabarito").</p>`;
  }
  if (!f.turmasSel.size) return '<p class="cp-dica">Escolha as turmas para montar a composição com as disciplinas delas.</p>';
  if (!f.discLista) return '<div class="cp-vazio">Carregando as disciplinas das turmas…</div>';
  if (!f.comp) { f.comp = compPadrao(); aplicarComp(); }
  const soma = f.comp.reduce((t, c) => t + (Number(c.qtd) || 0), 0), dif = f.totalSim - soma;
  return `<h3 class="cp-sub">Composição do simulado <small>— quantas questões de cada disciplina do bimestre (você decide)</small></h3>
    <div class="cp-campos">
      <label class="cp-campo">Total de questões <input type="number" id="f-total" min="1" max="${MAX_QUESTOES}" value="${f.totalSim}"></label>
      <div class="cp-comp-acoes"><button type="button" class="btn-secondary" data-comp-dividir="1" title="As quantidades que você digitou ficam; o que falta é repartido entre as outras">Dividir o que falta entre as outras</button></div>
    </div>
    <div class="cp-comp">${f.comp.map((c, k) => `<div class="cp-comp-linha">
        ${k === 0 && c.nome === CG ? `<span class="cp-comp-nome"><b>${CG}</b></span>` : c.novo ? `<input class="cp-comp-nome" data-comp-nome="${k}" value="${esc(c.nome)}" placeholder="Nome da disciplina">` : `<span class="cp-comp-nome">${esc(titulo(c.nome))}</span>`}
        <input type="number" min="0" max="${MAX_QUESTOES}" data-comp="${k}" value="${c.qtd}" class="${c.fixo ? 'fixo' : ''}" aria-label="Questões de ${esc(c.nome || 'disciplina')}">
        <span class="cp-comp-faixa">${(() => { const fx = f.faixasD.find(x => x.nome === c.nome); return fx && c.qtd ? (fx.de === fx.ate ? `questão ${fx.de}` : `questões ${fx.de} a ${fx.ate}`) : '—'; })()}</span>
        ${k > 0 ? `<button type="button" class="cp-link perigo" data-comp-del="${k}" aria-label="Tirar ${esc(c.nome || 'disciplina')}">tirar</button>` : '<span></span>'}
      </div>`).join('')}
      <button type="button" class="cp-link" data-comp-add="1">+ adicionar disciplina</button>
    </div>
    <p class="cp-comp-soma ${dif ? 'falta' : 'ok'}">${dif === 0 ? `Fechou: ${soma} questões.` : dif > 0 ? `Faltam ${dif} para chegar a ${f.totalSim} (está com ${soma}).` : `Passou ${-dif} de ${f.totalSim} (está com ${soma}).`}</p>`;
}
const discCache = {};
async function carregarDisciplinas() {
  const ids = [...form.turmasSel].sort(), chave = ids.join(',');
  if (!ids.length) { form.discLista = null; return; }
  if (discCache[chave]) { form.discLista = discCache[chave]; if (!form.compBanco) form.comp = null; return; }
  form.discLista = null;
  try { discCache[chave] = (await apiFetch(`/correcao/disciplinas?turmas=${encodeURIComponent(chave)}`)).disciplinas || []; }
  catch (err) { discCache[chave] = []; toast(err.message, 'erro'); }
  if (view === 'nova' && [...form.turmasSel].sort().join(',') === chave) { lerCamposForm(); form.discLista = discCache[chave]; if (!form.compBanco) form.comp = null; renderNova(); }
}
const dpCache = {};   // codcur -> disciplinas com aluno de DP
function blocoDP() {
  const f = form;
  const t = turmas.find(x => x.curso === f.curso);
  if (!t) return '<p class="cp-dica">Escolha o curso para ver as disciplinas que têm aluno de DP.</p>';
  const lista = dpCache[t.codcur];
  if (!lista) { carregarDP(t.codcur); return '<div class="cp-vazio">Procurando os alunos de DP…</div>'; }
  if (!lista.length) return '<div class="cp-vazio">Nenhum aluno fazendo DP neste curso no semestre.</div>';
  return `<p class="cp-dica">Entram todos os alunos que fazem a disciplina como DP, de qualquer turma.</p>
    <div class="cp-turmas"><div class="cp-grupo">${lista.map(d => `<label class="cp-turma"><input type="radio" name="f-dp" data-dp="${esc(d.chave)}" ${f.dp && f.dp.chave === d.chave ? 'checked' : ''}>
      <span><b>${esc(titulo(d.nome))}</b><small>${plural(d.alunos, 'aluno', 'alunos')} de DP${d.professor ? ` · ${esc(titulo(d.professor))}` : ''}</small></span></label>`).join('')}</div></div>`;
}
async function carregarDP(codcur) {
  try { dpCache[codcur] = (await apiFetch(`/correcao/dp/${encodeURIComponent(codcur)}`)).disciplinas || []; }
  catch (err) { dpCache[codcur] = []; toast(err.message, 'erro'); }
  if (view === 'nova') { lerCamposForm(); renderNova(); }
}
function avisoForm() {
  const falta = form.questoes.filter(q => !q.g).length;
  const el = $('f-aviso'); if (!el) return;
  el.textContent = falta ? `${plural(falta, 'questão ainda sem gabarito', 'questões ainda sem gabarito')} — dá para salvar e completar depois, antes de corrigir.` : '';
}
function aplicarFaixas() {
  form.questoes.forEach(q => { q.d = ''; });
  form.faixasD.forEach(x => { for (let i = Math.max(1, x.de); i <= Math.min(form.questoes.length, x.ate); i++) form.questoes[i - 1].d = x.nome; });
}
function lerCamposForm() {
  if (!$('f-nome')) return;
  form.nome = $('f-nome').value; form.data = $('f-data').value; form.valorTotal = $('f-valor').value;
  if ($('f-tipo') && !$('f-tipo').disabled) form.tipo = $('f-tipo').value;
  if ($('f-bim')) form.bimestre = $('f-bim').value;
  if ($('f-disc-outra')) form.disciplina = $('f-disc-outra').value.trim();
}
async function carregarProvasBanco() {
  if (provasBanco) return;
  try { provasBanco = (await apiFetch('/correcao/bancos/provas')).provas || []; }
  catch (err) { provasBanco = []; toast(err.message, 'erro'); }
  if (view === 'nova') { lerCamposForm(); renderNova(); }
}
async function escolherProva(valor) {
  if (!valor) return;
  const [origem, id] = valor.split('|');
  try {
    const r = await apiFetch(`/correcao/bancos/${origem}/${encodeURIComponent(id)}`);
    if (!r.questoes.length) { toast('Essa prova não tem questão objetiva.', 'erro'); return; }
    if (r.questoes.length > MAX_QUESTOES) { toast(`A folha comporta até ${MAX_QUESTOES} questões; a prova tem ${r.questoes.length}.`, 'erro'); return; }
    lerCamposForm();
    form.origem = origem; form.provaId = id;
    form.questoes = r.questoes.map(q => ({ g: q.g.length === 1 ? q.g : (q.g || ''), d: q.d || '', q: q.q }));
    form.faixasD = faixas(form.questoes).map(x => ({ ...x }));
    if (!form.nome) form.nome = r.nome;
    if (r.tipo && TIPOS[r.tipo]) form.tipo = r.tipo;
    if (r.bimestre) form.bimestre = String(r.bimestre);
    if (r.disciplina) { form.disciplina = r.disciplina; form.discOutra = !(r.disciplina === VARIAS || (form.discLista || []).some(d => d.nome === r.disciplina)); }
    if (r.professor) form.professor = r.professor;
    form.compBanco = form.tipo === 'simulado';
    if (form.tipo === 'simulado') { form.totalSim = form.questoes.length; form.comp = faixas(form.questoes).map(x => ({ nome: x.nome, qtd: x.ate - x.de + 1, fixo: true })); form.disciplina = VARIAS; }
    renderNova();
    toast(`Gabarito de "${r.nome}" carregado${r.dissertativas ? ` (${plural(r.dissertativas, 'dissertativa fica', 'dissertativas ficam')} fora da folha)` : ''}.`);
  } catch (err) { toast(err.message, 'erro'); }
}
async function salvarNova(btn) {
  lerCamposForm();
  const f = form;
  if (f.modo === 'dp' ? !f.dp : !f.turmasSel.size) { toast(f.modo === 'dp' ? 'Escolha a disciplina de DP.' : 'Escolha pelo menos uma turma.', 'erro'); return; }
  const tipo = f.modo === 'dp' ? 'dp' : f.tipo, disciplina = f.modo === 'dp' ? f.dp.nome : tipo === 'simulado' ? VARIAS : f.disciplina;
  if (tipo === 'simulado' && f.modo !== 'dp') {
    if (!f.comp) { toast('Monte a composição do simulado.', 'erro'); return; }
    const soma = f.comp.reduce((t, c) => t + (Number(c.qtd) || 0), 0);
    if (!f.compBanco && soma !== f.totalSim) { toast(`A composição soma ${soma} questões e o total é ${f.totalSim}. Ajuste antes de salvar.`, 'erro'); return; }
    if (f.comp.some(c => c.qtd > 0 && !c.nome)) { toast('Dê nome à disciplina que você adicionou.', 'erro'); return; }
    aplicarComp();
  }
  f.turmasNomes = [...f.turmasSel].map(id => nomeTurma(turmas.find(t => t.id === id))).join(', ');
  if (!disciplina) { toast('Escolha a disciplina da avaliação.', 'erro'); ($('f-disc') || $('f-disc-outra')).focus(); return; }
  if (!f.nome.trim()) f.nome = nomeAuto({ ...f, tipo, disciplina });
  const prof = f.professor || ((f.discLista || []).find(d => d.nome === disciplina) || {}).professor || '';
  aplicarFaixas();
  btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    const r = await apiFetch('/correcao/avaliacoes', { method: 'POST', body: JSON.stringify({
      nome: f.nome, tipo, bimestre: f.bimestre || null, disciplina, professor: prof, data: f.data, valorTotal: f.valorTotal ? Number(String(f.valorTotal).replace(',', '.')) : null,
      turmas: f.modo === 'dp' ? [] : [...f.turmasSel], dp: f.modo === 'dp' ? f.dp : null, nAlt: f.nAlt, questoes: f.questoes, origem: f.origem === 'banco' ? 'manual' : f.origem, provaId: f.provaId
    }) });
    toast('Avaliação criada. Agora imprima as folhas.');
    avaliacoes = null;
    navegar(`#av/${r.id}`);
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; btn.textContent = 'Salvar avaliação'; }
}

// ---------- RESULTADO (cálculo igual ao do servidor) ----------
function acertou(g, r) { return g === 'X' ? true : !!g && !!r && r.length === 1 && g.includes(r); }
function certaNaFolha(l, i) {
  const q = av.questoes[i], resp = (l.respostas || [])[i];
  if (l.consideradas && l.consideradas[i]) return true;
  if (acertou(q.g, resp)) return true;
  return !!(av.aceitarDupla && resp === '*' && q.g && q.g !== 'X' && [...String((l.duplas || {})[i] || '')].some(x => q.g.includes(x)));
}
function resultado(l) {
  const porDisc = {}; let acertos = 0;
  av.questoes.forEach((q, i) => {
    const ok = certaNaFolha(l, i); if (ok) acertos++;
    const x = (porDisc[q.d || ''] = porDisc[q.d || ''] || { acertos: 0, total: 0 }); x.total++; if (ok) x.acertos++;
  });
  return { acertos, total: av.questoes.length, nota: av.valorTotal ? Math.round(acertos / av.questoes.length * av.valorTotal * 100) / 100 : null, porDisc };
}

// ---------- AVALIAÇÃO ----------
async function abrirAvaliacao(id) {
  view = 'av';
  if (!av || av.id !== id) { av = null; abertoAluno = null; filtroTurma = ''; busca = ''; aba = 'alunos'; }
  $('tela').innerHTML = cabecalho('Avaliação', '', '', true) + '<div class="card cp-vazio">Carregando…</div>';
  try {
    const r = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(id)}`);
    av = r.avaliacao; leituras = r.leituras || {}; podeEditarAv = r.podeEditar;
  } catch (err) { $('tela').querySelector('.cp-vazio').textContent = `Não foi possível abrir: ${err.message}`; return; }
  if (view === 'av') renderAvaliacao();
}
const turmaDe = (a) => av.turmas.find(t => t.id === a.turmaId) || {};
function renderAvaliacao() {
  const lidas = av.alunos.filter(a => leituras[a.i]);
  const res = lidas.map(a => resultado(leituras[a.i]));
  const media = res.length ? res.reduce((s, r) => s + r.acertos, 0) / res.length : null;
  const n = av.questoes.length;
  const semGab = av.questoes.filter(q => !q.g).length;
  const kpi = (cls, rot, val, dica) => `<div class="kpi-card ${cls}"><div class="kpi-label">${rot}</div><div class="kpi-value">${val}</div><div class="kpi-hint">${dica}</div></div>`;
  const acoes = `
    <button type="button" class="btn-primary" data-ler="1"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Ler folhas</button>
    <button type="button" class="btn-secondary" data-imprimir="1">Imprimir folhas</button>
    <button type="button" class="btn-secondary" data-planilha="1">Baixar planilha</button>
    ${podeEditarAv ? '<button type="button" class="btn-secondary cp-btn-perigo" data-excluir-av="1">Excluir</button>' : ''}`;
  const sub = `${av.disciplina ? `<b>${esc(av.disciplina === VARIAS ? 'Várias disciplinas (simulado)' : titulo(av.disciplina))}</b> · ` : ''}${av.tipo ? `${esc(rotuloAv(av))} · ` : ''}${av.semestre ? `${esc(String(av.semestre).replace('-', '.'))} · ` : ''}Código ${String(av.codigo).padStart(4, '0')} · ${av.data ? fmtData(av.data) + ' · ' : ''}${plural(n, 'questão', 'questões')} (${LETRAS.slice(0, av.nAlt).split('').join(', ')}) · ${esc(av.turmas.map(t => nomeTurma(t)).join(', '))} · criada por ${esc(av.criadoPor || '—')}`;
  $('tela').innerHTML = cabecalho(av.nome, sub, acoes, true) + `
    ${av.gabaritoDoBancoEm ? `<div class="cp-aviso-banco">O gabarito foi atualizado pelo banco de questões em ${new Date(av.gabaritoDoBancoEm).toLocaleString('pt-BR')}${av.gabaritoDoBancoPor ? ` (${esc(av.gabaritoDoBancoPor)})` : ''}. As notas já foram recalculadas.</div>` : ''}
    ${semGab ? `<div class="cp-alerta">${plural(semGab, 'questão está', 'questões estão')} sem gabarito — complete em <b>Gabarito</b> antes de corrigir (as folhas já lidas são recalculadas sozinhas).</div>` : ''}
    <div class="kpi-grid cp-kpis">
      ${kpi('kpi-azul', 'Folhas corrigidas', `${lidas.length} de ${av.alunos.length}`, av.alunos.length ? `${pct(lidas.length / av.alunos.length)} da turma` : '')}
      ${kpi('kpi-verde', 'Média de acertos', media === null ? '–' : `${media.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} de ${n}`, media === null ? 'nenhuma folha lida ainda' : `${pct(media / n)} de acerto`)}
      ${kpi('kpi-sem', 'Maior e menor', res.length ? `${Math.max(...res.map(r => r.acertos))} · ${Math.min(...res.map(r => r.acertos))}` : '–', 'acertos entre as folhas lidas')}
      ${kpi('kpi-perda', 'Respostas a conferir', lidas.reduce((s, a) => s + leituras[a.i].respostas.filter(x => x === '*').length, 0), 'questões com duas marcações')}
    </div>
    <div class="abas cp-abas" role="tablist">
      ${[['alunos', 'Alunos'], ['questoes', 'Questões'], ['disciplinas', 'Disciplinas'], ['gabarito', 'Gabarito']].map(([k, v]) => `<button type="button" class="aba ${aba === k ? 'ativa' : ''}" data-aba="${k}" role="tab" aria-selected="${aba === k}">${v}</button>`).join('')}
    </div>
    <section class="card cp-bloco" id="aba-corpo">${corpoAba()}</section>`;
}
function corpoAba() {
  if (aba === 'questoes') return abaQuestoes();
  if (aba === 'disciplinas') return abaDisciplinas();
  if (aba === 'gabarito') return abaGabarito();
  return abaAlunos();
}
function celulaResp(q, r, i, editavel, l = null) {
  const g = av.questoes[i].g;
  const dupla = l && (l.duplas || {})[i];
  const conta = l ? certaNaFolha(l, i) : acertou(g, r);
  const cons = l && l.consideradas && l.consideradas[i];
  const cls = cons ? 'certo considerada' : conta ? 'certo' : r === '*' ? 'dupla' : !r ? 'branco' : 'errado';
  if (!editavel) return `<span class="cp-resp ${cls}" title="Questão ${i + 1}: ${r === '*' ? `duas marcações${dupla ? ` (${dupla.split('').join(' e ')})` : ''}` : r || 'em branco'} · certa: ${g === 'X' ? 'anulada' : g || '—'}${cons ? ' · considerada certa pelo coordenador' : ''}"><i>${i + 1}</i>${r === '*' ? (dupla ? dupla.split('').join('+') : '⁑') : r || '–'}</span>`;
  return `<label class="cp-resp ${cls}"><i>${i + 1}</i><select data-edq="${i}" aria-label="Resposta da questão ${i + 1}">${['', ...LETRAS.slice(0, av.nAlt).split(''), '*'].map(x => `<option value="${x}" ${x === (r || '') ? 'selected' : ''}>${x === '' ? '–' : x === '*' ? '⁑' : x}</option>`).join('')}</select></label>`;
}
// Questões que não contaram para o aluno, com o motivo — o coordenador pode considerar certa (ajudar o
// aluno numa dupla marcação, numa marca fraca que o leitor não pegou etc.). Fica registrado e dá pra desfazer.
function blocoNaoContaram(a, l) {
  const linhas = [], feitas = [];
  av.questoes.forEach((q, i) => {
    const r = l.respostas[i], cons = l.consideradas && l.consideradas[i];
    if (cons) { feitas.push(`<li><b>${i + 1}</b> considerada certa por ${esc(cons.por || '—')} em ${new Date(cons.em).toLocaleDateString('pt-BR')} <button type="button" class="cp-link perigo" data-considerar="${a.i}|${i}|0">desfazer</button></li>`); return; }
    if (q.g === 'X' || certaNaFolha(l, i)) return;
    const certa = q.g ? `a certa é ${q.g.split('').join(' ou ')}` : 'questão ainda sem gabarito';
    const dupla = (l.duplas || {})[i];
    const motivo = r === '*' ? `marcou ${dupla ? dupla.split('').join(' e ') : 'mais de uma'}${dupla && q.g && [...dupla].some(x => q.g.includes(x)) ? ' (uma delas é a certa)' : ''}` : !r ? 'em branco' : `marcou ${r}`;
    const duv = (l.duvidosas || []).includes(i) ? ' · <span class="cp-duv">marca fraca/apagada: confira na folha</span>' : '';
    linhas.push(`<li><b>${i + 1}</b> ${motivo}; ${certa}${duv} ${q.g ? `<button type="button" class="cp-link" data-considerar="${a.i}|${i}|1">considerar certa</button>` : ''}</li>`);
  });
  if (!linhas.length && !feitas.length) return '';
  return `<div class="cp-naocontou">
    ${linhas.length ? `<div><b>Questões que não contaram</b> <small>— se quiser ajudar o aluno, considere certa (fica registrado quem decidiu)</small><ul>${linhas.join('')}</ul></div>` : ''}
    ${feitas.length ? `<div><b>Consideradas certas pelo coordenador</b><ul>${feitas.join('')}</ul></div>` : ''}
  </div>`;
}
async function considerar(i, k, certa) {
  try {
    const r = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${i}/considerar`, { method: 'PUT', body: JSON.stringify({ questao: k, certa }) });
    leituras[i] = r.leitura; toast(r.message); renderAvaliacao();
  } catch (err) { toast(err.message, 'erro'); }
}
function abaAlunos() {
  const ts = av.turmas;
  const lista = av.alunos.filter(a => (!filtroTurma || a.turmaId === filtroTurma) && (!busca || a.nome.toLowerCase().includes(busca.toLowerCase())));
  return `<div class="cp-filtros">
      ${ts.length > 1 ? `<select id="fl-turma" aria-label="Turma"><option value="">Todas as turmas</option>${ts.map(t => `<option value="${esc(t.id)}" ${filtroTurma === t.id ? 'selected' : ''}>${esc(nomeTurma(t))}</option>`).join('')}</select>` : ''}
      <input id="fl-busca" type="search" placeholder="Buscar aluno" value="${esc(busca)}" aria-label="Buscar aluno">
      <button type="button" class="btn-secondary" data-add-aluno="1">+ Adicionar aluno</button>
    </div>
    <div class="cp-alunos">${lista.map(a => {
      const l = leituras[a.i], r = l ? resultado(l) : null;
      const aberto = abertoAluno === a.i;
      return `<article class="cp-aluno ${l ? 'lido' : ''}">
        <button type="button" class="cp-aluno-cab" data-aluno="${a.i}" aria-expanded="${aberto}">
          <span class="cp-aluno-nome">${esc(titulo(a.nome))}${a.extra ? ' <span class="cp-extra">adicionado</span>' : ''}<small>${esc(nomeTurma(turmaDe(a)))} · folha ${codigoLegivel(av.codigo, a.i)}</small></span>
          ${r ? `<span class="cp-nota"><b>${r.acertos}</b>/${r.total}${r.nota !== null ? `<small>nota ${r.nota.toLocaleString('pt-BR')}</small>` : `<small>${pct(r.acertos / r.total)}</small>`}</span>` : '<span class="cp-pend">sem folha lida</span>'}
        </button>
        ${aberto ? `<div class="cp-aluno-det">
          <div class="cp-resps">${av.questoes.map((q, i) => celulaResp(q, l ? l.respostas[i] : '', i, true, l)).join('')}</div>
          ${l ? blocoNaoContaram(a, l) : ''}
          ${r && Object.keys(r.porDisc).filter(Boolean).length > 1 ? `<div class="cp-pdisc">${Object.entries(r.porDisc).filter(([d]) => d).map(([d, x]) => `<span><b>${x.acertos}/${x.total}</b> ${esc(d)}</span>`).join('')}</div>` : ''}
          <div class="cp-aluno-pe">
            <span class="cp-dica">${l ? `${l.origem === 'manual' ? 'Corrigida à mão' : 'Lida pela câmera'} por ${esc(l.lidoPor || '—')} em ${new Date(l.lidoEm).toLocaleString('pt-BR')}` : 'Ainda sem leitura — dá para lançar à mão aqui.'}</span>
            <span class="cp-acoes">
              <button type="button" class="cp-link" data-folha-aluno="${a.i}">Baixar a folha (PDF)</button>
              ${l ? `<button type="button" class="cp-link perigo" data-apagar="${a.i}">Apagar leitura</button>` : ''}
              ${a.extra ? `<button type="button" class="cp-link perigo" data-tirar="${a.i}" title="Adicionado por ${esc(a.adicionadoPor || '—')}">Tirar da avaliação</button>` : ''}
              <button type="button" class="btn-primary" data-salvar-aluno="${a.i}">Salvar respostas</button>
            </span>
          </div>
        </div>` : ''}
      </article>`;
    }).join('') || '<div class="cp-vazio">Nenhum aluno encontrado.</div>'}</div>`;
}
function abaQuestoes() {
  const lidas = av.alunos.map(a => leituras[a.i]).filter(Boolean);
  if (!lidas.length) return '<div class="cp-vazio">Leia as folhas para ver o desempenho de cada questão.</div>';
  return `<p class="cp-dica">Questões em vermelho: menos da metade acertou — vale rever o enunciado ou o conteúdo.</p>
  <div class="cp-tab-wrap"><table class="data-table cp-tab"><thead><tr><th>Nº</th><th>Disciplina</th><th>Certa</th><th>Acertos</th><th>Como responderam</th></tr></thead><tbody>${av.questoes.map((q, i) => {
    const cont = {}; lidas.forEach(l => { const r = l.respostas[i] || '–'; cont[r] = (cont[r] || 0) + 1; });
    const ok = lidas.filter(l => certaNaFolha(l, i)).length, p = ok / lidas.length;
    const consid = lidas.filter(l => l.consideradas && l.consideradas[i]).length;
    return `<tr class="${p < 0.5 ? 'ruim' : ''}"><td class="num">${i + 1}</td><td>${esc(q.d || '—')}</td><td><b>${q.g === 'X' ? 'anulada' : esc(q.g || '—')}</b></td>
      <td><div class="cp-barra"><span style="width:${p * 100}%"></span></div><small>${pct(p)} (${ok}/${lidas.length})${consid ? ` · ${consid} considerada${consid > 1 ? 's' : ''} pelo coordenador` : ''}</small></td>
      <td class="cp-dist">${[...LETRAS.slice(0, av.nAlt).split(''), '–', '*'].filter(x => cont[x]).map(x => `<span class="${q.g.includes(x) ? 'certa' : ''}">${x === '*' ? '⁑' : x} ${cont[x]}</span>`).join('')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function abaDisciplinas() {
  const lidas = av.alunos.map(a => leituras[a.i]).filter(Boolean);
  const discs = faixas(av.questoes);
  if (!lidas.length) return '<div class="cp-vazio">Leia as folhas para ver o resultado por disciplina.</div>';
  if (!discs.length) return '<div class="cp-vazio">Esta avaliação não tem disciplinas definidas. Dá para definir em <b>Gabarito</b>.</div>';
  return `<div class="cp-discs">${discs.map(f => {
    let ok = 0, tot = 0;
    lidas.forEach(l => { for (let i = f.de - 1; i < f.ate; i++) { tot++; if (certaNaFolha(l, i)) ok++; } });
    const p = tot ? ok / tot : 0;
    return `<div class="cp-disc"><div><b>${esc(f.nome)}</b><small>questões ${f.de === f.ate ? f.de : `${f.de} a ${f.ate}`}</small></div><div class="cp-barra ${p < 0.5 ? 'ruim' : ''}"><span style="width:${p * 100}%"></span></div><b class="cp-disc-p">${pct(p)}</b></div>`;
  }).join('')}</div>`;
}
function abaGabarito() {
  if (!form || form.avId !== av.id) form = { avId: av.id, questoes: av.questoes.map(q => ({ ...q })), faixasD: faixas(av.questoes).map(x => ({ ...x })), nome: av.nome, data: av.data || '', valorTotal: av.valorTotal || '', nAlt: av.nAlt, tipo: av.tipo || 'outra', bimestre: av.bimestre || '', disciplina: av.disciplina || '', aceitarDupla: !!av.aceitarDupla };
  const f = form, ed = podeEditarAv;
  return `${ed ? '' : '<p class="cp-dica">Só quem criou a avaliação (ou a direção) altera o gabarito.</p>'}
    <div class="cp-campos">
      <label class="cp-campo cp-campo-grande">Nome <input id="g-nome" value="${esc(f.nome)}" ${ed ? '' : 'disabled'}></label>
      <label class="cp-campo">Data <input type="date" id="g-data" value="${esc(f.data)}" ${ed ? '' : 'disabled'}></label>
      <label class="cp-campo">Valor <input type="number" id="g-valor" step="0.1" min="0" value="${esc(f.valorTotal)}" ${ed ? '' : 'disabled'}></label>
    </div>
    <div class="cp-campos">
      <label class="cp-campo">Tipo <select id="g-tipo" ${ed ? '' : 'disabled'}>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${f.tipo === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="cp-campo">Bimestre <select id="g-bim" ${ed ? '' : 'disabled'}><option value="">—</option><option value="1" ${String(f.bimestre) === '1' ? 'selected' : ''}>1º bimestre</option><option value="2" ${String(f.bimestre) === '2' ? 'selected' : ''}>2º bimestre</option></select></label>
      <label class="cp-campo cp-campo-grande">Disciplina <input id="g-disc" maxlength="120" value="${esc(f.disciplina)}" ${ed ? '' : 'disabled'}></label>
    </div>
    <h3 class="cp-sub">Disciplinas</h3>
    <div class="cp-faixas">${f.faixasD.map((x, k) => `<div class="cp-faixa">
        <label>De <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="de" value="${x.de}" ${ed ? '' : 'disabled'}></label>
        <label>até <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="ate" value="${x.ate}" ${ed ? '' : 'disabled'}></label>
        <input class="cp-faixa-nome" data-fx="${k}" data-campo="nome" value="${esc(x.nome)}" ${ed ? '' : 'disabled'}>
        ${ed ? `<button type="button" class="cp-link perigo" data-fx-del="${k}">remover</button>` : ''}</div>`).join('')}
      ${ed ? '<button type="button" class="cp-link" data-fx-add="1">+ adicionar disciplina</button>' : ''}</div>
    <label class="cp-check-opcao"><input type="checkbox" id="g-dupla" ${f.aceitarDupla ? 'checked' : ''} ${ed ? '' : 'disabled'}> Quando o aluno marcar duas alternativas e uma delas for a certa, <b>contar como certa</b> <small>(vale para todos os alunos desta avaliação; para um aluno só, use "considerar certa" na ficha dele)</small></label>
    <h3 class="cp-sub">Resposta certa <small>— o número de questões não muda (as folhas já foram impressas)</small></h3>
    <div class="cp-gab">${f.questoes.map((q, i) => `<div class="cp-gab-q ${q.g ? '' : 'falta'}"><span class="cp-gab-n">${i + 1}</span>${LETRAS.slice(0, f.nAlt).split('').map(l => `<button type="button" class="cp-gab-l ${q.g === l ? 'on' : ''}" data-q="${i}" data-l="${l}" ${ed ? '' : 'disabled'}>${l}</button>`).join('')}<button type="button" class="cp-gab-x ${q.g === 'X' ? 'on' : ''}" data-q="${i}" data-l="X" ${ed ? '' : 'disabled'}>anular</button></div>`).join('')}</div>
    ${ed ? `<div class="cp-salvar"><button type="button" class="cp-link perigo" data-excluir-av="1">Excluir avaliação</button><button type="button" class="btn-primary" data-salvar-gab="1">Salvar gabarito</button></div>` : ''}`;
}
async function salvarGabarito(btn) {
  form.nome = $('g-nome').value; form.data = $('g-data').value; form.valorTotal = $('g-valor').value;
  form.tipo = $('g-tipo').value; form.bimestre = $('g-bim').value; form.disciplina = $('g-disc').value.trim(); form.aceitarDupla = $('g-dupla').checked;
  if (!form.disciplina) { toast('Informe a disciplina.', 'erro'); return; }
  aplicarFaixas();
  btn.disabled = true;
  try {
    await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}`, { method: 'PUT', body: JSON.stringify({ nome: form.nome, tipo: form.tipo, bimestre: form.bimestre || null, disciplina: form.disciplina, aceitarDupla: form.aceitarDupla, data: form.data, valorTotal: form.valorTotal ? Number(String(form.valorTotal).replace(',', '.')) : null, questoes: form.questoes }) });
    av = { ...av, nome: form.nome, aceitarDupla: form.aceitarDupla, tipo: form.tipo, bimestre: form.bimestre ? Number(form.bimestre) : null, disciplina: form.disciplina, data: form.data || null, valorTotal: form.valorTotal ? Number(String(form.valorTotal).replace(',', '.')) : null, questoes: form.questoes.map(q => ({ ...q })) };
    toast('Gabarito salvo. Os resultados foram recalculados.'); avaliacoes = null; renderAvaliacao();
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; }
}
async function salvarAluno(i, btn) {
  const respostas = av.questoes.map((_, k) => { const s = document.querySelector(`[data-edq="${k}"]`); return s ? s.value : ''; });
  btn.disabled = true;
  try {
    const r = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${i}`, { method: 'PUT', body: JSON.stringify({ respostas, duplas: (leituras[i] || {}).duplas || {}, origem: 'manual' }) });
    leituras[i] = r.leitura; toast('Respostas salvas.'); renderAvaliacao();
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; }
}
async function apagarLeitura(i) {
  if (!confirm('Apagar a leitura desta folha? Dá para ler de novo depois.')) return;
  try { await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${i}`, { method: 'DELETE' }); delete leituras[i]; toast('Leitura apagada.'); renderAvaliacao(); }
  catch (err) { toast(err.message, 'erro'); }
}
async function excluirAvaliacao(id = av && av.id, nome = av && av.nome) {
  const lidas = av && av.id === id ? Object.keys(leituras).length : null;
  const aviso = lidas === null ? 'e todas as folhas já lidas' : lidas ? `e as ${lidas} folha(s) já lida(s)` : '(nenhuma folha foi lida ainda)';
  if (!confirm(`Excluir a avaliação "${nome}" ${aviso}? Não dá para desfazer.`)) return;
  try {
    await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Avaliação excluída.');
    if (av && av.id === id) av = null;
    avaliacoes = null;
    if (view === 'lista') abrirLista(); else navegar('');
  } catch (err) { toast(err.message, 'erro'); }
}
async function baixarPlanilha(btn) {
  btn.disabled = true;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/correcao/avaliacoes/${encodeURIComponent(av.id)}/planilha`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erro ${res.status}`);
    const blob = await res.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${av.nome}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) { toast(err.message, 'erro'); } finally { btn.disabled = false; }
}

// ---------- ADICIONAR ALUNO QUE FALTOU ----------
function dialogoAddAluno() {
  const d = document.createElement('div');
  d.className = 'cp-modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Adicionar aluno');
  d.innerHTML = `<div class="cp-modal-box"><h2>Adicionar aluno</h2>
    <p class="cp-dica">Procure pelo nome nas turmas do curso (Edubox). Se não achar, digite o nome e adicione assim mesmo.</p>
    <label class="cp-campo">Nome do aluno <input id="ad-q" autocomplete="off" placeholder="Digite pelo menos 3 letras"></label>
    <div id="ad-res" class="cp-opcoes"></div>
    <div class="cp-salvar"><button type="button" class="btn-secondary" data-fechar-modal="1">Cancelar</button><button type="button" class="btn-primary" data-ad-manual="1">Adicionar com este nome</button></div></div>`;
  document.body.appendChild(d);
  const q = d.querySelector('#ad-q'); q.focus();
  let timer, achados = [];
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (q.value.trim().length < 3) { d.querySelector('#ad-res').innerHTML = ''; return; }
      try {
        achados = (await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/buscar-aluno?q=${encodeURIComponent(q.value.trim())}`)).alunos || [];
        d.querySelector('#ad-res').innerHTML = achados.length ? achados.map((a, k) => `<button type="button" class="cp-turma cp-achado" data-ad="${k}" ${a.jaEsta ? 'disabled' : ''}><span><b>${esc(titulo(a.nome))}</b><small>${esc(nomeTurma(a))} · matrícula ${esc(a.mat)}${a.jaEsta ? ' · já está na avaliação' : ''}</small></span></button>`).join('')
          : '<p class="cp-dica">Ninguém com esse nome nas turmas do curso. Dá para adicionar com o nome digitado.</p>';
      } catch (err) { toast(err.message, 'erro'); }
    }, 350);
  });
  const adicionar = async (corpo) => {
    try {
      const r = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/alunos`, { method: 'POST', body: JSON.stringify(corpo) });
      av.alunos.push(r.aluno); av.turmas = r.turmas;
      d.remove(); abertoAluno = r.aluno.i; busca = ''; filtroTurma = '';
      toast('Aluno adicionado. Baixe a folha dele em "Baixar a folha (PDF)".'); renderAvaliacao();
    } catch (err) { toast(err.message, 'erro'); }
  };
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-fechar-modal]')) { d.remove(); return; }
    const b = e.target.closest('[data-ad]'); if (b && !b.disabled) { const a = achados[Number(b.dataset.ad)]; adicionar({ alu: a.alu, mat: a.mat, nome: a.nome, turmaId: a.turmaId }); return; }
    if (e.target.closest('[data-ad-manual]')) { if (q.value.trim().length < 3) { toast('Digite o nome do aluno.', 'erro'); q.focus(); return; } adicionar({ nome: q.value.trim() }); }
  });
}
async function tirarAluno(i) {
  const a = av.alunos.find(x => x.i === i);
  if (!confirm(`Tirar ${titulo(a.nome)} desta avaliação? A leitura da folha dele também sai.`)) return;
  try {
    await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/alunos/${i}`, { method: 'DELETE' });
    av.alunos = av.alunos.filter(x => x.i !== i); delete leituras[i]; abertoAluno = null;
    toast('Aluno retirado.'); renderAvaliacao();
  } catch (err) { toast(err.message, 'erro'); }
}

// ---------- IMPRESSÃO DAS FOLHAS ----------
function dialogoImpressao() {
  const ts = av.turmas;
  const opcoes = [{ k: '', rot: `Todas as turmas da avaliação`, n: av.alunos.length }, ...(ts.length > 1 ? ts.map(t => ({ k: t.id, rot: nomeTurma(t), n: av.alunos.filter(a => a.turmaId === t.id).length })) : [])];
  const d = document.createElement('div');
  d.className = 'cp-modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Imprimir folhas');
  d.innerHTML = `<div class="cp-modal-box"><h2>Imprimir folhas de resposta</h2>
    <p class="cp-dica">Uma folha por aluno, <b>só a frente</b> (desligue a impressão frente e verso). Imprima em tamanho real (100%), sem "ajustar à página" se der.</p>
    <div class="cp-opcoes">${opcoes.map((o, k) => `<label class="cp-turma"><input type="radio" name="imp" value="${esc(o.k)}" ${k === 0 ? 'checked' : ''}><span><b>${esc(o.rot)}</b><small>${plural(o.n, 'folha', 'folhas')}</small></span></label>`).join('')}</div>
    <div class="cp-salvar"><button type="button" class="btn-secondary" data-fechar-modal="1">Cancelar</button><span class="cp-acoes"><button type="button" class="btn-secondary" data-gerar="imprimir">Imprimir direto</button><button type="button" class="btn-primary" data-gerar="pdf">Baixar PDF</button></span></div></div>`;
  document.body.appendChild(d);
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-fechar-modal]')) { d.remove(); return; }
    const g = e.target.closest('[data-gerar]');
    if (g) {
      const k = d.querySelector('input[name=imp]:checked').value;
      const lista = av.alunos.filter(a => !k || a.turmaId === k);
      const rot = k ? nomeTurma(av.turmas.find(t => t.id === k)) : 'todas as turmas';
      d.remove();
      if (g.dataset.gerar === 'pdf') baixarPdf(lista, rot); else imprimirFolhas(lista);
    }
  });
}
// PDF pronto pra salvar/mandar pra gráfica: uma página A4 por aluno, só a frente
async function baixarPdf(alunos, rotulo) {
  toast(`Gerando o PDF com ${plural(alunos.length, 'folha', 'folhas')}…`);
  try {
    const blob = await pdfDasFolhas(htmlFolhas(av, alunos));
    const nome = `Folhas de resposta - ${av.nome} - ${rotulo}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim();
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${nome}.pdf`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('PDF pronto. Imprima só a frente, em tamanho real (100%).');
  } catch (err) { console.error(err); toast(`Não foi possível gerar o PDF: ${err.message}`, 'erro'); }
}
function imprimirFolhas(alunos) {
  const janela = window.open('', '_blank');
  if (!janela) { toast('O navegador bloqueou a janela de impressão. Libere pop-ups para o Órbita.', 'erro'); return; }
  janela.document.open(); janela.document.write(htmlFolhas(av, alunos)); janela.document.close();
  const imgs = [...janela.document.images];
  const pronto = () => setTimeout(() => { janela.focus(); janela.print(); }, 300);
  let falta = imgs.filter(i => !i.complete).length;
  if (!falta) pronto(); else imgs.forEach(i => { i.onload = i.onerror = () => { if (--falta <= 0) pronto(); }; });
  // SVG <image> não entra em document.images: dá um tempo pro logo carregar
  if (!imgs.length) setTimeout(() => { janela.focus(); janela.print(); }, 900);
}

// ---------- LEITOR (câmera) ----------
let stream = null, rodando = false, ultimo = null, ultimoSalvo = { i: -1, t: 0 }, ocupado = false, timerLoop = null;
const cv = document.createElement('canvas');
function bip(ok = true) {
  try {
    const A = new (window.AudioContext || window.webkitAudioContext)(), o = A.createOscillator(), g = A.createGain();
    o.frequency.value = ok ? 880 : 300; g.gain.value = 0.08; o.connect(g); g.connect(A.destination); o.start(); setTimeout(() => { o.stop(); A.close(); }, ok ? 140 : 300);
  } catch (e) { /* sem som */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]);
}
function contagemLeitor() {
  const n = av.alunos.filter(a => leituras[a.i]).length;
  $('lt-cont').textContent = ` · ${n} de ${av.alunos.length} corrigidas`;
}
async function abrirLeitor() {
  if (av.questoes.some(q => !q.g)) toast('Atenção: há questões sem gabarito. A leitura é guardada e o acerto é recalculado quando completar.', 'erro');
  $('leitor').classList.remove('hidden'); document.body.classList.add('cp-sem-rolagem');
  $('lt-nome').textContent = av.nome; contagemLeitor();
  $('lt-res').classList.add('hidden');
  status('Abrindo a câmera…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const v = $('lt-video'); v.srcObject = stream; await v.play();
    const track = stream.getVideoTracks()[0], cap = track.getCapabilities ? track.getCapabilities() : {};
    $('lt-lanterna').hidden = !cap.torch;
    rodando = true; ultimo = null; status('Aponte a câmera para a folha, com os 4 quadrados pretos aparecendo.');
    loop();
  } catch (err) {
    status(location.protocol !== 'https:' && location.hostname !== 'localhost' ? 'A câmera ao vivo só abre no endereço seguro (https) do Órbita. Aqui, use "Usar foto ou arquivo" e tire a foto da folha.' : `Não deu para abrir a câmera (${err.message}). Libere o acesso à câmera ou use "Usar foto ou arquivo".`);
  }
}
function fecharLeitor() {
  rodando = false; clearTimeout(timerLoop);
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  $('leitor').classList.add('hidden'); document.body.classList.remove('cp-sem-rolagem');
  if (view === 'av') renderAvaliacao();
}
function status(t, cls = '') { const s = $('lt-status'); s.textContent = t; s.className = `cp-leitor-status ${cls}`; }
function desenharQuad(quad, cor) {
  const o = $('lt-overlay'), v = $('lt-video');
  o.width = v.videoWidth; o.height = v.videoHeight;
  const c = o.getContext('2d'); c.clearRect(0, 0, o.width, o.height);
  if (!quad) return;
  c.strokeStyle = cor; c.lineWidth = Math.max(4, o.width / 200); c.beginPath();
  quad.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
}
const infoCodigo = (id) => (id.cod === av.codigo && av.alunos.some(a => a.i === id.i) ? { nQuestoes: av.questoes.length, nAlt: av.nAlt } : null);
function loop() {
  if (!rodando) return;
  const v = $('lt-video');
  if (!ocupado && v.videoWidth) {
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(v, 0, 0);
    let r = null;
    try { r = lerFolha(c.getImageData(0, 0, cv.width, cv.height), { aoAcharCodigo: infoCodigo }); } catch (e) { console.error(e); }
    if (!r) { desenharQuad(null); ultimo = null; }
    else if (r.semCodigo) { desenharQuad(r.quad, '#e8791e'); status('Achei a folha, mas não consegui ler o código (faixa de quadradinhos). Aproxime, tire a sombra ou o reflexo; se estiver rabiscado, lance à mão em Alunos.', 'aviso'); ultimo = null; }
    else if (r.outra) { desenharQuad(r.quad, '#e8791e'); status(r.cod === av.codigo ? `Folha ${codigoLegivel(av.codigo, r.i)}: esse aluno não está mais na avaliação.` : `Esta folha é de outra avaliação (código ${String(r.cod).padStart(4, '0')}).`, 'aviso'); ultimo = null; }
    else {
      desenharQuad(r.quad, '#16a34a');
      const assin = `${r.i}|${r.respostas.join('')}`;
      // só aceita quando duas leituras seguidas batem (evita foto tremida)
      if (ultimo === assin && !(ultimoSalvo.i === r.i && Date.now() - ultimoSalvo.t < 6000)) { aceitar(r); }
      else { ultimo = assin; if (!(ultimoSalvo.i === r.i)) status('Segure firme…'); }
    }
  }
  timerLoop = setTimeout(loop, 280);
}
async function aceitar(r, deArquivo = false) {   // devolve true se salvou
  const aluno = av.alunos.find(a => a.i === r.i);
  ocupado = !deArquivo;
  const antes = !!leituras[r.i];
  try {
    const s = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${r.i}`, { method: 'PUT', body: JSON.stringify({ respostas: r.respostas, duplas: r.duplas || {}, duvidosas: r.duvidosas || [], origem: 'camera' }) });
    leituras[r.i] = s.leitura; ultimoSalvo = { i: r.i, t: Date.now() };
    bip(true); contagemLeitor();
    mostrarResultado(aluno, s.leitura, antes);
    if (!deArquivo) status('Corrigida! Pode passar para a próxima folha.', 'ok');
    return true;
  } catch (err) { bip(false); status(`Não salvou (${err.message}). Confira a internet e leia a folha de novo.`, 'aviso'); return false; }
  finally { setTimeout(() => { ocupado = false; ultimo = null; }, deArquivo ? 0 : 1200); }
}
function mostrarResultado(aluno, l, substituiu) {
  const r = resultado(l);
  const duplas = l.respostas.filter(x => x === '*').length, brancos = l.respostas.filter(x => !x).length, duv = (l.duvidosas || []).length;
  const muitasBranco = brancos > l.respostas.length / 2;
  const el = $('lt-res'); el.classList.remove('hidden');
  el.innerHTML = `<div class="cp-lr-cab"><div><b>${esc(titulo(aluno.nome))}</b><small>${esc(nomeTurma(turmaDe(aluno)))}${substituiu ? ' · leitura anterior substituída' : ''}</small></div>
      <div class="cp-lr-nota"><b>${r.acertos}</b>/${r.total}${r.nota !== null ? `<small>nota ${r.nota.toLocaleString('pt-BR')}</small>` : ''}</div></div>
    ${muitasBranco ? `<div class="cp-lr-av forte">Mais da metade em branco: confira se a folha foi preenchida com caneta e se é a folha certa.</div>` : ''}
    ${duplas || brancos || duv ? `<div class="cp-lr-av">${duplas ? `${plural(duplas, 'questão com duas marcações', 'questões com duas marcações')}${av.aceitarDupla ? '' : ' (conta como erro)'}. ` : ''}${brancos ? `${plural(brancos, 'em branco', 'em branco')}. ` : ''}${duv ? `${plural(duv, 'marca fraca ou apagada', 'marcas fracas ou apagadas')} para conferir. ` : ''}Dá para ajustar ou considerar certa em Alunos.</div>` : ''}
    <div class="cp-resps mini">${av.questoes.map((q, i) => celulaResp(q, l.respostas[i], i, false, l)).join('')}</div>`;
}
async function lerArquivos(files) {
  let ok = 0, falhou = 0;
  for (const f of files) {
    status(`Lendo ${f.name}…`);
    try {
      const bmp = await createImageBitmap(f);
      const esc2 = Math.min(1, 2600 / Math.max(bmp.width, bmp.height));
      cv.width = Math.round(bmp.width * esc2); cv.height = Math.round(bmp.height * esc2);
      const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(bmp, 0, 0, cv.width, cv.height);
      const r = lerFolha(c.getImageData(0, 0, cv.width, cv.height), { aoAcharCodigo: infoCodigo });
      if (r && !r.outra && !r.semCodigo && await aceitar(r, true)) ok++; else falhou++;
    } catch (e) { falhou++; }
  }
  status(`${plural(ok, 'folha corrigida', 'folhas corrigidas')}${falhou ? ` · ${plural(falhou, 'arquivo não foi reconhecido', 'arquivos não foram reconhecidos')} (confira se os 4 quadrados aparecem e se a folha é desta avaliação)` : ''}.`, falhou ? 'aviso' : 'ok');
}

// ---------- EVENTOS ----------
function wireEventos() {
  window.addEventListener('popstate', () => irPara(location.hash));
  $('tela').addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-voltar]')) { navegar(''); return; }
    if (t.closest('[data-nova]')) { navegar('#nova'); return; }
    const ex = t.closest('[data-excluir-lista]'); if (ex) { const a = (avaliacoes || []).find(x => x.id === ex.dataset.excluirLista); if (a) excluirAvaliacao(a.id, a.nome); return; }
    const ab = t.closest('[data-abrir]'); if (ab) { navegar(`#av/${ab.dataset.abrir}`); return; }
    // formulário (nova avaliação e aba Gabarito)
    const mo = t.closest('[data-modo]'); if (mo) { lerCamposForm(); form.modo = mo.dataset.modo; renderNova(); return; }
    const or = t.closest('[data-origem]');
    if (or) { lerCamposForm(); form.origem = or.dataset.origem === 'manual' ? 'manual' : 'banco'; if (form.origem === 'manual') { form.compBanco = false; form.provaId = ''; } renderNova(); if (form.origem === 'banco') carregarProvasBanco(); return; }
    const gl = t.closest('[data-q][data-l]');
    if (gl && !gl.disabled) {
      const q = form.questoes[Number(gl.dataset.q)]; q.g = q.g === gl.dataset.l ? '' : gl.dataset.l;
      const linha = gl.closest('.cp-gab-q');
      linha.classList.toggle('falta', !q.g);
      linha.querySelectorAll('[data-l]').forEach(b => { b.classList.toggle('on', b.dataset.l === q.g); b.setAttribute('aria-pressed', b.dataset.l === q.g); });
      avisoForm(); return;
    }
    if (t.closest('[data-fx-add]')) {
      const ult = form.faixasD[form.faixasD.length - 1];
      const de = ult ? Math.min(form.questoes.length, ult.ate + 1) : 1;
      form.faixasD.push({ de, ate: form.questoes.length, nome: '' });
      redesenharForm(); return;
    }
    if (t.closest('[data-comp-add]')) { lerCamposForm(); form.comp.push({ nome: '', qtd: 0, novo: true }); renderNova(); const ult = document.querySelectorAll('[data-comp-nome]'); if (ult.length) ult[ult.length - 1].focus(); return; }
    const cd = t.closest('[data-comp-del]'); if (cd) { lerCamposForm(); form.comp.splice(Number(cd.dataset.compDel), 1); aplicarComp(); renderNova(); return; }
    if (t.closest('[data-comp-dividir]')) { lerCamposForm(); dividirResto(form.comp); aplicarComp(); renderNova(); return; }
    const fd = t.closest('[data-fx-del]'); if (fd) { form.faixasD.splice(Number(fd.dataset.fxDel), 1); redesenharForm(); return; }
    if (t.closest('#f-salvar')) { salvarNova(t.closest('#f-salvar')); return; }
    // avaliação
    const a = t.closest('[data-aba]'); if (a) { aba = a.dataset.aba; renderAvaliacao(); return; }
    const al = t.closest('[data-aluno]'); if (al) { const i = Number(al.dataset.aluno); abertoAluno = abertoAluno === i ? null : i; $('aba-corpo').innerHTML = corpoAba(); return; }
    const cz = t.closest('[data-considerar]'); if (cz) { const [i, k, c] = cz.dataset.considerar.split('|').map(Number); considerar(i, k, !!c); return; }
    const sa = t.closest('[data-salvar-aluno]'); if (sa) { salvarAluno(Number(sa.dataset.salvarAluno), sa); return; }
    const ap = t.closest('[data-apagar]'); if (ap) { apagarLeitura(Number(ap.dataset.apagar)); return; }
    if (t.closest('[data-add-aluno]')) { dialogoAddAluno(); return; }
    const ti = t.closest('[data-tirar]'); if (ti) { tirarAluno(Number(ti.dataset.tirar)); return; }
    const fa = t.closest('[data-folha-aluno]'); if (fa) { const al = av.alunos.find(x => x.i === Number(fa.dataset.folhaAluno)); baixarPdf([al], titulo(al.nome)); return; }
    if (t.closest('[data-ler]')) { abrirLeitor(); return; }
    if (t.closest('[data-imprimir]')) { dialogoImpressao(); return; }
    const pl = t.closest('[data-planilha]'); if (pl) { baixarPlanilha(pl); return; }
    const sg = t.closest('[data-salvar-gab]'); if (sg) { salvarGabarito(sg); return; }
    if (t.closest('[data-excluir-av]')) { excluirAvaliacao(); return; }
  });
  $('tela').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-turma]')) {
      const tt = turmas.find(x => x.id === t.dataset.turma);
      const juntos = [tt, ...parceiras(tt)];
      juntos.forEach(x => (t.checked ? form.turmasSel.add(x.id) : form.turmasSel.delete(x.id)));
      lerCamposForm(); carregarDisciplinas(); renderNova(); return;
    }
    if (t.id === 'f-curso') { lerCamposForm(); form.curso = t.value; form.dp = null; renderNova(); return; }
    if (t.matches('[data-dp]')) {
      const cc = turmas.find(x => x.curso === form.curso).codcur, d = dpCache[cc].find(x => x.chave === t.dataset.dp);
      lerCamposForm(); form.dp = { codcur: cc, chave: d.chave, nome: d.nome, alunos: d.alunos };
      if (!form.nome) form.nome = `Prova de DP — ${titulo(d.nome)}`;
      renderNova(); return;
    }
    if (t.id === 'f-prova') { escolherProva(t.value); return; }
    if (t.id === 'f-disc') { lerCamposForm(); form.discOutra = t.value === '__outra'; form.disciplina = form.discOutra ? '' : t.value; if (form.disciplina === VARIAS) form.tipo = 'simulado'; form.professor = ''; renderNova(); if (form.discOutra) $('f-disc-outra').focus(); return; }
    if (t.id === 'f-tipo') {
      const antes = form.tipo; lerCamposForm();
      if (form.tipo === 'simulado' && antes !== 'simulado') { form.comp = null; form.disciplina = VARIAS; form.discOutra = false; }
      if (form.tipo !== 'simulado' && antes === 'simulado' && form.disciplina === VARIAS) form.disciplina = '';
      renderNova(); return;
    }
    if (t.id === 'f-bim') { lerCamposForm(); renderNova(); return; }
    if (t.id === 'f-total') { lerCamposForm(); form.totalSim = Math.max(1, Math.min(MAX_QUESTOES, Number(t.value) || 40)); dividirResto(form.comp || []); aplicarComp(); renderNova(); return; }
    if (t.matches('[data-comp]')) { lerCamposForm(); { const c = form.comp[Number(t.dataset.comp)]; c.qtd = Math.max(0, Math.min(MAX_QUESTOES, Number(t.value) || 0)); c.fixo = true; } aplicarComp(); renderNova(); return; }
    if (t.matches('[data-comp-nome]')) { lerCamposForm(); form.comp[Number(t.dataset.compNome)].nome = t.value.trim(); aplicarComp(); renderNova(); return; }
    if (t.id === 'f-n') {
      const n = Math.max(1, Math.min(MAX_QUESTOES, Number(t.value) || 1));
      lerCamposForm();
      while (form.questoes.length < n) form.questoes.push(novaQuestao());
      form.questoes.length = n;
      form.faixasD.forEach(x => { x.ate = Math.min(x.ate, n); x.de = Math.min(x.de, n); });
      renderNova(); return;
    }
    if (t.id === 'f-nalt') { lerCamposForm(); form.nAlt = Number(t.value); form.questoes.forEach(q => { if (q.g === 'E' && form.nAlt === 4) q.g = ''; }); renderNova(); return; }
    if (t.id === 'f-colar') {
      const letras = t.value.toUpperCase().replace(/[^A-EX]/g, '');
      letras.split('').slice(0, form.questoes.length).forEach((l, i) => { if (LETRAS.slice(0, form.nAlt).includes(l) || l === 'X') form.questoes[i].g = l; });
      lerCamposForm(); renderNova(); toast(`${plural(Math.min(letras.length, form.questoes.length), 'resposta preenchida', 'respostas preenchidas')}.`); return;
    }
    if (t.matches('[data-fx]')) {
      const x = form.faixasD[Number(t.dataset.fx)], c = t.dataset.campo;
      x[c] = c === 'nome' ? t.value.trim() : Math.max(1, Math.min(form.questoes.length, Number(t.value) || 1));
      return;
    }
    if (['ls-sem', 'ls-quem', 'ls-tipo'].includes(t.id)) { if (t.id === 'ls-sem') filtroSem = t.value; if (t.id === 'ls-quem') filtroQuem = t.value; if (t.id === 'ls-tipo') filtroTipo = t.value; abrirLista(); return; }
    if (t.id === 'fl-turma') { filtroTurma = t.value; $('aba-corpo').innerHTML = corpoAba(); return; }
    if (t.matches('[data-edq]')) {
      const cel = t.closest('.cp-resp'), i = Number(t.dataset.edq), r = t.value, g = av.questoes[i].g;
      cel.className = `cp-resp ${r === '*' ? 'dupla' : !r ? 'branco' : acertou(g, r) ? 'certo' : 'errado'}`;
    }
  });
  $('tela').addEventListener('input', (e) => {
    if (e.target.id === 'ls-busca') {
      buscaLista = e.target.value; const pos = e.target.selectionStart;
      abrirLista(); const b = $('ls-busca'); b.focus(); b.setSelectionRange(pos, pos); return;
    }
    if (e.target.id === 'fl-busca') {
      busca = e.target.value;
      const pos = e.target.selectionStart;
      $('aba-corpo').innerHTML = corpoAba();
      const b = $('fl-busca'); b.focus(); b.setSelectionRange(pos, pos);
    }
  });
  $('lt-fechar').addEventListener('click', fecharLeitor);
  $('lt-foto').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) lerArquivos(fs); });
  $('lt-lanterna').addEventListener('click', async () => {
    const tr = stream && stream.getVideoTracks()[0]; if (!tr) return;
    const ligado = !!(tr.getSettings && tr.getSettings().torch);
    try { await tr.applyConstraints({ advanced: [{ torch: !ligado }] }); } catch (e) { /* sem lanterna */ }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('leitor').classList.contains('hidden')) fecharLeitor(); });
}
function redesenharForm() {
  if (view === 'nova') { lerCamposForm(); renderNova(); }
  else if (view === 'av' && aba === 'gabarito') {
    form.nome = $('g-nome').value; form.data = $('g-data').value; form.valorTotal = $('g-valor').value;
    form.tipo = $('g-tipo').value; form.bimestre = $('g-bim').value; form.disciplina = $('g-disc').value; form.aceitarDupla = $('g-dupla').checked;
    $('aba-corpo').innerHTML = corpoAba();
  }
}
