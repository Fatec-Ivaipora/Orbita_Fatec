// ================================================================
//  ÓRBITA — MÓDULO CONFIRMAÇÃO DE PRESENÇA EM EVENTO (Docência)
//  Puxa os professores ativos do Edubox (GRA + MED) pra cada evento, e
//  ajuda o coordenador a controlar quem confirmou presença/ausência —
//  mesmo fluxo da planilha "CONFIRMAÇÃO SIP", só que dentro do sistema.
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;
let currentRole = null;
let appInitialized = false;
let initializedRole = null;

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

function showToast(msg, tipo = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${tipo}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatarData(iso) {
  if (!iso) return '—';
  const [ano, mes, dia] = iso.split('-');
  return dia && mes && ano ? `${dia}/${mes}/${ano}` : iso;
}

// ================================================================
//  AUTH GUARD E INICIALIZAÇÃO (mesmo padrão dos demais módulos)
// ================================================================
const cached = getCachedAuth();
if (cached) {
  currentUser = cached.user;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '../../auth/login.html';
    return;
  }
  currentUser = user;
  const token = await user.getIdToken();

  let role = 'visitante';
  try {
    const userData = await apiFetch('/usuarios/me');
    role = userData.role || 'visitante';
  } catch (err) {
    role = cached ? cached.role : 'visitante';
  }
  currentRole = role;
  setCachedAuth(user, role, token);

  if (!appInitialized || initializedRole !== role) {
    initializedRole = role;
    initApp(user, role);
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;
  currentRole = role;

  const guard = document.getElementById('auth-guard');
  if (guard) guard.classList.add('hidden');

  setupLayout(user, role, 'confirmacao-evento', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  // Só ADM cria evento — coordenador só confirma presença dos professores
  // do próprio curso (pedido explícito 18/09).
  if (role !== 'adm_l1' && role !== 'adm_l2') {
    document.getElementById('ce-btn-novo-evento').classList.add('hidden');
  }
  bindEventos();
  await carregarEventos();
  renderEventos();
}

// ================================================================
//  ESTADO
// ================================================================
let eventos = [];
let eventoAtual = null; // { id, nome, data, semestreLabel, itens, resumo }
let filtroStatus = '';
let filtroNome = '';

const STATUS_LABEL = { pendente: 'Pendente', presente: 'Presente', ausente: 'Ausente', ausente_ead: 'Ausente EAD' };
const STATUS_ORDEM = ['presente', 'ausente', 'ausente_ead', 'pendente'];

// ================================================================
//  EVENTOS (lista)
// ================================================================
async function carregarEventos() {
  try {
    eventos = await apiFetch('/confirmacao-evento/eventos');
  } catch (err) {
    showToast(err.message, 'error');
    eventos = [];
  }
}

function renderEventos() {
  const tbody = document.getElementById('ce-eventos-tbody');
  if (!eventos.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabela-msg">Nenhum evento criado ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = eventos.map(ev => {
    const r = ev.resumo || {};
    const confirmados = (r.presente || 0) + (r.ausente || 0) + (r.ausente_ead || 0);
    return `
      <tr>
        <td><button type="button" class="ce-link-evento action-execute" data-abrir-evento="${ev.id}">${esc(ev.nome)}</button></td>
        <td>${formatarData(ev.data)}</td>
        <td>${ev.semestreLabel ? esc(ev.semestreLabel) : '—'}</td>
        <td style="text-align:right;">${r.total || 0}</td>
        <td style="text-align:right;">${confirmados} / ${r.total || 0}</td>
        <td class="acoes-col">
          <button type="button" class="btn-icon btn-icon-perigo action-execute" data-excluir-evento="${ev.id}" title="Excluir">🗑</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-abrir-evento]').forEach(btn => {
    btn.addEventListener('click', () => abrirEvento(btn.dataset.abrirEvento));
  });
  tbody.querySelectorAll('[data-excluir-evento]').forEach(btn => {
    btn.addEventListener('click', () => excluirEvento(btn.dataset.excluirEvento));
  });
}

function abrirModalEvento() {
  document.getElementById('form-evento').reset();
  document.getElementById('modal-evento').classList.remove('hidden');
}

function fecharModalEvento() {
  document.getElementById('modal-evento').classList.add('hidden');
}

async function salvarEvento(e) {
  e.preventDefault();
  const nome = document.getElementById('evento-nome').value.trim();
  const data = document.getElementById('evento-data').value;
  const semestreLabel = document.getElementById('evento-semestre').value.trim();

  const btn = document.getElementById('btn-salvar-evento');
  btn.disabled = true;
  btn.textContent = 'Consultando Edubox...';
  try {
    const resp = await apiFetch('/confirmacao-evento/eventos', {
      method: 'POST',
      body: JSON.stringify({ nome, data, semestreLabel })
    });
    showToast(resp.message);
    fecharModalEvento();
    await carregarEventos();
    renderEventos();
    await abrirEvento(resp.id);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar Evento';
  }
}

async function excluirEvento(id) {
  if (!confirm('Excluir este evento e toda a lista de confirmação dele? Não tem como desfazer.')) return;
  try {
    await apiFetch(`/confirmacao-evento/eventos/${id}`, { method: 'DELETE' });
    showToast('Evento excluído.');
    await carregarEventos();
    renderEventos();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================================================================
//  EVENTO (detalhe / confirmação)
// ================================================================
async function abrirEvento(id) {
  try {
    eventoAtual = await apiFetch(`/confirmacao-evento/eventos/${id}`);
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  filtroStatus = '';
  filtroNome = '';
  document.getElementById('ce-filtro-status').value = '';
  document.getElementById('ce-filtro-nome').value = '';
  document.getElementById('ce-view-eventos').classList.add('hidden');
  document.getElementById('ce-view-evento').classList.remove('hidden');
  renderEvento();
}

function voltarParaEventos() {
  eventoAtual = null;
  document.getElementById('ce-view-evento').classList.add('hidden');
  document.getElementById('ce-view-eventos').classList.remove('hidden');
}

function renderEvento() {
  if (!eventoAtual) return;
  document.getElementById('ce-evento-nome').textContent = eventoAtual.nome;
  document.getElementById('ce-evento-meta').textContent =
    `${formatarData(eventoAtual.data)}${eventoAtual.semestreLabel ? ` · ${eventoAtual.semestreLabel}` : ''} · ${eventoAtual.itens.length} professor(es)`;
  renderResumoGrafico();
  renderItens();
}

// Barras de distribuição (Presente/Ausente/Ausente EAD/Pendente), mesma
// ideia do resumo com barrinha da planilha original — sem depender de lib
// de gráfico, só CSS.
function renderResumoGrafico() {
  const el = document.getElementById('ce-resumo-grafico');
  const r = eventoAtual.resumo;
  const total = r.total || 1;

  el.innerHTML = STATUS_ORDEM.map(status => {
    const qtd = r[status] || 0;
    const pct = total ? Math.round((qtd / total) * 1000) / 10 : 0;
    return `
      <div class="ce-resumo-linha">
        <span class="ce-resumo-label">${STATUS_LABEL[status]}</span>
        <div class="ce-resumo-barra-fundo">
          <div class="ce-resumo-barra ce-resumo-barra-${status}" style="width:${pct}%;"></div>
        </div>
        <span class="ce-resumo-valor">${qtd} (${pct.toFixed(1)}%)</span>
      </div>`;
  }).join('');
}

function itensFiltrados() {
  return eventoAtual.itens.filter(item => {
    if (filtroStatus && item.status !== filtroStatus) return false;
    if (filtroNome && !item.professorNome.toLowerCase().includes(filtroNome.toLowerCase())) return false;
    return true;
  });
}

function renderItens() {
  const tbody = document.getElementById('ce-itens-tbody');
  const lista = itensFiltrados();
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabela-msg">Nenhum professor encontrado com esse filtro.</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(item => `
    <tr data-item-id="${item.id}">
      <td>
        <div class="ce-professor-nome">${esc(item.professorNome)}</div>
        ${item.cursos && item.cursos.length ? `<div class="ce-professor-cursos">${esc(item.cursos.join(', '))}</div>` : ''}
      </td>
      <td>
        <div class="ce-status-pills">
          ${['presente', 'ausente', 'ausente_ead'].map(s => `
            <button type="button" class="ce-pill ce-pill-${s} ${item.status === s ? 'ce-pill-ativa' : ''}" data-set-status="${s}">${STATUS_LABEL[s]}</button>
          `).join('')}
        </div>
      </td>
      <td><textarea class="ce-input-inline ce-textarea-inline" data-campo="justificativa" placeholder="Motivo da ausência" rows="2">${esc(item.justificativa || '')}</textarea></td>
      <td><input type="text" class="ce-input-inline" data-campo="dataContato" value="${esc(item.dataContato || '')}" placeholder="dd/mm hh:mm"></td>
      <td><input type="text" class="ce-input-inline" data-campo="dataConfirmacao" value="${esc(item.dataConfirmacao || '')}" placeholder="dd/mm"></td>
      <td><button type="button" class="btn-icon btn-icon-perigo action-execute" data-remover-item="${item.id}" title="Remover da lista">🗑</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-set-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      salvarItem(tr.dataset.itemId, { status: btn.dataset.setStatus });
    });
  });
  tbody.querySelectorAll('.ce-input-inline').forEach(input => {
    input.addEventListener('change', () => {
      const tr = input.closest('tr');
      salvarItem(tr.dataset.itemId, { [input.dataset.campo]: input.value });
    });
  });
  tbody.querySelectorAll('[data-remover-item]').forEach(btn => {
    btn.addEventListener('click', () => removerItem(btn.dataset.removerItem));
  });
}

async function salvarItem(itemId, camposAlterados) {
  const item = eventoAtual.itens.find(i => i.id === itemId);
  if (!item) return;
  const payload = {
    status: item.status,
    justificativa: item.justificativa,
    dataContato: item.dataContato,
    dataConfirmacao: item.dataConfirmacao,
    ...camposAlterados
  };
  Object.assign(item, camposAlterados);
  eventoAtual.resumo = calcularResumo(eventoAtual.itens);
  renderResumoGrafico();
  renderItens();

  try {
    await apiFetch(`/confirmacao-evento/eventos/${eventoAtual.id}/itens/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function calcularResumo(itens) {
  const resumo = { pendente: 0, presente: 0, ausente: 0, ausente_ead: 0, total: itens.length };
  itens.forEach(i => { resumo[i.status] = (resumo[i.status] || 0) + 1; });
  return resumo;
}

async function removerItem(itemId) {
  if (!confirm('Remover esse professor da lista deste evento?')) return;
  try {
    await apiFetch(`/confirmacao-evento/eventos/${eventoAtual.id}/itens/${itemId}`, { method: 'DELETE' });
    eventoAtual.itens = eventoAtual.itens.filter(i => i.id !== itemId);
    eventoAtual.resumo = calcularResumo(eventoAtual.itens);
    renderEvento();
    showToast('Professor removido.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function atualizarProfessoresDoEdubox() {
  const btn = document.getElementById('ce-btn-atualizar-professores');
  btn.disabled = true;
  btn.textContent = 'Consultando...';
  try {
    const resp = await apiFetch(`/confirmacao-evento/eventos/${eventoAtual.id}/atualizar-professores`, { method: 'POST' });
    showToast(resp.message);
    eventoAtual = await apiFetch(`/confirmacao-evento/eventos/${eventoAtual.id}`);
    renderEvento();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Atualizar lista do Edubox';
  }
}

function abrirModalAddProfessor() {
  document.getElementById('form-add-professor').reset();
  document.getElementById('modal-add-professor').classList.remove('hidden');
}

function fecharModalAddProfessor() {
  document.getElementById('modal-add-professor').classList.add('hidden');
}

async function salvarProfessorManual(e) {
  e.preventDefault();
  const nome = document.getElementById('add-professor-nome').value.trim();
  const email = document.getElementById('add-professor-email').value.trim();
  try {
    await apiFetch(`/confirmacao-evento/eventos/${eventoAtual.id}/itens`, {
      method: 'POST',
      body: JSON.stringify({ nome, email })
    });
    showToast('Professor adicionado.');
    fecharModalAddProfessor();
    eventoAtual = await apiFetch(`/confirmacao-evento/eventos/${eventoAtual.id}`);
    renderEvento();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================================================================
//  EVENTOS DE UI
// ================================================================
function bindEventos() {
  document.getElementById('ce-btn-novo-evento').addEventListener('click', abrirModalEvento);
  document.getElementById('btn-cancelar-evento').addEventListener('click', fecharModalEvento);
  document.getElementById('form-evento').addEventListener('submit', salvarEvento);

  document.getElementById('ce-btn-voltar-eventos').addEventListener('click', voltarParaEventos);
  document.getElementById('ce-btn-atualizar-professores').addEventListener('click', atualizarProfessoresDoEdubox);
  document.getElementById('ce-btn-add-professor').addEventListener('click', abrirModalAddProfessor);
  document.getElementById('btn-cancelar-add-professor').addEventListener('click', fecharModalAddProfessor);
  document.getElementById('form-add-professor').addEventListener('submit', salvarProfessorManual);

  document.getElementById('ce-filtro-status').addEventListener('change', (e) => {
    filtroStatus = e.target.value;
    renderItens();
  });
  let debounceFiltroNome;
  document.getElementById('ce-filtro-nome').addEventListener('input', (e) => {
    clearTimeout(debounceFiltroNome);
    debounceFiltroNome = setTimeout(() => {
      filtroNome = e.target.value;
      renderItens();
    }, 250);
  });

  [document.getElementById('modal-evento'), document.getElementById('modal-add-professor')].forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}
