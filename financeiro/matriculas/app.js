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

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2')) {
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
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, 'matriculas');
      } catch (e) {
        if (role === 'adm_l2') level = 3;
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

  setupLayout(user, role, 'matriculas', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  if (document.getElementById('virar-semestre-root')) {
    initPaginaVirarSemestre();
  } else if (document.getElementById('alunos-tbody')) {
    initPaginaLancamento();
  } else if (document.getElementById('matriculas-relatorio-root')) {
    initPaginaRelatorio();
  }
}

// Lista de semestres existentes (padrão + os já criados via "Virar Semestre")
// pros três seletores do módulo — busca uma vez por carregamento de página,
// nunca varre a coleção de alunos inteira só pra montar esse combo.
async function popularSelectSemestres(selectEl) {
  if (!selectEl) return;
  const valorAtual = selectEl.value;
  try {
    const { semestres } = await apiFetch('/matriculas/config/semestres');
    selectEl.innerHTML = semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    selectEl.value = semestres.includes(valorAtual) ? valorAtual : semestres[semestres.length - 1];
  } catch (err) {
    showToast('Erro ao carregar semestres: ' + err.message, 'error');
  }
}

// ==========================================
// TELA DE LANÇAMENTO (index.html)
// ==========================================
let cursosFatec = [];
let opcoes = { situacoes: [], planosConfissao: [] };
let moduloSelecionado = 'fatec';
let semestreSelecionado = '2026.2';
let cursoSelecionadoId = null;
let cursoSelecionadoNome = null;

let alunos = [];
let alunosNextCursor = null;
let alunosHasMore = false;
let alunosCarregandoTodas = false;
let alunoEmEdicaoId = null;

async function initPaginaLancamento() {
  await Promise.all([carregarOpcoes(), carregarCursosFatec()]);
  popularSelectsOpcoes();
  await popularSelectSemestres(document.getElementById('semestre-select'));
  semestreSelecionado = document.getElementById('semestre-select')?.value || semestreSelecionado;

  document.getElementById('modulo-select')?.addEventListener('change', (e) => {
    moduloSelecionado = e.target.value;
    cursoSelecionadoId = null;
    cursoSelecionadoNome = null;
    document.getElementById('curso-select').value = '';
    atualizarVisibilidadeCurso();
    atualizarBotaoNovoAluno();
    atualizarLabelImpressaoLista();
    if (podeCarregar()) carregarAlunos();
    else renderTabelaAlunos([]);
  });

  document.getElementById('semestre-select')?.addEventListener('change', (e) => {
    semestreSelecionado = e.target.value;
    atualizarBotaoNovoAluno();
    atualizarLabelImpressaoLista();
    if (podeCarregar()) carregarAlunos();
    else renderTabelaAlunos([]);
  });

  document.getElementById('curso-select')?.addEventListener('change', (e) => {
    cursoSelecionadoId = e.target.value || null;
    const curso = cursosFatec.find(c => c.id === cursoSelecionadoId);
    cursoSelecionadoNome = curso ? curso.name : null;
    atualizarBotaoNovoAluno();
    atualizarLabelImpressaoLista();
    if (podeCarregar()) carregarAlunos();
    else renderTabelaAlunos([]);
  });

  ['periodo-filtro', 'situacao-filtro', 'plano-filtro'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (podeCarregar()) carregarAlunos();
    });
  });

  document.getElementById('busca-aluno')?.addEventListener('input', async (e) => {
    const termo = e.target.value.trim().toLowerCase();
    if (termo && alunosHasMore) await carregarTodasPaginasRestantes();
    const filtrados = termo ? alunos.filter(a => a.nome.toLowerCase().includes(termo)) : alunos;
    renderTabelaAlunos(filtrados);
    atualizarBotaoCarregarMais();
  });

  document.getElementById('btn-carregar-mais')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-carregar-mais');
    btn.disabled = true;
    btn.textContent = 'Carregando...';
    try {
      await buscarProximaPaginaAlunos(false);
      renderTabelaAlunos(alunos);
    } catch (err) {
      showToast('Erro ao carregar mais alunos: ' + err.message, 'error');
    } finally {
      atualizarBotaoCarregarMais();
    }
  });

  document.getElementById('btn-imprimir-lista')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparando...';
    try {
      // Impressão precisa ver a lista inteira filtrada, não só a página já
      // carregada na tela — busca o restante antes de abrir o diálogo.
      if (alunosHasMore) await carregarTodasPaginasRestantes();
      renderTabelaAlunos(alunos);
    } catch (err) {
      showToast('Erro ao preparar impressão: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = textoOriginal;
    }
    window.print();
  });

  setupModalAluno();
  atualizarVisibilidadeCurso();
  atualizarBotaoNovoAluno();
  if (podeCarregar()) carregarAlunos();
}

// Curso é opcional pra LISTAR (dá pra ver "todos os cursos" e filtrar por
// período/situação através do módulo inteiro), mas é obrigatório pra CRIAR
// um aluno novo em Fatec (não existe aluno sem curso).
function podeCarregar() {
  return !!semestreSelecionado;
}
function podeCriarAluno() {
  return !!semestreSelecionado && (moduloSelecionado === 'medicina' || !!cursoSelecionadoId);
}

function atualizarVisibilidadeCurso() {
  const isFatec = moduloSelecionado === 'fatec';
  document.getElementById('curso-select')?.classList.toggle('hidden', !isFatec);
  document.getElementById('grupo-curso-aluno')?.classList.toggle('hidden', !isFatec);
}

function atualizarBotaoNovoAluno() {
  document.getElementById('btn-novo-aluno')?.toggleAttribute('disabled', !podeCriarAluno());
}

async function carregarOpcoes() {
  try {
    opcoes = await apiFetch('/matriculas/config/opcoes');
  } catch (err) {
    showToast('Erro ao carregar opções: ' + err.message, 'error');
  }
}

// Reaproveita a mesma proxy de `courses` já usada em Licitação — Medicina não
// entra na lista porque já é o outro módulo, selecionado à parte.
async function carregarCursosFatec() {
  try {
    const todos = await apiFetch('/financeiro/cursos');
    cursosFatec = todos.filter(c => (c.name || '').trim().toLowerCase() !== 'medicina');
  } catch (err) {
    showToast('Erro ao carregar cursos: ' + err.message, 'error');
  }
}

function popularSelectsOpcoes() {
  const selectCurso = document.getElementById('curso-select');
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }

  // Fatec vai até o 10º período (+ "DP" de dependência); Medicina até o 12º —
  // lista única cobrindo os dois, filtrar por um período que não existe no
  // módulo atual simplesmente não retorna ninguém.
  const periodoFiltro = document.getElementById('periodo-filtro');
  if (periodoFiltro) {
    const periodos = [...Array.from({ length: 12 }, (_, i) => `${i + 1}º`), 'DP'];
    periodoFiltro.innerHTML = '<option value="">Todos os períodos</option>' +
      periodos.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }

  const situacaoFiltro = document.getElementById('situacao-filtro');
  if (situacaoFiltro) {
    situacaoFiltro.innerHTML = '<option value="">Todas as situações</option>' +
      opcoes.situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }
  const planoFiltro = document.getElementById('plano-filtro');
  if (planoFiltro) {
    planoFiltro.innerHTML = '<option value="">Todos os planos/confissão</option>' +
      opcoes.planosConfissao.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }

  const selectSituacaoAluno = document.getElementById('aluno-situacao');
  if (selectSituacaoAluno) {
    selectSituacaoAluno.innerHTML = opcoes.situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }
  const selectPlanoAluno = document.getElementById('aluno-plano');
  if (selectPlanoAluno) {
    selectPlanoAluno.innerHTML = opcoes.planosConfissao.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
  const selectCursoAluno = document.getElementById('aluno-curso');
  if (selectCursoAluno) {
    selectCursoAluno.innerHTML = cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
}

// Grupo de badge por SITUAÇÃO — cor por significado (ok/alerta/crítica/neutra),
// não por valor individual, senão vira uma cor aleatória por texto.
const SITUACAO_GRUPO = {
  'Matrícula Nova - Assinada': 'ok', 'Rematrícula Assinada': 'ok', 'Formando': 'ok',
  'Matrícula Nova': 'alerta', 'Pendência Financeira': 'alerta', 'Não Assinou': 'alerta',
  'Cancelou': 'critica', 'Trancou': 'critica', '1ª Evasão': 'critica', '2ª Evasão': 'critica',
  'Desistente': 'critica', 'Reprovado': 'critica',
  'Transferência': 'neutra', 'Retorno': 'neutra', 'Mudança de Curso': 'neutra'
};
function situacaoBadgeClasse(situacao) {
  return `situacao-${SITUACAO_GRUPO[situacao] || 'neutra'}`;
}

async function buscarProximaPaginaAlunos(primeira) {
  const params = new URLSearchParams();
  params.set('modulo', moduloSelecionado);
  params.set('semestre', semestreSelecionado);
  if (cursoSelecionadoId) params.set('cursoId', cursoSelecionadoId);
  const periodo = document.getElementById('periodo-filtro')?.value;
  const situacao = document.getElementById('situacao-filtro')?.value;
  const plano = document.getElementById('plano-filtro')?.value;
  if (periodo) params.set('periodo', periodo);
  if (situacao) params.set('situacao', situacao);
  if (plano) params.set('planoConfissao', plano);
  if (!primeira && alunosNextCursor) {
    params.set('cursorNome', alunosNextCursor.nome);
    params.set('cursorId', alunosNextCursor.id);
  }
  const resp = await apiFetch(`/matriculas/alunos?${params.toString()}`);
  alunos = primeira ? resp.alunos : [...alunos, ...resp.alunos];
  alunosHasMore = resp.hasMore;
  alunosNextCursor = resp.nextCursor;
}

async function carregarTodasPaginasRestantes() {
  if (alunosCarregandoTodas) return;
  alunosCarregandoTodas = true;
  const btn = document.getElementById('btn-carregar-mais');
  if (btn) { btn.disabled = true; btn.textContent = 'Carregando tudo pra buscar...'; }
  try {
    while (alunosHasMore) {
      await buscarProximaPaginaAlunos(false);
    }
  } finally {
    alunosCarregandoTodas = false;
  }
}

function atualizarBotaoCarregarMais() {
  const wrap = document.getElementById('carregar-mais-wrap');
  const btn = document.getElementById('btn-carregar-mais');
  if (!wrap || !btn) return;
  const buscando = !!document.getElementById('busca-aluno')?.value.trim();
  wrap.classList.toggle('hidden', !alunosHasMore || buscando);
  btn.disabled = false;
  btn.textContent = 'Carregar mais';
}

async function carregarAlunos() {
  const tbody = document.getElementById('alunos-tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="tabela-msg">Carregando...</td></tr>`;
  alunos = [];
  alunosNextCursor = null;
  document.getElementById('busca-aluno').value = '';
  try {
    await buscarProximaPaginaAlunos(true);
    renderTabelaAlunos(alunos);
    atualizarBotaoCarregarMais();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

function renderTabelaAlunos(lista) {
  const tbody = document.getElementById('alunos-tbody');
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="tabela-msg">Nenhum aluno encontrado para os filtros atuais.</td></tr>';
    return;
  }
  tbody.innerHTML = lista.map(a => `
    <tr>
      <td>${esc(a.nome)}${a.revisarManualmente ? '<span class="revisar-badge" title="Migrado da planilha com situação/plano fora do padrão — confira e edite.">⚠ revisar</span>' : ''}</td>
      <td>${esc(a.curso)}</td>
      <td>${esc(a.periodo)}</td>
      <td>${esc(a.cidade)}</td>
      <td><span class="status-badge ${situacaoBadgeClasse(a.situacao)}">${esc(a.situacao)}</span></td>
      <td>${esc(a.planoConfissao)}</td>
      <td>${esc(a.telefone)}</td>
      <td class="acoes-col">
        <button type="button" class="btn-icon" data-editar="${a.id}" title="Editar">✏️</button>
        <button type="button" class="btn-icon" data-excluir="${a.id}" data-nome="${esc(a.nome)}" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-editar]').forEach(btn => btn.addEventListener('click', () => {
    const aluno = alunos.find(a => a.id === btn.dataset.editar);
    if (aluno) abrirModalAluno(aluno);
  }));
  tbody.querySelectorAll('[data-excluir]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Excluir o registro de "${btn.dataset.nome}"?`)) return;
    try {
      await apiFetch(`/matriculas/alunos/${btn.dataset.excluir}`, { method: 'DELETE' });
      showToast('Aluno excluído');
      await carregarAlunos();
    } catch (err) {
      showToast('Erro ao excluir: ' + err.message, 'error');
    }
  }));
}

function setupModalAluno() {
  const modal = document.getElementById('modal-aluno');
  if (!modal) return;

  document.getElementById('btn-novo-aluno')?.addEventListener('click', () => abrirModalAluno(null));
  document.getElementById('btn-cancelar-aluno')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('form-aluno')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-salvar-aluno');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      const cursoSel = document.getElementById('aluno-curso');
      const cursoNome = cursoSel?.selectedOptions?.[0]?.textContent || cursoSelecionadoNome;
      const payload = {
        nome: document.getElementById('aluno-nome').value,
        periodo: document.getElementById('aluno-periodo').value,
        cidade: document.getElementById('aluno-cidade').value,
        telefone: document.getElementById('aluno-telefone').value,
        situacao: document.getElementById('aluno-situacao').value,
        planoConfissao: document.getElementById('aluno-plano').value,
        observacoes: document.getElementById('aluno-observacoes').value
      };
      if (moduloSelecionado === 'fatec') {
        payload.cursoId = cursoSel.value;
        payload.curso = cursoNome;
      }

      if (alunoEmEdicaoId) {
        await apiFetch(`/matriculas/alunos/${alunoEmEdicaoId}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Aluno atualizado');
      } else {
        payload.modulo = moduloSelecionado;
        payload.semestre = semestreSelecionado;
        await apiFetch('/matriculas/alunos', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Aluno cadastrado');
      }
      modal.classList.add('hidden');
      await carregarAlunos();
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

function abrirModalAluno(aluno) {
  alunoEmEdicaoId = aluno ? aluno.id : null;
  document.getElementById('modal-aluno-title').textContent = aluno ? 'Editar Aluno' : 'Novo Aluno';
  document.getElementById('aluno-id').value = aluno?.id || '';
  document.getElementById('aluno-nome').value = aluno?.nome || '';
  document.getElementById('aluno-periodo').value = aluno?.periodo || '';
  document.getElementById('aluno-cidade').value = aluno?.cidade || '';
  document.getElementById('aluno-telefone').value = aluno?.telefone || '';
  document.getElementById('aluno-situacao').value = aluno?.situacao || opcoes.situacoes[0] || '';
  document.getElementById('aluno-plano').value = aluno?.planoConfissao || 'Não';
  document.getElementById('aluno-observacoes').value = aluno?.observacoes || '';

  const grupoCurso = document.getElementById('grupo-curso-aluno');
  const isFatec = (aluno ? aluno.modulo : moduloSelecionado) === 'fatec';
  grupoCurso?.classList.toggle('hidden', !isFatec);
  const selectCursoAluno = document.getElementById('aluno-curso');
  if (selectCursoAluno) selectCursoAluno.value = aluno?.cursoId || cursoSelecionadoId || '';

  document.getElementById('modal-aluno').classList.remove('hidden');
}

// ==========================================
// TELA DE RELATÓRIO (relatorio.html)
// ==========================================
let relatorioEmAndamento = Promise.resolve(); // promessa da última carga, pra "Imprimir" nunca pegar dado desatualizado

async function initPaginaRelatorio() {
  const selectModulo = document.getElementById('rel-modulo-select');
  const selectSemestre = document.getElementById('rel-semestre-select');
  const selectCurso = document.getElementById('rel-curso-select');

  await carregarCursosFatec();
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  await popularSelectSemestres(selectSemestre);
  atualizarVisibilidadeCursoRelatorio();

  selectModulo?.addEventListener('change', () => {
    if (selectCurso) selectCurso.value = '';
    atualizarVisibilidadeCursoRelatorio();
    atualizarLabelImpressaoRelatorio();
    relatorioEmAndamento = carregarRelatorio();
  });
  selectSemestre?.addEventListener('change', () => {
    atualizarLabelImpressaoRelatorio();
    relatorioEmAndamento = carregarRelatorio();
  });
  selectCurso?.addEventListener('change', () => {
    atualizarLabelImpressaoRelatorio();
    relatorioEmAndamento = carregarRelatorio();
  });

  atualizarLabelImpressaoRelatorio();
  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  document.getElementById('btn-imprimir-relatorio')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparando...';
    try {
      // Espera a busca em andamento (troca de módulo/semestre, por ex.)
      // terminar antes de imprimir — senão a impressão podia sair com os
      // dados da seleção anterior.
      await relatorioEmAndamento;
    } finally {
      btn.disabled = false;
      btn.innerHTML = textoOriginal;
    }
    window.print();
  });

  relatorioEmAndamento = carregarRelatorio();
  await relatorioEmAndamento;
}

function atualizarVisibilidadeCursoRelatorio() {
  const isFatec = document.getElementById('rel-modulo-select')?.value !== 'medicina';
  document.getElementById('rel-curso-select')?.classList.toggle('hidden', !isFatec);
}

function atualizarLabelImpressaoRelatorio() {
  const label = document.getElementById('print-filtro-label');
  if (!label) return;
  const moduloValor = document.getElementById('rel-modulo-select')?.value;
  const modulo = moduloValor === 'medicina' ? 'Medicina' : 'Fatec';
  const semestre = document.getElementById('rel-semestre-select')?.value || '';
  const partes = [modulo];
  if (moduloValor !== 'medicina') {
    const cursoSelect = document.getElementById('rel-curso-select');
    const cursoNome = cursoSelect?.value ? cursoSelect.selectedOptions[0]?.textContent : 'Todos os cursos';
    partes.push(cursoNome);
  }
  partes.push(semestre);
  label.textContent = partes.filter(Boolean).join(' — ');
}

async function carregarRelatorio() {
  const modulo = document.getElementById('rel-modulo-select')?.value || 'fatec';
  const semestre = document.getElementById('rel-semestre-select')?.value || '2026.2';
  const cursoId = document.getElementById('rel-curso-select')?.value;
  try {
    const params = new URLSearchParams({ modulo, semestre });
    if (cursoId) params.set('cursoId', cursoId);
    const dados = await apiFetch(`/matriculas/relatorio?${params.toString()}`);
    renderRelatorio(dados);
  } catch (err) {
    showToast('Erro ao carregar relatório: ' + err.message, 'error');
  }
}

// Soma um grupo de situações pro KPI (ex.: "Cancelou / Trancou" junta 2
// situações distintas numa única leitura rápida) — sem exigir que o back
// mande o combinado já pronto.
function somaSituacoes(porSituacaoTotal, ...nomes) {
  return nomes.reduce((soma, n) => soma + (porSituacaoTotal[n] || 0), 0);
}

function renderRelatorio(dados) {
  const { total, pendentesRevisao, cursos, porCursoSituacao, porSituacaoTotal, porPlano, situacoes, planosConfissao } = dados;

  // Definições do jeito que a coordenação/financeiro já usa (mesmo conceito
  // da planilha antiga): Veterano = rematrícula; Calouro = matrícula nova do
  // semestre; Ativos = quem ainda está no jogo (assinou, tá pendente, não
  // assinou ainda ou é matrícula nova) — 1ª Evasão e Cancelou são coisas
  // diferentes (saiu antes x depois das aulas começarem/1ª mensalidade).
  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-veteranos').textContent = porSituacaoTotal['Rematrícula Assinada'] || 0;
  document.getElementById('kpi-calouros').textContent = somaSituacoes(porSituacaoTotal, 'Matrícula Nova', 'Matrícula Nova - Assinada');
  document.getElementById('kpi-ativos').textContent = somaSituacoes(porSituacaoTotal, 'Rematrícula Assinada', 'Pendência Financeira', 'Não Assinou', 'Matrícula Nova', 'Matrícula Nova - Assinada');
  document.getElementById('kpi-pendencia').textContent = porSituacaoTotal['Pendência Financeira'] || 0;
  document.getElementById('kpi-nao-assinou').textContent = porSituacaoTotal['Não Assinou'] || 0;
  document.getElementById('kpi-1-evasao').textContent = porSituacaoTotal['1ª Evasão'] || 0;
  document.getElementById('kpi-cancelou').textContent = porSituacaoTotal['Cancelou'] || 0;
  document.getElementById('kpi-trancou').textContent = porSituacaoTotal['Trancou'] || 0;

  const card2Evasao = document.getElementById('kpi-2-evasao-card');
  if ((porSituacaoTotal['2ª Evasão'] || 0) > 0) {
    card2Evasao.classList.remove('hidden');
    document.getElementById('kpi-2-evasao').textContent = porSituacaoTotal['2ª Evasão'];
  } else {
    card2Evasao.classList.add('hidden');
  }

  // "Perda" = todo mundo que saiu de qualquer jeito (cancelou, trancou,
  // evadiu). Captação = calouros (matrícula nova) do semestre — a métrica
  // olha "de cada 100 que a gente captou, quantos a gente perdeu".
  const totalCalouros = somaSituacoes(porSituacaoTotal, 'Matrícula Nova', 'Matrícula Nova - Assinada');
  const totalPerdas = somaSituacoes(porSituacaoTotal, 'Cancelou', 'Trancou', '1ª Evasão', '2ª Evasão');
  const formatarPercentual = (numerador, denominador) =>
    denominador > 0 ? `${((numerador / denominador) * 100).toFixed(1)}%` : '—';
  document.getElementById('kpi-perda-captacao').textContent = formatarPercentual(totalPerdas, totalCalouros);
  document.getElementById('kpi-perda-total').textContent = formatarPercentual(totalPerdas, total);

  const cardRevisar = document.getElementById('kpi-revisar-card');
  if (pendentesRevisao > 0) {
    cardRevisar.classList.remove('hidden');
    document.getElementById('kpi-revisar').textContent = pendentesRevisao;
  } else {
    cardRevisar.classList.add('hidden');
  }

  // Pivô Situação x Curso — só lista situação que tem pelo menos 1 aluno em
  // algum curso, senão a tabela fica enorme com linha zerada de ponta a ponta.
  const thead = document.getElementById('situacao-curso-thead');
  const tbody = document.getElementById('situacao-curso-tbody');
  if (!cursos.length) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="tabela-msg">Nenhum aluno lançado para esse módulo/semestre ainda.</td></tr>';
  } else {
    thead.innerHTML = `<tr><th>Situação</th>${cursos.map(c => `<th>${esc(c)}</th>`).join('')}<th>Total</th></tr>`;
    tbody.innerHTML = situacoes
      .filter(sit => (porSituacaoTotal[sit] || 0) > 0)
      .map(sit => {
        const linhaTotal = porSituacaoTotal[sit] || 0;
        return `<tr>
          <td><span class="status-badge ${situacaoBadgeClasse(sit)}">${esc(sit)}</span></td>
          ${cursos.map(c => `<td>${(porCursoSituacao[c] && porCursoSituacao[c][sit]) || 0}</td>`).join('')}
          <td><strong>${linhaTotal}</strong></td>
        </tr>`;
      }).join('') || '<tr><td class="tabela-msg">Nenhum aluno lançado para esse módulo/semestre ainda.</td></tr>';
  }

  const planoTbody = document.getElementById('plano-tbody');
  planoTbody.innerHTML = planosConfissao
    .filter(p => (porPlano[p] || 0) > 0)
    .map(p => `<tr><td>${esc(p)}</td><td>${porPlano[p] || 0}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="tabela-msg">Nenhum aluno lançado para esse módulo/semestre ainda.</td></tr>';
}

// ==========================================
// TELA VIRAR SEMESTRE (virar-semestre.html)
// ==========================================
// Quem vai pro próximo semestre é escolha manual, linha a linha — não existe
// regra automática por situação aqui. O período (+1) e a situação nova
// ("Não Assinou") são só sugestão editável antes de confirmar.
let vsAlunos = [];

function vsAvancarPeriodo(periodoOriginal) {
  const m = (periodoOriginal || '').trim().match(/^(\d+)º$/);
  if (!m) return periodoOriginal || '';
  return `${parseInt(m[1], 10) + 1}º`;
}

async function initPaginaVirarSemestre() {
  await Promise.all([carregarOpcoes(), carregarCursosFatec()]);

  const selectCurso = document.getElementById('vs-curso-filtro');
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  }
  const periodoFiltro = document.getElementById('vs-periodo-filtro');
  if (periodoFiltro) {
    const periodos = [...Array.from({ length: 12 }, (_, i) => `${i + 1}º`), 'DP'];
    periodoFiltro.innerHTML = '<option value="">Todos os períodos</option>' +
      periodos.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
  const situacaoFiltro = document.getElementById('vs-situacao-filtro');
  if (situacaoFiltro) {
    situacaoFiltro.innerHTML = '<option value="">Todas as situações</option>' +
      opcoes.situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }

  await popularSelectSemestres(document.getElementById('vs-origem-select'));
  vsAtualizarVisibilidadeCurso();

  document.getElementById('vs-modulo-select')?.addEventListener('change', () => {
    vsAtualizarVisibilidadeCurso();
    vsResetarCarregamento();
  });
  document.getElementById('vs-origem-select')?.addEventListener('change', vsResetarCarregamento);

  document.getElementById('btn-vs-carregar')?.addEventListener('click', vsCarregarAlunos);

  ['vs-curso-filtro', 'vs-periodo-filtro', 'vs-situacao-filtro'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', vsRenderTabela);
  });
  document.getElementById('vs-busca')?.addEventListener('input', vsRenderTabela);

  document.getElementById('btn-vs-marcar-filtrados')?.addEventListener('click', () => vsMarcarFiltrados(true));
  document.getElementById('btn-vs-desmarcar-filtrados')?.addEventListener('click', () => vsMarcarFiltrados(false));
  document.getElementById('vs-check-todos-cabecalho')?.addEventListener('change', (e) => vsMarcarFiltrados(e.target.checked));
  document.getElementById('btn-vs-limpar-selecao')?.addEventListener('click', () => {
    vsAlunos.forEach(a => { a._selecionado = false; });
    vsRenderTabela();
  });

  document.getElementById('vs-destino-input')?.addEventListener('input', vsAtualizarContadorEBotao);
  document.getElementById('btn-vs-confirmar')?.addEventListener('click', vsConfirmar);
}

function vsAtualizarVisibilidadeCurso() {
  const isFatec = document.getElementById('vs-modulo-select')?.value !== 'medicina';
  document.getElementById('vs-curso-filtro')?.classList.toggle('hidden', !isFatec);
}

function vsResetarCarregamento() {
  vsAlunos = [];
  document.getElementById('vs-area-selecao')?.classList.add('hidden');
  document.getElementById('vs-barra-confirmar')?.classList.add('hidden');
}

async function vsCarregarAlunos() {
  const modulo = document.getElementById('vs-modulo-select')?.value;
  const semestre = document.getElementById('vs-origem-select')?.value;
  if (!modulo || !semestre) return;

  const btn = document.getElementById('btn-vs-carregar');
  btn.disabled = true;
  btn.textContent = 'Carregando...';
  try {
    const carregados = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams({ modulo, semestre, pageSize: '200' });
      if (cursor) { params.set('cursorNome', cursor.nome); params.set('cursorId', cursor.id); }
      const resp = await apiFetch(`/matriculas/alunos?${params.toString()}`);
      carregados.push(...resp.alunos);
      hasMore = resp.hasMore;
      cursor = resp.nextCursor;
    }
    vsAlunos = carregados.map(a => ({
      ...a,
      _selecionado: false,
      _periodoNovo: vsAvancarPeriodo(a.periodo),
      _situacaoNova: 'Não Assinou'
    }));
    document.getElementById('vs-area-selecao')?.classList.remove('hidden');
    document.getElementById('vs-barra-confirmar')?.classList.remove('hidden');
    document.getElementById('vs-busca').value = '';
    vsRenderTabela();
  } catch (err) {
    showToast('Erro ao carregar alunos: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Carregar alunos';
  }
}

function vsAlunosFiltrados() {
  const curso = document.getElementById('vs-curso-filtro')?.value;
  const periodo = document.getElementById('vs-periodo-filtro')?.value;
  const situacao = document.getElementById('vs-situacao-filtro')?.value;
  const termo = document.getElementById('vs-busca')?.value.trim().toLowerCase();
  return vsAlunos.filter(a =>
    (!curso || a.curso === curso) &&
    (!periodo || a.periodo === periodo) &&
    (!situacao || a.situacao === situacao) &&
    (!termo || a.nome.toLowerCase().includes(termo))
  );
}

function vsSituacaoOptionsHtml(selecionada) {
  return opcoes.situacoes.map(s => `<option value="${esc(s)}" ${s === selecionada ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

function vsRenderTabela() {
  const tbody = document.getElementById('vs-tbody');
  const filtrados = vsAlunosFiltrados();

  if (!vsAlunos.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Escolha módulo e semestre de origem e clique em "Carregar alunos".</td></tr>';
  } else if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Nenhum aluno encontrado para os filtros atuais.</td></tr>';
  } else {
    tbody.innerHTML = filtrados.map(a => `
      <tr>
        <td><input type="checkbox" data-vs-check="${a.id}" ${a._selecionado ? 'checked' : ''}></td>
        <td>${esc(a.nome)}</td>
        <td>${esc(a.curso)}</td>
        <td>${esc(a.periodo)}</td>
        <td><input type="text" data-vs-periodo="${a.id}" value="${esc(a._periodoNovo)}" style="width: 4.5rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;"></td>
        <td><span class="status-badge ${situacaoBadgeClasse(a.situacao)}">${esc(a.situacao)}</span></td>
        <td><select data-vs-situacao="${a.id}" style="padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;">${vsSituacaoOptionsHtml(a._situacaoNova)}</select></td>
      </tr>`).join('');
  }

  tbody.querySelectorAll('[data-vs-check]').forEach(el => el.addEventListener('change', (e) => {
    const aluno = vsAlunos.find(a => a.id === el.dataset.vsCheck);
    if (aluno) aluno._selecionado = e.target.checked;
    vsAtualizarContadorEBotao();
  }));
  tbody.querySelectorAll('[data-vs-periodo]').forEach(el => el.addEventListener('input', (e) => {
    const aluno = vsAlunos.find(a => a.id === el.dataset.vsPeriodo);
    if (aluno) aluno._periodoNovo = e.target.value;
  }));
  tbody.querySelectorAll('[data-vs-situacao]').forEach(el => el.addEventListener('change', (e) => {
    const aluno = vsAlunos.find(a => a.id === el.dataset.vsSituacao);
    if (aluno) aluno._situacaoNova = e.target.value;
  }));

  vsAtualizarContadorEBotao();
}

function vsMarcarFiltrados(valor) {
  vsAlunosFiltrados().forEach(a => { a._selecionado = valor; });
  vsRenderTabela();
}

function vsAtualizarContadorEBotao() {
  const selecionados = vsAlunos.filter(a => a._selecionado).length;
  document.getElementById('vs-contador-selecionados').textContent = `${selecionados} aluno${selecionados === 1 ? '' : 's'} selecionado${selecionados === 1 ? '' : 's'}`;

  const destino = document.getElementById('vs-destino-input')?.value.trim();
  const origem = document.getElementById('vs-origem-select')?.value;
  const destinoValido = /^\d{4}\.\d$/.test(destino || '') && destino !== origem;
  document.getElementById('btn-vs-confirmar').disabled = !(selecionados > 0 && destinoValido);
}

async function vsConfirmar() {
  const semestreOrigem = document.getElementById('vs-origem-select')?.value;
  const semestreDestino = document.getElementById('vs-destino-input')?.value.trim();
  const selecionados = vsAlunos.filter(a => a._selecionado);
  if (!selecionados.length) return;

  if (!confirm(`Copiar ${selecionados.length} aluno(s) de ${semestreOrigem} para ${semestreDestino}?\n\nOs registros de ${semestreOrigem} não serão alterados nem apagados.`)) return;

  const btn = document.getElementById('btn-vs-confirmar');
  btn.disabled = true;
  btn.textContent = 'Gravando...';
  try {
    const overrides = {};
    selecionados.forEach(a => { overrides[a.id] = { periodo: a._periodoNovo, situacao: a._situacaoNova }; });

    const resp = await apiFetch('/matriculas/virar-semestre', {
      method: 'POST',
      body: JSON.stringify({
        semestreOrigem,
        semestreDestino,
        alunoIds: selecionados.map(a => a.id),
        overrides
      })
    });

    showToast(`${resp.copiados} aluno(s) copiado(s) para ${semestreDestino}.`);
    if (resp.avisosPeriodo?.length) {
      showToast(`${resp.avisosPeriodo.length} aluno(s) com período fora do padrão "Nº" — confira manualmente.`, 'error');
    }

    vsResetarCarregamento();
    document.getElementById('vs-destino-input').value = '';
    await popularSelectSemestres(document.getElementById('vs-origem-select'));
  } catch (err) {
    showToast('Erro ao virar semestre: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar virada de semestre';
    vsAtualizarContadorEBotao();
  }
}
