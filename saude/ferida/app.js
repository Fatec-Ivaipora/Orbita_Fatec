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
let userLevel = 1;
let appInitialized = false;
let initializedRole = null;

// Enfermeira-chefe do ambulatório — só ela (ou o ADM) edita cadastro/atendimento
// já salvos e exclui de fato; os demais só solicitam a exclusão.
const UID_AMANDA = 'yvbrbHvSPFMXyA3nLwB68qjch8A2';
const souAmandaOuAdmin = () => currentUser?.uid === UID_AMANDA || currentRole === 'adm_l1';

// O caminho rápido de auth (getCachedAuth) usa um token salvo em localStorage
// que pode estar vencido — ele não se autorrenova como o objeto real do
// Firebase. apiFetch espera a confirmação real (onAuthStateChanged) antes de
// chamar a API, pra nunca usar um token velho e falhar em silêncio.
let authConfirmado = false;
let resolverAuthConfirmado;
const authConfirmadoPromise = new Promise(res => { resolverAuthConfirmado = res; });

// Estado da ficha
let pacienteAtual = null;
let atendimentos = [];
let fichasAntigas = [];   // metadados das fichas de papel digitalizadas do paciente atual
let fichasPendentes = []; // imagens já comprimidas aguardando o cadastro do novo paciente
let pinCount = 0;
let dirty = false;
let iaImagens = { frente: null, verso: null };
let iaDados = null;
let atendimentoEmEdicaoId = null; // preenchido ao editar um atendimento do histórico (PUT em vez de POST)
let atendimentoDetalheAtual = null; // atendimento atualmente aberto no modal de detalhe do histórico

async function apiFetch(endpoint, options = {}) {
  if (!authConfirmado) await authConfirmadoPromise;
  const token = await currentUser.getIdToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, cache: 'no-store' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro na API: ${res.status}`);
  }
  return res.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  authConfirmado = true;
  resolverAuthConfirmado();
  try {
    const token = await user.getIdToken();
    let role = 'visitante';
    try {
      const userData = await apiFetch('/usuarios/me');
      role = userData.role || 'visitante';
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }

    setCachedAuth(user, role, token);

    // Carregar nível de acesso dinâmico do módulo
    let level = 1;
    if (role === 'adm_l1') {
      level = 3;
    } else {
      try {
        const perms = await apiFetch('/usuarios/config/permissions');
        const rolePerms = perms[role] || {};
        const rawPerm = rolePerms['ferida'];
        level = (rawPerm !== undefined && typeof rawPerm === 'object')
          ? (rawPerm.execute ? 3 : (rawPerm.view ? 2 : 1))
          : (parseInt(rawPerm) || 1);
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }
    userLevel = level;

    // Dado sensível de saúde: sem permissão de visualização, volta pro Meu Espaço
    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    if (level < 3) {
      document.body.classList.add('hide-execute');
    } else {
      document.body.classList.remove('hide-execute');
    }

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      currentRole = role;
      initApp(user, role);
    }
  } catch (err) {
    console.error("Erro na revalidação de auth:", err);
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'ferida', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  // pacientes.html e as telas de relatório reaproveitam este app.js só pra auth/layout + a própria tela
  if (document.getElementById('tabela-pacientes')) {
    initPaginaPacientes();
    return;
  }
  if (document.getElementById('relatorio-conteudo')) {
    initPaginaRelatorio();
    return;
  }
  if (document.getElementById('relatorio-geral-conteudo')) {
    initPaginaRelatorioGeral();
    return;
  }

  setupBodyMap();
  setupChips();
  setupFormListeners();
  setupPacienteModal();
  setupFichasAntigas();
  setupImportacaoIA();
  setupBuscaPacienteFicha();
  setupDetalheAtendimento();
  setupHistoricoModal();

  const idPacienteUrl = new URLSearchParams(window.location.search).get('paciente');
  if (idPacienteUrl) await abrirPacientePorId(idPacienteUrl);
}

// ==========================================
// TELA "PACIENTES" (pacientes.html) — lista com busca no servidor
// ==========================================
let buscaPacienteTimer = null;
let pacientesListaAtual = [];
// "ativos" (padrão) esconde quem já teve alta, sem precisar buscar de novo —
// é só um filtro em cima da lista já carregada.
let filtroStatusAtual = 'ativos';

async function initPaginaPacientes() {
  const input = document.getElementById('busca-paciente');
  try {
    await carregarEnfermeiros();
  } catch (err) { /* segue com a lista vazia se falhar */ }
  buscarEExibirPacientes('');
  input?.addEventListener('input', () => {
    clearTimeout(buscaPacienteTimer);
    buscaPacienteTimer = setTimeout(() => buscarEExibirPacientes(input.value.trim()), 300);
  });
  setupEnfermeirosModal();
  setupDarAltaModal();
  if (souAmandaOuAdmin()) {
    document.getElementById('btn-solicitacoes')?.classList.remove('hidden');
    setupSolicitacoesModal();
    atualizarBadgeSolicitacoes();
  }

  document.getElementById('pac-filtro-status')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.pac-filtro-btn');
    if (!btn) return;
    filtroStatusAtual = btn.dataset.status;
    document.querySelectorAll('.pac-filtro-btn').forEach(b => b.classList.toggle('ativo', b === btn));
    renderTabelaPacientes(pacientesListaAtual);
  });

  document.getElementById('tabela-pacientes')?.addEventListener('click', (e) => {
    const btnExcluir = e.target.closest('.pac-lista-excluir');
    if (btnExcluir) { excluirPacienteDaLista(btnExcluir.dataset.id, btnExcluir.dataset.nome); return; }
    const btnAlta = e.target.closest('.pac-lista-alta-btn');
    if (btnAlta) {
      const novoValor = btnAlta.dataset.novoValor === 'true';
      // Reativar não precisa de data (dataAlta só existe enquanto o
      // paciente está de alta); dar alta abre o modal pra informar quando
      // aconteceu, em vez de assumir "agora" sem perguntar.
      if (novoValor) abrirModalDarAlta(btnAlta.dataset.id);
      else mudarAltaDaLista(btnAlta.dataset.id, false);
      return;
    }
  });

  document.getElementById('tabela-pacientes')?.addEventListener('change', (e) => {
    const sel = e.target.closest('.enf-inline-select');
    if (!sel) return;
    mudarEnfermeiroDaLista(sel.dataset.id, sel.value);
  });
}

// ==========================================
// ENFERMEIROS — lista mantida pelo ADM, usada como padrão no cadastro
// ==========================================
let enfermeirosCache = null;

async function carregarEnfermeiros(forcar = false) {
  if (enfermeirosCache && !forcar) return enfermeirosCache;
  const resp = await apiFetch('/ferida/enfermeiros');
  enfermeirosCache = Array.isArray(resp.nomes) ? resp.nomes : [];
  return enfermeirosCache;
}

function setupEnfermeirosModal() {
  const modal = document.getElementById('modal-enfermeiros');
  const textarea = document.getElementById('enf-lista');
  if (!modal || !textarea) return;

  document.getElementById('btn-gerenciar-enfermeiros')?.addEventListener('click', async () => {
    textarea.value = 'Carregando...';
    modal.classList.remove('hidden');
    try {
      const nomes = await carregarEnfermeiros(true);
      textarea.value = nomes.join('\n');
    } catch (err) {
      textarea.value = '';
      showToast('Erro ao carregar enfermeiros: ' + err.message, 'error');
    }
  });
  document.getElementById('btn-cancelar-enfermeiros')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-salvar-enfermeiros')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-salvar-enfermeiros');
    const nomes = textarea.value.split('\n').map(n => n.trim()).filter(Boolean);
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      const resp = await apiFetch('/ferida/enfermeiros', { method: 'PUT', body: JSON.stringify({ nomes }) });
      enfermeirosCache = resp.nomes;
      modal.classList.add('hidden');
      showToast('Lista de enfermeiros atualizada');
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

// ==========================================
// SOLICITAÇÕES DE EXCLUSÃO — só a enfermeira responsável (ou ADM) vê e decide
// ==========================================

function descreverSolicitacao(s) {
  if (s.tipo === 'excluir_paciente') return `Excluir paciente <b>${esc(s.pacienteNome)}</b> (com todo o histórico)`;
  if (s.tipo === 'excluir_ficha_antiga') return `Excluir ficha antiga "${esc(s.fichaNome)}" de <b>${esc(s.pacienteNome)}</b>`;
  if (s.tipo === 'excluir_atendimento') return `Excluir atendimento de ${s.atendimentoData ? fmtData(s.atendimentoData) : '—'} de <b>${esc(s.pacienteNome)}</b>`;
  return 'Solicitação';
}

async function atualizarBadgeSolicitacoes() {
  const badge = document.getElementById('solicitacoes-badge');
  try {
    const pendentes = await apiFetch('/ferida/solicitacoes?status=pendente');
    if (pendentes.length) {
      badge.textContent = pendentes.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    return pendentes;
  } catch (err) {
    badge.classList.add('hidden');
    return [];
  }
}

function renderListaSolicitacoes(pendentes) {
  const lista = document.getElementById('solicitacoes-lista');
  if (!pendentes.length) {
    lista.innerHTML = '<p class="hint">Nenhuma solicitação pendente.</p>';
    return;
  }
  lista.innerHTML = pendentes.map(s => `
    <div class="solicitacao-item" data-id="${s.id}">
      <div>${descreverSolicitacao(s)}</div>
      <div class="hint">Pedido por ${esc(s.solicitadoPorNome)} em ${new Date(s.solicitadoEm).toLocaleString('pt-BR')}</div>
      <div class="modal-actions">
        <button type="button" class="btn ghost btn-recusar-solicitacao" data-id="${s.id}">Recusar</button>
        <button type="button" class="btn primary btn-aprovar-solicitacao" data-id="${s.id}">Aprovar</button>
      </div>
    </div>`).join('');
}

function setupSolicitacoesModal() {
  const modal = document.getElementById('modal-solicitacoes');
  if (!modal) return;

  document.getElementById('btn-solicitacoes')?.addEventListener('click', async () => {
    document.getElementById('solicitacoes-lista').innerHTML = '<p class="hint">Carregando...</p>';
    modal.classList.remove('hidden');
    const pendentes = await atualizarBadgeSolicitacoes();
    renderListaSolicitacoes(pendentes);
  });
  document.getElementById('btn-fechar-solicitacoes')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('solicitacoes-lista')?.addEventListener('click', async (e) => {
    const aprovar = e.target.closest('.btn-aprovar-solicitacao');
    const recusar = e.target.closest('.btn-recusar-solicitacao');
    const btn = aprovar || recusar;
    if (!btn) return;
    btn.disabled = true;
    try {
      const resp = await apiFetch(`/ferida/solicitacoes/${btn.dataset.id}/${aprovar ? 'aprovar' : 'recusar'}`, { method: 'PUT' });
      showToast(resp.message);
      const pendentes = await atualizarBadgeSolicitacoes();
      renderListaSolicitacoes(pendentes);
      if (aprovar) buscarEExibirPacientes(document.getElementById('busca-paciente')?.value.trim() || '');
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function buscarEExibirPacientes(termo) {
  const tbody = document.getElementById('tabela-pacientes');
  tbody.innerHTML = `<tr><td colspan="8" class="pac-lista-msg">Buscando...</td></tr>`;
  try {
    const qs = termo ? `?busca=${encodeURIComponent(termo)}` : '';
    const lista = await apiFetch(`/ferida/pacientes${qs}`);
    pacientesListaAtual = lista;
    renderTabelaPacientes(lista);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="pac-lista-msg">Erro ao buscar: ${esc(err.message)}</td></tr>`;
  }
}

// Select inline pra trocar o enfermeiro direto na lista, sem abrir a ficha —
// preserva o valor atual mesmo se ele não estiver mais na lista ativa (ex.:
// estagiário que já saiu do rodízio), mesmo padrão do cadastro do paciente.
function montarSelectEnfermeiroInline(id, valorAtual) {
  const alvo = (valorAtual || '').trim();
  const nomes = enfermeirosCache || [];
  let opcoes = '<option value="">Não informado</option>' +
    nomes.map(nome => `<option value="${esc(nome)}"${nome === alvo ? ' selected' : ''}>${esc(nome)}</option>`).join('');
  if (alvo && !nomes.includes(alvo)) {
    opcoes += `<option value="${esc(alvo)}" selected>${esc(alvo)}</option>`;
  }
  return `<select class="enf-inline-select action-execute" data-id="${id}">${opcoes}</select>`;
}

async function mudarEnfermeiroDaLista(id, novoValor) {
  const p = pacientesListaAtual.find(x => x.id === id);
  if (!p) return;
  try {
    await apiFetch(`/ferida/pacientes/${id}/enfermeiro`, {
      method: 'PUT',
      body: JSON.stringify({ enfermeiro: novoValor })
    });
    p.enfermeiro = novoValor;
    showToast('Enfermeiro atualizado');
  } catch (err) {
    showToast('Erro ao atualizar enfermeiro: ' + err.message, 'error');
  }
}

// Dar alta / reativar direto na lista — mesmo padrão do enfermeiro inline,
// sem precisar abrir a ficha inteira pra uma troca operacional simples.
// dataAlta é opcional (só faz sentido quando novaAlta=true) — sem ela o
// backend assume a data de hoje.
async function mudarAltaDaLista(id, novaAlta, dataAlta) {
  const p = pacientesListaAtual.find(x => x.id === id);
  if (!p) return;
  try {
    await apiFetch(`/ferida/pacientes/${id}/alta`, {
      method: 'PUT',
      body: JSON.stringify({ alta: novaAlta, dataAlta: novaAlta ? dataAlta : undefined })
    });
    p.alta = novaAlta;
    p.dataAlta = novaAlta ? dataAlta : null;
    showToast(novaAlta ? 'Paciente recebeu alta.' : 'Paciente reativado.');
    renderTabelaPacientes(pacientesListaAtual);
  } catch (err) {
    showToast('Erro ao atualizar status: ' + err.message, 'error');
  }
}

function abrirModalDarAlta(id) {
  const modal = document.getElementById('modal-dar-alta');
  if (!modal) return;
  document.getElementById('alta-paciente-id').value = id;
  document.getElementById('alta-data-input').value = todayStr();
  modal.classList.remove('hidden');
}

function setupDarAltaModal() {
  const modal = document.getElementById('modal-dar-alta');
  if (!modal) return;

  document.getElementById('btn-cancelar-alta')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-confirmar-alta')?.addEventListener('click', async () => {
    const id = document.getElementById('alta-paciente-id').value;
    const data = document.getElementById('alta-data-input').value;
    if (!data) { showToast('Informe a data da alta.', 'error'); return; }
    await mudarAltaDaLista(id, true, data);
    modal.classList.add('hidden');
  });
}

function renderTabelaPacientes(lista) {
  const tbody = document.getElementById('tabela-pacientes');
  const filtrada = filtroStatusAtual === 'todos' ? lista
    : filtroStatusAtual === 'alta' ? lista.filter(p => p.alta)
    : lista.filter(p => !p.alta);

  if (!filtrada.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="pac-lista-msg">Nenhum paciente encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtrada.map(p => {
    const cadastro = p.createdAt ? new Date(p.createdAt).toLocaleDateString('pt-BR') : '—';
    // dataAlta agora é "AAAA-MM-DD" puro (informado na tela, sem hora) —
    // fmtData() evita o efeito de fuso do new Date() virando um dia pra
    // trás. Pacientes com alta antiga (timestamp ISO completo) ainda caem
    // no new Date(), que continua correto nesse formato.
    const dataAltaTxt = p.dataAlta
      ? (p.dataAlta.includes('T') ? new Date(p.dataAlta).toLocaleDateString('pt-BR') : fmtData(p.dataAlta))
      : '';
    return `
      <tr>
        <td>${esc(p.nome)}</td>
        <td>${esc(p.tipoFerida || '—')}</td>
        <td>${esc(p.municipio || '—')}</td>
        <td>${montarSelectEnfermeiroInline(p.id, p.enfermeiro)}</td>
        <td>
          ${p.alta
            ? `<span class="pac-status-badge alta">Alta${dataAltaTxt ? ' em ' + dataAltaTxt : ''}</span>
               <button type="button" class="pac-lista-alta-btn action-execute" data-id="${p.id}" data-novo-valor="false" title="Reativar paciente">Reativar</button>`
            : `<span class="pac-status-badge ativo">Em atendimento</span>
               <button type="button" class="pac-lista-alta-btn action-execute" data-id="${p.id}" data-novo-valor="true" title="Dar alta">Dar alta</button>`}
        </td>
        <td>${p.atendimentosCount ?? 0}</td>
        <td>${cadastro}</td>
        <td class="pac-lista-acoes">
          <a href="/saude/ferida/index.html?paciente=${p.id}" title="Abrir ficha">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </a>
          <a href="/saude/ferida/relatorio.html?paciente=${p.id}" target="_blank" title="Gerar relatório">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
          </a>
          <button type="button" class="pac-lista-excluir action-execute" data-id="${p.id}" data-nome="${esc(p.nome)}" title="Excluir paciente">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </td>
      </tr>`;
  }).join('');
}

async function excluirPacienteDaLista(id, nome) {
  const pergunta = souAmandaOuAdmin()
    ? `Excluir DEFINITIVAMENTE o paciente "${nome}"?\n\nSerão apagados também todo o histórico de atendimentos e fichas antigas. Essa ação NÃO tem volta.`
    : `Solicitar exclusão definitiva do paciente "${nome}"?\n\nA enfermeira responsável vai receber o pedido e aprovar ou recusar.`;
  if (!confirm(pergunta)) return;
  try {
    const resp = await apiFetch(`/ferida/pacientes/${id}`, { method: 'DELETE' });
    showToast(resp.message);
    buscarEExibirPacientes(document.getElementById('busca-paciente')?.value.trim() || '');
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// TELA "RELATÓRIO" (relatorio.html) — documento imprimível
// ==========================================

async function initPaginaRelatorio() {
  const id = new URLSearchParams(window.location.search).get('paciente');
  const msg = document.getElementById('relatorio-msg');
  const btnImprimir = document.getElementById('btn-imprimir-relatorio');
  btnImprimir.disabled = true;

  if (!id) {
    msg.innerHTML = '<p class="hint" style="margin:0">Nenhum paciente selecionado. Volte pra tela "Pacientes" e use o botão de relatório numa linha.</p>';
    return;
  }

  try {
    const [paciente, atendimentosDoPaciente] = await Promise.all([
      apiFetch(`/ferida/pacientes/${id}`),
      apiFetch(`/ferida/pacientes/${id}/atendimentos`)
    ]);
    // Fichas antigas importadas (ou atendimentos lançados com data retroativa)
    // têm data clínica diferente da data de criação do registro — ordena pela
    // data clínica, mesmo critério já usado na timeline da tela principal.
    atendimentosDoPaciente.sort((a, b) =>
      String(a.dataAtendimento || a.createdAt).localeCompare(String(b.dataAtendimento || b.createdAt)));
    renderRelatorio(paciente, atendimentosDoPaciente);
    msg.classList.add('hidden');
    btnImprimir.disabled = false;
    btnImprimir.addEventListener('click', () => window.print());
  } catch (err) {
    msg.innerHTML = `<p class="hint" style="margin:0">Erro ao carregar relatório: ${esc(err.message)}</p>`;
  }
}

function renderRelatorio(p, atendimentosDoPaciente) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const listaOuTraco = arr => (Array.isArray(arr) && arr.length) ? esc(arr.join(', ')) : '—';

  const blocos = atendimentosDoPaciente.map((at, i) => {
    const quando = at.dataAtendimento ? fmtData(at.dataAtendimento) : new Date(at.createdAt).toLocaleDateString('pt-BR');
    const dims = listaDimensoesPorFerida(at).map(({ rotulo, dimensoes: d }) => {
      const partes = [
        fmtDim(d.comprimento)  && `Compr. ${fmtDim(d.comprimento)} cm`,
        fmtDim(d.largura)      && `Larg. ${fmtDim(d.largura)} cm`,
        fmtDim(d.profundidade) && `Prof. ${fmtDim(d.profundidade)} cm`,
        fmtDim(d.descolamento) && `Descol. ${fmtDim(d.descolamento)} cm`
      ].filter(Boolean).join(' · ') || '—';
      return rotulo ? `${esc(rotulo)}: ${partes}` : partes;
    }).join('<br>') || '—';
    const locais = (at.marcacoes || []).map(m => m.rotulo).filter(Boolean);
    const exs = at.exsudato || {};
    const exsudatoTxt = [exs.tipo, exs.cor, exs.consistencia, exs.quantidade].filter(Boolean).join(' · ') || '—';
    const biofilmeTxt = at.biofilme === true ? 'Sim' : at.biofilme === false ? 'Não' : '—';
    const dorTxt = at.dor?.presente === true
      ? `Sim${at.dor.escala ? ` (${at.dor.escala}/10)` : ''}`
      : at.dor?.presente === false ? 'Não' : '—';
    const enfermeiroTxt = at.enfermeiro || p.enfermeiro || '—';
    const rotuloVisita = i === 0 ? '1º atendimento' : `${i + 1}º retorno`;

    return `
      <div class="rel-atendimento">
        <div class="rel-atendimento-head">
          <b>${esc(quando)}</b>
          <span class="rel-num">${rotuloVisita}</span>
          <span class="rel-autor">por ${esc(at.createdByName || '—')}</span>
        </div>
        <div class="rel-atendimento-grid">
          <div><b>Dimensões:</b> ${dims}</div>
          <div><b>Localização:</b> ${listaOuTraco(locais)}</div>
          <div><b>Enfermeiro(a):</b> ${esc(enfermeiroTxt)}</div>
          <div><b>Tecido:</b> ${listaOuTraco(at.tecido)}</div>
          <div><b>Bordas:</b> ${listaOuTraco(at.bordas)}</div>
          <div><b>Pele adjacente:</b> ${listaOuTraco(at.peleAdjacente)}</div>
          <div><b>Exsudato:</b> ${esc(exsudatoTxt)}</div>
          <div><b>Infecção superficial:</b> ${listaOuTraco(at.infeccaoSuperficial)}</div>
          <div><b>Infecção profunda:</b> ${listaOuTraco(at.infeccaoProfunda)}</div>
          <div><b>Biofilme:</b> ${biofilmeTxt}</div>
          <div><b>Dor:</b> ${dorTxt}</div>
          <div><b>Cobertura(s):</b> ${listaOuTraco(at.cobertura)}</div>
        </div>
        <div class="rel-conduta"><b>Conduta:</b> ${esc(at.conduta || '—')}</div>
      </div>`;
  }).join('');

  document.getElementById('relatorio-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Relatório de Avaliação e Evolução da Ferida</h1>
        <p>Ambulatório · FATEC Ivaiporã</p>
      </div>
      <div class="rel-data-emissao">Emitido em ${hoje}</div>
    </div>
    <div class="rel-paciente">
      <div><span>Paciente</span><b>${esc(p.nome)}</b></div>
      <div><span>Município</span><b>${esc(p.municipio || '—')}</b></div>
      <div><span>Tipo de ferida</span><b>${esc(p.tipoFerida || '—')}</b></div>
    </div>
    <h2 class="rel-secao">Evolução (${atendimentosDoPaciente.length} atendimento${atendimentosDoPaciente.length === 1 ? '' : 's'})</h2>
    ${blocos || '<p class="rel-vazio">Nenhum atendimento registrado ainda.</p>'}
    <div class="rel-assinatura">
      <div class="linha">Enfermeira(o) responsável</div>
    </div>
  `;
}

// ==========================================
// TELA "RELATÓRIO GERAL" (relatorio-geral.html)
// ==========================================

async function initPaginaRelatorioGeral() {
  const msg = document.getElementById('relatorio-msg');
  const opcoes = document.getElementById('relatorio-opcoes');
  const btnImprimir = document.getElementById('btn-imprimir-relatorio');
  btnImprimir.disabled = true;

  try {
    const pacientesTodos = await apiFetch('/ferida/pacientes');
    renderRelatorioGeral(pacientesTodos);

    if (!opcoes) throw new Error('Painel de opções não encontrado na página (#relatorio-opcoes) — provável versão antiga em cache. Dê Ctrl+Shift+R.');

    opcoes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const bloco = document.querySelector(`#relatorio-geral-conteudo [data-secao="${cb.dataset.secao}"]`);
        if (bloco) bloco.classList.toggle('rel-oculto', !cb.checked);
      });
    });

    msg.classList.add('hidden');
    opcoes.classList.remove('hidden');
    btnImprimir.disabled = false;
    btnImprimir.addEventListener('click', () => window.print());
  } catch (err) {
    console.error('Falha ao montar o relatório geral:', err);
    msg.classList.remove('hidden');
    msg.innerHTML = `<p class="hint" style="margin:0; color:#b3453c">Erro ao carregar relatório: ${esc(err.message)}</p>`;
  }
}

function renderRelatorioGeral(pacientesTodos) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const total = pacientesTodos.length;

  const contarPor = (chave, valorPadrao) => {
    const contagem = {};
    pacientesTodos.forEach(p => {
      const v = (p[chave] && String(p[chave]).trim()) || valorPadrao;
      contagem[v] = (contagem[v] || 0) + 1;
    });
    return Object.entries(contagem).sort((a, b) => b[1] - a[1]);
  };

  const linhasTabela = (pares) => pares.map(([nome, n]) => `
    <tr><td>${esc(nome)}</td><td>${n}</td><td>${total ? Math.round(n / total * 100) : 0}%</td></tr>
  `).join('');

  const porTipo = contarPor('tipoFerida', 'Não especificado');
  const porMunicipio = contarPor('municipio', 'Não informado');

  const linhasPacientes = pacientesTodos
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(p => {
      const cadastro = p.createdAt ? new Date(p.createdAt).toLocaleDateString('pt-BR') : '—';
      return `
        <tr>
          <td>${esc(p.nome)}</td>
          <td>${esc(p.tipoFerida || '—')}</td>
          <td>${esc(p.municipio || '—')}</td>
          <td>${cadastro}</td>
        </tr>`;
    }).join('');

  document.getElementById('relatorio-geral-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Relatório Geral de Pacientes</h1>
        <p>Ambulatório · FATEC Ivaiporã</p>
      </div>
      <div class="rel-data-emissao">Emitido em ${hoje}</div>
    </div>

    <div data-secao="resumo" class="rel-resumo">
      <div class="rel-resumo-card"><b>${total}</b><span>Paciente${total === 1 ? '' : 's'} cadastrado${total === 1 ? '' : 's'}</span></div>
      <div class="rel-resumo-card"><b>${porMunicipio.length}</b><span>Município${porMunicipio.length === 1 ? '' : 's'} atendido${porMunicipio.length === 1 ? '' : 's'}</span></div>
    </div>

    <div data-secao="tipo">
      <h2 class="rel-secao">Distribuição por tipo de ferida</h2>
      <table class="rel-tabela">
        <thead><tr><th>Tipo de ferida</th><th>Pacientes</th><th>%</th></tr></thead>
        <tbody>${linhasTabela(porTipo)}</tbody>
      </table>
    </div>

    <div data-secao="municipio">
      <h2 class="rel-secao">Distribuição por município</h2>
      <table class="rel-tabela">
        <thead><tr><th>Município</th><th>Pacientes</th><th>%</th></tr></thead>
        <tbody>${linhasTabela(porMunicipio)}</tbody>
      </table>
    </div>

    <div data-secao="lista">
      <h2 class="rel-secao">Lista de pacientes (${total})</h2>
      <table class="rel-tabela rel-tabela-lista">
        <thead><tr><th>Nome</th><th>Tipo de ferida</th><th>Município</th><th>Cadastrado em</th></tr></thead>
        <tbody>${linhasPacientes || `<tr><td colspan="4" class="rel-vazio">Nenhum paciente cadastrado.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

// ==========================================
// PACIENTES
// ==========================================

// Busca com sugestões (digita o nome, busca no servidor) em vez de
// carregar todos os pacientes de uma vez — mesmo endpoint da tela "Pacientes".
let buscaFichaTimer = null;

function setupBuscaPacienteFicha() {
  const input = document.getElementById('busca-paciente-ficha');
  const caixa = document.getElementById('pac-sugestoes');
  if (!input) return;

  input.addEventListener('input', () => {
    document.getElementById('sel-paciente').value = '';
    if (pacienteAtual) selecionarPaciente(null);

    const termo = input.value.trim();
    clearTimeout(buscaFichaTimer);
    if (termo.length < 2) {
      caixa.classList.add('hidden');
      caixa.innerHTML = '';
      return;
    }
    buscaFichaTimer = setTimeout(() => buscarSugestoesFicha(termo), 250);
  });

  input.addEventListener('focus', () => {
    if (caixa.innerHTML && input.value.trim().length >= 2) caixa.classList.remove('hidden');
  });

  document.addEventListener('click', (e) => {
    if (e.target !== input && !caixa.contains(e.target)) caixa.classList.add('hidden');
  });
}

async function buscarSugestoesFicha(termo) {
  const caixa = document.getElementById('pac-sugestoes');
  try {
    const lista = await apiFetch(`/ferida/pacientes?busca=${encodeURIComponent(termo)}`);
    renderSugestoesFicha(lista);
  } catch (err) {
    caixa.innerHTML = `<div class="pac-sug-msg">Erro na busca: ${esc(err.message)}</div>`;
    caixa.classList.remove('hidden');
  }
}

function renderSugestoesFicha(lista) {
  const caixa = document.getElementById('pac-sugestoes');
  if (!lista.length) {
    caixa.innerHTML = '<div class="pac-sug-msg">Nenhum paciente encontrado. Use "Novo Paciente" pra cadastrar.</div>';
    caixa.classList.remove('hidden');
    return;
  }
  caixa.innerHTML = lista.map((p, i) => {
    const idade = calcIdade(p.dataNascimento);
    return `<div class="pac-sug-item" data-i="${i}">
      ${esc(p.nome)}${idade !== null ? ` — ${idade} anos` : ''}
      <small>${esc(p.municipio || '—')}</small>
    </div>`;
  }).join('');
  caixa.classList.remove('hidden');
  caixa.querySelectorAll('.pac-sug-item').forEach(el => {
    el.addEventListener('click', () => escolherPacienteFicha(lista[parseInt(el.dataset.i)]));
  });
}

async function escolherPacienteFicha(paciente) {
  document.getElementById('busca-paciente-ficha').value = paciente.nome;
  document.getElementById('sel-paciente').value = paciente.id;
  const caixa = document.getElementById('pac-sugestoes');
  caixa.classList.add('hidden');
  caixa.innerHTML = '';
  await selecionarPaciente(paciente);
}

// Abre direto num paciente específico (vindo de pacientes.html?paciente=ID)
async function abrirPacientePorId(id) {
  try {
    const paciente = await apiFetch(`/ferida/pacientes/${id}`);
    await escolherPacienteFicha(paciente);
  } catch (err) {
    showToast('Não foi possível abrir esse paciente: ' + err.message, 'error');
  }
}

// Preenche um <select> de município preservando valores fora da lista fixa
// do consórcio CIS de Ivaiporã (ex.: cadastro antigo ou leitura por OCR),
// em vez de perder silenciosamente o dado.
function selecionarMunicipio(selectId, valor) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.querySelectorAll('option[data-extra]').forEach(o => o.remove());
  const alvo = (valor || 'Ivaiporã').trim();
  const existe = [...sel.options].some(o => o.textContent === alvo);
  if (alvo && !existe) {
    const opt = document.createElement('option');
    opt.textContent = alvo;
    opt.setAttribute('data-extra', '1');
    sel.appendChild(opt);
  }
  sel.value = alvo;
}

function calcIdade(dataNascimento) {
  if (!dataNascimento) return null;
  const nasc = new Date(dataNascimento + 'T00:00:00');
  if (isNaN(nasc)) return null;
  const hoje = new Date();
  let idade = hoje.getFullYear() - nasc.getFullYear();
  const m = hoje.getMonth() - nasc.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < nasc.getDate())) idade--;
  return idade;
}

async function selecionarPaciente(paciente) {
  pacienteAtual = paciente || null;
  const badge = document.getElementById('badge-retorno');
  const btnFichas = document.getElementById('btn-fichas-antigas');
  const btnHistorico = document.getElementById('btn-historico');
  const pacActions = document.getElementById('pac-actions');

  pacActions.classList.toggle('hidden', !pacienteAtual);

  if (!pacienteAtual) {
    document.getElementById('meta-municipio').textContent = '—';
    document.getElementById('meta-tipo-ferida').textContent = '—';
    document.getElementById('meta-enfermeiro').textContent = '—';
    badge.classList.add('hidden');
    btnFichas.classList.add('hidden');
    btnHistorico.classList.add('hidden');
    atendimentos = [];
    fichasAntigas = [];
    renderTimeline(false);
    return;
  }

  document.getElementById('meta-municipio').textContent = pacienteAtual.municipio || '—';
  document.getElementById('meta-tipo-ferida').textContent = pacienteAtual.tipoFerida || '—';
  document.getElementById('meta-enfermeiro').textContent = pacienteAtual.enfermeiro || '—';

  // Editar cadastro de paciente já salvo é só da enfermeira responsável;
  // os demais podem cadastrar paciente novo e ver a ficha normalmente.
  document.getElementById('btn-editar-paciente')?.classList.toggle('hidden', !souAmandaOuAdmin());
  const linkRelatorio = document.getElementById('btn-relatorio-paciente');
  if (linkRelatorio) linkRelatorio.href = `/saude/ferida/relatorio.html?paciente=${pacienteAtual.id}`;

  // Enfermeiro deste atendimento começa igual ao padrão do cadastro do
  // paciente, mas pode ser trocado sem alterar esse padrão.
  try {
    await carregarEnfermeiros();
  } catch (err) { /* segue com a lista vazia se falhar */ }
  preencherSelectEnfermeiro(pacienteAtual.enfermeiro, 'atendimento-enfermeiro');

  try {
    [atendimentos, fichasAntigas] = await Promise.all([
      apiFetch(`/ferida/pacientes/${pacienteAtual.id}/atendimentos`),
      apiFetch(`/ferida/pacientes/${pacienteAtual.id}/fichas-antigas`)
    ]);
    // Fichas de papel importadas têm data original própria — ordena pela data clínica
    atendimentos.sort((a, b) =>
      String(a.dataAtendimento || a.createdAt).localeCompare(String(b.dataAtendimento || b.createdAt)));
  } catch (err) {
    atendimentos = [];
    fichasAntigas = [];
    showToast('Erro ao carregar histórico: ' + err.message, 'error');
  }

  const n = atendimentos.length + 1;
  badge.textContent = n === 1 ? '1º atendimento' : `${n}º retorno`;
  badge.classList.remove('hidden');

  document.getElementById('fichas-count').textContent = fichasAntigas.length;
  btnFichas.classList.remove('hidden');

  // Só faz sentido abrir o histórico se já houver algum retorno registrado
  document.getElementById('historico-count').textContent = atendimentos.length;
  btnHistorico.classList.toggle('hidden', atendimentos.length === 0);

  renderTimeline(true);
}

// Preenche o <select> de enfermeiro com a lista mantida pelo ADM, preservando
// o valor atual do paciente mesmo se o nome não estiver mais na lista (ex.:
// estagiário que já saiu do rodízio) — não perde o dado histórico.
function preencherSelectEnfermeiro(valorAtual, selectId = 'pac-enfermeiro') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const alvo = (valorAtual || '').trim();
  sel.innerHTML = '<option value="">Não informado</option>';
  (enfermeirosCache || []).forEach(nome => {
    const opt = document.createElement('option');
    opt.textContent = nome;
    sel.appendChild(opt);
  });
  const existe = [...sel.options].some(o => o.textContent === alvo);
  if (alvo && !existe) {
    const opt = document.createElement('option');
    opt.textContent = alvo;
    opt.setAttribute('data-extra', '1');
    sel.appendChild(opt);
  }
  sel.value = alvo;
}

function setupPacienteModal() {
  const modal = document.getElementById('modal-paciente');

  const abrirModalPaciente = async (paciente) => {
    document.getElementById('form-paciente').reset();
    fichasPendentes = [];
    renderThumbsPendentes();

    const editando = !!paciente;
    document.getElementById('pac-id').value = editando ? paciente.id : '';
    document.getElementById('pac-nome').value = editando ? (paciente.nome || '') : '';
    selecionarMunicipio('pac-municipio', editando ? paciente.municipio : 'Ivaiporã');
    document.getElementById('pac-tipo-ferida').value = editando ? (paciente.tipoFerida || '') : '';
    try {
      await carregarEnfermeiros();
    } catch (err) {
      showToast('Não foi possível carregar a lista de enfermeiros: ' + err.message, 'error');
    }
    preencherSelectEnfermeiro(editando ? paciente.enfermeiro : '');
    document.getElementById('modal-paciente-title').textContent = editando ? 'Editar Paciente' : 'Novo Paciente';
    document.getElementById('btn-salvar-paciente').textContent = editando ? 'Salvar alterações' : 'Cadastrar';
    // No modo edição as fichas antigas são gerenciadas pela galeria própria
    document.getElementById('grupo-fichas-novo').classList.toggle('hidden', editando);

    modal.classList.remove('hidden');
    document.getElementById('pac-nome').focus();
  };

  document.getElementById('btn-novo-paciente')?.addEventListener('click', () => abrirModalPaciente(null));
  document.getElementById('btn-editar-paciente')?.addEventListener('click', () => {
    if (pacienteAtual) abrirModalPaciente(pacienteAtual);
  });
  document.getElementById('btn-excluir-paciente')?.addEventListener('click', excluirPaciente);
  document.getElementById('btn-cancelar-paciente')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  // Upload das fichas antigas de papel (fotos), comprimidas no navegador
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('pac-fichas');
  zone?.addEventListener('click', () => input.click());
  zone?.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragging'); });
  zone?.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone?.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    adicionarPendentes(e.dataTransfer.files);
  });
  input?.addEventListener('change', (e) => { adicionarPendentes(e.target.files); input.value = ''; });

  document.getElementById('form-paciente')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-salvar-paciente');
    const idEdicao = document.getElementById('pac-id').value;
    const dados = {
      nome: document.getElementById('pac-nome').value.trim(),
      municipio: document.getElementById('pac-municipio').value.trim(),
      tipoFerida: document.getElementById('pac-tipo-ferida').value || null,
      enfermeiro: document.getElementById('pac-enfermeiro').value.trim()
    };

    btn.disabled = true;
    btn.textContent = idEdicao ? 'Salvando...' : 'Cadastrando...';
    try {
      let pacienteId = idEdicao;
      if (idEdicao) {
        await apiFetch(`/ferida/pacientes/${idEdicao}`, {
          method: 'PUT',
          body: JSON.stringify(dados)
        });
      } else {
        const resp = await apiFetch('/ferida/pacientes', {
          method: 'POST',
          body: JSON.stringify(dados)
        });
        pacienteId = resp.id;
      }

      // Anexar as fichas antigas selecionadas (só no cadastro)
      let enviadas = 0, falhas = 0;
      for (const ficha of fichasPendentes) {
        btn.textContent = `Anexando ficha ${enviadas + falhas + 1}/${fichasPendentes.length}...`;
        try {
          await apiFetch(`/ferida/pacientes/${pacienteId}/fichas-antigas`, {
            method: 'POST',
            body: JSON.stringify({ imagem: ficha.dataUrl, nome: ficha.nome })
          });
          enviadas++;
        } catch (err) {
          falhas++;
          console.error('Falha ao anexar ficha antiga:', err);
        }
      }
      fichasPendentes = [];

      modal.classList.add('hidden');
      if (idEdicao) showToast('Dados do paciente atualizados');
      else if (falhas) showToast(`Paciente cadastrado, mas ${falhas} imagem(ns) não subiram. Anexe de novo em "Fichas antigas".`, 'error');
      else showToast(enviadas ? `Paciente cadastrado com ${enviadas} ficha(s) antiga(s)` : 'Paciente cadastrado');
      await escolherPacienteFicha({ id: pacienteId, ...dados });
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = idEdicao ? 'Salvar alterações' : 'Cadastrar';
    }
  });
}

async function excluirPaciente() {
  if (!pacienteAtual) return;
  const p = pacienteAtual;
  const resumo = `${atendimentos.length} atendimento(s) e ${fichasAntigas.length} ficha(s) antiga(s)`;

  const pergunta = souAmandaOuAdmin()
    ? `Excluir DEFINITIVAMENTE o paciente "${p.nome}"?\n\nSerão apagados também ${resumo}. Essa ação NÃO tem volta.`
    : `Solicitar exclusão definitiva do paciente "${p.nome}"?\n\nA enfermeira responsável vai receber o pedido e aprovar ou recusar.`;
  if (!confirm(pergunta)) return;

  try {
    const resp = await apiFetch(`/ferida/pacientes/${p.id}`, { method: 'DELETE' });
    showToast(resp.message);
    if (souAmandaOuAdmin()) {
      limparFicha();
      document.getElementById('busca-paciente-ficha').value = '';
      document.getElementById('sel-paciente').value = '';
      await selecionarPaciente(null);
    }
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// FICHAS ANTIGAS (imagens da ficha de papel)
// ==========================================

// Comprime a imagem no navegador até caber no limite de 1 MiB
// por documento do Firestore (data URL base64 <= ~950 mil chars).
const LIMITE_BASE64 = 950000;

function comprimirImagem(file) {
  const tentativas = [
    { dim: 1600, q: 0.85 },
    { dim: 1400, q: 0.72 },
    { dim: 1200, q: 0.62 },
    { dim: 1000, q: 0.52 },
    { dim: 800,  q: 0.45 }
  ];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        for (const t of tentativas) {
          const scale = Math.min(1, t.dim / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', t.q);
          if (dataUrl.length <= LIMITE_BASE64) return resolve(dataUrl);
        }
        reject(new Error('imagem grande demais mesmo após compressão'));
      };
      img.onerror = () => reject(new Error('arquivo de imagem inválido'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('não foi possível ler o arquivo'));
    reader.readAsDataURL(file);
  });
}

async function adicionarPendentes(fileList) {
  for (const file of [...fileList]) {
    if (!file.type.startsWith('image/')) {
      showToast(`"${file.name}" não é uma imagem.`, 'error');
      continue;
    }
    try {
      const dataUrl = await comprimirImagem(file);
      fichasPendentes.push({ nome: file.name, dataUrl });
    } catch (err) {
      showToast(`Não deu pra usar "${file.name}": ${err.message}`, 'error');
    }
  }
  renderThumbsPendentes();
}

function renderThumbsPendentes() {
  const wrap = document.getElementById('pac-thumbs');
  wrap.innerHTML = '';
  fichasPendentes.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img alt="${esc(f.nome)}"><button type="button" class="rm-thumb" title="Remover">×</button>`;
    div.querySelector('img').src = f.dataUrl;
    div.querySelector('.rm-thumb').addEventListener('click', () => {
      fichasPendentes.splice(i, 1);
      renderThumbsPendentes();
    });
    wrap.appendChild(div);
  });
}

function setupFichasAntigas() {
  const modal = document.getElementById('modal-fichas');
  document.getElementById('btn-fichas-antigas')?.addEventListener('click', () => {
    if (!pacienteAtual) return;
    document.getElementById('modal-fichas-title').textContent = `Fichas antigas — ${pacienteAtual.nome}`;
    mostrarListaFichas();
    renderFichasList();
    modal.classList.remove('hidden');
  });
  document.getElementById('btn-fechar-fichas')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('btn-voltar-fichas')?.addEventListener('click', mostrarListaFichas);

  const addInput = document.getElementById('fichas-add-input');
  addInput?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    addInput.value = '';
    if (!files.length || !pacienteAtual) return;
    let enviadas = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/')) { showToast(`"${file.name}" não é uma imagem.`, 'error'); continue; }
      try {
        const dataUrl = await comprimirImagem(file);
        await apiFetch(`/ferida/pacientes/${pacienteAtual.id}/fichas-antigas`, {
          method: 'POST',
          body: JSON.stringify({ imagem: dataUrl, nome: file.name })
        });
        enviadas++;
      } catch (err) {
        showToast(`Falha em "${file.name}": ${err.message}`, 'error');
      }
    }
    if (enviadas) showToast(`${enviadas} ficha(s) anexada(s)`);
    fichasAntigas = await apiFetch(`/ferida/pacientes/${pacienteAtual.id}/fichas-antigas`);
    document.getElementById('fichas-count').textContent = fichasAntigas.length;
    renderFichasList();
  });
}

function mostrarListaFichas() {
  document.getElementById('fichas-lista-wrap').classList.remove('hidden');
  document.getElementById('ficha-viewer').classList.add('hidden');
}

function renderFichasList() {
  const list = document.getElementById('fichas-list');
  list.innerHTML = '';
  if (!fichasAntigas.length) {
    list.innerHTML = '<p class="fichas-empty">Nenhuma ficha antiga anexada.</p>';
    return;
  }
  fichasAntigas.forEach(f => {
    const quando = f.createdAt ? new Date(f.createdAt).toLocaleDateString('pt-BR') : '—';
    const quem = f.createdByName ? ` · por ${f.createdByName}` : '';
    const row = document.createElement('div');
    row.className = 'ficha-row';
    row.innerHTML = `
      <span class="fic-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>
      <div class="fic-info">
        <div class="fic-nome">${esc(f.nome)}</div>
        <div class="fic-meta">${esc(quando)}${esc(quem)}</div>
      </div>
      <button type="button" class="fic-btn fic-ver">Ver</button>
      <button type="button" class="fic-btn danger fic-excluir action-execute">Excluir</button>`;
    row.querySelector('.fic-ver').addEventListener('click', () => verFicha(f));
    row.querySelector('.fic-excluir').addEventListener('click', () => excluirFicha(f));
    list.appendChild(row);
  });
}

async function verFicha(meta) {
  try {
    const full = await apiFetch(`/ferida/pacientes/${pacienteAtual.id}/fichas-antigas/${meta.id}`);
    document.getElementById('ficha-viewer-img').src = full.imagem;
    const quando = full.createdAt ? new Date(full.createdAt).toLocaleString('pt-BR') : '—';
    document.getElementById('ficha-viewer-meta').textContent =
      `${full.nome} · anexada em ${quando}${full.createdByName ? ' por ' + full.createdByName : ''}`;
    document.getElementById('fichas-lista-wrap').classList.add('hidden');
    document.getElementById('ficha-viewer').classList.remove('hidden');
  } catch (err) {
    showToast('Erro ao abrir a ficha: ' + err.message, 'error');
  }
}

async function excluirFicha(meta) {
  const pergunta = souAmandaOuAdmin()
    ? `Excluir a imagem "${meta.nome}" do paciente? Essa ação não tem volta.`
    : `Solicitar exclusão da imagem "${meta.nome}"? A enfermeira responsável vai aprovar ou recusar.`;
  if (!confirm(pergunta)) return;
  try {
    const resp = await apiFetch(`/ferida/pacientes/${pacienteAtual.id}/fichas-antigas/${meta.id}`, { method: 'DELETE' });
    if (souAmandaOuAdmin()) {
      fichasAntigas = fichasAntigas.filter(f => f.id !== meta.id);
      document.getElementById('fichas-count').textContent = fichasAntigas.length;
      renderFichasList();
    }
    showToast(resp.message);
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// MAPA DO CORPO (assinatura da ficha)
// ==========================================

function setupBodyMap() {
  document.querySelectorAll('svg[data-region]').forEach(svg => {
    svg.addEventListener('click', e => {
      if (userLevel < 3) return;                          // leitura: não marca
      if (e.target.classList.contains('pin')) return;     // ignora cliques em pinos
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
      addPin(svg, loc.x, loc.y, svg.dataset.region);
    });
  });
}

// numeroForcado/rotuloForcado: usados só ao restaurar marcações de um
// atendimento existente pra edição (restaurarMarcacoes) — preserva o número
// original em vez de gerar um novo, e não marca a ficha como suja.
function addPin(svg, x, y, region, numeroForcado, rotuloForcado) {
  let id;
  if (numeroForcado) {
    id = numeroForcado;
    if (numeroForcado > pinCount) pinCount = numeroForcado;
  } else {
    pinCount++;
    id = pinCount;
  }
  const list = document.getElementById('pinlist');
  const g = svg.querySelector('.pins');

  const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  grp.dataset.id = id;
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 8); c.setAttribute('class', 'pin');
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('class', 'pinnum'); t.textContent = id;
  grp.appendChild(c); grp.appendChild(t); g.appendChild(grp);

  if (list.querySelector('.empty')) list.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'pinrow';
  li.dataset.id = id;
  li.dataset.region = region;
  li.dataset.x = x.toFixed(2);
  li.dataset.y = y.toFixed(2);
  li.innerHTML = `<span class="dot">${id}</span><span class="reg">${esc(region)}</span>` +
    `<input type="text" placeholder="Nomear local (ex.: calcâneo D)" aria-label="Nome do local ${id}" value="${esc(rotuloForcado || '')}">` +
    `<button type="button" class="rm" title="Remover" aria-label="Remover marcação ${id}">×</button>`;
  list.appendChild(li);

  const hi = () => c.classList.add('pin-hi'), un = () => c.classList.remove('pin-hi');
  li.addEventListener('mouseenter', hi);
  li.addEventListener('mouseleave', un);
  li.querySelector('.rm').addEventListener('click', () => {
    grp.remove(); li.remove();
    if (!list.children.length) resetEmpty();
    sincronizarDimensoesPorFerida();
    markDirty();
  });
  li.querySelector('input').addEventListener('input', () => {
    sincronizarDimensoesPorFerida();
    markDirty();
  });
  if (!numeroForcado) {
    sincronizarDimensoesPorFerida();
    markDirty();
  }
}

function resetEmpty() {
  document.getElementById('pinlist').innerHTML =
    '<li class="empty">Nenhuma marcação ainda. Toque no corpo pra indicar onde está a ferida.</li>';
}

// Cada ferida marcada no boneco tem seu próprio cartão de dimensões (só as
// dimensões são por ferida — o resto da avaliação clínica continua único pro
// atendimento). Preserva os valores já digitados ao adicionar/remover outras
// marcações ou redigitar um rótulo.
function montarLinhaDimensao(numero, rotulo) {
  return `
    <div class="dim-ferida" data-numero="${numero}">
      <div class="dim-ferida-titulo">Ferida ${numero}${rotulo ? ' — ' + esc(rotulo) : ''}</div>
      <div class="dims">
        <div class="u" data-u="cm"><label>Comprimento</label><input type="text" inputmode="decimal" placeholder="0,0" data-dim="comprimento"></div>
        <div class="u" data-u="cm"><label>Largura</label><input type="text" inputmode="decimal" placeholder="0,0" data-dim="largura"></div>
        <div class="u" data-u="cm"><label>Profundidade</label><input type="text" inputmode="decimal" placeholder="0,0" data-dim="profundidade"></div>
        <div class="u" data-u="cm"><label>Descolamento</label><input type="text" inputmode="decimal" placeholder="0,0" data-dim="descolamento"></div>
      </div>
    </div>`;
}

function sincronizarDimensoesPorFerida() {
  const container = document.getElementById('dims-por-ferida');
  const linhas = [...document.querySelectorAll('#pinlist .pinrow')];

  if (!linhas.length) {
    container.innerHTML = '<p class="hint" id="dims-vazio">Marque uma ferida no boneco pra informar as dimensões dela.</p>';
    return;
  }

  const valoresAtuais = {};
  container.querySelectorAll('.dim-ferida').forEach(bloco => {
    valoresAtuais[bloco.dataset.numero] = ['comprimento', 'largura', 'profundidade', 'descolamento']
      .reduce((acc, campo) => { acc[campo] = bloco.querySelector(`[data-dim="${campo}"]`).value; return acc; }, {});
  });

  container.innerHTML = linhas.map(li =>
    montarLinhaDimensao(li.dataset.id, li.querySelector('input').value.trim())
  ).join('');

  container.querySelectorAll('.dim-ferida').forEach(bloco => {
    const salvos = valoresAtuais[bloco.dataset.numero];
    if (!salvos) return;
    Object.entries(salvos).forEach(([campo, valor]) => {
      if (valor) bloco.querySelector(`[data-dim="${campo}"]`).value = valor;
    });
  });
}

function coletarMarcacoes() {
  return [...document.querySelectorAll('#pinlist .pinrow')].map(li => {
    const numero = li.dataset.id;
    const bloco = document.querySelector(`.dim-ferida[data-numero="${numero}"]`);
    const val = campo => (bloco?.querySelector(`[data-dim="${campo}"]`)?.value.trim() || null);
    return {
      numero: parseInt(numero),
      regiao: li.dataset.region,
      x: parseFloat(li.dataset.x),
      y: parseFloat(li.dataset.y),
      rotulo: li.querySelector('input').value.trim(),
      dimensoes: {
        comprimento:  val('comprimento'),
        largura:      val('largura'),
        profundidade: val('profundidade'),
        descolamento: val('descolamento')
      }
    };
  });
}

// Recria os pinos no boneco a partir das marcações de um atendimento salvo
// (usado ao editar um atendimento do histórico) — preserva número e rótulo
// originais e preenche as dimensões de cada ferida.
function restaurarMarcacoes(marcacoes) {
  document.querySelectorAll('svg[data-region] .pins').forEach(g => g.innerHTML = '');
  pinCount = 0;
  resetEmpty();

  (marcacoes || []).forEach(m => {
    const svg = document.querySelector(`svg[data-region="${m.regiao}"]`);
    if (!svg) return;
    addPin(svg, m.x, m.y, m.regiao, m.numero, m.rotulo);
  });

  sincronizarDimensoesPorFerida();

  (marcacoes || []).forEach(m => {
    if (!m.dimensoes) return;
    const bloco = document.querySelector(`.dim-ferida[data-numero="${m.numero}"]`);
    if (!bloco) return;
    Object.entries(m.dimensoes).forEach(([campo, valor]) => {
      if (valor !== null && valor !== undefined) {
        const input = bloco.querySelector(`[data-dim="${campo}"]`);
        if (input) input.value = valor;
      }
    });
  });
}

// ==========================================
// CHIPS (multi e single)
// ==========================================

function setupChips() {
  document.querySelectorAll('.chips').forEach(group => {
    const single = group.hasAttribute('data-single');
    group.addEventListener('click', e => {
      if (userLevel < 3) return;
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (single) { group.querySelectorAll('.chip').forEach(c => { if (c !== chip) c.classList.remove('on'); }); }
      chip.classList.toggle('on');
      markDirty();
    });
    group.addEventListener('keydown', e => {
      if ((e.key === ' ' || e.key === 'Enter') && e.target.classList.contains('chip')) {
        e.preventDefault();
        e.target.click();
      }
    });
  });
}

function chipsSelecionados(field) {
  return [...document.querySelectorAll(`.chips[data-field="${field}"] .chip.on`)].map(c => c.textContent.trim());
}

function chipUnico(field) {
  const on = document.querySelector(`.chips[data-field="${field}"] .chip.on`);
  return on ? on.textContent.trim() : null;
}

// ==========================================
// FICHA: salvar / limpar / estado
// ==========================================

function setupFormListeners() {
  document.querySelectorAll('.ferida-content input, .ferida-content textarea')
    .forEach(el => el.addEventListener('input', markDirty));
  document.getElementById('btn-salvar')?.addEventListener('click', salvarAtendimento);
  document.getElementById('btn-limpar')?.addEventListener('click', () => {
    limparFicha();
    showToast('Formulário limpo');
  });
}

function markDirty() {
  dirty = true;
  document.getElementById('status').textContent = 'Rascunho não salvo';
}

async function salvarAtendimento() {
  if (!pacienteAtual) {
    showToast('Selecione o paciente antes de salvar.', 'error');
    return;
  }

  const payload = {
    marcacoes: coletarMarcacoes(),
    tecido: chipsSelecionados('tecido'),
    bordas: chipsSelecionados('bordas'),
    peleAdjacente: chipsSelecionados('peleAdjacente'),
    exsudato: {
      tipo:         chipUnico('exsudatoTipo'),
      cor:          chipUnico('exsudatoCor'),
      consistencia: chipUnico('exsudatoConsistencia'),
      quantidade:   chipUnico('exsudatoQuantidade')
    },
    infeccaoSuperficial: chipsSelecionados('infeccaoSuperficial'),
    infeccaoProfunda:    chipsSelecionados('infeccaoProfunda'),
    biofilme: chipUnico('biofilme') === null ? null : chipUnico('biofilme') === 'Sim',
    dor: {
      presente: chipUnico('dorPresente') === null ? null : chipUnico('dorPresente') === 'Sim',
      escala: parseInt(chipUnico('dorEscala')) || null
    },
    cobertura: chipsSelecionados('cobertura'),
    conduta: document.getElementById('conduta').value.trim(),
    enfermeiro: document.getElementById('atendimento-enfermeiro').value.trim(),
    dataAtendimento: document.getElementById('data-atendimento-manual').value || null
  };

  const editando = atendimentoEmEdicaoId;
  const btn = document.getElementById('btn-salvar');
  btn.disabled = true;
  btn.textContent = editando ? 'Salvando edição...' : 'Salvando...';

  try {
    if (editando) {
      await apiFetch(`/ferida/pacientes/${pacienteAtual.id}/atendimentos/${editando}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      await apiFetch(`/ferida/pacientes/${pacienteAtual.id}/atendimentos`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
    dirty = false;
    document.getElementById('status').textContent =
      'Salvo às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    showToast(editando ? 'Atendimento atualizado' : 'Atendimento salvo');
    limparFicha(true);
    await selecionarPaciente(pacienteAtual);
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar atendimento';
  }
}

function limparFicha(manterStatus = false) {
  document.querySelectorAll('.chip.on').forEach(c => c.classList.remove('on'));
  document.getElementById('conduta').value = '';
  document.querySelectorAll('svg[data-region] .pins').forEach(g => g.innerHTML = '');
  pinCount = 0;
  const inputData = document.getElementById('data-atendimento-manual');
  inputData.max = todayStr();
  inputData.value = todayStr();
  document.getElementById('loc-hint')?.classList.add('hidden');
  resetEmpty();
  sincronizarDimensoesPorFerida();
  preencherSelectEnfermeiro(pacienteAtual?.enfermeiro, 'atendimento-enfermeiro');
  atendimentoEmEdicaoId = null;
  document.getElementById('btn-salvar').textContent = 'Salvar atendimento';
  document.getElementById('btn-limpar').textContent = 'Limpar';
  if (!manterStatus) {
    dirty = false;
    document.getElementById('status').textContent = 'Rascunho não salvo';
  }
}

// ==========================================
// IMPORTAR FICHA PREENCHIDA (OCR local em Python)
// Princípio: "leitura prepara, humano confirma" — o OCR só
// pré-preenche; a enfermeira revisa e salva.
// ==========================================

function setupImportacaoIA() {
  const modal = document.getElementById('modal-ia');

  document.getElementById('btn-importar-ficha')?.addEventListener('click', () => {
    iaImagens = { frente: null, verso: null };
    iaDados = null;
    resetSlotsIA();
    mostrarEtapaIA('fotos');
    modal.classList.remove('hidden');
  });
  document.getElementById('btn-cancelar-ia')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('btn-voltar-ia')?.addEventListener('click', () => mostrarEtapaIA('fotos'));

  for (const lado of ['frente', 'verso']) {
    const slot = document.getElementById(`ia-slot-${lado}`);
    const input = document.getElementById(`ia-file-${lado}`);
    slot?.addEventListener('click', () => input.click());
    input?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      input.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) { showToast(`"${file.name}" não é uma imagem.`, 'error'); return; }
      try {
        iaImagens[lado] = { nome: file.name, dataUrl: await comprimirImagem(file) };
        const img = slot.querySelector('.ia-slot-preview');
        img.src = iaImagens[lado].dataUrl;
        img.classList.remove('hidden');
        slot.querySelector('.ia-slot-body').classList.add('hidden');
        slot.classList.add('filled');
      } catch (err) {
        showToast(`Não deu pra usar "${file.name}": ${err.message}`, 'error');
      }
      document.getElementById('btn-ler-ia').disabled = !iaImagens.frente;
    });
  }

  document.getElementById('btn-ler-ia')?.addEventListener('click', lerFichaIA);
  document.getElementById('btn-aplicar-ia')?.addEventListener('click', aplicarFichaIA);
}

function resetSlotsIA() {
  for (const lado of ['frente', 'verso']) {
    const slot = document.getElementById(`ia-slot-${lado}`);
    slot.classList.remove('filled');
    slot.querySelector('.ia-slot-preview').classList.add('hidden');
    slot.querySelector('.ia-slot-body').classList.remove('hidden');
  }
  document.getElementById('btn-ler-ia').disabled = true;
}

function mostrarEtapaIA(etapa) {
  for (const e of ['fotos', 'lendo', 'revisao']) {
    document.getElementById(`ia-etapa-${e}`).classList.toggle('hidden', e !== etapa);
  }
}

async function lerFichaIA() {
  const imagens = [iaImagens.frente, iaImagens.verso].filter(Boolean).map(i => i.dataUrl);
  if (!imagens.length) return;

  mostrarEtapaIA('lendo');
  try {
    const resp = await apiFetch('/ferida/ler-ficha', {
      method: 'POST',
      body: JSON.stringify({ imagens })
    });
    iaDados = resp.dados;
    renderRevisaoIA(iaDados);
    mostrarEtapaIA('revisao');
  } catch (err) {
    showToast('Erro na leitura: ' + err.message, 'error');
    mostrarEtapaIA('fotos');
  }
}

const fmtData = (iso) => {
  if (!iso) return null;
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

// Data local (não UTC) no formato YYYY-MM-DD, pro <input type="date">
function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function renderRevisaoIA(d) {
  // Fotos da ficha ao lado dos campos, para conferência visual
  const fotos = document.getElementById('ia-fotos-review');
  fotos.innerHTML = '';
  for (const lado of ['frente', 'verso']) {
    if (!iaImagens[lado]) continue;
    const label = document.createElement('span');
    label.className = 'rev-foto-label';
    label.textContent = lado;
    const img = document.createElement('img');
    img.src = iaImagens[lado].dataUrl;
    img.alt = `Ficha — ${lado}`;
    fotos.appendChild(label);
    fotos.appendChild(img);
  }

  // Campos editáveis pré-preenchidos com o que a leitura identificou.
  // O que veio vazio/errado a pessoa corrige aqui, olhando a foto.
  const set = (id, v) => { document.getElementById(id).value = v ?? ''; };
  const setDim = (id, v) => { document.getElementById(id).value = typeof v === 'number' ? String(v).replace('.', ',') : ''; };

  set('rev-nome', d.paciente?.nome);
  selecionarMunicipio('rev-municipio', d.paciente?.municipio);
  set('rev-data', d.dataAtendimento);
  set('rev-localizacao', d.localizacao);
  setDim('rev-comprimento', d.dimensoes?.comprimento);
  setDim('rev-largura', d.dimensoes?.largura);
  setDim('rev-profundidade', d.dimensoes?.profundidade);
  setDim('rev-descolamento', d.dimensoes?.descolamento);
  set('rev-conduta', d.conduta);

  document.getElementById('rev-ocr-texto').textContent = d.observacoes || '(nenhum texto lido)';
  document.getElementById('rev-nome').focus();
}

async function aplicarFichaIA(e) {
  if (!iaDados) return;
  const d = iaDados;
  const btn = e.currentTarget;

  // Valores CORRIGIDOS pela pessoa na tela de conferência (não os crus da leitura)
  const val = (id) => document.getElementById(id).value.trim();
  const nome = val('rev-nome');
  const municipio = val('rev-municipio') || 'Ivaiporã';
  const dataFicha = val('rev-data') || null;
  const localizacao = val('rev-localizacao');
  const conduta = val('rev-conduta');

  if (!nome) {
    showToast('Preencha o nome do paciente antes de aplicar.', 'error');
    document.getElementById('rev-nome').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Aplicando...';

  try {
    // 1. Paciente: usa o existente com o mesmo nome (busca no servidor), ou cadastra
    let pacienteSelecionado = null;
    try {
      const achados = await apiFetch(`/ferida/pacientes?busca=${encodeURIComponent(nome)}`);
      pacienteSelecionado = achados.find(p => p.nome.trim().toLowerCase() === nome.toLowerCase()) || null;
    } catch (e) { /* segue pro cadastro se a busca falhar */ }

    if (!pacienteSelecionado) {
      const resp = await apiFetch('/ferida/pacientes', {
        method: 'POST',
        body: JSON.stringify({ nome, municipio })
      });
      pacienteSelecionado = { id: resp.id, nome, municipio };
    }
    const pacienteId = pacienteSelecionado.id;

    // 2. Anexa as fotos como fichas antigas do paciente
    for (const lado of ['frente', 'verso']) {
      if (!iaImagens[lado]) continue;
      try {
        await apiFetch(`/ferida/pacientes/${pacienteId}/fichas-antigas`, {
          method: 'POST',
          body: JSON.stringify({
            imagem: iaImagens[lado].dataUrl,
            nome: `ficha-${fmtData(dataFicha) || 'antiga'}-${lado}.jpg`
          })
        });
      } catch (err) {
        console.error('Falha ao anexar imagem da ficha:', err);
      }
    }

    // 3. Seleciona o paciente e pré-preenche o formulário com os valores conferidos
    await escolherPacienteFicha(pacienteSelecionado);
    limparFicha();

    // Dimensões agora são por ferida marcada no boneco — a leitura da ficha
    // de papel não sabe a qual marcação associar, então não pré-preenche mais
    // aqui (o enfermeiro marca a ferida e digita as dimensões manualmente).
    aplicarChips('tecido', d.tecido);
    aplicarChips('bordas', d.bordas);
    aplicarChips('peleAdjacente', d.peleAdjacente || []);
    aplicarChips('exsudatoTipo', d.exsudato?.tipo ? [d.exsudato.tipo] : []);
    aplicarChips('exsudatoCor', d.exsudato?.cor ? [d.exsudato.cor] : []);
    aplicarChips('exsudatoConsistencia', d.exsudato?.consistencia ? [d.exsudato.consistencia] : []);
    aplicarChips('exsudatoQuantidade', d.exsudato?.quantidade ? [d.exsudato.quantidade] : []);
    aplicarChips('infeccaoSuperficial', d.infeccaoSuperficial);
    aplicarChips('infeccaoProfunda', d.infeccaoProfunda);
    aplicarChips('biofilme', d.biofilme === true ? ['Sim'] : d.biofilme === false ? ['Não'] : []);
    document.getElementById('conduta').value = conduta;

    if (dataFicha) document.getElementById('data-atendimento-manual').value = dataFicha;

    // Localização vem como texto na ficha de papel — a marcação no mapa é manual
    const hint = document.getElementById('loc-hint');
    if (localizacao) {
      hint.textContent = `📍 A ficha indica: "${localizacao}" — toque no mapa para marcar o local.`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }

    dirty = true;
    document.getElementById('status').textContent = dataFicha
      ? `Preenchido pela leitura (ficha de ${fmtData(dataFicha)}) — revise antes de salvar`
      : 'Preenchido pela leitura — revise antes de salvar';

    document.getElementById('modal-ia').classList.add('hidden');
    showToast(existente ? 'Formulário pré-preenchido — revise e salve' : 'Paciente cadastrado e formulário pré-preenchido — revise e salve');
  } catch (err) {
    showToast('Erro ao aplicar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aplicar no formulário';
  }
}

function aplicarChips(field, valores) {
  if (!Array.isArray(valores)) return;
  document.querySelectorAll(`.chips[data-field="${field}"] .chip`).forEach(chip => {
    chip.classList.toggle('on', valores.includes(chip.textContent.trim()));
  });
}

// ==========================================
// HISTÓRICO / EVOLUÇÃO
// ==========================================

// Lista de { rotulo, dimensoes } — uma entrada por ferida marcada (formato
// atual, dimensões dentro de cada marcação) ou uma entrada única sem rótulo
// com as dimensões do nível de cima do atendimento (formato antigo, de antes
// da separação por ferida — sem precisar migrar dado nenhum).
function listaDimensoesPorFerida(at) {
  const marcacoesComDim = (at.marcacoes || [])
    .filter(m => m.dimensoes && Object.values(m.dimensoes).some(v => typeof v === 'number'));
  if (marcacoesComDim.length) {
    return marcacoesComDim.map(m => ({ rotulo: m.rotulo || `Ferida ${m.numero}`, dimensoes: m.dimensoes }));
  }
  if (at.dimensoes && Object.values(at.dimensoes).some(v => typeof v === 'number')) {
    return [{ rotulo: null, dimensoes: at.dimensoes }];
  }
  return [];
}

function areaDe(at) {
  const areas = listaDimensoesPorFerida(at)
    .map(({ dimensoes: d }) => (typeof d.comprimento === 'number' && typeof d.largura === 'number') ? d.comprimento * d.largura : null)
    .filter(a => a !== null);
  return areas.length ? Math.max(...areas) : null;
}

function fmtDim(v) {
  return typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : null;
}

function renderTimeline(temPaciente) {
  const tl = document.getElementById('timeline');
  tl.innerHTML = '';

  if (!temPaciente) {
    tl.innerHTML = '<div class="tl"><div class="what">Selecione um paciente para ver o histórico.</div></div>';
    return;
  }

  atendimentos.forEach((at, i) => {
    const quando = at.dataAtendimento
      ? fmtData(at.dataAtendimento)
      : new Date(at.createdAt).toLocaleDateString('pt-BR');
    const listaDims = listaDimensoesPorFerida(at);
    const dims = listaDims.length
      ? listaDims.map(({ rotulo, dimensoes: d }) => {
          const c = fmtDim(d.comprimento), l = fmtDim(d.largura);
          const medida = (c && l) ? `${c}×${l}cm` : 'sem medidas';
          return rotulo ? `${rotulo}: ${medida}` : medida;
        }).join(' · ')
      : 'sem medidas';

    const resumoPartes = [];
    if (at.tecido?.length) resumoPartes.push(at.tecido[0].toLowerCase());
    if (at.exsudato?.quantidade) resumoPartes.push(`exsudato ${at.exsudato.quantidade.toLowerCase()}`);
    const resumo = resumoPartes.length ? ' · ' + esc(resumoPartes.join(', ')) : '';

    let trend;
    if (i === 0) {
      trend = '<span class="trend flat">1º registro</span>';
    } else {
      const aAtual = areaDe(at), aAnterior = areaDe(atendimentos[i - 1]);
      if (aAtual === null || aAnterior === null) trend = '';
      else if (aAtual < aAnterior) trend = '<span class="trend up">melhora</span>';
      else if (aAtual > aAnterior) trend = '<span class="trend down">piora</span>';
      else trend = '<span class="trend flat">estável</span>';
    }

    const quem = at.createdByName ? `<span class="who">por ${esc(at.createdByName)}</span>` : '';

    const row = document.createElement('div');
    row.className = 'tl tl-clickable';
    row.innerHTML = `<div class="when">${esc(quando)}</div><div class="what"><b>${esc(dims)}</b>${resumo} ${trend}${quem}</div>`;
    row.addEventListener('click', () => abrirDetalheAtendimento(at));
    tl.appendChild(row);
  });

  const hoje = document.createElement('div');
  hoje.className = 'tl';
  hoje.innerHTML = '<div class="when">Hoje</div><div class="what"><b>em preenchimento…</b></div>';
  tl.appendChild(hoje);
}

// ==========================================
// DETALHE DE UM ATENDIMENTO (ver o registro anterior completo)
// ==========================================

function setupDetalheAtendimento() {
  const modal = document.getElementById('modal-atendimento');
  document.getElementById('btn-fechar-atendimento')?.addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('btn-editar-atendimento')?.addEventListener('click', () => {
    if (atendimentoDetalheAtual) iniciarEdicaoAtendimento(atendimentoDetalheAtual);
  });
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
}

function setupHistoricoModal() {
  const modal = document.getElementById('modal-historico');
  document.getElementById('btn-historico')?.addEventListener('click', () => modal.classList.remove('hidden'));
  document.getElementById('btn-fechar-historico')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
}

function abrirDetalheAtendimento(at) {
  atendimentoDetalheAtual = at;
  // Corrigir um atendimento já salvo é só da enfermeira responsável (LGPD).
  document.getElementById('btn-editar-atendimento')?.classList.toggle('hidden', !souAmandaOuAdmin());

  const quando = at.dataAtendimento
    ? fmtData(at.dataAtendimento)
    : new Date(at.createdAt).toLocaleDateString('pt-BR');
  document.getElementById('modal-atendimento-title').textContent = `Atendimento — ${quando}`;

  const linha = (label, valor) => `<div class="det-linha"><b>${esc(label)}:</b> ${valor}</div>`;
  const listaOuTraco = arr => (Array.isArray(arr) && arr.length) ? esc(arr.join(', ')) : '—';

  const dimsHtml = listaDimensoesPorFerida(at).map(({ rotulo, dimensoes: d }) => {
    const partes = [
      fmtDim(d.comprimento)  && `Compr. ${fmtDim(d.comprimento)} cm`,
      fmtDim(d.largura)      && `Larg. ${fmtDim(d.largura)} cm`,
      fmtDim(d.profundidade) && `Prof. ${fmtDim(d.profundidade)} cm`,
      fmtDim(d.descolamento) && `Descol. ${fmtDim(d.descolamento)} cm`
    ].filter(Boolean).join(' · ') || '—';
    return rotulo ? `<div>${esc(rotulo)}: ${partes}</div>` : `<div>${partes}</div>`;
  }).join('') || '—';

  const locais = (at.marcacoes || []).map(m => m.rotulo).filter(Boolean);
  const exs = at.exsudato || {};
  const exsudatoTxt = [exs.tipo, exs.cor, exs.consistencia, exs.quantidade].filter(Boolean).join(' · ') || '—';
  const biofilmeTxt = at.biofilme === true ? 'Sim' : at.biofilme === false ? 'Não' : '—';
  const dorTxt = at.dor?.presente === true
    ? `Sim${at.dor.escala ? ` (${at.dor.escala}/10)` : ''}`
    : at.dor?.presente === false ? 'Não' : '—';
  const enfermeiroTxt = at.enfermeiro || pacienteAtual?.enfermeiro || '—';

  document.getElementById('detalhe-atendimento').innerHTML = `
    <div class="det-grid">
      ${linha('Dimensões', dimsHtml)}
      ${linha('Localização', listaOuTraco(locais))}
      ${linha('Enfermeiro(a)', esc(enfermeiroTxt))}
      ${linha('Tecido', listaOuTraco(at.tecido))}
      ${linha('Bordas', listaOuTraco(at.bordas))}
      ${linha('Pele adjacente', listaOuTraco(at.peleAdjacente))}
      ${linha('Exsudato', esc(exsudatoTxt))}
      ${linha('Infecção superficial', listaOuTraco(at.infeccaoSuperficial))}
      ${linha('Infecção profunda', listaOuTraco(at.infeccaoProfunda))}
      ${linha('Biofilme', biofilmeTxt)}
      ${linha('Dor', dorTxt)}
      ${linha('Cobertura(s) utilizada(s)', listaOuTraco(at.cobertura))}
    </div>
    <div class="det-conduta"><b>Conduta:</b><p>${esc(at.conduta || '—')}</p></div>
    <div class="det-autor">Registrado por ${esc(at.createdByName || '—')} em ${new Date(at.createdAt).toLocaleString('pt-BR')}</div>
    ${at.updatedAt ? `<div class="det-autor">Editado por ${esc(at.updatedByName || '—')} em ${new Date(at.updatedAt).toLocaleString('pt-BR')}</div>` : ''}
  `;
  document.getElementById('modal-atendimento').classList.remove('hidden');
}

// Carrega um atendimento salvo de volta na ficha principal pra corrigir algo
// (formato antigo, sem dimensão por ferida, cai no fallback de listaDimensoesPorFerida
// já usado na exibição — ao salvar, essa marcação passa a ter dimensão própria).
function iniciarEdicaoAtendimento(at) {
  document.getElementById('modal-atendimento').classList.add('hidden');
  document.getElementById('modal-historico')?.classList.add('hidden');
  limparFicha(true);

  restaurarMarcacoes(at.marcacoes);
  aplicarChips('tecido', at.tecido);
  aplicarChips('bordas', at.bordas);
  aplicarChips('peleAdjacente', at.peleAdjacente);
  aplicarChips('exsudatoTipo', at.exsudato?.tipo ? [at.exsudato.tipo] : []);
  aplicarChips('exsudatoCor', at.exsudato?.cor ? [at.exsudato.cor] : []);
  aplicarChips('exsudatoConsistencia', at.exsudato?.consistencia ? [at.exsudato.consistencia] : []);
  aplicarChips('exsudatoQuantidade', at.exsudato?.quantidade ? [at.exsudato.quantidade] : []);
  aplicarChips('infeccaoSuperficial', at.infeccaoSuperficial);
  aplicarChips('infeccaoProfunda', at.infeccaoProfunda);
  aplicarChips('biofilme', at.biofilme === true ? ['Sim'] : at.biofilme === false ? ['Não'] : []);
  aplicarChips('dorPresente', at.dor?.presente === true ? ['Sim'] : at.dor?.presente === false ? ['Não'] : []);
  aplicarChips('dorEscala', at.dor?.escala ? [String(at.dor.escala)] : []);
  aplicarChips('cobertura', at.cobertura);

  document.getElementById('conduta').value = at.conduta || '';
  document.getElementById('data-atendimento-manual').value = at.dataAtendimento || todayStr();
  preencherSelectEnfermeiro(at.enfermeiro || pacienteAtual?.enfermeiro, 'atendimento-enfermeiro');

  atendimentoEmEdicaoId = at.id;
  document.getElementById('btn-salvar').textContent = 'Salvar edição';
  document.getElementById('btn-limpar').textContent = 'Cancelar edição';
  const quando = at.dataAtendimento ? fmtData(at.dataAtendimento) : new Date(at.createdAt).toLocaleDateString('pt-BR');
  document.getElementById('status').textContent = `Editando atendimento de ${quando}`;
  dirty = true;

  document.querySelector('.ferida-content')?.scrollIntoView({ behavior: 'smooth' });
  showToast('Edite os campos e clique em "Salvar edição"');
}

// ==========================================
// TOAST
// ==========================================

let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}
