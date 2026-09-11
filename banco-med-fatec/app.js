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
function comprimirImagem(file) {
  const tentativas = [
    { dim: 1600, q: 0.85 },
    { dim: 1400, q: 0.72 },
    { dim: 1200, q: 0.62 },
    { dim: 1000, q: 0.52 },
    { dim: 800, q: 0.45 }
  ];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        for (const t of tentativas) {
          const scale = Math.min(1, t.dim / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', t.q);
          if (dataUrl.length <= LIMITE_BASE64) return resolve(dataUrl);
        }
        reject(new Error('Imagem grande demais mesmo após compressão.'));
      };
      img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

// ---- Estado local ----
let categorias = [];
let questoes = [];
let provas = [];
let imagemAtual = null; // { nome, dataUrl } | null
let provaEmEdicao = null; // prova sendo montada no modal

const DIFICULDADE_LABEL = { facil: 'Fácil', media: 'Média', intermediaria: 'Intermediária', dificil: 'Difícil' };
const TIPO_LABEL = {
  multichoice_unica: 'Múltipla escolha (uma correta)',
  multichoice_multipla: 'Múltipla escolha (várias corretas)',
  verdadeiro_falso: 'Verdadeiro/Falso'
};

function nomeCategoria(id) {
  const c = categorias.find(c => c.id === id);
  if (!c) return '—';
  return `${c.periodo}º Período · ${c.nome}${c.nomeBreve ? ` (${c.nomeBreve})` : ''}`;
}

// ================================================================
//  CARREGAMENTO DE DADOS
// ================================================================
async function carregarTudo() {
  try {
    [categorias, questoes, provas] = await Promise.all([
      apiFetch('/banco-med-fatec/categorias'),
      apiFetch('/banco-med-fatec/questoes'),
      apiFetch('/banco-med-fatec/provas')
    ]);
    popularSelectsCategoria();
    renderQuestoes();
    renderProvas();
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
      opt.textContent = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
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
  const periodo = document.getElementById('bmf-filtro-periodo').value;
  const cat = document.getElementById('bmf-filtro-categoria').value;
  const dif = document.getElementById('bmf-filtro-dificuldade').value;
  const busca = document.getElementById('bmf-filtro-busca').value.trim().toLowerCase();

  return questoes.filter(q => {
    if (periodo && String(nomeCategoriaObj(q.categoriaId)?.periodo) !== periodo) return false;
    if (cat && q.categoriaId !== cat) return false;
    if (dif && q.dificuldade !== dif) return false;
    if (busca && !(`${q.titulo} ${q.elaboradoPor}`.toLowerCase().includes(busca))) return false;
    return true;
  });
}

function nomeCategoriaObj(id) {
  return categorias.find(c => c.id === id);
}

function renderQuestoes() {
  const grid = document.getElementById('bmf-questoes-grid');
  const vazio = document.getElementById('bmf-questoes-vazio');
  const lista = questoesFiltradas();

  grid.innerHTML = '';
  vazio.classList.toggle('hidden', lista.length > 0);

  lista.forEach(q => {
    const card = document.createElement('div');
    card.className = 'bmf-q-card';
    card.innerHTML = `
      <div class="bmf-q-card-top">
        <span class="bmf-badge bmf-badge-${q.dificuldade}">${DIFICULDADE_LABEL[q.dificuldade] || q.dificuldade}</span>
        <span class="bmf-badge bmf-badge-tipo">${q.imagem ? '🖼️ ' : ''}${TIPO_LABEL[q.tipoMoodle] || q.tipoMoodle}</span>
      </div>
      <h4>${esc(q.titulo)}</h4>
      <p class="bmf-q-meta">${esc(nomeCategoria(q.categoriaId))} · por ${esc(q.elaboradoPor || '—')}</p>
      <p class="bmf-q-snippet">${esc((q.enunciadoHtml || '').replace(/<[^>]+>/g, '').slice(0, 140))}...</p>
      <div class="bmf-q-actions">
        <button class="btn btn-secondary bmf-btn-editar-questao action-execute" data-id="${q.id}">Editar</button>
        <button class="btn btn-secondary bmf-btn-excluir-questao action-execute" data-id="${q.id}" style="color:#EF4444;">Excluir</button>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.bmf-btn-editar-questao').forEach(btn => {
    btn.addEventListener('click', () => abrirModalQuestao(btn.dataset.id));
  });
  grid.querySelectorAll('.bmf-btn-excluir-questao').forEach(btn => {
    btn.addEventListener('click', () => excluirQuestao(btn.dataset.id));
  });
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
    const card = document.createElement('div');
    card.className = 'bmf-prova-card';
    const totalExport = (p.exportacoes || []).length;
    card.innerHTML = `
      <div class="bmf-q-card-top">
        ${p.semestre ? `<span class="bmf-badge bmf-badge-tipo">${esc(p.semestre)}</span>` : ''}
      </div>
      <h4>${esc(p.nome)}</h4>
      <p class="bmf-q-meta">${esc(nomeCategoria(p.categoriaId))}</p>
      <p class="bmf-q-meta">${(p.questoesIds || []).length} questão(ões) selecionada(s)</p>
      ${totalExport ? `<p class="bmf-q-meta">Exportada ${totalExport}x — última em ${new Date(p.exportacoes[totalExport - 1].em).toLocaleString('pt-BR')}</p>` : ''}
      <div class="bmf-q-actions">
        <button class="btn btn-primary bmf-btn-montar-prova action-execute" data-id="${p.id}" style="flex:1;">Montar / Exportar</button>
      </div>
    `;
    grid.appendChild(card);
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
    <button type="button" class="btn btn-secondary bmf-alt-remover" style="width:36px; flex-shrink:0;">✕</button>
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
  renderAlternativasEditor([{ texto: '', correta: false }, { texto: '', correta: false }], 'multichoice_unica');
}

function abrirModalQuestao(id) {
  limparFormQuestao();
  const modal = document.getElementById('bmf-modal-questao');
  const titulo = document.getElementById('bmf-questao-modal-titulo');

  if (id) {
    const q = questoes.find(q => q.id === id);
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
function abrirModalNovaProva() {
  if (categorias.length === 0) {
    alert('Ainda não há nenhuma disciplina cadastrada. Cadastre uma disciplina primeiro pela aba "Banco de Questões" (botão "+ Nova Questão" → "+" ao lado de Disciplina).');
    return;
  }
  document.getElementById('bmf-form-prova-novo').reset();
  popularDisciplinasDoPeriodo('bmf-p-categoria', '');
  document.getElementById('bmf-modal-prova-novo').classList.add('active');
}
function fecharModalNovaProva() {
  document.getElementById('bmf-modal-prova-novo').classList.remove('active');
}

async function criarProva(e) {
  e.preventDefault();
  try {
    await apiFetch('/banco-med-fatec/provas', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('bmf-p-nome').value.trim(),
        semestre: document.getElementById('bmf-p-semestre').value.trim(),
        categoriaId: document.getElementById('bmf-p-categoria').value,
        questoesIds: []
      })
    });
    fecharModalNovaProva();
    await carregarTudo();
  } catch (err) {
    alert('Erro ao criar prova: ' + err.message);
  }
}

// ================================================================
//  MODAL: MONTAR / EXPORTAR PROVA
// ================================================================
function renderListaSelecaoQuestoes() {
  const busca = document.getElementById('bmf-prova-busca').value.trim().toLowerCase();
  const lista = document.getElementById('bmf-prova-questoes-lista');
  lista.innerHTML = '';

  // Só mostra questões da MESMA disciplina da prova — cada prova pertence a
  // uma disciplina só, então misturar questões de outras disciplinas aqui
  // não fazia sentido (era a confusão relatada sobre a categoria/disciplina).
  const daDisciplina = questoes.filter(q => q.categoriaId === provaEmEdicao.categoriaId);
  const disponiveis = daDisciplina.filter(q => !busca || q.titulo.toLowerCase().includes(busca));
  const selecionadas = new Set(provaEmEdicao.questoesIds || []);

  if (!daDisciplina.length) {
    lista.innerHTML = `<p class="bmf-empty" style="padding:1.5rem;">Ainda não há questões cadastradas em "${esc(nomeCategoria(provaEmEdicao.categoriaId))}". Cadastre questões dessa disciplina na aba Banco de Questões.</p>`;
    return;
  }

  disponiveis.forEach(q => {
    const linha = document.createElement('label');
    linha.className = 'bmf-prova-q-linha';
    linha.innerHTML = `
      <input type="checkbox" class="bmf-prova-q-check" value="${q.id}" ${selecionadas.has(q.id) ? 'checked' : ''}>
      <span class="bmf-badge bmf-badge-${q.dificuldade}">${DIFICULDADE_LABEL[q.dificuldade]}</span>
      <span class="bmf-prova-q-titulo">${esc(q.titulo)}</span>
    `;
    lista.appendChild(linha);
  });
}

function abrirModalMontarProva(id) {
  provaEmEdicao = provas.find(p => p.id === id);
  if (!provaEmEdicao) return;
  document.getElementById('bmf-prova-montar-titulo').textContent = `Montar Prova — ${provaEmEdicao.nome} (${nomeCategoria(provaEmEdicao.categoriaId)})`;
  document.getElementById('bmf-prova-busca').value = '';
  document.getElementById('bmf-prova-erro').classList.add('hidden');
  renderListaSelecaoQuestoes();
  document.getElementById('bmf-modal-prova-montar').classList.add('active');
}

function fecharModalMontarProva() {
  document.getElementById('bmf-modal-prova-montar').classList.remove('active');
  provaEmEdicao = null;
}

function questoesIdsSelecionadas() {
  return [...document.querySelectorAll('.bmf-prova-q-check:checked')].map(chk => chk.value);
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
  if (!confirm(`Excluir a prova "${provaEmEdicao.nome}"? Isso não afeta as questões do banco.`)) return;
  try {
    await apiFetch(`/banco-med-fatec/provas/${provaEmEdicao.id}`, { method: 'DELETE' });
    fecharModalMontarProva();
    await carregarTudo();
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
  }
}

// ================================================================
//  EVENTOS
// ================================================================
function bindEventos() {
  document.querySelectorAll('.bmf-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bmf-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('bmf-view-banco').classList.toggle('hidden', tab !== 'banco');
      document.getElementById('bmf-view-provas').classList.toggle('hidden', tab !== 'provas');
    });
  });

  document.getElementById('bmf-filtro-periodo').addEventListener('change', () => { popularSelectsCategoria(); renderQuestoes(); });
  document.getElementById('bmf-filtro-categoria').addEventListener('change', renderQuestoes);
  document.getElementById('bmf-filtro-dificuldade').addEventListener('change', renderQuestoes);
  document.getElementById('bmf-filtro-busca').addEventListener('input', renderQuestoes);

  document.getElementById('bmf-btn-nova-questao').addEventListener('click', () => abrirModalQuestao(null));
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
    } catch (err) {
      alert('Erro ao processar imagem: ' + err.message);
    }
  });
  document.getElementById('bmf-btn-remover-imagem').addEventListener('click', () => {
    imagemAtual = null;
    document.getElementById('bmf-q-imagem-input').value = '';
    document.getElementById('bmf-q-imagem-preview').classList.add('hidden');
  });

  document.getElementById('bmf-prova-filtro-periodo').addEventListener('change', renderProvas);
  document.getElementById('bmf-btn-nova-prova').addEventListener('click', abrirModalNovaProva);
  document.getElementById('bmf-btn-cancelar-prova-novo').addEventListener('click', fecharModalNovaProva);
  document.getElementById('bmf-form-prova-novo').addEventListener('submit', criarProva);

  document.getElementById('bmf-prova-busca').addEventListener('input', renderListaSelecaoQuestoes);
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
