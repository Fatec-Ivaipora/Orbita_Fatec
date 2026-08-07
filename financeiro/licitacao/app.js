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
let statusFiltroSelecionado = 'pendentes';

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
  } else if (document.getElementById('fechamento-root')) {
    initPaginaFechamento();
  } else if (document.getElementById('entregas-root')) {
    initPaginaEntregas();
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

  document.getElementById('status-filtro-select')?.addEventListener('change', async (e) => {
    statusFiltroSelecionado = e.target.value || 'pendentes';
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
  const qsStatus = statusFiltroSelecionado !== 'pendentes' ? `&statusFiltro=${encodeURIComponent(statusFiltroSelecionado)}` : '';
  const qsCursor = itensNextCursor
    ? `&cursorProduto=${encodeURIComponent(itensNextCursor.produto)}&cursorId=${encodeURIComponent(itensNextCursor.id)}`
    : '';
  const resp = await apiFetch(`/financeiro/itens?cursoId=${encodeURIComponent(cursoSelecionadoId)}${qsSemestre}${qsStatus}${qsCursor}`);
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
          ${item.status === 'fechado'
            ? `<span class="status-badge status-fechado" title="Fechado com ${esc(item.fornecedorFechadoNome || '')}">Fechado — ${esc(item.fornecedorFechadoNome || '')}</span>`
            : `<span class="status-badge status-pendente">Pendente</span>`}
        </td>
        <td class="acoes-col">
          <button type="button" class="btn-icon acao-cotacoes action-execute no-coordenador" data-id="${item.id}" title="Cotações">💰</button>
          <button type="button" class="btn-icon acao-editar action-execute" data-id="${item.id}" title="Editar">✏️</button>
          <button type="button" class="btn-icon acao-excluir action-execute" data-id="${item.id}" title="Excluir">🗑️</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.acao-cotacoes').forEach(btn => btn.addEventListener('click', () => abrirModalCotacoes(btn.dataset.id)));
  tbody.querySelectorAll('.acao-editar').forEach(btn => btn.addEventListener('click', () => abrirModalItem(btn.dataset.id)));
  tbody.querySelectorAll('.acao-excluir').forEach(btn => btn.addEventListener('click', () => excluirItem(btn.dataset.id)));
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
let itensComparacaoAtual = []; // itens em comum entre as 2 empresas selecionadas na "calculadora"
let selecionadosComparacao = new Set(); // itemId dos itens marcados na calculadora

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

  document.getElementById('btn-imprimir-ganhos')?.addEventListener('click', () => imprimirNegociacao('ganhos'));
  document.getElementById('btn-imprimir-perdidos')?.addEventListener('click', () => imprimirNegociacao('perdidos'));

  document.getElementById('comparar-empresa-a')?.addEventListener('change', renderComparacaoDuasEmpresas);
  document.getElementById('comparar-empresa-b')?.addEventListener('change', renderComparacaoDuasEmpresas);

  document.getElementById('btn-comp-marcar-todos')?.addEventListener('click', () => {
    itensComparacaoAtual.forEach(i => selecionadosComparacao.add(i.itemId));
    document.querySelectorAll('.comp-item-check').forEach(chk => { chk.checked = true; });
    atualizarCalculadoraComparacao();
  });
  document.getElementById('btn-comp-limpar')?.addEventListener('click', () => {
    selecionadosComparacao.clear();
    document.querySelectorAll('.comp-item-check').forEach(chk => { chk.checked = false; });
    atualizarCalculadoraComparacao();
  });

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
    popularSelectsComparacao();
  } catch (err) {
    showToast('Erro ao carregar negociação: ' + err.message, 'error');
  }
}

// Popula os dois selects de "comparar duas empresas" preservando a seleção
// atual, se a empresa ainda existir na lista (ex.: depois de trocar o curso).
function popularSelectsComparacao() {
  const selectA = document.getElementById('comparar-empresa-a');
  const selectB = document.getElementById('comparar-empresa-b');
  if (!selectA || !selectB) return;

  const { fornecedores } = negociacaoComparativo;
  const valorAtualA = selectA.value;
  const valorAtualB = selectB.value;

  const opcoes = fornecedores.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('');
  selectA.innerHTML = '<option value="">Empresa A...</option>' + opcoes;
  selectB.innerHTML = '<option value="">Empresa B...</option>' + opcoes;

  if (fornecedores.some(f => f.id === valorAtualA)) selectA.value = valorAtualA;
  if (fornecedores.some(f => f.id === valorAtualB)) selectB.value = valorAtualB;

  renderComparacaoDuasEmpresas();
}

// Comparação direta entre duas empresas — só os itens onde AS DUAS cotaram,
// pra ver visualmente a disputa quando fica concentrada entre um par de
// fornecedores (o resto do comparativo geral mostra todo mundo, o que fica
// poluído quando o que importa é só essas duas).
function renderComparacaoDuasEmpresas() {
  const vazio = document.getElementById('comparar-vazio');
  const conteudo = document.getElementById('comparar-conteudo');
  if (!vazio || !conteudo) return;

  const idA = document.getElementById('comparar-empresa-a')?.value || '';
  const idB = document.getElementById('comparar-empresa-b')?.value || '';

  if (!idA || !idB) {
    vazio.textContent = 'Selecione as duas empresas para comparar.';
    vazio.classList.remove('hidden');
    conteudo.classList.add('hidden');
    return;
  }
  if (idA === idB) {
    vazio.textContent = 'Escolha duas empresas diferentes.';
    vazio.classList.remove('hidden');
    conteudo.classList.add('hidden');
    return;
  }

  const { fornecedores, itens } = negociacaoComparativo;
  const nomeA = fornecedores.find(f => f.id === idA)?.nome || '—';
  const nomeB = fornecedores.find(f => f.id === idB)?.nome || '—';

  const itensEmComum = itens.filter(i =>
    i.valoresPorFornecedor[idA] !== undefined && i.valoresPorFornecedor[idB] !== undefined
  );
  itensComparacaoAtual = itensEmComum;
  selecionadosComparacao = new Set(); // troca de empresa/curso zera a seleção da calculadora

  vazio.classList.add('hidden');
  conteudo.classList.remove('hidden');

  document.getElementById('comp-th-a').textContent = nomeA;
  document.getElementById('comp-th-b').textContent = nomeB;
  document.getElementById('comp-kpi-a-label').textContent = `Vitórias de ${nomeA}`;
  document.getElementById('comp-kpi-b-label').textContent = `Vitórias de ${nomeB}`;
  document.getElementById('comp-calc-a-label').textContent = nomeA;
  document.getElementById('comp-calc-b-label').textContent = nomeB;

  let vitoriasA = 0, vitoriasB = 0, empates = 0;

  const linhas = itensEmComum.map(i => {
    const valorA = i.valoresPorFornecedor[idA];
    const valorB = i.valoresPorFornecedor[idB];
    const diferenca = valorA - valorB;
    let classeA = '', classeB = '';
    if (valorA < valorB) { vitoriasA++; classeA = 'valor-vencedor'; }
    else if (valorB < valorA) { vitoriasB++; classeB = 'valor-vencedor'; }
    else { empates++; }

    return `
    <tr>
      <td><input type="checkbox" class="comp-item-check" data-item-id="${i.itemId}"></td>
      <td>${esc(i.curso)}</td>
      <td>${esc(i.produto)}</td>
      <td>${esc(i.quantidade)}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
      <td class="${classeA}">${fmtMoeda(valorA)}</td>
      <td class="${classeB}">${fmtMoeda(valorB)}</td>
      <td>${diferenca === 0 ? '—' : (diferenca > 0 ? '+' : '') + fmtMoeda(diferenca)}</td>
    </tr>`;
  });

  const tbody = document.getElementById('comp-tbody');
  tbody.innerHTML = linhas.length
    ? linhas.join('')
    : `<tr><td colspan="7" class="tabela-msg">${esc(nomeA)} e ${esc(nomeB)} não cotaram nenhum item em comum nos filtros atuais.</td></tr>`;

  tbody.querySelectorAll('.comp-item-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) selecionadosComparacao.add(chk.dataset.itemId);
      else selecionadosComparacao.delete(chk.dataset.itemId);
      atualizarCalculadoraComparacao();
    });
  });

  document.getElementById('comp-kpi-total').textContent = itensEmComum.length;
  document.getElementById('comp-kpi-a').textContent = vitoriasA;
  document.getElementById('comp-kpi-b').textContent = vitoriasB;
  document.getElementById('comp-kpi-empate').textContent = empates;

  atualizarCalculadoraComparacao();
}

// Soma ao vivo dos itens marcados na calculadora — não precisa re-renderizar
// a tabela inteira a cada clique, só recalcula os totais.
function atualizarCalculadoraComparacao() {
  const idA = document.getElementById('comparar-empresa-a')?.value || '';
  const idB = document.getElementById('comparar-empresa-b')?.value || '';

  let somaA = 0, somaB = 0;
  itensComparacaoAtual.forEach(i => {
    if (!selecionadosComparacao.has(i.itemId)) return;
    somaA += i.valoresPorFornecedor[idA] || 0;
    somaB += i.valoresPorFornecedor[idB] || 0;
  });

  document.getElementById('comp-calc-qtd').textContent = `${selecionadosComparacao.size} ${selecionadosComparacao.size === 1 ? 'item selecionado' : 'itens selecionados'}`;
  document.getElementById('comp-calc-a').textContent = fmtMoeda(somaA);
  document.getElementById('comp-calc-b').textContent = fmtMoeda(somaB);
  const diferenca = somaA - somaB;
  document.getElementById('comp-calc-diferenca').textContent = (diferenca === 0 ? '' : (diferenca > 0 ? '+' : '')) + fmtMoeda(diferenca);
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

  // Ganhou/perdeu de verdade é quem FECHOU o item no Fechamento — não quem
  // tinha o menor preço na cotação (vencedorFornecedorId). Uma empresa pode
  // fechar um item negociando desconto mesmo sem ser a mais barata (caso já
  // visto na prática), e o inverso também: ser a mais barata mas o item
  // ainda não ter sido fechado com ninguém. Só o que já está decidido no
  // Fechamento entra aqui, pra ninguém achar que já garantiu um item que na
  // verdade ainda vai ter que comprar de outra empresa (ou que perdeu um
  // item que na verdade fechou).
  const ganhos = itens.filter(i => i.status === 'fechado' && i.fornecedorFechadoId === fornecedorId);
  const perdidos = itens.filter(i => i.valoresPorFornecedor[fornecedorId] !== undefined
    && i.status === 'fechado' && i.fornecedorFechadoId && i.fornecedorFechadoId !== fornecedorId);

  const totalGanhando = ganhos.reduce((soma, i) => soma + (i.valoresPorFornecedor[fornecedorId] || 0), 0);
  // Não é "economia" pro Fatec — nos itens perdidos o Fatec já paga o valor
  // fechado com a outra empresa. É quanto a PRÓPRIA EMPRESA passaria a
  // faturar a mais com o Fatec se topasse igualar esse valor nesses itens,
  // ou seja, o argumento pra oferecer na negociação.
  const potencialAdicional = perdidos.reduce((soma, i) => soma + (i.valorFechado || 0), 0);
  // Valor total que ela cotou no processo inteiro (ganhando + perdendo) — o
  // tamanho da licitação pra essa empresa, não só o que ela já garantiu.
  const valorTotalEmpresa = ganhos.reduce((soma, i) => soma + (i.valoresPorFornecedor[fornecedorId] || 0), 0)
    + perdidos.reduce((soma, i) => soma + (i.valoresPorFornecedor[fornecedorId] || 0), 0);

  document.getElementById('neg-kpi-valor-total-empresa').textContent = fmtMoeda(valorTotalEmpresa);
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
    const valorFechado = i.valorFechado || 0;
    const diferenca = valorDela - valorFechado;
    return `
    <tr>
      <td>${esc(i.curso)}</td>
      <td>${esc(i.produto)}</td>
      <td>${esc(i.quantidade)}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
      <td>${fmtMoeda(valorDela)}</td>
      <td>${esc(i.fornecedorFechadoNome || '—')}</td>
      <td>${fmtMoeda(valorFechado)}</td>
      <td class="${diferenca >= 0 ? 'diferenca-alta' : ''}">${diferenca > 0 ? '+' : ''}${fmtMoeda(diferenca)}</td>
    </tr>
  `;
  }).join('') : '<tr><td colspan="7" class="tabela-msg">Essa empresa não perdeu nenhum item nos filtros atuais.</td></tr>';

  const nomeAtual = nomeFornecedor(fornecedorId);
  const dataEmissao = 'Emitido em ' + new Date().toLocaleString('pt-BR');
  document.getElementById('negociacao-print-nome-ganhos').textContent = nomeAtual;
  document.getElementById('negociacao-print-nome-perdidos').textContent = nomeAtual;
  document.getElementById('negociacao-print-data-ganhos').textContent = dataEmissao;
  document.getElementById('negociacao-print-data-perdidos').textContent = dataEmissao;
}

// Imprime só o card de "ganhos" ou só o de "perdidos" — marca no body qual
// dos dois é pra mostrar (ver CSS @media print em licitacao.css) e desfaz
// depois de imprimir, senão a tela fica com o outro card escondido.
function imprimirNegociacao(tipo) {
  document.body.dataset.imprimindo = tipo;
  const limpar = () => { delete document.body.dataset.imprimindo; window.removeEventListener('afterprint', limpar); };
  window.addEventListener('afterprint', limpar);
  window.print();
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

  document.getElementById('btn-imprimir-fornecedor')?.addEventListener('click', () => window.print());

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

  // Cabeçalho que só aparece na impressão — é o relatório que sai impresso
  // pro próprio fornecedor, então não mostra status de venceu/perdeu (é
  // informação interna, não deveria ir pra mão da empresa concorrente).
  const printNome = document.getElementById('fornecedor-print-nome');
  const printData = document.getElementById('fornecedor-print-data');
  if (printNome) printNome.textContent = nome;
  if (printData) printData.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  tbody.innerHTML = itensDela.length ? itensDela.map(i => {
    // Venceu/perdeu de verdade é quem FECHOU o item no Fechamento — não quem
    // tinha o menor preço na cotação. Mesma correção aplicada na Negociação:
    // ver comentário em renderNegociacao.
    const fechado = i.status === 'fechado';
    const venceu = fechado && i.fornecedorFechadoId === fornecedorId;
    const perdeu = fechado && !!i.fornecedorFechadoId && i.fornecedorFechadoId !== fornecedorId;
    const statusClasse = venceu ? 'status-venceu' : (perdeu ? 'status-perdeu' : 'status-pendente');
    const statusTexto = venceu ? 'Venceu' : (perdeu ? 'Perdeu' : 'Em aberto');
    const statusTitle = perdeu ? `title="Fechado com ${esc(i.fornecedorFechadoNome || 'outra empresa')}"` : '';
    return `
    <tr>
      <td>${esc(i.curso)}</td>
      <td>${esc(i.produto)}</td>
      <td>${esc(i.quantidade)}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
      <td>${fmtMoeda(i.valoresPorFornecedor[fornecedorId])}</td>
      <td class="no-print"><span class="status-badge ${statusClasse}" ${statusTitle}>${statusTexto}</span></td>
      <td class="no-print"><button type="button" class="btn-icon action-execute" data-editar-item="${i.itemId}" title="Editar produto/quantidade/valor">✏️</button></td>
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

// ==========================================
// TELA DE FECHAMENTO (fechamento.html)
// ==========================================
// Fecha um lote de itens com uma empresa a partir do orçamento final
// negociado (que pode incluir itens que ela não venceu por preço — a
// negociação do financeiro vale mais que o menor preço "de tabela").
let fechaCandidatos = []; // resultado cru da busca, 1 entrada por linha colada

async function initPaginaFechamento() {
  await carregarFornecedores();
  const selectFornecedor = document.getElementById('fecha-fornecedor-select');
  if (selectFornecedor) {
    selectFornecedor.innerHTML = '<option value="">Selecione a empresa...</option>' +
      fornecedores.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('');
  }

  // Pré-preenche com o semestre ativo que o financeiro já configurou (mesmo
  // valor que os coordenadores enxergam) — continua editável pra fechar um
  // semestre diferente se precisar.
  const semestreInput = document.getElementById('fecha-semestre-input');
  if (semestreInput) {
    try {
      const { semestreAtivoCoordenador } = await apiFetch('/financeiro/config');
      if (semestreAtivoCoordenador) semestreInput.value = semestreAtivoCoordenador;
    } catch (err) {
      // Sem semestre ativo configurado ainda — deixa o campo em branco pra
      // preencher na mão, sem travar o resto da tela.
    }
  }

  let cursosParaFiltro = [];
  try {
    cursosParaFiltro = await apiFetch('/financeiro/cursos');
  } catch (err) {
    showToast('Erro ao carregar cursos: ' + err.message, 'error');
  }
  const selectCursoPendentes = document.getElementById('fecha-pendentes-curso-select');
  if (selectCursoPendentes) {
    selectCursoPendentes.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosParaFiltro.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  const selectCursoGeral = document.getElementById('fecha-geral-curso-select');
  if (selectCursoGeral) {
    selectCursoGeral.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosParaFiltro.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  const selectCursoDesconto = document.getElementById('fecha-desconto-curso-select');
  if (selectCursoDesconto) {
    selectCursoDesconto.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosParaFiltro.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }

  document.getElementById('btn-ver-itens-desconto')?.addEventListener('click', carregarItensDesconto);
  document.getElementById('fecha-desconto-valor')?.addEventListener('input', atualizarCalculadoraDesconto);
  document.getElementById('fecha-desconto-tipo')?.addEventListener('change', atualizarCalculadoraDesconto);
  document.getElementById('btn-confirmar-fechamento-desconto')?.addEventListener('click', confirmarFechamentoComDesconto);

  document.getElementById('btn-buscar-candidatos')?.addEventListener('click', buscarCandidatosFechamento);
  document.getElementById('btn-confirmar-fechamento')?.addEventListener('click', confirmarFechamento);
  document.getElementById('btn-ver-pendentes')?.addEventListener('click', carregarPendentesFechamento);
  document.getElementById('fecha-pendentes-curso-select')?.addEventListener('change', carregarPendentesFechamento);
  document.getElementById('fecha-pendentes-empresa-select')?.addEventListener('change', renderPendentesEmpresaSelecionada);
  document.getElementById('btn-imprimir-pendentes')?.addEventListener('click', () => window.print());
  document.getElementById('btn-ver-fechados-geral')?.addEventListener('click', carregarFechadosGeral);
  document.getElementById('fecha-geral-curso-select')?.addEventListener('change', carregarFechadosGeral);
  document.getElementById('btn-ver-fechados')?.addEventListener('click', carregarFechadosFechamento);
  document.getElementById('btn-desfazer-lote')?.addEventListener('click', desfazerLoteFechamento);
}

// Aceita linhas separadas por ; (produto;quantidade;valorUnitario;valorTotal)
// ou por tab (colado direto de planilha/Excel).
function parseLinhasOrcamento(texto) {
  return texto.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(linha => {
      const partes = linha.includes(';') ? linha.split(';') : linha.split('\t');
      const [produto, quantidade, valorUnitario, valorTotal] = partes.map(p => (p || '').trim());
      return {
        produto,
        quantidade: parseFloat((quantidade || '').replace(',', '.')) || 1,
        valorUnitario: parseFloat((valorUnitario || '').replace(',', '.')) || 0,
        valorTotal: parseFloat((valorTotal || '').replace(',', '.')) || 0
      };
    })
    .filter(i => i.produto);
}

async function buscarCandidatosFechamento() {
  const fornecedorId = document.getElementById('fecha-fornecedor-select')?.value;
  const semestre = document.getElementById('fecha-semestre-input')?.value.trim();
  const texto = document.getElementById('fecha-textarea')?.value || '';

  if (!fornecedorId) return showToast('Selecione o fornecedor.', 'error');
  if (!semestre) return showToast('Informe o semestre.', 'error');

  const itens = parseLinhasOrcamento(texto);
  if (!itens.length) return showToast('Cole os itens do orçamento (1 por linha).', 'error');

  const btn = document.getElementById('btn-buscar-candidatos');
  btn.disabled = true;
  btn.textContent = 'Buscando...';
  try {
    const resp = await apiFetch('/financeiro/fechamento/candidatos', {
      method: 'POST',
      body: JSON.stringify({ itens, fornecedorId, semestre })
    });
    fechaCandidatos = resp.itens;
    renderRevisaoFechamento();
    document.getElementById('fecha-revisao-card').classList.remove('hidden');
  } catch (err) {
    showToast('Erro ao buscar candidatos: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar correspondências no sistema';
  }
}

function renderRevisaoFechamento() {
  const tbody = document.getElementById('fecha-tbody');
  tbody.innerHTML = fechaCandidatos.map((item, idx) => {
    const semCorrespondencia = !item.candidatos.length;
    const melhorScore = semCorrespondencia ? 0 : item.candidatos[0].score;
    // Valor zerado geralmente é linha do orçamento que não tinha os 4 campos
    // completos (produto;quantidade;valor unitário;valor total) — já
    // aconteceu de passar batido e fechar item com R$0,00 sem ninguém notar,
    // porque só o nome não-exato era avisado. Trata como "precisa atenção"
    // igual ao match ruim, e nunca marca sozinho.
    const valorZerado = !(item.valorTotal > 0);
    // Só marca automático quando o nome bate EXATO (score 1.0) e o valor não
    // é zero — um caso real já mostrou que marcar tudo acima de 0.5 sozinho
    // deixa passar item errado sem ninguém perceber. Tudo que não é exato
    // fica sem marcar e destacado, pra obrigar a conferência manual antes de
    // fechar.
    const marcarPorPadrao = melhorScore === 1 && !valorZerado;
    const precisaAtencao = (!semCorrespondencia && melhorScore < 1) || valorZerado;
    return `
    <tr class="${precisaAtencao ? 'linha-fechamento-atencao' : ''}">
      <td><input type="checkbox" class="fecha-item-check" data-idx="${idx}" ${marcarPorPadrao ? 'checked' : ''} ${semCorrespondencia ? 'disabled' : ''}></td>
      <td>${esc(item.produto)}</td>
      <td>${item.quantidade} — ${fmtMoeda(item.valorTotal)}</td>
      <td>
        ${valorZerado ? '<div class="fechamento-aviso">⚠️ Valor R$0,00 — confira o orçamento colado, falta produto;quantidade;unitário;total</div>' : ''}
        ${!valorZerado && precisaAtencao ? '<div class="fechamento-aviso">⚠️ Confira — não é match exato</div>' : ''}
        <select class="select-filter fecha-candidato-select" data-idx="${idx}" style="min-width:280px;" ${semCorrespondencia ? 'disabled' : ''}>
          ${semCorrespondencia ? '<option value="">Nenhuma correspondência encontrada</option>' : ''}
          <option value="">— nenhuma dessas, deixar de fora —</option>
          ${item.candidatos.map((c, i) => `<option value="${c.id}" ${i === 0 ? 'selected' : ''}>${esc(c.produto)} — ${esc(c.curso)} (${Math.round(c.score * 100)}%)</option>`).join('')}
        </select>
      </td>
      <td>${semCorrespondencia ? '—' : (item.candidatos[0].temCotacaoDesteFornecedor ? 'Sim' : 'Não')}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.fecha-item-check, .fecha-candidato-select').forEach(el => {
    el.addEventListener('change', atualizarResumoFechamento);
  });
  atualizarResumoFechamento();
}

function atualizarResumoFechamento() {
  const marcados = [...document.querySelectorAll('.fecha-item-check')]
    .filter(chk => chk.checked && document.querySelector(`.fecha-candidato-select[data-idx="${chk.dataset.idx}"]`)?.value);
  document.getElementById('fecha-resumo-selecionados').textContent =
    `${marcados.length} ${marcados.length === 1 ? 'item selecionado' : 'itens selecionados'} pra fechar`;
}

async function confirmarFechamento() {
  const fornecedorId = document.getElementById('fecha-fornecedor-select')?.value;
  const linhas = [...document.querySelectorAll('.fecha-item-check')].filter(chk => chk.checked);

  const fechamentos = linhas.map(chk => {
    const idx = chk.dataset.idx;
    const select = document.querySelector(`.fecha-candidato-select[data-idx="${idx}"]`);
    const itemId = select?.value;
    if (!itemId) return null;
    const item = fechaCandidatos[idx];
    return { itemId, valorUnitario: item.valorUnitario, valorTotal: item.valorTotal };
  }).filter(Boolean);

  if (!fechamentos.length) return showToast('Marque pelo menos 1 item pra fechar.', 'error');
  if (!confirm(`Fechar ${fechamentos.length} ite${fechamentos.length === 1 ? 'm' : 'ns'} com essa empresa? Isso substitui a cotação dela nesses itens pelo valor final negociado.`)) return;

  const btn = document.getElementById('btn-confirmar-fechamento');
  btn.disabled = true;
  btn.textContent = 'Fechando...';
  try {
    const resp = await apiFetch('/financeiro/fechamento/confirmar', {
      method: 'POST',
      body: JSON.stringify({ fornecedorId, fechamentos })
    });
    showToast(resp.message);
    document.getElementById('fecha-revisao-card').classList.add('hidden');
    document.getElementById('fecha-textarea').value = '';
    fechaCandidatos = [];
    // Atualiza na hora as duas listas de baixo — assim, conforme ela vai
    // lançando cada empresa, dá pra ver ao vivo o que já saiu da lista do
    // que falta comprar e o que já está fechado com essa empresa.
    await Promise.all([carregarPendentesFechamento(), carregarFechadosFechamento(), carregarFechadosGeral()]);
  } catch (err) {
    showToast('Erro ao confirmar fechamento: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar fechamento';
  }
}

// Fecha vários itens de uma vez aplicando UM desconto sobre a cotação que a
// empresa já tinha lançado em cada um — pra quando ela manda "essa cotação,
// com X% de desconto", sem precisar redigitar valor item por item.
let itensDescontoAtuais = [];

async function carregarItensDesconto() {
  const fornecedorId = document.getElementById('fecha-fornecedor-select')?.value;
  const semestre = document.getElementById('fecha-semestre-input')?.value.trim();
  const container = document.getElementById('fecha-desconto-lista');
  const calculadora = document.getElementById('fecha-desconto-calculadora');
  calculadora.classList.add('hidden');
  itensDescontoAtuais = [];

  if (!fornecedorId) { container.innerHTML = '<p class="tabela-msg">Selecione a empresa acima primeiro.</p>'; return; }
  if (!semestre) { container.innerHTML = '<p class="tabela-msg">Informe o semestre acima primeiro.</p>'; return; }

  const cursoId = document.getElementById('fecha-desconto-curso-select')?.value || '';
  container.innerHTML = '<p class="tabela-msg">Carregando...</p>';
  try {
    const qs = new URLSearchParams({ semestre });
    if (cursoId) qs.set('cursoId', cursoId);
    const resp = await apiFetch(`/financeiro/relatorio?${qs.toString()}`);
    const todosItens = resp.comparativo?.itens || [];
    itensDescontoAtuais = todosItens
      .filter(i => i.status !== 'fechado' && i.valoresPorFornecedor[fornecedorId] !== undefined)
      .map(i => ({
        itemId: i.itemId, curso: i.curso, produto: i.produto, quantidade: i.quantidade, unidade: i.unidade,
        valorTotal: i.valoresPorFornecedor[fornecedorId]
      }))
      .sort((a, b) => a.curso.localeCompare(b.curso) || a.produto.localeCompare(b.produto));

    if (!itensDescontoAtuais.length) {
      container.innerHTML = '<p class="tabela-msg">Essa empresa não tem cotação em nenhum item em aberto nesse filtro.</p>';
      return;
    }

    renderItensDesconto();
    calculadora.classList.remove('hidden');
  } catch (err) {
    container.innerHTML = `<p class="tabela-msg">Erro: ${esc(err.message)}</p>`;
  }
}

function renderItensDesconto() {
  const container = document.getElementById('fecha-desconto-lista');
  container.innerHTML = `
    <div class="tabela-wrap tabela-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:2rem;"><input type="checkbox" id="fecha-desconto-marcar-todos" checked></th>
            <th>Curso</th>
            <th>Produto</th>
            <th>Qtd/Und</th>
            <th>Valor cotado</th>
          </tr>
        </thead>
        <tbody>
          ${itensDescontoAtuais.map(i => `
            <tr>
              <td><input type="checkbox" class="fecha-desconto-item-check" data-item-id="${i.itemId}" checked></td>
              <td>${esc(i.curso)}</td>
              <td>${esc(i.produto)}</td>
              <td>${i.quantidade}${i.unidade ? ' ' + esc(i.unidade) : ''}</td>
              <td>${fmtMoeda(i.valorTotal)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  document.getElementById('fecha-desconto-marcar-todos')?.addEventListener('change', (e) => {
    container.querySelectorAll('.fecha-desconto-item-check').forEach(chk => { chk.checked = e.target.checked; });
    atualizarCalculadoraDesconto();
  });
  container.querySelectorAll('.fecha-desconto-item-check').forEach(chk => chk.addEventListener('change', atualizarCalculadoraDesconto));

  atualizarCalculadoraDesconto();
}

function itensDescontoSelecionados() {
  const idsMarcados = new Set([...document.querySelectorAll('.fecha-desconto-item-check')].filter(c => c.checked).map(c => c.dataset.itemId));
  return itensDescontoAtuais.filter(i => idsMarcados.has(i.itemId));
}

function atualizarCalculadoraDesconto() {
  const selecionados = itensDescontoSelecionados();
  const totalOriginal = selecionados.reduce((s, i) => s + (i.valorTotal || 0), 0);
  const tipo = document.getElementById('fecha-desconto-tipo')?.value || 'percentual';
  const valorDesconto = parseFloat(document.getElementById('fecha-desconto-valor')?.value) || 0;
  const totalDesconto = tipo === 'percentual' ? totalOriginal * (valorDesconto / 100) : Math.min(valorDesconto, totalOriginal);
  const totalFinal = totalOriginal - totalDesconto;

  document.getElementById('fecha-desconto-selecionados').textContent =
    `${selecionados.length} ${selecionados.length === 1 ? 'item selecionado' : 'itens selecionados'}`;
  document.getElementById('fecha-desconto-total-original').textContent = fmtMoeda(totalOriginal);
  document.getElementById('fecha-desconto-total-final').textContent = fmtMoeda(totalFinal);
  document.getElementById('fecha-desconto-total-economia').textContent = fmtMoeda(totalDesconto);
}

async function confirmarFechamentoComDesconto() {
  const fornecedorId = document.getElementById('fecha-fornecedor-select')?.value;
  const selecionados = itensDescontoSelecionados();
  if (!selecionados.length) return showToast('Marque pelo menos 1 item pra fechar.', 'error');

  const tipo = document.getElementById('fecha-desconto-tipo')?.value || 'percentual';
  const valorDesconto = parseFloat(document.getElementById('fecha-desconto-valor')?.value) || 0;
  const descricaoDesconto = tipo === 'percentual' ? `${valorDesconto}% de desconto` : `${fmtMoeda(valorDesconto)} de desconto no total`;
  if (!confirm(`Fechar ${selecionados.length} ite${selecionados.length === 1 ? 'm' : 'ns'} com essa empresa aplicando ${descricaoDesconto}?`)) return;

  const btn = document.getElementById('btn-confirmar-fechamento-desconto');
  btn.disabled = true;
  btn.textContent = 'Fechando...';
  try {
    const resp = await apiFetch('/financeiro/fechamento/confirmar-com-desconto', {
      method: 'POST',
      body: JSON.stringify({
        fornecedorId,
        itemIds: selecionados.map(i => i.itemId),
        desconto: { tipo, valor: valorDesconto }
      })
    });
    showToast(resp.message);
    document.getElementById('fecha-desconto-calculadora').classList.add('hidden');
    document.getElementById('fecha-desconto-lista').innerHTML =
      '<p class="tabela-msg">Selecione a empresa e o semestre acima e clique em "Ver itens cotados por essa empresa".</p>';
    itensDescontoAtuais = [];
    await Promise.all([carregarPendentesFechamento(), carregarFechadosFechamento(), carregarFechadosGeral()]);
  } catch (err) {
    showToast('Erro ao confirmar fechamento: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar fechamento com desconto';
  }
}

// Guarda o agrupamento por empresa da última busca, só em memória — a
// pessoa escolhe a empresa no seletor e a gente monta a tabela na hora, sem
// precisar buscar de novo no Firestore a cada troca (ver
// feedback_economizar_leituras_firestore).
const SEM_COTACAO_KEY = '__sem_cotacao__';
let pendentesFechamentoPorEmpresa = {};

async function carregarPendentesFechamento() {
  const semestre = document.getElementById('fecha-semestre-input')?.value.trim();
  const container = document.getElementById('fecha-pendentes-lista');
  const empresaBar = document.getElementById('fecha-pendentes-empresa-bar');
  const empresaSelect = document.getElementById('fecha-pendentes-empresa-select');
  empresaBar.classList.add('hidden');
  empresaSelect.innerHTML = '<option value="">Selecione a empresa...</option>';
  pendentesFechamentoPorEmpresa = {};

  if (!semestre) {
    container.innerHTML = '<p class="tabela-msg">Informe o semestre no campo acima primeiro.</p>';
    return;
  }
  const cursoId = document.getElementById('fecha-pendentes-curso-select')?.value || '';
  container.innerHTML = '<p class="tabela-msg">Carregando...</p>';
  try {
    const qs = new URLSearchParams({ semestre });
    if (cursoId) qs.set('cursoId', cursoId);
    const pendentes = await apiFetch(`/financeiro/fechamento/pendentes?${qs.toString()}`);

    if (!pendentes.length) {
      container.innerHTML = '<p class="tabela-msg">Tudo fechado — nenhum item pendente nesse filtro.</p>';
      return;
    }

    // Agrupa por empresa mais barata — a pessoa escolhe qual empresa ligar
    // no seletor abaixo, em vez de já jogar tudo na tela de uma vez.
    pendentesFechamentoPorEmpresa[SEM_COTACAO_KEY] = [];
    pendentes.forEach(p => {
      const chave = p.vencedorNome || SEM_COTACAO_KEY;
      if (!pendentesFechamentoPorEmpresa[chave]) pendentesFechamentoPorEmpresa[chave] = [];
      pendentesFechamentoPorEmpresa[chave].push(p);
    });

    const semCotacao = pendentesFechamentoPorEmpresa[SEM_COTACAO_KEY];
    const opcoesEmpresas = Object.keys(pendentesFechamentoPorEmpresa)
      .filter(k => k !== SEM_COTACAO_KEY)
      .sort((a, b) => a.localeCompare(b))
      .map(empresa => `<option value="${esc(empresa)}">${esc(empresa)} (${pendentesFechamentoPorEmpresa[empresa].length})</option>`)
      .join('');
    const opcaoSemCotacao = semCotacao.length
      ? `<option value="${SEM_COTACAO_KEY}">Sem cotação lançada ainda (${semCotacao.length})</option>` : '';

    empresaSelect.innerHTML = '<option value="">Selecione a empresa...</option>' + opcoesEmpresas + opcaoSemCotacao;
    empresaBar.classList.remove('hidden');
    container.innerHTML = '<p class="tabela-msg">Selecione a empresa acima pra ver a lista dela.</p>';
  } catch (err) {
    container.innerHTML = `<p class="tabela-msg">Erro: ${esc(err.message)}</p>`;
  }
}

// Renderiza só a empresa escolhida no seletor — usa o que já foi buscado em
// carregarPendentesFechamento, sem nova leitura no Firestore.
function renderPendentesEmpresaSelecionada() {
  const container = document.getElementById('fecha-pendentes-lista');
  const chave = document.getElementById('fecha-pendentes-empresa-select')?.value;
  if (!chave) {
    container.innerHTML = '<p class="tabela-msg">Selecione a empresa acima pra ver a lista dela.</p>';
    return;
  }
  const itens = pendentesFechamentoPorEmpresa[chave] || [];
  const ehSemCotacao = chave === SEM_COTACAO_KEY;
  const total = itens.reduce((s, p) => s + (p.vencedorValor || 0), 0);

  container.innerHTML = `
    <div class="card">
      <div class="fornecedor-detalhe-header">
        <h4 class="card-secao-titulo" style="font-size:1rem;">${ehSemCotacao ? 'Sem cotação lançada ainda' : esc(chave) + ' — ligar'} (${itens.length} ${itens.length === 1 ? 'item' : 'itens'})</h4>
        ${ehSemCotacao ? '' : `<span>${fmtMoeda(total)}</span>`}
      </div>
      <div class="tabela-wrap">
        <table class="data-table">
          <thead><tr><th>Curso</th><th>Produto</th><th>Qtd/Und</th>${ehSemCotacao ? '' : '<th>Valor</th>'}</tr></thead>
          <tbody>
            ${itens.map(p => `
              <tr>
                <td>${esc(p.curso)}</td>
                <td>${esc(p.produto)}</td>
                <td>${p.quantidade}${p.unidade ? ' ' + esc(p.unidade) : ''}</td>
                ${ehSemCotacao ? '' : `<td>${fmtMoeda(p.vencedorValor)}</td>`}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// Lista o que já foi fechado com a empresa selecionada, pra conferir contra
// o orçamento que ela mandou antes de confiar no resultado.
let fechaFechadosAtuais = [];
let fechaFechadosEditandoId = null;

async function carregarFechadosFechamento() {
  const fornecedorId = document.getElementById('fecha-fornecedor-select')?.value;
  const semestre = document.getElementById('fecha-semestre-input')?.value.trim();
  const tbody = document.getElementById('fecha-fechados-tbody');
  if (!fornecedorId || !semestre) {
    showToast('Selecione a empresa e o semestre.', 'error');
    return;
  }
  tbody.innerHTML = '<tr><td colspan="4" class="tabela-msg">Carregando...</td></tr>';
  try {
    const qs = new URLSearchParams({ fornecedorId, semestre });
    const resp = await apiFetch(`/financeiro/fechamento/fechados?${qs.toString()}`);
    fechaFechadosAtuais = resp.itens;
    fechaFechadosEditandoId = null;
    renderFechadosFechamento();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}

function renderFechadosFechamento() {
  const tbody = document.getElementById('fecha-fechados-tbody');
  tbody.innerHTML = fechaFechadosAtuais.length ? fechaFechadosAtuais.map(it => {
    const editando = fechaFechadosEditandoId === it.id;
    return `
      <tr class="${it.pendenciaValorFechamento ? 'linha-fechamento-atencao' : ''}">
        <td>${esc(it.curso)}</td>
        <td>
          ${esc(it.produto)}
          ${it.pendenciaValorFechamento ? `<div class="fechamento-aviso">⚠️ ${esc(it.pendenciaValorFechamento)}</div>` : ''}
        </td>
        <td>${it.quantidade}${it.unidade ? ' ' + esc(it.unidade) : ''}</td>
        <td>
          ${editando ? `
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <input type="number" step="0.01" min="0" class="select-filter fecha-valor-input" data-id="${it.id}" value="${it.valorUnitario ?? ''}" placeholder="Valor unitário" style="width:110px; min-width:0; padding:0.4rem 0.6rem;">
              <button type="button" class="btn-primary btn-salvar-valor-fechado" data-id="${it.id}" style="padding:0.4rem 0.7rem;">Salvar</button>
              <button type="button" class="btn-secondary btn-cancelar-valor-fechado" style="padding:0.4rem 0.7rem;">Cancelar</button>
            </div>` : `
            <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
              <div>
                ${fmtMoeda(it.valorFechado)}
                ${it.percentualDescontoFechamento ? `<div style="font-size:0.78rem; color:var(--text-secondary);">Original ${fmtMoeda(it.valorOriginalAntesDoDesconto)} (-${it.percentualDescontoFechamento}%)</div>` : ''}
              </div>
              <button type="button" class="btn-secondary btn-editar-valor-fechado" data-id="${it.id}" style="padding:0.3rem 0.6rem;">Editar</button>
              <button type="button" class="btn-secondary btn-remover-item-fechado" data-id="${it.id}" data-produto="${esc(it.produto)}" style="padding:0.3rem 0.6rem;">Remover</button>
            </div>`}
        </td>
      </tr>`;
  }).join('') : '<tr><td colspan="4" class="tabela-msg">Nenhum item fechado com essa empresa ainda.</td></tr>';

  document.getElementById('fecha-fechados-total').textContent =
    `${fechaFechadosAtuais.length} itens — total fechado: ${fmtMoeda(fechaFechadosAtuais.reduce((s, it) => s + (it.valorFechado || 0), 0))}`;

  tbody.querySelectorAll('.btn-editar-valor-fechado').forEach(btn => btn.addEventListener('click', () => {
    fechaFechadosEditandoId = btn.dataset.id;
    renderFechadosFechamento();
  }));
  tbody.querySelectorAll('.btn-cancelar-valor-fechado').forEach(btn => btn.addEventListener('click', () => {
    fechaFechadosEditandoId = null;
    renderFechadosFechamento();
  }));
  tbody.querySelectorAll('.btn-salvar-valor-fechado').forEach(btn => btn.addEventListener('click', () => salvarValorFechado(btn.dataset.id)));
  tbody.querySelectorAll('.btn-remover-item-fechado').forEach(btn => btn.addEventListener('click', () => removerItemFechado(btn.dataset.id, btn.dataset.produto)));
}

// Desfaz o fechamento de UM item só (item entrou errado no lote) — sem
// precisar desfazer tudo da empresa. Restaura o estado de antes do
// fechamento (mesma lógica do "Desfazer todos", só que num item por vez).
async function removerItemFechado(id, produto) {
  if (!confirm(`Remover "${produto}" do fechamento dessa empresa? O item volta a ficar pendente.`)) return;
  try {
    await apiFetch(`/financeiro/fechamento/${id}/reabrir`, { method: 'POST' });
    fechaFechadosAtuais = fechaFechadosAtuais.filter(it => it.id !== id);
    if (fechaFechadosEditandoId === id) fechaFechadosEditandoId = null;
    renderFechadosFechamento();
    showToast('Item removido do fechamento.');
  } catch (err) {
    showToast('Erro ao remover item: ' + err.message, 'error');
  }
}

async function salvarValorFechado(id) {
  const input = document.querySelector(`.fecha-valor-input[data-id="${id}"]`);
  const valorUnitario = parseFloat(input.value);
  if (isNaN(valorUnitario) || valorUnitario < 0) return showToast('Informe um valor unitário válido.', 'error');

  try {
    const resp = await apiFetch(`/financeiro/fechamento/${id}/valor`, {
      method: 'PUT',
      body: JSON.stringify({ valorUnitario })
    });
    const item = fechaFechadosAtuais.find(it => it.id === id);
    if (item) {
      item.valorUnitario = valorUnitario;
      item.valorFechado = resp.valorFechado;
      item.pendenciaValorFechamento = null;
    }
    fechaFechadosEditandoId = null;
    renderFechadosFechamento();
    showToast('Valor atualizado.');
  } catch (err) {
    showToast('Erro ao atualizar valor: ' + err.message, 'error');
  }
}

// Relatório geral: tudo que já foi fechado no semestre, com QUALQUER
// empresa — pra ter uma visão completa do que já está decidido, não só de
// uma empresa por vez.
async function carregarFechadosGeral() {
  const semestre = document.getElementById('fecha-semestre-input')?.value.trim();
  const resumoDiv = document.getElementById('fecha-geral-resumo');
  if (!semestre) {
    showToast('Informe o semestre no campo acima primeiro.', 'error');
    return;
  }
  const cursoId = document.getElementById('fecha-geral-curso-select')?.value || '';
  resumoDiv.innerHTML = '<p class="tabela-msg">Carregando...</p>';
  document.getElementById('fecha-geral-total').textContent = '—';
  try {
    const qs = new URLSearchParams({ semestre });
    if (cursoId) qs.set('cursoId', cursoId);
    const resp = await apiFetch(`/financeiro/fechamento/fechados-geral?${qs.toString()}`);

    resumoDiv.innerHTML = resp.resumoPorFornecedor.length ? resp.resumoPorFornecedor.map(r => `
      <div class="kpi-card" style="min-width:180px;">
        <div class="kpi-label">${esc(r.fornecedor)}</div>
        <div class="kpi-value" style="font-size:1.1rem;">${r.itens} itens — ${fmtMoeda(r.total)}</div>
      </div>`).join('') : '<p class="tabela-msg">Nenhum item fechado ainda nesse filtro.</p>';

    const totalItens = resp.resumoPorFornecedor.reduce((s, r) => s + r.itens, 0);
    document.getElementById('fecha-geral-total').textContent =
      `${totalItens} itens fechados no total — ${fmtMoeda(resp.totalGeral)}`;
  } catch (err) {
    resumoDiv.innerHTML = `<p class="tabela-msg">Erro: ${esc(err.message)}</p>`;
  }
}

// Desfaz de uma vez todos os fechamentos dessa empresa nesse semestre — pra
// corrigir rápido um lote que saiu errado (sem precisar item por item).
async function desfazerLoteFechamento() {
  const fornecedorId = document.getElementById('fecha-fornecedor-select')?.value;
  const semestre = document.getElementById('fecha-semestre-input')?.value.trim();
  if (!fornecedorId || !semestre) {
    showToast('Selecione a empresa e o semestre.', 'error');
    return;
  }
  const nomeEmpresa = fornecedores.find(f => f.id === fornecedorId)?.nome || '';
  if (!confirm(`Desfazer TODOS os fechamentos de "${nomeEmpresa}" nesse semestre? Cada item volta pro estado de antes do fechamento dele.`)) return;

  const btn = document.getElementById('btn-desfazer-lote');
  btn.disabled = true;
  btn.textContent = 'Desfazendo...';
  try {
    const resp = await apiFetch('/financeiro/fechamento/reabrir-lote', {
      method: 'POST',
      body: JSON.stringify({ fornecedorId, semestre })
    });
    showToast(resp.message);
    await carregarFechadosFechamento();
  } catch (err) {
    showToast('Erro ao desfazer: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Desfazer todos os fechamentos dessa empresa';
  }
}

// ==========================================
// TELA DE ENTREGAS (entregas.html)
// ==========================================
// Acompanhamento do que já foi comprado (item com status "fechado"): prazo
// previsto e baixa de recebimento. Separado do fluxo de negociação de
// propósito — aqui só interessa o que já foi decidido/comprado.
async function initPaginaEntregas() {
  await carregarFornecedores();
  const selectFornecedor = document.getElementById('entregas-fornecedor-select');
  if (selectFornecedor) {
    selectFornecedor.innerHTML = '<option value="">Todas as empresas</option>' +
      fornecedores.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('');
  }

  await carregarCursos();
  const selectCurso = document.getElementById('entregas-curso-select');
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursos.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }

  const semestreInput = document.getElementById('entregas-semestre-input');
  if (semestreInput) {
    try {
      const { semestreAtivoCoordenador } = await apiFetch('/financeiro/config');
      if (semestreAtivoCoordenador) semestreInput.value = semestreAtivoCoordenador;
    } catch (err) {
      // Sem semestre ativo configurado ainda — deixa em branco, sem travar a tela.
    }
  }

  document.getElementById('btn-ver-entregas')?.addEventListener('click', carregarEntregas);
  document.getElementById('entregas-status-select')?.addEventListener('change', renderEntregas);
}

let entregasAtuais = [];
let entregasTruncado = false;

async function carregarEntregas() {
  const semestre = document.getElementById('entregas-semestre-input')?.value.trim();
  const container = document.getElementById('entregas-lista');
  const resumo = document.getElementById('entregas-resumo');
  if (!semestre) { container.innerHTML = '<p class="tabela-msg">Informe o semestre primeiro.</p>'; return; }

  const fornecedorId = document.getElementById('entregas-fornecedor-select')?.value || '';
  const cursoId = document.getElementById('entregas-curso-select')?.value || '';
  container.innerHTML = '<p class="tabela-msg">Carregando...</p>';
  resumo.innerHTML = '';
  try {
    const qs = new URLSearchParams({ semestre });
    if (fornecedorId) qs.set('fornecedorId', fornecedorId);
    if (cursoId) qs.set('cursoId', cursoId);
    const resp = await apiFetch(`/financeiro/entregas?${qs.toString()}`);
    entregasAtuais = resp.itens;
    entregasTruncado = !!resp.truncado;
    renderEntregas();
  } catch (err) {
    container.innerHTML = `<p class="tabela-msg">Erro: ${esc(err.message)}</p>`;
  }
}

function statusEntregaDoItem(it) {
  if (it.recebidoEm) {
    // "Em troca" = chegou com problema e a troca ainda não voltou resolvida.
    // Continua em aberto de propósito, não conta como "recebido" de verdade
    // até fechar o ciclo (padrão de recebimento + RMA separado).
    if (it.statusRecebimento === 'problema' && !it.trocaResolvidaEm) return 'em_troca';
    return 'recebido';
  }
  if (it.prazoEntrega && it.prazoEntrega < new Date().toISOString().slice(0, 10)) return 'atrasado';
  return 'aguardando';
}

let chartEntregasStatus = null;

function renderEntregas() {
  const container = document.getElementById('entregas-lista');
  const resumo = document.getElementById('entregas-resumo');
  const resumoWrap = document.getElementById('entregas-resumo-wrap');

  if (!entregasAtuais.length) {
    container.innerHTML = '<p class="tabela-msg">Nenhum item fechado nesse filtro.</p>';
    resumo.innerHTML = '';
    resumoWrap.classList.add('hidden');
    return;
  }
  resumoWrap.classList.remove('hidden');

  const totalAguardando = entregasAtuais.filter(it => statusEntregaDoItem(it) === 'aguardando').length;
  const totalAtrasado = entregasAtuais.filter(it => statusEntregaDoItem(it) === 'atrasado').length;
  const totalEmTroca = entregasAtuais.filter(it => statusEntregaDoItem(it) === 'em_troca').length;
  const totalRecebido = entregasAtuais.filter(it => statusEntregaDoItem(it) === 'recebido').length;
  resumo.innerHTML = `
    <div class="kpi-card" style="min-width:150px;"><div class="kpi-label">Aguardando</div><div class="kpi-value" style="font-size:1.1rem;">${totalAguardando}</div></div>
    <div class="kpi-card" style="min-width:150px;"><div class="kpi-label">Atrasado</div><div class="kpi-value" style="font-size:1.1rem; color:var(--red);">${totalAtrasado}</div></div>
    <div class="kpi-card" style="min-width:150px;"><div class="kpi-label">Em troca</div><div class="kpi-value" style="font-size:1.1rem; color:var(--accent-orange);">${totalEmTroca}</div></div>
    <div class="kpi-card" style="min-width:150px;"><div class="kpi-label">Recebido</div><div class="kpi-value" style="font-size:1.1rem; color:var(--green);">${totalRecebido}</div></div>
    ${entregasTruncado ? `<div class="fechamento-aviso" style="align-self:center;">⚠️ Mais de ${entregasAtuais.length} itens nesse filtro — mostrando só os ${entregasAtuais.length} primeiros. Filtre por empresa ou curso pra ver o restante.</div>` : ''}`;

  const totalGeralEntregas = totalAguardando + totalAtrasado + totalEmTroca + totalRecebido;
  if (chartEntregasStatus) chartEntregasStatus.destroy();
  chartEntregasStatus = new Chart(document.getElementById('chart-entregas-status'), {
    type: 'doughnut',
    data: {
      labels: ['Aguardando', 'Atrasado', 'Em troca', 'Recebido'],
      datasets: [{ data: [totalAguardando, totalAtrasado, totalEmTroca, totalRecebido], backgroundColor: ['#F59E0B', '#EF4444', '#EB7025', '#10B981'] }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            font: { size: 14 },
            padding: 16,
            // Mostra a quantidade e o % junto do nome — só a cor não deixa
            // claro o suficiente qual fatia é qual nem o peso de cada uma.
            generateLabels: (chart) => chart.data.labels.map((label, i) => {
              const valor = chart.data.datasets[0].data[i];
              const pct = totalGeralEntregas ? Math.round((valor / totalGeralEntregas) * 100) : 0;
              return {
                text: `${label}: ${valor} (${pct}%)`,
                fillStyle: chart.data.datasets[0].backgroundColor[i],
                index: i
              };
            })
          }
        },
        tooltip: { bodyFont: { size: 14 } }
      }
    }
  });

  const filtroStatus = document.getElementById('entregas-status-select')?.value || '';
  const itensFiltrados = filtroStatus ? entregasAtuais.filter(it => statusEntregaDoItem(it) === filtroStatus) : entregasAtuais;

  if (!itensFiltrados.length) {
    container.innerHTML = '<p class="tabela-msg">Nenhum item com esse status de entrega.</p>';
    return;
  }

  // Agrupa por empresa e, dentro dela, por produto — o mesmo produto cotado
  // por vários cursos costuma virar 1 compra física só, então junta num
  // grupo só (1 prazo, 1 baixa pro grupo inteiro).
  const porEmpresa = {};
  itensFiltrados.forEach(it => {
    const empresa = it.fornecedorFechadoNome || '—';
    const chaveProduto = (it.produto || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!porEmpresa[empresa]) porEmpresa[empresa] = {};
    if (!porEmpresa[empresa][chaveProduto]) porEmpresa[empresa][chaveProduto] = [];
    porEmpresa[empresa][chaveProduto].push(it);
  });

  container.innerHTML = Object.keys(porEmpresa).sort((a, b) => a.localeCompare(b)).map(empresa => {
    const grupos = Object.values(porEmpresa[empresa]).sort((a, b) => a[0].produto.localeCompare(b[0].produto));
    return `
      <div class="card" style="margin-bottom:1rem;">
        <h4 class="card-secao-titulo" style="font-size:1rem;">${esc(empresa)}</h4>
        <div class="tabela-wrap">
          <table class="data-table">
            <thead><tr><th>Produto</th><th>Qtd total</th><th>Valor total</th><th>Prazo</th><th>Status</th><th>Ação</th></tr></thead>
            <tbody>${grupos.map(renderLinhaGrupoEntrega).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  wireAcoesEntrega();
}

// itemIds (chave "id1,id2,...") do grupo que está com o formulário de
// "dar baixa" aberto no momento — só um por vez, guardado em memória (não
// precisa de leitura nova, é só estado de tela).
let entregaRecebendoIds = null;

function renderLinhaGrupoEntrega(grupo) {
  const produto = grupo[0].produto;
  const cursos = grupo.map(it => `${it.curso} (${it.quantidade}${it.unidade ? ' ' + it.unidade : ''})`).join(', ');
  const qtdTotal = grupo.reduce((s, it) => s + (it.quantidade || 0), 0);
  const valorTotal = grupo.reduce((s, it) => s + (it.valorFechado || 0), 0);
  const itemIds = grupo.map(it => it.id).join(',');
  const todosComRecebidoEm = grupo.every(it => it.recebidoEm);
  const statusGrupo = !todosComRecebidoEm
    ? (grupo.some(it => statusEntregaDoItem(it) === 'atrasado') ? 'atrasado' : 'aguardando')
    : (grupo.some(it => statusEntregaDoItem(it) === 'em_troca') ? 'em_troca' : 'recebido');
  const prazoAtual = grupo[0].prazoEntrega || '';
  const recebendoAgora = entregaRecebendoIds === itemIds;

  const statusBadge = {
    recebido: '<span class="status-badge status-fechado">Recebido</span>',
    atrasado: '<span class="status-badge" style="background:#fee2e2; color:#dc2626;">Atrasado</span>',
    em_troca: '<span class="status-badge" style="background:#ffedd5; color:#c2410c;">Em troca</span>',
    aguardando: '<span class="status-badge status-pendente">Aguardando</span>'
  }[statusGrupo];

  if (recebendoAgora) {
    return `
      <tr>
        <td colspan="6">
          <div style="display:flex; align-items:flex-end; gap:0.6rem; flex-wrap:wrap; padding:0.5rem 0;">
            <strong>${esc(produto)}</strong>
            <div class="form-group" style="margin:0; flex:1; min-width:220px;">
              <label style="font-size:0.75rem; text-transform:uppercase; font-weight:700; color:var(--text-secondary);">Descrição (opcional) — obrigatória se tiver problema</label>
              <input type="text" class="select-filter entrega-observacao-input" data-ids="${itemIds}" placeholder="Ex.: faltaram 2 unidades, resto ok" style="width:100%; padding:0.5rem 0.7rem;">
            </div>
            <button type="button" class="btn-primary btn-confirmar-baixa" data-ids="${itemIds}" style="padding:0.5rem 0.8rem;">Recebido OK</button>
            <button type="button" class="btn-secondary btn-confirmar-baixa-problema" data-ids="${itemIds}" style="padding:0.5rem 0.8rem; background:#ffedd5; color:#c2410c; border-color:#fed7aa;">Recebido com problema</button>
            <button type="button" class="btn-secondary btn-cancelar-baixa" style="padding:0.5rem 0.8rem;">Cancelar</button>
          </div>
        </td>
      </tr>`;
  }

  return `
    <tr>
      <td title="${esc(cursos)}">${esc(produto)}</td>
      <td>${qtdTotal}${grupo[0].unidade ? ' ' + esc(grupo[0].unidade) : ''}</td>
      <td>${fmtMoeda(valorTotal)}</td>
      <td>
        ${todosComRecebidoEm
          ? (prazoAtual ? new Date(prazoAtual + 'T00:00:00').toLocaleDateString('pt-BR') : '—')
          : `<input type="date" class="select-filter entrega-prazo-input" data-ids="${itemIds}" value="${prazoAtual}" style="padding:0.4rem 0.6rem;">`}
      </td>
      <td>
        ${statusBadge}
        ${todosComRecebidoEm ? `
          <div style="font-size:0.75rem; color:var(--text-secondary);">${esc(grupo[0].recebidoPor || '')} — ${new Date(grupo[0].recebidoEm).toLocaleDateString('pt-BR')}</div>
          ${grupo[0].observacaoRecebimento ? `<div class="fechamento-aviso" style="margin-top:0.2rem;">${esc(grupo[0].observacaoRecebimento)}</div>` : ''}
        ` : ''}
      </td>
      <td style="display:flex; flex-direction:column; gap:0.3rem; align-items:flex-start;">
        ${!todosComRecebidoEm ? `<button type="button" class="btn-primary btn-dar-baixa" data-ids="${itemIds}" style="padding:0.4rem 0.7rem;">Dar baixa</button>` : ''}
        ${statusGrupo === 'em_troca' ? `<button type="button" class="btn-primary btn-resolver-troca" data-ids="${itemIds}" style="padding:0.4rem 0.7rem;">Marcar troca resolvida</button>` : ''}
        ${todosComRecebidoEm ? `<button type="button" class="btn-secondary btn-desfazer-recebimento" data-ids="${itemIds}" style="padding:0.3rem 0.6rem;">Desfazer recebimento</button>` : ''}
      </td>
    </tr>`;
}

function wireAcoesEntrega() {
  const container = document.getElementById('entregas-lista');
  container.querySelectorAll('.entrega-prazo-input').forEach(input => {
    input.addEventListener('change', () => salvarPrazoEntrega(input.dataset.ids.split(','), input.value));
  });
  container.querySelectorAll('.btn-dar-baixa').forEach(btn => {
    btn.addEventListener('click', () => { entregaRecebendoIds = btn.dataset.ids; renderEntregas(); });
  });
  container.querySelectorAll('.btn-cancelar-baixa').forEach(btn => {
    btn.addEventListener('click', () => { entregaRecebendoIds = null; renderEntregas(); });
  });
  container.querySelectorAll('.btn-confirmar-baixa').forEach(btn => {
    btn.addEventListener('click', () => {
      const observacao = document.querySelector(`.entrega-observacao-input[data-ids="${btn.dataset.ids}"]`)?.value || '';
      darBaixaEntrega(btn.dataset.ids.split(','), observacao, 'ok');
    });
  });
  container.querySelectorAll('.btn-confirmar-baixa-problema').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.querySelector(`.entrega-observacao-input[data-ids="${btn.dataset.ids}"]`);
      const observacao = input?.value || '';
      if (!observacao.trim()) { showToast('Descreve o que aconteceu (defeito, faltante...) antes de marcar como problema.', 'error'); input?.focus(); return; }
      darBaixaEntrega(btn.dataset.ids.split(','), observacao, 'problema');
    });
  });
  container.querySelectorAll('.btn-resolver-troca').forEach(btn => {
    btn.addEventListener('click', () => resolverTrocaEntrega(btn.dataset.ids.split(',')));
  });
  container.querySelectorAll('.btn-desfazer-recebimento').forEach(btn => {
    btn.addEventListener('click', () => desfazerRecebimentoEntrega(btn.dataset.ids.split(',')));
  });
}

async function salvarPrazoEntrega(itemIds, prazoEntrega) {
  try {
    await apiFetch('/financeiro/entregas/prazo', { method: 'PUT', body: JSON.stringify({ itemIds, prazoEntrega }) });
    itemIds.forEach(id => {
      const item = entregasAtuais.find(it => it.id === id);
      if (item) item.prazoEntrega = prazoEntrega || null;
    });
    renderEntregas();
    showToast('Prazo atualizado.');
  } catch (err) {
    showToast('Erro ao salvar prazo: ' + err.message, 'error');
  }
}

async function darBaixaEntrega(itemIds, observacao, statusRecebimento) {
  try {
    const resp = await apiFetch('/financeiro/entregas/receber', { method: 'POST', body: JSON.stringify({ itemIds, observacao, statusRecebimento }) });
    itemIds.forEach(id => {
      const item = entregasAtuais.find(it => it.id === id);
      if (item) {
        item.recebidoEm = resp.recebidoEm; item.recebidoPor = resp.recebidoPor;
        item.observacaoRecebimento = resp.observacaoRecebimento || null;
        item.statusRecebimento = resp.statusRecebimento; item.trocaResolvidaEm = null;
      }
    });
    entregaRecebendoIds = null;
    renderEntregas();
    showToast(resp.message);
  } catch (err) {
    showToast('Erro ao dar baixa: ' + err.message, 'error');
  }
}

async function resolverTrocaEntrega(itemIds) {
  if (!confirm('Marcar essa troca como resolvida (a substituição/crédito já voltou do fornecedor)?')) return;
  try {
    const resp = await apiFetch('/financeiro/entregas/resolver-troca', { method: 'POST', body: JSON.stringify({ itemIds }) });
    itemIds.forEach(id => {
      const item = entregasAtuais.find(it => it.id === id);
      if (item) item.trocaResolvidaEm = resp.trocaResolvidaEm;
    });
    renderEntregas();
    showToast(resp.message);
  } catch (err) {
    showToast('Erro ao marcar troca resolvida: ' + err.message, 'error');
  }
}

async function desfazerRecebimentoEntrega(itemIds) {
  if (!confirm('Desfazer o recebimento desse(s) item(ns)?')) return;
  try {
    const resp = await apiFetch('/financeiro/entregas/desfazer-recebimento', { method: 'POST', body: JSON.stringify({ itemIds }) });
    itemIds.forEach(id => {
      const item = entregasAtuais.find(it => it.id === id);
      if (item) { item.recebidoEm = null; item.recebidoPor = null; item.observacaoRecebimento = null; item.statusRecebimento = null; item.trocaResolvidaEm = null; }
    });
    renderEntregas();
    showToast(resp.message);
  } catch (err) {
    showToast('Erro ao desfazer: ' + err.message, 'error');
  }
}
