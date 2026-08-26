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
// Lista de "todo mundo" pra delegar atividade — qualquer funcionário pode
// atribuir tarefa pra qualquer outro, não só gestor pro próprio setor.
// Buscada só na primeira vez que abre "Nova Atividade" (sob demanda), cacheada.
let todasPessoas = null;

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
        //
        // Não dá pra confiar em `souGestor`/`setorAtual` aqui — essa branch
        // pode disparar ANTES do initApp() do carregamento rápido (fast path
        // do cache, lá em cima) terminar de setar essas variáveis, já que os
        // dois rodam em paralelo. Resultado: numa recarga de página (F5), às
        // vezes essa branch corria primeiro, achava souGestor/setorAtual
        // ainda vazios e nunca chamava carregarPainelSetor()/carregarAvisos()
        // — Painel do Setor e Quadro de Avisos sumiam até deslogar e logar de
        // novo. Recalcula tudo de novo aqui, sem depender do outro fluxo.
        souGestor = ['chefe_setor', 'adm_l1', 'adm_l2'].includes(role);
        document.getElementById('gestor-panel')?.classList.toggle('hidden', !souGestor);
        document.getElementById('aviso-composer')?.classList.toggle('hidden', !souGestor);
        if (souGestor) {
          await setupSetorScope(role);
        } else {
          await carregarAvisos();
        }
        await carregarMeuQuadro();
        const boardSelect = document.getElementById('board-select');
        renderBoard(boardSelect ? boardSelect.value : '__self__');
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

  souGestor = ['chefe_setor', 'adm_l1', 'adm_l2'].includes(role);
  setupComposerAviso();
  if (souGestor) {
    document.getElementById('gestor-panel').classList.remove('hidden');
    document.getElementById('aviso-composer').classList.remove('hidden');
    await setupSetorScope(role);
  } else {
    await carregarAvisos();
  }

  document.getElementById('board-select').addEventListener('change', (e) => {
    renderBoard(e.target.value);
  });
  await carregarMeuQuadro();
  renderBoard('__self__');
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

// ================================================================
//  QUADRO DE AVISOS (mural de post-its do setor)
// ================================================================
const CORES_AVISO = ['amarelo', 'rosa', 'azul', 'verde', 'laranja'];
let corAvisoSelecionada = CORES_AVISO[0];

function setupComposerAviso() {
  const wrap = document.getElementById('aviso-cor-opcoes');
  if (!wrap) return;
  wrap.innerHTML = CORES_AVISO.map(c => `<span class="aviso-cor-swatch ${c === corAvisoSelecionada ? 'selecionada' : ''}" data-cor="${c}" title="${c}"></span>`).join('');
  wrap.querySelectorAll('.aviso-cor-swatch').forEach(el => el.addEventListener('click', () => {
    corAvisoSelecionada = el.dataset.cor;
    wrap.querySelectorAll('.aviso-cor-swatch').forEach(s => s.classList.toggle('selecionada', s.dataset.cor === corAvisoSelecionada));
  }));
  document.getElementById('btn-publicar-aviso')?.addEventListener('click', publicarAviso);
}

async function carregarAvisos() {
  const secao = document.getElementById('avisos-section');
  const mural = document.getElementById('avisos-mural');
  if (!secao || !mural) return;
  secao.classList.remove('hidden');

  // Gestor sem setor escolhido ainda não tem o que buscar — evita mandar
  // requisição à toa (mesma lógica do Painel do Setor).
  if (souGestor && !setorAtual) {
    mural.innerHTML = '<div class="empty-state">Selecione um setor acima pra ver e publicar avisos.</div>';
    return;
  }

  mural.innerHTML = '<div class="loading-state">Carregando avisos...</div>';
  try {
    const params = (souGestor && setorAtual) ? `?setorId=${encodeURIComponent(setorAtual)}` : '';
    const avisos = await apiFetch(`/processos/avisos${params}`);
    renderAvisos(avisos);
  } catch (err) {
    mural.innerHTML = `<div class="empty-state">Erro ao carregar avisos: ${esc(err.message)}</div>`;
  }
}

function renderAvisos(avisos) {
  const mural = document.getElementById('avisos-mural');
  if (!avisos.length) {
    mural.innerHTML = '<div class="empty-state">Nenhum aviso publicado pra esse setor ainda.</div>';
    return;
  }
  mural.innerHTML = avisos.map((a, i) => {
    const tilt = (i % 2 === 0 ? -1 : 1) * (2 + (i % 3));
    const podeExcluir = a.autorUid === currentUser.uid || souAdmin();
    const data = new Date(a.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `
      <div class="aviso-card" data-cor="${esc(a.cor)}" style="--tilt:${tilt}deg;">
        <div class="aviso-card-texto">${esc(a.texto)}</div>
        <div class="aviso-card-footer">
          <span>${esc(a.autorNome)} · ${data}</span>
          ${podeExcluir ? `<button type="button" class="aviso-card-excluir" data-id="${a.id}" title="Remover aviso">🗑</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  mural.querySelectorAll('.aviso-card-excluir').forEach(btn => btn.addEventListener('click', () => excluirAviso(btn.dataset.id)));
}

function souAdmin() {
  return currentRole === 'adm_l1' || currentRole === 'adm_l2';
}

async function publicarAviso() {
  const texto = document.getElementById('aviso-texto').value.trim();
  if (!texto) return;
  const btn = document.getElementById('btn-publicar-aviso');
  btn.disabled = true;
  try {
    const params = setorAtual ? `?setorId=${encodeURIComponent(setorAtual)}` : '';
    await apiFetch(`/processos/avisos${params}`, { method: 'POST', body: JSON.stringify({ texto, cor: corAvisoSelecionada }) });
    document.getElementById('aviso-texto').value = '';
    await carregarAvisos();
  } catch (err) {
    alert('Erro ao publicar aviso: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function excluirAviso(id) {
  if (!confirm('Remover esse aviso do mural?')) return;
  try {
    await apiFetch(`/processos/avisos/${id}`, { method: 'DELETE' });
    await carregarAvisos();
  } catch (err) {
    alert('Erro ao remover aviso: ' + err.message);
  }
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

    // ADM que também é chefe de um setor específico (ex.: TI) já abre no
    // próprio setor por padrão, igual antes de virar ADM — só que aqui,
    // diferente do Chefe de Setor puro, o select continua liberado pra
    // trocar pra qualquer outro setor quando precisar.
    let me;
    try { me = await apiFetch('/usuarios/me'); } catch (e) { me = {}; }
    setorAtual = me.setorId || null;
    if (setorAtual) {
      document.getElementById('gestor-setor-select').value = setorAtual;
      await carregarPainelSetor();
    }
  } else {
    let me;
    try { me = await apiFetch('/usuarios/me'); } catch (e) { me = {}; }
    setorAtual = me.setorId || null;
    await carregarPainelSetor();
  }
}

async function carregarPainelSetor() {
  await carregarAvisos();

  const listEl = document.getElementById('setor-progresso-list');
  const boardSelect = document.getElementById('board-select');
  boardSelect.innerHTML = '<option value="__self__">Minhas atividades</option>';

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
    row.title = 'Clique para ver as atividades desta pessoa';
    row.innerHTML = `
      <div class="progress-ring" style="--pct:${pct}"><span>${pct}%</span></div>
      <div class="setor-progresso-info">
        <div class="setor-progresso-nome">${esc(p.nome || p.uid)}</div>
        <div class="setor-progresso-sub">${p.concluidas}/${p.total} concluídas</div>
      </div>
    `;
    row.addEventListener('click', () => verQuadroDe(p.uid));
    listEl.appendChild(row);
  });
}

// Abre o quadro Kanban (A Fazer / Fazendo / Concluído) dessa pessoa a partir
// do clique no cartão dela no Painel do Setor — mesmo mecanismo do combo
// "Ver quadro de" acima do quadro, só que disparado pelo card em vez do select.
function verQuadroDe(uid) {
  const boardSelect = document.getElementById('board-select');
  const valor = uid === currentUser.uid ? '__self__' : uid;
  if (![...boardSelect.options].some(o => o.value === valor)) return;
  boardSelect.value = valor;
  renderBoard(valor);
  atualizarProcessosFuncionario(valor);
  document.querySelector('.activities-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function carregarMeuQuadro() {
  try {
    minhasAtividades = await apiFetch('/processos/atividades');
  } catch (err) {
    minhasAtividades = [];
  }
}

// Atualiza os dados por trás do quadro que está aberto na tela — o próprio
// (minhasAtividades) ou o de um colaborador (atividadesPorUid), sem resetar
// a seleção do combo "Ver quadro de" nem o painel de progresso inteiro.
async function recarregarQuadroAtual() {
  if (boardAtual === '__self__') {
    await carregarMeuQuadro();
    return;
  }
  if (!setorAtual) return;
  try {
    const board = await apiFetch(`/processos/setor/atividades?setorId=${encodeURIComponent(setorAtual)}`);
    funcionariosDoSetor = board.funcionarios || [];
    atividadesPorUid = board.atividadesPorUid || {};
  } catch (err) {}
}

let boardAtual = '__self__';

function renderBoard(uidSelecionado) {
  boardAtual = uidSelecionado;
  const ehMeuBoard = uidSelecionado === '__self__';
  // Chefe de Setor/ADM também pode arrastar (reagendar) e mudar status das
  // atividades da própria equipe, não só ver — o quadro de outra pessoa só
  // aparece pra quem é gestor do setor dela (Painel do Setor/combo já filtram
  // isso), então chegar aqui com uidSelecionado != '__self__' já implica gestão.
  const editavel = ehMeuBoard || souGestor;
  const atividades = ehMeuBoard ? minhasAtividades : (atividadesPorUid[uidSelecionado] || []);

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
    doDia.forEach(a => body.appendChild(criarCard(a, editavel)));

    if (editavel) {
      col.querySelector('.btn-add-dia').onclick = () => abrirModalAtividade({ diaPreset: dia });
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
  const f = funcionariosDoSetor.find(f => f.uid === uid) || (todasPessoas || []).find(p => p.uid === uid);
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

  const coletiva = Array.isArray(atividade.atribuidos);
  const souAtribuidoLocal = atividade.uid === currentUser.uid || (coletiva && atividade.atribuidos.includes(currentUser.uid));

  let etiqueta = '';
  if (coletiva) {
    const nomes = atividade.atribuidos.map(uid => uid === currentUser.uid ? 'Eu' : nomePorUid(uid));
    etiqueta = `<span class="recorrencia-badge" title="Atividade coletiva — todo mundo vê o mesmo histórico">👥 ${esc(nomes.join(', '))}</span>`;
  } else if (atividade.uid !== currentUser.uid) {
    etiqueta = `<span class="recorrencia-badge">Para: ${esc(nomePorUid(atividade.uid))}</span>`;
  } else if (atividade.criadoPor !== atividade.uid) {
    etiqueta = `<span class="recorrencia-badge">De: ${esc(atividade.criadoPorNome || '—')}</span>`;
  }

  // Excluir é mais restrito que editar/mover: quem só é atribuído a uma
  // atividade que outra pessoa criou não pode excluir direto — só quem
  // criou (pra si ou delegando) ou o gestor vendo o quadro do setor dele.
  const podeExcluir = editavel && (atividade.criadoPor === currentUser.uid || boardAtual !== '__self__');

  // Quem está atribuído pode ACRESCENTAR uma entrada no histórico de
  // andamento (nunca sobrescrever/apagar as de outra pessoa) — é assim que
  // dá pra saber, numa atividade dividida entre turnos, onde cada um parou:
  // "Junior: fiz até Agronomia", depois "Maria: terminei o resto". Quem só
  // está gerenciando (gestor vendo o card de outra pessoa) vê o histórico
  // completo, mas em modo leitura.
  const podeAndamentoInline = editavel && souAtribuidoLocal;
  const historico = Array.isArray(atividade.historico) ? atividade.historico : [];

  const historicoHtml = historico.length ? `
    <div class="kanban-card-historico">
      ${historico.map(h => `
        <div class="historico-item">
          <strong>${esc(h.autorNome || 'Alguém')}:</strong> ${esc(h.texto)}
          <span class="historico-data">${formatarHorario(h.criadoEm)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  card.innerHTML = `
    <div class="kanban-card-header">
      <span class="kanban-card-horario">${atividade.prazo ? formatarHorario(atividade.prazo) : ''}</span>
      ${etiqueta}
      ${atrasada ? '<span class="atrasada-badge">Atrasada</span>' : ''}
    </div>
    <div class="kanban-card-titulo">${esc(atividade.titulo)}</div>
    ${atividade.descricao ? `<div class="kanban-card-prazo">${esc(atividade.descricao)}</div>` : ''}
    ${historicoHtml}
    ${editavel ? `
      <div class="kanban-card-actions">
        <select class="status-select">
          ${ORDEM_STATUS.map(s => `<option value="${s}" ${s === atividade.status ? 'selected' : ''}>${COL_LABEL[s]}</option>`).join('')}
        </select>
        <button class="btn-mover btn-editar-atividade" title="Editar">✎</button>
        ${podeExcluir ? '<button class="btn-mover btn-excluir-atividade" title="Excluir">🗑</button>' : '<span class="btn-excluir-bloqueado" title="Atribuída por outra pessoa — peça pra ela excluir">🔒</span>'}
      </div>
      ${podeAndamentoInline ? `
        <div class="kanban-card-andamento-edit">
          <textarea class="andamento-input" rows="2" placeholder="Contar como está o andamento..."></textarea>
          <button type="button" class="btn btn-secondary btn-sm btn-salvar-andamento">Adicionar ao histórico</button>
        </div>
      ` : ''}
    ` : `<div class="kanban-card-actions"><span class="status-atual">${COL_LABEL[atividade.status]}</span></div>`}
  `;

  if (editavel) {
    card.addEventListener('dragstart', () => { draggedId = atividade.id; });
    card.querySelector('.status-select').onchange = (e) => moverAtividade(atividade.id, e.target.value);
    card.querySelector('.btn-editar-atividade').onclick = () => abrirModalAtividade({ editar: atividade });
    if (podeExcluir) card.querySelector('.btn-excluir-atividade').onclick = () => excluirAtividade(atividade.id, atividade.titulo);
    if (podeAndamentoInline) {
      const textarea = card.querySelector('.andamento-input');
      textarea.draggable = false;
      textarea.addEventListener('mousedown', (e) => e.stopPropagation()); // não deixa o drag do card "roubar" o clique de selecionar texto
      card.querySelector('.btn-salvar-andamento').onclick = () => adicionarAndamento(atividade.id, textarea.value.trim());
    }
  }

  return card;
}

async function adicionarAndamento(id, texto) {
  if (!texto) return;
  try {
    await apiFetch(`/processos/atividades/${id}/andamento`, { method: 'POST', body: JSON.stringify({ texto }) });
    await recarregarQuadroAtual();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao adicionar andamento: ' + err.message);
  }
}

async function moverAtividade(id, novoStatus) {
  try {
    await apiFetch(`/processos/atividades/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: novoStatus }) });
    await recarregarQuadroAtual();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao mover atividade: ' + err.message);
  }
}

async function excluirAtividade(id, titulo) {
  if (!confirm(`Excluir a atividade "${titulo}"?`)) return;
  try {
    await apiFetch(`/processos/atividades/${id}`, { method: 'DELETE' });
    await recarregarQuadroAtual();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao excluir atividade: ' + err.message);
  }
}

// Arrastou o card pra outro dia: troca a data, mantendo o horário original.
async function reagendarAtividade(id, novoDia) {
  const origem = boardAtual === '__self__' ? minhasAtividades : (atividadesPorUid[boardAtual] || []);
  const atividade = origem.find(a => a.id === id);
  if (!atividade || !atividade.prazo) return;
  const original = new Date(atividade.prazo);
  const novaData = new Date(novoDia);
  novaData.setHours(original.getHours(), original.getMinutes(), 0, 0);

  // Quem só é dono (não foi quem atribuiu) só pode antecipar o prazo de uma
  // atividade atribuída por outra pessoa, nunca adiar — checagem local pra
  // já avisar na hora, o backend também barra por segurança.
  const souApenasDono = atividade.uid === currentUser.uid && atividade.criadoPor !== atividade.uid;
  if (souApenasDono && novaData > original) {
    alert('Essa atividade foi atribuída por outra pessoa — você só pode antecipar o prazo, não adiar. Peça mais prazo pra quem atribuiu.');
    return;
  }

  try {
    await apiFetch(`/processos/atividades/${id}`, { method: 'PUT', body: JSON.stringify({ prazo: novaData.toISOString() }) });
    await recarregarQuadroAtual();
    renderBoard(boardAtual);
  } catch (err) {
    alert('Erro ao reagendar: ' + err.message);
  }
}

// ================================================================
//  MODAL: NOVA ATIVIDADE
// ================================================================
let editandoId = null;

async function abrirModalAtividade({ diaPreset = null, editar = null } = {}) {
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
  const lista = document.getElementById('atividade-uid-lista');
  const boardSelect = document.getElementById('board-select');
  const selecionadoAtual = boardSelect ? boardSelect.value : '__self__';

  const marcarCheckbox = (uid, marcado) => {
    const cb = lista.querySelector(`input[value="${CSS.escape(uid)}"]`);
    if (cb) cb.checked = marcado;
  };

  if (!editar) {
    wrap.classList.remove('hidden');
    lista.innerHTML = `<label><input type="checkbox" value="${esc(currentUser.uid)}" checked> Eu mesmo</label>`;
  } else {
    wrap.classList.add('hidden');
  }

  abrirModal('modal-atividade');

  // Gestor com um setor selecionado (Painel do Setor) vê só a equipe DESSE
  // setor pra atribuir — é o caso mais comum e uma lista com a escola
  // inteira misturada só atrapalha. Fora desse contexto (funcionário comum,
  // ou gestor sem setor escolhido ainda), mostra todo mundo — é o caso de
  // "preciso pedir uma coisa específica pra alguém fora da minha área".
  if (!editar) {
    const listaSetor = souGestor && setorAtual && funcionariosDoSetor.length;
    if (!listaSetor && !todasPessoas) {
      try { todasPessoas = await apiFetch('/processos/pessoas'); } catch (e) { todasPessoas = []; }
    }
    if (editandoId !== null || !document.getElementById('modal-atividade').classList.contains('active')) return; // modal fechado ou trocou pra edição nesse meio-tempo

    const pessoas = listaSetor ? funcionariosDoSetor : (todasPessoas || []);
    lista.innerHTML = `<label><input type="checkbox" value="${esc(currentUser.uid)}"> Eu mesmo</label>` +
      pessoas
        .filter(p => p.uid !== currentUser.uid)
        .map(p => `<label><input type="checkbox" value="${esc(p.uid)}"> ${esc(p.name || p.email)}</label>`).join('');

    // Pré-marca conforme o contexto: vendo o quadro de alguém (gestor) marca
    // essa pessoa; senão marca "Eu mesmo" — mas continua sendo só sugestão,
    // dá pra marcar mais gente.
    if (souGestor && selecionadoAtual !== '__self__' && pessoas.some(p => p.uid === selecionadoAtual)) {
      marcarCheckbox(selecionadoAtual, true);
    } else {
      marcarCheckbox(currentUser.uid, true);
    }
  }
}

async function salvarAtividade(e) {
  e.preventDefault();
  const titulo = document.getElementById('atividade-titulo').value.trim();
  const descricao = document.getElementById('atividade-descricao').value.trim();
  const prazoInput = document.getElementById('atividade-prazo').value;

  if (!titulo) return;
  if (!prazoInput) { alert('Informe o dia e horário da atividade.'); return; }

  const data = {
    titulo,
    descricao,
    prazo: new Date(prazoInput).toISOString()
  };
  if (!editandoId && !document.getElementById('atividade-para-wrap').classList.contains('hidden')) {
    const uids = [...document.querySelectorAll('#atividade-uid-lista input[type="checkbox"]:checked')].map(cb => cb.value);
    if (!uids.length) { alert('Marque pelo menos uma pessoa em "Para".'); return; }
    data.uids = uids;
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
    if (boardAtual !== '__self__') {
      // Editando/arrastando/movendo enquanto o quadro aberto é de um
      // colaborador — só recarrega os dados do setor, sem trocar de quadro.
      await recarregarQuadroAtual();
      renderBoard(boardAtual);
    } else if (souGestor && data.uids && data.uids.some(uid => uid !== currentUser.uid)) {
      // Sou gestor e criei uma atividade nova PARA uma ou mais pessoas a
      // partir do meu próprio quadro — troca pro quadro da primeira delas
      // pra já mostrar o resultado (só faz sentido pra gestor, que tem o
      // Painel do Setor/board-select com outras pessoas; funcionário comum
      // delegando pra fora do seu alcance de gestão não tem quadro alheio
      // pra abrir, então fica no seu).
      const outroUid = data.uids.find(uid => uid !== currentUser.uid);
      await carregarPainelSetor();
      const boardSelect = document.getElementById('board-select');
      if (boardSelect && [...boardSelect.options].some(o => o.value === outroUid)) {
        boardSelect.value = outroUid;
        renderBoard(outroUid);
        atualizarProcessosFuncionario(outroUid);
      } else {
        renderBoard(boardAtual);
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
