import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';
import { lerFolha, LETRAS, MAX_QUESTOES } from './leitor.js';
import { htmlFolhas, faixas, codigoLegivel } from './folha.js';

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
  if (rota === 'nova') return abrirNova();
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
async function abrirLista() {
  view = 'lista';
  $('tela').innerHTML = cabecalho('Correção de Provas', 'Folha de respostas por aluno e correção pela câmera do celular. Turmas e alunos vêm do Edubox.',
    podeCriar ? '<button type="button" class="btn-primary" data-nova="1">+ Nova avaliação</button>' : '') + '<div class="card cp-vazio">Carregando…</div>';
  try {
    const r = await apiFetch('/correcao/avaliacoes');
    avaliacoes = r.avaliacoes || [];
  } catch (err) { $('tela').querySelector('.cp-vazio').textContent = `Não foi possível carregar: ${err.message}`; return; }
  if (view !== 'lista') return;
  const corpo = avaliacoes.length ? `<div class="cp-lista">${avaliacoes.map(a => `
      <button type="button" class="card cp-item" data-abrir="${esc(a.id)}">
        <div class="cp-item-cod">${String(a.codigo).padStart(4, '0')}</div>
        <div class="cp-item-txt"><b>${esc(a.nome)}</b>
          <small>${a.data ? fmtData(a.data) + ' · ' : ''}${plural(a.questoes.length, 'questão', 'questões')} · ${esc(a.turmas.map(t => titulo(t.turma.replace(/ - \d{4}.\d$/, ''))).join(', '))}</small></div>
        <div class="cp-item-n"><b>${a.nAlunos}</b><small>alunos</small></div>
      </button>`).join('')}</div>`
    : `<div class="card cp-vazio"><b>Nenhuma avaliação ainda.</b><br>${podeCriar ? 'Clique em <b>+ Nova avaliação</b> para começar: escolha as turmas, o gabarito e imprima as folhas.' : ''}</div>`;
  $('tela').innerHTML = cabecalho('Correção de Provas', 'Folha de respostas por aluno e correção pela câmera do celular. Turmas e alunos vêm do Edubox.',
    podeCriar ? '<button type="button" class="btn-primary" data-nova="1">+ Nova avaliação</button>' : '') + corpo;
}

// ---------- NOVA AVALIAÇÃO ----------
const novaQuestao = () => ({ g: '', d: '' });
async function abrirNova() {
  view = 'nova';
  form = { nome: '', data: new Date().toISOString().slice(0, 10), valorTotal: '', turmasSel: new Set(), curso: '', nAlt: 5, questoes: Array.from({ length: 10 }, novaQuestao), origem: 'manual', provaId: '', faixasD: [], modo: 'turmas', dp: null };
  $('tela').innerHTML = cabecalho('Nova avaliação', 'Escolha as turmas, defina o gabarito e salve. Depois é só imprimir as folhas.', '', true) + '<div class="card cp-vazio">Carregando as turmas…</div>';
  if (!turmas) {
    try { turmas = (await apiFetch('/correcao/turmas')).turmas || []; }
    catch (err) { $('tela').querySelector('.cp-vazio').textContent = `Não foi possível carregar as turmas: ${err.message}`; return; }
  }
  if (view !== 'nova') return;
  const cursos = [...new Set(turmas.map(t => t.curso))];
  if (cursos.length === 1) form.curso = cursos[0];
  renderNova();
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
    <h2 class="card-secao-titulo"><span class="cp-passo">1</span> Identificação</h2>
    <div class="cp-campos">
      <label class="cp-campo cp-campo-grande">Nome da avaliação <input id="f-nome" maxlength="120" value="${esc(f.nome)}" placeholder="Ex.: Simulado 2º bimestre — Enfermagem 1 e 2"></label>
      <label class="cp-campo">Data da aplicação <input type="date" id="f-data" value="${esc(f.data)}"></label>
      <label class="cp-campo">Valor da prova <small>(opcional)</small><input type="number" id="f-valor" min="0" max="100" step="0.1" value="${esc(f.valorTotal)}" placeholder="Ex.: 2,0"></label>
    </div>
  </section>

  <section class="card cp-bloco">
    <h2 class="card-secao-titulo"><span class="cp-passo">2</span> Quem faz a prova <small>— ${f.modo === 'dp' ? (f.dp ? `DP de ${esc(titulo(f.dp.nome))}, ${plural(f.dp.alunos, 'aluno', 'alunos')}` : 'escolha a disciplina de DP') : `${plural(f.turmasSel.size, 'turma escolhida', 'turmas escolhidas')}, ${plural(nSel, 'aluno', 'alunos')}`} (uma folha por aluno)</small></h2>
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
          <span><b>${esc(nomeTurma(t))}</b><small>${esc(cursoCurto(t.curso))} · ${plural(t.alunos || 0, 'aluno', 'alunos')}</small></span></label>`).join('')}
      </div>`).join('') || '<div class="cp-vazio">Nenhuma turma no CADD para o seu curso.</div>'}</div>`}
  </section>

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
      <label class="cp-campo">Nº de questões <input type="number" id="f-n" min="1" max="${MAX_QUESTOES}" value="${f.questoes.length}"></label>
      <label class="cp-campo">Alternativas <select id="f-nalt"><option value="5" ${f.nAlt === 5 ? 'selected' : ''}>A a E</option><option value="4" ${f.nAlt === 4 ? 'selected' : ''}>A a D</option></select></label>
      <label class="cp-campo cp-campo-grande">Colar o gabarito <small>(opcional — ex.: ABCDA BECDA…)</small><input id="f-colar" placeholder="Digite as letras em sequência e saia do campo"></label>
    </div>
    <h3 class="cp-sub">Disciplinas <small>— aparecem na folha do aluno e no resultado por disciplina (no simulado, uma faixa por disciplina)</small></h3>
    <div class="cp-faixas">${f.faixasD.map((x, k) => `<div class="cp-faixa">
        <label>De <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="de" value="${x.de}"></label>
        <label>até <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="ate" value="${x.ate}"></label>
        <input class="cp-faixa-nome" data-fx="${k}" data-campo="nome" value="${esc(x.nome)}" placeholder="Nome da disciplina">
        <button type="button" class="cp-link perigo" data-fx-del="${k}">remover</button></div>`).join('')}
      <button type="button" class="cp-link" data-fx-add="1">+ adicionar disciplina</button>
      ${!f.faixasD.length && fx.length ? '' : ''}</div>
    <h3 class="cp-sub">Resposta certa de cada questão <small>— toque na letra; "anular" vale a questão para todos</small></h3>
    <div class="cp-gab">${f.questoes.map((q, i) => `<div class="cp-gab-q ${q.g ? '' : 'falta'}"><span class="cp-gab-n">${i + 1}</span>${LETRAS.slice(0, f.nAlt).split('').map(l => `<button type="button" class="cp-gab-l ${q.g === l ? 'on' : ''}" data-q="${i}" data-l="${l}" aria-pressed="${q.g === l}">${l}</button>`).join('')}<button type="button" class="cp-gab-x ${q.g === 'X' ? 'on' : ''}" data-q="${i}" data-l="X" title="Anular a questão (vale para todos)">anular</button></div>`).join('')}</div>
  </section>

  <div class="cp-salvar"><span class="cp-dica" id="f-aviso"></span><button type="button" class="btn-primary" id="f-salvar">Salvar avaliação</button></div>`;
  avisoForm();
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
    form.questoes = r.questoes.map(q => ({ g: q.g.length === 1 ? q.g : (q.g || ''), d: q.d || '' }));
    form.faixasD = faixas(form.questoes).map(x => ({ ...x }));
    if (!form.nome) form.nome = r.nome;
    renderNova();
    toast(`Gabarito de "${r.nome}" carregado${r.dissertativas ? ` (${plural(r.dissertativas, 'dissertativa fica', 'dissertativas ficam')} fora da folha)` : ''}.`);
  } catch (err) { toast(err.message, 'erro'); }
}
async function salvarNova(btn) {
  lerCamposForm();
  const f = form;
  if (!f.nome.trim()) { toast('Dê um nome para a avaliação.', 'erro'); $('f-nome').focus(); return; }
  if (f.modo === 'dp' ? !f.dp : !f.turmasSel.size) { toast(f.modo === 'dp' ? 'Escolha a disciplina de DP.' : 'Escolha pelo menos uma turma.', 'erro'); return; }
  aplicarFaixas();
  btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    const r = await apiFetch('/correcao/avaliacoes', { method: 'POST', body: JSON.stringify({
      nome: f.nome, data: f.data, valorTotal: f.valorTotal ? Number(String(f.valorTotal).replace(',', '.')) : null,
      turmas: f.modo === 'dp' ? [] : [...f.turmasSel], dp: f.modo === 'dp' ? f.dp : null, nAlt: f.nAlt, questoes: f.questoes, origem: f.origem === 'banco' ? 'manual' : f.origem, provaId: f.provaId
    }) });
    toast('Avaliação criada. Agora imprima as folhas.');
    avaliacoes = null;
    navegar(`#av/${r.id}`);
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; btn.textContent = 'Salvar avaliação'; }
}

// ---------- RESULTADO (cálculo igual ao do servidor) ----------
function acertou(g, r) { return g === 'X' ? true : !!g && !!r && r.length === 1 && g.includes(r); }
function resultado(respostas) {
  const porDisc = {}; let acertos = 0;
  av.questoes.forEach((q, i) => {
    const ok = acertou(q.g, respostas[i]); if (ok) acertos++;
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
  const res = lidas.map(a => resultado(leituras[a.i].respostas));
  const media = res.length ? res.reduce((s, r) => s + r.acertos, 0) / res.length : null;
  const n = av.questoes.length;
  const semGab = av.questoes.filter(q => !q.g).length;
  const kpi = (cls, rot, val, dica) => `<div class="kpi-card ${cls}"><div class="kpi-label">${rot}</div><div class="kpi-value">${val}</div><div class="kpi-hint">${dica}</div></div>`;
  const acoes = `
    <button type="button" class="btn-primary" data-ler="1"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Ler folhas</button>
    <button type="button" class="btn-secondary" data-imprimir="1">Imprimir folhas</button>
    <button type="button" class="btn-secondary" data-planilha="1">Baixar planilha</button>`;
  const sub = `${av.dp ? `<b>Prova de DP — ${esc(titulo(av.dp.disciplina))}</b> · ` : ''}Código ${String(av.codigo).padStart(4, '0')} · ${av.data ? fmtData(av.data) + ' · ' : ''}${plural(n, 'questão', 'questões')} (${LETRAS.slice(0, av.nAlt).split('').join(', ')}) · ${esc(av.turmas.map(t => nomeTurma(t)).join(', '))} · criada por ${esc(av.criadoPor || '—')}`;
  $('tela').innerHTML = cabecalho(av.nome, sub, acoes, true) + `
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
function celulaResp(q, r, i, editavel) {
  const g = av.questoes[i].g;
  const cls = r === '*' ? 'dupla' : !r ? 'branco' : acertou(g, r) ? 'certo' : 'errado';
  if (!editavel) return `<span class="cp-resp ${cls}" title="Questão ${i + 1}: ${r === '*' ? 'duas marcações' : r || 'em branco'} · certa: ${g === 'X' ? 'anulada' : g || '—'}"><i>${i + 1}</i>${r === '*' ? '⁑' : r || '–'}</span>`;
  return `<label class="cp-resp ${cls}"><i>${i + 1}</i><select data-edq="${i}" aria-label="Resposta da questão ${i + 1}">${['', ...LETRAS.slice(0, av.nAlt).split(''), '*'].map(x => `<option value="${x}" ${x === (r || '') ? 'selected' : ''}>${x === '' ? '–' : x === '*' ? '⁑' : x}</option>`).join('')}</select></label>`;
}
function abaAlunos() {
  const ts = av.turmas;
  const lista = av.alunos.filter(a => (!filtroTurma || a.turmaId === filtroTurma) && (!busca || a.nome.toLowerCase().includes(busca.toLowerCase())));
  return `<div class="cp-filtros">
      ${ts.length > 1 ? `<select id="fl-turma" aria-label="Turma"><option value="">Todas as turmas</option>${ts.map(t => `<option value="${esc(t.id)}" ${filtroTurma === t.id ? 'selected' : ''}>${esc(nomeTurma(t))}</option>`).join('')}</select>` : ''}
      <input id="fl-busca" type="search" placeholder="Buscar aluno" value="${esc(busca)}" aria-label="Buscar aluno">
    </div>
    <div class="cp-alunos">${lista.map(a => {
      const l = leituras[a.i], r = l ? resultado(l.respostas) : null;
      const aberto = abertoAluno === a.i;
      return `<article class="cp-aluno ${l ? 'lido' : ''}">
        <button type="button" class="cp-aluno-cab" data-aluno="${a.i}" aria-expanded="${aberto}">
          <span class="cp-aluno-nome">${esc(titulo(a.nome))}<small>${esc(nomeTurma(turmaDe(a)))} · folha ${codigoLegivel(av.codigo, a.i)}</small></span>
          ${r ? `<span class="cp-nota"><b>${r.acertos}</b>/${r.total}${r.nota !== null ? `<small>nota ${r.nota.toLocaleString('pt-BR')}</small>` : `<small>${pct(r.acertos / r.total)}</small>`}</span>` : '<span class="cp-pend">sem folha lida</span>'}
        </button>
        ${aberto ? `<div class="cp-aluno-det">
          <div class="cp-resps">${av.questoes.map((q, i) => celulaResp(q, l ? l.respostas[i] : '', i, true)).join('')}</div>
          ${r && Object.keys(r.porDisc).filter(Boolean).length > 1 ? `<div class="cp-pdisc">${Object.entries(r.porDisc).filter(([d]) => d).map(([d, x]) => `<span><b>${x.acertos}/${x.total}</b> ${esc(d)}</span>`).join('')}</div>` : ''}
          <div class="cp-aluno-pe">
            <span class="cp-dica">${l ? `${l.origem === 'manual' ? 'Corrigida à mão' : 'Lida pela câmera'} por ${esc(l.lidoPor || '—')} em ${new Date(l.lidoEm).toLocaleString('pt-BR')}` : 'Ainda sem leitura — dá para lançar à mão aqui.'}</span>
            <span class="cp-acoes">
              <button type="button" class="cp-link" data-folha-aluno="${a.i}">Imprimir a folha</button>
              ${l ? `<button type="button" class="cp-link perigo" data-apagar="${a.i}">Apagar leitura</button>` : ''}
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
    const ok = lidas.filter(l => acertou(q.g, l.respostas[i])).length, p = ok / lidas.length;
    return `<tr class="${p < 0.5 ? 'ruim' : ''}"><td class="num">${i + 1}</td><td>${esc(q.d || '—')}</td><td><b>${q.g === 'X' ? 'anulada' : esc(q.g || '—')}</b></td>
      <td><div class="cp-barra"><span style="width:${p * 100}%"></span></div><small>${pct(p)} (${ok}/${lidas.length})</small></td>
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
    lidas.forEach(l => { for (let i = f.de - 1; i < f.ate; i++) { tot++; if (acertou(av.questoes[i].g, l.respostas[i])) ok++; } });
    const p = tot ? ok / tot : 0;
    return `<div class="cp-disc"><div><b>${esc(f.nome)}</b><small>questões ${f.de === f.ate ? f.de : `${f.de} a ${f.ate}`}</small></div><div class="cp-barra ${p < 0.5 ? 'ruim' : ''}"><span style="width:${p * 100}%"></span></div><b class="cp-disc-p">${pct(p)}</b></div>`;
  }).join('')}</div>`;
}
function abaGabarito() {
  if (!form || form.avId !== av.id) form = { avId: av.id, questoes: av.questoes.map(q => ({ ...q })), faixasD: faixas(av.questoes).map(x => ({ ...x })), nome: av.nome, data: av.data || '', valorTotal: av.valorTotal || '', nAlt: av.nAlt };
  const f = form, ed = podeEditarAv;
  return `${ed ? '' : '<p class="cp-dica">Só quem criou a avaliação (ou a direção) altera o gabarito.</p>'}
    <div class="cp-campos">
      <label class="cp-campo cp-campo-grande">Nome <input id="g-nome" value="${esc(f.nome)}" ${ed ? '' : 'disabled'}></label>
      <label class="cp-campo">Data <input type="date" id="g-data" value="${esc(f.data)}" ${ed ? '' : 'disabled'}></label>
      <label class="cp-campo">Valor <input type="number" id="g-valor" step="0.1" min="0" value="${esc(f.valorTotal)}" ${ed ? '' : 'disabled'}></label>
    </div>
    <h3 class="cp-sub">Disciplinas</h3>
    <div class="cp-faixas">${f.faixasD.map((x, k) => `<div class="cp-faixa">
        <label>De <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="de" value="${x.de}" ${ed ? '' : 'disabled'}></label>
        <label>até <input type="number" min="1" max="${f.questoes.length}" data-fx="${k}" data-campo="ate" value="${x.ate}" ${ed ? '' : 'disabled'}></label>
        <input class="cp-faixa-nome" data-fx="${k}" data-campo="nome" value="${esc(x.nome)}" ${ed ? '' : 'disabled'}>
        ${ed ? `<button type="button" class="cp-link perigo" data-fx-del="${k}">remover</button>` : ''}</div>`).join('')}
      ${ed ? '<button type="button" class="cp-link" data-fx-add="1">+ adicionar disciplina</button>' : ''}</div>
    <h3 class="cp-sub">Resposta certa <small>— o número de questões não muda (as folhas já foram impressas)</small></h3>
    <div class="cp-gab">${f.questoes.map((q, i) => `<div class="cp-gab-q ${q.g ? '' : 'falta'}"><span class="cp-gab-n">${i + 1}</span>${LETRAS.slice(0, f.nAlt).split('').map(l => `<button type="button" class="cp-gab-l ${q.g === l ? 'on' : ''}" data-q="${i}" data-l="${l}" ${ed ? '' : 'disabled'}>${l}</button>`).join('')}<button type="button" class="cp-gab-x ${q.g === 'X' ? 'on' : ''}" data-q="${i}" data-l="X" ${ed ? '' : 'disabled'}>anular</button></div>`).join('')}</div>
    ${ed ? `<div class="cp-salvar"><button type="button" class="cp-link perigo" data-excluir-av="1">Excluir avaliação</button><button type="button" class="btn-primary" data-salvar-gab="1">Salvar gabarito</button></div>` : ''}`;
}
async function salvarGabarito(btn) {
  form.nome = $('g-nome').value; form.data = $('g-data').value; form.valorTotal = $('g-valor').value;
  aplicarFaixas();
  btn.disabled = true;
  try {
    await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}`, { method: 'PUT', body: JSON.stringify({ nome: form.nome, data: form.data, valorTotal: form.valorTotal ? Number(String(form.valorTotal).replace(',', '.')) : null, questoes: form.questoes }) });
    av = { ...av, nome: form.nome, data: form.data || null, valorTotal: form.valorTotal ? Number(String(form.valorTotal).replace(',', '.')) : null, questoes: form.questoes.map(q => ({ ...q })) };
    toast('Gabarito salvo. Os resultados foram recalculados.'); avaliacoes = null; renderAvaliacao();
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; }
}
async function salvarAluno(i, btn) {
  const respostas = av.questoes.map((_, k) => { const s = document.querySelector(`[data-edq="${k}"]`); return s ? s.value : ''; });
  btn.disabled = true;
  try {
    const r = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${i}`, { method: 'PUT', body: JSON.stringify({ respostas, origem: 'manual' }) });
    leituras[i] = r.leitura; toast('Respostas salvas.'); renderAvaliacao();
  } catch (err) { toast(err.message, 'erro'); btn.disabled = false; }
}
async function apagarLeitura(i) {
  if (!confirm('Apagar a leitura desta folha? Dá para ler de novo depois.')) return;
  try { await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${i}`, { method: 'DELETE' }); delete leituras[i]; toast('Leitura apagada.'); renderAvaliacao(); }
  catch (err) { toast(err.message, 'erro'); }
}
async function excluirAvaliacao() {
  if (!confirm(`Excluir a avaliação "${av.nome}" e todas as folhas lidas? Não dá para desfazer.`)) return;
  try { await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}`, { method: 'DELETE' }); toast('Avaliação excluída.'); av = null; avaliacoes = null; navegar(''); }
  catch (err) { toast(err.message, 'erro'); }
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

// ---------- IMPRESSÃO DAS FOLHAS ----------
function dialogoImpressao() {
  const ts = av.turmas;
  const opcoes = [{ k: '', rot: `Todas as turmas da avaliação`, n: av.alunos.length }, ...(ts.length > 1 ? ts.map(t => ({ k: t.id, rot: nomeTurma(t), n: av.alunos.filter(a => a.turmaId === t.id).length })) : [])];
  const d = document.createElement('div');
  d.className = 'cp-modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Imprimir folhas');
  d.innerHTML = `<div class="cp-modal-box"><h2>Imprimir folhas de resposta</h2>
    <p class="cp-dica">Uma folha por aluno, <b>só a frente</b> (desligue a impressão frente e verso). Imprima em tamanho real (100%), sem "ajustar à página" se der.</p>
    <div class="cp-opcoes">${opcoes.map((o, k) => `<label class="cp-turma"><input type="radio" name="imp" value="${esc(o.k)}" ${k === 0 ? 'checked' : ''}><span><b>${esc(o.rot)}</b><small>${plural(o.n, 'folha', 'folhas')}</small></span></label>`).join('')}</div>
    <div class="cp-salvar"><button type="button" class="btn-secondary" data-fechar-modal="1">Cancelar</button><button type="button" class="btn-primary" data-gerar="1">Gerar e imprimir</button></div></div>`;
  document.body.appendChild(d);
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-fechar-modal]')) { d.remove(); return; }
    if (e.target.closest('[data-gerar]')) {
      const k = d.querySelector('input[name=imp]:checked').value;
      d.remove();
      imprimirFolhas(av.alunos.filter(a => !k || a.turmaId === k));
    }
  });
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
    else if (r.outra) { desenharQuad(r.quad, '#e8791e'); status(`Esta folha é de outra avaliação (código ${String(r.cod).padStart(4, '0')}).`, 'aviso'); ultimo = null; }
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
async function aceitar(r, deArquivo = false) {
  const aluno = av.alunos.find(a => a.i === r.i);
  ocupado = !deArquivo;
  const antes = !!leituras[r.i];
  try {
    const s = await apiFetch(`/correcao/avaliacoes/${encodeURIComponent(av.id)}/leituras/${r.i}`, { method: 'PUT', body: JSON.stringify({ respostas: r.respostas, origem: 'camera' }) });
    leituras[r.i] = s.leitura; ultimoSalvo = { i: r.i, t: Date.now() };
    bip(true); contagemLeitor();
    mostrarResultado(aluno, s.leitura, antes);
    if (!deArquivo) status('Corrigida! Pode passar para a próxima folha.', 'ok');
  } catch (err) { bip(false); status(`Não salvou: ${err.message}`, 'aviso'); }
  finally { setTimeout(() => { ocupado = false; ultimo = null; }, deArquivo ? 0 : 1200); }
}
function mostrarResultado(aluno, l, substituiu) {
  const r = resultado(l.respostas);
  const duplas = l.respostas.filter(x => x === '*').length, brancos = l.respostas.filter(x => !x).length;
  const el = $('lt-res'); el.classList.remove('hidden');
  el.innerHTML = `<div class="cp-lr-cab"><div><b>${esc(titulo(aluno.nome))}</b><small>${esc(nomeTurma(turmaDe(aluno)))}${substituiu ? ' · leitura anterior substituída' : ''}</small></div>
      <div class="cp-lr-nota"><b>${r.acertos}</b>/${r.total}${r.nota !== null ? `<small>nota ${r.nota.toLocaleString('pt-BR')}</small>` : ''}</div></div>
    ${duplas || brancos ? `<div class="cp-lr-av">${duplas ? `${plural(duplas, 'questão com duas marcações', 'questões com duas marcações')} (conta como erro). ` : ''}${brancos ? `${plural(brancos, 'em branco', 'em branco')}.` : ''} Dá para ajustar em Alunos.</div>` : ''}
    <div class="cp-resps mini">${av.questoes.map((q, i) => celulaResp(q, l.respostas[i], i, false)).join('')}</div>`;
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
      if (r && !r.outra) { await aceitar(r, true); ok++; } else falhou++;
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
    const ab = t.closest('[data-abrir]'); if (ab) { navegar(`#av/${ab.dataset.abrir}`); return; }
    // formulário (nova avaliação e aba Gabarito)
    const mo = t.closest('[data-modo]'); if (mo) { lerCamposForm(); form.modo = mo.dataset.modo; renderNova(); return; }
    const or = t.closest('[data-origem]');
    if (or) { lerCamposForm(); form.origem = or.dataset.origem === 'manual' ? 'manual' : 'banco'; renderNova(); if (form.origem === 'banco') carregarProvasBanco(); return; }
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
    const fd = t.closest('[data-fx-del]'); if (fd) { form.faixasD.splice(Number(fd.dataset.fxDel), 1); redesenharForm(); return; }
    if (t.closest('#f-salvar')) { salvarNova(t.closest('#f-salvar')); return; }
    // avaliação
    const a = t.closest('[data-aba]'); if (a) { aba = a.dataset.aba; renderAvaliacao(); return; }
    const al = t.closest('[data-aluno]'); if (al) { const i = Number(al.dataset.aluno); abertoAluno = abertoAluno === i ? null : i; $('aba-corpo').innerHTML = corpoAba(); return; }
    const sa = t.closest('[data-salvar-aluno]'); if (sa) { salvarAluno(Number(sa.dataset.salvarAluno), sa); return; }
    const ap = t.closest('[data-apagar]'); if (ap) { apagarLeitura(Number(ap.dataset.apagar)); return; }
    const fa = t.closest('[data-folha-aluno]'); if (fa) { imprimirFolhas(av.alunos.filter(x => x.i === Number(fa.dataset.folhaAluno))); return; }
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
      lerCamposForm(); renderNova(); return;
    }
    if (t.id === 'f-curso') { lerCamposForm(); form.curso = t.value; form.dp = null; renderNova(); return; }
    if (t.matches('[data-dp]')) {
      const cc = turmas.find(x => x.curso === form.curso).codcur, d = dpCache[cc].find(x => x.chave === t.dataset.dp);
      lerCamposForm(); form.dp = { codcur: cc, chave: d.chave, nome: d.nome, alunos: d.alunos };
      if (!form.nome) form.nome = `Prova de DP — ${titulo(d.nome)}`;
      renderNova(); return;
    }
    if (t.id === 'f-prova') { escolherProva(t.value); return; }
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
    if (t.id === 'fl-turma') { filtroTurma = t.value; $('aba-corpo').innerHTML = corpoAba(); return; }
    if (t.matches('[data-edq]')) {
      const cel = t.closest('.cp-resp'), i = Number(t.dataset.edq), r = t.value, g = av.questoes[i].g;
      cel.className = `cp-resp ${r === '*' ? 'dupla' : !r ? 'branco' : acertou(g, r) ? 'certo' : 'errado'}`;
    }
  });
  $('tela').addEventListener('input', (e) => {
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
    $('aba-corpo').innerHTML = corpoAba();
  }
}
