import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';
import { escapeHTML as esc } from '../core/security.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;
let currentRole = 'visitante';
let meuCursoId = null;

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

let avaliacoes = [];
let avaliacoesTodas = [];
let cursos = [];

// As 10 perguntas fixas do questionário (mesmo texto/ordem do backend). As
// perguntas 11 e 12 são abertas e ficam direto no HTML (questionario-positivo /
// questionario-melhoria).
const PERGUNTAS = [
  'O professor demonstra domínio do conteúdo e transmite segurança ao desenvolver os temas da disciplina?',
  'O professor explica os conteúdos de forma clara, utilizando exemplos e estratégias que facilitam a compreensão e a aprendizagem?',
  'O professor relaciona os conteúdos da disciplina com situações práticas da profissão, do mercado de trabalho e da realidade regional?',
  'As aulas são planejadas, organizadas e aproveitam adequadamente o tempo destinado à aprendizagem?',
  'O professor utiliza metodologias, recursos tecnológicos e diferentes estratégias que tornam as aulas mais dinâmicas e estimulam o interesse dos alunos?',
  'O professor estimula a participação, o pensamento crítico, os questionamentos e o protagonismo dos alunos durante as aulas?',
  'O professor demonstra respeito, ética, disponibilidade e boa relação com os alunos, considerando diferentes níveis de conhecimento e ritmos de aprendizagem?',
  'As atividades, avaliações e orientações realizadas pelo professor contribuem para o desenvolvimento das competências necessárias à formação profissional?',
  'O professor demonstra abertura para ouvir os alunos, receber sugestões e aperfeiçoar sua forma de ensinar?',
  'De modo geral, o trabalho deste professor contribui efetivamente para sua aprendizagem e formação profissional?'
];

const ESCALA = [
  { value: '1', label: '1 – Discordo totalmente' },
  { value: '2', label: '2 – Discordo' },
  { value: '3', label: '3 – Nem concordo, nem discordo' },
  { value: '4', label: '4 – Concordo' },
  { value: '5', label: '5 – Concordo totalmente' },
  { value: 'na', label: 'N/A – Não tenho elementos para avaliar' }
];

// Perguntas 1-3 -> etapa 2, 4-6 -> etapa 3, 7-9 -> etapa 4, 10 -> etapa 5
// (junto com as perguntas abertas 11/12). Etapa 1 é só "Quantidade de Alunos".
function etapaDaPergunta(n) {
  return Math.ceil(n / 3) + 1;
}
const TOTAL_ETAPAS_QUESTIONARIO = 5;

function renderPerguntas() {
  const container = document.getElementById('perguntas-container');
  container.innerHTML = PERGUNTAS.map((texto, idx) => {
    const n = idx + 1;
    return `
      <div class="pergunta-item" data-step="${etapaDaPergunta(n)}">
        <div class="pergunta-texto">${n}. ${esc(texto)}</div>
        <div class="escala-opcoes">
          ${ESCALA.map((op, opIdx) => `
            <label class="escala-opcao">
              <input type="radio" name="pergunta-${n}" value="${op.value}" ${opIdx === 0 ? 'required' : ''}>
              <span>${esc(op.label)}</span>
            </label>
          `).join('')}
        </div>
        <textarea class="pergunta-obs" id="obs-pergunta-${n}" rows="2" placeholder="Observação sobre esta pergunta (opcional)"></textarea>
      </div>
    `;
  }).join('');
}

// ==========================================
// NOMES DOS ALUNOS (etapa 1) — um input por aluno, gerado a partir da
// quantidade informada. Preserva o que já foi digitado ao aumentar/diminuir.
// ==========================================
const LIMITE_ALUNOS = 100;

function renderAlunosNomes(quantidade) {
  const container = document.getElementById('alunos-nomes-container');
  const nomesAtuais = coletarAlunosNomes();
  const qtd = Math.min(Math.max(parseInt(quantidade, 10) || 0, 0), LIMITE_ALUNOS);

  container.innerHTML = Array.from({ length: qtd }, (_, i) => `
    <div class="form-group">
      <label>Aluno ${i + 1}</label>
      <input type="text" class="aluno-nome" data-idx="${i}" placeholder="Nome do aluno" value="${esc(nomesAtuais[i] || '')}">
    </div>
  `).join('');
}

function coletarAlunosNomes() {
  return Array.from(document.querySelectorAll('#alunos-nomes-container .aluno-nome')).map(el => el.value.trim());
}

function preencherAlunosNomes(nomes) {
  renderAlunosNomes((nomes || []).length);
  document.querySelectorAll('#alunos-nomes-container .aluno-nome').forEach((el, i) => {
    el.value = (nomes && nomes[i]) || '';
  });
}

document.getElementById('questionario-alunos').addEventListener('input', (e) => {
  renderAlunosNomes(e.target.value);
});

// ==========================================
// NAVEGAÇÃO EM ETAPAS DO QUESTIONÁRIO
// ==========================================
let etapaAtualQuestionario = 1;

function mostrarEtapaQuestionario(n) {
  etapaAtualQuestionario = n;
  document.querySelectorAll('#form-questionario [data-step]').forEach(el => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== n);
  });

  document.getElementById('questionario-step-label').textContent = `Etapa ${n} de ${TOTAL_ETAPAS_QUESTIONARIO}`;
  document.getElementById('questionario-progress-fill').style.width = `${(n / TOTAL_ETAPAS_QUESTIONARIO) * 100}%`;

  const ehUltima = n === TOTAL_ETAPAS_QUESTIONARIO;
  document.getElementById('btn-questionario-voltar').classList.toggle('hidden', n === 1);
  document.getElementById('btn-questionario-proxima').classList.toggle('hidden', ehUltima);

  const btnSalvar = document.getElementById('btn-questionario-salvar');
  btnSalvar.classList.toggle('hidden', !ehUltima);
  btnSalvar.disabled = !ehUltima;

  // Cada etapa começa do topo do modal, não de onde a rolagem parou na anterior.
  document.querySelector('#modal-questionario .modal-content')?.scrollTo(0, 0);
}

// Garante que a etapa atual está completa antes de deixar avançar.
function validarEtapaAtualQuestionario() {
  const wrappers = document.querySelectorAll(`#form-questionario [data-step="${etapaAtualQuestionario}"]`);
  for (const el of wrappers) {
    if (el.classList.contains('pergunta-item')) {
      const nomeGrupo = el.querySelector('input[type="radio"]')?.name;
      if (nomeGrupo && !el.querySelector(`input[name="${nomeGrupo}"]:checked`)) {
        alert('Selecione uma resposta para continuar.');
        return false;
      }
    } else {
      for (const campo of el.querySelectorAll('input[required], textarea[required]')) {
        if (!campo.checkValidity()) {
          campo.reportValidity();
          return false;
        }
      }
    }
  }
  return true;
}

window.proximaEtapa = function () {
  if (!validarEtapaAtualQuestionario()) return;
  if (etapaAtualQuestionario < TOTAL_ETAPAS_QUESTIONARIO) mostrarEtapaQuestionario(etapaAtualQuestionario + 1);
}

window.etapaAnterior = function () {
  if (etapaAtualQuestionario > 1) mostrarEtapaQuestionario(etapaAtualQuestionario - 1);
}

function coletarRespostas() {
  const respostas = {};
  for (let n = 1; n <= PERGUNTAS.length; n++) {
    const checked = document.querySelector(`input[name="pergunta-${n}"]:checked`);
    const obs = document.getElementById(`obs-pergunta-${n}`)?.value || '';
    respostas[`p${n}`] = { valor: checked ? checked.value : null, obs };
  }
  return respostas;
}

function preencherRespostas(respostas) {
  respostas = respostas || {};
  for (let n = 1; n <= PERGUNTAS.length; n++) {
    const resposta = respostas[`p${n}`];
    const val = resposta && typeof resposta === 'object' ? resposta.valor : resposta;
    const obs = resposta && typeof resposta === 'object' ? resposta.obs : '';
    const radio = val && document.querySelector(`input[name="pergunta-${n}"][value="${val}"]`);
    if (radio) radio.checked = true;
    const obsField = document.getElementById(`obs-pergunta-${n}`);
    if (obsField) obsField.value = obs || '';
  }
}

function popularSelectSemestre(select, comTodos) {
  const opcoes = Array.from({ length: 10 }, (_, i) => String(i + 1));
  select.innerHTML = (comTodos ? '<option value="">Todos os Semestres</option>' : '<option value="">Selecione o semestre</option>') +
    opcoes.map(n => `<option value="${n}">${n}º Semestre</option>`).join('');
}

let appInitialized = false;
let initializedRole = null;

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
    window.location.href = '../auth/login.html';
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
      meuCursoId = userData.curso || null;
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }

    setCachedAuth(user, role, token);

    // Nível EFETIVO: override individual do usuário vence o do cargo
    let userLevel = 3;
    if (role !== 'adm_l1') {
      try {
        const perms = await apiFetch('/usuarios/config/permissions');
        userLevel = getEffectiveLevel(perms[role] || {}, meuOverrides, 'avaliacao-docente');
      } catch (e) {
        userLevel = role === 'adm_l2' ? 3 : (role === 'coordenador' ? 3 : 1);
      }
      if (userLevel < 2) {
        window.location.href = '../meu-espaco/index.html';
        return;
      }
      document.body.classList.toggle('hide-execute', userLevel < 3);
    }

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
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
  currentRole = role;

  // Inicializa a navegação
  setupLayout(user, role, 'avaliacao-docente', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  // Mostra a tela
  document.getElementById('app-root').classList.remove('hidden');

  // Coordenador só vê e cria as próprias avaliações — não existe "Painel do
  // Diretor" pra ele. Qualquer outro papel com acesso ao módulo (ADM,
  // Diretor Acadêmico etc.) enxerga o painel comparativo entre cursos.
  const ehCoordenador = role === 'coordenador';
  document.getElementById('tab-btn-diretor').classList.toggle('hidden', ehCoordenador);
  document.getElementById('page-subtitle').textContent = ehCoordenador
    ? 'Cadastre o professor e a turma, depois responda o questionário de avaliação'
    : 'Gerencie e acompanhe as avaliações de desempenho dos docentes';

  popularSelectSemestre(document.getElementById('avaliacao-semestre'), false);
  popularSelectSemestre(document.getElementById('filter-semestre'), true);
  document.getElementById('filter-semestre').addEventListener('change', applyFilters);

  setupFilters();
  setupTabs();
  renderPerguntas();
  await loadCursos();
  await loadAvaliacoes();
}

// ==========================================
// ABAS
// ==========================================
function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn[data-tab]');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('hidden')) return;

      tabBtns.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetTab = document.getElementById(`tab-${btn.dataset.tab}`);
      if (targetTab) targetTab.classList.add('active');

      if (btn.dataset.tab === 'diretor') {
        await loadDashboard();
      }
    });
  });
}

// ==========================================
// CURSOS
// ==========================================
async function loadCursos() {
  try {
    cursos = await apiFetch('/avaliacao-docente/cursos');
    const selectModal = document.getElementById('avaliacao-curso');
    selectModal.innerHTML = '<option value="">Selecione um curso</option>' +
      cursos.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    const selectDir = document.getElementById('filter-curso-dir');
    if (selectDir) {
      selectDir.innerHTML = '<option value="">Todos os Cursos</option>' +
        cursos.map(c => `<option value="${c.name}">${esc(c.name)}</option>`).join('');
      selectDir.addEventListener('change', renderDiretorList);
    }
  } catch (err) {
    console.error('Erro ao carregar cursos:', err.message);
  }
}

// Coordenador nunca escolhe o curso da avaliação — ele sempre avalia dentro
// do curso vinculado ao seu usuário (definido em Usuários pelo admin).
function aplicarRestricaoCurso() {
  const select = document.getElementById('avaliacao-curso');
  if (currentRole === 'coordenador') {
    select.value = meuCursoId || '';
    select.disabled = true;
  } else {
    select.disabled = false;
  }
}

// ==========================================
// MINHAS AVALIAÇÕES (cadastro básico: docente + semestre)
// ==========================================
async function loadAvaliacoes() {
  try {
    avaliacoes = await apiFetch('/avaliacao-docente');
    applyFilters();
  } catch (err) {
    alert("Erro ao carregar avaliações: " + err.message);
  }
}

function applyFilters() {
  const texto = (document.getElementById('filter-texto')?.value || '').toLowerCase();
  const semestre = document.getElementById('filter-semestre')?.value || '';

  const filtered = avaliacoes.filter(av => {
    const matchTexto = !texto || (av.docente || '').toLowerCase().includes(texto);
    const matchSemestre = !semestre || av.semestre === semestre;
    return matchTexto && matchSemestre;
  });

  const hasFilter = !!(texto || semestre);
  document.getElementById('btn-clear-filters')?.classList.toggle('hidden', !hasFilter);
  renderTable(filtered);
}

function setupFilters() {
  document.getElementById('filter-texto')?.addEventListener('input', applyFilters);
}

window.clearFilters = function () {
  document.getElementById('filter-texto').value = '';
  document.getElementById('filter-semestre').value = '';
  applyFilters();
};

function notaClass(nota) {
  const n = Number(nota);
  if (n >= 4) return 'badge-nota boa';
  if (n >= 3) return 'badge-nota media';
  return 'badge-nota baixa';
}

// Nota é a média das respostas 1-5 (escala do questionário); pode ser nula
// se a avaliação ainda está pendente ou se todas as perguntas foram N/A.
function notaBadge(nota) {
  if (nota === null || nota === undefined) return `<span class="badge-nota na">N/A</span>`;
  return `<span class="${notaClass(nota)}">${Number(nota).toFixed(1)}</span>`;
}

function statusBadge(status) {
  const concluida = status === 'concluida';
  return `<span class="badge-status ${concluida ? 'concluida' : 'pendente'}">${concluida ? 'Concluída' : 'Pendente'}</span>`;
}

function renderTable(lista = avaliacoes) {
  const tbody = document.getElementById('avaliacoes-list');
  if (!lista.length) {
    const msg = avaliacoes.length
      ? 'Nenhuma avaliação encontrada com esses filtros.'
      : 'Nenhuma avaliação cadastrada.';
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 24px; color:#64748b;">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(av => `
        <tr>
            <td><strong>${esc(av.docente)}</strong></td>
            <td>${esc(av.semestre)}º</td>
            <td>${esc(av.curso) || '-'}</td>
            <td>${statusBadge(av.status)}</td>
            <td>${notaBadge(av.nota)}</td>
            <td><button class="btn-sm" onclick="verDetalhes('${av.id}', false)">Ver</button></td>
            <td class="action-execute">
                <button class="btn-sm" onclick="abrirQuestionario('${av.id}', false)">${av.status === 'concluida' ? 'Editar Respostas' : 'Avaliar'}</button>
                <button class="btn-sm" onclick="editAvaliacao('${av.id}')">Editar</button>
                <button class="btn-sm danger" onclick="deleteAvaliacao('${av.id}')">Excluir</button>
            </td>
        </tr>
    `).join('');
}

// ==========================================
// MODAL: NOVA/EDITAR (cadastro básico)
// ==========================================
window.openModal = function () {
  if (currentRole === 'coordenador' && !meuCursoId) {
    alert('Seu usuário ainda não está vinculado a um curso. Peça a um administrador para vincular seu curso em Usuários antes de criar avaliações.');
    return;
  }
  document.getElementById('form-avaliacao').reset();
  document.getElementById('avaliacao-id').value = '';
  document.getElementById('modal-title').innerText = 'Nova Avaliação';
  aplicarRestricaoCurso();
  document.getElementById('modal-avaliacao').classList.remove('hidden');
}

window.closeModal = function () {
  document.getElementById('modal-avaliacao').classList.add('hidden');
}

window.editAvaliacao = function (id) {
  const av = avaliacoes.find(a => a.id === id);
  if (!av) return;
  document.getElementById('avaliacao-id').value = av.id;
  document.getElementById('avaliacao-docente').value = av.docente;
  document.getElementById('avaliacao-semestre').value = av.semestre;
  document.getElementById('avaliacao-curso').value = av.cursoId || '';
  document.getElementById('modal-title').innerText = 'Editar Avaliação';
  aplicarRestricaoCurso();
  document.getElementById('modal-avaliacao').classList.remove('hidden');
}

window.deleteAvaliacao = async function (id) {
  if (!confirm('Tem certeza que deseja remover esta avaliação?')) return;
  try {
    await apiFetch(`/avaliacao-docente/${id}`, { method: 'DELETE' });
    await loadAvaliacoes();
  } catch (err) {
    alert("Erro ao remover: " + err.message);
  }
}

document.getElementById('form-avaliacao').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('avaliacao-id').value;
  const cursoId = document.getElementById('avaliacao-curso').value;
  const cursoObj = cursos.find(c => c.id === cursoId);
  const data = {
    docente: document.getElementById('avaliacao-docente').value,
    semestre: document.getElementById('avaliacao-semestre').value,
    cursoId: cursoId || null,
    curso: cursoObj ? cursoObj.name : '',
  };

  try {
    let novoId = id;
    if (id) {
      await apiFetch(`/avaliacao-docente/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
      });
    } else {
      const resultado = await apiFetch(`/avaliacao-docente`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      novoId = resultado.id;
    }
    closeModal();
    await loadAvaliacoes();

    // Cadastro novo: já chama o questionário em seguida, pra fluir direto
    // pra etapa de avaliar o professor recém-cadastrado.
    if (!id && novoId) {
      abrirQuestionario(novoId, false);
    }
  } catch (err) {
    alert("Erro ao salvar: " + err.message);
  }
});

// ==========================================
// MODAL: QUESTIONÁRIO (as 12 perguntas)
// ==========================================
window.abrirQuestionario = function (id, todas) {
  const lista = todas ? avaliacoesTodas : avaliacoes;
  const av = lista.find(a => a.id === id);
  if (!av) return;

  document.getElementById('form-questionario').reset();
  document.getElementById('questionario-id').value = av.id;
  document.getElementById('questionario-title').textContent = `Avaliar: ${av.docente}`;
  document.getElementById('questionario-subtitle').textContent = `${av.semestre}º Semestre · ${av.curso || 'Curso não informado'}`;
  preencherRespostas(av.respostas);
  document.getElementById('questionario-alunos').value = av.alunos || '';
  preencherAlunosNomes(av.alunosNomes);
  document.getElementById('questionario-positivo').value = av.positivo || '';
  document.getElementById('questionario-melhoria').value = av.melhoria || '';
  mostrarEtapaQuestionario(1);
  document.getElementById('modal-questionario').classList.remove('hidden');
}

window.closeQuestionario = function () {
  document.getElementById('modal-questionario').classList.add('hidden');
}

document.getElementById('form-questionario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('questionario-id').value;
  const data = {
    respostas: coletarRespostas(),
    alunos: document.getElementById('questionario-alunos').value,
    alunosNomes: coletarAlunosNomes(),
    positivo: document.getElementById('questionario-positivo').value,
    melhoria: document.getElementById('questionario-melhoria').value,
  };

  try {
    await apiFetch(`/avaliacao-docente/${id}/responder`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    closeQuestionario();
    await loadAvaliacoes();
    if (currentRole !== 'coordenador') await loadDashboard();
  } catch (err) {
    alert("Erro ao salvar respostas: " + err.message);
  }
});

// ==========================================
// PAINEL DO DIRETOR
// ==========================================
async function loadDashboard() {
  try {
    const dados = await apiFetch('/avaliacao-docente/dashboard');
    document.getElementById('dash-total').textContent = dados.total;
    document.getElementById('dash-media').textContent = dados.mediaGeral.toFixed(1);
    document.getElementById('dash-cursos').textContent = dados.porCurso.length;

    const tbody = document.getElementById('dashboard-porcurso-list');
    if (!dados.porCurso.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding: 24px; color:#64748b;">Nenhuma avaliação cadastrada ainda.</td></tr>`;
    } else {
      tbody.innerHTML = dados.porCurso.map(c => `
                <tr>
                    <td><strong>${esc(c.curso)}</strong></td>
                    <td>${c.total}</td>
                    <td>${notaBadge(c.media)}</td>
                </tr>
            `).join('');
    }

    // Reaproveita a lista completa (não escopada) só disponível pra quem tem
    // acesso ao painel do diretor — busca de novo pois `avaliacoes` (a de
    // "Minhas Avaliações") já está escopada por coordenador quando aplicável.
    if (currentRole !== 'coordenador') {
      avaliacoesTodas = await apiFetch('/avaliacao-docente');
    } else {
      avaliacoesTodas = avaliacoes;
    }
    renderDiretorList();
  } catch (err) {
    alert("Erro ao carregar o painel do diretor: " + err.message);
  }
}

function renderDiretorList() {
  const cursoFiltro = document.getElementById('filter-curso-dir')?.value || '';
  const lista = cursoFiltro
    ? avaliacoesTodas.filter(a => a.curso === cursoFiltro)
    : avaliacoesTodas;

  const tbody = document.getElementById('diretor-list');
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 24px; color:#64748b;">Nenhuma avaliação encontrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(av => `
        <tr>
            <td><strong>${esc(av.docente)}</strong></td>
            <td>${esc(av.semestre)}º</td>
            <td>${esc(av.curso) || '-'}</td>
            <td>${statusBadge(av.status)}</td>
            <td>${notaBadge(av.nota)}</td>
            <td>${esc(av.criadoPorNome) || '-'}</td>
            <td><button class="btn-sm" onclick="verDetalhes('${av.id}', true)">Ver</button></td>
        </tr>
    `).join('');
}

// ==========================================
// DETALHES (somente leitura)
// ==========================================
window.verDetalhes = function (id, todas) {
  const lista = todas ? avaliacoesTodas : avaliacoes;
  const av = lista.find(a => a.id === id);
  if (!av) return;

  const perguntasHtml = PERGUNTAS.map((texto, idx) => {
    const n = idx + 1;
    const resposta = av.respostas ? av.respostas[`p${n}`] : null;
    const val = resposta && typeof resposta === 'object' ? resposta.valor : resposta;
    const obs = resposta && typeof resposta === 'object' ? resposta.obs : '';
    const opcao = ESCALA.find(o => o.value === val);
    return `
      <div class="detalhe-pergunta">
        <strong>${n}. ${esc(texto)}</strong>
        <p>${opcao ? esc(opcao.label) : 'Não respondida'}</p>
        ${obs ? `<p class="detalhe-obs">Observação: ${esc(obs)}</p>` : ''}
      </div>
    `;
  }).join('');

  document.getElementById('detalhes-content').innerHTML = `
    <div class="detalhe-header">
      <p><strong>Docente:</strong> ${esc(av.docente)} · <strong>Semestre:</strong> ${esc(av.semestre)}º</p>
      <p><strong>Curso:</strong> ${esc(av.curso) || '-'} · <strong>Status:</strong> ${statusBadge(av.status)} · <strong>Nota:</strong> ${av.nota !== null && av.nota !== undefined ? Number(av.nota).toFixed(1) : 'N/A'}</p>
      ${av.alunos ? `<p><strong>Quantidade de Alunos:</strong> ${esc(String(av.alunos))}</p>` : ''}
      ${(av.alunosNomes || []).some(n => n) ? `<p><strong>Alunos:</strong> ${av.alunosNomes.map((n, i) => esc(n) || `Aluno ${i + 1}`).join(', ')}</p>` : ''}
      ${av.criadoPorNome ? `<p><strong>Avaliado por:</strong> ${esc(av.criadoPorNome)}</p>` : ''}
    </div>
    ${perguntasHtml}
    <div class="detalhe-pergunta">
      <strong>11. O que este professor faz que contribui positivamente para sua aprendizagem?</strong>
      <p>${esc(av.positivo) || '—'}</p>
    </div>
    <div class="detalhe-pergunta">
      <strong>12. O que este professor poderia melhorar para contribuir ainda mais com sua aprendizagem?</strong>
      <p>${esc(av.melhoria) || '—'}</p>
    </div>
  `;
  document.getElementById('modal-detalhes').classList.remove('hidden');
}

window.closeDetalhes = function () {
  document.getElementById('modal-detalhes').classList.add('hidden');
}
