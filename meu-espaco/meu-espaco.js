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
//  MINHAS ATIVIDADES (AGENDA SEMANAL — tarefas avulsas)
// ================================================================
const COL_LABEL = { a_fazer: 'A Fazer', fazendo: 'Fazendo', concluido: 'Concluído' };
const ORDEM_STATUS = ['a_fazer', 'fazendo', 'concluido'];
const DIA_LABEL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

let semanaOffset = 0;

function segundaDaSemana(offset) {
  const hoje = new Date();
  const dia = hoje.getDay(); // 0=Dom..6=Sáb
  const diffPraSegunda = (dia === 0 ? -6 : 1) - dia;
  const segunda = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + diffPraSegunda + offset * 7);
  segunda.setHours(0, 0, 0, 0);
  return segunda;
}

function diasDaSemana(offset) {
  const segunda = segundaDaSemana(offset);
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(segunda);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function chaveDia(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

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

    document.getElementById('agenda-setor-wrap').classList.remove('hidden');
    renderAgendaSetor();
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Erro ao carregar painel: ${esc(err.message)}</div>`;
  }
}

// Visão geral do setor: todo mundo, dia a dia, na mesma semana do quadro
// pessoal abaixo — pra ver de relance quem tem o quê marcado em cada dia.
function renderAgendaSetor() {
  const el = document.getElementById('agenda-setor');
  const dias = diasDaSemana(semanaOffset);
  const fmtCurto = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  el.innerHTML = '';
  dias.forEach(dia => {
    const chave = chaveDia(dia);
    const hoje = chaveDia(new Date()) === chave;

    const porPessoa = funcionariosDoSetor.map(f => {
      const itens = (atividadesPorUid[f.uid] || [])
        .filter(a => a.prazo && a.status !== 'concluido' && chaveDia(new Date(a.prazo)) === chave)
        .sort((a, b) => new Date(a.prazo) - new Date(b.prazo));
      return { nome: f.name || f.email, itens };
    }).filter(p => p.itens.length);

    const col = document.createElement('div');
    col.className = 'agenda-dia agenda-setor-dia';
    col.innerHTML = `
      <h3 class="agenda-dia-title ${hoje ? 'agenda-dia-hoje' : ''}">${DIA_LABEL[dia.getDay()]} <span>${fmtCurto(dia)}</span></h3>
      <div class="agenda-dia-body">
        ${porPessoa.length ? porPessoa.map(p => `
          <div class="agenda-setor-pessoa">
            <strong>${esc(p.nome)}</strong>
            ${p.itens.map(a => `<div class="agenda-setor-item">${formatarHorario(a.prazo)} — ${esc(a.titulo)}</div>`).join('')}
          </div>
        `).join('') : '<div class="empty-state" style="padding:1rem;">Nada marcado</div>'}
      </div>
    `;
    el.appendChild(col);
  });
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

let boardAtual = '__self__';

function renderBoard(uidSelecionado) {
  boardAtual = uidSelecionado;
  const editavel = uidSelecionado === '__self__';
  const atividades = editavel ? minhasAtividades : (atividadesPorUid[uidSelecionado] || []);

  const dias = diasDaSemana(semanaOffset);
  const primeiro = dias[0], ultimo = dias[4];
  const fmtCurto = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  document.getElementById('agenda-semana-label').textContent =
    semanaOffset === 0 ? `Esta semana (${fmtCurto(primeiro)} a ${fmtCurto(ultimo)})` : `${fmtCurto(primeiro)} a ${fmtCurto(ultimo)}`;

  const comData = atividades.filter(a => a.prazo);
  const semData = atividades.length - comData.length;
  const pendentes = comData.filter(a => a.status !== 'concluido');

  const porDia = {};
  pendentes.forEach(a => {
    const chave = chaveDia(new Date(a.prazo));
    if (!porDia[chave]) porDia[chave] = [];
    porDia[chave].push(a);
  });

  const agendaEl = document.getElementById('agenda-semana');
  agendaEl.innerHTML = '';
  dias.forEach(dia => {
    const chave = chaveDia(dia);
    const doDia = (porDia[chave] || []).sort((a, b) => new Date(a.prazo) - new Date(b.prazo));

    const col = document.createElement('div');
    col.className = 'agenda-dia';
    col.dataset.chave = chave;
    col.dataset.editavel = editavel ? '1' : '0';

    const hoje = chaveDia(new Date()) === chave;
    col.innerHTML = `
      <h3 class="agenda-dia-title ${hoje ? 'agenda-dia-hoje' : ''}">${DIA_LABEL[dia.getDay()]} <span>${fmtCurto(dia)}</span></h3>
      <div class="agenda-dia-body"></div>
      ${editavel ? '<button type="button" class="btn-add-dia" title="Nova atividade nesse dia">+ atividade</button>' : ''}
    `;
    const body = col.querySelector('.agenda-dia-body');
    doDia.forEach(a => body.appendChild(criarCard(a, editavel && a.uid === currentUser.uid)));

    if (editavel) {
      col.querySelector('.btn-add-dia').onclick = () => abrirModalAtividade(dia);
      col.ondragover = (e) => e.preventDefault();
      col.ondrop = (e) => {
        e.preventDefault();
        if (!draggedId) return;
        reagendarAtividade(draggedId, dia);
        draggedId = null;
      };
    }

    agendaEl.appendChild(col);
  });

  const avisoEl = document.getElementById('agenda-sem-data-aviso');
  if (semData > 0) {
    avisoEl.classList.remove('hidden');
    avisoEl.textContent = `${semData} atividade(s) antiga(s) sem data cadastrada não aparecem na agenda.`;
  } else {
    avisoEl.classList.add('hidden');
  }

  renderProgressoBoard(editavel ? comData.filter(a => a.uid === currentUser.uid) : comData);
  renderConcluidas(atividades.filter(a => a.status === 'concluido'), editavel);
}

// Início do período (semana/mês/semestre/ano) contado a partir de hoje —
// é sempre relativo a "agora", independe da semana que está navegando na agenda.
function inicioDoPeriodo(periodo) {
  const hoje = new Date();
  switch (periodo) {
    case 'semana': return segundaDaSemana(0);
    case 'mes': return new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    case 'semestre': return new Date(hoje.getFullYear(), hoje.getMonth() < 6 ? 0 : 6, 1);
    case 'ano': return new Date(hoje.getFullYear(), 0, 1);
    default: return null;
  }
}

function renderConcluidas(concluidasTodas, editavel) {
  const periodo = document.getElementById('concluidas-periodo').value;
  const inicio = inicioDoPeriodo(periodo);
  const concluidas = inicio
    ? concluidasTodas.filter(a => new Date(a.concluidoEm || a.updatedAt) >= inicio)
    : concluidasTodas;

  document.getElementById('concluidas-contador').textContent = concluidas.length;
  const el = document.getElementById('agenda-concluidas');

  concluidas.sort((a, b) => new Date(b.concluidoEm || b.updatedAt) - new Date(a.concluidoEm || a.updatedAt));
  el.innerHTML = '';
  if (!concluidas.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma atividade concluída nesse período.</div>';
    return;
  }
  concluidas.forEach(a => el.appendChild(criarCard(a, editavel && a.uid === currentUser.uid)));
}

function renderProgressoBoard(atividades) {
  const el = document.getElementById('board-progresso');
  if (!atividades.length) { el.innerHTML = ''; return; }
  const concluidas = atividades.filter(a => a.status === 'concluido').length;
  const pct = Math.round((concluidas / atividades.length) * 100);
  el.innerHTML = `
    <div class="progress-ring" style="--pct:${pct}"><span>${pct}%</span></div>
    <div class="board-progresso-texto">${concluidas} de ${atividades.length} atividades concluídas nesta semana</div>
  `;
}

function nomePorUid(uid) {
  const f = funcionariosDoSetor.find(f => f.uid === uid);
  return f ? (f.name || f.email) : 'outra pessoa';
}

function formatarHorario(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function criarCard(atividade, editavel) {
  const card = document.createElement('div');
  const agora = new Date();
  const atrasada = atividade.status !== 'concluido' && atividade.prazo && agora > new Date(atividade.prazo);

  card.className = `kanban-card ${atrasada ? 'atrasada' : ''}`;
  card.draggable = editavel;
  card.dataset.id = atividade.id;
  card.dataset.status = atividade.status;

  const souDono = atividade.uid === currentUser.uid;
  let etiqueta = '';
  if (!souDono) {
    etiqueta = `<span class="recorrencia-badge">Para: ${esc(nomePorUid(atividade.uid))}</span>`;
  } else if (atividade.criadoPor !== atividade.uid) {
    etiqueta = `<span class="recorrencia-badge">De: ${esc(atividade.criadoPorNome || '—')}</span>`;
  }

  card.innerHTML = `
    <div class="kanban-card-header">
      <span class="kanban-card-horario">${atividade.prazo ? formatarHorario(atividade.prazo) : ''}</span>
      ${etiqueta}
      ${atrasada ? '<span class="atrasada-badge">Atrasada</span>' : ''}
    </div>
    <div class="kanban-card-titulo">${esc(atividade.titulo)}</div>
    ${atividade.descricao ? `<div class="kanban-card-prazo">${esc(atividade.descricao)}</div>` : ''}
    ${editavel ? `
      <div class="kanban-card-actions">
        <select class="status-select">
          ${ORDEM_STATUS.map(s => `<option value="${s}" ${s === atividade.status ? 'selected' : ''}>${COL_LABEL[s]}</option>`).join('')}
        </select>
        <button class="btn-mover btn-editar-atividade" title="Editar">✎</button>
        <button class="btn-mover btn-excluir-atividade" title="Excluir">🗑</button>
      </div>
    ` : `<div class="kanban-card-actions"><span class="status-atual">${COL_LABEL[atividade.status]}</span></div>`}
  `;

  if (editavel) {
    card.addEventListener('dragstart', () => { draggedId = atividade.id; });
    card.querySelector('.status-select').onchange = (e) => moverAtividade(atividade.id, e.target.value);
    card.querySelector('.btn-editar-atividade').onclick = () => abrirModalAtividade({ editar: atividade });
    card.querySelector('.btn-excluir-atividade').onclick = () => excluirAtividade(atividade.id, atividade.titulo);
  }

  return card;
}

async function moverAtividade(id, novoStatus) {
  try {
    await apiFetch(`/processos/atividades/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: novoStatus }) });
    await carregarMeuQuadro();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao mover atividade: ' + err.message);
  }
}

async function excluirAtividade(id, titulo) {
  if (!confirm(`Excluir a atividade "${titulo}"?`)) return;
  try {
    await apiFetch(`/processos/atividades/${id}`, { method: 'DELETE' });
    await carregarMeuQuadro();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao excluir atividade: ' + err.message);
  }
}

// Arrastou o card pra outro dia: troca a data, mantendo o horário original.
async function reagendarAtividade(id, novoDia) {
  const atividade = minhasAtividades.find(a => a.id === id);
  if (!atividade || !atividade.prazo) return;
  const original = new Date(atividade.prazo);
  const novaData = new Date(novoDia);
  novaData.setHours(original.getHours(), original.getMinutes(), 0, 0);

  try {
    await apiFetch(`/processos/atividades/${id}`, { method: 'PUT', body: JSON.stringify({ prazo: novaData.toISOString() }) });
    await carregarMeuQuadro();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao reagendar: ' + err.message);
  }
}

// ================================================================
//  MODAL: NOVA ATIVIDADE
// ================================================================
let editandoId = null;

function abrirModalAtividade({ diaPreset = null, editar = null } = {}) {
  document.getElementById('form-atividade').reset();
  editandoId = editar ? editar.id : null;

  document.getElementById('atividade-modal-title').textContent = editar ? 'Editar Atividade' : 'Nova Atividade';

  const prazoInput = document.getElementById('atividade-prazo');
  const preencherPrazo = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    prazoInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  if (editar) {
    document.getElementById('atividade-titulo').value = editar.titulo || '';
    document.getElementById('atividade-descricao').value = editar.descricao || '';
    if (editar.prazo) preencherPrazo(editar.prazo);
  } else if (diaPreset) {
    const d = new Date(diaPreset);
    d.setHours(9, 0, 0, 0);
    preencherPrazo(d);
  }

  const wrap = document.getElementById('atividade-para-wrap');
  const select = document.getElementById('atividade-uid');
  if (!editar && souGestor && funcionariosDoSetor.length) {
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
  if (!prazoInput) { alert('Informe o dia e horário da atividade.'); return; }

  const data = {
    titulo,
    descricao,
    prazo: new Date(prazoInput).toISOString()
  };
  if (!editandoId && souGestor && uidSelect && !document.getElementById('atividade-para-wrap').classList.contains('hidden')) {
    data.uid = uidSelect.value;
  }

  try {
    await secureAction(currentUser.uid, async () => {
      if (editandoId) {
        await apiFetch(`/processos/atividades/${editandoId}`, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        await apiFetch('/processos/atividades', { method: 'POST', body: JSON.stringify(data) });
      }
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
      renderBoard(boardAtual);
    }
  } catch (err) {
    if (err.message.includes("Rate limit")) return;
    alert("Erro ao salvar atividade: " + err.message);
  }
}

// ================================================================
//  HELPERS & EVENTS
// ================================================================
function mudarSemana(delta) {
  semanaOffset += delta;
  renderBoard(boardAtual);
  if (souGestor && setorAtual) renderAgendaSetor();
}

function setupEventListeners() {
  document.getElementById('btn-nova-atividade').onclick = () => abrirModalAtividade();
  document.getElementById('form-atividade').onsubmit = salvarAtividade;
  document.getElementById('btn-semana-anterior').onclick = () => mudarSemana(-1);
  document.getElementById('btn-semana-proxima').onclick = () => mudarSemana(1);
  document.getElementById('btn-toggle-concluidas').onclick = () => {
    document.getElementById('agenda-concluidas').classList.toggle('hidden');
    document.getElementById('concluidas-periodo').classList.toggle('hidden');
  };
  document.getElementById('concluidas-periodo').addEventListener('change', () => renderBoard(boardAtual));
}

window.abrirModal = (id) => document.getElementById(id).classList.add('active');
window.fecharModal = (id) => document.getElementById(id).classList.remove('active');
