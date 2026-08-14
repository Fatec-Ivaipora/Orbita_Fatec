import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { CATEGORIES } from "../../core/permissions.js";
import { secureAction, escapeHTML as esc } from "../../core/security.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro na API: ${res.status}`);
  }
  return res.json();
}

const RECORRENCIA_LABEL = { diaria: 'Diária', semanal: 'Semanal', mensal: 'Mensal', bimestral: 'Bimestral', semestral: 'Semestral', anual: 'Anual', conforme_demanda: 'Conforme Demanda' };

let currentUser = null;
let currentRole = null;
let appInitialized = false;
let initializedRole = null;
let souGestor = false;
let setorAtual = null; // setorId em que estou operando (fixo p/ chefe, escolhido p/ adm)
let funcionariosDoSetor = [];
let processos = [];

const cached = getCachedAuth();
if (cached) initApp(cached.user, cached.role);

onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); window.location.href = '../../auth/login.html'; return; }
  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante';
    let setorId = null;
    try {
      const me = await apiFetch('/usuarios/me');
      role = me.role || 'visitante';
      setorId = me.setorId || null;
    } catch (e) { role = cached ? cached.role : 'visitante'; }

    setCachedAuth(user, role, token);
    currentUser._setorId = setorId; // guardado no próprio objeto para não recriar cache separado

    if (!appInitialized || initializedRole !== role) {
      currentRole = role;
      initApp(user, role);
    }
  } catch (err) { console.error("Erro na revalidação de auth:", err); }
});

async function initApp(user, role) {
  currentUser = user;
  souGestor = ['chefe_setor', 'adm_l1', 'adm_l2'].includes(role);

  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'dashboard', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  if (souGestor) {
    document.getElementById('gestor-view').classList.remove('hidden');
    setupEventListeners();
    await setupSetorScope(role);
    await loadFuncionarios();
    setupVerComoSelect();
    await loadProcessos();
  } else {
    document.getElementById('page-title').textContent = 'Meus Processos';
    document.getElementById('page-subtitle').textContent = 'O "norte" de cada rotina que você é responsável por executar, organizado por frequência.';
    document.getElementById('funcionario-view').classList.remove('hidden');
    await loadMeusProcessos();
  }
}

const ORDEM_RECORRENCIA = ['diaria', 'semanal', 'mensal', 'bimestral', 'semestral', 'anual', 'conforme_demanda'];

async function loadMeusProcessos(uid = null, container = null) {
  container = container || document.getElementById('meus-processos-grouped');
  container.innerHTML = '<div class="loading-state">Carregando processos...</div>';
  try {
    const endpoint = uid ? `/processos/meus?uid=${encodeURIComponent(uid)}` : '/processos/meus';
    const meus = await apiFetch(endpoint);
    renderMeusProcessos(meus, container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erro ao carregar: ${esc(err.message)}</div>`;
  }
}

// Seletor "Ver como" (gestor): alterna entre o modo de gestão (CRUD) e a
// visão somente-leitura de como um funcionário específico vê "Meus Processos".
function setupVerComoSelect() {
  const select = document.getElementById('ver-como-select');
  select.innerHTML = '<option value="">— Gerenciar (minha visão) —</option>' +
    funcionariosDoSetor.map(f => `<option value="${esc(f.uid)}">${esc(f.name || f.email)}</option>`).join('');

  select.onchange = () => {
    const uid = select.value;
    const toolbarBtns = document.getElementById('btn-novo-processo');
    const grid = document.getElementById('processos-grid');
    const vercomo = document.getElementById('vercomo-grouped');

    if (!uid) {
      grid.classList.remove('hidden');
      toolbarBtns.classList.remove('hidden');
      vercomo.classList.add('hidden');
    } else {
      grid.classList.add('hidden');
      toolbarBtns.classList.add('hidden');
      vercomo.classList.remove('hidden');
      loadMeusProcessos(uid, vercomo);
    }
  };
}

function renderMeusProcessos(meus, container) {
  container.innerHTML = '';

  if (!meus.length) {
    container.innerHTML = '<div class="empty-state">Nenhum processo atribuído a você ainda. Fale com o Chefe de Setor.</div>';
    return;
  }

  ORDEM_RECORRENCIA.forEach(rec => {
    const doGrupo = meus.filter(p => p.recorrencia === rec);
    if (!doGrupo.length) return;

    const grupo = document.createElement('section');
    grupo.className = 'meus-processos-grupo';
    grupo.innerHTML = `
      <h2 class="meus-processos-grupo-titulo">${esc(RECORRENCIA_LABEL[rec] || rec)}</h2>
      <div class="processos-grid">
        ${doGrupo.map(p => `
          <div class="processo-card processo-card-leitura">
            <div class="processo-card-titulo">${esc(p.titulo)}</div>
            ${p.descricao ? `<div class="processo-card-descricao">${esc(p.descricao)}</div>` : ''}
            ${(p.passos || []).length ? `
              <details class="kanban-card-passos">
                <summary>Ver passos (${p.passos.length})</summary>
                <ul>${p.passos.map(passo => `<li>${esc(passo.texto)}</li>`).join('')}</ul>
              </details>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(grupo);
  });
}

// Chefe: setor fixo (do próprio cadastro). Admin: seletor manual.
async function setupSetorScope(role) {
  const wrap = document.getElementById('proc-setor-select-wrap');
  if (role === 'adm_l1' || role === 'adm_l2') {
    wrap.classList.remove('hidden');
    wrap.innerHTML = `
      <select id="proc-setor-select" class="form-input" style="width:auto; display:inline-block;">
        <option value="">Selecione um setor...</option>
        ${Object.entries(CATEGORIES).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('')}
      </select>
    `;
    const sel = document.getElementById('proc-setor-select');
    sel.addEventListener('change', async () => {
      setorAtual = sel.value || null;
      await loadFuncionarios();
      setupVerComoSelect();
      await loadProcessos();
    });
    setorAtual = null;
  } else {
    let me;
    try { me = await apiFetch('/usuarios/me'); } catch (e) { me = {}; }
    setorAtual = me.setorId || null;
    if (!setorAtual) {
      document.getElementById('processos-grid').innerHTML = '<div class="empty-state">Você é Chefe de Setor, mas não tem um setor de atuação definido. Contate o ADM.</div>';
    }
  }
}

function querySetor() {
  return setorAtual ? `?setorId=${encodeURIComponent(setorAtual)}` : '';
}

async function loadFuncionarios() {
  if (!setorAtual) { funcionariosDoSetor = []; return; }
  try {
    funcionariosDoSetor = await apiFetch(`/processos/setor/funcionarios${querySetor()}`);
  } catch (e) { funcionariosDoSetor = []; }
}

async function loadProcessos() {
  const grid = document.getElementById('processos-grid');
  if (!setorAtual) {
    grid.innerHTML = '<div class="empty-state">Selecione um setor para ver os processos.</div>';
    return;
  }
  grid.innerHTML = '<div class="loading-state">Carregando processos...</div>';
  try {
    processos = await apiFetch(`/processos${querySetor()}`);
    renderProcessos();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Erro ao carregar: ${esc(err.message)}</div>`;
  }
}

function renderProcessos() {
  const grid = document.getElementById('processos-grid');
  grid.innerHTML = '';

  if (!processos.length) {
    grid.innerHTML = '<div class="empty-state">Nenhum processo cadastrado neste setor ainda.</div>';
    return;
  }

  processos.forEach(p => {
    const nomesAtribuidos = (p.atribuidos || [])
      .map(uid => funcionariosDoSetor.find(f => f.uid === uid)?.name || uid)
      .join(', ');

    const card = document.createElement('div');
    card.className = 'processo-card';
    card.innerHTML = `
      <div class="processo-card-header">
        <span class="recorrencia-badge">${RECORRENCIA_LABEL[p.recorrencia] || p.recorrencia}</span>
        <div class="processo-card-actions">
          <button class="icon-btn btn-editar-processo" title="Editar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn btn-excluir-processo" title="Excluir">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="processo-card-titulo">${esc(p.titulo)}</div>
      ${p.descricao ? `<div class="processo-card-descricao">${esc(p.descricao)}</div>` : ''}
      <div class="processo-card-passos">${(p.passos || []).length} passo(s)</div>
      <div class="processo-card-atribuidos">👤 ${esc(nomesAtribuidos || 'Ninguém atribuído')}</div>
    `;
    card.querySelector('.btn-editar-processo').onclick = () => abrirModalProcesso(p);
    card.querySelector('.btn-excluir-processo').onclick = () => excluirProcesso(p.id, p.titulo);
    grid.appendChild(card);
  });
}

async function excluirProcesso(id, titulo) {
  if (!confirm(`Excluir o processo "${titulo}"? As atividades já geradas permanecem no histórico.`)) return;
  try {
    await secureAction(currentUser.uid, async () => {
      await apiFetch(`/processos/${id}`, { method: 'DELETE' });
    });
    await loadProcessos();
  } catch (err) {
    if (err.message.includes("Rate limit")) return;
    alert("Erro ao excluir: " + err.message);
  }
}

// ================================================================
//  MODAL DE PROCESSO
// ================================================================
function abrirModalProcesso(processo = null) {
  document.getElementById('form-processo').reset();
  document.getElementById('processo-id').value = processo ? processo.id : '';
  document.getElementById('processo-modal-title').textContent = processo ? 'Editar Processo' : 'Novo Processo';
  document.getElementById('processo-titulo').value = processo?.titulo || '';
  document.getElementById('processo-descricao').value = processo?.descricao || '';
  document.getElementById('processo-recorrencia').value = processo?.recorrencia || 'diaria';

  renderPassosList(processo?.passos || []);
  renderAtribuidosList(processo?.atribuidos || []);

  abrirModal('modal-processo');
}

function renderPassosList(passos) {
  const list = document.getElementById('passos-list');
  list.innerHTML = '';
  if (!passos.length) passos = [{ texto: '' }];
  passos.forEach(p => addPassoInput(p.texto || ''));
}

function addPassoInput(valor = '') {
  const list = document.getElementById('passos-list');
  const row = document.createElement('div');
  row.className = 'passo-row';
  row.innerHTML = `
    <input type="text" class="form-input passo-input" placeholder="Descreva o passo..." value="${esc(valor)}">
    <button type="button" class="icon-btn btn-remove-passo" title="Remover passo">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  row.querySelector('.btn-remove-passo').onclick = () => row.remove();
  list.appendChild(row);
}

function renderAtribuidosList(atribuidosAtuais) {
  const list = document.getElementById('atribuidos-list');
  if (!funcionariosDoSetor.length) {
    list.innerHTML = '<div class="empty-state">Nenhum funcionário cadastrado neste setor ainda.</div>';
    return;
  }
  list.innerHTML = funcionariosDoSetor.map(f => `
    <label class="atribuido-opt">
      <input type="checkbox" value="${esc(f.uid)}" ${atribuidosAtuais.includes(f.uid) ? 'checked' : ''}>
      <span>${esc(f.name || f.email)}</span>
    </label>
  `).join('');
}

async function salvarProcesso(e) {
  e.preventDefault();
  const id = document.getElementById('processo-id').value;
  const titulo = document.getElementById('processo-titulo').value.trim();
  const descricao = document.getElementById('processo-descricao').value.trim();
  const recorrencia = document.getElementById('processo-recorrencia').value;
  const passos = Array.from(document.querySelectorAll('.passo-input'))
    .map(input => ({ texto: input.value.trim() }))
    .filter(p => p.texto);
  const atribuidos = Array.from(document.querySelectorAll('#atribuidos-list input[type="checkbox"]:checked')).map(c => c.value);

  if (!atribuidos.length) { alert('Atribua o processo a pelo menos 1 funcionário.'); return; }

  const data = { titulo, descricao, recorrencia, passos, atribuidos, setorId: setorAtual };

  try {
    await secureAction(currentUser.uid, async () => {
      if (id) {
        await apiFetch(`/processos/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        await apiFetch('/processos', { method: 'POST', body: JSON.stringify(data) });
      }
    });
    fecharModal('modal-processo');
    await loadProcessos();
  } catch (err) {
    if (err.message.includes("Rate limit")) return;
    alert("Erro ao salvar processo: " + err.message);
  }
}

function setupEventListeners() {
  document.getElementById('btn-novo-processo').onclick = () => abrirModalProcesso();
  document.getElementById('btn-add-passo').onclick = () => addPassoInput();
  document.getElementById('form-processo').onsubmit = salvarProcesso;
}

window.abrirModal = (id) => document.getElementById(id).classList.add('active');
window.fecharModal = (id) => document.getElementById(id).classList.remove('active');
