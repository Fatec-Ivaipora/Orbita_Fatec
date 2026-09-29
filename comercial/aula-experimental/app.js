import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';
import { opcaoEscolhida, imprimirRelatorio, avatar } from '../comercial-comum.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'aula-experimental';
// Nível padrão quando config/permissions ainda não tem a chave do módulo
// (mesmo valor do defaultPermissions do backend).
const NIVEL_PADRAO = { adm_l2: 3, comercial: 3 };
const STATUS_LABEL = { agendada: 'Agendada', realizada: 'Veio', faltou: 'Faltou', cancelada: 'Cancelada' };
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;

let aulas = [];
let periodoAtual = '';
let emEdicaoId = null;
let apoio = null;          // { cursos, professores, eduboxOk } — carregado só ao abrir o formulário
let equipe = null;         // [{uid, nome}] do Comercial pra "quem vai receber"

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro na API: ${res.status}`);
  }
  return res.json();
}

async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try { return await apiFetch(endpoint); } catch (err) {
      if (i === tentativas) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

function showToast(msg, tipo = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${tipo}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Datas em 'AAAA-MM-DD' — monta Date local (meio-dia) pra não cair um dia pelo fuso.
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d, 12);
}
function fmtData(s) {
  if (!s) return '';
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}
function fmtDiaSemana(s) {
  return s ? DIAS[dataLocal(s).getDay()] : '';
}
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const hoje = () => isoLocal(new Date());

function soDigitos(v) { return (v || '').replace(/\D/g, ''); }
function numeroZap(contato) {
  const dig = soDigitos(contato);
  if (dig.length < 10) return null;
  return dig.length <= 11 ? '55' + dig : dig;
}
// "RAFAELA TROPP" -> "Rafaela Tropp" (nome em maiúsculo fica gritado na mensagem).
function nomeProprio(nome) {
  const minusculas = ['da', 'de', 'do', 'das', 'dos', 'e'];
  return (nome || '').toLowerCase().split(/\s+/).filter(Boolean)
    .map((p, i) => (i > 0 && minusculas.includes(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}
function primeiroNome(nome) {
  const p = (nome || '').trim().split(/\s+/)[0] || '';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// ==========================================
// AUTH GUARD
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2' || cached.role === 'comercial')) {
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
      currentUserNome = userData.name || user.displayName || '';
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
        const doCargo = perms[role] || {};
        const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
      } catch (e) {
        level = NIVEL_PADRAO[role] || 1;
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
  currentUserNome = currentUserNome || user.displayName || '';

  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  montarPeriodos();
  wireEventos();
}

// Períodos: "próximas" (de hoje em diante), esta semana e os meses em volta.
function montarPeriodos() {
  const sel = document.getElementById('sel-periodo');
  const agora = new Date();
  const opcoes = [[`${hoje()}|`, 'Próximas aulas (de hoje em diante)']];
  const seg = new Date(agora); seg.setDate(agora.getDate() - ((agora.getDay() + 6) % 7));
  const dom = new Date(seg); dom.setDate(seg.getDate() + 6);
  opcoes.push([`${isoLocal(seg)}|${isoLocal(dom)}`, 'Esta semana']);
  for (let i = 1; i >= -3; i--) {
    const ini = new Date(agora.getFullYear(), agora.getMonth() + i, 1);
    const fim = new Date(agora.getFullYear(), agora.getMonth() + i + 1, 0);
    const nome = ini.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    opcoes.push([`${isoLocal(ini)}|${isoLocal(fim)}`, nome.charAt(0).toUpperCase() + nome.slice(1)]);
  }
  sel.innerHTML = '<option value="">Selecione o período...</option>' + opcoes.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
}

function wireEventos() {
  // Só busca depois que a pessoa escolhe o período (economia de leitura).
  document.getElementById('sel-periodo').addEventListener('change', (e) => {
    periodoAtual = e.target.value;
    document.getElementById('btn-imprimir').classList.toggle('hidden', !periodoAtual);
    if (periodoAtual) carregar();
    else {
      document.getElementById('conteudo').classList.add('hidden');
      document.getElementById('msg-inicial').classList.remove('hidden');
    }
  });

  ['busca', 'filtro-curso', 'filtro-professor', 'filtro-recebe', 'filtro-status'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(el.type === 'text' ? 'input' : 'change', renderTudo);
  });
  document.getElementById('cursos-bar').addEventListener('click', (e) => {
    const chip = e.target.closest('.curso-chip');
    if (!chip) return;
    document.getElementById('filtro-curso').value = chip.dataset.curso;
    renderTudo();
  });
  document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
    ['busca', 'filtro-curso', 'filtro-professor', 'filtro-recebe', 'filtro-status'].forEach(id => { document.getElementById(id).value = ''; });
    renderTudo();
  });

  document.getElementById('btn-novo').addEventListener('click', () => abrirModalAula(null));
  document.getElementById('btn-imprimir').addEventListener('click', () => imprimirRelatorio([
    `Período: ${opcaoEscolhida('sel-periodo')}`,
    opcaoEscolhida('filtro-curso') && `Curso: ${opcaoEscolhida('filtro-curso')}`,
    opcaoEscolhida('filtro-professor') && `Professor: ${opcaoEscolhida('filtro-professor')}`,
    opcaoEscolhida('filtro-recebe') && `Quem recebe: ${opcaoEscolhida('filtro-recebe')}`,
    opcaoEscolhida('filtro-status') && `Situação: ${opcaoEscolhida('filtro-status')}`,
    document.getElementById('busca').value.trim() && `Busca: "${document.getElementById('busca').value.trim()}"`,
    `${document.querySelectorAll('#tabela-corpo tr:not(:has(.tabela-msg))').length} agendamento(s)`
  ], currentUserNome || currentUser.email));
  document.getElementById('btn-cancelar-aula').addEventListener('click', () => fechar('modal-aula'));
  document.getElementById('form-aula').addEventListener('submit', salvarAula);
  document.getElementById('btn-excluir').addEventListener('click', () => excluirAula(emEdicaoId));
  document.getElementById('f-curso').addEventListener('change', atualizarListaProfessores);

  document.getElementById('btn-fechar-msg').addEventListener('click', () => fechar('modal-msg'));
  document.querySelectorAll('[data-copiar]').forEach(btn => btn.addEventListener('click', () => copiar(btn.dataset.copiar)));
  ['msg-professor', 'msg-aluno'].forEach(id => document.getElementById(id).addEventListener('input', atualizarLinksZap));

  document.getElementById('tabela-corpo').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const { id, acao } = btn.dataset;
    if (acao === 'editar') abrirModalAula(id);
    else if (acao === 'excluir') excluirAula(id);
    else if (acao === 'mensagens') abrirMensagens(id);
    else mudarStatus(id, acao);
  });
}

async function carregar() {
  document.getElementById('msg-inicial').classList.add('hidden');
  document.getElementById('conteudo').classList.remove('hidden');
  document.getElementById('tabela-corpo').innerHTML = '<tr><td colspan="8" class="tabela-msg">Carregando...</td></tr>';
  const [de, ate] = periodoAtual.split('|');
  try {
    aulas = await apiFetch(`/aula-experimental?de=${de}${ate ? `&ate=${ate}` : ''}`);
    renderTudo();
  } catch (err) {
    document.getElementById('tabela-corpo').innerHTML = `<tr><td colspan="8" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

// ==========================================
// FILTROS + RENDER
// ==========================================
function lerFiltros() {
  const busca = document.getElementById('busca').value.trim().toLowerCase();
  return {
    busca, buscaDig: busca.replace(/\D/g, ''),
    curso: document.getElementById('filtro-curso').value,
    professor: document.getElementById('filtro-professor').value,
    recebe: document.getElementById('filtro-recebe').value,
    status: document.getElementById('filtro-status').value
  };
}

function passa(a, f, ignorar = '') {
  if (ignorar !== 'curso' && f.curso && a.curso !== f.curso) return false;
  if (f.professor && a.professor !== f.professor) return false;
  if (f.recebe && a.recebidoPor !== f.recebe) return false;
  if (ignorar !== 'status' && f.status && a.status !== f.status) return false;
  if (f.busca) {
    const noTexto = `${a.alunoNome} ${a.observacoes} ${a.alunoContato}`.toLowerCase().includes(f.busca);
    const noFone = f.buscaDig.length >= 4 && soDigitos(a.alunoContato).includes(f.buscaDig);
    if (!noTexto && !noFone) return false;
  }
  return true;
}

function preencherSelect(id, valores, rotuloTodos) {
  const sel = document.getElementById(id);
  const atual = sel.value;
  sel.innerHTML = `<option value="">${rotuloTodos}</option>` + valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (valores.includes(atual)) sel.value = atual;
}

function unicos(campo) {
  return [...new Set(aulas.map(a => a[campo]).filter(Boolean))].sort((x, y) => x.localeCompare(y));
}

function renderTudo() {
  preencherSelect('filtro-curso', unicos('curso'), 'Todos os cursos');
  preencherSelect('filtro-professor', unicos('professor'), 'Todos os professores');
  preencherSelect('filtro-recebe', unicos('recebidoPor'), 'Quem recebe: todos');

  const f = lerFiltros();
  const semStatus = aulas.filter(a => passa(a, f, 'status'));
  const conta = (s) => semStatus.filter(a => a.status === s).length;
  document.getElementById('kpi-total').textContent = semStatus.filter(a => a.status !== 'cancelada').length;
  document.getElementById('kpi-agendada').textContent = conta('agendada');
  document.getElementById('kpi-realizada').textContent = conta('realizada');
  document.getElementById('kpi-faltou').textContent = conta('faltou');
  const deHoje = semStatus.filter(a => a.data === hoje() && a.status === 'agendada').length;
  document.getElementById('kpi-hoje').textContent = deHoje ? `${deHoje} hoje` : '';

  // Botões por curso com quantidade (respeitando os outros filtros).
  const semCurso = aulas.filter(a => passa(a, f, 'curso'));
  const porCurso = {};
  semCurso.forEach(a => { if (a.curso) porCurso[a.curso] = (porCurso[a.curso] || 0) + 1; });
  const cursos = Object.entries(porCurso).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  if (f.curso && !porCurso[f.curso]) cursos.push([f.curso, 0]);
  const chip = (v, r, n) => `<button type="button" class="curso-chip ${f.curso === v ? 'ativo' : ''}" data-curso="${esc(v)}">${esc(r)} <span class="curso-chip-qtd">${n}</span></button>`;
  document.getElementById('cursos-bar').innerHTML = chip('', 'Todos os cursos', semCurso.length) + cursos.map(([c, n]) => chip(c, c, n)).join('');
  [...document.getElementById('filtro-curso').options].forEach(o => {
    o.textContent = o.value ? `${o.value} (${porCurso[o.value] || 0})` : `Todos os cursos (${semCurso.length})`;
  });

  const lista = aulas.filter(a => passa(a, f));
  const filtrando = Object.values(f).some(v => v);
  document.getElementById('btn-limpar-filtros').classList.toggle('hidden', !filtrando);
  document.getElementById('filtro-resumo').innerHTML = filtrando ? `Mostrando <strong>${lista.length}</strong> de ${aulas.length} agendamentos do período` : '';
  renderTabela(lista);
}

function renderTabela(lista) {
  const corpo = document.getElementById('tabela-corpo');
  if (!lista.length) {
    corpo.innerHTML = `<tr><td colspan="8" class="tabela-msg">${aulas.length ? 'Nenhum agendamento com esses filtros.' : 'Nenhuma aula experimental nesse período. Use "Agendar aula".'}</td></tr>`;
    return;
  }
  corpo.innerHTML = lista.map(a => {
    const ehHoje = a.data === hoje();
    let acoes = `<button class="btn-acao" data-acao="mensagens" data-id="${a.id}">✉️ Mensagens</button>`;
    if (a.status === 'agendada') {
      acoes += `<span class="action-execute"><button class="btn-acao ok" data-acao="realizada" data-id="${a.id}">✓ Veio</button>`;
      acoes += `<button class="btn-acao desistir" data-acao="faltou" data-id="${a.id}">Faltou</button></span>`;
    }
    acoes += `<button class="btn-acao action-execute" data-acao="editar" data-id="${a.id}">Editar</button>`;
    acoes += `<button class="btn-acao desistir action-execute" data-acao="excluir" data-id="${a.id}" title="Excluir agendamento">🗑</button>`;
    return `
      <tr>
        <td><div class="ae-dia">${fmtData(a.data)}${ehHoje ? '<span class="ae-hoje">HOJE</span>' : ''}</div><div class="ct-sub">${fmtDiaSemana(a.data)}${a.horario ? ' · ' + a.horario : ''}</div></td>
        <td><span class="cm-pessoa">${avatar(a.alunoNome)}<span class="ct-nome">${esc(a.alunoNome)}</span></span>${a.alunoContato ? `<div class="ct-sub">${esc(a.alunoContato)}</div>` : ''}${a.observacoes ? `<div class="ct-sub" title="${esc(a.observacoes)}">📝 ${esc(a.observacoes.length > 50 ? a.observacoes.slice(0, 50) + '…' : a.observacoes)}</div>` : ''}</td>
        <td>${esc(a.curso) || '<span class="ct-vazio">—</span>'}</td>
        <td>${esc(a.professor) || '<span class="ct-vazio">—</span>'}</td>
        <td>${esc(nomeProprio(a.recebidoPor)) || '<span class="ct-vazio">—</span>'}${a.atividadeId ? '<div class="ae-agenda-ok" title="Está na agenda do Meu Espaço">📅 na agenda</div>' : ''}</td>
        <td>${esc(a.sala) || '<span class="ct-vazio">—</span>'}</td>
        <td><span class="status-badge st-${a.status}">${STATUS_LABEL[a.status] || a.status}</span></td>
        <td class="acoes-col">${acoes}</td>
      </tr>`;
  }).join('');
}

// ==========================================
// FORMULÁRIO
// ==========================================
function abrir(id) { document.getElementById(id).classList.remove('hidden'); }
function fechar(id) { document.getElementById(id).classList.add('hidden'); }

// Cursos/professores (Edubox) e pessoas do setor só são buscados na primeira
// vez que o formulário abre.
// Nada disso pode segurar a abertura do formulário (em produção o Edubox
// não responde e a rota de professores leva segundos): o modal abre na hora
// e cada lista preenche quando chega. Cursos e equipe são rápidos; a lista
// de professores (Edubox) é só sugestão — sem ela, digita-se o nome.
let cursosPromise = null, equipePromise = null, apoioPromise = null;

function carregarApoio(onCursos, onEquipe, onProfessores) {
  cursosPromise = cursosPromise || apiFetch('/aula-experimental/cursos').catch(() => { cursosPromise = null; return []; });
  equipePromise = equipePromise || apiFetch('/aula-experimental/equipe').then(e => (equipe = e)).catch(() => { equipePromise = null; return (equipe = []); });
  apoioPromise = apoioPromise || apiFetch('/aula-experimental/apoio')
    .then(a => (apoio = a))
    .catch(() => (apoio = { cursos: [], professores: [], eduboxOk: false }));
  cursosPromise.then(onCursos);
  equipePromise.then(onEquipe);
  apoioPromise.then(onProfessores);
}

function preencherCursos(cursos, selecionado) {
  const sel = document.getElementById('f-curso');
  if (!cursos.length) {
    sel.innerHTML = '<option value="">Não carregou — feche e abra de novo</option>';
    return;
  }
  sel.innerHTML = '<option value="">Selecione...</option>' +
    cursos.map(c => `<option value="${esc(c.name)}" data-id="${c.id}">${esc(c.name)}</option>`).join('');
  if (selecionado && ![...sel.options].some(o => o.value === selecionado)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(selecionado)}">${esc(selecionado)}</option>`);
  }
  sel.value = selecionado || '';
  atualizarListaProfessores();
}

// Botões com a equipe do Comercial — quem for marcado ganha a atividade na
// agenda do Meu Espaço.
function renderEquipe(selecionados) {
  const box = document.getElementById('f-equipe');
  if (!equipe.length) { box.innerHTML = '<span class="ct-sub">Não foi possível carregar a equipe do Comercial.</span>'; return; }
  box.innerHTML = equipe.map(p => `
    <label class="equipe-chip"><input type="checkbox" value="${p.uid}" ${selecionados.includes(p.uid) ? 'checked' : ''}>${esc(nomeProprio(p.nome))}</label>`).join('');
}

function uidsSelecionados() {
  return [...document.querySelectorAll('#f-equipe input:checked')].map(i => i.value);
}

// Se a pessoa já mexeu nos botões antes da equipe terminar de carregar,
// respeita o que está marcado; senão usa o padrão.
function uidsSelecionadosOu(padrao) {
  return document.querySelector('#f-equipe input') ? uidsSelecionados() : padrao;
}

function atualizarListaProfessores() {
  const opt = document.getElementById('f-curso').selectedOptions[0];
  const cursoId = opt ? opt.dataset.id : '';
  const dica = document.getElementById('dica-professor');
  if (!apoio || !apoio.eduboxOk) {
    document.getElementById('lista-professores').innerHTML = '';
    dica.textContent = !apoio ? 'Buscando professores no Edubox... (pode digitar o nome)' : 'Lista do Edubox indisponível agora — digite o nome.';
    return;
  }
  const doCurso = cursoId ? apoio.professores.filter(p => (p.cursoIds || []).includes(cursoId)) : [];
  const lista = doCurso.length ? doCurso : apoio.professores;
  document.getElementById('lista-professores').innerHTML = lista.map(p => `<option value="${esc(p.nome)}">`).join('');
  dica.textContent = cursoId
    ? (doCurso.length ? `${doCurso.length} professores ativos neste curso (Edubox) — clique no campo para ver.` : 'Nenhum professor do curso no Edubox — mostrando todos.')
    : '';
}

function abrirModalAula(id) {
  emEdicaoId = id;
  const a = id ? aulas.find(x => x.id === id) : null;
  document.getElementById('modal-aula-titulo').textContent = a ? 'Editar aula experimental' : 'Agendar aula experimental';
  document.getElementById('modal-ultima-alt').textContent = a && a.updatedBy
    ? `Agendado por ${a.createdBy} · última alteração: ${a.updatedBy} em ${new Date(a.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  const cursoSel = document.getElementById('f-curso');
  const cursoAtual = a?.curso || '';
  if (cursoSel.options.length <= 1) cursoSel.innerHTML = '<option value="">Carregando cursos...</option>';
  else { preencherCursos([...cursoSel.options].filter(o => o.dataset.id).map(o => ({ id: o.dataset.id, name: o.value })), cursoAtual); }
  document.getElementById('f-aluno').value = a?.alunoNome || '';
  document.getElementById('f-contato').value = a?.alunoContato || '';
  document.getElementById('f-data').value = a?.data || '';
  document.getElementById('f-horario').value = a?.horario || '';
  document.getElementById('f-professor').value = a?.professor || '';
  const equipeMarcada = a ? (a.responsaveis || []).map(r => r.uid) : [currentUser.uid];
  if (equipe) renderEquipe(equipeMarcada);
  else document.getElementById('f-equipe').innerHTML = '<span class="ct-sub">Carregando equipe...</span>';
  // Listas chegam depois, sem travar a abertura (só aplica se o modal ainda
  // for do mesmo agendamento).
  carregarApoio(
    (cursos) => { if (emEdicaoId === id) preencherCursos(cursos, document.getElementById('f-curso').value || cursoAtual); },
    () => { if (emEdicaoId === id) renderEquipe(uidsSelecionadosOu(equipeMarcada)); },
    () => { if (emEdicaoId === id) atualizarListaProfessores(); }
  );
  document.getElementById('f-sala').value = a?.sala || '';
  document.getElementById('f-status').value = a?.status || 'agendada';
  document.getElementById('grupo-status').classList.toggle('hidden', !a);
  document.getElementById('f-obs').value = a?.observacoes || '';
  document.getElementById('btn-excluir').classList.toggle('hidden', !a);
  atualizarListaProfessores();
  abrir('modal-aula');
  document.getElementById('f-aluno').focus();
}

async function salvarAula(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-salvar-aula');
  const body = {
    alunoNome: document.getElementById('f-aluno').value,
    alunoContato: document.getElementById('f-contato').value,
    curso: document.getElementById('f-curso').value,
    data: document.getElementById('f-data').value,
    horario: document.getElementById('f-horario').value,
    professor: document.getElementById('f-professor').value,
    responsaveisUids: uidsSelecionados(),
    sala: document.getElementById('f-sala').value,
    status: document.getElementById('f-status').value,
    observacoes: document.getElementById('f-obs').value
  };
  btn.disabled = true;
  try {
    const salvo = emEdicaoId
      ? await apiFetch(`/aula-experimental/${emEdicaoId}`, { method: 'PUT', body: JSON.stringify(body) })
      : await apiFetch('/aula-experimental', { method: 'POST', body: JSON.stringify(body) });
    substituir(salvo);
    fechar('modal-aula');
    showToast(emEdicaoId ? 'Alterações salvas.' : 'Aula agendada.');
    // Recém-agendada: já abre as mensagens pra mandar pro professor e pro aluno.
    if (!emEdicaoId) abrirMensagens(salvo.id);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function substituir(a) {
  const idx = aulas.findIndex(x => x.id === a.id);
  if (idx >= 0) aulas[idx] = a; else aulas.push(a);
  aulas.sort((x, y) => (x.data || '').localeCompare(y.data || '') || (x.horario || '').localeCompare(y.horario || ''));
  renderTudo();
}

async function mudarStatus(id, status) {
  const a = aulas.find(x => x.id === id);
  try {
    substituir(await apiFetch(`/aula-experimental/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }));
    showToast(`${a.alunoNome} → ${STATUS_LABEL[status]}`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function excluirAula(id) {
  const a = aulas.find(x => x.id === id);
  if (!a || !confirm(`Excluir a aula experimental de ${a.alunoNome} (${fmtData(a.data)})?

Isso não pode ser desfeito. (Se só não vai acontecer, dá para marcar como "Cancelada" em Editar.)`)) return;
  try {
    await apiFetch(`/aula-experimental/${a.id}`, { method: 'DELETE' });
    aulas = aulas.filter(x => x.id !== a.id);
    fechar('modal-aula');
    renderTudo();
    showToast('Agendamento excluído.');
  } catch (err) { showToast(err.message, 'error'); }
}

// ==========================================
// MENSAGENS PRONTAS
// ==========================================
// Linhas `null` somem (campo não preenchido); '' vira linha em branco, sem
// deixar duas em branco seguidas.
function juntar(linhas) {
  const out = [];
  linhas.filter(l => l !== null).forEach(l => {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) return;
    out.push(l);
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function montarMensagens(a) {
  const dia = `${fmtDiaSemana(a.data)}, ${fmtData(a.data)}`;
  const quando = a.horario ? `${dia}, às ${a.horario}` : dia;
  const artigo = ['sábado', 'domingo'].includes(fmtDiaSemana(a.data)) ? 'No' : 'Na';
  const recebe = nomeProprio(a.recebidoPor);
  const prof = nomeProprio(a.professor);
  const remetente = primeiroNome(currentUserNome) || 'a equipe';
  const profNome = a.professor ? primeiroNome(a.professor) : '';

  const professor = juntar([
    `Olá${profNome ? `, prof. ${profNome}` : ''}! Tudo bem? 😊`,
    '',
    `Aqui é ${remetente}, do Comercial da Fatec Ivaiporã.`,
    '',
    `${artigo} ${quando}, o(a) aluno(a) *${a.alunoNome}* vai assistir à sua aula${a.curso ? ` de ${a.curso}` : ''} como *aula experimental* — está conhecendo o curso e pensando em se matricular.`,
    a.recebidoPor ? `${recebe} vai recebê-lo(a) e levar até a sala${a.sala ? ` (${a.sala})` : ''}.` : (a.sala ? `A aula será na ${a.sala}.` : null),
    '',
    'Se puder, dê as boas-vindas, apresente-o(a) à turma e inclua na atividade do dia. Queremos que ele(a) tenha a melhor experiência possível! 🙌',
    a.observacoes ? '' : null,
    a.observacoes ? `Observação: ${a.observacoes}` : null,
    '',
    'Muito obrigado(a)!'
  ]);

  const diaMaiusculo = dia.charAt(0).toUpperCase() + dia.slice(1);
  const aluno = juntar([
    `Olá, ${primeiroNome(a.alunoNome)}! Tudo bem? 😊`,
    '',
    `Sua *aula experimental${a.curso ? ` de ${a.curso}` : ''}* na Fatec Ivaiporã está confirmada!`,
    '',
    `📅 ${diaMaiusculo}`,
    a.horario ? `⏰ ${a.horario}` : null,
    a.sala ? `📍 ${a.sala}` : null,
    a.professor ? `👩‍🏫 Aula com o(a) prof. ${prof}` : null,
    '',
    a.recebidoPor
      ? `Quando chegar, procure por *${recebe}*, do setor Comercial — vamos te receber e te acompanhar até a sala.`
      : 'Quando chegar, procure o setor Comercial — vamos te receber e te acompanhar até a sala.',
    'Chegue uns 10 minutinhos antes para dar tempo de se situar. 😉',
    '',
    'Qualquer dúvida, é só responder esta mensagem. Te esperamos!'
  ]);

  return { professor, aluno };
}

let aulaMsgAtual = null;
function abrirMensagens(id) {
  const a = aulas.find(x => x.id === id);
  if (!a) return;
  aulaMsgAtual = a;
  const { professor, aluno } = montarMensagens(a);
  document.getElementById('msg-sub').textContent = `${a.alunoNome} · ${a.curso || ''} · ${fmtData(a.data)}${a.horario ? ' ' + a.horario : ''}`;
  document.getElementById('msg-professor').value = professor;
  document.getElementById('msg-aluno').value = aluno;
  atualizarLinksZap();
  abrir('modal-msg');
}

function atualizarLinksZap() {
  if (!aulaMsgAtual) return;
  const txtProf = encodeURIComponent(document.getElementById('msg-professor').value);
  const txtAluno = encodeURIComponent(document.getElementById('msg-aluno').value);
  document.getElementById('zap-professor').href = `https://wa.me/?text=${txtProf}`;
  const num = numeroZap(aulaMsgAtual.alunoContato);
  const zapAluno = document.getElementById('zap-aluno');
  zapAluno.href = num ? `https://wa.me/${num}?text=${txtAluno}` : `https://wa.me/?text=${txtAluno}`;
  zapAluno.title = num ? `Abrir conversa com ${aulaMsgAtual.alunoContato}` : 'Sem telefone cadastrado — escolha o contato no WhatsApp';
}

async function copiar(idCampo) {
  const campo = document.getElementById(idCampo);
  try {
    await navigator.clipboard.writeText(campo.value);
  } catch (e) {
    campo.select();
    document.execCommand('copy');
  }
  showToast('Mensagem copiada!');
}
