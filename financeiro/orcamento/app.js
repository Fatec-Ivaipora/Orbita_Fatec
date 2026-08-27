import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;
let appInitialized = false;
let initializedRole = null;

let orcamentos = [];
let orcamentoDetalheId = null;
let lancamentoEmEdicaoId = null;

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

// Usado só no guard de acesso (role/permissões no login) — uma instabilidade
// passageira de rede/servidor nessas duas chamadas não pode virar "sem
// acesso" e chutar quem já tem permissão de volta pro Meu Espaço.
async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await apiFetch(endpoint);
    } catch (err) {
      if (i === tentativas) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

function fmtMoeda(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function showToast(msg, tipo = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${tipo}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2')) {
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
  try {
    const token = await user.getIdToken();
    let role = 'visitante';
    let meuOverrides = null;
    try {
      const userData = await apiFetchComRetentativa('/usuarios/me');
      role = userData.role || 'visitante';
      meuOverrides = userData.permissoes || null;
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }

    setCachedAuth(user, role, token);

    let level = 1;
    if (role === 'adm_l1') {
      level = 3;
    } else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, 'orcamento');
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }

    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    document.body.classList.toggle('hide-execute', level < 3);

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      initializedRole = role;
      initApp(user, role);
    }
  } catch (err) {
    console.error('Erro na revalidação de auth:', err);
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'orcamento', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  document.getElementById('btn-novo-orcamento').disabled = false;

  wireEventos();
  await carregarOrcamentos();
}

// ==========================================
// CARREGAMENTO — 1 única leitura da coleção inteira; filtros de setor/
// período/status/busca são aplicados em memória (mesmo motivo do incidente
// de cota do módulo Licitação: evita 1 leitura por troca de filtro).
// ==========================================
async function carregarOrcamentos() {
  try {
    orcamentos = await apiFetch('/orcamento/orcamentos');
    popularFiltroSetor();
    popularFiltroSemestre();
    renderizarGrid();
  } catch (err) {
    document.getElementById('orc-grid').innerHTML = `<div class="tabela-msg-grid">Erro ao carregar: ${esc(err.message)}</div>`;
  }
}

function popularFiltroSetor() {
  const select = document.getElementById('setor-select');
  const datalist = document.getElementById('setores-datalist');
  const atual = select.value;
  const setores = [...new Set(orcamentos.map(o => o.setor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  select.innerHTML = '<option value="">Todos os setores</option>' + setores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  select.value = setores.includes(atual) ? atual : '';

  datalist.innerHTML = setores.map(s => `<option value="${esc(s)}">`).join('');
}

function popularFiltroSemestre() {
  const select = document.getElementById('semestre-select');
  const atual = select.value;
  const semestres = [...new Set(orcamentos.map(o => o.semestre).filter(Boolean))].sort().reverse();

  select.innerHTML = '<option value="">Todos os períodos</option>' + semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  select.value = semestres.includes(atual) ? atual : '';
}

function orcamentosFiltrados() {
  const setor = document.getElementById('setor-select').value;
  const semestre = document.getElementById('semestre-select').value;
  const status = document.getElementById('status-select').value;
  const busca = document.getElementById('busca-orcamento').value.trim().toLowerCase();

  return orcamentos.filter(o => {
    if (setor && o.setor !== setor) return false;
    if (semestre && o.semestre !== semestre) return false;
    if (status !== 'todos' && o.status !== status) return false;
    if (busca && !(o.nome || '').toLowerCase().includes(busca)) return false;
    return true;
  });
}

function classeProgresso(previsto, gasto) {
  if (!previsto) return '';
  const pct = gasto / previsto;
  if (pct >= 1) return 'orc-progress-estourado';
  if (pct >= 0.8) return 'orc-progress-alerta';
  return '';
}

function renderizarGrid() {
  const lista = orcamentosFiltrados();
  const grid = document.getElementById('orc-grid');

  // KPIs sobre o conjunto filtrado
  const totalPrevisto = lista.reduce((s, o) => s + (o.valorPrevisto || 0), 0);
  const totalGasto = lista.reduce((s, o) => s + (o.totalGasto || 0), 0);
  const saldoGeral = totalPrevisto - totalGasto;
  document.getElementById('kpi-previsto').textContent = fmtMoeda(totalPrevisto);
  document.getElementById('kpi-gasto').textContent = fmtMoeda(totalGasto);
  const kpiSaldo = document.getElementById('kpi-saldo');
  kpiSaldo.textContent = fmtMoeda(saldoGeral);
  kpiSaldo.classList.toggle('valor-negativo', saldoGeral < 0);
  document.getElementById('kpi-qtd').textContent = lista.length;
  document.getElementById('kpi-qtd-hint').textContent = lista.some(o => (o.totalGasto || 0) > (o.valorPrevisto || 0)) ? 'Há orçamento(s) estourado(s)' : '';

  if (!lista.length) {
    grid.innerHTML = '<div class="tabela-msg-grid">Nenhum orçamento encontrado com esses filtros.</div>';
    return;
  }

  grid.innerHTML = lista.map(o => {
    const previsto = o.valorPrevisto || 0;
    const gasto = o.totalGasto || 0;
    const saldo = o.saldo !== undefined ? o.saldo : (previsto - gasto);
    const pct = previsto ? Math.min(100, (gasto / previsto) * 100) : 0;
    return `
      <div class="orc-card" data-id="${o.id}">
        <div class="orc-card-topo">
          <div class="orc-card-nome">${esc(o.nome)}</div>
          <span class="status-badge status-${o.status}">${o.status === 'aberto' ? 'Aberto' : 'Encerrado'}</span>
        </div>
        <div class="orc-card-meta">
          <span class="setor-chip">${esc(o.setor)}</span>
          ${o.semestre ? `<span class="semestre-chip">${esc(o.semestre)}</span>` : ''}
        </div>
        <div class="orc-progress-track"><div class="orc-progress-fill ${classeProgresso(previsto, gasto)}" style="width:${pct}%"></div></div>
        <div class="orc-card-valores">
          <div><span>Previsto</span><strong>${fmtMoeda(previsto)}</strong></div>
          <div><span>Gasto</span><strong>${fmtMoeda(gasto)}</strong></div>
          <div class="${saldo < 0 ? 'valor-saldo-negativo' : ''}"><span>Saldo</span><strong>${fmtMoeda(saldo)}</strong></div>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.orc-card').forEach(card => {
    card.addEventListener('click', () => abrirDetalhe(card.dataset.id));
  });
}

// ==========================================
// MODAL NOVO/EDITAR ORÇAMENTO
// ==========================================
function abrirModalOrcamento(orcamento = null) {
  const form = document.getElementById('form-orcamento');
  form.reset();
  document.getElementById('orcamento-id').value = orcamento ? orcamento.id : '';
  document.getElementById('modal-orcamento-title').textContent = orcamento ? 'Editar Orçamento' : 'Novo Orçamento';
  document.getElementById('orcamento-nome').value = orcamento ? orcamento.nome : '';
  document.getElementById('orcamento-setor').value = orcamento ? orcamento.setor : '';
  document.getElementById('orcamento-semestre').value = orcamento ? (orcamento.semestre || '') : '';
  document.getElementById('orcamento-valor-previsto').value = orcamento ? orcamento.valorPrevisto : '';
  document.getElementById('orcamento-observacoes').value = orcamento ? (orcamento.observacoes || '') : '';
  document.getElementById('modal-orcamento').classList.remove('hidden');
}

function fecharModalOrcamento() {
  document.getElementById('modal-orcamento').classList.add('hidden');
}

async function salvarOrcamento(e) {
  e.preventDefault();
  const id = document.getElementById('orcamento-id').value;
  const body = {
    nome: document.getElementById('orcamento-nome').value.trim(),
    setor: document.getElementById('orcamento-setor').value.trim(),
    semestre: document.getElementById('orcamento-semestre').value.trim(),
    valorPrevisto: Number(document.getElementById('orcamento-valor-previsto').value),
    observacoes: document.getElementById('orcamento-observacoes').value.trim()
  };

  try {
    if (id) {
      await apiFetch(`/orcamento/orcamentos/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Orçamento atualizado!');
    } else {
      await apiFetch('/orcamento/orcamentos', { method: 'POST', body: JSON.stringify(body) });
      showToast('Orçamento criado!');
    }
    fecharModalOrcamento();
    await carregarOrcamentos();
    if (orcamentoDetalheId && id === orcamentoDetalheId) abrirDetalhe(orcamentoDetalheId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// MODAL DETALHE (lançamentos)
// ==========================================
async function abrirDetalhe(id) {
  const orcamento = orcamentos.find(o => o.id === id);
  if (!orcamento) return;
  orcamentoDetalheId = id;

  document.getElementById('detalhe-nome').textContent = orcamento.nome;
  document.getElementById('detalhe-meta').textContent = orcamento.semestre ? `${orcamento.setor} · ${orcamento.semestre}` : orcamento.setor;
  atualizarResumoDetalhe(orcamento);

  const statusToggle = document.getElementById('detalhe-status-toggle');
  statusToggle.textContent = orcamento.status === 'aberto' ? 'Aberto' : 'Encerrado';
  statusToggle.className = `status-badge action-execute status-${orcamento.status}`;

  cancelarEdicaoLancamento();
  document.getElementById('lancamento-orcamento-id').value = id;
  document.getElementById('lancamento-data').value = new Date().toISOString().slice(0, 10);

  document.getElementById('modal-detalhe').classList.remove('hidden');
  document.getElementById('lancamentos-tbody').innerHTML = '<tr><td colspan="7" class="tabela-msg">Carregando...</td></tr>';

  try {
    const lancamentos = await apiFetch(`/orcamento/orcamentos/${id}/lancamentos`);
    renderizarLancamentos(lancamentos);
  } catch (err) {
    document.getElementById('lancamentos-tbody').innerHTML = `<tr><td colspan="7" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}

function atualizarResumoDetalhe(orcamento) {
  const previsto = orcamento.valorPrevisto || 0;
  const gasto = orcamento.totalGasto || 0;
  const saldo = orcamento.saldo !== undefined ? orcamento.saldo : (previsto - gasto);
  document.getElementById('detalhe-previsto').textContent = fmtMoeda(previsto);
  document.getElementById('detalhe-gasto').textContent = fmtMoeda(gasto);
  const saldoEl = document.getElementById('detalhe-saldo');
  saldoEl.textContent = fmtMoeda(saldo);
  saldoEl.closest('div').classList.toggle('valor-negativo', saldo < 0);
}

function renderizarLancamentos(lancamentos) {
  const tbody = document.getElementById('lancamentos-tbody');
  if (!lancamentos.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Nenhum lançamento ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = lancamentos.map(l => `
    <tr>
      <td>${esc(l.descricao)}</td>
      <td>${esc(l.fornecedor || '—')}</td>
      <td>${l.quantidade}</td>
      <td>${fmtMoeda(l.valorUnitario)}</td>
      <td>${fmtMoeda(l.valorTotal)}</td>
      <td>${l.data ? new Date(l.data + 'T00:00:00').toLocaleDateString('pt-BR') : '—'}</td>
      <td class="acoes-col action-execute">
        <button type="button" class="btn-icon action-execute" data-editar-lanc="${l.id}" title="Editar">✎</button>
        <button type="button" class="btn-icon action-execute" data-excluir-lanc="${l.id}" title="Excluir">🗑</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-editar-lanc]').forEach(btn => {
    btn.addEventListener('click', () => editarLancamento(btn.dataset.editarLanc, lancamentos));
  });
  tbody.querySelectorAll('[data-excluir-lanc]').forEach(btn => {
    btn.addEventListener('click', () => excluirLancamento(btn.dataset.excluirLanc));
  });
}

function editarLancamento(id, lancamentos) {
  const lanc = lancamentos.find(l => l.id === id);
  if (!lanc) return;
  lancamentoEmEdicaoId = id;
  document.getElementById('lancamento-id').value = id;
  document.getElementById('lancamento-descricao').value = lanc.descricao;
  document.getElementById('lancamento-fornecedor').value = lanc.fornecedor || '';
  document.getElementById('lancamento-quantidade').value = lanc.quantidade;
  document.getElementById('lancamento-valor-unitario').value = lanc.valorUnitario;
  document.getElementById('lancamento-data').value = lanc.data || '';
  document.getElementById('btn-salvar-lancamento').textContent = 'Atualizar gasto';
  document.getElementById('btn-cancelar-lancamento').classList.remove('hidden');
  document.getElementById('lancamento-descricao').focus();
}

function cancelarEdicaoLancamento() {
  lancamentoEmEdicaoId = null;
  document.getElementById('form-lancamento').reset();
  document.getElementById('lancamento-id').value = '';
  document.getElementById('lancamento-quantidade').value = 1;
  document.getElementById('btn-salvar-lancamento').textContent = 'Lançar gasto';
  document.getElementById('btn-cancelar-lancamento').classList.add('hidden');
}

async function excluirLancamento(id) {
  if (!confirm('Remover este lançamento? O valor volta a somar no saldo do orçamento.')) return;
  try {
    await apiFetch(`/orcamento/lancamentos/${id}`, { method: 'DELETE' });
    showToast('Lançamento removido.');
    await recarregarDetalheAposMudanca();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function salvarLancamento(e) {
  e.preventDefault();
  const id = document.getElementById('lancamento-id').value;
  const orcamentoId = document.getElementById('lancamento-orcamento-id').value;
  const body = {
    descricao: document.getElementById('lancamento-descricao').value.trim(),
    fornecedor: document.getElementById('lancamento-fornecedor').value.trim(),
    quantidade: Number(document.getElementById('lancamento-quantidade').value),
    valorUnitario: Number(document.getElementById('lancamento-valor-unitario').value),
    data: document.getElementById('lancamento-data').value
  };

  try {
    if (id) {
      await apiFetch(`/orcamento/lancamentos/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Lançamento atualizado!');
    } else {
      await apiFetch(`/orcamento/orcamentos/${orcamentoId}/lancamentos`, { method: 'POST', body: JSON.stringify(body) });
      showToast('Gasto lançado!');
    }
    cancelarEdicaoLancamento();
    document.getElementById('lancamento-data').value = new Date().toISOString().slice(0, 10);
    await recarregarDetalheAposMudanca();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function recarregarDetalheAposMudanca() {
  const id = orcamentoDetalheId;
  await carregarOrcamentos();
  if (!id) return;
  const orcamento = orcamentos.find(o => o.id === id);
  if (!orcamento) return;
  atualizarResumoDetalhe(orcamento);
  try {
    const lancamentos = await apiFetch(`/orcamento/orcamentos/${id}/lancamentos`);
    renderizarLancamentos(lancamentos);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function alternarStatusDetalhe() {
  const orcamento = orcamentos.find(o => o.id === orcamentoDetalheId);
  if (!orcamento) return;
  const novoStatus = orcamento.status === 'aberto' ? 'encerrado' : 'aberto';
  try {
    await apiFetch(`/orcamento/orcamentos/${orcamento.id}`, { method: 'PUT', body: JSON.stringify({ status: novoStatus }) });
    showToast(novoStatus === 'aberto' ? 'Orçamento reaberto.' : 'Orçamento encerrado.');
    await carregarOrcamentos();
    abrirDetalhe(orcamento.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function fecharModalDetalhe() {
  document.getElementById('modal-detalhe').classList.add('hidden');
  orcamentoDetalheId = null;
}

// ==========================================
// EVENTOS
// ==========================================
function wireEventos() {
  document.getElementById('btn-novo-orcamento').addEventListener('click', () => abrirModalOrcamento());
  document.getElementById('btn-cancelar-orcamento').addEventListener('click', fecharModalOrcamento);
  document.getElementById('form-orcamento').addEventListener('submit', salvarOrcamento);

  document.getElementById('setor-select').addEventListener('change', renderizarGrid);
  document.getElementById('semestre-select').addEventListener('change', renderizarGrid);
  document.getElementById('status-select').addEventListener('change', renderizarGrid);
  document.getElementById('busca-orcamento').addEventListener('input', renderizarGrid);

  document.getElementById('btn-fechar-detalhe').addEventListener('click', fecharModalDetalhe);
  document.getElementById('detalhe-status-toggle').addEventListener('click', alternarStatusDetalhe);
  document.getElementById('btn-editar-orcamento').addEventListener('click', () => {
    const orcamento = orcamentos.find(o => o.id === orcamentoDetalheId);
    if (orcamento) abrirModalOrcamento(orcamento);
  });

  document.getElementById('form-lancamento').addEventListener('submit', salvarLancamento);
  document.getElementById('btn-cancelar-lancamento').addEventListener('click', cancelarEdicaoLancamento);

  [document.getElementById('modal-orcamento'), document.getElementById('modal-detalhe')].forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}
