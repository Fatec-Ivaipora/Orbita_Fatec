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
let itensNextCursor = null;
let itensHasMore = false;
let itensCarregandoTodas = false;

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
  } else if (document.getElementById('negociacao-root')) {
    initPaginaNegociacao();
  } else if (document.getElementById('fornecedores-root')) {
    initPaginaFornecedores();
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

  document.getElementById('busca-item')?.addEventListener('input', async (e) => {
    const termo = e.target.value.trim().toLowerCase();
    // Busca precisa ver o curso inteiro, não só a página já carregada — só
    // busca o restante na primeira vez que alguém digita (autolimitado: depois
    // disso itensHasMore já fica false e não busca de novo).
    if (termo && itensHasMore) {
      await carregarTodasPaginasRestantes();
    }
    const filtrados = termo ? itens.filter(it => it.produto.toLowerCase().includes(termo)) : itens;
    renderTabelaItens(filtrados);
    atualizarBotaoCarregarMais();
  });

  document.getElementById('btn-carregar-mais-itens')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-carregar-mais-itens');
    btn.disabled = true;
    btn.textContent = 'Carregando...';
    try {
      await buscarProximaPaginaItens(false);
      renderTabelaItens(itens);
    } catch (err) {
      showToast('Erro ao carregar mais itens: ' + err.message, 'error');
    } finally {
      atualizarBotaoCarregarMais();
    }
  });
}

// Busca o restante das páginas de uma vez só — usado quando a busca por texto
// precisa enxergar itens que ainda não foram carregados.
async function carregarTodasPaginasRestantes() {
  if (itensCarregandoTodas) return;
  itensCarregandoTodas = true;
  const btn = document.getElementById('btn-carregar-mais-itens');
  if (btn) { btn.disabled = true; btn.textContent = 'Carregando tudo pra buscar...'; }
  try {
    while (itensHasMore) {
      await buscarProximaPaginaItens(false);
    }
  } finally {
    itensCarregandoTodas = false;
  }
}

function atualizarBotaoCarregarMais() {
  const wrap = document.getElementById('carregar-mais-wrap');
  const btn = document.getElementById('btn-carregar-mais-itens');
  if (!wrap || !btn) return;
  const buscando = !!document.getElementById('busca-item')?.value.trim();
  wrap.classList.toggle('hidden', !itensHasMore || buscando);
  btn.disabled = false;
  btn.textContent = 'Carregar mais itens';
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

// Mantém os links "Relatório" e "Negociação" sempre apontando pro curso
// selecionado na tela, pra abrir já filtrados em vez de "Todos os cursos".
function atualizarLinkRelatorio() {
  const linkRelatorio = document.getElementById('link-relatorio');
  if (linkRelatorio) {
    linkRelatorio.href = cursoSelecionadoId
      ? `/financeiro/licitacao/relatorio.html?cursoId=${encodeURIComponent(cursoSelecionadoId)}`
      : '/financeiro/licitacao/relatorio.html';
  }
  const linkNegociacao = document.getElementById('link-negociacao');
  if (linkNegociacao) {
    linkNegociacao.href = cursoSelecionadoId
      ? `/financeiro/licitacao/negociacao.html?cursoId=${encodeURIComponent(cursoSelecionadoId)}`
      : '/financeiro/licitacao/negociacao.html';
  }
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

// Traz só a próxima página do curso/semestre selecionado (30 itens por vez
// por padrão) em vez do curso inteiro de uma tarada só — turmas grandes
// (Biomedicina, Medicina) chegam a ter 150-200+ itens, o que gastava uma
// cota de leitura enorme só pra abrir a tela.
async function buscarProximaPaginaItens(primeira) {
  const qsSemestre = semestreSelecionado ? `&semestre=${encodeURIComponent(semestreSelecionado)}` : '';
  const qsCursor = itensNextCursor
    ? `&cursorProduto=${encodeURIComponent(itensNextCursor.produto)}&cursorId=${encodeURIComponent(itensNextCursor.id)}`
    : '';
  const resp = await apiFetch(`/financeiro/itens?cursoId=${encodeURIComponent(cursoSelecionadoId)}${qsSemestre}${qsCursor}`);
  itens = primeira ? resp.itens : [...itens, ...resp.itens];
  itensHasMore = resp.hasMore;
  itensNextCursor = resp.nextCursor;
}

async function carregarItens() {
  const tbody = document.getElementById('itens-tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Carregando...</td></tr>`;
  itens = [];
  itensNextCursor = null;
  itensHasMore = false;
  try {
    await buscarProximaPaginaItens(true);
    document.getElementById('busca-item').value = '';
    renderTabelaItens(itens);
    atualizarBotaoCarregarMais();
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
    // Atualiza só o item local — não precisa reler o curso inteiro do Firestore
    // de novo pra mudar um status que a gente já sabe qual é.
    const item = itens.find(it => it.id === id);
    if (item) item.status = novo;
    renderTabelaItens(itens);
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
    itens = itens.filter(it => it.id !== id);
    renderTabelaItens(itens);
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
    const qtdInformada = parseFloat(document.getElementById('item-quantidade').value);
    const dados = {
      produto: document.getElementById('item-produto').value.trim(),
      // Mesma normalização que o servidor faz — importante porque agora
      // atualizamos o item local direto (sem reler do Firestore) e precisa
      // bater com o que ficou salvo de verdade.
      quantidade: !isNaN(qtdInformada) && qtdInformada > 0 ? qtdInformada : 1,
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
        // Atualiza o item local em vez de recarregar o curso inteiro. Se a
        // quantidade mudou, o servidor recalcula o valorTotal das cotações já
        // lançadas — replica a mesma conta aqui pra não mostrar total velho.
        const item = itens.find(it => it.id === id);
        if (item) {
          const qtdMudou = item.quantidade !== dados.quantidade;
          Object.assign(item, dados);
          if (qtdMudou && item.cotacoes?.length) {
            item.cotacoes = item.cotacoes.map(c => ({ ...c, valorTotal: Math.round(c.valorUnitario * dados.quantidade * 100) / 100 }));
          }
        }
      } else {
        const { id: novoId } = await apiFetch('/financeiro/itens', { method: 'POST', body: JSON.stringify(dados) });
        // Insere localmente na posição alfabética certa — evita reler o curso
        // inteiro só pra mostrar o item que a gente acabou de criar.
        itens.push({ ...dados, id: novoId, status: 'pendente', cotacoes: [] });
        itens.sort((a, b) => (a.produto || '').localeCompare(b.produto || ''));
      }
      modal.classList.add('hidden');
      showToast(id ? 'Item atualizado' : 'Item cadastrado');
      renderTabelaItens(itens);
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
// Lista global de fornecedores cadastrados — usada aqui, na tela de
// Fornecedores e no modal de Cotações (pra montar uma linha por empresa).
async function carregarFornecedores() {
  try {
    fornecedores = await apiFetch('/financeiro/fornecedores');
  } catch (err) {
    showToast('Erro ao carregar fornecedores: ' + err.message, 'error');
  }
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
      // Busca só esse item de novo (1 leitura) pra pegar o valorTotal
      // recalculado no servidor — não precisa reler o curso inteiro.
      const itemAtualizado = await apiFetch(`/financeiro/itens/${itemEmEdicaoCotacoes.id}`);
      const idx = itens.findIndex(it => it.id === itemEmEdicaoCotacoes.id);
      if (idx !== -1) itens[idx] = itemAtualizado;
      renderTabelaItens(itens);
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
  const linkNegociacao = document.getElementById('link-negociacao');
  // Se veio de "Licitação" com um curso já selecionado (?cursoId=...), abre o
  // relatório já filtrado nele em vez de "Todos os cursos".
  const cursoIdInicial = new URLSearchParams(window.location.search).get('cursoId') || '';

  function atualizarLinkNegociacao() {
    if (!linkNegociacao) return;
    linkNegociacao.href = select?.value
      ? `/financeiro/licitacao/negociacao.html?cursoId=${encodeURIComponent(select.value)}`
      : '/financeiro/licitacao/negociacao.html';
  }

  function atualizarLabelImpressao() {
    if (!cursoLabel) return;
    const curso = cursos.find(c => c.id === select.value);
    const partes = [curso ? curso.name : 'Todos os cursos'];
    if (selectPeriodicidade?.value) partes.push(selectPeriodicidade.value);
    if (selectCotacoes?.value === 'unica') partes.push('apenas 1 cotação');
    if (selectCotacoes?.value === 'multipla') partes.push('mais de 1 cotação');
    cursoLabel.textContent = partes.join(' — ');
  }

  // Lista de cursos pro filtro — usa o endpoint leve (~16 docs) em vez de
  // buscar o /relatorio inteiro (que lê TODOS os itens) só pra montar um
  // dropdown. Efeito colateral aceitável: pode listar curso sem nenhum item
  // ainda, que simplesmente mostra "sem dados" se selecionado.
  let cursosComItens = [];
  try {
    cursosComItens = (await apiFetch('/financeiro/cursos')).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    showToast('Erro ao carregar cursos do relatório: ' + err.message, 'error');
  }

  if (select) {
    select.innerHTML = '<option value="">Todos os cursos</option>' + cursosComItens.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (cursoIdInicial && cursosComItens.some(c => c.id === cursoIdInicial)) {
      select.value = cursoIdInicial;
    }
    select.addEventListener('change', () => {
      atualizarLabelImpressao();
      atualizarLinkNegociacao();
      relatorioEmAndamento = carregarRelatorio();
    });
  }
  atualizarLinkNegociacao();

  selectPeriodicidade?.addEventListener('change', () => {
    atualizarLabelImpressao();
    relatorioEmAndamento = carregarRelatorio();
  });
  selectCotacoes?.addEventListener('change', () => {
    atualizarLabelImpressao();
    relatorioEmAndamento = carregarRelatorio();
  });

  atualizarLabelImpressao();

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

  window.addEventListener('resize', atualizarIndicadorScrollComparativo);

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
    atualizarIndicadorScrollComparativo();
    return;
  }

  thead.innerHTML = `<tr>
    <th>Curso</th>
    <th>Produto</th>
    <th>Qtd/Und</th>
    ${fornecedores.map(f => `<th>${esc(f.nome)}</th>`).join('')}
  </tr>`;

  tbody.innerHTML = itens.map(item => `
    <tr>
      <td>${esc(item.curso)}</td>
      <td>${esc(item.produto)}</td>
      <td>${esc(item.quantidade)}${item.unidade ? ' ' + esc(item.unidade) : ''}</td>
      ${fornecedores.map(f => {
        const valor = item.valoresPorFornecedor[f.id];
        if (valor === undefined) return '<td class="valor-ausente">—</td>';
        const classe = f.id === item.vencedorFornecedorId ? 'valor-vencedor' : '';
        return `<td class="${classe}">${fmtMoeda(valor)}</td>`;
      }).join('')}
    </tr>
  `).join('');

  atualizarIndicadorScrollComparativo();
}

// Só mostra a dica/sombra de rolagem quando a tabela realmente transborda a
// tela — sem isso, apareceria até quando cabem todos os fornecedores.
function atualizarIndicadorScrollComparativo() {
  const wrap = document.getElementById('comparativo-scroll-wrap');
  const fade = document.getElementById('comparativo-scroll-fade');
  const dica = document.getElementById('comparativo-scroll-dica');
  if (!wrap || !fade || !dica) return;

  const temOverflow = wrap.scrollWidth > wrap.clientWidth + 4;
  dica.classList.toggle('hidden', !temOverflow);

  const atualizarFade = () => {
    const faltaRolar = wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft;
    fade.classList.toggle('hidden', !temOverflow || faltaRolar < 4);
  };
  atualizarFade();
  wrap.onscroll = atualizarFade;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ==========================================
// TELA DE NEGOCIAÇÃO (negociacao.html)
// ==========================================
// Por fornecedor: os itens que ele ganhou (pra ver quanto a Fatec gasta com
// ele) e os que perdeu (pra levar pra mesa de negociação — "o mesmo item na
// outra empresa é tanto"). Reaproveita o mesmo /financeiro/relatorio que já
// traz valoresPorFornecedor de cada item, então não precisou de rota nova.
let negociacaoComparativo = { fornecedores: [], itens: [] };

async function initPaginaNegociacao() {
  await carregarCursos();
  const selectCurso = document.getElementById('negociacao-curso-select');
  const selectFornecedor = document.getElementById('negociacao-fornecedor-select');
  const params = new URLSearchParams(window.location.search);
  const cursoIdInicial = params.get('cursoId') || '';
  const fornecedorIdInicial = params.get('fornecedorId') || '';

  // Lista de cursos pro filtro — endpoint leve, em vez do /relatorio inteiro
  // (ver mesma correção em initPaginaRelatorio).
  let cursosComItens = [];
  try {
    cursosComItens = (await apiFetch('/financeiro/cursos')).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    showToast('Erro ao carregar cursos: ' + err.message, 'error');
  }

  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosComItens.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (cursoIdInicial && cursosComItens.some(c => c.id === cursoIdInicial)) {
      selectCurso.value = cursoIdInicial;
    }
    selectCurso.addEventListener('change', () => carregarNegociacao());
  }

  selectFornecedor?.addEventListener('change', () => renderNegociacao(selectFornecedor.value));

  await carregarNegociacao(fornecedorIdInicial);
}

// fornecedorIdForcado só é usado na primeira carga, quando a tela abre a
// partir do link "Ver itens" do modal de Fornecedores (?fornecedorId=...).
async function carregarNegociacao(fornecedorIdForcado = '') {
  const selectFornecedor = document.getElementById('negociacao-fornecedor-select');
  const fornecedorSelecionado = fornecedorIdForcado || selectFornecedor?.value || '';
  try {
    const cursoId = document.getElementById('negociacao-curso-select')?.value || '';
    const qs = cursoId ? `?cursoId=${encodeURIComponent(cursoId)}` : '';
    const dados = await apiFetch(`/financeiro/relatorio${qs}`);
    negociacaoComparativo = dados.comparativo || { fornecedores: [], itens: [] };

    if (selectFornecedor) {
      selectFornecedor.innerHTML = '<option value="">Selecione um fornecedor...</option>' +
        negociacaoComparativo.fornecedores.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('');
      if (fornecedorSelecionado && negociacaoComparativo.fornecedores.some(f => f.id === fornecedorSelecionado)) {
        selectFornecedor.value = fornecedorSelecionado;
      }
    }
    renderNegociacao(selectFornecedor?.value || '');
  } catch (err) {
    showToast('Erro ao carregar negociação: ' + err.message, 'error');
  }
}

function renderNegociacao(fornecedorId) {
  const vazio = document.getElementById('negociacao-vazio');
  const conteudo = document.getElementById('negociacao-conteudo');
  if (!vazio || !conteudo) return;

  if (!fornecedorId) {
    vazio.classList.remove('hidden');
    conteudo.classList.add('hidden');
    return;
  }
  vazio.classList.add('hidden');
  conteudo.classList.remove('hidden');

  const { fornecedores, itens } = negociacaoComparativo;
  const nomeFornecedor = (id) => fornecedores.find(f => f.id === id)?.nome || '—';

  const ganhos = itens.filter(i => i.vencedorFornecedorId === fornecedorId);
  const perdidos = itens.filter(i => i.valoresPorFornecedor[fornecedorId] !== undefined && i.vencedorFornecedorId !== fornecedorId);

  const totalGanhando = ganhos.reduce((soma, i) => soma + (i.valoresPorFornecedor[fornecedorId] || 0), 0);
  // Não é "economia" pro Fatec — nos itens perdidos o Fatec já paga o menor
  // preço (do vencedor). É quanto a PRÓPRIA EMPRESA passaria a faturar a mais
  // com o Fatec se topasse igualar o preço do vencedor nesses itens, ou seja,
  // o argumento pra oferecer na negociação.
  const potencialAdicional = perdidos.reduce((soma, i) => soma + (i.valoresPorFornecedor[i.vencedorFornecedorId] || 0), 0);

  document.getElementById('neg-kpi-total').textContent = fmtMoeda(totalGanhando);
  document.getElementById('neg-kpi-ganhos').textContent = ganhos.length;
  document.getElementById('neg-kpi-perdidos').textContent = perdidos.length;
  document.getElementById('neg-kpi-potencial').textContent = fmtMoeda(potencialAdicional);

  const tbodyGanhos = document.getElementById('neg-tbody-ganhos');
  tbodyGanhos.innerHTML = ganhos.length ? ganhos.map(i => `
    <tr>
      <td>${esc(i.curso)}</td>
      <td>${esc(i.produto)}</td>
      <td>${esc(i.quantidade)}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
      <td>${fmtMoeda(i.valoresPorFornecedor[fornecedorId])}</td>
    </tr>
  `).join('') : '<tr><td colspan="4" class="tabela-msg">Essa empresa não está ganhando nenhum item nos filtros atuais.</td></tr>';

  const tbodyPerdidos = document.getElementById('neg-tbody-perdidos');
  tbodyPerdidos.innerHTML = perdidos.length ? perdidos.map(i => {
    const valorDela = i.valoresPorFornecedor[fornecedorId] || 0;
    const valorVencedor = i.valoresPorFornecedor[i.vencedorFornecedorId] || 0;
    const diferenca = valorDela - valorVencedor;
    return `
    <tr>
      <td>${esc(i.curso)}</td>
      <td>${esc(i.produto)}</td>
      <td>${esc(i.quantidade)}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
      <td>${fmtMoeda(valorDela)}</td>
      <td>${esc(nomeFornecedor(i.vencedorFornecedorId))}</td>
      <td>${fmtMoeda(valorVencedor)}</td>
      <td class="diferenca-alta">+${fmtMoeda(diferenca)}</td>
    </tr>
  `;
  }).join('') : '<tr><td colspan="7" class="tabela-msg">Essa empresa não perdeu nenhum item nos filtros atuais.</td></tr>';
}

// ==========================================
// TELA DE FORNECEDORES (fornecedores.html)
// ==========================================
// Cadastro/exclusão de empresas + consulta de todas as cotações de uma
// empresa específica (todos os cursos de uma vez), com edição rápida de
// produto/quantidade/valor direto dali — sem precisar ir na tela principal
// procurar o curso certo pra achar o mesmo item.
let fornecedorItensGeral = []; // itens com cotação de qualquer fornecedor, de todos os cursos
let fornecedorDetalheAbertoId = null;
let itemEmEdicaoFornecedor = null; // { item, fornecedorId } do item aberto no modal de edição

async function initPaginaFornecedores() {
  await carregarFornecedores();
  await recarregarItensGeraisFornecedores();
  renderTabelaFornecedores();
  setupModalEditarItemFornecedor();

  document.getElementById('form-fornecedor')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('fornecedor-nome');
    const nome = input.value.trim();
    if (!nome) return;
    try {
      await apiFetch('/financeiro/fornecedores', { method: 'POST', body: JSON.stringify({ nome }) });
      input.value = '';
      await carregarFornecedores();
      renderTabelaFornecedores();
      showToast('Fornecedor cadastrado');
    } catch (err) {
      showToast('Erro ao cadastrar: ' + err.message, 'error');
    }
  });
}

async function recarregarItensGeraisFornecedores() {
  try {
    const basedata = await apiFetch('/financeiro/relatorio');
    fornecedorItensGeral = basedata.comparativo.itens || [];
  } catch (err) {
    showToast('Erro ao carregar cotações: ' + err.message, 'error');
  }
}

function renderTabelaFornecedores() {
  const tbody = document.getElementById('fornecedores-tbody');
  if (!tbody) return;
  if (!fornecedores.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="tabela-msg">Nenhum fornecedor cadastrado ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = fornecedores.map(f => {
    const qtdItens = fornecedorItensGeral.filter(i => i.valoresPorFornecedor[f.id] !== undefined).length;
    return `
    <tr>
      <td>${esc(f.nome)}</td>
      <td>${qtdItens}</td>
      <td class="acoes-col">
        <button type="button" class="btn-icon" data-ver="${f.id}" data-nome="${esc(f.nome)}" title="Ver cotações">📋</button>
        <button type="button" class="btn-icon action-execute" data-excluir="${f.id}" data-nome="${esc(f.nome)}" title="Excluir">🗑️</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-ver]').forEach(btn => btn.addEventListener('click', () => {
    abrirDetalheFornecedor(btn.dataset.ver, btn.dataset.nome);
  }));
  tbody.querySelectorAll('[data-excluir]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Excluir o fornecedor "${btn.dataset.nome}"? As cotações já lançadas com ele nos itens não serão apagadas automaticamente.`)) return;
    try {
      await apiFetch(`/financeiro/fornecedores/${btn.dataset.excluir}`, { method: 'DELETE' });
      if (fornecedorDetalheAbertoId === btn.dataset.excluir) {
        document.getElementById('fornecedor-detalhe')?.classList.add('hidden');
        fornecedorDetalheAbertoId = null;
      }
      await carregarFornecedores();
      renderTabelaFornecedores();
      showToast('Fornecedor excluído');
    } catch (err) {
      showToast('Erro ao excluir: ' + err.message, 'error');
    }
  }));
}

// Mostra todos os itens com cotação dessa empresa, em qualquer curso — curso
// sem nenhuma cotação dela simplesmente não gera linha, sem poluir a tela.
function abrirDetalheFornecedor(fornecedorId, nome) {
  fornecedorDetalheAbertoId = fornecedorId;
  const painel = document.getElementById('fornecedor-detalhe');
  const titulo = document.getElementById('fornecedor-detalhe-titulo');
  const tbody = document.getElementById('fornecedor-detalhe-tbody');
  if (!painel || !titulo || !tbody) return;

  const itensDela = fornecedorItensGeral.filter(i => i.valoresPorFornecedor[fornecedorId] !== undefined);
  titulo.textContent = `Cotações — ${nome}`;

  tbody.innerHTML = itensDela.length ? itensDela.map(i => {
    const venceu = i.vencedorFornecedorId === fornecedorId;
    return `
    <tr>
      <td>${esc(i.curso)}</td>
      <td>${esc(i.produto)}</td>
      <td>${esc(i.quantidade)}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
      <td>${fmtMoeda(i.valoresPorFornecedor[fornecedorId])}</td>
      <td><span class="status-badge ${venceu ? 'status-venceu' : 'status-perdeu'}">${venceu ? 'Venceu' : 'Não venceu'}</span></td>
      <td><button type="button" class="btn-icon action-execute" data-editar-item="${i.itemId}" title="Editar produto/quantidade/valor">✏️</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="tabela-msg">Essa empresa ainda não tem nenhuma cotação registrada.</td></tr>';

  tbody.querySelectorAll('[data-editar-item]').forEach(btn => btn.addEventListener('click', () => {
    const item = itensDela.find(i => i.itemId === btn.dataset.editarItem);
    if (item) abrirModalEditarItemFornecedor(item, fornecedorId);
  }));

  painel.classList.remove('hidden');
  painel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setupModalEditarItemFornecedor() {
  const modal = document.getElementById('modal-editar-item');
  if (!modal) return;

  document.getElementById('btn-cancelar-editar-item')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('form-editar-item')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!itemEmEdicaoFornecedor) return;
    const { item, fornecedorId } = itemEmEdicaoFornecedor;

    const produto = document.getElementById('edit-item-produto').value.trim();
    const quantidade = parseFloat(document.getElementById('edit-item-quantidade').value);
    const novoValorTotal = parseFloat(document.getElementById('edit-item-valor').value);
    if (!produto || isNaN(quantidade) || quantidade <= 0 || isNaN(novoValorTotal) || novoValorTotal < 0) {
      showToast('Preencha produto, quantidade e valor corretamente.', 'error');
      return;
    }

    const btn = document.getElementById('btn-salvar-editar-item');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      // 1) Produto/quantidade valem pro item inteiro (todos os fornecedores).
      await apiFetch(`/financeiro/itens/${item.itemId}`, {
        method: 'PUT',
        body: JSON.stringify({ produto, quantidade })
      });
      // 2) Reconstrói a lista de cotações a partir do que já tínhamos: o valor
      // unitário de cada fornecedor é intrínseco a ele (valorTotal antigo /
      // quantidade antiga) e não muda; só o valor desta empresa é recalculado
      // a partir do novo total ÷ nova quantidade. O servidor recalcula o
      // valorTotal de todo mundo usando a quantidade já atualizada no passo 1.
      const cotacoes = Object.entries(item.valoresPorFornecedor).map(([fid, valorTotalAntigo]) => ({
        fornecedorId: fid,
        valorUnitario: fid === fornecedorId ? (novoValorTotal / quantidade) : (valorTotalAntigo / item.quantidade)
      }));
      await apiFetch(`/financeiro/itens/${item.itemId}/cotacoes`, {
        method: 'PUT',
        body: JSON.stringify({ cotacoes })
      });

      modal.classList.add('hidden');
      showToast('Item atualizado');

      // Atualiza o item local (fornecedorItensGeral) em vez de reler a
      // coleção inteira de novo — replica a mesma conta que o servidor faz.
      const itemGeral = fornecedorItensGeral.find(i => i.itemId === item.itemId);
      if (itemGeral) {
        itemGeral.produto = produto;
        itemGeral.quantidade = quantidade;
        const novosValores = {};
        cotacoes.forEach(c => { novosValores[c.fornecedorId] = Math.round(c.valorUnitario * quantidade * 100) / 100; });
        itemGeral.valoresPorFornecedor = novosValores;
        let menorId = null, menorValor = Infinity;
        Object.entries(novosValores).forEach(([fid, v]) => { if (v < menorValor) { menorValor = v; menorId = fid; } });
        itemGeral.vencedorFornecedorId = menorId;
      }

      renderTabelaFornecedores();
      const nomeAtual = fornecedores.find(f => f.id === fornecedorDetalheAbertoId)?.nome || '';
      if (fornecedorDetalheAbertoId) abrirDetalheFornecedor(fornecedorDetalheAbertoId, nomeAtual);
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

function abrirModalEditarItemFornecedor(item, fornecedorId) {
  itemEmEdicaoFornecedor = { item, fornecedorId };
  document.getElementById('edit-item-id').value = item.itemId;
  document.getElementById('edit-item-produto').value = item.produto;
  document.getElementById('edit-item-quantidade').value = item.quantidade;
  document.getElementById('edit-item-valor').value = item.valoresPorFornecedor[fornecedorId];
  document.getElementById('modal-editar-item').classList.remove('hidden');
}
