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
let currentRole = null;
let userLevel = 1;
let appInitialized = false;
let initializedRole = null;

let cursos = [];
let fornecedores = [];
let itens = [];
let cursoSelecionadoId = null;
let semestreSelecionado = null;
let itemEmEdicaoCotacoes = null;

function isCoordenador() {
  return currentRole === 'coordenador';
}

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

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2')) {
  currentUser = cached.user;
  currentRole = cached.role;
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
      const userData = await apiFetch('/usuarios/me');
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
        const perms = await apiFetch('/usuarios/config/permissions');
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, 'licitacao');
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }
    userLevel = level;

    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    document.body.classList.toggle('hide-execute', level < 3);
    // Coordenador cadastra/edita itens, mas não vê preços, fornecedores nem relatório.
    document.body.classList.toggle('modo-coordenador', role === 'coordenador');

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      currentRole = role;
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

  setupLayout(user, role, 'licitacao', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  if (document.getElementById('itens-tbody')) {
    initPaginaLicitacao();
  } else if (document.getElementById('relatorio-root')) {
    initPaginaRelatorio();
  }
}

// ==========================================
// TELA PRINCIPAL (index.html)
// ==========================================
async function initPaginaLicitacao() {
  await carregarCursos();
  const selectCurso = document.getElementById('curso-select');
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Selecione um curso...</option>' +
      cursos.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  setupModalFornecedores();
  setupModalItem();
  setupModalCotacoes();
  setupModalSemestre();
  await carregarSemestreAtivo();

  document.getElementById('curso-select')?.addEventListener('change', async (e) => {
    cursoSelecionadoId = e.target.value || null;
    document.getElementById('btn-novo-item')?.toggleAttribute('disabled', !cursoSelecionadoId || !semestreSelecionado);
    atualizarLinkRelatorio();
    if (cursoSelecionadoId && semestreSelecionado) await carregarItens();
    else renderTabelaItens([]);
  });

  document.getElementById('semestre-input')?.addEventListener('change', async (e) => {
    semestreSelecionado = e.target.value.trim() || null;
    document.getElementById('btn-novo-item')?.toggleAttribute('disabled', !cursoSelecionadoId || !semestreSelecionado);
    if (cursoSelecionadoId && semestreSelecionado) await carregarItens();
  });

  document.getElementById('busca-item')?.addEventListener('input', (e) => {
    const termo = e.target.value.trim().toLowerCase();
    const filtrados = termo ? itens.filter(it => it.produto.toLowerCase().includes(termo)) : itens;
    renderTabelaItens(filtrados);
  });
}

// Busca o semestre ativo configurado pelo financeiro. Coordenador fica travado
// nesse valor (só vê o badge); financeiro/admin veem o campo editável, já
// preenchido com o semestre ativo, mas podem trocar pra ver outro período.
async function carregarSemestreAtivo() {
  try {
    const { semestreAtivoCoordenador } = await apiFetch('/financeiro/config');
    const input = document.getElementById('semestre-input');
    const badge = document.getElementById('semestre-badge');

    if (isCoordenador()) {
      semestreSelecionado = semestreAtivoCoordenador || null;
      if (badge) {
        badge.textContent = semestreAtivoCoordenador ? `Semestre: ${semestreAtivoCoordenador}` : 'Semestre ainda não configurado pelo financeiro';
        badge.classList.remove('hidden');
      }
    } else if (input) {
      input.value = semestreAtivoCoordenador || '';
      semestreSelecionado = input.value.trim() || null;
    }
    document.getElementById('btn-novo-item')?.toggleAttribute('disabled', !cursoSelecionadoId || !semestreSelecionado);
  } catch (err) {
    showToast('Erro ao carregar semestre ativo: ' + err.message, 'error');
  }
}

function setupModalSemestre() {
  const modal = document.getElementById('modal-semestre');
  if (!modal) return;

  document.getElementById('btn-config-semestre')?.addEventListener('click', async () => {
    try {
      const { semestreAtivoCoordenador } = await apiFetch('/financeiro/config');
      document.getElementById('semestre-ativo-input').value = semestreAtivoCoordenador || '';
      modal.classList.remove('hidden');
    } catch (err) {
      showToast('Erro ao carregar configuração: ' + err.message, 'error');
    }
  });
  document.getElementById('btn-cancelar-semestre')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-salvar-semestre')?.addEventListener('click', async () => {
    const semestre = document.getElementById('semestre-ativo-input').value.trim();
    const btn = document.getElementById('btn-salvar-semestre');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      await apiFetch('/financeiro/config/semestre-ativo', { method: 'PUT', body: JSON.stringify({ semestre }) });
      modal.classList.add('hidden');
      showToast('Semestre ativo atualizado');
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

// Mantém o link "Relatório" sempre apontando pro curso selecionado na tela,
// pra abrir o relatório já filtrado em vez de "Todos os cursos".
function atualizarLinkRelatorio() {
  const link = document.getElementById('link-relatorio');
  if (!link) return;
  link.href = cursoSelecionadoId
    ? `/financeiro/licitacao/relatorio.html?cursoId=${encodeURIComponent(cursoSelecionadoId)}`
    : '/financeiro/licitacao/relatorio.html';
}

// Só busca e guarda a lista de cursos — cada tela (index.html/relatorio.html)
// popula seu próprio <select>, já que os ids dos elementos são diferentes.
async function carregarCursos() {
  try {
    cursos = await apiFetch('/financeiro/cursos');
  } catch (err) {
    showToast('Erro ao carregar cursos: ' + err.message, 'error');
  }
}

async function carregarItens() {
  const tbody = document.getElementById('itens-tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Carregando...</td></tr>`;
  try {
    const qsSemestre = semestreSelecionado ? `&semestre=${encodeURIComponent(semestreSelecionado)}` : '';
    itens = await apiFetch(`/financeiro/itens?cursoId=${encodeURIComponent(cursoSelecionadoId)}${qsSemestre}`);
    document.getElementById('busca-item').value = '';
    renderTabelaItens(itens);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}

function melhorCotacao(item) {
  const cotacoes = item.cotacoes || [];
  if (!cotacoes.length) return null;
  return cotacoes.reduce((menor, c) => (c.valorTotal < menor.valorTotal ? c : menor), cotacoes[0]);
}

// O campo aceita tanto um link real quanto uma observação livre (ex.: "Local",
// pra compras que não são online) — só vira <a> clicável se parecer uma URL de verdade.
function renderLinkReferencia(valor) {
  if (!valor) return '';
  if (/^https?:\/\//i.test(valor.trim())) {
    return `<a href="${esc(valor)}" target="_blank" title="Link de referência" class="item-link">🔗</a>`;
  }
  return `<span class="item-obs" title="${esc(valor)}">📍 ${esc(valor)}</span>`;
}

function renderTabelaItens(lista) {
  const tbody = document.getElementById('itens-tbody');
  if (!cursoSelecionadoId) {
    tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Selecione um curso para ver os itens.</td></tr>`;
    return;
  }
  if (!semestreSelecionado) {
    tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Informe o semestre para ver os itens.</td></tr>`;
    return;
  }
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Nenhum item cadastrado para este curso.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(item => {
    const melhor = melhorCotacao(item);
    return `
      <tr>
        <td>
          ${esc(item.produto)}
          ${renderLinkReferencia(item.linkReferencia)}
        </td>
        <td>${item.quantidade}</td>
        <td>${esc(item.unidade || '—')}</td>
        <td>${esc(item.periodicidade || '—')}</td>
        <td>${esc(item.professor || '—')}</td>
        <td class="no-coordenador">${(item.cotacoes || []).length}</td>
        <td class="valor-menor no-coordenador">${melhor ? fmtMoeda(melhor.valorTotal) : '—'}</td>
        <td class="no-coordenador">${melhor ? esc(melhor.fornecedorNome) : '—'}</td>
        <td>
          <button type="button" class="status-badge status-${item.status} action-execute" data-id="${item.id}" data-status="${item.status}">
            ${item.status === 'chegou' ? 'Chegou' : 'Pendente'}
          </button>
        </td>
        <td class="acoes-col">
          <button type="button" class="btn-icon acao-cotacoes action-execute no-coordenador" data-id="${item.id}" title="Cotações">💰</button>
          <button type="button" class="btn-icon acao-editar action-execute" data-id="${item.id}" title="Editar">✏️</button>
          <button type="button" class="btn-icon acao-excluir action-execute" data-id="${item.id}" title="Excluir">🗑️</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.status-badge').forEach(btn => btn.addEventListener('click', () => toggleStatus(btn.dataset.id, btn.dataset.status)));
  tbody.querySelectorAll('.acao-cotacoes').forEach(btn => btn.addEventListener('click', () => abrirModalCotacoes(btn.dataset.id)));
  tbody.querySelectorAll('.acao-editar').forEach(btn => btn.addEventListener('click', () => abrirModalItem(btn.dataset.id)));
  tbody.querySelectorAll('.acao-excluir').forEach(btn => btn.addEventListener('click', () => excluirItem(btn.dataset.id)));
}

async function toggleStatus(id, statusAtual) {
  const novo = statusAtual === 'chegou' ? 'pendente' : 'chegou';
  try {
    await apiFetch(`/financeiro/itens/${id}`, { method: 'PUT', body: JSON.stringify({ status: novo }) });
    await carregarItens();
  } catch (err) {
    showToast('Erro ao atualizar status: ' + err.message, 'error');
  }
}

async function excluirItem(id) {
  const item = itens.find(it => it.id === id);
  if (!confirm(`Excluir o item "${item ? item.produto : ''}"? Essa ação não tem volta.`)) return;
  try {
    await apiFetch(`/financeiro/itens/${id}`, { method: 'DELETE' });
    showToast('Item excluído');
    await carregarItens();
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// MODAL: NOVO/EDITAR ITEM
// ==========================================
function setupModalItem() {
  const modal = document.getElementById('modal-item');
  if (!modal) return;

  document.getElementById('btn-novo-item')?.addEventListener('click', () => abrirModalItem(null));
  document.getElementById('btn-cancelar-item')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('form-item')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-salvar-item');
    const id = document.getElementById('item-id').value;
    const cursoAtual = cursos.find(c => c.id === cursoSelecionadoId);
    const dados = {
      produto: document.getElementById('item-produto').value.trim(),
      quantidade: document.getElementById('item-quantidade').value,
      unidade: document.getElementById('item-unidade').value.trim(),
      periodicidade: document.getElementById('item-periodicidade').value.trim(),
      professor: document.getElementById('item-professor').value.trim(),
      linkReferencia: document.getElementById('item-link').value.trim()
    };
    if (!id) {
      dados.cursoId = cursoSelecionadoId;
      dados.curso = cursoAtual ? cursoAtual.name : '';
      dados.semestre = semestreSelecionado; // coordenador é sempre travado no servidor de qualquer forma
    }

    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      if (id) {
        await apiFetch(`/financeiro/itens/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      } else {
        await apiFetch('/financeiro/itens', { method: 'POST', body: JSON.stringify(dados) });
      }
      modal.classList.add('hidden');
      showToast(id ? 'Item atualizado' : 'Item cadastrado');
      await carregarItens();
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

function abrirModalItem(id) {
  const modal = document.getElementById('modal-item');
  const item = id ? itens.find(it => it.id === id) : null;

  document.getElementById('modal-item-title').textContent = item ? 'Editar Item' : 'Novo Item';
  document.getElementById('item-id').value = id || '';
  document.getElementById('item-produto').value = item?.produto || '';
  document.getElementById('item-quantidade').value = item?.quantidade || 1;
  document.getElementById('item-unidade').value = item?.unidade || '';
  document.getElementById('item-periodicidade').value = item?.periodicidade || '';
  document.getElementById('item-professor').value = item?.professor || '';
  document.getElementById('item-link').value = item?.linkReferencia || '';

  modal.classList.remove('hidden');
  document.getElementById('item-produto').focus();
}

// ==========================================
// MODAL: FORNECEDORES
// ==========================================
function setupModalFornecedores() {
  const modal = document.getElementById('modal-fornecedores');
  if (!modal) return;

  document.getElementById('btn-fornecedores')?.addEventListener('click', async () => {
    modal.classList.remove('hidden');
    await carregarFornecedores();
    renderListaFornecedores();
  });
  document.getElementById('btn-fechar-fornecedores')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('form-fornecedor')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('fornecedor-nome');
    const nome = input.value.trim();
    if (!nome) return;
    try {
      await apiFetch('/financeiro/fornecedores', { method: 'POST', body: JSON.stringify({ nome }) });
      input.value = '';
      await carregarFornecedores();
      renderListaFornecedores();
      showToast('Fornecedor cadastrado');
    } catch (err) {
      showToast('Erro ao cadastrar: ' + err.message, 'error');
    }
  });
}

async function carregarFornecedores() {
  try {
    fornecedores = await apiFetch('/financeiro/fornecedores');
  } catch (err) {
    showToast('Erro ao carregar fornecedores: ' + err.message, 'error');
  }
}

function renderListaFornecedores() {
  const lista = document.getElementById('lista-fornecedores');
  if (!lista) return;
  if (!fornecedores.length) {
    lista.innerHTML = '<p class="tabela-msg">Nenhum fornecedor cadastrado ainda.</p>';
    return;
  }
  lista.innerHTML = fornecedores.map(f => `
    <div class="fornecedor-item">
      <span>${esc(f.nome)}</span>
      <button type="button" class="btn-icon action-execute" data-id="${f.id}" data-nome="${esc(f.nome)}" title="Excluir">🗑️</button>
    </div>`).join('');

  lista.querySelectorAll('button').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Excluir o fornecedor "${btn.dataset.nome}"? As cotações já lançadas com ele nos itens não serão apagadas automaticamente.`)) return;
    try {
      await apiFetch(`/financeiro/fornecedores/${btn.dataset.id}`, { method: 'DELETE' });
      await carregarFornecedores();
      renderListaFornecedores();
    } catch (err) {
      showToast('Erro ao excluir: ' + err.message, 'error');
    }
  }));
}

// ==========================================
// MODAL: COTAÇÕES
// ==========================================
function setupModalCotacoes() {
  const modal = document.getElementById('modal-cotacoes');
  if (!modal) return;

  document.getElementById('btn-cancelar-cotacoes')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-salvar-cotacoes')?.addEventListener('click', async () => {
    const linhas = [...document.querySelectorAll('#lista-cotacoes .cotacao-linha')];
    const cotacoes = linhas
      .map(l => ({ fornecedorId: l.dataset.fornecedorId, valorUnitario: l.querySelector('input').value }))
      .filter(c => c.valorUnitario !== '');

    const btn = document.getElementById('btn-salvar-cotacoes');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      await apiFetch(`/financeiro/itens/${itemEmEdicaoCotacoes.id}/cotacoes`, {
        method: 'PUT',
        body: JSON.stringify({ cotacoes })
      });
      modal.classList.add('hidden');
      showToast('Cotações salvas');
      await carregarItens();
    } catch (err) {
      showToast('Erro ao salvar cotações: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar cotações';
    }
  });
}

async function abrirModalCotacoes(id) {
  const modal = document.getElementById('modal-cotacoes');
  const item = itens.find(it => it.id === id);
  if (!item) return;
  itemEmEdicaoCotacoes = item;

  document.getElementById('modal-cotacoes-titulo').textContent = `Cotações — ${item.produto}`;
  document.getElementById('modal-cotacoes-qtd').textContent = `Quantidade: ${item.quantidade} ${item.unidade || ''}`;

  if (!fornecedores.length) await carregarFornecedores();

  const cotacoesPorFornecedor = {};
  (item.cotacoes || []).forEach(c => { cotacoesPorFornecedor[c.fornecedorId] = c.valorUnitario; });

  renderLinhasCotacoes(item, cotacoesPorFornecedor);
  modal.classList.remove('hidden');
}

function renderLinhasCotacoes(item, cotacoesPorFornecedor) {
  const lista = document.getElementById('lista-cotacoes');
  if (!fornecedores.length) {
    lista.innerHTML = '<p class="tabela-msg">Nenhum fornecedor cadastrado. Cadastre em "Fornecedores" primeiro.</p>';
    return;
  }
  lista.innerHTML = fornecedores.map(f => `
    <div class="cotacao-linha" data-fornecedor-id="${f.id}">
      <span class="cotacao-nome">${esc(f.nome)}</span>
      <input type="number" step="0.01" min="0" placeholder="Valor unitário" value="${cotacoesPorFornecedor[f.id] ?? ''}">
      <span class="cotacao-total">—</span>
    </div>`).join('');

  const atualizarTotais = () => {
    const linhas = [...lista.querySelectorAll('.cotacao-linha')];
    let menor = Infinity, linhaMenor = null;
    linhas.forEach(l => {
      const v = parseFloat(l.querySelector('input').value);
      const totalEl = l.querySelector('.cotacao-total');
      l.classList.remove('cotacao-melhor');
      if (!isNaN(v) && v >= 0) {
        const total = Math.round(v * item.quantidade * 100) / 100;
        totalEl.textContent = fmtMoeda(total);
        if (total < menor) { menor = total; linhaMenor = l; }
      } else {
        totalEl.textContent = '—';
      }
    });
    if (linhaMenor) linhaMenor.classList.add('cotacao-melhor');
  };

  lista.querySelectorAll('input').forEach(inp => inp.addEventListener('input', atualizarTotais));
  atualizarTotais();
}

// ==========================================
// TELA DE RELATÓRIO (relatorio.html)
// ==========================================
let chartCurso = null, chartRanking = null, chartStatus = null;
let relatorioEmAndamento = Promise.resolve(); // promessa da última carga, pra "Imprimir" nunca pegar dado desatualizado

async function initPaginaRelatorio() {
  await carregarCursos();
  const select = document.getElementById('relatorio-curso-select');
  const selectPeriodicidade = document.getElementById('relatorio-periodicidade-select');
  const selectCotacoes = document.getElementById('relatorio-cotacoes-select');
  const cursoLabel = document.getElementById('print-curso-label');
  // Se veio de "Licitação" com um curso já selecionado (?cursoId=...), abre o
  // relatório já filtrado nele em vez de "Todos os cursos".
  const cursoIdInicial = new URLSearchParams(window.location.search).get('cursoId') || '';

  function atualizarLabelImpressao() {
    if (!cursoLabel) return;
    const curso = cursos.find(c => c.id === select.value);
    const partes = [curso ? curso.name : 'Todos os cursos'];
    if (selectPeriodicidade?.value) partes.push(selectPeriodicidade.value);
    if (selectCotacoes?.value === 'unica') partes.push('apenas 1 cotação');
    if (selectCotacoes?.value === 'multipla') partes.push('mais de 1 cotação');
    cursoLabel.textContent = partes.join(' — ');
  }

  if (select) {
    select.innerHTML = '<option value="">Todos os cursos</option>' + cursos.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (cursoIdInicial && cursos.some(c => c.id === cursoIdInicial)) {
      select.value = cursoIdInicial;
    }
    select.addEventListener('change', () => {
      atualizarLabelImpressao();
      relatorioEmAndamento = carregarRelatorio();
    });
  }

  selectPeriodicidade?.addEventListener('change', () => {
    atualizarLabelImpressao();
    relatorioEmAndamento = carregarRelatorio();
  });
  selectCotacoes?.addEventListener('change', () => {
    atualizarLabelImpressao();
    relatorioEmAndamento = carregarRelatorio();
  });

  atualizarLabelImpressao();

  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  document.getElementById('btn-imprimir-relatorio')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparando...';
    try {
      // Espera a busca em andamento (troca de curso, por ex.) terminar antes de
      // imprimir — senão a impressão podia sair com os dados da seleção anterior.
      await relatorioEmAndamento;
    } finally {
      btn.disabled = false;
      btn.innerHTML = textoOriginal;
    }
    window.print();
  });

  // Os canvases do Chart.js guardam o tamanho em pixel calculado pra tela;
  // sem forçar um resize antes de imprimir, o gráfico não se ajusta ao
  // layout (mais estreito) da folha e o conteúdo aparece cortado.
  window.addEventListener('beforeprint', () => {
    [chartCurso, chartRanking, chartStatus].forEach(c => c && c.resize());
  });

  relatorioEmAndamento = carregarRelatorio();
  await relatorioEmAndamento;
}

async function carregarRelatorio() {
  try {
    const cursoId = document.getElementById('relatorio-curso-select')?.value || '';
    const periodicidade = document.getElementById('relatorio-periodicidade-select')?.value || '';
    const cotacoesFiltro = document.getElementById('relatorio-cotacoes-select')?.value || '';
    const params = new URLSearchParams();
    if (cursoId) params.set('cursoId', cursoId);
    if (periodicidade) params.set('periodicidade', periodicidade);
    if (cotacoesFiltro) params.set('cotacoesFiltro', cotacoesFiltro);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const dados = await apiFetch(`/financeiro/relatorio${qs}`);
    renderRelatorio(dados);
  } catch (err) {
    showToast('Erro ao carregar relatório: ' + err.message, 'error');
  }
}

function renderRelatorio(dados) {
  document.getElementById('kpi-gasto').textContent = fmtMoeda(dados.geral.gastoTotal);
  document.getElementById('kpi-economia').textContent = fmtMoeda(dados.geral.economia);
  document.getElementById('kpi-pendente').textContent = dados.geral.pendente;
  document.getElementById('kpi-chegou').textContent = dados.geral.chegou;

  const porCurso = dados.porCurso.sort((a, b) => b.gastoTotal - a.gastoTotal);
  const ranking = dados.rankingFornecedores.slice(0, 8);

  const cores = ['#0F4EB8', '#EB7025', '#10B981', '#EF4444', '#8B5CF6', '#06B6D4', '#F59E0B', '#64748B'];

  if (chartCurso) chartCurso.destroy();
  chartCurso = new Chart(document.getElementById('chart-curso'), {
    type: 'bar',
    data: {
      labels: porCurso.map(c => c.curso),
      datasets: [{ label: 'Gasto (menor cotação)', data: porCurso.map(c => c.gastoTotal), backgroundColor: '#0F4EB8', borderRadius: 6 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });

  if (chartRanking) chartRanking.destroy();
  chartRanking = new Chart(document.getElementById('chart-ranking'), {
    type: 'bar',
    data: {
      labels: ranking.map(r => r.nome),
      datasets: [{ label: 'Cotações vencidas', data: ranking.map(r => r.vitorias), backgroundColor: cores, borderRadius: 6 }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });

  if (chartStatus) chartStatus.destroy();
  chartStatus = new Chart(document.getElementById('chart-status'), {
    type: 'doughnut',
    data: {
      labels: ['Pendente', 'Chegou'],
      datasets: [{ data: [dados.geral.pendente, dados.geral.chegou], backgroundColor: ['#F59E0B', '#10B981'] }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  renderComparativo(dados.comparativo);
}

// Tabela "produto x fornecedor" — mostra o valor que cada empresa cotou pra
// cada item lado a lado (não só quem ganhou), pra dar a visão de orçamento
// comparativo que o financeiro pediu.
function renderComparativo(comparativo) {
  const thead = document.getElementById('comparativo-thead');
  const tbody = document.getElementById('comparativo-tbody');
  if (!thead || !tbody) return;

  const fornecedores = comparativo?.fornecedores || [];
  const itens = comparativo?.itens || [];

  if (!itens.length) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="tabela-msg">Nenhum item com cotação para os filtros selecionados.</td></tr>';
    return;
  }

  thead.innerHTML = `<tr>
    <th>Curso</th>
    <th>Produto</th>
    ${fornecedores.map(f => `<th>${esc(f.nome)}</th>`).join('')}
  </tr>`;

  tbody.innerHTML = itens.map(item => `
    <tr>
      <td>${esc(item.curso)}</td>
      <td>${esc(item.produto)}</td>
      ${fornecedores.map(f => {
        const valor = item.valoresPorFornecedor[f.id];
        if (valor === undefined) return '<td class="valor-ausente">—</td>';
        const classe = f.id === item.vencedorFornecedorId ? 'valor-vencedor' : '';
        return `<td class="${classe}">${fmtMoeda(valor)}</td>`;
      }).join('')}
    </tr>
  `).join('');
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
