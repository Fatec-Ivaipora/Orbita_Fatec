// ================================================================
//  ÓRBITA — MÓDULO CARGA HORÁRIA (RH)
//  Tela única: Lançar Horário · Recessos & Feriados · Extrato
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { getEffectiveLevel } from "../../core/permissions.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

async function apiFetch(endpoint, options = {}) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') {
    token = await currentUser.getIdToken();
  } else if (auth.currentUser) {
    token = await auth.currentUser.getIdToken();
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    let msg = `Erro na API: ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---- Estado global ----
let currentUser      = null;
let allFuncionarios  = [];
let funcionarioAtual = null;   // funcionário selecionado no extrato
let extratoRegistros = [];
let recessos         = [];
let recessoParaExcluir = null;

let appInitialized = false;
let initializedRole = null;
let uiInicializada = false;

// Check cache immediately
const cached = getCachedAuth();
if (cached && ['adm_l1', 'adm_l2', 'rh'].includes(cached.role)) {
  currentUser = cached.user;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '/login.html';
    return;
  }
  currentUser = user;

  try {
    const token = await user.getIdToken();
    const me = await apiFetch('/usuarios/me');
    const role = me?.role || 'visitante';

    setCachedAuth(user, role, token);

    // Nível EFETIVO: override individual do usuário vence o do cargo
    let nivel = 3;
    if (role !== 'adm_l1') {
      try {
        const perms = await apiFetch('/usuarios/config/permissions');
        nivel = getEffectiveLevel(perms[role] || {}, me?.permissoes || null, 'carga-horaria');
      } catch (e) {
        // Fallback: comportamento anterior por cargo
        nivel = ['adm_l2', 'rh'].includes(role) ? 3 : 1;
      }
    }

    if (nivel < 2) {
      document.getElementById('auth-guard').classList.remove('hidden');
      return;
    }
    document.body.classList.toggle('hide-execute', role !== 'adm_l1' && nivel < 3);

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      initApp(user, role);
    }

  } catch (e) {
    console.error("Erro na revalidação de auth:", e);
    if (!appInitialized) {
      document.getElementById('auth-guard').classList.remove('hidden');
    }
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'carga-horaria', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '/login.html';
  });

  document.getElementById('main-content').classList.remove('hidden');
  inicializar();
}

// ================================================================
//  INICIALIZAÇÃO
// ================================================================
function inicializar() {
  // Evita registrar listeners duas vezes (causava lançamentos duplicados)
  if (uiInicializada) return;
  uiInicializada = true;
  setupFormPonto();
  setupRecessos();
  setupExtrato();
  carregarFuncionarios();
  carregarRecessos();
}

// ================================================================
//  DADOS
// ================================================================
async function carregarFuncionarios() {
  try {
    const data = await apiFetch('/carga-horaria/funcionarios_rh');
    allFuncionarios = data.filter(f => f.ativo !== false);
    popularSelectFuncionarios();
    renderStats();
    // Se já havia um funcionário selecionado, atualiza o extrato
    if (funcionarioAtual) {
      const atualizado = allFuncionarios.find(f => f.id === funcionarioAtual.id);
      if (atualizado) funcionarioAtual = atualizado;
    }
  } catch (err) {
    showToast('❌ Erro ao carregar funcionários: ' + err.message, 'error');
  }
}

async function carregarRecessos() {
  try {
    recessos = await apiFetch('/carga-horaria/custom/recessos');
    renderRecessos();
    renderStats();
  } catch (err) {
    document.getElementById('lista-recessos').innerHTML =
      `<div class="ch-empty"><p>Erro ao carregar recessos.</p></div>`;
  }
}

// ================================================================
//  STATS
// ================================================================
function renderStats() {
  const total = allFuncionarios.length;
  const pos = allFuncionarios.filter(f => (Number(f.totalHorasExtras) || 0) > 0).length;
  const neg = allFuncionarios.filter(f => (Number(f.totalHorasExtras) || 0) < 0).length;

  document.getElementById('stat-total-func').textContent = total;
  document.getElementById('stat-saldo-pos').textContent  = pos;
  document.getElementById('stat-saldo-neg').textContent  = neg;
  document.getElementById('stat-recessos').textContent   = recessos.length;
}

// ================================================================
//  LANÇAR HORÁRIO
// ================================================================
function popularSelectFuncionarios() {
  const sel = document.getElementById('func-select');
  const selecionado = sel.value;
  sel.innerHTML = '<option value="">Selecione um funcionário...</option>' +
    allFuncionarios.map(f => `<option value="${esc(f.id)}">${esc(f.nome)}</option>`).join('');
  if (selecionado && allFuncionarios.some(f => f.id === selecionado)) sel.value = selecionado;
}

const TURNO_LABEL = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

function getFuncSelecionado() {
  const id = document.getElementById('func-select').value;
  return allFuncionarios.find(f => f.id === id) || null;
}

// Ordem canônica dos turnos e turnos cadastrados do funcionário
const ORDEM_TURNOS = ['manha', 'tarde', 'noite'];

function getTurnosCadastrados(func) {
  return ((func && Array.isArray(func.turnos)) ? func.turnos : [])
    .filter(t => ORDEM_TURNOS.includes(t.id))
    .sort((a, b) => ORDEM_TURNOS.indexOf(a.id) - ORDEM_TURNOS.indexOf(b.id));
}

function popularTurnosCheck() {
  const box = document.getElementById('turnos-check');
  const func = getFuncSelecionado();
  if (!func) {
    box.innerHTML = '<span class="ch-turnos-vazio">Selecione um funcionário para ver os turnos.</span>';
    return;
  }
  box.innerHTML = ORDEM_TURNOS.map(id => `
      <label class="ch-turno-check-label">
        <input type="checkbox" name="turno-check" value="${id}">
        <div class="ch-turno-check-card">${TURNO_LABEL[id]}</div>
      </label>`).join('');

  box.querySelectorAll('input[name="turno-check"]').forEach(cb =>
    cb.addEventListener('change', atualizarPreviewPonto));
  atualizarPreviewPonto();
}

function getTurnosMarcados() {
  return [...document.querySelectorAll('input[name="turno-check"]:checked')].map(cb => cb.value);
}

function calcHorasIntervalo(entrada, saida) {
  if (!/^\d{2}:\d{2}$/.test(entrada) || !/^\d{2}:\d{2}$/.test(saida)) return null;
  const [eh, em] = entrada.split(':').map(Number);
  const [sh, sm] = saida.split(':').map(Number);
  let diff = (sh * 60 + sm) - (eh * 60 + em);
  if (diff <= 0) diff += 24 * 60;
  return Math.round(diff / 60 * 100) / 100;
}

// Diferença simples entre dois horários (sem virada de dia), em horas
function diffSimplesHoras(a, b) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return Math.round(Math.abs((bh * 60 + bm) - (ah * 60 + am)) / 60 * 100) / 100;
}

// Espelha a regra do backend:
// - Turnos marcados = atalho de turno inteiro (sem horário junto).
// - Entrada E saída = período inteiro conta.
// - Só saída = diferença vs saída padrão do fim do expediente.
// - Só entrada = diferença vs entrada padrão do início do expediente.
function calcularLancamento() {
  const func = getFuncSelecionado();
  if (!func) return null;

  const marcados = getTurnosMarcados();
  const entrada = document.getElementById('ponto-entrada').value;
  const saida = document.getElementById('ponto-saida').value;
  const temHorario = !!(entrada || saida);
  const temTurnos = marcados.length > 0;

  if (!temHorario && !temTurnos) return null;
  if (temHorario && temTurnos) {
    return { erro: 'Informe horário OU marque turnos — não os dois ao mesmo tempo.' };
  }

  const cadastrados = getTurnosCadastrados(func);
  let total = 0;

  if (temTurnos) {
    // Turno cadastrado = carga do funcionário; não cadastrado = 4h padrão
    const HORAS_PADRAO_TURNO = 4;
    for (const id of marcados) {
      const t = cadastrados.find(x => x.id === id);
      total += t ? (Number(t.horas) || 0) : HORAS_PADRAO_TURNO;
    }
  } else if (entrada && saida) {
    // Se o período bate com um turno cadastrado, compara com a jornada dele;
    // se não bate com nenhum, o período inteiro conta (horas avulsas).
    const trabalhado = calcHorasIntervalo(entrada, saida);
    if (trabalhado === null) return { erro: 'Horário inválido.' };

    const toMin = h => { const [x, y] = h.split(':').map(Number); return x * 60 + y; };
    const iniMin = toMin(entrada);
    const fimMin = toMin(saida);

    let melhorTurno = null;
    let melhorOverlap = 0;
    for (const t of cadastrados) {
      if (!t.entrada || !t.saida) continue;
      const overlap = Math.min(fimMin, toMin(t.saida)) - Math.max(iniMin, toMin(t.entrada));
      if (overlap > melhorOverlap) { melhorOverlap = overlap; melhorTurno = t; }
    }

    total = melhorTurno
      ? Math.abs(trabalhado - (Number(melhorTurno.horas) || 0))
      : trabalhado;
  } else if (saida) {
    // Compara com a saída padrão do turno mais próximo do horário informado
    const candidatos = cadastrados.filter(t => t.saida);
    if (!candidatos.length) return { erro: 'Funcionário sem horário padrão — informe entrada E saída.' };
    const turnoRef = candidatos.reduce((melhor, t) =>
      diffSimplesHoras(t.saida, saida) < diffSimplesHoras(melhor.saida, saida) ? t : melhor);
    total = diffSimplesHoras(turnoRef.saida, saida);
  } else {
    // Compara com a entrada padrão do turno mais próximo do horário informado
    const candidatos = cadastrados.filter(t => t.entrada);
    if (!candidatos.length) return { erro: 'Funcionário sem horário padrão — informe entrada E saída.' };
    const turnoRef = candidatos.reduce((melhor, t) =>
      diffSimplesHoras(t.entrada, entrada) < diffSimplesHoras(melhor.entrada, entrada) ? t : melhor);
    total = diffSimplesHoras(turnoRef.entrada, entrada);
  }

  return { total: Math.round(total * 100) / 100, temHorario };
}

function atualizarPreviewPonto() {
  const el = document.getElementById('ponto-preview');
  const calc = calcularLancamento();

  if (!calc) { el.classList.add('hidden'); return; }

  el.classList.remove('hidden');
  el.classList.remove('positivo', 'negativo', 'neutro');

  if (calc.erro) {
    el.classList.add('negativo');
    el.innerHTML = `⚠️ ${calc.erro}`;
    return;
  }

  const operacao = document.querySelector('input[name="tipo-op"]:checked').value;
  if (calc.total === 0) {
    el.classList.add('neutro');
    el.innerHTML = 'Cálculo resultou em <strong>0h</strong> — nada será lançado.';
    return;
  }

  if (operacao === 'retirar') {
    el.classList.add('negativo');
    el.innerHTML = `Será <strong>retirado ${fmtHoras(calc.total)}</strong> do banco de horas.`;
  } else {
    el.classList.add('positivo');
    el.innerHTML = `Será <strong>adicionado ${fmtHoras(calc.total)}</strong> ao banco de horas.`;
  }
}

function setupFormPonto() {
  // Data padrão: hoje
  document.getElementById('ponto-data').value = new Date().toISOString().split('T')[0];

  document.getElementById('ponto-entrada').addEventListener('input', atualizarPreviewPonto);
  document.getElementById('ponto-saida').addEventListener('input', atualizarPreviewPonto);
  document.querySelectorAll('input[name="tipo-op"]').forEach(r =>
    r.addEventListener('change', atualizarPreviewPonto));

  document.getElementById('form-ponto').addEventListener('submit', async e => {
    e.preventDefault();
    const func = getFuncSelecionado();
    if (!func) { showToast('⚠️ Selecione um funcionário.', 'error'); return; }

    const data = document.getElementById('ponto-data').value;
    const turnosMarcados = getTurnosMarcados();
    if (!data) { showToast('⚠️ Informe a data.', 'error'); return; }

    const calc = calcularLancamento();
    if (!calc) { showToast('⚠️ Informe um horário ou marque um turno.', 'error'); return; }
    if (calc.erro) { showToast('⚠️ ' + calc.erro, 'error'); return; }

    const entrada = document.getElementById('ponto-entrada').value || null;
    const saida = document.getElementById('ponto-saida').value || null;
    const descricao = document.getElementById('ponto-descricao').value.trim();
    if (!descricao) { showToast('⚠️ Informe o motivo do lançamento.', 'error'); return; }
    const operacao = document.querySelector('input[name="tipo-op"]:checked').value;

    const btn = document.getElementById('btn-ponto');
    btn.disabled = true;
    try {
      const res = await apiFetch('/carga-horaria/custom/pontos', {
        method: 'POST',
        body: JSON.stringify({ funcionarioId: func.id, data, operacao, turnos: turnosMarcados, entrada, saida, descricao })
      });

      const idx = allFuncionarios.findIndex(f => f.id === func.id);
      if (idx >= 0) allFuncionarios[idx].totalHorasExtras = res.novoSaldo;

      // Limpa campos mantendo funcionário e data
      document.getElementById('ponto-entrada').value = '';
      document.getElementById('ponto-saida').value = '';
      document.getElementById('ponto-descricao').value = '';
      document.querySelectorAll('input[name="turno-check"]').forEach(cb => cb.checked = false);
      atualizarPreviewPonto();

      const msg = res.horasExtras >= 0
        ? `+${fmtHoras(res.horasExtras)} adicionado`
        : `${fmtHoras(res.horasExtras)} retirado`;
      showToast(`✅ Lançamento registrado — ${msg}.`, 'success');
      renderStats();
      await carregarExtrato(func.id);
    } catch (err) {
      showToast('❌ Erro: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}


// ================================================================
//  RECESSOS & FERIADOS
// ================================================================
function setupRecessos() {
  // O submit do formulário abre o modal de seleção de participantes
  document.getElementById('form-recesso').addEventListener('submit', e => {
    e.preventDefault();
    const nome = document.getElementById('recesso-nome').value.trim();
    const data = document.getElementById('recesso-data').value;
    if (!nome || !data) { showToast('⚠️ Preencha nome e data do recesso.', 'error'); return; }
    abrirModalRecessoFunc(nome, data);
  });

  // Busca no modal
  document.getElementById('modal-func-busca').addEventListener('input', filtrarModalFunc);

  // Selecionar todos
  document.getElementById('modal-func-todos').addEventListener('change', e => {
    document.querySelectorAll('#modal-func-lista input[type="checkbox"]').forEach(cb => {
      if (cb.closest('.ch-func-item').style.display !== 'none') cb.checked = e.target.checked;
    });
    atualizarContadorRecesso();
  });

  document.getElementById('modal-func-lista').addEventListener('change', atualizarContadorRecesso);

  document.getElementById('btn-cancelar-recesso-func').addEventListener('click', () => {
    document.getElementById('modal-recesso-func').classList.remove('active');
  });

  document.getElementById('btn-confirmar-recesso-func').addEventListener('click', async () => {
    const nome = document.getElementById('recesso-nome').value.trim();
    const data = document.getElementById('recesso-data').value;
    const ids = [...document.querySelectorAll('#modal-func-lista input[type="checkbox"]:checked')]
      .map(cb => cb.value);

    if (!ids.length) { showToast('⚠️ Selecione pelo menos um funcionário.', 'error'); return; }

    const btn = document.getElementById('btn-confirmar-recesso-func');
    btn.disabled = true;
    try {
      const res = await apiFetch('/carga-horaria/custom/recessos', {
        method: 'POST',
        body: JSON.stringify({ nome, data, funcionarioIds: ids })
      });
      document.getElementById('modal-recesso-func').classList.remove('active');
      document.getElementById('form-recesso').reset();
      showToast(`✅ Recesso criado — horas debitadas de ${res.totalFuncionarios} funcionário(s).`, 'success');
      await Promise.all([carregarRecessos(), carregarFuncionarios()]);
      if (funcionarioAtual) await carregarExtrato(funcionarioAtual.id);
    } catch (err) {
      showToast('❌ Erro ao criar recesso: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Delegação: excluir recesso
  document.getElementById('lista-recessos').addEventListener('click', e => {
    const btn = e.target.closest('[data-recesso-id]');
    if (!btn) return;
    recessoParaExcluir = btn.dataset.recessoId;
    const rec = recessos.find(r => r.id === recessoParaExcluir);
    document.getElementById('modal-excluir-texto').innerHTML =
      `Excluir <strong>${esc(rec?.nome || 'recesso')}</strong>? Os débitos aplicados a todos os funcionários serão <strong>revertidos automaticamente</strong>.`;
    document.getElementById('modal-excluir-recesso').classList.add('active');
  });

  document.getElementById('btn-cancelar-excluir').addEventListener('click', () => {
    recessoParaExcluir = null;
    document.getElementById('modal-excluir-recesso').classList.remove('active');
  });

  document.getElementById('btn-confirmar-excluir').addEventListener('click', async () => {
    if (!recessoParaExcluir) return;
    const btn = document.getElementById('btn-confirmar-excluir');
    btn.disabled = true;
    try {
      const res = await apiFetch(`/carga-horaria/custom/recessos/${recessoParaExcluir}`, { method: 'DELETE' });
      showToast(`✅ Recesso removido — ${res.registrosRevertidos} débito(s) revertido(s).`, 'success');
      document.getElementById('modal-excluir-recesso').classList.remove('active');
      recessoParaExcluir = null;
      await Promise.all([carregarRecessos(), carregarFuncionarios()]);
      if (funcionarioAtual) await carregarExtrato(funcionarioAtual.id);
    } catch (err) {
      showToast('❌ Erro ao excluir recesso: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// Modal de participantes: lista todos os ativos agrupados por cargo/setor
function abrirModalRecessoFunc(nome, data) {
  const lista = document.getElementById('modal-func-lista');
  const dataFmt = new Date(data + 'T12:00:00').toLocaleDateString('pt-BR');
  document.getElementById('modal-recesso-info').textContent =
    `"${nome}" em ${dataFmt} — as horas do dia serão debitadas dos selecionados.`;

  // Agrupar por setor (funcionários sem setor ficam no grupo "Sem setor")
  const grupos = {};
  allFuncionarios.forEach(f => {
    const setor = (f.setor || 'Sem setor').trim();
    if (!grupos[setor]) grupos[setor] = [];
    grupos[setor].push(f);
  });

  lista.innerHTML = Object.keys(grupos).sort((a, b) => {
    if (a === 'Sem setor') return 1;
    if (b === 'Sem setor') return -1;
    return a.localeCompare(b);
  }).map(setor => `
    <div class="ch-func-grupo">${esc(setor)}</div>
    ${grupos[setor].map(f => `
      <label class="ch-func-item" data-nome="${esc(f.nome.toLowerCase())}">
        <input type="checkbox" value="${esc(f.id)}" checked>
        <span class="ch-func-item-nome">${esc(f.nome)}</span>
        <span class="ch-func-item-horas">${fmtHoras(Number(f.horasTurno) || 0)}/dia</span>
      </label>`).join('')}
  `).join('');

  document.getElementById('modal-func-busca').value = '';
  document.getElementById('modal-func-todos').checked = true;
  atualizarContadorRecesso();
  document.getElementById('modal-recesso-func').classList.add('active');
}

function filtrarModalFunc() {
  const termo = document.getElementById('modal-func-busca').value.trim().toLowerCase();
  const itens = document.querySelectorAll('#modal-func-lista .ch-func-item');
  itens.forEach(item => {
    item.style.display = item.dataset.nome.includes(termo) ? '' : 'none';
  });
  // Esconde títulos de grupo sem itens visíveis
  document.querySelectorAll('#modal-func-lista .ch-func-grupo').forEach(grupo => {
    let el = grupo.nextElementSibling;
    let temVisivel = false;
    while (el && !el.classList.contains('ch-func-grupo')) {
      if (el.style.display !== 'none') { temVisivel = true; break; }
      el = el.nextElementSibling;
    }
    grupo.style.display = temVisivel ? '' : 'none';
  });
}

function atualizarContadorRecesso() {
  const n = document.querySelectorAll('#modal-func-lista input[type="checkbox"]:checked').length;
  document.getElementById('btn-confirmar-recesso-func').textContent = `Criar Recesso (${n})`;
}

function renderRecessos() {
  const el = document.getElementById('lista-recessos');
  if (!recessos.length) {
    el.innerHTML = `
      <div class="ch-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <p>Nenhum recesso cadastrado.</p>
      </div>`;
    return;
  }

  el.innerHTML = recessos.map(r => {
    const dataFmt = r.data ? new Date(r.data + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
    return `
      <div class="ch-recesso-item">
        <div class="ch-recesso-info">
          <span class="ch-recesso-nome">${esc(r.nome)}</span>
          <span class="ch-recesso-meta">${dataFmt} · ${r.totalFuncionarios || 0} funcionário(s)</span>
        </div>
        <button class="ch-icon-btn action-execute" data-recesso-id="${esc(r.id)}" title="Excluir e reverter débitos">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`;
  }).join('');
}

// ================================================================
//  EXTRATO
// ================================================================
function setupExtrato() {
  document.getElementById('func-select').addEventListener('change', async e => {
    const funcId = e.target.value;
    popularTurnosCheck();
    if (!funcId) {
      funcionarioAtual = null;
      extratoRegistros = [];
      document.getElementById('saldo-card').classList.add('hidden');
      document.getElementById('btn-exportar-pdf').disabled = true;
      document.getElementById('extrato-lista').innerHTML =
        `<div class="ch-empty"><p>Selecione um funcionário acima para ver o extrato.</p></div>`;
      return;
    }
    await carregarExtrato(funcId);
  });

  document.getElementById('btn-exportar-pdf').addEventListener('click', exportarPDF);

  // Delegação: excluir lançamento individual (estorna o saldo)
  document.getElementById('extrato-lista').addEventListener('click', async e => {
    const btn = e.target.closest('[data-registro-id]');
    if (!btn || !funcionarioAtual) return;
    if (!confirm('Excluir este lançamento?\n\nO efeito no banco de horas será estornado.')) return;

    btn.disabled = true;
    try {
      await apiFetch(`/carga-horaria/custom/registros/${btn.dataset.registroId}`, { method: 'DELETE' });
      showToast('✅ Lançamento excluído e saldo estornado.', 'success');
      await Promise.all([carregarFuncionarios(), carregarExtrato(funcionarioAtual.id)]);
    } catch (err) {
      showToast('❌ Erro ao excluir: ' + err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function carregarExtrato(funcId) {
  document.getElementById('extrato-lista').innerHTML = '<div class="ch-loading">Carregando extrato...</div>';
  try {
    const res = await apiFetch(`/carga-horaria/custom/extrato/${funcId}`);
    funcionarioAtual = { id: res.funcionario.id, ...res.funcionario, totalHorasExtras: res.saldo };
    extratoRegistros = res.registros;
    document.getElementById('btn-exportar-pdf').disabled = !extratoRegistros.length;
    renderSaldo(res.saldo);
    renderExtrato(extratoRegistros);
  } catch (err) {
    showToast('❌ Erro ao carregar extrato: ' + err.message, 'error');
    document.getElementById('extrato-lista').innerHTML =
      `<div class="ch-empty"><p>Erro ao carregar o extrato.</p></div>`;
  }
}

function renderSaldo(saldo) {
  const card = document.getElementById('saldo-card');
  card.classList.remove('hidden');
  card.classList.toggle('negativo', saldo < 0);
  card.classList.toggle('positivo', saldo >= 0);

  document.getElementById('saldo-avatar').textContent = (funcionarioAtual.nome || '?').charAt(0).toUpperCase();
  document.getElementById('saldo-nome').textContent   = funcionarioAtual.nome;
  document.getElementById('saldo-cargo').textContent  = funcionarioAtual.setor || funcionarioAtual.cargo || 'Sem setor';
  document.getElementById('saldo-valor').textContent  = fmtHoras(saldo);
  document.getElementById('saldo-label').textContent  = saldo < 0 ? 'Devendo Horas' : 'Banco de Horas';
}

const TIPO_BADGE = {
  ponto:   ['badge-ponto', 'Ponto'],
  manual:  ['badge-manual', 'Crédito'],
  debito:  ['badge-debito', 'Débito'],
  recesso: ['badge-recesso', 'Recesso'],
  evento:  ['badge-evento', 'Evento']
};

// Data "de referência" do registro: `dataEvento` é o dia que o RH
// selecionou na tela (o dia em que a hora extra/falta realmente aconteceu)
// — é isso que deve aparecer no relatório e no agrupamento por mês, não
// `lancadoEm` (só o timestamp de quando o registro foi criado no sistema,
// que pode ser um dia bem diferente do evento em si). `lancadoEm` só entra
// como fallback pra lançamentos antigos/manuais que não têm `dataEvento`.
function dataDoRegistro(r) {
  if (r.dataEvento) return new Date(r.dataEvento + 'T12:00:00');
  return r.lancadoEm ? new Date(r.lancadoEm) : new Date();
}

function renderExtrato(registros) {
  const lista = document.getElementById('extrato-lista');
  if (!registros.length) {
    lista.innerHTML = `<div class="ch-empty"><p>Nenhum lançamento para este funcionário.</p></div>`;
    return;
  }

  // Ordena pela data do evento (não da criação do registro) antes de
  // agrupar, senão um lançamento retroativo aparece fora de ordem dentro
  // do próprio mês a que pertence.
  const registrosOrdenados = [...registros].sort((a, b) => dataDoRegistro(b) - dataDoRegistro(a));

  // Agrupar por mês/ano
  const grupos = {};
  registrosOrdenados.forEach(r => {
    const dataObj = dataDoRegistro(r);
    const mesAno = dataObj.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    if (!grupos[mesAno]) grupos[mesAno] = [];
    grupos[mesAno].push(r);
  });

  let html = '';
  for (const [mesAno, items] of Object.entries(grupos)) {
    const mesCapitalizado = mesAno.charAt(0).toUpperCase() + mesAno.slice(1);
    html += `<div class="ch-mes-header">${mesCapitalizado}</div>`;

    html += items.map(r => {
      const data = r.dataEvento
        ? new Date(r.dataEvento + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : (r.lancadoEm
          ? new Date(r.lancadoEm).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '—');
      const [tipoClass, tipoLabel] = TIPO_BADGE[r.tipo] || ['badge-evento', r.tipo || '—'];

      const valor = Number(r.horasExtras || 0);
      const valorFormatado = (valor >= 0 ? '+' : '') + fmtHoras(valor);
      const valorClasse = valor >= 0 ? 'ch-horas-pos' : 'ch-horas-neg';

      const podeExcluir = r.tipo !== 'recesso';
      return `
        <div class="ch-registro-card">
          <span class="ch-tipo-badge ${tipoClass}">${tipoLabel}</span>
          <div class="ch-registro-info">
            <div class="ch-registro-desc">${esc(r.descricao || '')}</div>
            <div class="ch-registro-data">${data}</div>
          </div>
          <span class="ch-registro-valor ${valorClasse}">${valorFormatado}</span>
          ${podeExcluir ? `
          <button class="ch-icon-btn action-execute" data-registro-id="${esc(r.id)}" title="Excluir lançamento (estorna o saldo)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>` : ''}
        </div>`;
    }).join('');
  }

  lista.innerHTML = html;
}

const TIPO_LABEL_PDF = { ponto: 'Ponto', manual: 'Crédito', debito: 'Débito', recesso: 'Recesso', evento: 'Evento' };

// Cache da logo da Fatec para os PDFs (dataURL + proporção)
let logoCache = null;
async function getLogoFatec() {
  if (logoCache !== null) return logoCache;
  try {
    const blob = await (await fetch('/img/fateclogoazul.png')).blob();
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    logoCache = { dataUrl, ratio: img.naturalWidth / img.naturalHeight };
  } catch (_) {
    logoCache = false; // falhou; não tenta de novo
  }
  return logoCache;
}

async function exportarPDF() {
  if (!funcionarioAtual || !extratoRegistros.length) return;
  if (!window.jspdf) { showToast('❌ Biblioteca de PDF não carregou — verifique a conexão.', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const logo = await getLogoFatec();
  if (logo) {
    const h = 14;
    const w = h * logo.ratio;
    doc.addImage(logo.dataUrl, 'PNG', 14, 10, w, h);
  }
  const hoje = new Date().toLocaleDateString('pt-BR');
  const saldo = Number(funcionarioAtual.totalHorasExtras) || 0;

  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.text('Extrato de Banco de Horas', 14, 32);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`Funcionário: ${funcionarioAtual.nome}`, 14, 39);
  doc.text(`Setor: ${funcionarioAtual.setor || funcionarioAtual.cargo || '—'}`, 14, 45);
  doc.setFont(undefined, 'bold');
  doc.text(`Saldo atual: ${fmtHoras(saldo)}${saldo < 0 ? ' (devendo horas)' : ''}`, 14, 51);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.text(`Emitido em ${hoje}`, 14, 57);

  doc.autoTable({
    startY: 62,
    theme: 'grid',
    head: [['Data', 'Tipo', 'Motivo', 'Horas']],
    body: [...extratoRegistros].sort((a, b) => dataDoRegistro(b) - dataDoRegistro(a)).map(r => [
      r.dataEvento
        ? new Date(r.dataEvento + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : (r.lancadoEm ? new Date(r.lancadoEm).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
      TIPO_LABEL_PDF[r.tipo] || r.tipo || '—',
      r.descricao || '',
      (Number(r.horasExtras || 0) >= 0 ? '+' : '') + fmtHoras(Number(r.horasExtras || 0))
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [15, 78, 184] },
    columnStyles: { 3: { halign: 'right' } }
  });

  doc.save(`extrato_${funcionarioAtual.nome.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`);
  showToast('📥 PDF exportado com sucesso!', 'success');
}

// ================================================================
//  UTILITÁRIOS
// ================================================================
// Converte 1.5 -> "1h 30m" (com sinal para negativos)
function fmtHoras(decimal) {
  const totalMinutos = Math.round(Math.abs(decimal) * 60);
  const h = Math.floor(totalMinutos / 60);
  const m = totalMinutos % 60;
  const sinal = decimal < 0 ? '-' : '';
  return `${sinal}${h}h ${m < 10 ? '0' : ''}${m}m`;
}

let toastTimer = null;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `ch-toast toast-${type}`;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
