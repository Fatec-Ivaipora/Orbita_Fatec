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
let fornecedoresGlobais = [];
let currentRole = null;
let currentChefeDeSetor = false;

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
      currentChefeDeSetor = userData.chefeDeSetor === true;
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }
    currentRole = role;

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

  if (document.getElementById('orc-grid')) {
    initPaginaLista();
  } else if (document.getElementById('orcamento-relatorio-root')) {
    initPaginaRelatorio();
  }
}

async function initPaginaLista() {
  document.getElementById('btn-novo-orcamento').disabled = false;
  wireEventos();
  await carregarOrcamentos();
  carregarFornecedores();
  carregarCatalogoItens();
}

// ==========================================
// RELATÓRIO IMPRIMÍVEL (relatorio.html) — mesmo padrão de Matrículas/
// Licitação: cabeçalho com logo só aparece na impressão (@media print),
// "Imprimir" abre o diálogo do navegador — usuário escolhe "Salvar como PDF".
// ==========================================
async function initPaginaRelatorio() {
  try {
    orcamentos = await apiFetch('/orcamento/orcamentos');
  } catch (err) {
    document.getElementById('relatorio-tbody').innerHTML = `<tr><td colspan="7" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
    return;
  }

  popularFiltroSetor();
  popularFiltroSemestre();
  popularSelectOrcamentoRelatorio();

  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  ['setor-select', 'semestre-select', 'status-select'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', renderizarRelatorio);
  });

  document.getElementById('rel-orcamento-select')?.addEventListener('change', carregarItensRelatorio);
  document.getElementById('rel-fornecedor-select')?.addEventListener('change', renderizarItensRelatorio);

  document.getElementById('btn-imprimir-relatorio')?.addEventListener('click', () => window.print());

  renderizarRelatorio();
}

function popularSelectOrcamentoRelatorio() {
  const select = document.getElementById('rel-orcamento-select');
  if (!select) return;
  const atual = select.value;
  const ordenados = [...orcamentos].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  select.innerHTML = '<option value="">Todos os orçamentos</option>' +
    ordenados.map(o => `<option value="${o.id}">${esc(o.nome)}</option>`).join('');
  select.value = ordenados.some(o => o.id === atual) ? atual : '';
}

// Um orçamento específico selecionado no filtro de cima → troca a visão
// geral (1 linha por orçamento) pelos itens daquele orçamento, igual o
// usuário pediu: já está filtrando o que quer imprimir ali em cima, não
// precisa de um filtro separado embaixo.
let lancamentosOrcamentoRelatorio = [];
async function carregarItensRelatorio() {
  const orcamentoId = document.getElementById('rel-orcamento-select').value;
  const selectFornecedor = document.getElementById('rel-fornecedor-select');
  const cardOrcamentos = document.getElementById('relatorio-card-orcamentos');
  const cardItens = document.getElementById('relatorio-card-itens');
  const tbody = document.getElementById('rel-itens-tbody');

  if (!orcamentoId) {
    lancamentosOrcamentoRelatorio = [];
    selectFornecedor.innerHTML = '<option value="">Todos os fornecedores</option>';
    selectFornecedor.disabled = true;
    cardItens.classList.add('hidden');
    cardOrcamentos.classList.remove('hidden');
    renderizarRelatorio();
    return;
  }

  cardOrcamentos.classList.add('hidden');
  cardItens.classList.remove('hidden');
  tbody.innerHTML = '<tr><td colspan="5" class="tabela-msg">Carregando...</td></tr>';
  try {
    lancamentosOrcamentoRelatorio = await apiFetch(`/orcamento/orcamentos/${orcamentoId}/lancamentos`);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
    return;
  }

  const fornecedores = [...new Set(lancamentosOrcamentoRelatorio.map(l => l.fornecedorFechado).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  selectFornecedor.innerHTML = '<option value="">Todos os fornecedores</option>' +
    fornecedores.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  selectFornecedor.disabled = false;

  renderizarItensRelatorio();
}

function renderizarItensRelatorio() {
  const orcamentoId = document.getElementById('rel-orcamento-select').value;
  const fornecedorSelecionado = document.getElementById('rel-fornecedor-select').value;
  const tbody = document.getElementById('rel-itens-tbody');

  if (!orcamentoId) return;

  const itens = fornecedorSelecionado
    ? lancamentosOrcamentoRelatorio.filter(l => l.fornecedorFechado === fornecedorSelecionado)
    : lancamentosOrcamentoRelatorio;

  const orcamento = orcamentos.find(o => o.id === orcamentoId);
  const total = itens.reduce((s, l) => s + (l.valorTotalFechado || 0), 0);
  document.getElementById('rel-itens-fornecedor').textContent = fornecedorSelecionado || 'Todos os fornecedores';
  document.getElementById('rel-itens-orcamento').textContent = orcamento ? orcamento.nome : '—';
  document.getElementById('rel-itens-total').textContent = fmtMoeda(total);

  // KPIs do topo passam a refletir o orçamento selecionado (não faz sentido
  // mostrar a soma de vários orçamentos enquanto se olha os itens de só um).
  if (orcamento) atualizarKPIs([orcamento]);

  atualizarLabelImpressaoOrcamento();

  if (!itens.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="tabela-msg">Nenhum item encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = montarLinhasAgrupadasPorFornecedor(itens, false);
}

// Rótulo do cabeçalho impresso — reflete o que está de fato filtrado/visível
// no momento, seja a visão geral ou os itens de um orçamento/fornecedor.
function atualizarLabelImpressaoOrcamento() {
  const filtroLabel = document.getElementById('print-filtro-label');
  if (!filtroLabel) return;

  const orcamentoId = document.getElementById('rel-orcamento-select').value;
  if (orcamentoId) {
    const orcamento = orcamentos.find(o => o.id === orcamentoId);
    const fornecedor = document.getElementById('rel-fornecedor-select').value;
    filtroLabel.textContent = fornecedor
      ? `${orcamento ? orcamento.nome : ''} — ${fornecedor}`
      : `${orcamento ? orcamento.nome : ''} — Todos os fornecedores`;
    return;
  }

  const setorLabel = document.getElementById('setor-select').selectedOptions[0]?.textContent || 'Todos os setores';
  const semestreLabel = document.getElementById('semestre-select').selectedOptions[0]?.textContent || 'Todos os períodos';
  filtroLabel.textContent = `${setorLabel} — ${semestreLabel}`;
}

function renderizarRelatorio() {
  const lista = orcamentosFiltrados();
  atualizarKPIs(lista);

  atualizarLabelImpressaoOrcamento();

  const tbody = document.getElementById('relatorio-tbody');
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Nenhum orçamento encontrado com esses filtros.</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(o => {
    const temPrevisto = o.valorPrevisto !== null && o.valorPrevisto !== undefined;
    const gasto = o.totalGasto || 0;
    const saldo = temPrevisto ? (o.saldo !== undefined && o.saldo !== null ? o.saldo : (o.valorPrevisto - gasto)) : null;
    return `
      <tr>
        <td>${esc(o.nome)}</td>
        <td>${esc(o.setor)}</td>
        <td>${o.semestre ? esc(o.semestre) : '—'}</td>
        <td><span class="status-badge status-${o.status}">${o.status === 'aberto' ? 'Em aberto' : 'Fechado'}</span></td>
        <td>${temPrevisto ? fmtMoeda(o.valorPrevisto) : '—'}</td>
        <td>${fmtMoeda(gasto)}</td>
        <td>${saldo !== null ? fmtMoeda(saldo) : '—'}</td>
      </tr>
    `;
  }).join('');
}

// Lista de fornecedores compartilhada com o módulo Licitação — só para
// sugerir nomes já usados (autocomplete) e manter consistência ao agrupar
// lançamentos por fornecedor. Falha aqui não deve travar a página.
async function carregarFornecedores() {
  try {
    const lista = await apiFetch('/financeiro/fornecedores');
    fornecedoresGlobais = lista.map(f => f.nome).filter(Boolean);
    document.getElementById('fornecedores-datalist').innerHTML = fornecedoresGlobais.map(n => `<option value="${esc(n)}">`).join('');
  } catch (err) {
    // Sem permissão de Licitação ou erro pontual — o campo de fornecedor
    // continua funcionando como texto livre, só sem sugestão.
  }
}

// Catálogo de itens recorrentes (Açúcar, Material de limpeza...) — cresce
// sozinho a cada lançamento com nome novo (ver upsert no backend), só serve
// de sugestão aqui.
async function carregarCatalogoItens() {
  try {
    const lista = await apiFetch('/orcamento/catalogo-itens');
    const nomes = lista.map(i => i.nome).filter(Boolean);
    document.getElementById('catalogo-itens-datalist').innerHTML = nomes.map(n => `<option value="${esc(n)}">`).join('');
  } catch (err) {
    // Erro pontual — o campo de item continua funcionando como texto livre.
  }
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

  // O datalist de autocomplete só existe no formulário de novo orçamento
  // (index.html) — no relatório não tem, e sem essa checagem a função
  // quebrava ali e travava o resto do carregamento da página.
  if (datalist) datalist.innerHTML = setores.map(s => `<option value="${esc(s)}">`).join('');
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
  // Campo de busca só existe na lista (index.html), não no relatório.
  const buscaInput = document.getElementById('busca-orcamento');
  const busca = buscaInput ? buscaInput.value.trim().toLowerCase() : '';

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

// Compartilhado entre a lista (index.html) e o relatório (relatorio.html) —
// os dois têm os mesmos ids de KPI, só o que vem embaixo (cards x tabela
// imprimível) é diferente.
function atualizarKPIs(lista) {
  // "Previsto"/"Saldo" só somam quem tem teto definido (nem todo orçamento
  // tem); "Gasto" soma todo mundo. O rótulo deixa claro de ONDE vem o valor:
  // nome do orçamento quando o filtro resulta em um só, ou "N orçamentos"
  // quando é uma soma de vários — sem isso não dá pra saber se é o previsto
  // de 1 orçamento ou de todos.
  const comPrevisto = lista.filter(o => o.valorPrevisto !== null && o.valorPrevisto !== undefined);
  const totalPrevisto = comPrevisto.reduce((s, o) => s + o.valorPrevisto, 0);
  const totalGasto = lista.reduce((s, o) => s + (o.totalGasto || 0), 0);
  const saldoGeral = totalPrevisto - comPrevisto.reduce((s, o) => s + (o.totalGasto || 0), 0);

  const escopo = lista.length === 1 ? `(${lista[0].nome})` : `— ${lista.length} orçamento${lista.length === 1 ? '' : 's'}`;
  document.getElementById('kpi-previsto-label').textContent = `Previsto ${escopo}`;
  document.getElementById('kpi-gasto-label').textContent = `Gasto ${escopo}`;
  document.getElementById('kpi-saldo-label').textContent = `Saldo ${escopo}`;

  document.getElementById('kpi-previsto').textContent = comPrevisto.length ? fmtMoeda(totalPrevisto) : '—';
  document.getElementById('kpi-gasto').textContent = fmtMoeda(totalGasto);
  const kpiSaldo = document.getElementById('kpi-saldo');
  kpiSaldo.textContent = comPrevisto.length ? fmtMoeda(saldoGeral) : '—';
  kpiSaldo.classList.toggle('valor-negativo', comPrevisto.length > 0 && saldoGeral < 0);
  document.getElementById('kpi-qtd').textContent = lista.length;
  document.getElementById('kpi-qtd-hint').textContent = comPrevisto.some(o => (o.totalGasto || 0) > o.valorPrevisto) ? 'Há orçamento(s) estourado(s)' : '';
}

function renderizarGrid() {
  const lista = orcamentosFiltrados();
  const grid = document.getElementById('orc-grid');

  atualizarKPIs(lista);

  if (!lista.length) {
    grid.innerHTML = '<div class="tabela-msg-grid">Nenhum orçamento encontrado com esses filtros.</div>';
    return;
  }

  grid.innerHTML = lista.map(o => {
    const temPrevisto = o.valorPrevisto !== null && o.valorPrevisto !== undefined;
    const previsto = o.valorPrevisto || 0;
    const gasto = o.totalGasto || 0;
    const saldo = o.saldo !== undefined ? o.saldo : (previsto - gasto);
    const pct = previsto ? Math.min(100, (gasto / previsto) * 100) : 0;
    return `
      <div class="orc-card" data-id="${o.id}">
        <div class="orc-card-topo">
          <div class="orc-card-nome">${esc(o.nome)}</div>
          <span class="status-badge status-${o.status}">${o.status === 'aberto' ? 'Em aberto' : 'Fechado'}</span>
        </div>
        <div class="orc-card-meta">
          <span class="setor-chip">${esc(o.setor)}</span>
          ${o.semestre ? `<span class="semestre-chip">${esc(o.semestre)}</span>` : ''}
          ${o.createdByNome ? `<span class="semestre-chip" title="Quem cadastrou este orçamento">${esc(o.createdByNome)}</span>` : ''}
        </div>
        ${temPrevisto ? `<div class="orc-progress-track"><div class="orc-progress-fill ${classeProgresso(previsto, gasto)}" style="width:${pct}%"></div></div>` : ''}
        <div class="orc-card-valores">
          ${temPrevisto ? `<div><span>Previsto</span><strong>${fmtMoeda(previsto)}</strong></div>` : ''}
          <div><span>Gasto</span><strong>${fmtMoeda(gasto)}</strong></div>
          ${temPrevisto
            ? `<div class="${saldo < 0 ? 'valor-saldo-negativo' : ''}"><span>Saldo</span><strong>${fmtMoeda(saldo)}</strong></div>`
            : `<div><span>Teto</span><strong>Não definido</strong></div>`}
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
  document.getElementById('orcamento-valor-previsto').value = (orcamento && orcamento.valorPrevisto !== null && orcamento.valorPrevisto !== undefined) ? orcamento.valorPrevisto : '';
  document.getElementById('orcamento-observacoes').value = orcamento ? (orcamento.observacoes || '') : '';
  document.getElementById('modal-orcamento').classList.remove('hidden');
}

function fecharModalOrcamento() {
  document.getElementById('modal-orcamento').classList.add('hidden');
}

async function salvarOrcamento(e) {
  e.preventDefault();
  const id = document.getElementById('orcamento-id').value;
  const valorPrevistoTexto = document.getElementById('orcamento-valor-previsto').value.trim();
  const body = {
    nome: document.getElementById('orcamento-nome').value.trim(),
    setor: document.getElementById('orcamento-setor').value.trim(),
    semestre: document.getElementById('orcamento-semestre').value.trim(),
    valorPrevisto: valorPrevistoTexto === '' ? null : Number(valorPrevistoTexto),
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

  const statusBadge = document.getElementById('detalhe-status-badge');
  statusBadge.textContent = orcamento.status === 'aberto' ? 'Em aberto' : 'Fechado';
  statusBadge.className = `status-badge status-${orcamento.status}`;

  const btnAlternarStatus = document.getElementById('btn-alternar-status');
  btnAlternarStatus.textContent = orcamento.status === 'aberto' ? 'Fechar orçamento' : 'Reabrir orçamento';

  document.getElementById('btn-excluir-orcamento').classList.toggle('hidden', !podeExcluirOrcamento());

  cancelarEdicaoLancamento();
  document.getElementById('lancamento-orcamento-id').value = id;
  document.getElementById('lancamento-data').value = new Date().toISOString().slice(0, 10);

  document.getElementById('modal-detalhe').classList.remove('hidden');
  document.getElementById('lancamentos-tbody').innerHTML = '<tr><td colspan="6" class="tabela-msg">Carregando...</td></tr>';

  try {
    const lancamentos = await apiFetch(`/orcamento/orcamentos/${id}/lancamentos`);
    renderizarLancamentos(lancamentos);
  } catch (err) {
    document.getElementById('lancamentos-tbody').innerHTML = `<tr><td colspan="6" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}

function atualizarResumoDetalhe(orcamento) {
  const temPrevisto = orcamento.valorPrevisto !== null && orcamento.valorPrevisto !== undefined;
  const gasto = orcamento.totalGasto || 0;
  document.getElementById('detalhe-gasto').textContent = fmtMoeda(gasto);

  const previstoWrap = document.getElementById('detalhe-previsto-wrap');
  const saldoWrap = document.getElementById('detalhe-saldo-wrap');
  previstoWrap.classList.toggle('hidden', !temPrevisto);
  saldoWrap.classList.toggle('hidden', !temPrevisto);

  if (temPrevisto) {
    const previsto = orcamento.valorPrevisto;
    const saldo = orcamento.saldo !== undefined && orcamento.saldo !== null ? orcamento.saldo : (previsto - gasto);
    document.getElementById('detalhe-previsto').textContent = fmtMoeda(previsto);
    const saldoEl = document.getElementById('detalhe-saldo');
    saldoEl.textContent = fmtMoeda(saldo);
    saldoWrap.classList.toggle('valor-negativo', saldo < 0);
  }
}

// Agrupado por fornecedor VENCEDOR (não por fornecedor "escolhido à mão") —
// cada item pode ter tido cotação de vários fornecedores, só a mais barata
// conta pra compra. É isso que dá a visão "o que comprar de cada empresa"
// sem misturar tudo numa lista só.
// Agrupa por fornecedor vencedor e monta as linhas da tabela (cabeçalho de
// grupo + itens). Reaproveitado pelo modal de detalhe (com Ações) e pelo
// relatório imprimível (sem Ações — é só visualização/impressão).
function montarLinhasAgrupadasPorFornecedor(lancamentos, comAcoes) {
  const grupos = new Map(); // nome do fornecedor vencedor -> lançamentos[]
  lancamentos.forEach(l => {
    const chave = l.fornecedorFechado || 'Sem fornecedor';
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  });

  const nomesOrdenados = [...grupos.keys()].sort((a, b) => {
    if (a === 'Sem fornecedor') return 1;
    if (b === 'Sem fornecedor') return -1;
    return a.localeCompare(b, 'pt-BR');
  });

  const colspan = comAcoes ? 6 : 5;
  return nomesOrdenados.map(nome => {
    const itens = grupos.get(nome);
    const subtotal = itens.reduce((s, l) => s + (l.valorTotalFechado || 0), 0);
    const header = `
      <tr class="lanc-grupo-header">
        <td colspan="${colspan}">${esc(nome)} <span>· ${itens.length} ${itens.length === 1 ? 'item' : 'itens'} · ${fmtMoeda(subtotal)}</span></td>
      </tr>
    `;
    const linhas = itens.map(l => `
      <tr>
        <td>
          ${esc(l.itemNome)}${l.unidade ? ` <span class="lanc-item-unidade">(${esc(l.unidade)})</span>` : ''}
          ${renderizarResumoCotacoes(l)}
        </td>
        <td>${l.quantidade}</td>
        <td>${fmtMoeda(l.valorUnitarioFechado)}</td>
        <td>${fmtMoeda(l.valorTotalFechado)}</td>
        <td>${l.data ? new Date(l.data + 'T00:00:00').toLocaleDateString('pt-BR') : '—'}</td>
        ${comAcoes ? `
        <td class="acoes-col action-execute">
          <button type="button" class="btn-icon action-execute" data-editar-lanc="${l.id}" title="Editar">✎</button>
          <button type="button" class="btn-icon action-execute" data-excluir-lanc="${l.id}" title="Excluir">🗑</button>
        </td>` : ''}
      </tr>
    `).join('');
    return header + linhas;
  }).join('');
}

function renderizarLancamentos(lancamentos) {
  const tbody = document.getElementById('lancamentos-tbody');
  if (!lancamentos.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabela-msg">Nenhum item lançado ainda.</td></tr>';
    return;
  }

  tbody.innerHTML = montarLinhasAgrupadasPorFornecedor(lancamentos, true);

  tbody.querySelectorAll('[data-editar-lanc]').forEach(btn => {
    btn.addEventListener('click', () => editarLancamento(btn.dataset.editarLanc, lancamentos));
  });
  tbody.querySelectorAll('[data-excluir-lanc]').forEach(btn => {
    btn.addEventListener('click', () => excluirLancamento(btn.dataset.excluirLanc));
  });
}

function renderizarResumoCotacoes(l) {
  const cotacoes = l.cotacoes || [];
  if (cotacoes.length <= 1) return '';
  const partes = cotacoes
    .slice()
    .sort((a, b) => a.valorUnitario - b.valorUnitario)
    .map(c => c.fornecedor === l.fornecedorFechado
      ? `<span class="cotacao-vencedora-nome">${esc(c.fornecedor)} ${fmtMoeda(c.valorUnitario)} ✓</span>`
      : `${esc(c.fornecedor)} ${fmtMoeda(c.valorUnitario)}`);
  return `<div class="lanc-cotacoes-resumo">${cotacoes.length} cotações: ${partes.join(' · ')}</div>`;
}

function editarLancamento(id, lancamentos) {
  const lanc = lancamentos.find(l => l.id === id);
  if (!lanc) return;
  lancamentoEmEdicaoId = id;
  document.getElementById('lancamento-id').value = id;
  document.getElementById('lancamento-item').value = lanc.itemNome;
  document.getElementById('lancamento-quantidade').value = lanc.quantidade;
  document.getElementById('lancamento-unidade').value = lanc.unidade || '';
  document.getElementById('lancamento-data').value = lanc.data || '';

  limparCotacoes();
  const cotacoes = (lanc.cotacoes && lanc.cotacoes.length) ? lanc.cotacoes : [{ fornecedor: lanc.fornecedorFechado, valorUnitario: lanc.valorUnitarioFechado }];
  cotacoes.forEach(c => adicionarLinhaCotacao(c.fornecedor, c.valorUnitario));

  document.getElementById('btn-salvar-lancamento').textContent = 'Atualizar gasto';
  document.getElementById('btn-cancelar-lancamento').classList.remove('hidden');
  document.getElementById('lancamento-item').focus();
}

function cancelarEdicaoLancamento() {
  lancamentoEmEdicaoId = null;
  document.getElementById('form-lancamento').reset();
  document.getElementById('lancamento-id').value = '';
  document.getElementById('lancamento-quantidade').value = 1;
  document.getElementById('btn-salvar-lancamento').textContent = 'Lançar gasto';
  document.getElementById('btn-cancelar-lancamento').classList.add('hidden');
  limparCotacoes();
  adicionarLinhaCotacao();
  adicionarLinhaCotacao();
}

async function excluirLancamento(id) {
  if (!confirm('Remover este item lançado? O valor volta a somar no saldo do orçamento.')) return;
  try {
    await apiFetch(`/orcamento/lancamentos/${id}`, { method: 'DELETE' });
    showToast('Item removido.');
    await recarregarDetalheAposMudanca();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// COTAÇÕES — linhas dinâmicas (fornecedor + valor) dentro do formulário de
// lançamento. A mais barata é destacada ao vivo enquanto a pessoa digita.
// ==========================================
function limparCotacoes() {
  document.getElementById('cotacoes-lista').innerHTML = '';
}

function adicionarLinhaCotacao(fornecedor = '', valorUnitario = '') {
  const lista = document.getElementById('cotacoes-lista');
  const row = document.createElement('div');
  row.className = 'cotacao-row';
  row.innerHTML = `
    <input type="text" class="cotacao-fornecedor" list="fornecedores-datalist" placeholder="Fornecedor" style="text-transform:uppercase;" value="${esc(fornecedor)}" maxlength="120">
    <input type="number" class="cotacao-valor" step="0.01" min="0" placeholder="Valor unit. (R$)" value="${valorUnitario === '' ? '' : valorUnitario}">
    <span class="cotacao-selo hidden">✓ mais barato</span>
    <button type="button" class="cotacao-remover" title="Remover cotação">×</button>
  `;
  lista.appendChild(row);

  row.querySelector('.cotacao-valor').addEventListener('input', atualizarSeloVencedora);
  row.querySelector('.cotacao-remover').addEventListener('click', () => {
    row.remove();
    atualizarSeloVencedora();
  });

  atualizarSeloVencedora();
}

function atualizarSeloVencedora() {
  const linhas = [...document.querySelectorAll('#cotacoes-lista .cotacao-row')];
  const valores = linhas.map(row => {
    const v = row.querySelector('.cotacao-valor').value;
    return v === '' ? null : Number(v);
  });
  const validos = valores.filter(v => v !== null && Number.isFinite(v));
  const menor = validos.length ? Math.min(...validos) : null;

  linhas.forEach((row, i) => {
    const venceu = menor !== null && valores[i] === menor;
    row.classList.toggle('cotacao-vencedora', venceu);
    row.querySelector('.cotacao-selo').classList.toggle('hidden', !venceu);
  });
}

function lerCotacoesDoFormulario() {
  const linhas = [...document.querySelectorAll('#cotacoes-lista .cotacao-row')];
  const cotacoes = [];
  for (const row of linhas) {
    const fornecedor = row.querySelector('.cotacao-fornecedor').value.trim();
    const valorTexto = row.querySelector('.cotacao-valor').value;
    if (!fornecedor && valorTexto === '') continue; // linha em branco, ignora
    if (!fornecedor || valorTexto === '') throw new Error('Preencha fornecedor e valor em todas as cotações (ou remova a linha em branco).');
    cotacoes.push({ fornecedor, valorUnitario: Number(valorTexto) });
  }
  if (!cotacoes.length) throw new Error('Informe ao menos uma cotação.');
  return cotacoes;
}

async function salvarLancamento(e) {
  e.preventDefault();
  const id = document.getElementById('lancamento-id').value;
  const orcamentoId = document.getElementById('lancamento-orcamento-id').value;

  let cotacoes;
  try {
    cotacoes = lerCotacoesDoFormulario();
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  const body = {
    itemNome: document.getElementById('lancamento-item').value.trim(),
    quantidade: Number(document.getElementById('lancamento-quantidade').value),
    unidade: document.getElementById('lancamento-unidade').value.trim(),
    data: document.getElementById('lancamento-data').value,
    cotacoes
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
    carregarCatalogoItens();
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
    showToast(novoStatus === 'aberto' ? 'Orçamento reaberto.' : 'Orçamento fechado.');
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

// Excluir o orçamento é mais restrito que editar/lançar gasto: só ADM N1/N2
// ou qualquer Chefe de Setor. Checagem só de UI — quem decide de verdade é
// o backend (ver DELETE /orcamento/orcamentos/:id).
function podeExcluirOrcamento() {
  return currentRole === 'adm_l1' || currentRole === 'adm_l2' || currentChefeDeSetor === true;
}

async function excluirOrcamentoAtual() {
  const orcamento = orcamentos.find(o => o.id === orcamentoDetalheId);
  if (!orcamento) return;
  if (!confirm(`Excluir o orçamento "${orcamento.nome}"? Só é possível se ele ainda não tiver nenhum lançamento de gasto.`)) return;
  try {
    await apiFetch(`/orcamento/orcamentos/${orcamento.id}`, { method: 'DELETE' });
    showToast('Orçamento excluído.');
    fecharModalDetalhe();
    await carregarOrcamentos();
  } catch (err) {
    showToast(err.message, 'error');
  }
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
  document.getElementById('btn-alternar-status').addEventListener('click', alternarStatusDetalhe);
  document.getElementById('btn-editar-orcamento').addEventListener('click', () => {
    const orcamento = orcamentos.find(o => o.id === orcamentoDetalheId);
    if (orcamento) abrirModalOrcamento(orcamento);
  });
  document.getElementById('btn-excluir-orcamento').addEventListener('click', excluirOrcamentoAtual);

  document.getElementById('form-lancamento').addEventListener('submit', salvarLancamento);
  document.getElementById('btn-cancelar-lancamento').addEventListener('click', cancelarEdicaoLancamento);
  document.getElementById('btn-add-cotacao').addEventListener('click', () => adicionarLinhaCotacao());

  [document.getElementById('modal-orcamento'), document.getElementById('modal-detalhe')].forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}
