import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../core/layout.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { CATEGORIES } from "../core/permissions.js";

import { secureAction, escapeHTML as esc } from "../core/security.js";

const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);

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

let currentUser = null;
let currentRole = null;
let appInitialized = false;
let initializedRole = null;

// Estado do quadro Kanban — precisa estar declarado aqui em cima porque o
// carregamento rápido (usuário cacheado) chama initApp() de forma síncrona,
// antes do restante do módulo terminar de avaliar; deixar essas variáveis lá
// embaixo (onde a seção Kanban fica) jogava initApp() na zona morta
// temporal do `let` e travava com "Cannot access before initialization".
let souGestor = false;
let setorAtual = null;
let minhasAtividades = [];
let atividadesPorUid = {};
let funcionariosDoSetor = [];
let draggedId = null;

// ================================================================
//  AUTH GUARD & INIT
// ================================================================
const cached = getCachedAuth();
if (cached) {
  currentUser = cached.user;
  currentRole = cached.role;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    try {
      const token = await user.getIdToken();
      let role = 'visitante';
      try {
        const userData = await apiFetch('/usuarios/me');
        role = userData.role || 'visitante';
      } catch(e) {
        role = cached ? cached.role : 'visitante';
      }

      setCachedAuth(user, role, token);

      if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
        currentRole = role;
        initApp(user, role);
      } else {
        // App já rodou com o usuário cacheado (token pode ter vencido nesse
        // meio tempo) — agora que o Firebase confirmou a sessão de verdade e
        // renovou o token, recarrega o que depende dele pra não ficar preso
        // no board vazio/desatualizado até um logout+login.
        await carregarMeuQuadro();
        const boardSelect = document.getElementById('board-select');
        renderBoard(boardSelect ? boardSelect.value : '__self__');
        if (souGestor && setorAtual) await carregarPainelSetor();
      }
    } catch (err) {
      console.error("Erro na revalidação de auth:", err);
    }
  } else {
    clearCachedAuth();
    window.location.href = '../auth/login.html';
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'dashboard', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  setupEventListeners();

  const linkProcessos = document.getElementById('link-processos-setor');
  souGestor = ['chefe_setor', 'adm_l1', 'adm_l2'].includes(role);
  if (souGestor) {
    if (linkProcessos) linkProcessos.classList.remove('hidden');
    document.getElementById('gestor-panel').classList.remove('hidden');
    await setupSetorScope(role);
  }

  document.getElementById('board-select').addEventListener('change', (e) => {
    renderBoard(e.target.value);
    atualizarProcessosFuncionario(e.target.value);
  });
  await carregarMeuQuadro();
  renderBoard('__self__');
}

// ================================================================
//  PROCESSOS DO FUNCIONÁRIO SELECIONADO (referência, "Ver quadro de")
// ================================================================
const RECORRENCIA_LABEL = { diaria: 'Diária', semanal: 'Semanal', mensal: 'Mensal', bimestral: 'Bimestral', semestral: 'Semestral', anual: 'Anual', conforme_demanda: 'Conforme Demanda' };

async function atualizarProcessosFuncionario(uidSelecionado) {
  const el = document.getElementById('quadro-processos-funcionario');
  if (uidSelecionado === '__self__') {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = '<div class="loading-state">Carregando processos dessa pessoa...</div>';
  try {
    const processos = await apiFetch(`/processos/meus?uid=${encodeURIComponent(uidSelecionado)}`);
    if (!processos.length) {
      el.innerHTML = '<div class="empty-state">Nenhum processo do setor atribuído a essa pessoa ainda.</div>';
      return;
    }
    el.innerHTML = `
      <div class="processos-funcionario-titulo">Processos do setor atribuídos a essa pessoa</div>
      <div class="processos-funcionario-lista">
        ${processos.map(p => `
          <div class="processo-ref-item">
            <span class="recorrencia-badge">${esc(RECORRENCIA_LABEL[p.recorrencia] || p.recorrencia)}</span>
            <strong>${esc(p.titulo)}</strong>
            ${(p.passos || []).length ? `<details class="kanban-card-passos"><summary>Ver passos (${p.passos.length})</summary><ul>${p.passos.map(x => `<li>${esc(x.texto)}</li>`).join('')}</ul></details>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Erro ao carregar processos: ${esc(err.message)}</div>`;
  }
}

// ================================================================
//  MINHAS ATIVIDADES (QUADRO KANBAN — tarefas avulsas)
// ================================================================
const COL_LABEL = { a_fazer: 'A Fazer', fazendo: 'Fazendo', concluido: 'Concluído' };
const ORDEM_STATUS = ['a_fazer', 'fazendo', 'concluido'];

async function setupSetorScope(role) {
  const wrap = document.getElementById('proc-setor-select-wrap');
  if (role === 'adm_l1' || role === 'adm_l2') {
    wrap.classList.remove('hidden');
    wrap.innerHTML = `
      <select id="gestor-setor-select" class="form-input" style="width:auto; display:inline-block;">
        <option value="">Selecione um setor...</option>
        ${Object.entries(CATEGORIES).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('')}
      </select>
    `;
    document.getElementById('gestor-setor-select').addEventListener('change', async (e) => {
      setorAtual = e.target.value || null;
      await carregarPainelSetor();
    });
    setorAtual = null;
  } else {
    let me;
    try { me = await apiFetch('/usuarios/me'); } catch (e) { me = {}; }
    setorAtual = me.setorId || null;
    await carregarPainelSetor();
  }
}

async function carregarPainelSetor() {
  const listEl = document.getElementById('setor-progresso-list');
  const boardSelect = document.getElementById('board-select');
  boardSelect.innerHTML = '<option value="__self__">Minhas atividades</option>';
  atualizarProcessosFuncionario('__self__');

  if (!setorAtual) {
    listEl.innerHTML = '<div class="empty-state">Selecione um setor para ver o progresso da equipe.</div>';
    atividadesPorUid = {};
    funcionariosDoSetor = [];
    return;
  }

  listEl.innerHTML = '<div class="loading-state">Carregando progresso do setor...</div>';
  try {
    const [progresso, board] = await Promise.all([
      apiFetch(`/processos/setor/progresso?setorId=${encodeURIComponent(setorAtual)}`),
      apiFetch(`/processos/setor/atividades?setorId=${encodeURIComponent(setorAtual)}`)
    ]);
    funcionariosDoSetor = board.funcionarios || [];
    atividadesPorUid = board.atividadesPorUid || {};
    renderPainelSetor(progresso);

    funcionariosDoSetor
      .filter(f => f.uid !== currentUser.uid)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.uid;
        opt.textContent = f.name || f.email;
        boardSelect.appendChild(opt);
      });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Erro ao carregar painel: ${esc(err.message)}</div>`;
  }
}

function renderPainelSetor(progresso) {
  const listEl = document.getElementById('setor-progresso-list');
  listEl.innerHTML = '';

  if (!progresso.length) {
    listEl.innerHTML = '<div class="empty-state">Nenhum funcionário neste setor ainda.</div>';
    return;
  }

  progresso.forEach(p => {
    const pct = p.total > 0 ? Math.round((p.concluidas / p.total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'setor-progresso-row';
    row.innerHTML = `
      <div class="progress-ring" style="--pct:${pct}"><span>${pct}%</span></div>
      <div class="setor-progresso-info">
        <div class="setor-progresso-nome">${esc(p.nome || p.uid)}</div>
        <div class="setor-progresso-sub">${p.concluidas}/${p.total} concluídas</div>
      </div>
    `;
    listEl.appendChild(row);
  });
}

async function carregarMeuQuadro() {
  try {
    minhasAtividades = await apiFetch('/processos/atividades');
  } catch (err) {
    minhasAtividades = [];
  }
}

function renderBoard(uidSelecionado) {
  const editavel = uidSelecionado === '__self__';
  const atividades = editavel ? minhasAtividades : (atividadesPorUid[uidSelecionado] || []);

  ORDEM_STATUS.forEach(status => {
    const col = document.getElementById(`col-${status}`);
    col.innerHTML = '';
    col.dataset.editavel = editavel ? '1' : '0';
  });

  atividades
    .slice()
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
    .forEach(a => {
      const col = document.getElementById(`col-${a.status}`);
      if (col) col.appendChild(criarCard(a, editavel));
    });

  renderProgressoBoard(atividades);
  setupColumnDropTargets();
}

function renderProgressoBoard(atividades) {
  const el = document.getElementById('board-progresso');
  if (!atividades.length) { el.innerHTML = ''; return; }
  const concluidas = atividades.filter(a => a.status === 'concluido').length;
  const pct = Math.round((concluidas / atividades.length) * 100);
  el.innerHTML = `
    <div class="progress-ring" style="--pct:${pct}"><span>${pct}%</span></div>
    <div class="board-progresso-texto">${concluidas} de ${atividades.length} atividades concluídas</div>
  `;
}

function formatarPrazo(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function criarCard(atividade, editavel) {
  const card = document.createElement('div');
  const agora = new Date();
  const atrasada = atividade.status !== 'concluido' && atividade.prazo && agora > new Date(atividade.prazo);

  card.className = `kanban-card ${atrasada ? 'atrasada' : ''}`;
  card.draggable = editavel;
  card.dataset.id = atividade.id;

  const idx = ORDEM_STATUS.indexOf(atividade.status);

  card.innerHTML = `
    <div class="kanban-card-header">
      ${atividade.criadoPor !== atividade.uid ? `<span class="recorrencia-badge">De: ${esc(atividade.criadoPorNome || '—')}</span>` : '<span></span>'}
      ${atrasada ? '<span class="atrasada-badge">Atrasada</span>' : ''}
    </div>
    <div class="kanban-card-titulo">${esc(atividade.titulo)}</div>
    ${atividade.descricao ? `<div class="kanban-card-prazo">${esc(atividade.descricao)}</div>` : ''}
    ${atividade.prazo ? `<div class="kanban-card-prazo">Prazo: ${formatarPrazo(atividade.prazo)}</div>` : ''}
    ${editavel ? `
      <div class="kanban-card-actions">
        <button class="btn-mover btn-voltar" ${idx === 0 ? 'disabled' : ''} title="Voltar">‹</button>
        <span class="status-atual">${COL_LABEL[atividade.status]}</span>
        <button class="btn-mover btn-avancar" ${idx === ORDEM_STATUS.length - 1 ? 'disabled' : ''} title="Avançar">›</button>
        <button class="btn-mover btn-excluir-atividade" title="Excluir">🗑</button>
      </div>
    ` : ''}
  `;

  if (editavel) {
    card.addEventListener('dragstart', () => { draggedId = atividade.id; });
    const btnVoltar = card.querySelector('.btn-voltar');
    const btnAvancar = card.querySelector('.btn-avancar');
    const btnExcluir = card.querySelector('.btn-excluir-atividade');
    if (btnVoltar) btnVoltar.onclick = () => moverAtividade(atividade.id, ORDEM_STATUS[idx - 1]);
    if (btnAvancar) btnAvancar.onclick = () => moverAtividade(atividade.id, ORDEM_STATUS[idx + 1]);
    if (btnExcluir) btnExcluir.onclick = () => excluirAtividade(atividade.id, atividade.titulo);
  }

  return card;
}

// Colunas aceitam drop tanto para trocar de status quanto para reordenar
// (soltar entre dois cards já existentes na mesma coluna).
function setupColumnDropTargets() {
  ORDEM_STATUS.forEach(status => {
    const col = document.getElementById(`col-${status}`);
    if (col.dataset.editavel !== '1') return;
    const body = col;
    body.ondragover = (e) => e.preventDefault();
    body.ondrop = (e) => {
      e.preventDefault();
      if (!draggedId) return;

      const afterEl = [...body.querySelectorAll('.kanban-card')].find(el => {
        const rect = el.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2;
      });

      const atividade = minhasAtividades.find(a => a.id === draggedId);
      if (!atividade) return;

      if (atividade.status !== status) {
        moverAtividade(draggedId, status);
      } else {
        const idsNaColuna = minhasAtividades
          .filter(a => a.status === status)
          .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
          .map(a => a.id)
          .filter(id => id !== draggedId);
        const idxAfter = afterEl ? idsNaColuna.indexOf(afterEl.dataset.id) : -1;
        if (idxAfter === -1) idsNaColuna.push(draggedId);
        else idsNaColuna.splice(idxAfter, 0, draggedId);
        reordenarColuna(status, idsNaColuna);
      }
      draggedId = null;
    };
  });
}

async function moverAtividade(id, novoStatus) {
  try {
    await apiFetch(`/processos/atividades/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: novoStatus }) });
    await carregarMeuQuadro();
    renderBoard('__self__');
  } catch (err) {
    alert('Erro ao mover atividade: ' + err.message);
  }
}

async function excluirAtividade(id, titulo) {
  if (!confirm(`Excluir a atividade "${titulo}"?`)) return;
  try {
    await apiFetch(`/processos/atividades/${id}`, { method: 'DELETE' });
    await carregarMeuQuadro();
    renderBoard('__self__');
  } catch (err) {
    alert('Erro ao excluir atividade: ' + err.message);
  }
}

async function reordenarColuna(status, idsOrdenados) {
  // Atualiza localmente antes de confirmar no servidor para o drag parecer instantâneo
  idsOrdenados.forEach((id, i) => {
    const a = minhasAtividades.find(a => a.id === id);
    if (a) a.ordem = i;
  });
  renderBoard('__self__');
  try {
    await apiFetch('/processos/atividades/reordenar', { method: 'PUT', body: JSON.stringify({ status, ordenadas: idsOrdenados }) });
  } catch (err) {
    alert('Erro ao reordenar: ' + err.message);
    await carregarMeuQuadro();
    renderBoard('__self__');
  }
}

// ================================================================
//  MODAL: NOVA ATIVIDADE
// ================================================================
function abrirModalAtividade() {
  document.getElementById('form-atividade').reset();

  const wrap = document.getElementById('atividade-para-wrap');
  const select = document.getElementById('atividade-uid');
  if (souGestor && funcionariosDoSetor.length) {
    wrap.classList.remove('hidden');
    const boardSelect = document.getElementById('board-select');
    const selecionadoAtual = boardSelect ? boardSelect.value : '__self__';
    select.innerHTML = `<option value="${esc(currentUser.uid)}">Eu mesmo</option>` +
      funcionariosDoSetor
        .filter(f => f.uid !== currentUser.uid)
        .map(f => `<option value="${esc(f.uid)}">${esc(f.name || f.email)}</option>`).join('');
    select.value = (selecionadoAtual && selecionadoAtual !== '__self__') ? selecionadoAtual : currentUser.uid;
  } else {
    wrap.classList.add('hidden');
  }

  abrirModal('modal-atividade');
}

async function salvarAtividade(e) {
  e.preventDefault();
  const titulo = document.getElementById('atividade-titulo').value.trim();
  const descricao = document.getElementById('atividade-descricao').value.trim();
  const prazoInput = document.getElementById('atividade-prazo').value;
  const uidSelect = document.getElementById('atividade-uid');

  if (!titulo) return;

  const data = {
    titulo,
    descricao,
    prazo: prazoInput ? new Date(prazoInput).toISOString() : null
  };
  if (souGestor && uidSelect && !document.getElementById('atividade-para-wrap').classList.contains('hidden')) {
    data.uid = uidSelect.value;
  }

  try {
    await secureAction(currentUser.uid, async () => {
      await apiFetch('/processos/atividades', { method: 'POST', body: JSON.stringify(data) });
    });
    fecharModal('modal-atividade');
    if (data.uid && data.uid !== currentUser.uid) {
      await carregarPainelSetor();
      const boardSelect = document.getElementById('board-select');
      if (boardSelect) {
        boardSelect.value = data.uid;
        renderBoard(data.uid);
        atualizarProcessosFuncionario(data.uid);
      }
    } else {
      await carregarMeuQuadro();
      renderBoard('__self__');
    }
  } catch (err) {
    if (err.message.includes("Rate limit")) return;
    alert("Erro ao salvar atividade: " + err.message);
  }
}

// ================================================================
//  HELPERS & EVENTS
// ================================================================
function setupEventListeners() {
  document.getElementById('btn-nova-atividade').onclick = () => abrirModalAtividade();
  document.getElementById('form-atividade').onsubmit = salvarAtividade;
}

window.abrirModal = (id) => document.getElementById(id).classList.add('active');
window.fecharModal = (id) => document.getElementById(id).classList.remove('active');
