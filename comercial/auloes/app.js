import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';
import { opcaoEscolhida, imprimirRelatorio } from '../comercial-comum.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'auloes';
// Nível padrão quando config/permissions ainda não tem a chave do módulo
// (mesmo valor do defaultPermissions do backend).
const NIVEL_PADRAO = { adm_l2: 3, comercial: 3 };
const STATUS_LABEL = { agendado: 'Agendado', realizado: 'Realizado', cancelado: 'Cancelado' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
// Tem que ficar aqui em cima: initApp() roda antes do fim do arquivo quando
// já há login em cache (caminho rápido) e wireEventos() usa esta lista.
const FILTROS = ['busca', 'filtro-cidade', 'filtro-tipo', 'filtro-turno', 'filtro-status'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;

let itens = [];
let periodoAtual = '';
let emEdicaoId = null;
let equipe = null; // [{uid, nome}] do Comercial

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

// Datas em 'AAAA-MM-DD' — Date local ao meio-dia pra não cair um dia pelo fuso.
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d, 12);
}
function fmtData(s) {
  if (!s) return '';
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const hoje = () => isoLocal(new Date());

function turnoClasse(t) {
  if (!t) return '';
  if (t.startsWith('MANHÃ')) return 'turno-manha';
  if (t.startsWith('TARDE')) return 'turno-tarde';
  if (t.startsWith('NOITE')) return 'turno-noite';
  return '';
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

// Períodos: próximos, o ano inteiro e cada mês do ano (a planilha era
// organizada por mês).
function montarPeriodos() {
  const ano = new Date().getFullYear();
  const opcoes = [
    [`${hoje()}|`, 'Próximos (de hoje em diante)'],
    [`${ano}-01-01|${ano}-12-31`, `Ano ${ano} inteiro`]
  ];
  MESES.forEach((m, i) => {
    const fim = new Date(ano, i + 1, 0).getDate();
    const mm = String(i + 1).padStart(2, '0');
    opcoes.push([`${ano}-${mm}-01|${ano}-${mm}-${fim}`, `${m.charAt(0).toUpperCase() + m.slice(1)} de ${ano}`]);
  });
  opcoes.push([`${ano + 1}-01-01|${ano + 1}-12-31`, `Ano ${ano + 1} inteiro`]);
  document.getElementById('sel-periodo').innerHTML = '<option value="">Selecione o período...</option>' +
    opcoes.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
}

function wireEventos() {
  // Só busca depois que a pessoa escolhe o período (economia de leitura).
  document.getElementById('sel-periodo').addEventListener('change', (e) => {
    periodoAtual = e.target.value;
    document.getElementById('btn-copiar-agenda').classList.toggle('hidden', !periodoAtual);
    document.getElementById('btn-imprimir').classList.toggle('hidden', !periodoAtual);
    if (periodoAtual) carregar();
    else {
      document.getElementById('conteudo').classList.add('hidden');
      document.getElementById('msg-inicial').classList.remove('hidden');
    }
  });

  FILTROS.forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(el.type === 'text' ? 'input' : 'change', renderTudo);
  });
  document.getElementById('cidades-bar').addEventListener('click', (e) => {
    const chip = e.target.closest('.curso-chip');
    if (!chip) return;
    document.getElementById('filtro-cidade').value = chip.dataset.cidade;
    renderTudo();
  });
  document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
    FILTROS.forEach(id => { document.getElementById(id).value = ''; });
    renderTudo();
  });

  document.getElementById('btn-novo').addEventListener('click', () => abrirModal(null));
  document.getElementById('btn-imprimir').addEventListener('click', () => imprimirRelatorio([
    `Período: ${opcaoEscolhida('sel-periodo')}`,
    opcaoEscolhida('filtro-cidade') && `Cidade: ${opcaoEscolhida('filtro-cidade')}`,
    opcaoEscolhida('filtro-tipo') && `Tipo: ${opcaoEscolhida('filtro-tipo')}`,
    opcaoEscolhida('filtro-turno') && `Turno: ${opcaoEscolhida('filtro-turno')}`,
    opcaoEscolhida('filtro-status') && `Situação: ${opcaoEscolhida('filtro-status')}`,
    document.getElementById('busca').value.trim() && `Busca: "${document.getElementById('busca').value.trim()}"`,
    `${document.querySelectorAll('#tabela-corpo tr:not(.mes-linha):not(:has(.tabela-msg))').length} agendamento(s)`
  ], currentUserNome || currentUser.email));
  document.getElementById('btn-cancelar-modal').addEventListener('click', () => fecharModal());
  document.getElementById('form-aulao').addEventListener('submit', salvar);
  document.getElementById('btn-excluir').addEventListener('click', () => excluir(emEdicaoId));
  document.getElementById('btn-copiar-agenda').addEventListener('click', copiarAgenda);
  // Colégio já visitado: puxa a cidade sozinho.
  document.getElementById('f-colegio').addEventListener('change', (e) => {
    const c = e.target.value.trim().toUpperCase();
    const achado = itens.find(i => i.colegio === c);
    const cidade = document.getElementById('f-cidade');
    if (achado && !cidade.value) cidade.value = achado.cidade;
  });

  document.getElementById('tabela-corpo').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const { id, acao } = btn.dataset;
    if (acao === 'editar') abrirModal(id);
    else if (acao === 'excluir') excluir(id);
    else mudarStatus(id, acao);
  });
}

async function carregar() {
  document.getElementById('msg-inicial').classList.add('hidden');
  document.getElementById('conteudo').classList.remove('hidden');
  document.getElementById('tabela-corpo').innerHTML = '<tr><td colspan="8" class="tabela-msg">Carregando...</td></tr>';
  const [de, ate] = periodoAtual.split('|');
  try {
    itens = await apiFetch(`/auloes?de=${de}${ate ? `&ate=${ate}` : ''}`);
    renderTudo();
  } catch (err) {
    document.getElementById('tabela-corpo').innerHTML = `<tr><td colspan="8" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

// ==========================================
// FILTROS + RENDER
// ==========================================
function lerFiltros() {
  return {
    busca: document.getElementById('busca').value.trim().toLowerCase(),
    cidade: document.getElementById('filtro-cidade').value,
    tipo: document.getElementById('filtro-tipo').value,
    turno: document.getElementById('filtro-turno').value,
    status: document.getElementById('filtro-status').value
  };
}

// Cidade é comparada sem acento/maiúscula ("Lidianópolis" x "LIdianópolis"
// vieram diferentes da planilha).
const chave = (v) => (v || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function passa(i, f, ignorar = '') {
  if (ignorar !== 'cidade' && f.cidade && chave(i.cidade) !== chave(f.cidade)) return false;
  if (f.tipo && i.tipo !== f.tipo) return false;
  if (f.turno && i.turno !== f.turno) return false;
  if (ignorar !== 'status' && f.status && i.status !== f.status) return false;
  if (f.busca && !`${i.colegio} ${i.turma} ${i.responsavel} ${i.palestrante} ${i.observacoes} ${i.contatoColegio}`.toLowerCase().includes(f.busca)) return false;
  return true;
}

// Uma opção por cidade (sem duplicar por acento/maiúscula), com o nome mais comum.
function cidadesUnicas() {
  const porChave = {};
  itens.forEach(i => {
    if (!i.cidade) return;
    const k = chave(i.cidade);
    porChave[k] = porChave[k] || {};
    porChave[k][i.cidade.trim()] = (porChave[k][i.cidade.trim()] || 0) + 1;
  });
  return Object.values(porChave).map(v => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]).sort((a, b) => a.localeCompare(b));
}

function preencherSelect(id, valores, rotuloTodos) {
  const sel = document.getElementById(id);
  const atual = sel.value;
  sel.innerHTML = `<option value="">${rotuloTodos}</option>` + valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (valores.includes(atual)) sel.value = atual;
}

function unicos(campo) {
  return [...new Set(itens.map(i => i[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function renderTudo() {
  const cidades = cidadesUnicas();
  preencherSelect('filtro-cidade', cidades, 'Todas as cidades');
  preencherSelect('filtro-tipo', unicos('tipo'), 'Todos os tipos');
  preencherSelect('filtro-turno', unicos('turno'), 'Todos os turnos');
  document.getElementById('lista-colegios').innerHTML = unicos('colegio').map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-cidades').innerHTML = cidades.map(v => `<option value="${esc(v)}">`).join('');

  const f = lerFiltros();

  // KPIs (respeitam os filtros, menos a situação — é o que eles contam).
  const base = itens.filter(i => passa(i, f, 'status'));
  const ativos = base.filter(i => i.status !== 'cancelado');
  document.getElementById('kpi-total').textContent = ativos.length;
  const canc = base.length - ativos.length;
  document.getElementById('kpi-cancelados').textContent = canc ? `+ ${canc} cancelado(s)` : '';
  document.getElementById('kpi-agendado').textContent = base.filter(i => i.status === 'agendado').length;
  const daqui7 = isoLocal(new Date(Date.now() + 7 * 86400000));
  const semana = base.filter(i => i.status === 'agendado' && i.data >= hoje() && i.data <= daqui7).length;
  document.getElementById('kpi-semana').textContent = semana ? `${semana} nos próximos 7 dias` : '';
  document.getElementById('kpi-realizado').textContent = base.filter(i => i.status === 'realizado').length;
  document.getElementById('kpi-colegios').textContent = new Set(ativos.map(i => i.colegio)).size;
  document.getElementById('kpi-cidades').textContent = `${new Set(ativos.map(i => chave(i.cidade))).size} cidade(s)`;

  // Botões por cidade com quantidade (respeitando os outros filtros).
  const semCidade = itens.filter(i => passa(i, f, 'cidade'));
  const porCidade = {};
  semCidade.forEach(i => { const k = chave(i.cidade); if (k) porCidade[k] = (porCidade[k] || 0) + 1; });
  const chip = (v, n) => `<button type="button" class="curso-chip ${chave(f.cidade) === chave(v) ? 'ativo' : ''}" data-cidade="${esc(v)}">${esc(v || 'Todas as cidades')} <span class="curso-chip-qtd">${n}</span></button>`;
  const listaCidades = cidades.map(c => [c, porCidade[chave(c)] || 0]).filter(([c, n]) => n > 0 || chave(c) === chave(f.cidade)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  document.getElementById('cidades-bar').innerHTML = chip('', semCidade.length) + listaCidades.map(([c, n]) => chip(c, n)).join('');
  [...document.getElementById('filtro-cidade').options].forEach(o => {
    o.textContent = o.value ? `${o.value} (${porCidade[chave(o.value)] || 0})` : `Todas as cidades (${semCidade.length})`;
  });

  const lista = itens.filter(i => passa(i, f));
  const filtrando = Object.values(f).some(v => v);
  document.getElementById('btn-limpar-filtros').classList.toggle('hidden', !filtrando);
  document.getElementById('filtro-resumo').innerHTML = filtrando ? `Mostrando <strong>${lista.length}</strong> de ${itens.length} agendamentos do período` : '';
  renderTabela(lista);
}

function renderTabela(lista) {
  const corpo = document.getElementById('tabela-corpo');
  if (!lista.length) {
    corpo.innerHTML = `<tr><td colspan="8" class="tabela-msg">${itens.length ? 'Nenhum agendamento com esses filtros.' : 'Nada agendado nesse período. Use "Agendar aulão".'}</td></tr>`;
    return;
  }
  // Agrupado por mês, igual à planilha ("MÊS DE MAIO"...).
  const porMes = {};
  lista.forEach(i => { const k = (i.data || '').slice(0, 7); (porMes[k] = porMes[k] || []).push(i); });
  const h = hoje();
  corpo.innerHTML = Object.keys(porMes).sort().map(k => {
    const [a, m] = k.split('-');
    const cab = `<tr class="mes-linha"><td colspan="8">Mês de ${MESES[Number(m) - 1]} ${a}<span class="mes-qtd">${porMes[k].length} agendamento(s)</span></td></tr>`;
    return cab + porMes[k].map(i => {
      const passado = i.data < h;
      const esqueceu = passado && i.status === 'agendado';
      let acoes = '';
      if (i.status === 'agendado') {
        acoes += `<button class="btn-acao ok" data-acao="realizado" data-id="${i.id}">✓ Realizado</button>`;
        acoes += `<button class="btn-acao desistir" data-acao="cancelado" data-id="${i.id}">Cancelar</button>`;
      } else {
        acoes += `<button class="btn-acao" data-acao="agendado" data-id="${i.id}" title="Voltar para agendado">↺</button>`;
      }
      acoes += `<button class="btn-acao" data-acao="editar" data-id="${i.id}">Editar</button>`;
      acoes += `<button class="btn-acao desistir" data-acao="excluir" data-id="${i.id}" title="Excluir agendamento">🗑</button>`;
      const extras = [i.turma && `Turma: ${i.turma}`, i.palestrante && `Com: ${i.palestrante}`, i.publicoEstimado && `~${i.publicoEstimado} alunos`].filter(Boolean).join(' · ');
      return `
        <tr class="${passado && i.status !== 'agendado' ? 'linha-passada' : ''}">
          <td><div class="ae-dia">${fmtData(i.data)}${i.data === h ? '<span class="ae-hoje">HOJE</span>' : ''}</div><div class="ct-sub">${DIAS[dataLocal(i.data).getDay()]}${i.horario ? ' · ' + i.horario : ''}</div></td>
          <td>${i.turno ? `<span class="turno-badge ${turnoClasse(i.turno)}">${esc(i.turno)}</span>` : '<span class="ct-vazio">—</span>'}</td>
          <td><span class="ct-nome">${esc(i.colegio)}</span>${extras ? `<div class="ct-sub">${esc(extras)}</div>` : ''}${i.observacoes ? `<div class="ct-sub" title="${esc(i.observacoes)}">📝 ${esc(i.observacoes.length > 50 ? i.observacoes.slice(0, 50) + '…' : i.observacoes)}</div>` : ''}</td>
          <td>${esc(i.cidade)}</td>
          <td>${i.tipo ? `<span class="tipo-badge">${esc(i.tipo)}</span>` : '<span class="ct-vazio">—</span>'}</td>
          <td>${esc(nomeProprio(i.responsavel)) || '<span class="ct-vazio">—</span>'}${i.atividadeId ? '<div class="ae-agenda-ok" title="Está na agenda do Meu Espaço">📅 na agenda</div>' : ''}</td>
          <td><span class="status-badge st-${i.status}">${STATUS_LABEL[i.status] || i.status}</span>${esqueceu ? '<div class="ae-atencao" title="Data já passou — marque se foi realizado">aconteceu?</div>' : ''}</td>
          <td class="acoes-col action-execute">${acoes}</td>
        </tr>`;
    }).join('');
  }).join('');
}

// ==========================================
// FORMULÁRIO / AÇÕES
// ==========================================
// Equipe do Comercial (buscada só na 1ª vez que o formulário abre). Quem for
// marcado em "Quem vai" ganha a atividade na agenda do Meu Espaço.
async function carregarEquipe() {
  if (equipe) return;
  try { equipe = await apiFetch('/auloes/equipe'); } catch (e) { equipe = []; }
}

function nomeProprio(nome) {
  const minusculas = ['da', 'de', 'do', 'das', 'dos', 'e'];
  return (nome || '').toLowerCase().split(/\s+/).filter(Boolean)
    .map((p, i) => (i > 0 && minusculas.includes(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function renderEquipe(selecionados) {
  const box = document.getElementById('f-equipe');
  if (!equipe.length) { box.innerHTML = '<span class="ct-sub">Não foi possível carregar a equipe do Comercial.</span>'; return; }
  box.innerHTML = equipe.map(p => `
    <label class="equipe-chip"><input type="checkbox" value="${p.uid}" ${selecionados.includes(p.uid) ? 'checked' : ''}>${esc(nomeProprio(p.nome))}</label>`).join('');
}

function uidsSelecionados() {
  return [...document.querySelectorAll('#f-equipe input:checked')].map(i => i.value);
}

async function abrirModal(id) {
  // Não espera a equipe pra abrir (no Vercel a 1ª chamada pode levar
  // segundos) — os botões aparecem quando ela chegar.
  const equipePronta = carregarEquipe();
  emEdicaoId = id;
  const i = id ? itens.find(x => x.id === id) : null;
  document.getElementById('modal-titulo').textContent = i ? 'Editar agendamento' : 'Agendar aulão';
  document.getElementById('modal-ultima-alt').textContent = i && i.updatedBy
    ? `Agendado por ${i.createdBy} · última alteração: ${i.updatedBy} em ${new Date(i.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  const set = (campo, v) => { document.getElementById(campo).value = v ?? ''; };
  set('f-data', i?.data);
  set('f-turno', i?.turno);
  set('f-horario', i?.horario);
  set('f-colegio', i?.colegio);
  set('f-cidade', i?.cidade);
  set('f-tipo', i ? i.tipo : 'Aulão de redação');
  set('f-turma', i?.turma);
  const marcados = i ? (i.responsaveis || []).map(r => r.uid) : [currentUser.uid];
  if (equipe) renderEquipe(marcados);
  else {
    document.getElementById('f-equipe').innerHTML = '<span class="ct-sub">Carregando equipe...</span>';
    equipePronta.then(() => { if (emEdicaoId === id) renderEquipe(marcados); });
  }
  set('f-palestrante', i?.palestrante);
  set('f-contato-colegio', i?.contatoColegio);
  set('f-publico', i?.publicoEstimado);
  set('f-status', i?.status || 'agendado');
  set('f-obs', i?.observacoes);
  document.getElementById('grupo-status').classList.toggle('hidden', !i);
  document.getElementById('btn-excluir').classList.toggle('hidden', !i);
  document.getElementById('modal-aulao').classList.remove('hidden');
  document.getElementById('f-data').focus();
}

function fecharModal() {
  document.getElementById('modal-aulao').classList.add('hidden');
}

async function salvar(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-salvar');
  const v = (id) => document.getElementById(id).value;
  const body = {
    data: v('f-data'), turno: v('f-turno'), horario: v('f-horario'), colegio: v('f-colegio'), cidade: v('f-cidade'),
    tipo: v('f-tipo'), turma: v('f-turma'), responsaveisUids: uidsSelecionados(), palestrante: v('f-palestrante'),
    contatoColegio: v('f-contato-colegio'), publicoEstimado: v('f-publico'), status: v('f-status'), observacoes: v('f-obs')
  };
  btn.disabled = true;
  try {
    const salvo = emEdicaoId
      ? await apiFetch(`/auloes/${emEdicaoId}`, { method: 'PUT', body: JSON.stringify(body) })
      : await apiFetch('/auloes', { method: 'POST', body: JSON.stringify(body) });
    substituir(salvo);
    fecharModal();
    showToast(emEdicaoId ? 'Alterações salvas.' : 'Aulão agendado.');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function substituir(item) {
  const idx = itens.findIndex(x => x.id === item.id);
  if (idx >= 0) itens[idx] = item; else itens.push(item);
  itens.sort((a, b) => (a.data || '').localeCompare(b.data || ''));
  renderTudo();
}

async function mudarStatus(id, status) {
  const i = itens.find(x => x.id === id);
  if (status === 'cancelado' && !confirm(`Marcar ${i.colegio} (${fmtData(i.data)}) como cancelado?`)) return;
  try {
    substituir(await apiFetch(`/auloes/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }));
    showToast(`${i.colegio} → ${STATUS_LABEL[status]}`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function excluir(id) {
  const i = itens.find(x => x.id === id);
  if (!i || !confirm(`Excluir o agendamento de ${i.colegio} (${fmtData(i.data)} - ${i.turno || ''})?\n\nIsso não pode ser desfeito. (Se só não vai acontecer, use "Cancelar".)`)) return;
  try {
    await apiFetch(`/auloes/${i.id}`, { method: 'DELETE' });
    itens = itens.filter(x => x.id !== i.id);
    fecharModal();
    renderTudo();
    showToast('Agendamento excluído.');
  } catch (err) { showToast(err.message, 'error'); }
}

// Agenda filtrada em texto, agrupada por mês — pronta pra colar no WhatsApp.
async function copiarAgenda() {
  const f = lerFiltros();
  const lista = itens.filter(i => passa(i, f) && i.status !== 'cancelado');
  if (!lista.length) { showToast('Nada para copiar com esses filtros.', 'error'); return; }
  const linhas = ['*AGENDA AULÕES - REDAÇÕES*'];
  let mesAtual = '';
  lista.forEach(i => {
    const k = i.data.slice(0, 7);
    if (k !== mesAtual) {
      mesAtual = k;
      const [a, m] = k.split('-');
      linhas.push('', `*${MESES[Number(m) - 1].toUpperCase()} ${a}*`);
    }
    const partes = [`${fmtData(i.data).slice(0, 5)} (${DIAS[dataLocal(i.data).getDay()]})`, i.turno + (i.horario ? ` ${i.horario}` : ''), i.colegio, i.cidade];
    if (i.tipo) partes.push(i.tipo);
    if (i.responsavel) partes.push(`vai: ${i.responsavel}`);
    linhas.push(`• ${partes.filter(Boolean).join(' – ')}${i.status === 'realizado' ? ' ✅' : ''}`);
  });
  const txt = linhas.join('\n');
  try { await navigator.clipboard.writeText(txt); } catch (e) {
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  showToast(`Agenda copiada (${lista.length} agendamentos).`);
}
