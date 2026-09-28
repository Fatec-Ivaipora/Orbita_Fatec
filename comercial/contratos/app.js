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

// Nível padrão do módulo quando config/permissions ainda não tem a chave
// `contratos` pro cargo (mesmo valor do defaultPermissions do backend).
const NIVEL_PADRAO = { adm_l2: 3, comercial: 3 };

const STATUS_LABEL = { sem_assinatura: 'Sem assinatura', assinado: 'Assinado', desistente: 'Desistente' };

let currentUser = null;
let appInitialized = false;
let initializedRole = null;

let registros = [];
let semestreAtual = '';
let abaAtual = 'sem_assinatura';
let emEdicaoId = null;
let contatoId = null;

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

async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await apiFetch(endpoint);
    } catch (err) {
      if (i === tentativas) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
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

// Datas guardadas como 'AAAA-MM-DD' — formata sem passar por Date pra não
// cair um dia por causa do fuso.
function fmtData(s) {
  if (!s) return '';
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}

function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function linkWhatsapp(contato) {
  const dig = (contato || '').replace(/\D/g, '');
  if (dig.length < 10) return null;
  return `https://wa.me/${dig.length <= 11 ? '55' + dig : dig}`;
}

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO
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
        const semConfig = doCargo.contratos === undefined && !(meuOverrides && meuOverrides.contratos !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, 'contratos');
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

  setupLayout(user, role, 'contratos', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  montarSemestres();
  wireEventos();
}

// Semestres de um ano atrás até o ano que vem (a matrícula do 1º semestre
// começa no 2º semestre do ano anterior — ex.: planilha "2027.1" em ago/2026).
function montarSemestres() {
  const sel = document.getElementById('sel-semestre');
  const ano = new Date().getFullYear();
  const opcoes = [];
  for (let a = ano + 1; a >= ano - 1; a--) opcoes.push(`${a}.2`, `${a}.1`);
  sel.innerHTML = '<option value="">Selecione o semestre...</option>' +
    opcoes.map(s => `<option value="${s}">${s}</option>`).join('');
}

function wireEventos() {
  // Só busca depois que a pessoa escolhe o semestre (economia de leitura).
  document.getElementById('sel-semestre').addEventListener('change', (e) => {
    semestreAtual = e.target.value;
    document.getElementById('btn-novo').disabled = !semestreAtual;
    document.getElementById('btn-imprimir').classList.toggle('hidden', !semestreAtual);
    if (semestreAtual) carregar();
    else {
      document.getElementById('conteudo').classList.add('hidden');
      document.getElementById('msg-inicial').classList.remove('hidden');
    }
  });

  document.querySelectorAll('.aba').forEach(btn => btn.addEventListener('click', () => {
    abaAtual = btn.dataset.status;
    document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b === btn));
    renderTudo();
  }));

  ['busca', 'filtro-curso', 'filtro-cidade', 'filtro-menor'].forEach(id => {
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
    document.getElementById('busca').value = '';
    document.getElementById('filtro-curso').value = '';
    document.getElementById('filtro-cidade').value = '';
    document.getElementById('filtro-menor').checked = false;
    renderTudo();
  });

  document.getElementById('btn-novo').addEventListener('click', () => abrirModalAluno(null));
  document.getElementById('btn-imprimir').addEventListener('click', () => imprimirRelatorio([
    `Semestre ${semestreAtual}`,
    STATUS_LABEL[abaAtual],
    opcaoEscolhida('filtro-curso') && `Curso: ${opcaoEscolhida('filtro-curso')}`,
    opcaoEscolhida('filtro-cidade') && `Cidade: ${opcaoEscolhida('filtro-cidade')}`,
    document.getElementById('filtro-menor').checked && 'Só menores de 18',
    document.getElementById('busca').value.trim() && `Busca: "${document.getElementById('busca').value.trim()}"`,
    `${document.querySelectorAll('#tabela-corpo tr:not(.mes-linha):not(:has(.tabela-msg))').length} aluno(s) listados`
  ], currentUser.displayName || currentUser.email));
  document.getElementById('btn-cancelar-aluno').addEventListener('click', () => fecharModal('modal-aluno'));
  document.getElementById('form-aluno').addEventListener('submit', salvarAluno);
  document.getElementById('btn-excluir').addEventListener('click', () => excluirAluno(emEdicaoId));
  document.getElementById('f-status').addEventListener('change', atualizarGrupoAssinado);

  document.getElementById('btn-cancelar-contato').addEventListener('click', () => fecharModal('modal-contato'));
  document.getElementById('form-contato').addEventListener('submit', salvarContato);

  document.getElementById('tabela-corpo').addEventListener('click', (e) => {
    const obs = e.target.closest('[data-historico]');
    if (obs) { abrirModalContato(obs.dataset.historico); return; }
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const id = btn.dataset.id;
    const acao = btn.dataset.acao;
    if (acao === 'editar') abrirModalAluno(id);
    else if (acao === 'excluir') excluirAluno(id);
    else if (acao === 'contato') abrirModalContato(id);
    else mudarStatus(id, acao);
  });
}

async function carregar() {
  document.getElementById('msg-inicial').classList.add('hidden');
  document.getElementById('conteudo').classList.remove('hidden');
  document.getElementById('tabela-corpo').innerHTML = '<tr><td colspan="10" class="tabela-msg">Carregando...</td></tr>';
  try {
    registros = await apiFetch(`/contratos?semestre=${encodeURIComponent(semestreAtual)}`);
    montarFiltros();
    renderTudo();
  } catch (err) {
    document.getElementById('tabela-corpo').innerHTML = `<tr><td colspan="10" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

function valoresUnicos(campo) {
  return [...new Set(registros.map(r => (r[campo] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function montarFiltros() {
  [['filtro-curso', 'curso', 'Todos os cursos', 'lista-cursos'], ['filtro-cidade', 'cidade', 'Todas as cidades', 'lista-cidades']].forEach(([selId, campo, rotulo, listId]) => {
    const sel = document.getElementById(selId);
    const atual = sel.value;
    const vals = valoresUnicos(campo);
    sel.innerHTML = `<option value="">${rotulo}</option>` + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (vals.includes(atual)) sel.value = atual;
    document.getElementById(listId).innerHTML = vals.map(v => `<option value="${esc(v)}">`).join('');
  });
}

// Filtros valem pra tudo na tela (resumo, abas, botões de curso e tabela),
// menos a situação — essa é a aba. `ignorar` tira um filtro da conta (os
// botões de curso contam ignorando o próprio filtro de curso).
function lerFiltros() {
  const busca = document.getElementById('busca').value.trim().toLowerCase();
  return {
    busca,
    buscaDig: busca.replace(/\D/g, ''),
    curso: document.getElementById('filtro-curso').value,
    cidade: document.getElementById('filtro-cidade').value,
    soMenor: document.getElementById('filtro-menor').checked
  };
}

function passaFiltros(r, f, ignorar = '') {
  if (ignorar !== 'curso' && f.curso && (r.curso || '').trim() !== f.curso) return false;
  if (f.cidade && (r.cidade || '').trim() !== f.cidade) return false;
  if (f.soMenor && !r.menor18) return false;
  if (f.busca) {
    const noTexto = `${r.nome} ${r.observacoes} ${r.contato}`.toLowerCase().includes(f.busca);
    const noFone = f.buscaDig.length >= 4 && (r.contato || '').replace(/\D/g, '').includes(f.buscaDig);
    if (!noTexto && !noFone) return false;
  }
  return true;
}

function renderCursos(f) {
  // Contagem por curso dentro da aba atual, respeitando os outros filtros.
  const daAba = registros.filter(r => r.status === abaAtual && passaFiltros(r, f, 'curso'));
  const porCurso = {};
  daAba.forEach(r => { const c = (r.curso || '').trim() || 'SEM CURSO'; porCurso[c] = (porCurso[c] || 0) + 1; });
  const cursos = Object.entries(porCurso).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Curso selecionado que zerou com os outros filtros continua aparecendo (com 0) pra dar pra desmarcar.
  if (f.curso && !porCurso[f.curso]) cursos.push([f.curso, 0]);
  const chip = (valor, rotulo, n) =>
    `<button type="button" class="curso-chip ${f.curso === valor ? 'ativo' : ''}" data-curso="${esc(valor)}">${esc(rotulo)} <span class="curso-chip-qtd">${n}</span></button>`;
  document.getElementById('cursos-bar').innerHTML =
    chip('', 'Todos os cursos', daAba.length) +
    cursos.filter(([c]) => c !== 'SEM CURSO').map(([c, n]) => chip(c, c, n)).join('');

  // Mesma contagem no select de curso.
  const sel = document.getElementById('filtro-curso');
  [...sel.options].forEach(o => {
    if (!o.value) { o.textContent = `Todos os cursos (${daAba.length})`; return; }
    o.textContent = `${o.value} (${porCurso[o.value] || 0})`;
  });
}

function renderTudo() {
  const f = lerFiltros();
  const base = registros.filter(r => passaFiltros(r, f));
  const qtd = (s) => base.filter(r => r.status === s).length;
  const sem = qtd('sem_assinatura'), ass = qtd('assinado'), des = qtd('desistente');
  const total = sem + ass + des;
  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-sem').textContent = sem;
  document.getElementById('kpi-ass').textContent = ass;
  document.getElementById('kpi-des').textContent = des;
  const ativos = sem + ass;
  document.getElementById('kpi-ass-pct').textContent = ativos ? `${Math.round(ass / ativos * 100)}% dos matriculados ativos` : '';
  document.getElementById('kpi-menor').textContent = base.filter(r => r.status === 'sem_assinatura' && r.menor18).length;
  document.getElementById('qtd-sem').textContent = sem;
  document.getElementById('qtd-ass').textContent = ass;
  document.getElementById('qtd-des').textContent = des;

  renderCursos(f);

  const filtrando = !!(f.busca || f.curso || f.cidade || f.soMenor);
  document.getElementById('btn-limpar-filtros').classList.toggle('hidden', !filtrando);
  const partes = [f.curso && `curso ${f.curso}`, f.cidade && `cidade ${f.cidade}`, f.soMenor && 'menores de 18', f.busca && `busca "${f.busca}"`].filter(Boolean);
  const naAba = qtd(abaAtual);
  const totalAba = registros.filter(r => r.status === abaAtual).length;
  document.getElementById('filtro-resumo').innerHTML = filtrando
    ? `Mostrando <strong>${naAba}</strong> de ${totalAba} em ${STATUS_LABEL[abaAtual]} · filtro: ${esc(partes.join(', '))}`
    : '';

  renderTabela(base);
}

function renderTabela(base) {
  const corpo = document.getElementById('tabela-corpo');
  const lista = base.filter(r => r.status === abaAtual);
  if (!lista.length) {
    corpo.innerHTML = `<tr><td colspan="10" class="tabela-msg">${registros.length ? 'Nenhum aluno nessa situação com esses filtros.' : 'Nenhum aluno cadastrado nesse semestre ainda. Use "Novo aluno".'}</td></tr>`;
    return;
  }
  corpo.innerHTML = lista.map((r, i) => {
    const zap = linkWhatsapp(r.contato);
    const obs = r.observacoes || '';
    const linhasObs = obs.split('\n');
    const obsCurta = linhasObs.slice(0, 2).join('\n');
    const temMais = linhasObs.length > 2;
    const contrato = r.status === 'assinado'
      ? `<span class="ct-assinado">✓ ${esc([r.assinadoPor, fmtData(r.assinadoEm)].filter(Boolean).join(' · ') || 'Assinado')}</span>`
      : (r.assinadoPor || r.assinadoEm ? `<span class="ct-sub">${esc([r.assinadoPor, fmtData(r.assinadoEm)].filter(Boolean).join(' · '))}</span>` : '<span class="ct-vazio">—</span>');
    let acoes = `<button class="btn-acao" data-acao="contato" data-id="${r.id}" title="Ver histórico e registrar contato">🕘 Histórico</button>`;
    if (r.status === 'sem_assinatura') {
      acoes += `<button class="btn-acao ok" data-acao="assinado" data-id="${r.id}">✓ Assinou</button>`;
      acoes += `<button class="btn-acao desistir" data-acao="desistente" data-id="${r.id}">Desistiu</button>`;
    } else if (r.status === 'desistente') {
      acoes += `<button class="btn-acao" data-acao="sem_assinatura" data-id="${r.id}">Reativar</button>`;
    }
    acoes += `<button class="btn-acao" data-acao="editar" data-id="${r.id}">Editar</button>`;
    acoes += `<button class="btn-acao desistir" data-acao="excluir" data-id="${r.id}" title="Excluir aluno da lista">🗑</button>`;
    return `
      <tr>
        <td class="ct-sub">${i + 1}</td>
        <td><span class="cm-pessoa">${avatar(r.nome)}<span class="ct-nome">${esc(r.nome)}</span></span>${r.menor18 ? '<span class="ct-menor" title="Menor de 18 — contrato pelo responsável">-18</span>' : ''}</td>
        <td>${fmtData(r.dataMatricula) || '<span class="ct-vazio">—</span>'}</td>
        <td>${esc(r.curso) || '<span class="ct-vazio">—</span>'}</td>
        <td>${esc(r.cidade) || '<span class="ct-vazio">—</span>'}</td>
        <td>${zap ? `<a class="ct-zap" href="${zap}" target="_blank" rel="noopener" title="Abrir no WhatsApp">${esc(r.contato)}</a>` : (esc(r.contato) || '<span class="ct-vazio">—</span>')}</td>
        <td class="ct-obs-link" data-historico="${r.id}" title="Ver histórico completo"><div class="ct-obs">${esc(obsCurta) || '<span class="ct-vazio">—</span>'}</div>${temMais ? `<span class="ct-obs-mais">ver histórico (${linhasObs.length})</span>` : ''}</td>
        <td>${fmtData(r.vencimentoBoleto) || '<span class="ct-vazio">—</span>'}</td>
        <td>${contrato}</td>
        <td class="acoes-col action-execute">${acoes}</td>
      </tr>`;
  }).join('');
}

// ==========================================
// AÇÕES
// ==========================================
function substituir(atualizado) {
  const idx = registros.findIndex(r => r.id === atualizado.id);
  if (idx >= 0) registros[idx] = atualizado; else registros.push(atualizado);
  montarFiltros();
  renderTudo();
}

async function mudarStatus(id, status) {
  const r = registros.find(x => x.id === id);
  if (!r) return;
  if (status === 'desistente' && !confirm(`Mover ${r.nome} para Desistentes?`)) return;
  try {
    const atualizado = await apiFetch(`/contratos/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, hoje: hojeLocal() }) });
    substituir(atualizado);
    showToast(`${r.nome} → ${STATUS_LABEL[status]}`);
  } catch (err) { showToast(err.message, 'error'); }
}

function abrirModal(id) { document.getElementById(id).classList.remove('hidden'); }
function fecharModal(id) { document.getElementById(id).classList.add('hidden'); }

function atualizarGrupoAssinado() {
  document.getElementById('grupo-assinado').classList.toggle('hidden', document.getElementById('f-status').value !== 'assinado');
}

function abrirModalAluno(id) {
  emEdicaoId = id;
  const r = id ? registros.find(x => x.id === id) : null;
  document.getElementById('modal-aluno-titulo').textContent = r ? 'Editar aluno' : 'Novo aluno';
  document.getElementById('modal-aluno-sub').textContent = `Semestre ${semestreAtual}`;
  document.getElementById('modal-ultima-alt').textContent = r && r.updatedBy
    ? `Última alteração: ${r.updatedBy} em ${new Date(r.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : '';
  document.getElementById('f-nome').value = r?.nome || '';
  document.getElementById('f-matricula').value = r?.dataMatricula || (r ? '' : hojeLocal());
  document.getElementById('f-curso').value = r?.curso || '';
  document.getElementById('f-cidade').value = r?.cidade || '';
  document.getElementById('f-contato').value = r?.contato || '';
  document.getElementById('f-boleto').value = r?.vencimentoBoleto || '';
  document.getElementById('f-status').value = r?.status || abaAtual;
  document.getElementById('f-assinado-por').value = r?.assinadoPor || '';
  document.getElementById('f-assinado-em').value = r?.assinadoEm || '';
  document.getElementById('f-menor').checked = !!r?.menor18;
  document.getElementById('f-obs').value = r?.observacoes || '';
  document.getElementById('btn-excluir').classList.toggle('hidden', !r);
  atualizarGrupoAssinado();
  abrirModal('modal-aluno');
  document.getElementById('f-nome').focus();
}

async function salvarAluno(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-salvar-aluno');
  const status = document.getElementById('f-status').value;
  const body = {
    semestre: semestreAtual,
    nome: document.getElementById('f-nome').value,
    dataMatricula: document.getElementById('f-matricula').value,
    curso: document.getElementById('f-curso').value,
    cidade: document.getElementById('f-cidade').value,
    contato: document.getElementById('f-contato').value,
    vencimentoBoleto: document.getElementById('f-boleto').value,
    menor18: document.getElementById('f-menor').checked,
    assinadoPor: document.getElementById('f-assinado-por').value,
    assinadoEm: document.getElementById('f-assinado-em').value,
    observacoes: document.getElementById('f-obs').value,
    status
  };
  btn.disabled = true;
  try {
    let salvo;
    if (emEdicaoId) {
      salvo = await apiFetch(`/contratos/${emEdicaoId}`, { method: 'PUT', body: JSON.stringify(body) });
      const anterior = registros.find(x => x.id === emEdicaoId);
      if (anterior && anterior.status !== status) {
        salvo = await apiFetch(`/contratos/${emEdicaoId}/status`, { method: 'PATCH', body: JSON.stringify({ status, hoje: hojeLocal() }) });
      }
    } else {
      salvo = await apiFetch('/contratos', { method: 'POST', body: JSON.stringify(body) });
    }
    substituir(salvo);
    fecharModal('modal-aluno');
    showToast(emEdicaoId ? 'Alterações salvas.' : 'Aluno cadastrado.');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function excluirAluno(id) {
  const r = registros.find(x => x.id === id);
  if (!r || !confirm(`Excluir ${r.nome} da lista de contratos?

Isso apaga o aluno e todo o histórico dele, e não pode ser desfeito.
(Se ele só desistiu, use "Desistiu".)`)) return;
  try {
    await apiFetch(`/contratos/${r.id}`, { method: 'DELETE' });
    registros = registros.filter(x => x.id !== r.id);
    fecharModal('modal-aluno');
    montarFiltros();
    renderTudo();
    showToast('Registro excluído.');
  } catch (err) { showToast(err.message, 'error'); }
}

// Histórico = observações, uma linha por registro. Linhas do "Registrar
// contato" têm o formato "DD/MM/AAAA - NOME: texto" e viram data + autor;
// o resto (anotação livre / importada da planilha) aparece como está.
function renderHistorico(r) {
  const linhas = (r.observacoes || '').split('\n').map(l => l.trim()).filter(Boolean);
  const lista = document.getElementById('hist-lista');
  if (!linhas.length) {
    lista.innerHTML = '<div class="hist-vazio">Nenhuma observação registrada ainda.</div>';
  } else {
    lista.innerHTML = linhas.map(l => {
      const m = l.match(/^(\d{2}\/\d{2}\/\d{4}) - ([^:]{1,40}): (.*)$/);
      return m
        ? `<div class="hist-item"><div class="hist-data">${m[1]}</div><div><span class="hist-quem">${esc(m[2])}</span><div class="hist-texto">${esc(m[3])}</div></div></div>`
        : `<div class="hist-item"><div class="hist-data ct-vazio">anotação</div><div class="hist-texto">${esc(l)}</div></div>`;
    }).join('');
  }
  const info = [
    `Situação: <strong>${STATUS_LABEL[r.status] || r.status}</strong>`,
    r.dataMatricula ? `Matrícula: <strong>${fmtData(r.dataMatricula)}</strong>` : '',
    r.status === 'assinado' && (r.assinadoPor || r.assinadoEm) ? `Assinado: <strong>${esc([r.assinadoPor, fmtData(r.assinadoEm)].filter(Boolean).join(' · '))}</strong>` : '',
    r.createdBy ? `Cadastrado por: <strong>${esc(r.createdBy)}</strong>` : '',
    r.updatedBy && r.updatedAt ? `Última alteração: <strong>${esc(r.updatedBy)}</strong> em ${new Date(r.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''
  ].filter(Boolean);
  document.getElementById('hist-info').innerHTML = info.map(t => `<span>${t}</span>`).join('');
}

function abrirModalContato(id) {
  contatoId = id;
  const r = registros.find(x => x.id === id);
  if (!r) return;
  document.getElementById('modal-contato-aluno').textContent = `${r.nome}${r.curso ? ' · ' + r.curso : ''}${r.contato ? ' · ' + r.contato : ''}`;
  document.getElementById('c-texto').value = '';
  renderHistorico(r);
  abrirModal('modal-contato');
  document.getElementById('c-texto').focus();
}

async function salvarContato(e) {
  e.preventDefault();
  const texto = document.getElementById('c-texto').value.trim();
  if (!texto) return;
  try {
    const atualizado = await apiFetch(`/contratos/${contatoId}/contato`, { method: 'POST', body: JSON.stringify({ texto, hoje: hojeLocal() }) });
    substituir(atualizado);
    // Fica aberto mostrando o histórico já com o registro novo no topo.
    document.getElementById('c-texto').value = '';
    renderHistorico(atualizado);
    showToast('Contato registrado.');
  } catch (err) { showToast(err.message, 'error'); }
}
