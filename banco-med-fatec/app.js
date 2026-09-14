// ================================================================
//  ÓRBITA — MÓDULO BANCO MED-FATEC
//  Banco de questões clínicas (Medicina) + exportação Moodle XML
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../core/layout.js";
import { escapeHTML as esc, sanitizeHTML } from "../core/security.js";
import { getEffectiveLevel } from "../core/permissions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;

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
    try { const body = await res.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// Download de arquivo (usado na exportação do XML) — precisa do token
// no header, então não dá pra ser um <a href> simples.
async function apiDownload(endpoint) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') {
    token = await currentUser.getIdToken();
  }
  const res = await fetch(`${API_BASE}${endpoint}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    let msg = `Erro ao exportar: ${res.status}`;
    try { const body = await res.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const nomeArquivo = match ? match[1] : 'prova.xml';

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---- Compressão de imagem no navegador (mesmo padrão do módulo Ferida) ----
const LIMITE_BASE64 = 950000;

// Núcleo comum: recebe a imagem já como data URL e comprime em cascata até
// caber no limite de 1 MiB do documento do Firestore.
function comprimirDataUrl(dataUrl) {
  const tentativas = [
    { dim: 1600, q: 0.85 },
    { dim: 1400, q: 0.72 },
    { dim: 1200, q: 0.62 },
    { dim: 1000, q: 0.52 },
    { dim: 800, q: 0.45 }
  ];
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Já cabe sem precisar reprocessar (ex.: imagem pequena vinda do Moodle)
      if (dataUrl.length <= LIMITE_BASE64 && /^data:image\/jpeg/.test(dataUrl)) return resolve(dataUrl);
      for (const t of tentativas) {
        const scale = Math.min(1, t.dim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL('image/jpeg', t.q);
        if (out.length <= LIMITE_BASE64) return resolve(out);
      }
      reject(new Error('Imagem grande demais mesmo após compressão.'));
    };
    img.onerror = () => reject(new Error('Não foi possível carregar a imagem.'));
    img.src = dataUrl;
  });
}

// Upload manual (input type=file) — lê o arquivo e delega a compressão.
function comprimirImagem(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => comprimirDataUrl(reader.result).then(resolve, reject);
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

// ---- Estado local ----
// Nunca carregamos o banco inteiro de uma vez — cada pedaço é buscado sob
// demanda, filtrado no servidor, e só o necessário pra tela atual fica em
// memória (economia de leitura no Firestore: o banco cresce bastante com
// as importações do AVA).
let categorias = [];
let questoesBanco = [];      // questões "publicada" do período escolhido no filtro do Banco de Questões
let questoesRevisao = [];    // questões status=revisao_importacao (fila de revisão — sempre carregada, é pequena)
let questoesProvaAtual = []; // questões da disciplina da prova aberta em "Montar Prova" (carregado ao abrir o modal)
let provas = [];
let imagemAtual = null; // { nome, dataUrl } | null
let provaEmEdicao = null; // prova sendo montada no modal

const DIFICULDADE_LABEL = { facil: 'Fácil', media: 'Média', intermediaria: 'Intermediária', dificil: 'Difícil' };
const TIPO_LABEL = {
  multichoice_unica: 'Múltipla escolha (uma correta)',
  multichoice_multipla: 'Múltipla escolha (várias corretas)',
  verdadeiro_falso: 'Verdadeiro/Falso'
};

// Ícones SVG inline (nunca emoji/glifo unicode como substituto de ícone).
const ICONS = {
  editar: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 0 1 4 4L7 21l-4 1 1-4Z"/></svg>',
  excluir: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  imagem: '<svg class="bmf-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  montar: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
};

function nomeCategoria(id) {
  const c = categorias.find(c => c.id === id);
  if (!c) return '—';
  return `${c.periodo}º Período · ${c.nome}${c.nomeBreve ? ` (${c.nomeBreve})` : ''}`;
}

// ================================================================
//  CARREGAMENTO DE DADOS
// ================================================================
async function carregarQuestoesRevisao() {
  questoesRevisao = await apiFetch('/banco-med-fatec/questoes?status=revisao_importacao');
}

async function carregarQuestoesDoPeriodo(periodo) {
  questoesBanco = periodo
    ? await apiFetch(`/banco-med-fatec/questoes?periodo=${encodeURIComponent(periodo)}&status=publicada`)
    : [];
}

async function carregarQuestoesDaCategoria(categoriaId) {
  questoesProvaAtual = await apiFetch(`/banco-med-fatec/questoes?categoriaId=${encodeURIComponent(categoriaId)}&status=publicada`);
}

// Recarrega categorias/provas/fila-de-revisão (sempre leves) e, só se já
// houver um período escolhido no filtro, as questões daquele período — nunca
// o banco inteiro.
async function carregarTudo() {
  try {
    [categorias, provas] = await Promise.all([
      apiFetch('/banco-med-fatec/categorias'),
      apiFetch('/banco-med-fatec/provas')
    ]);
    await carregarQuestoesRevisao();
    popularSelectsCategoria();

    const periodoAtual = document.getElementById('bmf-filtro-periodo').value;
    await carregarQuestoesDoPeriodo(periodoAtual);

    renderQuestoes();
    renderProvas();
    renderRevisao();
  } catch (err) {
    console.error(err);
  }
}

function ordinal(n) { return `${n}º`; }

// Popula os selects de "Período" (1º a 12º, grade da Medicina) usados no
// filtro do banco e nos formulários de questão/prova/nova disciplina.
function popularSelectsPeriodo() {
  const ids = ['bmf-filtro-periodo', 'bmf-q-periodo', 'bmf-p-periodo', 'bmf-q-categoria-nova-periodo', 'bmf-prova-filtro-periodo'];
  ids.map(id => document.getElementById(id)).forEach(sel => {
    if (!sel || sel.dataset.montado) return;
    for (let p = 1; p <= 12; p++) {
      const opt = document.createElement('option');
      opt.value = String(p);
      opt.textContent = sel.id === 'bmf-q-categoria-nova-periodo' ? `${ordinal(p)} Per.` : `${ordinal(p)} Período`;
      sel.appendChild(opt);
    }
    sel.dataset.montado = '1';
  });
}

// Filtro do banco: disciplinas agrupadas por período (<optgroup>) — dá pra
// ver tudo de uma vez, já filtrado se um período específico for escolhido.
function popularSelectsCategoria() {
  const sel = document.getElementById('bmf-filtro-categoria');
  const filtroPeriodo = document.getElementById('bmf-filtro-periodo').value;
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Todas as disciplinas</option>';

  const porPeriodo = new Map();
  categorias.forEach(c => {
    if (filtroPeriodo && String(c.periodo) !== filtroPeriodo) return;
    if (!porPeriodo.has(c.periodo)) porPeriodo.set(c.periodo, []);
    porPeriodo.get(c.periodo).push(c);
  });

  [...porPeriodo.keys()].sort((a, b) => a - b).forEach(periodo => {
    const group = document.createElement('optgroup');
    group.label = `${ordinal(periodo)} Período`;
    porPeriodo.get(periodo).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      const rotulo = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
      opt.textContent = `${rotulo} — ${c.totalQuestoes || 0} questão(ões)`;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  });

  if (valorAtual && [...sel.options].some(o => o.value === valorAtual)) sel.value = valorAtual;
}

// Formulários de questão/prova: fluxo em cascata — escolhe o período
// primeiro, o select de disciplina já filtra sozinho pra só aquele período
// (pedido do professor: "ela seleciona o período aí já traz as disciplinas
// corretas daquele período", em vez de rolar uma lista longa de todas).
function popularDisciplinasDoPeriodo(selectDisciplinaId, periodo, valorParaSelecionar) {
  const sel = document.getElementById(selectDisciplinaId);
  sel.innerHTML = '';

  if (!periodo) {
    sel.innerHTML = '<option value="">Selecione o período primeiro</option>';
    return;
  }

  const daPeriodo = categorias.filter(c => String(c.periodo) === String(periodo));
  if (!daPeriodo.length) {
    sel.innerHTML = '<option value="" disabled selected>Nenhuma disciplina cadastrada neste período</option>';
    return;
  }

  daPeriodo.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
    sel.appendChild(opt);
  });

  if (valorParaSelecionar && daPeriodo.some(c => c.id === valorParaSelecionar)) {
    sel.value = valorParaSelecionar;
  }
}

// ================================================================
//  RENDER: BANCO DE QUESTÕES
// ================================================================
function questoesFiltradas() {
  // questoesBanco já vem do servidor filtrado por período + status=publicada
  // — aqui só refinamos dentro do que já está em memória (disciplina/
  // dificuldade/busca não precisam de nova ida ao Firestore).
  const cat = document.getElementById('bmf-filtro-categoria').value;
  const dif = document.getElementById('bmf-filtro-dificuldade').value;
  const busca = document.getElementById('bmf-filtro-busca').value.trim().toLowerCase();

  return questoesBanco.filter(q => {
    if (cat && q.categoriaId !== cat) return false;
    if (dif && q.dificuldade !== dif) return false;
    if (busca && !(`${q.titulo} ${q.elaboradoPor}`.toLowerCase().includes(busca))) return false;
    return true;
  });
}

function nomeCategoriaObj(id) {
  return categorias.find(c => c.id === id);
}

// Seleção em massa (mesmo padrão do item bank do quiz.one: marca várias
// questões na lista e já manda pra uma prova, sem precisar reabrir um modal
// e buscar tudo de novo).
let questoesSelecionadas = new Set();

function renderQuestoes() {
  const grid = document.getElementById('bmf-questoes-grid');
  const vazio = document.getElementById('bmf-questoes-vazio');

  // Sem período escolhido ainda, não tem o que listar (e não fomos buscar
  // nada no servidor) — pede pra escolher em vez de mostrar "vazio".
  const periodoEscolhido = document.getElementById('bmf-filtro-periodo').value;
  if (!periodoEscolhido) {
    grid.innerHTML = '';
    vazio.textContent = 'Selecione um período acima pra ver as questões daquele período.';
    vazio.classList.remove('hidden');
    renderBarraSelecao();
    return;
  }

  const lista = questoesFiltradas();

  // Tira da seleção qualquer questão que não esteja mais na lista filtrada
  // (foi excluída, ou mudou de disciplina) — evita "selecionadas fantasmas".
  const idsVisiveis = new Set(lista.map(q => q.id));
  [...questoesSelecionadas].forEach(id => { if (!idsVisiveis.has(id)) questoesSelecionadas.delete(id); });

  grid.innerHTML = '';
  vazio.textContent = 'Nenhuma questão encontrada. Que tal cadastrar a primeira?';
  vazio.classList.toggle('hidden', lista.length > 0);

  lista.forEach(q => {
    const row = document.createElement('div');
    row.className = 'bmf-q-row';
    row.innerHTML = `
      <input type="checkbox" class="bmf-q-row-check" data-id="${q.id}" ${questoesSelecionadas.has(q.id) ? 'checked' : ''} aria-label="Selecionar questão">
      <div class="bmf-q-row-main">
        <div class="bmf-q-row-badges">
          <span class="bmf-badge bmf-badge-${q.dificuldade}">${DIFICULDADE_LABEL[q.dificuldade] || q.dificuldade}</span>
          <span class="bmf-badge bmf-badge-tipo">${q.imagem ? ICONS.imagem : ''}${TIPO_LABEL[q.tipoMoodle] || q.tipoMoodle}</span>
        </div>
        <div class="bmf-q-row-titulo">${esc(q.titulo)}</div>
        <div class="bmf-q-row-meta">${esc(nomeCategoria(q.categoriaId))} · por ${esc(q.elaboradoPor || '—')}</div>
      </div>
      <div class="bmf-q-row-actions">
        <button class="bmf-icon-btn bmf-btn-editar-questao action-execute" data-id="${q.id}" title="Editar questão">${ICONS.editar}</button>
        <button class="bmf-icon-btn bmf-icon-btn-perigo bmf-btn-excluir-questao action-execute" data-id="${q.id}" title="Excluir questão">${ICONS.excluir}</button>
      </div>
    `;
    grid.appendChild(row);
  });

  grid.querySelectorAll('.bmf-btn-editar-questao').forEach(btn => {
    btn.addEventListener('click', () => abrirModalQuestao(btn.dataset.id));
  });
  grid.querySelectorAll('.bmf-btn-excluir-questao').forEach(btn => {
    btn.addEventListener('click', () => excluirQuestao(btn.dataset.id));
  });
  grid.querySelectorAll('.bmf-q-row-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) questoesSelecionadas.add(chk.dataset.id);
      else questoesSelecionadas.delete(chk.dataset.id);
      renderBarraSelecao();
    });
  });

  renderBarraSelecao();
}

function renderBarraSelecao() {
  const barra = document.getElementById('bmf-selecao-bar');
  const n = questoesSelecionadas.size;
  barra.classList.toggle('hidden', n === 0);
  if (n > 0) {
    document.getElementById('bmf-selecao-contagem').textContent = `${n} questão(ões) selecionada(s)`;
  }
}

// ================================================================
//  RENDER: PROVAS
// ================================================================
function provasFiltradas() {
  const periodo = document.getElementById('bmf-prova-filtro-periodo').value;
  return provas.filter(p => {
    if (periodo && String(nomeCategoriaObj(p.categoriaId)?.periodo) !== periodo) return false;
    return true;
  });
}

function renderProvas() {
  const grid = document.getElementById('bmf-provas-grid');
  const vazio = document.getElementById('bmf-provas-vazio');
  const lista = provasFiltradas();
  grid.innerHTML = '';
  vazio.classList.toggle('hidden', lista.length > 0);

  lista.forEach(p => {
    const row = document.createElement('div');
    row.className = 'bmf-prova-row';
    const totalExport = (p.exportacoes || []).length;
    row.innerHTML = `
      <div class="bmf-prova-row-main">
        <div class="bmf-q-row-badges">
          ${p.semestre ? `<span class="bmf-badge bmf-badge-tipo">${esc(p.semestre)}</span>` : ''}
        </div>
        <div class="bmf-prova-row-titulo">${esc(p.nome)}</div>
        <div class="bmf-prova-row-meta">${esc(nomeCategoria(p.categoriaId))} · ${(p.questoesIds || []).length} questão(ões)${totalExport ? ` · exportada ${totalExport}x` : ''}</div>
      </div>
      <div class="bmf-prova-row-acoes">
        <button class="btn btn-secondary bmf-btn-montar-prova action-execute" data-id="${p.id}">
          ${ICONS.montar}
          <span>Montar / Exportar</span>
        </button>
        <button class="bmf-icon-btn bmf-icon-btn-perigo bmf-btn-excluir-prova-linha action-execute" data-id="${p.id}" data-nome="${esc(p.nome)}" title="Excluir prova">${ICONS.excluir}</button>
      </div>
    `;
    grid.appendChild(row);
  });

  grid.querySelectorAll('.bmf-btn-excluir-prova-linha').forEach(btn => {
    btn.addEventListener('click', () => excluirProvaPorId(btn.dataset.id, btn.dataset.nome));
  });

  grid.querySelectorAll('.bmf-btn-montar-prova').forEach(btn => {
    btn.addEventListener('click', () => abrirModalMontarProva(btn.dataset.id));
  });
}

// ================================================================
//  MODAL: QUESTÃO (criar/editar)
// ================================================================
function novaLinhaAlternativa(texto = '', correta = false, tipoRadio = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'bmf-alt-linha';
  wrapper.innerHTML = `
    <input type="${tipoRadio ? 'radio' : 'checkbox'}" name="bmf-alt-correta" class="bmf-alt-correta" ${correta ? 'checked' : ''}>
    <input type="text" class="form-control bmf-alt-texto" placeholder="Texto da alternativa" value="${esc(texto)}">
    <button type="button" class="bmf-icon-btn bmf-icon-btn-perigo bmf-alt-remover" title="Remover alternativa">
      <svg class="bmf-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  wrapper.querySelector('.bmf-alt-remover').addEventListener('click', () => wrapper.remove());
  return wrapper;
}

function renderAlternativasEditor(alternativas, tipoMoodle) {
  const lista = document.getElementById('bmf-alternativas-lista');
  lista.innerHTML = '';
  const tipoRadio = tipoMoodle === 'multichoice_unica';
  alternativas.forEach(a => lista.appendChild(novaLinhaAlternativa(a.texto, a.correta, tipoRadio)));
}

function ajustarEditorPorTipo() {
  const tipo = document.getElementById('bmf-q-tipo').value;
  const lista = document.getElementById('bmf-alternativas-lista');
  const addBtn = document.getElementById('bmf-btn-add-alternativa');

  if (tipo === 'verdadeiro_falso') {
    lista.innerHTML = '';
    lista.appendChild(novaLinhaAlternativa('Verdadeiro', true, true));
    lista.appendChild(novaLinhaAlternativa('Falso', false, true));
    lista.querySelectorAll('.bmf-alt-texto').forEach(inp => inp.disabled = true);
    lista.querySelectorAll('.bmf-alt-remover').forEach(btn => btn.style.display = 'none');
    addBtn.classList.add('hidden');
    return;
  }

  addBtn.classList.remove('hidden');
  const tipoRadio = tipo === 'multichoice_unica';
  lista.querySelectorAll('.bmf-alt-correta').forEach(inp => {
    inp.type = tipoRadio ? 'radio' : 'checkbox';
    inp.name = tipoRadio ? 'bmf-alt-correta' : '';
  });
  if (!lista.children.length) {
    lista.appendChild(novaLinhaAlternativa('', false, tipoRadio));
    lista.appendChild(novaLinhaAlternativa('', false, tipoRadio));
  }
}

function limparFormQuestao() {
  document.getElementById('bmf-form-questao').reset();
  document.getElementById('bmf-q-id').value = '';
  document.getElementById('bmf-q-erro').classList.add('hidden');
  document.getElementById('bmf-nova-categoria-group').classList.add('hidden');
  popularDisciplinasDoPeriodo('bmf-q-categoria', '');
  imagemAtual = null;
  document.getElementById('bmf-q-imagem-preview').classList.add('hidden');
  document.getElementById('bmf-q-imagem-input').value = '';
  document.getElementById('bmf-q-imagem-nome').textContent = 'Escolher imagem…';
  renderAlternativasEditor([{ texto: '', correta: false }, { texto: '', correta: false }], 'multichoice_unica');
}

function abrirModalQuestao(id) {
  limparFormQuestao();
  const modal = document.getElementById('bmf-modal-questao');
  const titulo = document.getElementById('bmf-questao-modal-titulo');

  if (id) {
    const q = questoesBanco.find(q => q.id === id);
    if (!q) return;
    titulo.textContent = 'Editar Questão';
    document.getElementById('bmf-q-id').value = q.id;
    document.getElementById('bmf-q-titulo').value = q.titulo;
    const categoriaAtual = nomeCategoriaObj(q.categoriaId);
    if (categoriaAtual) {
      document.getElementById('bmf-q-periodo').value = String(categoriaAtual.periodo);
      popularDisciplinasDoPeriodo('bmf-q-categoria', categoriaAtual.periodo, q.categoriaId);
    }
    document.getElementById('bmf-q-dificuldade').value = q.dificuldade;
    document.getElementById('bmf-q-tipo').value = q.tipoMoodle;
    document.getElementById('bmf-q-enunciado').value = q.enunciadoHtml;
    document.getElementById('bmf-q-justificativa').value = q.justificativa || '';
    document.getElementById('bmf-q-fonte').value = q.fonte || '';
    renderAlternativasEditor(q.alternativas, q.tipoMoodle);
    if (q.tipoMoodle === 'verdadeiro_falso') ajustarEditorPorTipo();
    if (q.imagem && q.imagem.dataUrl) {
      imagemAtual = q.imagem;
      document.getElementById('bmf-q-imagem-img').src = q.imagem.dataUrl;
      document.getElementById('bmf-q-imagem-preview').classList.remove('hidden');
      document.getElementById('bmf-q-imagem-nome').textContent = q.imagem.nome || 'Imagem carregada';
    }
  } else {
    titulo.textContent = 'Nova Questão';
    // Sem disciplina nenhuma cadastrada, o select de disciplina fica vazio —
    // já abre o painel de criação em vez de deixar a professora procurando o "+".
    if (categorias.length === 0) {
      document.getElementById('bmf-nova-categoria-group').classList.remove('hidden');
    }
  }

  modal.classList.add('active');
}

function fecharModalQuestao() {
  document.getElementById('bmf-modal-questao').classList.remove('active');
}

function lerAlternativasDoForm() {
  return [...document.querySelectorAll('#bmf-alternativas-lista .bmf-alt-linha')].map(linha => ({
    texto: linha.querySelector('.bmf-alt-texto').value.trim(),
    correta: linha.querySelector('.bmf-alt-correta').checked
  }));
}

async function salvarQuestao(e) {
  e.preventDefault();
  const erroEl = document.getElementById('bmf-q-erro');
  erroEl.classList.add('hidden');

  const id = document.getElementById('bmf-q-id').value;
  const payload = {
    titulo: document.getElementById('bmf-q-titulo').value.trim(),
    categoriaId: document.getElementById('bmf-q-categoria').value,
    dificuldade: document.getElementById('bmf-q-dificuldade').value,
    tipoMoodle: document.getElementById('bmf-q-tipo').value,
    enunciadoHtml: sanitizeHTML(document.getElementById('bmf-q-enunciado').value.trim()).replace(/\n/g, '<br>'),
    alternativas: lerAlternativasDoForm(),
    justificativa: sanitizeHTML(document.getElementById('bmf-q-justificativa').value.trim()).replace(/\n/g, '<br>'),
    fonte: document.getElementById('bmf-q-fonte').value.trim(),
    imagem: imagemAtual
  };

  try {
    if (id) {
      await apiFetch(`/banco-med-fatec/questoes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/banco-med-fatec/questoes', { method: 'POST', body: JSON.stringify(payload) });
    }
    fecharModalQuestao();
    await carregarTudo();
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

async function excluirQuestao(id) {
  if (!confirm('Remover esta questão do banco compartilhado? Ela sairá de qualquer prova que a use.')) return;
  try {
    await apiFetch(`/banco-med-fatec/questoes/${id}`, { method: 'DELETE' });
    await carregarTudo();
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
  }
}

// ================================================================
//  MODAL: NOVA PROVA
// ================================================================
// Quando "Nova Prova" é aberta a partir da seleção em massa do banco (ver
// abrirModalAdicionarProva), essas questões já entram na prova assim que
// ela é criada — sem precisar reabrir "Montar Prova" pra selecioná-las de novo.
let questoesParaNovaProva = null;

function abrirModalNovaProva(prefill) {
  if (categorias.length === 0) {
    alert('Ainda não há nenhuma disciplina cadastrada. Cadastre uma disciplina primeiro pela aba "Banco de Questões" (botão "+ Nova Questão" → "+" ao lado de Disciplina).');
    return;
  }
  document.getElementById('bmf-form-prova-novo').reset();
  questoesParaNovaProva = prefill?.questoesIds || null;
  if (prefill?.categoriaId) {
    const cat = nomeCategoriaObj(prefill.categoriaId);
    if (cat) {
      document.getElementById('bmf-p-periodo').value = String(cat.periodo);
      popularDisciplinasDoPeriodo('bmf-p-categoria', cat.periodo, cat.id);
    }
  } else {
    popularDisciplinasDoPeriodo('bmf-p-categoria', '');
  }
  // Sugere o semestre corrente (jan-jun = .1, jul-dez = .2) — o professor pode trocar.
  const hoje = new Date();
  document.getElementById('bmf-p-semestre').value = `${hoje.getFullYear()}.${hoje.getMonth() < 6 ? '1' : '2'}`;
  document.getElementById('bmf-modal-prova-novo').classList.add('active');
}
function fecharModalNovaProva() {
  document.getElementById('bmf-modal-prova-novo').classList.remove('active');
}

async function criarProva(e) {
  e.preventDefault();
  try {
    const questoesIds = questoesParaNovaProva || [];
    await apiFetch('/banco-med-fatec/provas', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('bmf-p-nome').value.trim(),
        semestre: document.getElementById('bmf-p-semestre').value.trim(),
        categoriaId: document.getElementById('bmf-p-categoria').value,
        questoesIds
      })
    });
    const veioDaSelecao = questoesParaNovaProva && questoesParaNovaProva.length > 0;
    questoesParaNovaProva = null;
    fecharModalNovaProva();
    if (veioDaSelecao) {
      questoesSelecionadas.clear();
      fecharModalAdicionarProva();
    }
    await carregarTudo();
  } catch (err) {
    alert('Erro ao criar prova: ' + err.message);
  }
}

// ================================================================
//  ADICIONAR SELEÇÃO EM MASSA A UMA PROVA (fluxo do item bank)
// ================================================================
function abrirModalAdicionarProva() {
  const idsSelecionados = [...questoesSelecionadas];
  const erroEl = document.getElementById('bmf-adicionar-prova-erro');
  const sub = document.getElementById('bmf-adicionar-prova-sub');
  const lista = document.getElementById('bmf-adicionar-prova-lista');
  erroEl.classList.add('hidden');

  const questoesSelecionadasObjs = questoesBanco.filter(q => idsSelecionados.includes(q.id));
  const categoriasDistintas = new Set(questoesSelecionadasObjs.map(q => q.categoriaId));

  if (categoriasDistintas.size > 1) {
    erroEl.textContent = 'As questões selecionadas são de disciplinas diferentes. Uma prova pertence a uma única disciplina — selecione questões de uma disciplina por vez.';
    erroEl.classList.remove('hidden');
    lista.innerHTML = '';
    sub.textContent = '';
    document.getElementById('bmf-modal-adicionar-prova').classList.add('active');
    return;
  }

  const categoriaId = [...categoriasDistintas][0];
  sub.textContent = `${idsSelecionados.length} questão(ões) de "${nomeCategoria(categoriaId)}" — escolha a prova de destino:`;

  const provasDaDisciplina = provas.filter(p => p.categoriaId === categoriaId);
  lista.innerHTML = '';

  provasDaDisciplina.forEach(p => {
    const linha = document.createElement('button');
    linha.type = 'button';
    linha.className = 'bmf-prova-q-linha';
    linha.style.cssText = 'width:100%; text-align:left; background:none; border:none; cursor:pointer;';
    const jaTem = (p.questoesIds || []).filter(id => idsSelecionados.includes(id)).length;
    linha.innerHTML = `
      <span class="bmf-prova-q-titulo">${esc(p.nome)} <span style="color:var(--text-secondary); font-weight:500;">(${esc(p.semestre || '')})</span></span>
      <span class="bmf-q-meta">${jaTem ? `${jaTem} já estão aqui` : ''}</span>
    `;
    linha.addEventListener('click', () => adicionarSelecaoNaProva(p.id, idsSelecionados));
    lista.appendChild(linha);
  });

  const criarNova = document.createElement('button');
  criarNova.type = 'button';
  criarNova.className = 'bmf-prova-q-linha';
  criarNova.style.cssText = 'width:100%; text-align:left; background:none; border:none; cursor:pointer; color:var(--med-azul-escuro); font-weight:700;';
  criarNova.innerHTML = `<span class="bmf-prova-q-titulo">+ Criar nova prova com estas questões</span>`;
  criarNova.addEventListener('click', () => {
    fecharModalAdicionarProva();
    abrirModalNovaProva({ categoriaId, questoesIds: idsSelecionados });
  });
  lista.appendChild(criarNova);

  document.getElementById('bmf-modal-adicionar-prova').classList.add('active');
}

function fecharModalAdicionarProva() {
  document.getElementById('bmf-modal-adicionar-prova').classList.remove('active');
}

async function adicionarSelecaoNaProva(provaId, idsParaAdicionar) {
  const erroEl = document.getElementById('bmf-adicionar-prova-erro');
  erroEl.classList.add('hidden');
  try {
    const prova = provas.find(p => p.id === provaId);
    const questoesIds = [...new Set([...(prova.questoesIds || []), ...idsParaAdicionar])];
    await apiFetch(`/banco-med-fatec/provas/${provaId}`, {
      method: 'PUT',
      body: JSON.stringify({ nome: prova.nome, categoriaId: prova.categoriaId, questoesIds })
    });
    questoesSelecionadas.clear();
    fecharModalAdicionarProva();
    await carregarTudo();
    alert(`Adicionado à prova "${prova.nome}"!`);
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

// ================================================================
//  MODAL: MONTAR / EXPORTAR PROVA
// ================================================================
// Fonte única de verdade da seleção enquanto o modal está aberto — os
// checkboxes só refletem este Set, nunca o contrário. Sem isso, filtrar
// pela busca (que remove do DOM as linhas que não batem) fazia a seleção de
// itens fora do filtro sumir na hora de salvar/exportar.
let selecaoProvaAtual = new Set();

function renderListaSelecaoQuestoes() {
  const busca = document.getElementById('bmf-prova-busca').value.trim().toLowerCase();
  const lista = document.getElementById('bmf-prova-questoes-lista');
  lista.innerHTML = '';

  // questoesProvaAtual já vem do servidor filtrado pela disciplina da prova
  // (GET /questoes?categoriaId=...) — cada prova pertence a uma disciplina
  // só, então misturar questões de outras disciplinas aqui não fazia sentido.
  const disponiveis = questoesProvaAtual.filter(q => !busca || q.titulo.toLowerCase().includes(busca));

  if (!questoesProvaAtual.length) {
    lista.innerHTML = `<p class="bmf-empty" style="padding:1.5rem;">Ainda não há questões cadastradas em "${esc(nomeCategoria(provaEmEdicao.categoriaId))}". Cadastre questões dessa disciplina na aba Banco de Questões.</p>`;
    return;
  }

  disponiveis.forEach(q => {
    const item = document.createElement('div');
    item.className = 'bmf-prova-q-item';
    const alternativasHtml = (q.alternativas || []).map(a =>
      `<li class="${a.correta ? 'bmf-prova-q-alt-correta' : ''}">${esc(a.texto)}</li>`
    ).join('');
    item.innerHTML = `
      <div class="bmf-prova-q-linha">
        <input type="checkbox" class="bmf-prova-q-check" value="${q.id}" ${selecaoProvaAtual.has(q.id) ? 'checked' : ''} aria-label="Selecionar questão">
        <span class="bmf-badge bmf-badge-${q.dificuldade}">${DIFICULDADE_LABEL[q.dificuldade]}</span>
        <button type="button" class="bmf-prova-q-titulo bmf-prova-q-expandir" data-id="${q.id}">${esc(q.titulo)}</button>
        <button type="button" class="bmf-icon-btn bmf-prova-q-expandir" data-id="${q.id}" title="Ver enunciado">
          <svg class="bmf-icon" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <div class="bmf-prova-q-detalhe hidden" id="bmf-prova-q-detalhe-${q.id}">
        <div class="bmf-prova-q-enunciado">${q.enunciadoHtml || ''}</div>
        ${q.imagem && q.imagem.dataUrl ? `<img src="${q.imagem.dataUrl}" alt="Imagem clínica" class="bmf-prova-q-imagem">` : ''}
        <ul class="bmf-prova-q-alternativas">${alternativasHtml}</ul>
        ${q.justificativa ? `<p class="bmf-prova-q-justificativa"><strong>Justificativa:</strong> ${q.justificativa}</p>` : ''}
      </div>
    `;
    lista.appendChild(item);
  });

  lista.querySelectorAll('.bmf-prova-q-expandir').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(`bmf-prova-q-detalhe-${btn.dataset.id}`)?.classList.toggle('hidden');
    });
  });

  lista.querySelectorAll('.bmf-prova-q-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) selecaoProvaAtual.add(chk.value);
      else selecaoProvaAtual.delete(chk.value);
    });
  });
}

async function abrirModalMontarProva(id) {
  provaEmEdicao = provas.find(p => p.id === id);
  if (!provaEmEdicao) return;
  selecaoProvaAtual = new Set(provaEmEdicao.questoesIds || []);
  document.getElementById('bmf-prova-montar-titulo').textContent = `Montar Prova — ${provaEmEdicao.nome} (${nomeCategoria(provaEmEdicao.categoriaId)})`;
  document.getElementById('bmf-prova-busca').value = '';
  document.getElementById('bmf-prova-qtd-input').value = '';
  document.getElementById('bmf-prova-erro').classList.add('hidden');
  document.getElementById('bmf-modal-prova-montar').classList.add('active');
  document.getElementById('bmf-prova-questoes-lista').innerHTML = '<p class="bmf-empty" style="padding:1.5rem;">Carregando questões…</p>';
  try {
    await carregarQuestoesDaCategoria(provaEmEdicao.categoriaId);
  } catch (err) {
    questoesProvaAtual = [];
  }
  renderListaSelecaoQuestoes();
}

// "Todas" / "aleatórias" agem só sobre o que está visível no momento (já
// filtrado pela busca) — selecionar tudo não deve alcançar o que a busca escondeu.
function selecionarTodasVisiveis(marcar) {
  document.querySelectorAll('#bmf-prova-questoes-lista .bmf-prova-q-check').forEach(chk => {
    chk.checked = marcar;
    if (marcar) selecaoProvaAtual.add(chk.value);
    else selecaoProvaAtual.delete(chk.value);
  });
}

function selecionarQuantidadeAleatoria(qtd) {
  const checks = [...document.querySelectorAll('#bmf-prova-questoes-lista .bmf-prova-q-check')];
  checks.forEach(chk => { chk.checked = false; selecaoProvaAtual.delete(chk.value); });
  const embaralhadas = checks
    .map(chk => ({ chk, ordem: Math.random() }))
    .sort((a, b) => a.ordem - b.ordem)
    .map(x => x.chk);
  embaralhadas.slice(0, qtd).forEach(chk => { chk.checked = true; selecaoProvaAtual.add(chk.value); });
}

function fecharModalMontarProva() {
  document.getElementById('bmf-modal-prova-montar').classList.remove('active');
  provaEmEdicao = null;
  selecaoProvaAtual = new Set();
}

function questoesIdsSelecionadas() {
  return [...selecaoProvaAtual];
}

async function salvarSelecaoProva() {
  const erroEl = document.getElementById('bmf-prova-erro');
  erroEl.classList.add('hidden');
  try {
    const questoesIds = questoesIdsSelecionadas();
    await apiFetch(`/banco-med-fatec/provas/${provaEmEdicao.id}`, {
      method: 'PUT',
      body: JSON.stringify({ nome: provaEmEdicao.nome, categoriaId: provaEmEdicao.categoriaId, questoesIds })
    });
    provaEmEdicao.questoesIds = questoesIds;
    await carregarTudo();
    alert('Seleção salva!');
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

async function exportarProva() {
  const erroEl = document.getElementById('bmf-prova-erro');
  erroEl.classList.add('hidden');
  try {
    await salvarSelecaoProvaSilencioso();
    await apiDownload(`/banco-med-fatec/provas/${provaEmEdicao.id}/exportar`);
    await carregarTudo();
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

async function salvarSelecaoProvaSilencioso() {
  const questoesIds = questoesIdsSelecionadas();
  await apiFetch(`/banco-med-fatec/provas/${provaEmEdicao.id}`, {
    method: 'PUT',
    body: JSON.stringify({ nome: provaEmEdicao.nome, categoriaId: provaEmEdicao.categoriaId, questoesIds })
  });
  provaEmEdicao.questoesIds = questoesIds;
}

async function excluirProva() {
  if (!provaEmEdicao) return;
  const ok = await excluirProvaPorId(provaEmEdicao.id, provaEmEdicao.nome);
  if (ok) fecharModalMontarProva();
}

// Usado tanto pelo botão "Excluir Prova" dentro do modal "Montar Prova"
// quanto pelo ícone de lixeira direto na linha da prova (não precisa abrir o
// modal só pra apagar uma prova de teste). Devolve true se excluiu de fato.
async function excluirProvaPorId(id, nome) {
  if (!confirm(`Excluir a prova "${nome}"? Isso não afeta as questões do banco.`)) return false;
  try {
    await apiFetch(`/banco-med-fatec/provas/${id}`, { method: 'DELETE' });
    await carregarTudo();
    return true;
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
    return false;
  }
}

// ================================================================
//  IMPORTAÇÃO DO AVA (Moodle XML)
// ================================================================
// Parsing 100% no navegador (DOMParser, nativo) — evita mandar pro
// servidor um arquivo que pode vir gigante (imagem embutida em base64
// dentro do XML costuma pesar muito mais que o resto do arquivo inteiro).
// Só o resultado já normalizado (e a imagem já recomprimida) vai pra API.

function textoDe(el, seletor) {
  const alvo = el.querySelector(seletor);
  return alvo ? alvo.textContent : '';
}

// Tira acento/pontuação/maiúsculas — usado só pra sugerir a disciplina
// mais provável (o professor sempre confirma antes de valer).
function normalizarTexto(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function sugerirCategoria(categoriaSugeridaTexto) {
  const alvo = normalizarTexto(categoriaSugeridaTexto);
  if (!alvo) return null;
  const candidata = categorias.find(c => c.nomeBreve && c.nomeBreve.length >= 3 && alvo.includes(normalizarTexto(c.nomeBreve)));
  return candidata || null;
}

async function extrairImagemDoMoodle(questionEl) {
  const fileEl = questionEl.querySelector('questiontext > file');
  if (!fileEl) return null;
  const nome = fileEl.getAttribute('name') || 'imagem';
  const base64 = (fileEl.textContent || '').trim();
  if (!base64) return null;
  const ext = (nome.split('.').pop() || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${base64}`;
  try {
    const comprimida = await comprimirDataUrl(dataUrl);
    return { nome: nome.replace(/\.[^.]+$/, ''), dataUrl: comprimida };
  } catch (err) {
    console.warn('Não deu pra comprimir imagem importada:', nome, err.message);
    return null;
  }
}

// Remove a <img> que aponta pro @@PLUGINFILE@@ (a imagem já vira o campo
// `imagem` separado do nosso schema, não fica solta dentro do enunciado).
function removerImgPluginfile(html) {
  return (html || '')
    .replace(/<img[^>]*@@PLUGINFILE@@[^>]*>/gi, '')
    .replace(/<p>\s*<\/p>/gi, '') // some o parágrafo que só existia pra segurar a imagem
    .trim();
}

function tagDoMoodle(questionEl, prefixo) {
  const tags = [...questionEl.querySelectorAll('tags > tag > text')].map(t => t.textContent);
  const achada = tags.find(t => t.startsWith(`${prefixo}:`));
  return achada ? achada.slice(prefixo.length + 1) : '';
}

const DIFICULDADE_POR_LABEL = { 'Fácil': 'facil', 'Média': 'media', 'Intermediária': 'intermediaria', 'Difícil': 'dificil' };

async function questaoMoodleParaSchema(questionEl) {
  const tipo = questionEl.getAttribute('type');
  const titulo = textoDe(questionEl, 'name > text').trim() || '(sem título)';
  const enunciadoBruto = textoDe(questionEl, 'questiontext > text');
  const imagem = await extrairImagemDoMoodle(questionEl);
  const enunciadoHtml = removerImgPluginfile(enunciadoBruto);
  const justificativa = textoDe(questionEl, 'generalfeedback > text').trim();

  // Round-trip: se veio de uma exportação nossa, os tags/rodapé de FONTE já
  // estão no formato que a gente mesmo gera — aproveita em vez de perder.
  const fonteMatch = /<p><em>FONTE:\s*(.*?)<\/em><\/p>\s*$/i.exec(justificativa);
  const fonte = fonteMatch ? fonteMatch[1].trim() : '';
  const justificativaSemFonte = fonteMatch ? justificativa.slice(0, fonteMatch.index).trim() : justificativa;

  const dificuldadeLabel = tagDoMoodle(questionEl, 'dificuldade');
  const dificuldade = DIFICULDADE_POR_LABEL[dificuldadeLabel] || 'media';
  const elaboradoPor = tagDoMoodle(questionEl, 'autor') || 'Importado do AVA';

  const alternativas = [...questionEl.querySelectorAll(':scope > answer')].map(a => {
    const fraction = parseFloat(a.getAttribute('fraction') || '0');
    const textoAlt = document.createElement('div');
    textoAlt.innerHTML = textoDe(a, 'text');
    return { texto: textoAlt.textContent.trim(), correta: fraction > 0 };
  });

  let tipoMoodle;
  if (tipo === 'truefalse') {
    tipoMoodle = 'verdadeiro_falso';
  } else if (tipo === 'multichoiceset') {
    tipoMoodle = 'multichoice_multipla';
  } else {
    tipoMoodle = 'multichoice_unica';
  }

  // truefalse do Moodle vem como respostas "true"/"false" — normaliza pro
  // texto Verdadeiro/Falso que o resto do app espera pra esse tipo.
  const alternativasFinal = tipoMoodle === 'verdadeiro_falso'
    ? alternativas.map(a => ({ texto: a.texto === 'true' ? 'Verdadeiro' : 'Falso', correta: a.correta }))
    : alternativas;

  return {
    titulo,
    enunciadoHtml,
    imagem,
    justificativa: justificativaSemFonte,
    fonte,
    dificuldade,
    elaboradoPor,
    tipoMoodle,
    alternativas: alternativasFinal
  };
}

// Um arquivo do Moodle pode trazer só uma disciplina (uma categoria) ou
// várias de uma vez (quando exportado com "incluir subcategorias" a partir
// de um contexto compartilhado) — nesse caso, cada troca de categoria vem
// marcada por um <question type="category"> no meio do arquivo, e tudo que
// vem depois dela pertence a essa categoria até a próxima marca aparecer.
// Por isso devolvemos uma LISTA de grupos, um por categoria encontrada,
// cada um virando seu próprio lote de revisão — nunca misturamos disciplinas
// diferentes num só lote.
async function parseMoodleXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Arquivo XML inválido ou corrompido.');

  const todasQuestoes = [...doc.querySelectorAll('quiz > question')];
  const grupos = [];
  let grupoAtual = null;

  for (const qEl of todasQuestoes) {
    const tipo = qEl.getAttribute('type');

    if (tipo === 'category') {
      const bruto = textoDe(qEl, 'category > text');
      const caminho = bruto.replace(/^\$module\$\/top\//, '').replace(/^\$course\$\/top\//, '').replace(/^\$system\$\/top\//, '').trim();
      // Só o último pedaço do caminho (a subcategoria/disciplina em si, não
      // a árvore inteira) — ex: "Medicina/OPT. I - 6927" vira "OPT. I - 6927".
      const nomeCurto = caminho.split('/').filter(Boolean).pop() || caminho;
      grupoAtual = { categoriaSugeridaTexto: nomeCurto, questoes: [] };
      grupos.push(grupoAtual);
      continue;
    }

    if (!TIPOS_MOODLE_SUPORTADOS.includes(tipo)) continue;
    if (!grupoAtual) {
      grupoAtual = { categoriaSugeridaTexto: '', questoes: [] };
      grupos.push(grupoAtual);
    }
    grupoAtual.questoes.push(await questaoMoodleParaSchema(qEl));
  }

  // Categorias "pai" que não tinham nenhuma questão direta (só existiam pra
  // organizar as subcategorias) não viram lote vazio.
  return grupos.filter(g => g.questoes.length > 0);
}

const TIPOS_MOODLE_SUPORTADOS = ['multichoice', 'multichoiceset', 'truefalse'];

async function importarArquivosAva(fileList) {
  const arquivos = [...fileList];
  if (!arquivos.length) return;

  const resumo = [];
  for (const file of arquivos) {
    try {
      const texto = await file.text();
      const grupos = await parseMoodleXml(texto);
      if (!grupos.length) {
        resumo.push(`${file.name}: nenhuma questão de tipo suportado encontrada.`);
        continue;
      }

      // Um arquivo pode trazer mais de uma disciplina (exportação com
      // subcategorias) — cada categoria encontrada vira seu próprio lote,
      // sem misturar questões de disciplinas diferentes.
      for (const grupo of grupos) {
        const resp = await apiFetch('/banco-med-fatec/questoes/importar-lote', {
          method: 'POST',
          body: JSON.stringify({ categoriaSugeridaTexto: grupo.categoriaSugeridaTexto, questoes: grupo.questoes })
        });
        const rotulo = grupo.categoriaSugeridaTexto ? `"${grupo.categoriaSugeridaTexto}"` : '(sem categoria)';
        let linha = `${file.name} — ${rotulo}: ${resp.criadas} questão(ões) importada(s)`;
        if (resp.duplicadas && resp.duplicadas.length) linha += `, ${resp.duplicadas.length} já existente(s) no banco (ignorada(s))`;
        if (resp.erros && resp.erros.length) linha += `, ${resp.erros.length} com erro (ver console)`;
        if (resp.duplicadas && resp.duplicadas.length) console.info(`Duplicatas ignoradas em ${file.name} / ${rotulo}:`, resp.duplicadas);
        if (resp.erros && resp.erros.length) console.warn(`Erros ao importar ${file.name} / ${rotulo}:`, resp.erros);
        resumo.push(linha);
      }
    } catch (err) {
      resumo.push(`${file.name}: falhou — ${err.message}`);
    }
  }

  alert(`Importação concluída:\n\n${resumo.join('\n')}\n\nConfira a aba "Revisão de Importação" pra confirmar a disciplina de cada lote.`);
  await carregarTudo();
  document.querySelector('.bmf-tab-btn[data-tab="revisao"]')?.click();
}

// ================================================================
//  RENDER: REVISÃO DE IMPORTAÇÃO
// ================================================================
function lotesPendentes() {
  const porLote = new Map();
  questoesRevisao.forEach(q => {
    if (!porLote.has(q.loteId)) porLote.set(q.loteId, { loteId: q.loteId, categoriaSugeridaTexto: q.categoriaSugeridaTexto, questoes: [] });
    porLote.get(q.loteId).questoes.push(q);
  });
  return [...porLote.values()];
}

function renderRevisao() {
  const lotes = lotesPendentes();
  const lista = document.getElementById('bmf-revisao-lista');
  const vazio = document.getElementById('bmf-revisao-vazio');
  const badge = document.getElementById('bmf-revisao-badge');

  badge.classList.toggle('hidden', lotes.length === 0);
  badge.textContent = String(lotes.length);
  vazio.classList.toggle('hidden', lotes.length > 0);
  lista.innerHTML = '';

  lotes.forEach(lote => {
    const grupo = document.createElement('div');
    grupo.className = 'bmf-revisao-grupo';
    const sugestao = sugerirCategoria(lote.categoriaSugeridaTexto);
    grupo.innerHTML = `
      <div class="bmf-revisao-cabecalho">
        <h4>${lote.questoes.length} questão(ões) importada(s)</h4>
        <p class="bmf-q-meta">Vieram do arquivo do AVA como <strong>"${esc(lote.categoriaSugeridaTexto || '(sem categoria identificada)')}"</strong></p>
      </div>

      <div class="bmf-revisao-lista-titulos">
        ${lote.questoes.map((q, i) => `<div>${i + 1}. ${esc(q.titulo)}</div>`).join('')}
      </div>

      <div class="bmf-revisao-instrucao">
        <strong>1.</strong> Confira/ajuste a disciplina abaixo (${sugestao ? 'já veio sugerida com base no nome do arquivo' : 'não consegui adivinhar, selecione manualmente'}).
        <strong>2.</strong> Clique em "Confirmar Disciplina" — só depois disso as questões entram no banco compartilhado.
      </div>

      <div class="bmf-revisao-acoes">
        <div>
          <label class="form-label" style="font-size:0.75rem;">Período</label>
          <select class="form-control bmf-revisao-periodo"><option value="">Período</option></select>
        </div>
        <div>
          <label class="form-label" style="font-size:0.75rem;">Disciplina</label>
          <select class="form-control bmf-revisao-categoria"><option value="">Selecione o período primeiro</option></select>
        </div>
        <button type="button" class="btn btn-primary bmf-btn-confirmar-lote action-execute">Confirmar Disciplina</button>
      </div>
      <button type="button" class="bmf-revisao-descartar bmf-btn-descartar-lote action-execute">Descartar este lote</button>
    `;
    lista.appendChild(grupo);

    const selPeriodo = grupo.querySelector('.bmf-revisao-periodo');
    const selCategoria = grupo.querySelector('.bmf-revisao-categoria');
    for (let p = 1; p <= 12; p++) {
      const opt = document.createElement('option');
      opt.value = String(p);
      opt.textContent = `${ordinal(p)} Período`;
      selPeriodo.appendChild(opt);
    }
    if (sugestao) {
      selPeriodo.value = String(sugestao.periodo);
      popularDisciplinasEmSelect(selCategoria, sugestao.periodo, sugestao.id);
    }
    selPeriodo.addEventListener('change', () => popularDisciplinasEmSelect(selCategoria, selPeriodo.value));

    grupo.querySelector('.bmf-btn-confirmar-lote').addEventListener('click', async () => {
      const categoriaId = selCategoria.value;
      if (!categoriaId) { alert('Selecione a disciplina antes de confirmar.'); return; }
      try {
        await apiFetch(`/banco-med-fatec/questoes/lote/${lote.loteId}/resolver`, {
          method: 'PUT',
          body: JSON.stringify({ categoriaId })
        });
        await carregarTudo();
      } catch (err) {
        alert('Erro ao confirmar: ' + err.message);
      }
    });

    grupo.querySelector('.bmf-btn-descartar-lote').addEventListener('click', async () => {
      if (!confirm(`Descartar as ${lote.questoes.length} questões deste lote? Essa ação não pode ser desfeita.`)) return;
      try {
        await apiFetch(`/banco-med-fatec/questoes/lote/${lote.loteId}`, { method: 'DELETE' });
        await carregarTudo();
      } catch (err) {
        alert('Erro ao descartar: ' + err.message);
      }
    });
  });
}

// Igual a popularDisciplinasDoPeriodo, mas recebendo o <select> direto (os
// cards de revisão são criados dinamicamente, sem id fixo por elemento).
function popularDisciplinasEmSelect(sel, periodo, valorParaSelecionar) {
  sel.innerHTML = '';
  if (!periodo) { sel.innerHTML = '<option value="">Selecione o período primeiro</option>'; return; }
  const daPeriodo = categorias.filter(c => String(c.periodo) === String(periodo));
  if (!daPeriodo.length) { sel.innerHTML = '<option value="" disabled selected>Nenhuma disciplina cadastrada neste período</option>'; return; }
  daPeriodo.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
    sel.appendChild(opt);
  });
  if (valorParaSelecionar && daPeriodo.some(c => c.id === valorParaSelecionar)) sel.value = valorParaSelecionar;
}

// ================================================================
//  EVENTOS
// ================================================================
// Fecha o modal aberto no momento com a tecla Esc — mapeia cada overlay pro
// fechamento certo (alguns limpam estado, tipo provaEmEdicao/imagemAtual).
function fecharModalAtivoComEsc() {
  const mapa = [
    ['bmf-modal-questao', fecharModalQuestao],
    ['bmf-modal-prova-novo', fecharModalNovaProva],
    ['bmf-modal-prova-montar', fecharModalMontarProva],
    ['bmf-modal-adicionar-prova', fecharModalAdicionarProva]
  ];
  for (const [id, fechar] of mapa) {
    const modal = document.getElementById(id);
    if (modal && modal.classList.contains('active')) { fechar(); return; }
  }
}

function bindEventos() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharModalAtivoComEsc();
  });

  document.querySelectorAll('.bmf-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bmf-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('bmf-view-banco').classList.toggle('hidden', tab !== 'banco');
      document.getElementById('bmf-view-provas').classList.toggle('hidden', tab !== 'provas');
      document.getElementById('bmf-view-revisao').classList.toggle('hidden', tab !== 'revisao');
    });
  });

  document.getElementById('bmf-filtro-periodo').addEventListener('change', async () => {
    popularSelectsCategoria();
    const grid = document.getElementById('bmf-questoes-grid');
    grid.innerHTML = '<p class="bmf-empty">Carregando…</p>';
    await carregarQuestoesDoPeriodo(document.getElementById('bmf-filtro-periodo').value);
    renderQuestoes();
  });
  document.getElementById('bmf-filtro-categoria').addEventListener('change', renderQuestoes);
  document.getElementById('bmf-filtro-dificuldade').addEventListener('change', renderQuestoes);
  document.getElementById('bmf-filtro-busca').addEventListener('input', renderQuestoes);

  document.getElementById('bmf-btn-nova-questao').addEventListener('click', () => abrirModalQuestao(null));
  document.getElementById('bmf-btn-importar-ava').addEventListener('click', () => {
    document.getElementById('bmf-importar-ava-input').click();
  });
  document.getElementById('bmf-importar-ava-input').addEventListener('change', async (e) => {
    const arquivos = e.target.files;
    if (!arquivos.length) return;
    const btn = document.getElementById('bmf-btn-importar-ava');
    btn.disabled = true;
    btn.textContent = 'Importando...';
    try {
      await importarArquivosAva(arquivos);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬆ Importar do AVA';
      e.target.value = '';
    }
  });
  document.getElementById('bmf-btn-cancelar-questao').addEventListener('click', fecharModalQuestao);
  document.getElementById('bmf-form-questao').addEventListener('submit', salvarQuestao);
  document.getElementById('bmf-q-periodo').addEventListener('change', (e) => {
    popularDisciplinasDoPeriodo('bmf-q-categoria', e.target.value);
  });
  document.getElementById('bmf-p-periodo').addEventListener('change', (e) => {
    popularDisciplinasDoPeriodo('bmf-p-categoria', e.target.value);
  });
  document.getElementById('bmf-q-tipo').addEventListener('change', ajustarEditorPorTipo);
  document.getElementById('bmf-btn-add-alternativa').addEventListener('click', () => {
    const tipoRadio = document.getElementById('bmf-q-tipo').value === 'multichoice_unica';
    document.getElementById('bmf-alternativas-lista').appendChild(novaLinhaAlternativa('', false, tipoRadio));
  });

  document.getElementById('bmf-btn-add-categoria').addEventListener('click', () => {
    document.getElementById('bmf-nova-categoria-group').classList.toggle('hidden');
  });
  document.getElementById('bmf-btn-cancelar-categoria').addEventListener('click', () => {
    document.getElementById('bmf-nova-categoria-group').classList.add('hidden');
  });
  document.getElementById('bmf-btn-salvar-categoria').addEventListener('click', async () => {
    const nome = document.getElementById('bmf-q-categoria-nova').value.trim();
    const periodo = parseInt(document.getElementById('bmf-q-categoria-nova-periodo').value, 10);
    if (!nome) return;
    if (!periodo) { alert('Selecione o período da disciplina.'); return; }
    try {
      const resp = await apiFetch('/banco-med-fatec/categorias', { method: 'POST', body: JSON.stringify({ nome, periodo }) });
      categorias.push({ id: resp.id, nome, periodo });
      popularSelectsCategoria();
      // A disciplina nova nasce no período que acabou de ser escolhido —
      // reflete isso no seletor de período/disciplina do formulário da questão.
      document.getElementById('bmf-q-periodo').value = String(periodo);
      popularDisciplinasDoPeriodo('bmf-q-categoria', periodo, resp.id);
      document.getElementById('bmf-q-categoria-nova').value = '';
      document.getElementById('bmf-q-categoria-nova-periodo').value = '';
      document.getElementById('bmf-nova-categoria-group').classList.add('hidden');
    } catch (err) {
      alert('Erro ao criar disciplina: ' + err.message);
    }
  });

  document.getElementById('bmf-q-imagem-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await comprimirImagem(file);
      imagemAtual = { nome: file.name.replace(/\.[^.]+$/, ''), dataUrl };
      document.getElementById('bmf-q-imagem-img').src = dataUrl;
      document.getElementById('bmf-q-imagem-preview').classList.remove('hidden');
      document.getElementById('bmf-q-imagem-nome').textContent = file.name;
    } catch (err) {
      alert('Erro ao processar imagem: ' + err.message);
    }
  });
  document.getElementById('bmf-btn-remover-imagem').addEventListener('click', () => {
    imagemAtual = null;
    document.getElementById('bmf-q-imagem-input').value = '';
    document.getElementById('bmf-q-imagem-preview').classList.add('hidden');
    document.getElementById('bmf-q-imagem-nome').textContent = 'Escolher imagem…';
  });

  document.getElementById('bmf-prova-filtro-periodo').addEventListener('change', renderProvas);
  document.getElementById('bmf-btn-nova-prova').addEventListener('click', () => abrirModalNovaProva());
  document.getElementById('bmf-btn-limpar-selecao').addEventListener('click', () => {
    questoesSelecionadas.clear();
    renderQuestoes();
  });
  document.getElementById('bmf-btn-adicionar-prova').addEventListener('click', abrirModalAdicionarProva);
  document.getElementById('bmf-btn-fechar-adicionar-prova').addEventListener('click', fecharModalAdicionarProva);
  document.getElementById('bmf-btn-cancelar-prova-novo').addEventListener('click', fecharModalNovaProva);
  document.getElementById('bmf-form-prova-novo').addEventListener('submit', criarProva);

  document.getElementById('bmf-prova-busca').addEventListener('input', renderListaSelecaoQuestoes);
  document.getElementById('bmf-prova-selecionar-todas').addEventListener('click', () => selecionarTodasVisiveis(true));
  document.getElementById('bmf-prova-desmarcar-todas').addEventListener('click', () => selecionarTodasVisiveis(false));
  document.getElementById('bmf-prova-selecionar-qtd').addEventListener('click', () => {
    const qtd = parseInt(document.getElementById('bmf-prova-qtd-input').value, 10);
    if (!qtd || qtd < 1) { alert('Informe uma quantidade válida.'); return; }
    selecionarQuantidadeAleatoria(qtd);
  });
  document.getElementById('bmf-btn-fechar-montar').addEventListener('click', fecharModalMontarProva);
  document.getElementById('bmf-btn-salvar-selecao').addEventListener('click', salvarSelecaoProva);
  document.getElementById('bmf-btn-exportar-prova').addEventListener('click', exportarProva);
  document.getElementById('bmf-btn-excluir-prova').addEventListener('click', excluirProva);
}

// ================================================================
//  AUTH GUARD (mesmo padrão dos demais módulos do Órbita)
// ================================================================
let appInitialized = false;
let initializedRole = null;

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  const guard = document.getElementById('auth-guard');
  if (guard) guard.classList.add('hidden');

  setupLayout(user, role, 'banco-med-fatec', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  bindEventos();
  popularSelectsPeriodo();
  ajustarEditorPorTipo();
  await carregarTudo();
}

const cached = getCachedAuth();
if (cached) {
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

  let role = 'visitante';
  let meuOverrides = null;
  try {
    const userData = await apiFetch('/usuarios/me');
    role = userData.role || 'visitante';
    meuOverrides = userData.permissoes || null;
  } catch (err) {
    role = cached ? cached.role : 'visitante';
  }

  let userLevel = 1;
  try {
    const allPerms = await apiFetch('/usuarios/config/permissions');
    userLevel = getEffectiveLevel(allPerms[role] || {}, meuOverrides, 'banco-med-fatec');
  } catch (err) {
    // Falha silenciosa por segurança — sem permissão confirmada, não libera.
  }

  const token = await user.getIdToken();
  setCachedAuth(user, role, token);

  if (role !== 'adm_l1' && userLevel < 2) {
    window.location.href = '../meu-espaco/index.html';
    return;
  }
  if (role !== 'adm_l1' && userLevel < 3) {
    document.body.classList.add('hide-execute');
  }

  if (!appInitialized || initializedRole !== role) {
    initApp(user, role);
  }
});
