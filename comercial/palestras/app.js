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

const MODULO = 'palestras';
// Nível padrão quando config/permissions ainda não tem a chave do módulo
// (mesmo valor do defaultPermissions do backend).
const NIVEL_PADRAO = { adm_l2: 3, comercial: 3 };
const STATUS_LABEL = { agendada: 'Agendada', realizada: 'Realizada', cancelada: 'Cancelada' };
const TRANSPORTE_LABEL = { comercial: 'Equipe Comercial', outro: 'Outro motorista', proprio: 'Deslocamento próprio', nao_necessario: 'Não será necessário', verificar: 'A verificar' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
// Tem que ficar aqui em cima: initApp() roda antes do fim do arquivo quando
// já há login em cache (caminho rápido) e wireEventos() usa esta lista.
const FILTROS = ['busca', 'filtro-cidade', 'filtro-palestrante', 'filtro-transporte', 'filtro-status'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;

let itens = [];
let periodoAtual = '';
let emEdicaoId = null;
let equipe = null;

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

function nomeProprio(nome) {
  const minusculas = ['da', 'de', 'do', 'das', 'dos', 'e'];
  return (nome || '').toLowerCase().split(/\s+/).filter(Boolean)
    .map((p, i) => (i > 0 && minusculas.includes(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// Cidade/palestrante comparados sem acento/maiúscula (a planilha tinha
// "Jardim alegre" e "Jardim Alegre").
const chave = (v) => (v || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Palestra que ainda vai acontecer e não tem quem leve.
const semTransporte = (i) => i.status === 'agendada' && i.transporte === 'verificar' && (!i.data || i.data >= hoje());

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

// Semestres (a planilha é por semestre: aba "2026.2"), próximos e meses.
function montarPeriodos() {
  const ano = new Date().getFullYear();
  const opcoes = [
    [`${hoje()}|`, 'Próximas (de hoje em diante)'],
    [`${ano}-07-01|${ano}-12-31`, `Semestre ${ano}.2`],
    [`${ano}-01-01|${ano}-06-30`, `Semestre ${ano}.1`],
    [`${ano}-01-01|${ano}-12-31`, `Ano ${ano} inteiro`]
  ];
  MESES.forEach((m, i) => {
    const fim = new Date(ano, i + 1, 0).getDate();
    const mm = String(i + 1).padStart(2, '0');
    opcoes.push([`${ano}-${mm}-01|${ano}-${mm}-${fim}`, `${m.charAt(0).toUpperCase() + m.slice(1)} de ${ano}`]);
  });
  opcoes.push([`${ano + 1}-01-01|${ano + 1}-06-30`, `Semestre ${ano + 1}.1`]);
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
  document.getElementById('alerta-transporte').addEventListener('click', (e) => {
    if (!e.target.closest('button')) return;
    FILTROS.forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('filtro-transporte').value = 'verificar';
    document.getElementById('filtro-status').value = 'agendada';
    renderTudo();
  });

  document.getElementById('btn-novo').addEventListener('click', () => abrirModal(null));
  document.getElementById('btn-cancelar-modal').addEventListener('click', fecharModal);
  document.getElementById('form-palestra').addEventListener('submit', salvar);
  document.getElementById('btn-excluir').addEventListener('click', () => excluir(emEdicaoId));
  document.getElementById('btn-copiar-agenda').addEventListener('click', copiarAgenda);
  document.getElementById('btn-imprimir').addEventListener('click', () => imprimirRelatorio([
    `Período: ${opcaoEscolhida('sel-periodo')}`,
    opcaoEscolhida('filtro-cidade') && `Cidade: ${opcaoEscolhida('filtro-cidade')}`,
    opcaoEscolhida('filtro-palestrante') && `Palestrante: ${opcaoEscolhida('filtro-palestrante')}`,
    opcaoEscolhida('filtro-transporte') && `Transporte: ${opcaoEscolhida('filtro-transporte')}`,
    opcaoEscolhida('filtro-status') && `Situação: ${opcaoEscolhida('filtro-status')}`,
    document.getElementById('busca').value.trim() && `Busca: "${document.getElementById('busca').value.trim()}"`,
    `${document.querySelectorAll('#tabela-corpo tr:not(.mes-linha):not(:has(.tabela-msg))').length} palestra(s)`
  ], currentUserNome || currentUser.email));

  document.querySelectorAll('input[name="transporte"]').forEach(r => r.addEventListener('change', atualizarTransporte));
  document.getElementById('f-sem-data').addEventListener('change', atualizarSemData);
  // Instituição já cadastrada: puxa a cidade sozinho.
  document.getElementById('f-local').addEventListener('change', (e) => {
    const achado = itens.find(i => chave(i.local) === chave(e.target.value));
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
  document.getElementById('tabela-corpo').innerHTML = '<tr><td colspan="6" class="tabela-msg">Carregando...</td></tr>';
  const [de, ate] = periodoAtual.split('|');
  try {
    itens = await apiFetch(`/palestras?de=${de}${ate ? `&ate=${ate}` : ''}`);
    renderTudo();
  } catch (err) {
    document.getElementById('tabela-corpo').innerHTML = `<tr><td colspan="6" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

// ==========================================
// FILTROS + RENDER
// ==========================================
function lerFiltros() {
  return {
    busca: document.getElementById('busca').value.trim().toLowerCase(),
    cidade: document.getElementById('filtro-cidade').value,
    palestrante: document.getElementById('filtro-palestrante').value,
    transporte: document.getElementById('filtro-transporte').value,
    status: document.getElementById('filtro-status').value
  };
}

function passa(i, f, ignorar = '') {
  if (ignorar !== 'cidade' && f.cidade && chave(i.cidade) !== chave(f.cidade)) return false;
  if (f.palestrante && chave(i.palestrante) !== chave(f.palestrante)) return false;
  if (f.transporte && i.transporte !== f.transporte) return false;
  if (ignorar !== 'status' && f.status && i.status !== f.status) return false;
  if (f.busca && !`${i.local} ${i.tema} ${i.palestrante} ${i.motorista} ${(i.envolvidos || []).map(p => p.nome).join(' ')} ${i.observacoes} ${i.contatoLocal}`.toLowerCase().includes(f.busca)) return false;
  return true;
}

// Uma opção por valor (sem duplicar por acento/maiúscula), com a grafia mais comum.
function unicosNormalizados(campo) {
  const porChave = {};
  itens.forEach(i => {
    const v = (i[campo] || '').trim();
    if (!v) return;
    const k = chave(v);
    porChave[k] = porChave[k] || {};
    porChave[k][v] = (porChave[k][v] || 0) + 1;
  });
  return Object.values(porChave).map(v => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]).sort((a, b) => a.localeCompare(b));
}

function preencherSelect(id, valores, rotuloTodos) {
  const sel = document.getElementById(id);
  const atual = sel.value;
  sel.innerHTML = `<option value="">${rotuloTodos}</option>` + valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (valores.includes(atual)) sel.value = atual;
}

function renderTudo() {
  const cidades = unicosNormalizados('cidade');
  const palestrantes = unicosNormalizados('palestrante');
  preencherSelect('filtro-cidade', cidades, 'Todas as cidades');
  preencherSelect('filtro-palestrante', palestrantes, 'Todos os palestrantes');
  document.getElementById('lista-locais').innerHTML = unicosNormalizados('local').map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-cidades').innerHTML = cidades.map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-palestrantes').innerHTML = palestrantes.map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-motoristas').innerHTML = unicosNormalizados('motorista').map(v => `<option value="${esc(v)}">`).join('');

  const f = lerFiltros();

  // Alerta: palestras futuras sem quem leve (independe dos filtros).
  const pendentes = itens.filter(semTransporte).length;
  const alerta = document.getElementById('alerta-transporte');
  alerta.classList.toggle('hidden', !pendentes);
  alerta.innerHTML = pendentes ? `⚠️ ${pendentes} palestra(s) ainda sem definição de quem leva o palestrante. <button type="button">Ver quais</button>` : '';

  // KPIs (respeitam os filtros, menos a situação).
  const base = itens.filter(i => passa(i, f, 'status'));
  const ativos = base.filter(i => i.status !== 'cancelada');
  document.getElementById('kpi-total').textContent = ativos.length;
  const semData = ativos.filter(i => !i.data).length;
  document.getElementById('kpi-sem-data').textContent = semData ? `${semData} com data a definir` : '';
  document.getElementById('kpi-agendada').textContent = base.filter(i => i.status === 'agendada').length;
  const daqui7 = isoLocal(new Date(Date.now() + 7 * 86400000));
  const semana = base.filter(i => i.status === 'agendada' && i.data && i.data >= hoje() && i.data <= daqui7).length;
  document.getElementById('kpi-semana').textContent = semana ? `${semana} nos próximos 7 dias` : '';
  document.getElementById('kpi-realizada').textContent = base.filter(i => i.status === 'realizada').length;
  document.getElementById('kpi-verificar').textContent = base.filter(semTransporte).length;
  document.getElementById('kpi-palestrantes').textContent = new Set(ativos.map(i => chave(i.palestrante)).filter(Boolean)).size;
  document.getElementById('kpi-cidades').textContent = `${new Set(ativos.map(i => chave(i.cidade))).size} cidade(s) atendidas`;

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
  document.getElementById('filtro-resumo').innerHTML = filtrando ? `Mostrando <strong>${lista.length}</strong> de ${itens.length} palestras` : '';
  renderTabela(lista);
}

function quemLevaHtml(i) {
  let txt;
  if (i.transporte === 'comercial') txt = `🚗 ${esc(nomeProprio(i.motorista))}`;
  else if (i.transporte === 'outro') txt = `🚗 ${esc(i.motorista || 'Outro motorista')}`;
  else if (i.transporte === 'proprio') txt = '🚙 Deslocamento próprio';
  else if (i.transporte === 'nao_necessario') txt = 'Não será necessário';
  else txt = '⚠️ A verificar';
  return `<span class="pl-leva tp-${i.transporte}">${txt}</span>`
    + (i.atividadeId ? '<div class="ae-agenda-ok" title="Está na agenda do Meu Espaço">📅 na agenda</div>' : '')
    + (i.pagarDeslocamento ? '<span class="pl-pagar">💰 pagar deslocamento</span>' : '');
}

function renderTabela(lista) {
  const corpo = document.getElementById('tabela-corpo');
  if (!lista.length) {
    corpo.innerHTML = `<tr><td colspan="6" class="tabela-msg">${itens.length ? 'Nenhuma palestra com esses filtros.' : 'Nada agendado nesse período. Use "Agendar palestra".'}</td></tr>`;
    return;
  }
  // Agrupado por mês; as sem data vão no fim, em "Data a definir".
  const grupos = {};
  lista.forEach(i => { const k = i.data ? i.data.slice(0, 7) : 'zz-sem-data'; (grupos[k] = grupos[k] || []).push(i); });
  const h = hoje();
  corpo.innerHTML = Object.keys(grupos).sort().map(k => {
    const titulo = k === 'zz-sem-data' ? 'Data a definir' : `Mês de ${MESES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
    const cab = `<tr class="mes-linha ${k === 'zz-sem-data' ? 'sem-data' : ''}"><td colspan="6">${titulo}<span class="mes-qtd">${grupos[k].length} palestra(s)</span></td></tr>`;
    return cab + grupos[k].map(i => {
      const passado = i.data && i.data < h;
      const esqueceu = passado && i.status === 'agendada';
      let acoes = '';
      if (i.status === 'agendada') {
        acoes += `<button class="btn-acao ok" data-acao="realizada" data-id="${i.id}">✓ Realizada</button>`;
        acoes += `<button class="btn-acao desistir" data-acao="cancelada" data-id="${i.id}">Cancelar</button>`;
      } else {
        acoes += `<button class="btn-acao" data-acao="agendada" data-id="${i.id}" title="Voltar para agendada">↺</button>`;
      }
      acoes += `<button class="btn-acao" data-acao="editar" data-id="${i.id}">Editar</button>`;
      acoes += `<button class="btn-acao desistir" data-acao="excluir" data-id="${i.id}" title="Excluir palestra">🗑</button>`;
      const quando = i.data
        ? `<div class="ae-dia">${fmtData(i.data)}${i.data === h ? '<span class="ae-hoje">HOJE</span>' : ''}</div><div class="ct-sub">${DIAS[dataLocal(i.data).getDay()]}${i.horario ? ' · ' + esc(i.horario) : (i.horaInicio ? ' · ' + i.horaInicio : '')}</div>`
        : `<div class="ae-dia">${esc(i.dataPrevista || 'A definir')}</div>${i.horario ? `<div class="ct-sub">${esc(i.horario)}</div>` : ''}`;
      return `
        <tr class="${passado && i.status !== 'agendada' ? 'linha-passada' : ''}">
          <td>${quando}</td>
          <td><div class="pl-local">${esc(i.local)}</div><div class="ct-sub">📍 ${esc(i.cidade)}</div>${i.observacoes ? `<div class="ct-sub" title="${esc(i.observacoes)}">📝 ${esc(i.observacoes.length > 45 ? i.observacoes.slice(0, 45) + '…' : i.observacoes)}</div>` : ''}</td>
          <td><span class="cm-pessoa" style="min-width:0">${avatar(i.palestrante)}<span><span class="pl-palestrante">${esc(i.palestrante) || '—'}</span>${i.tema ? `<div class="pl-tema">${esc(i.tema)}</div>` : ''}${(i.envolvidos || []).length ? `<div class="ct-sub">👥 Comercial: ${esc(i.envolvidos.map(p => nomeProprio(p.nome)).join(', '))}</div>` : ''}</span></span></td>
          <td>${quemLevaHtml(i)}</td>
          <td><span class="status-badge st-${i.status}">${STATUS_LABEL[i.status] || i.status}</span>${esqueceu ? '<div class="ae-atencao" title="Data já passou — marque se foi realizada">aconteceu?</div>' : ''}</td>
          <td class="acoes-col action-execute">${acoes}</td>
        </tr>`;
    }).join('');
  }).join('');
}

// ==========================================
// FORMULÁRIO / AÇÕES
// ==========================================
async function carregarEquipe() {
  if (equipe) return;
  try { equipe = await apiFetch('/palestras/equipe'); } catch (e) { equipe = []; }
}

function renderEquipe(selecionados, boxId = 'f-equipe') {
  const box = document.getElementById(boxId);
  if (!equipe.length) { box.innerHTML = '<span class="ct-sub">Não foi possível carregar a equipe do Comercial.</span>'; return; }
  box.innerHTML = equipe.map(p => `
    <label class="equipe-chip"><input type="checkbox" value="${p.uid}" ${selecionados.includes(p.uid) ? 'checked' : ''}>${esc(nomeProprio(p.nome))}</label>`).join('');
}

function transporteEscolhido() {
  return document.querySelector('input[name="transporte"]:checked')?.value || 'verificar';
}

function atualizarTransporte() {
  const t = transporteEscolhido();
  document.getElementById('grupo-equipe').classList.toggle('hidden', t !== 'comercial');
  document.getElementById('grupo-motorista').classList.toggle('hidden', t !== 'outro');
}

function atualizarSemData() {
  const semData = document.getElementById('f-sem-data').checked;
  document.getElementById('grupo-data-prevista').classList.toggle('hidden', !semData);
  document.getElementById('f-data').disabled = semData;
  if (semData) document.getElementById('f-data').value = '';
}

async function abrirModal(id) {
  // Não espera a equipe pra abrir (no Vercel a 1ª chamada pode levar
  // segundos) — os botões aparecem quando ela chegar.
  const equipePronta = carregarEquipe();
  emEdicaoId = id;
  const i = id ? itens.find(x => x.id === id) : null;
  document.getElementById('modal-titulo').textContent = i ? 'Editar palestra' : 'Agendar palestra';
  document.getElementById('modal-ultima-alt').textContent = i && i.updatedBy
    ? `Agendada por ${i.createdBy} · última alteração: ${i.updatedBy} em ${new Date(i.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  const set = (campo, v) => { document.getElementById(campo).value = v ?? ''; };
  set('f-local', i?.local);
  set('f-cidade', i?.cidade);
  set('f-data', i?.data);
  set('f-data-prevista', i?.dataPrevista);
  set('f-hora-inicio', i?.horaInicio);
  set('f-horario', i?.horario);
  set('f-palestrante', i?.palestrante);
  set('f-tema', i?.tema);
  set('f-motorista', i?.transporte === 'outro' ? i.motorista : '');
  set('f-contato', i?.contatoLocal);
  set('f-status', i?.status || 'agendada');
  set('f-obs', i?.observacoes);
  document.getElementById('f-sem-data').checked = !!(i && !i.data);
  document.getElementById('f-pagar').checked = !!i?.pagarDeslocamento;
  const t = i ? i.transporte : 'comercial';
  document.querySelectorAll('input[name="transporte"]').forEach(r => { r.checked = r.value === t; });
  const levam = i ? (i.responsaveis || []).map(r => r.uid) : [];
  const envolvidos = i ? (i.envolvidos || []).map(r => r.uid) : [];
  const desenharEquipe = () => { renderEquipe(levam); renderEquipe(envolvidos, 'f-envolvidos'); };
  if (equipe) desenharEquipe();
  else {
    ['f-equipe', 'f-envolvidos'].forEach(b => { document.getElementById(b).innerHTML = '<span class="ct-sub">Carregando equipe...</span>'; });
    equipePronta.then(() => { if (emEdicaoId === id) desenharEquipe(); });
  }
  atualizarTransporte();
  atualizarSemData();
  document.getElementById('grupo-status').classList.toggle('hidden', !i);
  document.getElementById('btn-excluir').classList.toggle('hidden', !i);
  document.getElementById('modal-palestra').classList.remove('hidden');
  document.getElementById('f-local').focus();
}

function fecharModal() {
  document.getElementById('modal-palestra').classList.add('hidden');
}

async function salvar(e) {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  const semData = document.getElementById('f-sem-data').checked;
  if (!semData && !v('f-data')) { showToast('Informe a data ou marque "Ainda sem data".', 'error'); return; }
  if (semData && !v('f-data-prevista').trim()) { showToast('Informe a previsão (ex.: "Novembro").', 'error'); return; }
  const transporte = transporteEscolhido();
  const responsaveisUids = [...document.querySelectorAll('#f-equipe input:checked')].map(x => x.value);
  if (transporte === 'comercial' && !responsaveisUids.length) { showToast('Marque quem da equipe vai levar o palestrante.', 'error'); return; }
  const body = {
    local: v('f-local'), cidade: v('f-cidade'), data: semData ? '' : v('f-data'), dataPrevista: semData ? v('f-data-prevista') : '',
    horaInicio: v('f-hora-inicio'), horario: v('f-horario'), palestrante: v('f-palestrante'), tema: v('f-tema'),
    transporte, responsaveisUids,
    envolvidosUids: [...document.querySelectorAll('#f-envolvidos input:checked')].map(x => x.value),
    motorista: v('f-motorista'), pagarDeslocamento: document.getElementById('f-pagar').checked,
    contatoLocal: v('f-contato'), status: v('f-status'), observacoes: v('f-obs')
  };
  const btn = document.getElementById('btn-salvar');
  btn.disabled = true;
  try {
    const salvo = emEdicaoId
      ? await apiFetch(`/palestras/${emEdicaoId}`, { method: 'PUT', body: JSON.stringify(body) })
      : await apiFetch('/palestras', { method: 'POST', body: JSON.stringify(body) });
    substituir(salvo);
    fecharModal();
    showToast(emEdicaoId ? 'Alterações salvas.' : 'Palestra agendada.');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function substituir(item) {
  const idx = itens.findIndex(x => x.id === item.id);
  if (idx >= 0) itens[idx] = item; else itens.push(item);
  itens.sort((a, b) => (a.data || '9999').localeCompare(b.data || '9999') || (a.horaInicio || '').localeCompare(b.horaInicio || ''));
  renderTudo();
}

async function mudarStatus(id, status) {
  const i = itens.find(x => x.id === id);
  if (status === 'cancelada' && !confirm(`Cancelar a palestra em ${i.local} (${fmtData(i.data) || i.dataPrevista})?`)) return;
  try {
    substituir(await apiFetch(`/palestras/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }));
    showToast(`${i.local} → ${STATUS_LABEL[status]}`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function excluir(id) {
  const i = itens.find(x => x.id === id);
  if (!i || !confirm(`Excluir a palestra em ${i.local} (${fmtData(i.data) || i.dataPrevista})?\n\nIsso não pode ser desfeito. (Se só não vai acontecer, use "Cancelar".)`)) return;
  try {
    await apiFetch(`/palestras/${i.id}`, { method: 'DELETE' });
    itens = itens.filter(x => x.id !== i.id);
    fecharModal();
    renderTudo();
    showToast('Palestra excluída.');
  } catch (err) { showToast(err.message, 'error'); }
}

// Agenda filtrada em texto, por mês — pronta pra colar no WhatsApp.
async function copiarAgenda() {
  const f = lerFiltros();
  const lista = itens.filter(i => passa(i, f) && i.status !== 'cancelada');
  if (!lista.length) { showToast('Nada para copiar com esses filtros.', 'error'); return; }
  const linhas = ['*AGENDA DE PALESTRAS - FATEC*'];
  let grupo = '';
  lista.forEach(i => {
    const k = i.data ? i.data.slice(0, 7) : 'sem';
    if (k !== grupo) {
      grupo = k;
      linhas.push('', k === 'sem' ? '*DATA A DEFINIR*' : `*${MESES[Number(k.slice(5, 7)) - 1].toUpperCase()} ${k.slice(0, 4)}*`);
    }
    const quando = i.data ? `${fmtData(i.data).slice(0, 5)} (${DIAS[dataLocal(i.data).getDay()]})` : (i.dataPrevista || 'a definir');
    const leva = i.transporte === 'comercial' || i.transporte === 'outro' ? `leva: ${nomeProprio(i.motorista)}` : (i.transporte === 'verificar' ? 'transporte: A VERIFICAR' : TRANSPORTE_LABEL[i.transporte]);
    const partes = [quando + (i.horario ? ` ${i.horario}` : ''), `${i.local} (${i.cidade})`, i.palestrante, i.tema, leva];
    linhas.push(`• ${partes.filter(Boolean).join(' – ')}${i.status === 'realizada' ? ' ✅' : ''}`);
  });
  const txt = linhas.join('\n');
  try { await navigator.clipboard.writeText(txt); } catch (e) {
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  showToast(`Agenda copiada (${lista.length} palestras).`);
}
