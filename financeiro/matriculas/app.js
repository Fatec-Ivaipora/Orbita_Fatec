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

  if (document.getElementById('alunos-tbody')) {
    initPaginaLancamento();
  } else if (document.getElementById('matriculas-relatorio-root')) {
    initPaginaRelatorio();
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

  document.getElementById('modulo-select')?.addEventListener('change', (e) => {
    moduloSelecionado = e.target.value;
    cursoSelecionadoId = null;
    cursoSelecionadoNome = null;
    document.getElementById('curso-select').value = '';
    atualizarVisibilidadeCurso();
    atualizarBotaoNovoAluno();
    renderTabelaAlunos([]);
  });

  document.getElementById('semestre-select')?.addEventListener('change', (e) => {
    semestreSelecionado = e.target.value;
    atualizarBotaoNovoAluno();
    if (podeCarregar()) carregarAlunos();
    else renderTabelaAlunos([]);
  });

  document.getElementById('curso-select')?.addEventListener('change', (e) => {
    cursoSelecionadoId = e.target.value || null;
    const curso = cursosFatec.find(c => c.id === cursoSelecionadoId);
    cursoSelecionadoNome = curso ? curso.name : null;
    atualizarBotaoNovoAluno();
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

  setupModalAluno();
  atualizarVisibilidadeCurso();
  atualizarBotaoNovoAluno();
}

function podeCarregar() {
  return !!semestreSelecionado && (moduloSelecionado === 'medicina' || !!cursoSelecionadoId);
}

function atualizarVisibilidadeCurso() {
  const isFatec = moduloSelecionado === 'fatec';
  document.getElementById('curso-select')?.classList.toggle('hidden', !isFatec);
  document.getElementById('grupo-curso-aluno')?.classList.toggle('hidden', !isFatec);
}

function atualizarBotaoNovoAluno() {
  document.getElementById('btn-novo-aluno')?.toggleAttribute('disabled', !podeCarregar());
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
    selectCurso.innerHTML = '<option value="">Selecione um curso...</option>' +
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
  if (moduloSelecionado === 'fatec') params.set('cursoId', cursoSelecionadoId);
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
async function initPaginaRelatorio() {
  const selectModulo = document.getElementById('rel-modulo-select');
  const selectSemestre = document.getElementById('rel-semestre-select');

  selectModulo?.addEventListener('change', () => carregarRelatorio());
  selectSemestre?.addEventListener('change', () => carregarRelatorio());

  await carregarRelatorio();
}

async function carregarRelatorio() {
  const modulo = document.getElementById('rel-modulo-select')?.value || 'fatec';
  const semestre = document.getElementById('rel-semestre-select')?.value || '2026.2';
  try {
    const dados = await apiFetch(`/matriculas/relatorio?modulo=${encodeURIComponent(modulo)}&semestre=${encodeURIComponent(semestre)}`);
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

  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-rematricula').textContent = porSituacaoTotal['Rematrícula Assinada'] || 0;
  document.getElementById('kpi-pendencia').textContent = porSituacaoTotal['Pendência Financeira'] || 0;
  document.getElementById('kpi-nao-assinou').textContent = porSituacaoTotal['Não Assinou'] || 0;
  document.getElementById('kpi-cancelou-trancou').textContent = somaSituacoes(porSituacaoTotal, 'Cancelou', 'Trancou');
  document.getElementById('kpi-evasao').textContent = somaSituacoes(porSituacaoTotal, '1ª Evasão', '2ª Evasão');

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
