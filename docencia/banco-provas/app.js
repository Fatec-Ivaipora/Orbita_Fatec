// ================================================================
//  ÓRBITA — MÓDULO BANCO DE PROVAS (Docência)
//  Banco de questões por curso/disciplina/período/bimestre, base pra
//  montar Simulados/Provas Bimestrais/Exames (próximas etapas).
// ================================================================
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
let appInitialized = false;
let initializedRole = null;

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

function ordinal(n) { return `${n}º`; }

// ================================================================
//  ESTADO
// ================================================================
let meusCursos = [];
let cursoAtivo = null;
let disciplinas = [];
let questoes = [];
let semestresBanco = [];
const DISCIPLINA_GERAL_ID = 'geral';

// ================================================================
//  AUTH GUARD E INICIALIZAÇÃO (mesmo padrão dos demais módulos)
// ================================================================
const cached = getCachedAuth();
if (cached) {
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
  const token = await user.getIdToken();

  let role = 'visitante';
  try {
    const userData = await apiFetch('/usuarios/me');
    role = userData.role || 'visitante';
  } catch (err) {
    role = cached ? cached.role : 'visitante';
  }
  currentRole = role;
  setCachedAuth(user, role, token);

  if (!appInitialized || initializedRole !== role) {
    initializedRole = role;
    initApp(user, role);
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;
  currentRole = role;

  const guard = document.getElementById('auth-guard');
  if (guard) guard.classList.add('hidden');

  setupLayout(user, role, 'banco-provas', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  bindEventos();
  await carregarMeusCursos();
}

// ================================================================
//  CURSOS
// ================================================================
async function carregarMeusCursos() {
  try {
    meusCursos = await apiFetch('/banco-provas/meus-cursos');
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  const select = document.getElementById('bp-curso-select');
  const aviso = document.getElementById('bp-sem-curso-aviso');
  const conteudo = document.getElementById('bp-conteudo');

  if (!meusCursos.length) {
    select.innerHTML = '';
    select.classList.add('hidden');
    aviso.classList.remove('hidden');
    conteudo.classList.add('hidden');
    return;
  }

  select.classList.remove('hidden');
  aviso.classList.add('hidden');
  select.innerHTML = meusCursos.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  cursoAtivo = meusCursos[0].id;
  select.value = cursoAtivo;
  conteudo.classList.remove('hidden');

  await carregarTudoDoCurso();
}

async function carregarTudoDoCurso() {
  await carregarDisciplinas();
  popularSelectsPeriodo();
  popularSelectDisciplinaFiltro();
  popularSelectDisciplinaModal();
  renderDisciplinas();
  await carregarSemestresBanco();
  popularSelectSemestreFiltro();
  await carregarQuestoes();
  renderQuestoes();
  await carregarRevisao();
  renderRevisao();
  await carregarProvas();
  renderProvas();
}

// Semestres DISTINTOS já usados em questões deste curso — pedido explícito
// (18/09): "somente o que tem no banco para não ter erros" (texto livre
// deixava "2026.2" e "2026-2" não baterem no filtro por igualdade exata).
async function carregarSemestresBanco() {
  try {
    semestresBanco = await apiFetch(`/banco-provas/questoes/semestres?curso=${encodeURIComponent(cursoAtivo)}`);
  } catch (err) {
    semestresBanco = [];
  }
}

function popularSelectSemestreFiltro() {
  const select = document.getElementById('bp-filtro-semestre');
  const valorAtual = select.value;
  select.innerHTML = '<option value="">Todos os semestres</option>' +
    semestresBanco.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  select.value = semestresBanco.includes(valorAtual) ? valorAtual : '';
}

// Select do campo "Semestre" da prova — só semestres que já têm questão
// cadastrada (sem isso não tem o que selecionar na etapa de montar a
// prova). Sempre inclui uma opção vazia (prova sem semestre amarrado).
function popularSelectSemestreProva() {
  const select = document.getElementById('prova-semestre');
  select.innerHTML = '<option value="">— sem semestre —</option>' +
    semestresBanco.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

// ================================================================
//  DISCIPLINAS
// ================================================================
async function carregarDisciplinas() {
  try {
    disciplinas = await apiFetch(`/banco-provas/disciplinas?curso=${encodeURIComponent(cursoAtivo)}`);
  } catch (err) {
    showToast(err.message, 'error');
    disciplinas = [];
  }
}

function popularSelectsPeriodo() {
  const periodosUsados = [...new Set(disciplinas.map(d => d.periodo))].sort((a, b) => a - b);
  const maxPeriodo = periodosUsados.length ? Math.max(12, ...periodosUsados) : 12;

  const filtroSelect = document.getElementById('bp-filtro-periodo');
  const valorFiltroAtual = filtroSelect.value;
  filtroSelect.innerHTML = '<option value="">Todos os períodos</option>' +
    Array.from({ length: maxPeriodo }, (_, i) => i + 1).map(p => `<option value="${p}">${ordinal(p)} Período</option>`).join('');
  filtroSelect.value = valorFiltroAtual;

  const modalSelect = document.getElementById('disciplina-periodo');
  modalSelect.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1).map(p => `<option value="${p}">${ordinal(p)} Período</option>`).join('');
}

function popularSelectDisciplinaFiltro() {
  const select = document.getElementById('bp-filtro-disciplina');
  const valorAtual = select.value;
  select.innerHTML = '<option value="">Todas as disciplinas</option><option value="geral">Conhecimentos Gerais</option>' +
    disciplinas.map(d => `<option value="${d.id}">${ordinal(d.periodo)} · ${esc(d.nome)}</option>`).join('');
  select.value = valorAtual;
}

function popularSelectDisciplinaModal() {
  const select = document.getElementById('questao-disciplina');
  select.innerHTML = '<option value="">Selecione</option><option value="geral">Conhecimentos Gerais</option>' +
    disciplinas.map(d => `<option value="${d.id}">${ordinal(d.periodo)} · ${esc(d.nome)}</option>`).join('');
}

function nomeDisciplina(id) {
  if (id === DISCIPLINA_GERAL_ID) return 'Conhecimentos Gerais';
  const d = disciplinas.find(x => x.id === id);
  return d ? `${ordinal(d.periodo)} · ${d.nome}` : '—';
}

function renderDisciplinas() {
  const tbody = document.getElementById('bp-disciplinas-tbody');
  if (!disciplinas.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="tabela-msg">Nenhuma disciplina cadastrada ainda. Cadastre a primeira acima.</td></tr>';
    return;
  }

  const porPeriodo = new Map();
  disciplinas.forEach(d => {
    if (!porPeriodo.has(d.periodo)) porPeriodo.set(d.periodo, []);
    porPeriodo.get(d.periodo).push(d);
  });

  tbody.innerHTML = [...porPeriodo.keys()].sort((a, b) => a - b).map(periodo => {
    const header = `<tr class="grupo-header"><td colspan="3">${ordinal(periodo)} Período</td></tr>`;
    const linhas = porPeriodo.get(periodo)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(d => `
        <tr>
          <td>${esc(d.nome)}${d.nomeBreve ? ` <span style="color:var(--text-secondary);">(${esc(d.nomeBreve)})</span>` : ''}</td>
          <td style="text-align:right;">${questoes.filter(q => q.disciplinaId === d.id).length || '—'}</td>
          <td class="acoes-col">
            <button type="button" class="btn-icon action-execute" data-editar-disciplina="${d.id}" title="Editar">✎</button>
            <button type="button" class="btn-icon btn-icon-perigo action-execute" data-excluir-disciplina="${d.id}" title="Excluir">🗑</button>
          </td>
        </tr>`).join('');
    return header + linhas;
  }).join('');

  tbody.querySelectorAll('[data-editar-disciplina]').forEach(btn => {
    btn.addEventListener('click', () => abrirModalDisciplina(btn.dataset.editarDisciplina));
  });
  tbody.querySelectorAll('[data-excluir-disciplina]').forEach(btn => {
    btn.addEventListener('click', () => excluirDisciplina(btn.dataset.excluirDisciplina));
  });
}

function abrirModalDisciplina(id) {
  document.getElementById('form-disciplina').reset();
  document.getElementById('disciplina-id').value = id || '';
  document.getElementById('modal-disciplina-title').textContent = id ? 'Editar Disciplina' : 'Nova Disciplina';

  if (id) {
    const d = disciplinas.find(x => x.id === id);
    if (d) {
      document.getElementById('disciplina-periodo').value = d.periodo;
      document.getElementById('disciplina-nome').value = d.nome;
      document.getElementById('disciplina-nome-breve').value = d.nomeBreve || '';
    }
  }
  document.getElementById('modal-disciplina').classList.remove('hidden');
}

function fecharModalDisciplina() {
  document.getElementById('modal-disciplina').classList.add('hidden');
}

async function salvarDisciplina(e) {
  e.preventDefault();
  const id = document.getElementById('disciplina-id').value;
  const payload = {
    curso: cursoAtivo,
    periodo: document.getElementById('disciplina-periodo').value,
    nome: document.getElementById('disciplina-nome').value.trim(),
    nomeBreve: document.getElementById('disciplina-nome-breve').value.trim()
  };
  try {
    if (id) {
      await apiFetch(`/banco-provas/disciplinas/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Disciplina atualizada.');
    } else {
      await apiFetch('/banco-provas/disciplinas', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Disciplina cadastrada.');
    }
    fecharModalDisciplina();
    await carregarTudoDoCurso();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function excluirDisciplina(id) {
  const d = disciplinas.find(x => x.id === id);
  if (!confirm(`Excluir a disciplina "${d ? d.nome : ''}"? Só funciona se ela não tiver nenhuma questão no banco.`)) return;
  try {
    await apiFetch(`/banco-provas/disciplinas/${id}`, { method: 'DELETE' });
    showToast('Disciplina excluída.');
    await carregarTudoDoCurso();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================================================================
//  QUESTÕES
// ================================================================
async function carregarQuestoes() {
  const periodo = document.getElementById('bp-filtro-periodo').value;
  const disciplinaId = document.getElementById('bp-filtro-disciplina').value;
  const bimestre = document.getElementById('bp-filtro-bimestre').value;
  const chamada = document.getElementById('bp-filtro-chamada').value;
  const tipo = document.getElementById('bp-filtro-tipo').value;
  const dificuldade = document.getElementById('bp-filtro-dificuldade').value;
  const semestre = document.getElementById('bp-filtro-semestre').value.trim();

  const params = new URLSearchParams({ curso: cursoAtivo, status: 'publicada' });
  if (periodo) params.set('periodo', periodo);
  if (disciplinaId) params.set('disciplinaId', disciplinaId);
  if (bimestre) params.set('bimestre', bimestre);
  if (chamada) params.set('chamada', chamada);
  if (tipo) params.set('tipo', tipo);
  if (dificuldade) params.set('dificuldade', dificuldade);
  if (semestre) params.set('semestre', semestre);

  try {
    const [doCurso, gerais] = await Promise.all([
      apiFetch(`/banco-provas/questoes?${params.toString()}`),
      disciplinaId && disciplinaId !== DISCIPLINA_GERAL_ID ? Promise.resolve([]) : apiFetch('/banco-provas/questoes-gerais')
    ]);
    questoes = disciplinaId === DISCIPLINA_GERAL_ID ? gerais : [...doCurso, ...gerais];
  } catch (err) {
    showToast(err.message, 'error');
    questoes = [];
  }
}

function renderQuestoes() {
  const lista = document.getElementById('bp-questoes-lista');
  const vazio = document.getElementById('bp-questoes-vazio');

  if (!questoes.length) {
    lista.innerHTML = '';
    vazio.textContent = 'Nenhuma questão encontrada. Que tal cadastrar a primeira?';
    vazio.classList.remove('hidden');
    return;
  }
  vazio.classList.add('hidden');

  lista.innerHTML = questoes.map(q => `
    <div class="bp-q-row">
      <div class="bp-q-row-main">
        <div class="bp-q-row-badges">
          <span class="bp-badge ${q.tipo === 'objetiva' ? 'bp-badge-objetiva' : 'bp-badge-dissertativa'}">${q.tipo === 'objetiva' ? 'Objetiva' : 'Dissertativa'}</span>
          <span class="bp-badge bp-badge-dificuldade-${q.dificuldade || 'media'}">${DIFICULDADE_LABEL[q.dificuldade] || DIFICULDADE_LABEL.media}</span>
          ${q.disciplinaId === DISCIPLINA_GERAL_ID ? '<span class="bp-badge bp-badge-geral">Conhecimentos Gerais</span>' : ''}
          ${q.bimestre ? `<span class="bp-badge" style="background:#f1f5f9; color:var(--text-secondary);">${q.bimestre}º Bimestre</span>` : ''}
          ${q.chamada ? `<span class="bp-badge" style="background:#f1f5f9; color:var(--text-secondary);">${q.chamada}ª Chamada</span>` : ''}
        </div>
        <div class="bp-q-row-titulo">${esc(q.enunciadoHtml).slice(0, 220)}${q.enunciadoHtml.length > 220 ? '…' : ''}</div>
        <div class="bp-q-row-meta">${esc(nomeDisciplina(q.disciplinaId))}${q.professorNome ? ` · por ${esc(q.professorNome)}` : ''}</div>
      </div>
      <div class="bp-q-row-actions">
        <button type="button" class="btn-icon action-execute" data-editar-questao="${q.id}" title="Editar">✎</button>
        <button type="button" class="btn-icon btn-icon-perigo action-execute" data-excluir-questao="${q.id}" title="Excluir">🗑</button>
      </div>
    </div>`).join('');

  lista.querySelectorAll('[data-editar-questao]').forEach(btn => {
    btn.addEventListener('click', () => abrirModalQuestao(btn.dataset.editarQuestao));
  });
  lista.querySelectorAll('[data-excluir-questao]').forEach(btn => {
    btn.addEventListener('click', () => excluirQuestao(btn.dataset.excluirQuestao));
  });
}

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const DIFICULDADE_LABEL = { facil: 'Fácil', media: 'Média', intermediaria: 'Intermediária', dificil: 'Difícil' };

function renderAlternativasEditor(alternativas, gabarito) {
  const lista = document.getElementById('questao-alternativas-lista');
  lista.innerHTML = '';
  alternativas.forEach((texto, i) => adicionarLinhaAlternativa(texto, LETRAS[i] === gabarito));
}

function adicionarLinhaAlternativa(texto = '', correta = false) {
  const lista = document.getElementById('questao-alternativas-lista');
  if (lista.children.length >= 5) return;
  const letra = LETRAS[lista.children.length];

  const row = document.createElement('div');
  row.className = `alternativa-row${correta ? ' alternativa-correta' : ''}`;
  row.innerHTML = `
    <input type="radio" name="questao-gabarito" class="alternativa-gabarito-radio" ${correta ? 'checked' : ''} title="Marcar como correta">
    <input type="text" placeholder="Texto da alternativa" value="${esc(texto)}" maxlength="500">
    <span class="alternativa-letra">${letra}</span>
  `;
  lista.appendChild(row);

  row.querySelector('input[type="radio"]').addEventListener('change', () => {
    lista.querySelectorAll('.alternativa-row').forEach(r => r.classList.remove('alternativa-correta'));
    row.classList.add('alternativa-correta');
  });
}

function ajustarEditorPorTipo() {
  const tipo = document.getElementById('questao-tipo').value;
  document.getElementById('questao-bloco-alternativas').classList.toggle('hidden', tipo !== 'objetiva');
}

function abrirModalQuestao(id) {
  document.getElementById('form-questao').reset();
  document.getElementById('questao-id').value = id || '';
  document.getElementById('modal-questao-title').textContent = id ? 'Editar Questão' : 'Nova Questão';
  document.getElementById('questao-alternativas-lista').innerHTML = '';

  if (id) {
    const q = questoes.find(x => x.id === id);
    if (q) {
      document.getElementById('questao-disciplina').value = q.disciplinaId || '';
      document.getElementById('questao-bimestre').value = q.bimestre || '';
      document.getElementById('questao-chamada').value = q.chamada || '';
      document.getElementById('questao-semestre').value = q.semestre || '';
      document.getElementById('questao-tipo').value = q.tipo;
      document.getElementById('questao-dificuldade').value = q.dificuldade || 'media';
      document.getElementById('questao-enunciado').value = q.enunciadoHtml;
      document.getElementById('questao-valor').value = q.valor ?? '';
      document.getElementById('questao-professor').value = q.professorNome || '';
      if (q.tipo === 'objetiva') {
        renderAlternativasEditor((q.alternativas || []).map(a => a.texto), q.gabarito);
      }
    }
  } else {
    document.getElementById('questao-tipo').value = 'objetiva';
    document.getElementById('questao-dificuldade').value = 'media';
    ['', '', ''].forEach(() => adicionarLinhaAlternativa());
  }
  ajustarEditorPorTipo();
  document.getElementById('modal-questao').classList.remove('hidden');
}

function fecharModalQuestao() {
  document.getElementById('modal-questao').classList.add('hidden');
}

function lerAlternativasDoForm() {
  return [...document.querySelectorAll('#questao-alternativas-lista .alternativa-row')].map((row, i) => ({
    letra: LETRAS[i],
    texto: row.querySelector('input[type="text"]').value.trim()
  }));
}

function lerGabaritoDoForm() {
  const linhas = [...document.querySelectorAll('#questao-alternativas-lista .alternativa-row')];
  const idx = linhas.findIndex(row => row.querySelector('input[type="radio"]').checked);
  return idx >= 0 ? LETRAS[idx] : null;
}

async function salvarQuestao(e) {
  e.preventDefault();
  const id = document.getElementById('questao-id').value;
  const tipo = document.getElementById('questao-tipo').value;
  const disciplinaId = document.getElementById('questao-disciplina').value;

  const payload = {
    curso: disciplinaId === DISCIPLINA_GERAL_ID ? undefined : cursoAtivo,
    disciplinaId,
    bimestre: document.getElementById('questao-bimestre').value,
    chamada: document.getElementById('questao-chamada').value,
    semestre: document.getElementById('questao-semestre').value.trim(),
    tipo,
    dificuldade: document.getElementById('questao-dificuldade').value,
    enunciadoHtml: document.getElementById('questao-enunciado').value.trim(),
    valor: document.getElementById('questao-valor').value,
    professorNome: document.getElementById('questao-professor').value.trim()
  };
  if (tipo === 'objetiva') {
    payload.alternativas = lerAlternativasDoForm().filter(a => a.texto);
    payload.gabarito = lerGabaritoDoForm();
  }

  try {
    if (id) {
      await apiFetch(`/banco-provas/questoes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Questão atualizada.');
    } else {
      await apiFetch('/banco-provas/questoes', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Questão cadastrada.');
    }
    fecharModalQuestao();
    await carregarQuestoes();
    renderQuestoes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function excluirQuestao(id) {
  if (!confirm('Excluir esta questão do banco?')) return;
  try {
    await apiFetch(`/banco-provas/questoes/${id}`, { method: 'DELETE' });
    showToast('Questão excluída.');
    await carregarQuestoes();
    renderQuestoes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================================================================
//  IMPORTAÇÃO DO WORD + REVISÃO
// ================================================================
let revisaoQuestoes = [];

async function carregarRevisao() {
  try {
    revisaoQuestoes = await apiFetch(`/banco-provas/questoes/revisao?curso=${encodeURIComponent(cursoAtivo)}`);
  } catch (err) {
    revisaoQuestoes = [];
  }
}

// Sugere a disciplina cadastrada cujo NOME tem mais palavras em comum com o
// texto da seção detectada no Word (ex.: "GESTÃO DE PESSOAS" → disciplina
// "Gestão de Pessoas"). Mesma ideia do Banco MED-FATEC — exige 1+ palavra em
// comum, sem arriscar palpite quando não bate nada.
function sugerirDisciplina(categoriaSugeridaTexto) {
  if (!categoriaSugeridaTexto) return null;
  const semAcento = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const tokensAlvo = new Set(semAcento(categoriaSugeridaTexto).split(/[^A-Z0-9]+/).filter(w => w.length >= 3));
  if (!tokensAlvo.size) return null;
  let melhor = null, melhorScore = 0;
  disciplinas.forEach(d => {
    const tokensNome = semAcento(d.nome).split(/[^A-Z0-9]+/).filter(w => w.length >= 3);
    const bateram = tokensNome.filter(t => tokensAlvo.has(t)).length;
    if (bateram > 0 && bateram > melhorScore) { melhorScore = bateram; melhor = d; }
  });
  return melhor;
}

function renderRevisao() {
  const lista = document.getElementById('bp-revisao-lista');
  const vazio = document.getElementById('bp-revisao-vazio');
  const badge = document.getElementById('bp-revisao-badge');

  badge.textContent = revisaoQuestoes.length;
  badge.classList.toggle('hidden', revisaoQuestoes.length === 0);

  if (!revisaoQuestoes.length) {
    lista.innerHTML = '';
    vazio.classList.remove('hidden');
    return;
  }
  vazio.classList.add('hidden');

  // Agrupa por (loteId + categoriaSugeridaTexto) — um arquivo pode ter mais
  // de uma disciplina junto.
  const grupos = new Map();
  revisaoQuestoes.forEach(q => {
    const chave = `${q.loteId}::${q.categoriaSugeridaTexto || ''}`;
    if (!grupos.has(chave)) grupos.set(chave, { loteId: q.loteId, categoriaSugeridaTexto: q.categoriaSugeridaTexto, itens: [] });
    grupos.get(chave).itens.push(q);
  });

  lista.innerHTML = [...grupos.values()].map((g, i) => {
    const sugestao = sugerirDisciplina(g.categoriaSugeridaTexto);
    const opcoes = '<option value="">Selecione a disciplina</option><option value="geral">Conhecimentos Gerais</option>' +
      disciplinas.map(d => `<option value="${d.id}" ${sugestao && sugestao.id === d.id ? 'selected' : ''}>${ordinal(d.periodo)} · ${esc(d.nome)}</option>`).join('');
    return `
      <div class="bp-revisao-card" data-grupo-index="${i}">
        <div class="bp-revisao-card-topo">
          <div>
            <div class="bp-revisao-card-titulo">${esc(g.categoriaSugeridaTexto || '(sem seção detectada)')}</div>
            <div class="bp-revisao-card-qtd">${g.itens.length} questão(ões)${sugestao ? ` · sugestão: ${esc(sugestao.nome)}` : ''}</div>
          </div>
          <div class="bp-revisao-card-acoes">
            <select class="select-filter bp-revisao-select-disciplina">${opcoes}</select>
            <select class="select-filter bp-revisao-select-bimestre">
              <option value="">Bimestre —</option>
              <option value="1">1º Bimestre</option>
              <option value="2">2º Bimestre</option>
            </select>
            <select class="select-filter bp-revisao-select-chamada">
              <option value="">Chamada —</option>
              <option value="1">1ª Chamada</option>
              <option value="2">2ª Chamada</option>
              <option value="exame">Exame</option>
            </select>
            <input type="text" class="select-filter bp-revisao-input-semestre" placeholder="Semestre (ex.: 2026.2)" style="min-width:150px;">
            <button type="button" class="btn-primary bp-revisao-btn-confirmar">Confirmar</button>
            <button type="button" class="btn-secondary bp-revisao-btn-descartar">Descartar</button>
          </div>
        </div>
      </div>`;
  }).join('');

  [...grupos.values()].forEach((g, i) => {
    const card = lista.querySelector(`[data-grupo-index="${i}"]`);
    card.querySelector('.bp-revisao-btn-confirmar').addEventListener('click', () => resolverGrupoRevisao(g, {
      disciplinaId: card.querySelector('.bp-revisao-select-disciplina').value,
      bimestre: card.querySelector('.bp-revisao-select-bimestre').value,
      chamada: card.querySelector('.bp-revisao-select-chamada').value,
      semestre: card.querySelector('.bp-revisao-input-semestre').value.trim()
    }));
    card.querySelector('.bp-revisao-btn-descartar').addEventListener('click', () => descartarGrupoRevisao(g));
  });
}

async function resolverGrupoRevisao(grupo, dados) {
  if (!dados.disciplinaId) { showToast('Selecione a disciplina.', 'error'); return; }
  if (!dados.chamada) { showToast('Selecione a chamada.', 'error'); return; }
  // Obrigatório (18/09): questão sem bimestre some da tela de montar prova
  // sempre que o coordenador filtra por bimestre — já aconteceu com gestão
  // comercial (27 questões publicadas sem bimestre, ficaram "invisíveis").
  // Exame não tem bimestre (só acontece depois do 2º bimestre), então essa
  // exigência não vale quando a chamada é "Exame".
  if (dados.chamada !== 'exame' && !dados.bimestre) { showToast('Selecione o bimestre.', 'error'); return; }
  try {
    await apiFetch(`/banco-provas/questoes/lote/${grupo.loteId}/resolver`, {
      method: 'PUT',
      body: JSON.stringify({ ...dados, categoriaSugeridaTexto: grupo.categoriaSugeridaTexto })
    });
    showToast('Disciplina confirmada — questões publicadas.');
    await carregarTudoDoCurso();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function descartarGrupoRevisao(grupo) {
  if (!confirm(`Descartar ${grupo.itens.length} questão(ões) importada(s) desse grupo? Não tem como desfazer.`)) return;
  try {
    const params = new URLSearchParams();
    if (grupo.categoriaSugeridaTexto !== undefined && grupo.categoriaSugeridaTexto !== null) params.set('categoriaSugeridaTexto', grupo.categoriaSugeridaTexto);
    await apiFetch(`/banco-provas/questoes/lote/${grupo.loteId}?${params.toString()}`, { method: 'DELETE' });
    showToast('Grupo descartado.');
    await carregarRevisao();
    renderRevisao();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Estado da importação em 2 etapas. O gabarito marcado é salvo automaticamente
// no localStorage a cada clique — pedido explícito (17/09): "precisa salvar o
// progresso... eu saí da tela das perguntas e perdi tudo que estava fazendo".
// Só é gravado no Firestore de fato quando o coordenador clica "Confirmar".
const RASCUNHO_IMPORTACAO_KEY = 'bp_importacao_rascunho_v1';
let importarQuestoesAnalisadas = [];
let importarAlternativasPorQuestao = 5;
let importarCursoSelecionado = null;

function salvarRascunhoImportacao() {
  try {
    localStorage.setItem(RASCUNHO_IMPORTACAO_KEY, JSON.stringify({
      curso: importarCursoSelecionado,
      alternativasPorQuestao: importarAlternativasPorQuestao,
      professorNome: document.getElementById('importar-professor').value.trim(),
      questoes: importarQuestoesAnalisadas,
      salvoEm: new Date().toISOString()
    }));
  } catch (err) { /* localStorage indisponível (modo privado etc.) — segue sem rascunho */ }
}

function lerRascunhoImportacao() {
  try {
    const bruto = localStorage.getItem(RASCUNHO_IMPORTACAO_KEY);
    return bruto ? JSON.parse(bruto) : null;
  } catch (err) {
    return null;
  }
}

function descartarRascunhoImportacao() {
  try { localStorage.removeItem(RASCUNHO_IMPORTACAO_KEY); } catch (err) { /* ignora */ }
}

// Preenche o select de curso da importação com os cursos do coordenador —
// pedido explícito (17/09): "quando for importado, perguntar o curso, porque
// se você não perceber ele tá indo pro agronegócio que é o primeiro da fila".
// Nunca herda silenciosamente o curso do filtro principal da página.
function popularSelectCursoImportacao(cursoPreSelecionado) {
  const select = document.getElementById('importar-curso');
  select.innerHTML = meusCursos.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (cursoPreSelecionado && meusCursos.some(c => c.id === cursoPreSelecionado)) {
    select.value = cursoPreSelecionado;
  }
}

function abrirModalImportar() {
  document.getElementById('modal-importar').classList.remove('hidden');

  const rascunho = lerRascunhoImportacao();
  if (rascunho && rascunho.questoes && rascunho.questoes.length) {
    popularSelectCursoImportacao(rascunho.curso);
    importarCursoSelecionado = rascunho.curso;
    importarAlternativasPorQuestao = rascunho.alternativasPorQuestao || 5;
    importarQuestoesAnalisadas = rascunho.questoes;
    document.getElementById('importar-professor').value = rascunho.professorNome || '';
    document.getElementById('importar-etapa-arquivo').classList.add('hidden');
    document.getElementById('importar-etapa-gabarito').classList.remove('hidden');
    document.getElementById('importar-rascunho-aviso').classList.remove('hidden');
    const nomeCurso = (meusCursos.find(c => c.id === rascunho.curso) || {}).name || rascunho.curso;
    document.getElementById('importar-gabarito-curso-nome').textContent = nomeCurso;
    renderGabaritoImportacao();
  } else {
    document.getElementById('form-importar').reset();
    popularSelectCursoImportacao(cursoAtivo);
    document.getElementById('importar-etapa-arquivo').classList.remove('hidden');
    document.getElementById('importar-etapa-gabarito').classList.add('hidden');
    document.getElementById('importar-rascunho-aviso').classList.add('hidden');
    importarQuestoesAnalisadas = [];
  }
}

function fecharModalImportar() {
  document.getElementById('modal-importar').classList.add('hidden');
}

function descartarImportacaoEComecarDeNovo() {
  descartarRascunhoImportacao();
  importarQuestoesAnalisadas = [];
  document.getElementById('form-importar').reset();
  popularSelectCursoImportacao(cursoAtivo);
  document.getElementById('importar-etapa-arquivo').classList.remove('hidden');
  document.getElementById('importar-etapa-gabarito').classList.add('hidden');
  document.getElementById('importar-rascunho-aviso').classList.add('hidden');
}

function arquivoParaBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(arquivo);
  });
}

const LETRAS_GABARITO = ['A', 'B', 'C', 'D', 'E'];

// ETAPA 1 -> 2: só lê o arquivo, nada é gravado ainda.
async function analisarImportacao(e) {
  e.preventDefault();
  const arquivo = document.getElementById('importar-arquivo').files[0];
  if (!arquivo) return;
  importarCursoSelecionado = document.getElementById('importar-curso').value;
  if (!importarCursoSelecionado) {
    showToast('Selecione o curso antes de analisar o arquivo.', 'error');
    return;
  }
  const btn = document.getElementById('btn-analisar-importar');
  btn.disabled = true;
  btn.textContent = 'Analisando...';
  try {
    const arquivoBase64 = await arquivoParaBase64(arquivo);
    importarAlternativasPorQuestao = parseInt(document.getElementById('importar-alternativas').value, 10);
    const resp = await apiFetch('/banco-provas/questoes/analisar-docx', {
      method: 'POST',
      body: JSON.stringify({ arquivoBase64, alternativasPorQuestao: importarAlternativasPorQuestao })
    });
    importarQuestoesAnalisadas = resp.questoes.map(q => ({ ...q, gabarito: null }));
    document.getElementById('importar-etapa-arquivo').classList.add('hidden');
    document.getElementById('importar-etapa-gabarito').classList.remove('hidden');
    document.getElementById('importar-rascunho-aviso').classList.remove('hidden');
    const nomeCurso = (meusCursos.find(c => c.id === importarCursoSelecionado) || {}).name || importarCursoSelecionado;
    document.getElementById('importar-gabarito-curso-nome').textContent = nomeCurso;
    salvarRascunhoImportacao();
    renderGabaritoImportacao();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analisar arquivo';
  }
}

function voltarEtapaArquivo() {
  document.getElementById('importar-etapa-arquivo').classList.remove('hidden');
  document.getElementById('importar-etapa-gabarito').classList.add('hidden');
}

// ETAPA 2: marcar o gabarito CLICANDO na bolinha certa — pedido explícito
// (17/09): "ter que ir colocando número e letra às vezes a pessoa erra,
// precisamos facilitar o trabalho". Nada de digitar "1-C, 2-A...".
function renderGabaritoImportacao() {
  const lista = document.getElementById('importar-gabarito-lista');
  const letras = LETRAS_GABARITO.slice(0, importarAlternativasPorQuestao);

  // Mostra a disciplina detectada como cabeçalho de grupo (só quando muda da
  // anterior) — pedido explícito: "mostrar qual disciplina é pra ficar mais
  // fácil a conferência do gabarito", já que um arquivo só pode ter várias
  // disciplinas juntas (ex.: um Simulado).
  let categoriaAnterior = undefined;
  lista.innerHTML = importarQuestoesAnalisadas.map((q, i) => {
    const cabecalho = q.categoriaSugeridaTexto !== categoriaAnterior
      ? `<div class="gab-grupo-header">${esc(q.categoriaSugeridaTexto || '(sem disciplina detectada)')}</div>`
      : '';
    categoriaAnterior = q.categoriaSugeridaTexto;
    // Aviso quando a letra impressa no arquivo original não bate com a
    // letra que o sistema atribuiu por posição — pedido explícito (18/09).
    // O sistema adapta a qualquer formato desde que as alternativas venham
    // na ordem certa (A, B, C...); quando não vêm, isso aqui avisa em vez
    // de trocar a letra errada sem ninguém perceber.
    const temAviso = Array.isArray(q.avisoAlternativas) && q.avisoAlternativas.length > 0;
    const aviso = temAviso
      ? `<div class="gab-questao-aviso">Atenção: ${esc(q.avisoAlternativas.join(' '))}</div>`
      : '';
    // Dissertativa não tem alternativa pra marcar — mostra só como "sem
    // gabarito" e conta como resolvida, sem bolinhas de A a E.
    if (q.tipo === 'dissertativa') {
      return `
        ${cabecalho}
        <div class="gab-questao-row gab-marcada" data-idx="${i}">
          <div class="gab-questao-texto">
            <span class="gab-questao-num">${q.numero}.</span>${esc(q.enunciado).slice(0, 160)}${q.enunciado.length > 160 ? '…' : ''}
          </div>
          <div class="gab-bolinhas">
            <span class="bp-badge bp-badge-dissertativa">Dissertativa — sem gabarito</span>
          </div>
        </div>`;
    }
    return `
      ${cabecalho}
      <div class="gab-questao-row ${q.gabarito ? 'gab-marcada' : ''} ${temAviso ? 'gab-questao-com-aviso' : ''}" data-idx="${i}">
        <div class="gab-questao-texto">
          <span class="gab-questao-num">${q.numero}.</span>${esc(q.enunciado).slice(0, 160)}${q.enunciado.length > 160 ? '…' : ''}
          ${aviso}
        </div>
        <div class="gab-bolinhas">
          ${letras.map(l => `<button type="button" class="gab-bolinha ${q.gabarito === l ? 'gab-bolinha-marcada' : ''}" data-letra="${l}">${l}</button>`).join('')}
        </div>
      </div>`;
  }).join('');

  lista.querySelectorAll('.gab-questao-row').forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);
    row.querySelectorAll('.gab-bolinha').forEach(btn => {
      btn.addEventListener('click', () => {
        importarQuestoesAnalisadas[idx].gabarito = btn.dataset.letra;
        salvarRascunhoImportacao();
        renderGabaritoImportacao();
      });
    });
  });

  atualizarProgressoGabarito();
}

function atualizarProgressoGabarito() {
  const objetivas = importarQuestoesAnalisadas.filter(q => q.tipo !== 'dissertativa');
  const total = objetivas.length;
  const marcadas = objetivas.filter(q => q.gabarito).length;
  document.getElementById('importar-gabarito-progresso').textContent = `${marcadas} de ${total} marcadas`;
}

// "Imprime em outra tela" — pedido explícito, igual ao EvalBee: abre uma
// aba nova só com número + letra marcada, pronta pra Ctrl+P.
function imprimirGabaritoImportacao() {
  const janela = window.open('', '_blank');
  const linhas = importarQuestoesAnalisadas.map(q => `<tr><td>${q.numero}</td><td><strong>${esc(q.gabarito || '—')}</strong></td></tr>`).join('');
  janela.document.write(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>Gabarito</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #0B1F33; }
      h1 { font-size: 18px; margin-bottom: 4px; }
      p { color: #64748B; font-size: 12px; margin-top: 0; }
      table { border-collapse: collapse; width: 100%; max-width: 320px; }
      th, td { border: 1px solid #ccc; padding: 6px 12px; text-align: center; font-size: 14px; }
      th { background: #f1f5f9; }
    </style></head><body>
    <h1>Gabarito</h1>
    <p>Uso interno — não entregar ao aluno.</p>
    <table><thead><tr><th>Nº</th><th>Resposta</th></tr></thead><tbody>${linhas}</tbody></table>
    <script>window.print();</script>
    </body></html>`);
  janela.document.close();
}

// ETAPA 2 -> grava: envia as questões (já com gabarito marcado) pra fila de
// revisão.
async function confirmarImportacao() {
  const semGabarito = importarQuestoesAnalisadas.filter(q => q.tipo !== 'dissertativa' && !q.gabarito);
  if (semGabarito.length) {
    showToast(`Falta marcar o gabarito de ${semGabarito.length} questão(ões) (nº ${semGabarito.map(q => q.numero).join(', ')}).`, 'error');
    return;
  }
  const btn = document.getElementById('btn-confirmar-importar');
  btn.disabled = true;
  btn.textContent = 'Importando...';
  try {
    const resp = await apiFetch('/banco-provas/questoes/importar-docx', {
      method: 'POST',
      body: JSON.stringify({
        curso: importarCursoSelecionado,
        alternativasPorQuestao: importarAlternativasPorQuestao,
        professorNome: document.getElementById('importar-professor').value.trim(),
        questoes: importarQuestoesAnalisadas
      })
    });
    showToast(resp.message);
    descartarRascunhoImportacao();
    fecharModalImportar();
    await carregarRevisao();
    renderRevisao();
    document.querySelector('.bp-tab-btn[data-tab="revisao"]').click();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar importação';
  }
}

// ================================================================
//  PROVAS
// ================================================================
let provas = [];
let provaTipoAtivo = 'simulado';
let sorteioAtual = null;
let questoesManualDisponiveis = [];
let questoesManualSelecionadas = new Set();
// Ordem de impressão das questões selecionadas (array de ids) — o professor
// arrasta pra rearranjar; independente do Set acima, que só controla
// marcado/desmarcado. Pedido explícito: "precisa estar na mesma sequência
// que o professor manda a prova", nada de sorteio.
let questoesManualOrdem = [];

async function carregarProvas() {
  try {
    provas = await apiFetch(`/banco-provas/provas?curso=${encodeURIComponent(cursoAtivo)}`);
  } catch (err) {
    provas = [];
  }
}

const TIPO_PROVA_LABEL = { simulado: 'Simulado', bimestral: 'Prova Bimestral', exame: 'Exame' };

function renderProvas() {
  const tbody = document.getElementById('bp-provas-tbody');
  if (!provas.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="tabela-msg">Nenhuma prova criada ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = provas.map(p => `
    <tr>
      <td>${esc(p.nome)}</td>
      <td>${TIPO_PROVA_LABEL[p.tipo] || p.tipo}</td>
      <td style="text-align:right;">${(p.questoesIds || []).length}</td>
      <td class="acoes-col">
        <button type="button" class="btn-icon action-execute" data-preview-prova="${p.id}" title="Pré-visualizar antes de baixar">👁</button>
        <button type="button" class="btn-icon action-execute" data-exportar-prova="${p.id}" title="Exportar prova (.docx) — pro aluno">⬇</button>
        <button type="button" class="btn-icon action-execute" data-exportar-gabarito="${p.id}" title="Exportar gabarito (.docx) — uso interno, não entregar ao aluno">🔑</button>
        <button type="button" class="btn-icon btn-icon-perigo action-execute" data-excluir-prova="${p.id}" title="Excluir">🗑</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-preview-prova]').forEach(btn => {
    btn.addEventListener('click', () => abrirPreviewProva(btn.dataset.previewProva));
  });
  tbody.querySelectorAll('[data-exportar-prova]').forEach(btn => {
    btn.addEventListener('click', () => baixarArquivoProva(btn.dataset.exportarProva, 'exportar-docx', ''));
  });
  tbody.querySelectorAll('[data-exportar-gabarito]').forEach(btn => {
    btn.addEventListener('click', () => baixarArquivoProva(btn.dataset.exportarGabarito, 'exportar-gabarito', 'Gabarito - '));
  });
  tbody.querySelectorAll('[data-excluir-prova]').forEach(btn => {
    btn.addEventListener('click', () => excluirProva(btn.dataset.excluirProva));
  });
}

let previewProvaIdAtual = null;

async function abrirPreviewProva(id) {
  const modal = document.getElementById('modal-preview-prova');
  const conteudo = document.getElementById('preview-prova-conteudo');
  const prova = provas.find(p => p.id === id);
  document.getElementById('preview-prova-titulo').textContent = `Pré-visualizar: ${prova ? prova.nome : ''}`;
  conteudo.innerHTML = '<p class="tabela-msg">Carregando...</p>';
  previewProvaIdAtual = id;
  modal.classList.remove('hidden');
  try {
    const resp = await apiFetch(`/banco-provas/provas/${id}/preview`);
    conteudo.innerHTML = resp.html;
    bindGabaritoEditavelPreview();
  } catch (err) {
    conteudo.innerHTML = `<p class="tabela-msg">${esc(err.message)}</p>`;
  }
}

function fecharPreviewProva() {
  document.getElementById('modal-preview-prova').classList.add('hidden');
  previewProvaIdAtual = null;
}

// Clicar numa alternativa na pré-visualização corrige o gabarito na hora —
// pedido explícito (18/09): "editar no final seria legal, aí já atualiza
// no banco também, na mesma tela aonde tem pra visualizar e imprimir a
// prova". Salva na questão de verdade (PUT /questoes/:id/gabarito), não só
// visualmente no preview.
function bindGabaritoEditavelPreview() {
  const conteudo = document.getElementById('preview-prova-conteudo');
  conteudo.querySelectorAll('.bp-prev-questao[data-questao-id]').forEach(bloco => {
    const questaoId = bloco.dataset.questaoId;
    bloco.querySelectorAll('.bp-prev-alt-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const letra = btn.dataset.letra;
        btn.disabled = true;
        try {
          await apiFetch(`/banco-provas/questoes/${questaoId}/gabarito`, {
            method: 'PUT',
            body: JSON.stringify({ gabarito: letra })
          });
          bloco.querySelectorAll('.bp-prev-alt-btn').forEach(b => b.classList.toggle('bp-prev-alt-correta', b === btn));
          const q = questoes.find(x => x.id === questaoId);
          if (q) q.gabarito = letra;
          showToast('Gabarito atualizado.');
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  });
}

// Pedido explícito: "gera o arquivo final e o arquivo com o gabarito" —
// dois downloads separados (nunca junto), a prova (pro aluno) e o gabarito
// (uso interno). Mesma lógica de download pros dois, só muda o endpoint e o
// prefixo do nome do arquivo.
async function baixarArquivoProva(id, endpoint, prefixoNome) {
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/banco-provas/provas/${id}/${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Erro na API: ${res.status}`); }
    const blob = await res.blob();
    const prova = provas.find(p => p.id === id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefixoNome}${(prova ? prova.nome : 'prova').replace(/[^a-zA-Z0-9 ]/g, '')}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function excluirProva(id) {
  if (!confirm('Excluir esta prova?')) return;
  try {
    await apiFetch(`/banco-provas/provas/${id}`, { method: 'DELETE' });
    showToast('Prova excluída.');
    await carregarProvas();
    renderProvas();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function selecionarTipoProva(tipo) {
  provaTipoAtivo = tipo;
  document.querySelectorAll('[data-prova-tipo]').forEach(b => b.classList.toggle('active', b.dataset.provaTipo === tipo));
  document.getElementById('prova-bloco-simulado').classList.toggle('hidden', tipo !== 'simulado');
  document.getElementById('prova-bloco-manual').classList.toggle('hidden', tipo === 'simulado');
  // Exame só acontece depois do 2º bimestre (é a recuperação de quem não
  // atingiu a média no semestre inteiro) — pedido explícito (18/09): "não
  // tem bimestre no caso". Bimestral continua exigindo bimestre normalmente.
  const grupoBimestre = document.getElementById('prova-manual-bimestre-grupo');
  const grupoChamada = document.getElementById('prova-manual-chamada-grupo');
  const avisoExame = document.getElementById('prova-manual-exame-aviso');
  if (tipo === 'exame') {
    grupoBimestre.classList.add('hidden');
    grupoChamada.classList.add('hidden');
    avisoExame.classList.remove('hidden');
    document.getElementById('prova-manual-bimestre').value = '';
    document.getElementById('prova-manual-chamada').value = '';
  } else {
    grupoBimestre.classList.remove('hidden');
    grupoChamada.classList.remove('hidden');
    avisoExame.classList.add('hidden');
  }
  if (tipo !== 'simulado') {
    popularSelectManualDisciplina();
    // Reconsulta com o filtro certo (Exame = só dissertativa marcada como
    // "Exame", sem filtrar por bimestre) — sem isso, trocar de Bimestral
    // pra Exame com a disciplina já escolhida deixava a lista antiga na
    // tela até trocar de novo.
    if (document.getElementById('prova-manual-disciplina').value) carregarQuestoesManual();
  }
}

// Período/Série da prova — pedido explícito (17/09): "está aparecendo todas
// as disciplinas do curso, deveria aparecer somente as do [período] no
// edubox". Uma prova é sempre pra uma turma/período específico, não pra
// grade inteira do curso.
function popularSelectPeriodoProva() {
  const select = document.getElementById('prova-periodo');
  const periodosUsados = [...new Set(disciplinas.map(d => d.periodo))].sort((a, b) => a - b);
  const valorAtual = select.value;
  select.innerHTML = '<option value="">Selecione o período</option>' +
    periodosUsados.map(p => `<option value="${p}">${ordinal(p)} Período</option>`).join('');
  select.value = periodosUsados.includes(parseInt(valorAtual, 10)) ? valorAtual : '';
}

function disciplinasDoPeriodoProva() {
  const periodo = parseInt(document.getElementById('prova-periodo').value, 10);
  if (!periodo) return [];
  return disciplinas.filter(d => d.periodo === periodo);
}

function popularCotasSimulado() {
  const lista = document.getElementById('prova-cotas-lista');
  const doPeriodo = disciplinasDoPeriodoProva();
  if (!doPeriodo.length) {
    lista.innerHTML = '<p class="tabela-msg">Selecione o período acima pra ver as disciplinas.</p>';
    return;
  }
  const linhas = [
    { id: DISCIPLINA_GERAL_ID, label: 'Conhecimentos Gerais' },
    ...doPeriodo.map(d => ({ id: d.id, label: `${ordinal(d.periodo)} · ${d.nome}` }))
  ];
  lista.innerHTML = linhas.map(l => `
    <div class="prova-cota-row">
      <span>${esc(l.label)}</span>
      <input type="number" min="0" value="0" class="prova-cota-qtd" data-disciplina-id="${l.id}">
    </div>`).join('');
}

async function sortearProvaSimulado() {
  if (!document.getElementById('prova-periodo').value) {
    showToast('Selecione o período/série antes de montar a prova.', 'error');
    return;
  }
  const cotas = [...document.querySelectorAll('.prova-cota-qtd')]
    .map(input => ({ disciplinaId: input.dataset.disciplinaId, quantidade: parseInt(input.value, 10) || 0 }))
    .filter(c => c.quantidade > 0);
  if (!cotas.length) { showToast('Defina a quantidade de pelo menos uma disciplina.', 'error'); return; }

  try {
    sorteioAtual = await apiFetch('/banco-provas/provas/simular', {
      method: 'POST',
      body: JSON.stringify({
        curso: cursoAtivo, cotas,
        bimestre: document.getElementById('prova-simulado-bimestre').value,
        chamada: document.getElementById('prova-simulado-chamada').value
      })
    });
    renderPreviewSorteio();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderPreviewSorteio() {
  const preview = document.getElementById('prova-preview');
  if (!sorteioAtual) { preview.innerHTML = ''; return; }

  preview.innerHTML = sorteioAtual.map(grupo => {
    const nome = grupo.disciplinaId === DISCIPLINA_GERAL_ID ? 'Conhecimentos Gerais' : nomeDisciplina(grupo.disciplinaId);
    const aviso = grupo.quantidadeDisponivel < grupo.quantidadePedida
      ? ` — só ${grupo.quantidadeDisponivel} disponível(is) no banco (pediu ${grupo.quantidadePedida})`
      : '';
    return `
      <div class="prova-preview-grupo">
        <div class="prova-preview-grupo-titulo">${esc(nome)}${aviso}</div>
        ${grupo.questoes.map(q => `<div class="prova-preview-item">${esc(q.enunciadoHtml).slice(0, 140)}${q.enunciadoHtml.length > 140 ? '…' : ''}</div>`).join('') || '<div class="prova-preview-item">Nenhuma questão disponível.</div>'}
      </div>`;
  }).join('');
}

function popularSelectManualDisciplina() {
  const select = document.getElementById('prova-manual-disciplina');
  const valorAtual = select.value;
  const doPeriodo = disciplinasDoPeriodoProva();
  select.innerHTML = '<option value="">Selecione</option>' +
    doPeriodo.map(d => `<option value="${d.id}">${ordinal(d.periodo)} · ${esc(d.nome)}</option>`).join('');
  select.value = doPeriodo.some(d => d.id === valorAtual) ? valorAtual : '';
}

async function carregarQuestoesManual() {
  const disciplinaId = document.getElementById('prova-manual-disciplina').value;
  const bimestre = document.getElementById('prova-manual-bimestre').value;
  // Exame não filtra por bimestre/chamada escolhida na tela — sempre busca
  // as questões marcadas como "Exame" (pedido explícito 18/09).
  const chamada = provaTipoAtivo === 'exame' ? 'exame' : document.getElementById('prova-manual-chamada').value;
  // Reaproveita o campo "Semestre" do topo do modal — pedido explícito
  // (18/09): "o semestre vai trazer somente as do semestre 2026.2 pra
  // ajudar o professor... o banco vai ser enorme". Em branco = sem filtro
  // (mantém o comportamento antigo, útil pra reaproveitar questão de
  // semestre anterior).
  const semestre = document.getElementById('prova-semestre').value.trim();
  const lista = document.getElementById('prova-manual-lista');
  if (!disciplinaId) { lista.innerHTML = ''; questoesManualDisponiveis = []; return; }

  const params = new URLSearchParams({ curso: cursoAtivo, disciplinaId, status: 'publicada' });
  if (bimestre) params.set('bimestre', bimestre);
  if (chamada) params.set('chamada', chamada);
  if (semestre) params.set('semestre', semestre);
  // Exame é só dissertativa (pedido explícito 18/09: "o exame são somente 5
  // discursivas... as objetivas não aparecem no exame") — o professor
  // cadastra as dissertativas da disciplina antes, senão a lista some.
  // Bimestral continua mostrando os dois tipos misturados.
  if (provaTipoAtivo === 'exame') params.set('tipo', 'dissertativa');

  lista.innerHTML = '<p class="tabela-msg">Carregando...</p>';
  try {
    questoesManualDisponiveis = await apiFetch(`/banco-provas/questoes?${params.toString()}`);
  } catch (err) {
    questoesManualDisponiveis = [];
  }
  questoesManualSelecionadas = new Set();
  questoesManualOrdem = [];
  renderListaManual();
  renderOrdemLista();
}

function renderListaManual() {
  const lista = document.getElementById('prova-manual-lista');
  if (!questoesManualDisponiveis.length) {
    lista.innerHTML = provaTipoAtivo === 'exame'
      ? '<p class="tabela-msg">Nenhuma dissertativa cadastrada nessa disciplina ainda — cadastre as dissertativas em "Banco de Questões" antes de montar o exame.</p>'
      : '<p class="tabela-msg">Nenhuma questão publicada nessa disciplina ainda.</p>';
    return;
  }
  lista.innerHTML = questoesManualDisponiveis.map(q => `
    <label class="prova-manual-item">
      <input type="checkbox" class="prova-manual-check" value="${q.id}" ${questoesManualSelecionadas.has(q.id) ? 'checked' : ''}>
      <span>
        <span class="bp-badge ${q.tipo === 'objetiva' ? 'bp-badge-objetiva' : 'bp-badge-dissertativa'}" style="margin-right:0.4rem;">${q.tipo === 'objetiva' ? 'Objetiva' : 'Dissertativa'}</span>
        <span class="bp-badge bp-badge-dificuldade-${q.dificuldade || 'media'}" style="margin-right:0.4rem;">${DIFICULDADE_LABEL[q.dificuldade] || DIFICULDADE_LABEL.media}</span>
        ${esc(q.enunciadoHtml).slice(0, 160)}${q.enunciadoHtml.length > 160 ? '…' : ''}
      </span>
    </label>`).join('');

  lista.querySelectorAll('.prova-manual-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) {
        questoesManualSelecionadas.add(chk.value);
        if (!questoesManualOrdem.includes(chk.value)) questoesManualOrdem.push(chk.value);
      } else {
        questoesManualSelecionadas.delete(chk.value);
        questoesManualOrdem = questoesManualOrdem.filter(id => id !== chk.value);
      }
      renderOrdemLista();
    });
  });
}

// Lista das questões SELECIONADAS na ordem de impressão — arrastar uma
// linha muda a posição dela em `questoesManualOrdem`, que é o que vai pro
// `questoesIds` da prova (a ordem final de gravação/impressão).
function renderOrdemLista() {
  const container = document.getElementById('prova-ordem-lista');
  if (!container) return;
  if (!questoesManualOrdem.length) {
    container.innerHTML = '<p class="tabela-msg">Selecione questões acima pra definir a ordem.</p>';
    return;
  }
  const porId = new Map(questoesManualDisponiveis.map(q => [q.id, q]));
  container.innerHTML = questoesManualOrdem.map((id, i) => {
    const q = porId.get(id);
    if (!q) return '';
    return `
      <div class="prova-ordem-item" draggable="true" data-id="${id}">
        <span class="prova-ordem-arrasta" title="Arraste pra reordenar">⠿</span>
        <span class="prova-ordem-numero">${i + 1}</span>
        <span class="bp-badge ${q.tipo === 'objetiva' ? 'bp-badge-objetiva' : 'bp-badge-dissertativa'}">${q.tipo === 'objetiva' ? 'Objetiva' : 'Dissertativa'}</span>
        <span class="prova-ordem-texto">${esc(q.enunciadoHtml).slice(0, 100)}${q.enunciadoHtml.length > 100 ? '…' : ''}</span>
      </div>`;
  }).join('');

  let idArrastando = null;
  container.querySelectorAll('.prova-ordem-item').forEach(item => {
    item.addEventListener('dragstart', () => {
      idArrastando = item.dataset.id;
      item.classList.add('prova-ordem-item-arrastando');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('prova-ordem-item-arrastando');
    });
    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const idAlvo = item.dataset.id;
      if (!idArrastando || idArrastando === idAlvo) return;
      questoesManualOrdem = questoesManualOrdem.filter(id => id !== idArrastando);
      const posAlvo = questoesManualOrdem.indexOf(idAlvo);
      questoesManualOrdem.splice(posAlvo, 0, idArrastando);
      renderOrdemLista();
    });
  });
}

function abrirModalProva() {
  const nomeCursoAtivo = (meusCursos.find(c => c.id === cursoAtivo) || {}).name || cursoAtivo;
  document.getElementById('prova-curso-nome').textContent = nomeCursoAtivo;
  document.getElementById('prova-nome').value = '';
  popularSelectSemestreProva();
  document.getElementById('prova-periodo').value = '';
  document.getElementById('prova-simulado-bimestre').value = '';
  document.getElementById('prova-simulado-chamada').value = '';
  document.getElementById('prova-manual-bimestre').value = '';
  document.getElementById('prova-manual-chamada').value = '';
  document.getElementById('prova-manual-professor').value = '';
  document.getElementById('prova-preview').innerHTML = '';
  sorteioAtual = null;
  questoesManualSelecionadas = new Set();
  questoesManualOrdem = [];
  popularSelectPeriodoProva();
  popularCotasSimulado();
  popularSelectManualDisciplina();
  document.getElementById('prova-manual-lista').innerHTML = '';
  document.getElementById('prova-ordem-lista').innerHTML = '<p class="tabela-msg">Selecione questões acima pra definir a ordem.</p>';
  selecionarTipoProva('simulado');
  document.getElementById('modal-prova').classList.remove('hidden');
}

function fecharModalProva() {
  document.getElementById('modal-prova').classList.add('hidden');
}

async function salvarProva() {
  const nome = document.getElementById('prova-nome').value.trim();
  if (!nome) { showToast('Informe o nome da prova.', 'error'); return; }
  const semestre = document.getElementById('prova-semestre').value.trim();

  let payload;
  if (provaTipoAtivo === 'simulado') {
    if (!sorteioAtual) { showToast('Clique em "Montar prova com essas quantidades" antes de criar a prova.', 'error'); return; }
    const questoesIds = sorteioAtual.flatMap(g => g.questoes.map(q => q.id));
    if (!questoesIds.length) { showToast('Nenhuma questão foi selecionada — confira as quantidades.', 'error'); return; }
    payload = {
      curso: cursoAtivo, tipo: 'simulado', nome, semestre,
      bimestre: document.getElementById('prova-simulado-bimestre').value,
      chamada: document.getElementById('prova-simulado-chamada').value,
      questoesIds
    };
  } else {
    const disciplinaId = document.getElementById('prova-manual-disciplina').value;
    if (!disciplinaId) { showToast('Selecione a disciplina.', 'error'); return; }
    if (!questoesManualOrdem.length) { showToast('Selecione ao menos uma questão.', 'error'); return; }
    payload = {
      curso: cursoAtivo, tipo: provaTipoAtivo, nome, semestre,
      bimestre: document.getElementById('prova-manual-bimestre').value,
      chamada: document.getElementById('prova-manual-chamada').value,
      disciplinaId,
      professorNome: document.getElementById('prova-manual-professor').value.trim(),
      // Ordem escolhida arrastando (ver renderOrdemLista) — o gerador do
      // .docx respeita essa ordem dentro de cada bloco (objetivas,
      // dissertativas), não é o Set de seleção (que não preserva reordenação).
      questoesIds: [...questoesManualOrdem]
    };
  }

  try {
    await apiFetch('/banco-provas/provas', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Prova criada.');
    fecharModalProva();
    await carregarProvas();
    renderProvas();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================================================================
//  EVENTOS
// ================================================================
function bindEventos() {
  document.getElementById('bp-curso-select').addEventListener('change', async (e) => {
    cursoAtivo = e.target.value;
    await carregarTudoDoCurso();
  });

  // ":not(.prova-tipo-btn)" — os botões Simulado/Bimestral/Exame do modal
  // "Nova Prova" reaproveitam a MESMA classe visual (.bp-tab-btn), mas são
  // um controle à parte (ver selecionarTipoProva), não uma aba da página.
  document.querySelectorAll('.bp-tab-btn:not(.prova-tipo-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bp-tab-btn:not(.prova-tipo-btn)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('bp-view-disciplinas').classList.toggle('hidden', tab !== 'disciplinas');
      document.getElementById('bp-view-questoes').classList.toggle('hidden', tab !== 'questoes');
      document.getElementById('bp-view-revisao').classList.toggle('hidden', tab !== 'revisao');
      document.getElementById('bp-view-provas').classList.toggle('hidden', tab !== 'provas');
    });
  });

  document.getElementById('bp-btn-nova-disciplina').addEventListener('click', () => abrirModalDisciplina(null));
  document.getElementById('btn-cancelar-disciplina').addEventListener('click', fecharModalDisciplina);
  document.getElementById('form-disciplina').addEventListener('submit', salvarDisciplina);

  document.getElementById('bp-btn-nova-questao').addEventListener('click', () => abrirModalQuestao(null));
  document.getElementById('btn-cancelar-questao').addEventListener('click', fecharModalQuestao);
  document.getElementById('form-questao').addEventListener('submit', salvarQuestao);
  document.getElementById('questao-tipo').addEventListener('change', ajustarEditorPorTipo);
  document.getElementById('btn-add-alternativa').addEventListener('click', () => adicionarLinhaAlternativa());

  ['bp-filtro-periodo', 'bp-filtro-disciplina', 'bp-filtro-bimestre', 'bp-filtro-chamada', 'bp-filtro-tipo', 'bp-filtro-dificuldade'].forEach(id => {
    document.getElementById(id).addEventListener('change', async () => {
      await carregarQuestoes();
      renderQuestoes();
    });
  });
  document.getElementById('bp-filtro-semestre').addEventListener('change', async () => {
    await carregarQuestoes();
    renderQuestoes();
  });

  document.getElementById('bp-btn-importar-docx').addEventListener('click', abrirModalImportar);
  document.getElementById('btn-cancelar-importar').addEventListener('click', fecharModalImportar);
  document.getElementById('form-importar').addEventListener('submit', analisarImportacao);
  document.getElementById('btn-voltar-importar').addEventListener('click', voltarEtapaArquivo);
  document.getElementById('btn-descartar-importar').addEventListener('click', () => {
    if (confirm('Descartar o progresso salvo e começar uma nova importação do zero?')) {
      descartarImportacaoEComecarDeNovo();
    }
  });
  document.getElementById('btn-imprimir-gabarito-importar').addEventListener('click', imprimirGabaritoImportacao);
  document.getElementById('btn-confirmar-importar').addEventListener('click', confirmarImportacao);

  document.getElementById('bp-btn-nova-prova').addEventListener('click', abrirModalProva);
  document.getElementById('btn-cancelar-prova').addEventListener('click', fecharModalProva);
  document.getElementById('btn-fechar-preview-prova').addEventListener('click', fecharPreviewProva);
  document.getElementById('btn-baixar-preview-prova').addEventListener('click', () => {
    if (previewProvaIdAtual) baixarArquivoProva(previewProvaIdAtual, 'exportar-docx', '');
  });
  document.getElementById('btn-salvar-prova').addEventListener('click', salvarProva);
  document.getElementById('btn-sortear-prova').addEventListener('click', sortearProvaSimulado);
  document.getElementById('prova-periodo').addEventListener('change', () => {
    sorteioAtual = null;
    document.getElementById('prova-preview').innerHTML = '';
    document.getElementById('prova-manual-lista').innerHTML = '';
    document.getElementById('prova-ordem-lista').innerHTML = '<p class="tabela-msg">Selecione questões acima pra definir a ordem.</p>';
    questoesManualDisponiveis = [];
    questoesManualSelecionadas = new Set();
    questoesManualOrdem = [];
    popularCotasSimulado();
    popularSelectManualDisciplina();
  });
  document.getElementById('prova-manual-disciplina').addEventListener('change', carregarQuestoesManual);
  document.getElementById('prova-manual-bimestre').addEventListener('change', carregarQuestoesManual);
  document.getElementById('prova-manual-chamada').addEventListener('change', carregarQuestoesManual);
  document.getElementById('prova-semestre').addEventListener('change', carregarQuestoesManual);
  document.querySelectorAll('.prova-tipo-btn').forEach(btn => {
    btn.addEventListener('click', () => selecionarTipoProva(btn.dataset.provaTipo));
  });

  [document.getElementById('modal-disciplina'), document.getElementById('modal-questao'), document.getElementById('modal-importar'), document.getElementById('modal-prova'), document.getElementById('modal-preview-prova')].forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}
