// ================================================================
//  ÓRBITA — PLANO DE AÇÃO DOS COORDENADORES (Docência, 21/10/2026)
//  Coordenador: marca o que fez (diárias do dia, semanais da semana,
//  mensais do mês e prazos do semestre) e vê o que está atrasado.
//  Direção Acadêmica (ADM N1/N2): acompanha por coordenação, edita as
//  atividades e define as datas que o calendário do Edubox não deu.
//  Regra das datas em periodos.js; servidor em src/rotas/plano-acao.js.
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { getEffectiveLevel } from "../../core/permissions.js";
import {
  PERIODICIDADE_LABEL, COM_PRAZO, conta, periodosDa, semPrazo, status, resumo, pct,
  letivo, segundaDa, somaDias, fmtData, nomeMes
} from "./periodos.js";
import {
  ligarDocumentos, renderListaDirecao, blocoParaAssinar, renderDocumentoResponsavel, renderAssinaturas,
  tratarClique, temDocumentoAberto, fecharDocumento, limparDocumentos
} from "./documentos.js?v=17";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
  ? `http://${location.hostname}:3000/api`
  : '/api';

const MODULO = 'plano-acao';
const NIVEL_PADRAO = { adm_l2: 3, coordenador: 3 };
const RESP_LABEL = { coordenador: 'Coordenador', administrativo: 'Administrativo', ambos: 'Coordenador e administrativo' };
const CURSO_NOME = {
  agronegocio: 'Agronegócio', agronomia: 'Agronomia', 'arquitetura-urbanismo': 'Arquitetura e Urbanismo', biomedicina: 'Biomedicina',
  contabeis: 'Ciências Contábeis', direito: 'Direito', rh: 'Recursos Humanos', enfermagem: 'Enfermagem', 'engenharia-civil': 'Engenharia Civil',
  fisioterapia: 'Fisioterapia', 'gestao-comercial': 'Gestão Comercial', 'gestao-financeira': 'Gestão Financeira', logistica: 'Logística',
  medicina: 'Medicina', 'medicina-veterinaria': 'Medicina Veterinária', pedagogia: 'Pedagogia', psicologia: 'Psicologia'
};
const DIA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const $ = id => document.getElementById(id);

let currentUser = null;
let appInitialized = false;
let initializedRole = null;

let ctx = null;            // /contexto: atividades, semestre, coordenadores, direcao, hoje
let marcas = {};           // marcas do coordenador que está na tela
let painel = null;         // Direção: { porUid }
let aba = 'painel';
let verUid = null;         // Direção olhando o plano de um coordenador
let diaSel = null;         // dia escolhido na régua
let verAtrasadas = false;
let filtroTipo = 'todas';  // aba Atividades e prazos
let agenda = {};           // compromissos por semana: { 'uid|segunda': [itens] }
let tarefas = {};          // atividades definidas (Direção ou o próprio): { uid: [..] }
let tarefasTodas = null;   // Direção: todas, pro painel
const ORIGEM_LABEL = {
  'meu-espaco': 'Meu Espaço', 'agenda-interna': 'Agenda Interna', tarefa: 'Atividade do Plano de Ação', palestras: 'Palestra · Comercial', auloes: 'Aulão · Comercial',
  curso: 'Evento do curso', calendario: 'Calendário acadêmico'
};

// ---------------- infraestrutura ----------------

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}

let toastTimer;
function toast(msg, tipo = '') {
  const t = $('pa-toast');
  t.textContent = msg;
  t.className = `pa-toast ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

const tela = () => $('pa-tela');
const sem = () => ctx && ctx.semestre;
const ativas = () => ctx.atividades.filter(a => a.ativo !== false);
const nomeCursos = (ids) => ids.map(c => CURSO_NOME[c] || c).join(', ');
const dataHora = (s) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function semestreAtual() {
  const d = new Date();
  return `${d.getFullYear()}.${d.getMonth() < 6 ? 1 : 2}`;
}

// ---------------- modal ----------------

let modalOk = null;
function abrirModal(titulo, corpoHtml, aoSalvar, rotuloOk = 'Salvar') {
  $('pa-modal-titulo').textContent = titulo;
  $('pa-modal-corpo').innerHTML = corpoHtml;
  $('pa-modal-ok').textContent = rotuloOk;
  $('pa-modal-ok').classList.toggle('hidden', !aoSalvar);
  $('pa-modal-cancelar').textContent = aoSalvar ? 'Cancelar' : 'Fechar';
  modalOk = aoSalvar;
  $('pa-modal').classList.remove('hidden');
  const primeiro = $('pa-modal-corpo').querySelector('input, textarea, select');
  if (primeiro) primeiro.focus();
}
function fecharModal() { $('pa-modal').classList.add('hidden'); modalOk = null; }

// ---------------- carregamento ----------------

async function carregar() {
  const s = $('pa-semestre').value;
  tela().innerHTML = '<p class="pa-vazio">Carregando...</p>';
  agenda = {};
  limparDocumentos();
  tarefas = {};
  tarefasTodas = null;
  try {
    ctx = await apiFetch(`/${MODULO}/contexto?semestre=${encodeURIComponent(s)}`);
    if (!sem()) {
      tela().innerHTML = `<div class="pa-card pa-vazio-card"><h2 class="pa-card-titulo">O semestre ${esc(s)} ainda não foi carregado</h2><p>As datas vêm do calendário acadêmico do Edubox. Peça pra TI carregar o calendário deste semestre.</p></div>`;
      return;
    }
    $('pa-abas').classList.toggle('hidden', !ctx.direcao);
    $('pa-subtitulo').textContent = ctx.direcao
      ? 'Acompanhamento das coordenações de curso'
      : 'Suas atividades como coordenador de curso';
    diaSel = diaPadrao();
    if (ctx.direcao) {
      [painel, tarefasTodas] = await Promise.all([
        apiFetch(`/${MODULO}/painel?semestre=${encodeURIComponent(s)}`),
        apiFetch(`/${MODULO}/tarefas?todos=1`).then(r => r.tarefas)
      ]);
    } else {
      marcas = (await apiFetch(`/${MODULO}/marcas?semestre=${encodeURIComponent(s)}`)).marcas;
    }
    render();
  } catch (e) {
    tela().innerHTML = `<div class="pa-card pa-erro">${esc(e.message)}</div>`;
  }
}

// hoje, se estiver dentro do semestre; senão o último dia do semestre
function diaPadrao() {
  const s = sem();
  if (ctx.hoje < s.inicio) return s.inicio;
  if (ctx.hoje > s.fim) return s.fim;
  return ctx.hoje;
}

function render() {
  if (!ctx || !sem()) return;
  if (!ctx.direcao) return temDocumentoAberto() ? renderDocumentoResponsavel(tela()) : renderPlano(ctx.uid, false);
  document.querySelectorAll('#pa-abas .aba').forEach(b => {
    const ativa = b.dataset.aba === aba;
    b.classList.toggle('ativa', ativa);
    b.setAttribute('aria-selected', ativa);
  });
  if (aba === 'painel') return verUid ? renderPlano(verUid, true) : renderPainel();
  if (aba === 'atividades') return renderAtividades();
  if (aba === 'documentos') return renderListaDirecao(tela());
  if (aba === 'assinaturas') return renderAssinaturas(tela());
  return renderCalendario();
}

// ================================================================
//  PLANO DO COORDENADOR (o próprio, ou a Direção olhando, só leitura)
// ================================================================

// Compromissos da semana (seg–dom) do coordenador — Meu Espaço, Comercial e
// calendário acadêmico (GET /agenda). Busca uma vez por semana e guarda.
async function carregarAgenda(uid, seg) {
  const chave = `${uid}|${seg}`;
  if (agenda[chave]) return agenda[chave];
  const q = `semestre=${encodeURIComponent(sem().id)}&de=${seg}&ate=${somaDias(seg, 6)}${uid !== ctx.uid ? `&uid=${encodeURIComponent(uid)}` : ''}`;
  try { agenda[chave] = (await apiFetch(`/${MODULO}/agenda?${q}`)).itens; }
  catch (e) { agenda[chave] = []; toast(`Agenda: ${e.message}`, 'erro'); }
  return agenda[chave];
}

const doDia = (itens, d) => itens.filter(i => i.inicio ? (i.inicio <= d && i.fim >= d) : i.data === d);

function renderPlano(uid, somenteLeitura) {
  const chave = `${uid}|${segundaDa(diaSel)}`;
  if (!agenda[chave]) {
    carregarAgenda(uid, segundaDa(diaSel)).then(() => { if (segundaDa(diaSel) === chave.split('|')[1]) render(); });
  }
  if (!tarefas[uid]) {
    apiFetch(`/${MODULO}/tarefas${uid !== ctx.uid ? `?uid=${encodeURIComponent(uid)}` : ''}`)
      .then(r => { tarefas[uid] = r.tarefas; render(); })
      .catch(e => { tarefas[uid] = []; toast(e.message, 'erro'); });
  }
  const minhas = tarefas[uid] || [];
  const seg0 = segundaDa(diaSel), dom0 = somaDias(seg0, 6);
  const itensSemana = agenda[chave] ? [...agenda[chave], ...minhas.filter(t => t.data >= seg0 && t.data <= dom0).map(t => ({
    data: t.data, hora: t.hora, titulo: t.hora ? t.titulo : `Prazo: ${t.titulo}`, descricao: t.descricao, origem: 'tarefa',
    por: t.criadoPor === uid ? '' : t.criadoPorNome, feito: t.feito
  }))] : null;
  const s = sem();
  const m = somenteLeitura ? ((painel && painel.porUid[uid]) || {}) : marcas;
  const coord = somenteLeitura ? ctx.coordenadores.find(c => c.uid === uid) : null;
  const r = resumo(ctx.atividades, s, m, ctx.hoje);
  somarTarefas(r, minhas);
  const inicioConta = s.inicioAcompanhamento > s.inicio ? s.inicioAcompanhamento : s.inicio;

  let html = '';
  if (somenteLeitura) {
    html += `<div class="pa-voltar"><button type="button" class="btn-secondary" data-acao="voltar">Voltar ao acompanhamento</button>
      <div><h2 class="pa-coord-nome">${esc(coord ? coord.nome : '')}</h2><span class="pa-mudo">${esc(coord ? nomeCursos(coord.cursos) : '')}</span></div></div>`;
  }

  if (!somenteLeitura) html += blocoParaAssinar();

  // agenda da semana em grade (estilo Google Agenda): compromissos com data
  // vindos dos outros módulos — o Órbita interligado (pedido 21/10/2026)
  html += gradeSemana(itensSemana, uid, somenteLeitura);

  html += `<div class="pa-resumo">
      <span><b>${pct(r.total) ?? '—'}${pct(r.total) === null ? '' : '%'}</b> das tarefas em dia desde ${fmtData(inicioConta)}</span>
      <span class="pa-sep" aria-hidden="true"></span>
      <span>${r.total.feitos} feitas de ${r.total.devidos} que já venceram</span>
      ${r.total.atrasados ? `<button type="button" class="pa-link-atraso" data-acao="atrasadas" aria-expanded="${verAtrasadas}">${r.total.atrasados} atrasada${r.total.atrasados > 1 ? 's' : ''}</button>` : '<span class="pa-ok">Nada atrasado</span>'}
    </div>`;

  if (verAtrasadas && r.total.atrasados) html += blocoAtrasadas(m, somenteLeitura);

  const dia = diaSel;
  const seg = segundaDa(dia);
  const mes = dia.slice(0, 7);

  // obrigações diárias: rotina fixa, só pra consulta
  const rotina = ativas().filter(a => a.periodicidade === 'diario');
  let rotinaHtml = '';
  if (rotina.length) {
    rotinaHtml = `<details class="pa-card pa-rotina"><summary class="pa-card-titulo">Obrigações diárias <span class="pa-mudo">(${rotina.length} · rotina fixa, não precisa marcar)</span></summary>
      <ul class="pa-rotina-lista">${rotina.map(a => `<li>${esc(a.titulo)}${tagResp(a)}${a.detalhe ? `<details class="pa-detalhe"><summary>Como fazer</summary>${esc(a.detalhe)}</details>` : ''}</li>`).join('')}</ul></details>`;
  }

  html += '<div class="pa-tarefas"><div class="pa-tarefas-col">';
  html += secao('Atividades definidas', listaTarefas(minhas, uid, somenteLeitura));
  // semanais
  const semanais = ativas().filter(a => a.periodicidade === 'semanal');
  const pSem = (a) => periodosDa(a, s).find(p => p.periodo === seg);
  const itensSem = semanais.map(a => ({ a, p: pSem(a) })).filter(x => x.p);
  html += secao(`Semanais <span class="pa-secao-prazo">até sexta, ${fmtData(somaDias(seg, 4)).slice(0, 5)}</span>`,
    itensSem.length ? lista(itensSem, m, somenteLeitura) : '<p class="pa-mudo">Semana fora do acompanhamento.</p>');

  // mensais
  const mensais = ativas().filter(a => a.periodicidade === 'mensal');
  const itensMes = mensais.map(a => ({ a, p: periodosDa(a, s).find(p => p.periodo === mes) })).filter(x => x.p);
  html += secao(`Mensais de ${nomeMes(mes)}${itensMes.length ? ` <span class="pa-secao-prazo">até ${fmtData(itensMes[0].p.prazo).slice(0, 5)}</span>` : ''}`,
    itensMes.length ? lista(itensMes, m, somenteLeitura) : '<p class="pa-mudo">Mês fora do acompanhamento.</p>');

  html += '</div><div class="pa-tarefas-col">';
  // prazos do semestre
  const comPrazo = ativas().filter(a => COM_PRAZO.includes(a.periodicidade));
  const itensPrazo = [];
  comPrazo.forEach(a => periodosDa(a, s).forEach(p => itensPrazo.push({ a, p })));
  itensPrazo.sort((x, y) => x.p.prazo.localeCompare(y.p.prazo));
  const semData = comPrazo.filter(a => semPrazo(a, s));
  html += secao(`Prazos do semestre ${esc(s.id)}`,
    (itensPrazo.length ? lista(itensPrazo, m, somenteLeitura, x => `${PERIODICIDADE_LABEL[x.a.periodicidade]} · até ${fmtData(x.p.prazo)}${x.p.evento ? ` (${frase(x.p.evento)})` : ''}`) : '') +
    (semData.length ? `<details class="pa-semdata"><summary>${semData.length} atividade${semData.length > 1 ? 's' : ''} ainda sem data (a Direção vai definir)</summary><ul class="pa-lista">${semData.map(a => `
      <li class="pa-item st-semdata"><span class="pa-check pa-check-off" aria-hidden="true"></span>
        <div class="pa-item-texto"><span class="pa-titulo">${esc(a.titulo)}</span>${tagResp(a)}
        <div class="pa-meta">${PERIODICIDADE_LABEL[a.periodicidade]} · sem data no calendário acadêmico</div></div></li>`).join('')}</ul></details>` : ''));
  html += '</div></div>';
  html += rotinaHtml;

  tela().innerHTML = html;
}

// ---------- grade da semana ----------
// Coordenador trabalha à noite (pedido 21/10/2026): a grade mostra só 18h30–22h30,
// com a hora bem alta; o que acontece de dia vai pra linha "fora da noite".
const PX_HORA = 84;
const NOITE_INI = 18 * 60 + 30, NOITE_FIM = 22 * 60 + 30;
let eventosTela = [];      // compromissos desenhados na grade (o clique abre o detalhe)

const minutos = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Fim do compromisso: a reserva da Agenda Interna traz "19:30–22:30" na
// descrição; sem isso, 1h (palestra/aulão 1h30).
function duracao(i) {
  if (i.fimHora && minutos(i.fimHora) > minutos(i.hora)) return minutos(i.fimHora) - minutos(i.hora);
  const m = /(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/.exec(`${i.descricao || ''} ${i.titulo || ''}`);
  if (m && minutos(m[2]) > minutos(i.hora)) return minutos(m[2]) - minutos(i.hora);
  return ['palestras', 'auloes'].includes(i.origem) ? 90 : 60;
}

// Compromissos que se cruzam no mesmo dia ficam lado a lado.
function emColunas(lista) {
  const ord = [...lista].sort((a, b) => a.ini - b.ini || b.fim - a.fim);
  let grupo = [], fimGrupo = -1;
  const fecha = () => { const n = Math.max(...grupo.map(e => e.col)) + 1; grupo.forEach(e => { e.cols = n; }); grupo = []; };
  ord.forEach(e => {
    if (grupo.length && e.ini >= fimGrupo) fecha();
    const ocupadas = grupo.filter(g => g.fim > e.ini).map(g => g.col);
    let c = 0; while (ocupadas.includes(c)) c++;
    e.col = c; grupo.push(e); fimGrupo = Math.max(fimGrupo, e.fim);
  });
  if (grupo.length) fecha();
  return ord;
}

function gradeSemana(itensSemana, uidPlano, somenteLeitura) {
  const s = sem();
  const seg = segundaDa(diaSel);
  const itens = itensSemana || [];
  const comHora = itens.filter(i => i.hora);
  const diaTodo = itens.filter(i => !i.hora);
  // trabalham de segunda a sexta; sábado e domingo só aparecem quando tem
  // compromisso dele no dia (evento geral do calendário que atravessa o fim de semana não conta)
  const temNoDia = (d) => comHora.some(i => i.data === d) || diaTodo.some(i => i.origem !== 'calendario' && (i.inicio || i.data) <= d && (i.fim || i.data) >= d);
  const dias = [0, 1, 2, 3, 4, 5, 6].map(k => somaDias(seg, k)).filter((d, k) => k < 5 || temNoDia(d));
  const ultimo = dias[dias.length - 1];

  eventosTela = [];
  const evs = comHora.filter(i => i.data >= seg && i.data <= ultimo).map(i => {
    const ini = minutos(i.hora);
    const e = { i, dia: i.data, ini, fim: ini + duracao(i), idx: eventosTela.length };
    eventosTela.push(i);
    return e;
  });
  const h0 = NOITE_INI / 60, h1 = NOITE_FIM / 60;
  const altura = (h1 - h0) * PX_HORA;
  const daNoite = (e) => e.fim > NOITE_INI && e.ini < NOITE_FIM;
  const foraDaNoite = evs.filter(e => !daNoite(e));
  const linhaFora = foraDaNoite.length ? `<div class="pa-cs-fora"><div class="pa-cs-canto">fora da noite</div>${dias.map(d => `<div class="pa-cs-fora-dia">${
    foraDaNoite.filter(e => e.dia === d).sort((a, b) => a.ini - b.ini).map(e => `<button type="button" class="pa-ev-fora pa-ev-${e.i.origem}${e.i.feito ? ' feito' : ''}" data-ev="${e.idx}" title="${esc(e.i.titulo)}"><b>${hhmm(e.ini)}</b> ${esc(e.i.titulo)}</button>`).join('')
  }</div>`).join('')}</div>` : '';

  const fimSemana = somaDias(seg, 6);
  const rotuloSemana = `${Number(seg.slice(8))}${seg.slice(5, 7) !== ultimo.slice(5, 7) ? ` de ${nomeMes(seg.slice(0, 7)).split(' ')[0]}` : ''} a ${Number(ultimo.slice(8))} de ${nomeMes(ultimo.slice(0, 7))}`;
  const podeVoltar = somaDias(seg, -1) >= s.inicio;
  const podeIr = somaDias(seg, 7) <= s.fim;
  const nesta = segundaDa(ctx.hoje) === seg;

  const cab = dias.map(d => {
    const w = new Date(d + 'T12:00').getDay();
    const nl = (s.naoLetivos || {})[d];
    return `<div class="pa-cs-dia${d === ctx.hoje ? ' hoje' : ''}${nl || d < s.inicio || d > s.fim ? ' off' : ''}">
      <span class="pa-cs-dsem">${DIA_SEMANA[w]}</span><span class="pa-cs-dnum">${Number(d.slice(8))}</span>
      ${nl ? `<span class="pa-cs-feriado" title="${esc(nl)}">${esc(nl.split(' – ')[0].toLowerCase())}</span>` : ''}</div>`;
  }).join('');

  // faixa de dia inteiro (eventos do calendário acadêmico, às vezes vários dias)
  const faixa = diaTodo.map(i => {
    const a = (i.inicio || i.data) < seg ? seg : (i.inicio || i.data);
    const b = (i.fim || i.data) > ultimo ? ultimo : (i.fim || i.data);
    const c0 = dias.indexOf(a), c1 = dias.indexOf(b);
    if (c0 < 0 || c1 < 0) return '';
    const idx = eventosTela.length; eventosTela.push(i);
    return `<button type="button" class="pa-ev-dia pa-ev-${i.origem}" data-ev="${idx}" style="grid-column:${c0 + 1} / ${c1 + 2}" title="${esc(i.titulo)}${i.descricao ? ` — ${esc(i.descricao)}` : ''}">${esc(i.titulo.toLowerCase().replace(/^./, c => c.toUpperCase()))}${i.descricao ? ` <span>${esc(i.descricao.toLowerCase())}</span>` : ''}</button>`;
  }).join('');

  const horas = Array.from({ length: (NOITE_FIM - NOITE_INI) / 30 }, (_, k) => {
    const m = NOITE_INI + k * 30;
    return `<span class="${m % 60 ? 'meia' : ''}" style="top:${k * PX_HORA / 2}px">${hhmm(m)}</span>`;
  }).join('');
  const agora = new Date();
  const minAgora = agora.getHours() * 60 + agora.getMinutes();
  const colunas = dias.map(d => {
    // começa antes das 18h ou passa das 23h: corta na borda da grade
    const doD = emColunas(evs.filter(e => e.dia === d && daNoite(e)).map(e => ({ ...e, ini: Math.max(e.ini, NOITE_INI), fim: Math.min(e.fim, NOITE_FIM), iniReal: e.ini, fimReal: e.fim })));
    const blocos = doD.map(e => {
      const top = (e.ini - h0 * 60) / 60 * PX_HORA;
      const alt = Math.max((e.fim - e.ini) / 60 * PX_HORA - 3, 26);
      const larg = 100 / e.cols;
      return `<button type="button" class="pa-ev pa-ev-${e.i.origem}${e.i.feito ? ' feito' : ''}${e.i.confirmar ? ' confirmar' : ''}" data-ev="${e.idx}"
          style="top:${top}px;height:${alt}px;left:calc(${larg * e.col}% + 2px);width:calc(${larg}% - 4px)"
          title="${esc(e.i.titulo)}${e.i.pendente ? ' (aguardando aprovação)' : ''}"><b>${hhmm(e.iniReal)}–${hhmm(e.fimReal)}</b> ${esc(e.i.titulo)}${alt > 70 && e.i.descricao ? `<small>${esc(e.i.descricao)}</small>` : ''}</button>`;
    }).join('');
    const linhaAgora = d === ctx.hoje && minAgora >= h0 * 60 && minAgora <= h1 * 60
      ? `<span class="pa-cs-agora" style="top:${(minAgora - h0 * 60) / 60 * PX_HORA}px" aria-hidden="true"></span>` : '';
    const nl = (s.naoLetivos || {})[d];
    return `<div class="pa-cs-col${d === ctx.hoje ? ' hoje' : ''}${nl ? ' off' : ''}">${blocos}${linhaAgora}</div>`;
  }).join('');

  const vazio = itensSemana && !itens.length
    ? '<p class="pa-cs-vazio">Nenhum compromisso nesta semana. Reuniões marcadas no Meu Espaço, reservas da Agenda Interna, palestras e aulões do Comercial com o seu nome e eventos do calendário acadêmico aparecem aqui.</p>' : '';

  return `<section class="pa-card pa-cs" style="--dias:${dias.length}">
    <div class="pa-cs-topo">
      <div class="pa-cs-nav">
        <button type="button" class="pa-cs-btn" data-acao="hoje" ${nesta ? 'disabled' : ''}>Hoje</button>
        <button type="button" class="pa-cs-seta" data-semana="-7" ${podeVoltar ? '' : 'disabled'} aria-label="Semana anterior">‹</button>
        <button type="button" class="pa-cs-seta" data-semana="7" ${podeIr ? '' : 'disabled'} aria-label="Próxima semana">›</button>
        <h3 class="pa-cs-titulo">${rotuloSemana}</h3>
      </div>
      ${!somenteLeitura || ctx.direcao ? `<button type="button" class="btn-primary pa-cs-nova" data-nova-tarefa="${esc(uidPlano)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Nova atividade</button>` : ''}
      <div class="pa-cs-legenda" aria-label="Legenda">
        <span class="lg lg-meu-espaco">Meu Espaço e Agenda Interna</span><span class="lg lg-palestras">Palestra e aulão</span><span class="lg lg-curso">Evento do curso</span><span class="lg lg-calendario">Calendário acadêmico</span>
      </div>
    </div>
    ${itensSemana ? '' : '<p class="pa-cs-vazio">Carregando a agenda...</p>'}${vazio}
    <div class="pa-cs-grade">
      <div class="pa-cs-cab"><div class="pa-cs-canto"></div>${cab}</div>
      ${faixa ? `<div class="pa-cs-faixa"><div class="pa-cs-canto">dia todo</div><div class="pa-cs-faixa-itens">${faixa}</div></div>` : ''}
      ${linhaFora}
      <div class="pa-cs-corpo" style="height:${altura}px; --px-hora:${PX_HORA}px">
        <div class="pa-cs-horas">${horas}</div>${colunas}
      </div>
    </div>
  </section>`;
}

// ---------- atividades definidas ----------
// Atividade vencida e não concluída conta como atrasada (no resumo e no painel).
function somarTarefas(r, lista) {
  const t = { devidos: 0, feitos: 0, atrasados: 0 };
  lista.forEach(x => {
    if (x.data > ctx.hoje && !x.feito) return;
    t.devidos++;
    if (x.feito) t.feitos++; else if (x.data < ctx.hoje) t.atrasados++;
  });
  r.por.tarefa = t;
  r.total.devidos += t.devidos; r.total.feitos += t.feitos; r.total.atrasados += t.atrasados;
  return r;
}

function listaTarefas(lista, uid, somenteLeitura) {
  const abertas = lista.filter(t => !t.feito).sort((a, b) => a.data.localeCompare(b.data) || (a.hora || '99').localeCompare(b.hora || '99'));
  const feitas = lista.filter(t => t.feito).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 15);
  const item = (t) => {
    const atrasada = !t.feito && t.data < ctx.hoje;
    const quem = t.criadoPor === uid ? 'criada por você' : `definida por ${nomeCurto(t.criadoPorNome)}`;
    const podeMarcar = !somenteLeitura && t.criadoPor !== undefined;
    const podeExcluir = t.criadoPor === ctx.uid || ctx.direcao;
    const check = podeMarcar
      ? `<button type="button" class="pa-check ${t.feito ? 'on' : ''}" data-tarefa="${esc(t.id)}" aria-pressed="${t.feito}" aria-label="${t.feito ? 'Reabrir' : 'Marcar como feita'}: ${esc(t.titulo)}"></button>`
      : `<span class="pa-check ${t.feito ? 'on' : ''}" aria-hidden="true"></span>`;
    return `<li class="pa-item st-${t.feito ? 'feito' : atrasada ? 'atrasado' : 'afazer'}">${check}
      <div class="pa-item-texto"><span class="pa-titulo">${esc(t.titulo)}</span>${t.daDirecao ? '<span class="pa-tag pa-tag-dir">Direção</span>' : ''}
        <div class="pa-meta">${t.hora ? `${fmtData(t.data)} às ${esc(t.hora)}` : `até ${fmtData(t.data)}`} · ${esc(quem)}${t.feito && t.concluidoEm ? ` · feita em ${dataHora(t.concluidoEm)}` : atrasada ? ' · atrasada' : ''}</div>
        ${t.descricao ? `<div class="pa-obs-texto">${esc(t.descricao)}</div>` : ''}</div>
      ${podeExcluir ? `<button type="button" class="pa-btn-icone pa-btn-icone-perigo" data-excluir-tarefa="${esc(t.id)}" aria-label="Excluir: ${esc(t.titulo)}" title="Excluir"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>` : ''}</li>`;
  };
  if (!lista.length) return `<p class="pa-mudo">${somenteLeitura ? 'Nenhuma atividade definida pra este coordenador.' : 'Nenhuma atividade ainda. Use "Nova atividade" na agenda pra criar uma com prazo.'}</p>`;
  return `${abertas.length ? `<ul class="pa-lista">${abertas.map(item).join('')}</ul>` : '<p class="pa-ok">Tudo feito.</p>'}
    ${feitas.length ? `<details class="pa-feitas"><summary>${feitas.length} feita${feitas.length > 1 ? 's' : ''}</summary><ul class="pa-lista">${feitas.map(item).join('')}</ul></details>` : ''}`;
}

function novaTarefa(uidAlvo) {
  const paraOutro = ctx.direcao;
  const coords = ctx.coordenadores || [];
  const escolha = paraOutro ? `
    <fieldset class="pa-para"><legend>Para quem</legend>
      <label class="pa-check-linha"><input type="checkbox" id="pa-t-todos"> Todos os coordenadores</label>
      <div class="pa-para-lista">${coords.map(c => `<label class="pa-check-linha"><input type="checkbox" class="pa-t-uid" value="${esc(c.uid)}" ${c.uid === uidAlvo ? 'checked' : ''}> ${esc(c.nome)} <span class="pa-mudo">${esc(nomeCursos(c.cursos))}</span></label>`).join('')}</div>
    </fieldset>` : '';
  abrirModal(paraOutro ? 'Nova atividade para coordenador' : 'Nova atividade na minha agenda', `
    <label class="pa-campo">Atividade<input type="text" id="pa-t-titulo" maxlength="200" placeholder="Ex.: Entregar o relatório do NDE"></label>
    <label class="pa-campo">Detalhes (opcional)<textarea id="pa-t-desc" rows="3" maxlength="1500"></textarea></label>
    <div class="pa-campos-2">
      <label class="pa-campo">Data ou prazo<input type="date" id="pa-t-data" value="${esc(ctx.hoje)}" ${paraOutro ? '' : `min="${esc(ctx.hoje)}"`}></label>
      <label class="pa-campo">Horário (opcional)<input type="time" id="pa-t-hora"></label>
    </div>
    <p class="pa-mudo">Sem horário, vale como prazo: precisa ser feita até o fim do dia. Com horário, entra na agenda naquele horário (ex.: reunião). Aparece também no Meu Espaço.</p>
    ${escolha}`, async () => {
    const body = {
      titulo: $('pa-t-titulo').value, descricao: $('pa-t-desc').value, data: $('pa-t-data').value, hora: $('pa-t-hora').value,
      uids: paraOutro ? [...document.querySelectorAll('.pa-t-uid:checked')].map(i => i.value) : undefined
    };
    try {
      const r = await apiFetch(`/${MODULO}/tarefas`, { method: 'POST', body: JSON.stringify(body) });
      r.tarefas.forEach(t => {
        if (tarefas[t.uid]) tarefas[t.uid].push(t);
        if (tarefasTodas) tarefasTodas.push(t);
      });
      fecharModal();
      render();
      toast(r.criadas > 1 ? `Atividade criada para ${r.criadas} coordenadores.` : 'Atividade criada.');
    } catch (e) { toast(e.message, 'erro'); }
  }, 'Criar atividade');
  const todos = $('pa-t-todos');
  if (todos) todos.addEventListener('change', () => document.querySelectorAll('.pa-t-uid').forEach(i => { i.checked = todos.checked; }));
}

async function concluirTarefa(id) {
  const lista = tarefas[ctx.uid] || [];
  const t = lista.find(x => x.id === id);
  if (!t) return;
  try {
    const nova = await apiFetch(`/${MODULO}/tarefas/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ feito: !t.feito }) });
    Object.assign(t, nova);
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function excluirTarefa(id) {
  if (!confirm('Excluir esta atividade? Ela sai também do Meu Espaço.')) return;
  try {
    await apiFetch(`/${MODULO}/tarefas/${encodeURIComponent(id)}`, { method: 'DELETE' });
    Object.keys(tarefas).forEach(u => { tarefas[u] = tarefas[u].filter(t => t.id !== id); });
    if (tarefasTodas) tarefasTodas = tarefasTodas.filter(t => t.id !== id);
    render();
    toast('Atividade excluída.');
  } catch (e) { toast(e.message, 'erro'); }
}

function detalheEvento(idx) {
  const i = eventosTela[idx];
  if (!i) return;
  const periodo = i.inicio && i.fim !== i.inicio ? `${fmtData(i.inicio)} a ${fmtData(i.fim)}` : fmtData(i.data);
  const origem = ORIGEM_LABEL[i.origem] + (i.origem === 'meu-espaco' && i.por ? ` · marcado por ${nomeCurto(i.por)}` : '') + (i.motivo ? ` · ${i.motivo}` : '');
  abrirModal(i.titulo, `
    <p class="pa-det-quando">${esc(periodo)}${i.hora ? ` · ${esc(i.hora)}` : ' · dia todo'}</p>
    ${i.descricao ? `<p class="pa-det-desc">${esc(i.descricao)}</p>` : ''}
    <p class="pa-mudo">${esc(origem)}${i.feito ? ' · concluído' : ''}</p>
    ${i.confirmar ? `<p class="pa-ag-confirmar">${esc(i.confirmar)}</p>` : ''}`, null);
}

const SIGLAS = new Set(['CPA', 'NDE', 'EAD', 'CADD', 'CONSUP', 'MAC', 'ICAA', 'NEAD', 'DP', 'ENADE', 'ENEM', 'NAPA', 'CODI', 'PIT', 'RIAD', 'IES', 'TCC', 'MEC', 'FATEC']);
// "SEMANA DE INTEGRAÇÃO PEDAGÓGICA" → "Semana de integração pedagógica"; "REUNIÃO DA CPA" → "Reunião da CPA"
function frase(t) {
  const txt = String(t || '').trim().replace(/\.$/, '');
  if (!txt || txt !== txt.toUpperCase()) return txt;
  const out = txt.toLowerCase().replace(/[a-zà-ú0-9]+/g, w => SIGLAS.has(w.toUpperCase()) ? w.toUpperCase() : w);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const nomeCurto = (n) => (n || '').trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');

function secao(titulo, corpo) {
  return `<section class="pa-card"><h3 class="pa-card-titulo">${titulo}</h3>${corpo}</section>`;
}

function tagResp(a) {
  if (a.responsavel === 'administrativo') return '<span class="pa-tag pa-tag-adm" title="Atividade do administrativo da coordenação">Adm</span>';
  if (a.responsavel === 'ambos') return '<span class="pa-tag pa-tag-adm" title="Coordenador e administrativo">Coord. e adm</span>';
  return '';
}

function lista(itens, m, somenteLeitura, metaExtra) {
  if (!itens.length) return '<p class="pa-mudo">Nenhuma atividade.</p>';
  return `<ul class="pa-lista">${itens.map(x => {
    const st = status(x.a, x.p, m, ctx.hoje);
    const chave = `${x.a.id}|${x.p.periodo}`;
    const metas = [];
    if (metaExtra) metas.push(esc(metaExtra(x)));
    if (st.tipo === 'feito') metas.push(`feita em ${dataHora(st.marca.em)}${st.marca.em.slice(0, 10) > x.p.prazo ? ' (com atraso)' : ''}`);
    if (st.tipo === 'atrasado') metas.push('atrasada');
    const obs = st.tipo === 'feito' && st.marca.obs ? `<div class="pa-obs-texto">${esc(st.marca.obs)}</div>` : '';
    const detalhe = x.a.detalhe ? `<details class="pa-detalhe"><summary>Como fazer</summary>${esc(x.a.detalhe)}</details>` : '';
    const futuro = ['diario', 'semanal', 'mensal'].includes(x.a.periodicidade) && x.p.periodo > ctx.hoje.slice(0, x.p.periodo.length);
    const check = somenteLeitura
      ? `<span class="pa-check ${st.tipo === 'feito' ? 'on' : ''}" aria-label="${st.tipo === 'feito' ? 'Feita' : 'Não feita'}"></span>`
      : `<button type="button" class="pa-check ${st.tipo === 'feito' ? 'on' : ''}" data-marcar="${esc(chave)}" aria-pressed="${st.tipo === 'feito'}" aria-label="${st.tipo === 'feito' ? 'Desmarcar' : 'Marcar como feita'}: ${esc(x.a.titulo)}" ${futuro ? 'disabled title="Ainda não chegou esse dia"' : ''}></button>`;
    const btnObs = !somenteLeitura && st.tipo === 'feito'
      ? `<button type="button" class="pa-btn-obs" data-obs="${esc(chave)}">${st.marca.obs ? 'Editar observação' : 'Observação'}</button>` : '';
    return `<li class="pa-item st-${st.tipo}">${check}
      <div class="pa-item-texto"><p class="pa-linha-titulo"><span class="pa-titulo">${esc(x.a.titulo)}</span>${tagResp(x.a)}</p>
        ${metas.length ? `<div class="pa-meta">${metas.join(' · ')}</div>` : ''}${obs}${detalhe}</div>${btnObs}</li>`;
  }).join('')}</ul>`;
}

// Atrasadas agrupadas por atividade, cada período vira um botão (marca com atraso).
function blocoAtrasadas(m, somenteLeitura) {
  const s = sem();
  const grupos = [];
  ctx.atividades.filter(conta).forEach(a => {
    if (semPrazo(a, s)) return;
    const atrasos = periodosDa(a, s).filter(p => p.prazo < ctx.hoje && !m[`${a.id}|${p.periodo}`]);
    if (atrasos.length) grupos.push({ a, atrasos });
  });
  return `<section class="pa-card pa-atrasadas"><h3 class="pa-card-titulo">Atrasadas</h3>
    <p class="pa-mudo">${somenteLeitura ? 'Períodos que venceram sem marcação.' : 'Se você fez e esqueceu de marcar, clique no período pra marcar agora (fica registrado como feita com atraso).'}</p>
    <ul class="pa-lista">${grupos.map(g => `
      <li class="pa-item st-atrasado"><span class="pa-contagem">${g.atrasos.length}</span>
        <div class="pa-item-texto"><span class="pa-titulo">${esc(g.a.titulo)}</span>${tagResp(g.a)}
          <div class="pa-periodos">${g.atrasos.map(p => somenteLeitura
            ? `<span class="pa-periodo">${esc(p.rotulo)}</span>`
            : `<button type="button" class="pa-periodo" data-marcar="${esc(`${g.a.id}|${p.periodo}`)}" title="Marcar como feita">${esc(p.rotulo)}</button>`).join('')}</div>
        </div></li>`).join('')}</ul></section>`;
}

async function marcar(chave, feito, obs = '') {
  const [atividadeId, periodo] = chave.split('|');
  try {
    const r = await apiFetch(`/${MODULO}/marcas`, { method: 'PUT', body: JSON.stringify({ semestre: sem().id, atividadeId, periodo, feito, obs }) });
    if (r.marca) marcas[chave] = r.marca; else delete marcas[chave];
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function editarObs(chave) {
  const atual = (marcas[chave] || {}).obs || '';
  const a = ctx.atividades.find(x => x.id === chave.split('|')[0]);
  abrirModal('Observação', `<p class="pa-mudo">${esc(a ? a.titulo : '')}</p>
    <label class="pa-campo">O que foi feito (opcional)<textarea id="pa-obs" rows="4" maxlength="500">${esc(atual)}</textarea></label>`,
  async () => { await marcar(chave, true, $('pa-obs').value); fecharModal(); });
}

// ================================================================
//  DIREÇÃO — ACOMPANHAMENTO POR COORDENAÇÃO
// ================================================================

function renderPainel() {
  const s = sem();
  const inicioConta = s.inicioAcompanhamento > s.inicio ? s.inicioAcompanhamento : s.inicio;
  const linhas = ctx.coordenadores.map(c => ({ c, r: somarTarefas(resumo(ctx.atividades, s, painel.porUid[c.uid] || {}, ctx.hoje), (tarefasTodas || []).filter(t => t.uid === c.uid)) }));
  linhas.sort((x, y) => (pct(x.r.total) ?? 101) - (pct(y.r.total) ?? 101));
  const pend = ativas().filter(a => semPrazo(a, s)).length;
  const celula = (x) => x && x.devidos ? `${x.feitos}/${x.devidos}` : '—';
  const prazos = (r) => {
    const t = { devidos: 0, feitos: 0 };
    ['bimestral', 'semestral', 'anual', 'a_definir'].forEach(k => { if (r.por[k]) { t.devidos += r.por[k].devidos; t.feitos += r.por[k].feitos; } });
    return t;
  };

  tela().innerHTML = `
    <div class="pa-resumo pa-resumo-direcao">
      <span>Contando de ${fmtData(inicioConta)} até hoje, ${fmtData(ctx.hoje)}</span>
      ${pend ? `<span class="pa-sep" aria-hidden="true"></span><button type="button" class="pa-link-pend" data-acao="ir-atividades">${pend} atividade${pend > 1 ? 's' : ''} sem data definida</button>` : ''}
      <button type="button" class="btn-primary pa-imprimir" data-nova-tarefa=""><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Nova atividade para coordenadores</button>
      <button type="button" class="btn-secondary" data-acao="imprimir">Imprimir</button>
    </div>
    <section class="pa-card">
      <div class="pa-print-titulo">Plano de Ação dos Coordenadores — ${esc(s.id)} · situação em ${fmtData(ctx.hoje)}</div>
      <div class="pa-tabela-wrap"><table class="pa-tabela">
        <thead><tr><th scope="col">Coordenação</th><th scope="col">Em dia</th><th scope="col" class="num">Semanais</th><th scope="col" class="num">Mensais</th><th scope="col" class="num">Prazos</th><th scope="col" class="num">Definidas</th><th scope="col" class="num">Atrasadas</th></tr></thead>
        <tbody>${linhas.map(({ c, r }) => {
          const p = pct(r.total);
          const pAtraso = r.total.devidos ? Math.round(r.total.atrasados / r.total.devidos * 100) : 0;
          return `<tr class="pa-linha" data-ver="${esc(c.uid)}" tabindex="0" title="Ver o plano de ${esc(c.nome)}">
            <td><span class="pa-coord">${esc(c.nome)}</span><span class="pa-mudo">${esc(nomeCursos(c.cursos))}</span></td>
            <td class="pa-col-barra"><span class="pa-barra-dupla" aria-hidden="true"><span class="ok" style="width:${p ?? 0}%"></span><span class="nok" style="width:${pAtraso}%"></span></span><b>${p === null ? '—' : `${p}%`}</b></td>
            <td class="num">${celula(r.por.semanal)}</td><td class="num">${celula(r.por.mensal)}</td><td class="num">${celula(prazos(r))}</td><td class="num">${celula(r.por.tarefa)}</td>
            <td class="num ${r.total.atrasados ? 'pa-num-atraso' : ''}">${r.total.atrasados}</td></tr>`;
        }).join('')}</tbody></table></div>
      <p class="pa-mudo pa-legenda">Feitas / esperadas até hoje em cada tipo (o que foi feito antes do prazo já conta). Clique numa coordenação pra ver o plano dela.</p>
    </section>`;
}

// ================================================================
//  DIREÇÃO — ATIVIDADES E PRAZOS
// ================================================================

function renderAtividades() {
  const s = sem();
  const ordemTipos = ['diario', 'semanal', 'mensal', 'bimestral', 'semestral', 'anual', 'a_definir'];
  const rotuloTipo = (t) => t === 'diario' ? 'Obrigação diária' : PERIODICIDADE_LABEL[t];
  const pendentes = ctx.atividades.filter(a => a.ativo !== false && semPrazo(a, s));
  const filtros = [
    { id: 'todas', rotulo: 'Todas', n: ctx.atividades.length },
    ...ordemTipos.map(t => ({ id: t, rotulo: t === 'diario' ? 'Obrigações diárias' : t === 'a_definir' ? 'Sem periodicidade' : ({ semanal: 'Semanais', mensal: 'Mensais', bimestral: 'Bimestrais', semestral: 'Semestrais', anual: 'Anuais' })[t], n: ctx.atividades.filter(a => a.periodicidade === t).length })).filter(f => f.n),
    { id: 'semdata', rotulo: 'Sem data', n: pendentes.length, alerta: true }
  ];
  if (!filtros.some(f => f.id === filtroTipo)) filtroTipo = 'todas';
  const lista = ctx.atividades
    .filter(a => filtroTipo === 'todas' || (filtroTipo === 'semdata' ? pendentes.includes(a) : a.periodicidade === filtroTipo))
    .sort((a, b) => ordemTipos.indexOf(a.periodicidade) - ordemTipos.indexOf(b.periodicidade) || (a.ordem || 0) - (b.ordem || 0));

  const datas = (a) => {
    if (a.periodicidade === 'diario') return '<span class="pa-mudo">todo dia letivo</span>';
    if (a.periodicidade === 'semanal') return '<span class="pa-mudo">até sexta</span>';
    if (a.periodicidade === 'mensal') return '<span class="pa-mudo">último dia letivo do mês</span>';
    const ps = (s.prazos || {})[a.id] || [];
    const chips = ps.map(p => `<span class="pa-chip ${p.origem === 'direcao' ? 'dir' : ''}" title="${esc(p.origem === 'direcao' ? `Definida pela Direção${p.por ? ` (${p.por})` : ''}` : `Calendário acadêmico: ${frase(p.evento || '')}`)}">${fmtData(p.data).slice(0, 5)}</span>`).join('');
    return `<div class="pa-prazos">${chips}<button type="button" class="pa-chip-btn ${ps.length ? '' : 'pend'}" data-datas="${esc(a.id)}">${ps.length ? 'Datas' : 'Definir data'}</button></div>`;
  };
  const responsavel = (a) => ({ coordenador: 'Coordenador', administrativo: 'Administrativo', ambos: 'Coord. e adm' })[a.responsavel] || '—';

  tela().innerHTML = `
    <section class="pa-card pa-config">
      <div class="pa-config-info">
        <span class="pa-config-rot">Semestre ${esc(s.id)}</span>
        <span class="pa-config-val">${fmtData(s.inicio).slice(0, 5)} a ${fmtData(s.fim).slice(0, 5)}</span>
        <span class="pa-mudo">calendário do Edubox atualizado em ${s.calendarioAtualizadoEm ? dataHora(s.calendarioAtualizadoEm) : '—'}</span>
      </div>
      <div class="pa-config-acomp">
        <label for="pa-inicio-acomp" class="pa-config-rot">Contar atraso a partir de</label>
        <div class="pa-config-linha">
          <input type="date" id="pa-inicio-acomp" value="${esc(s.inicioAcompanhamento || s.inicio)}" min="${esc(s.inicio)}" max="${esc(s.fim)}">
          <button type="button" class="btn-secondary" data-acao="salvar-inicio">Salvar</button>
        </div>
      </div>
      <button type="button" class="btn-primary pa-nova" data-acao="nova"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Nova atividade</button>
    </section>

    <div class="pa-filtros" role="tablist" aria-label="Filtrar por tipo">${filtros.map(f => `
      <button type="button" class="pa-filtro${f.id === filtroTipo ? ' ativo' : ''}${f.alerta && f.n ? ' alerta' : ''}" role="tab" aria-selected="${f.id === filtroTipo}" data-filtro="${f.id}">${esc(f.rotulo)} <span>${f.n}</span></button>`).join('')}
    </div>

    <section class="pa-card pa-card-tabela">
      <div class="pa-tabela-wrap"><table class="pa-tabela pa-tabela-atv">
        <thead><tr><th scope="col">Atividade</th><th scope="col">Responsável</th><th scope="col">Tipo</th><th scope="col">Datas</th><th scope="col"><span class="sr-only">Ações</span></th></tr></thead>
        <tbody>${lista.map(a => `
          <tr class="${a.ativo === false ? 'inativa' : ''}">
            <td class="pa-col-atv"><span class="pa-titulo">${esc(a.titulo)}</span>${a.ativo === false ? ' <span class="pa-tag">desativada</span>' : ''}
              ${a.detalhe ? `<span class="pa-atv-det">${esc(a.detalhe)}</span>` : ''}</td>
            <td><span class="pa-resp pa-resp-${a.responsavel}">${responsavel(a)}</span></td>
            <td><span class="pa-tipo pa-tipo-${a.periodicidade}">${rotuloTipo(a.periodicidade)}</span></td>
            <td class="pa-col-datas">${datas(a)}</td>
            <td class="pa-col-acao"><button type="button" class="pa-btn-icone" data-editar="${esc(a.id)}" aria-label="Editar: ${esc(a.titulo)}" title="Editar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button></td>
          </tr>`).join('') || '<tr><td colspan="5" class="pa-mudo">Nenhuma atividade neste filtro.</td></tr>'}</tbody>
      </table></div>
      <p class="pa-mudo pa-legenda">Datas em azul vêm do calendário acadêmico do Edubox; em marinho, foram definidas pela Direção. Obrigações diárias são rotina: o coordenador não marca.</p>
    </section>`;
}

function formAtividade(a) {
  const opt = (obj, sel) => Object.entries(obj).map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
  return `
    <label class="pa-campo">Atividade<textarea id="pa-f-titulo" rows="3" maxlength="400">${esc(a ? a.titulo : '')}</textarea></label>
    <div class="pa-campos-2">
      <label class="pa-campo">Periodicidade<select id="pa-f-per" class="select-filter">${opt(PERIODICIDADE_LABEL, a ? a.periodicidade : 'semanal')}</select></label>
      <label class="pa-campo">Responsável<select id="pa-f-resp" class="select-filter">${opt(RESP_LABEL, a ? a.responsavel : 'coordenador')}</select></label>
    </div>
    <label class="pa-campo">Como fazer (opcional)<textarea id="pa-f-det" rows="3" maxlength="1000">${esc(a ? a.detalhe || '' : '')}</textarea></label>
    ${a ? `<label class="pa-check-linha"><input type="checkbox" id="pa-f-ativo" ${a.ativo === false ? '' : 'checked'}> Ativa (desmarque pra tirar do plano sem perder o histórico)</label>` : ''}`;
}

function editarAtividade(id) {
  const a = id ? ctx.atividades.find(x => x.id === id) : null;
  abrirModal(a ? 'Editar atividade' : 'Nova atividade', formAtividade(a), async () => {
    const body = {
      titulo: $('pa-f-titulo').value, periodicidade: $('pa-f-per').value, responsavel: $('pa-f-resp').value,
      detalhe: $('pa-f-det').value, ativo: a ? $('pa-f-ativo').checked : true
    };
    try {
      const salvo = a
        ? await apiFetch(`/${MODULO}/atividades/${a.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : await apiFetch(`/${MODULO}/atividades`, { method: 'POST', body: JSON.stringify(body) });
      const i = ctx.atividades.findIndex(x => x.id === salvo.id);
      if (i >= 0) ctx.atividades[i] = salvo; else ctx.atividades.push(salvo);
      fecharModal();
      render();
      toast(a ? 'Atividade salva.' : 'Atividade criada.');
    } catch (e) { toast(e.message, 'erro'); }
  });
}

function editarDatas(id) {
  const s = sem();
  const a = ctx.atividades.find(x => x.id === id);
  const lista = (s.prazos || {})[id] || [];
  const doCal = lista.filter(p => p.origem === 'calendario');
  const daDir = lista.filter(p => p.origem === 'direcao').map(p => p.data);
  const linhaData = (v = '') => `<div class="pa-data-linha"><input type="date" class="pa-f-data" value="${esc(v)}" min="${esc(s.inicio)}" max="${esc(s.fim)}"><button type="button" class="btn-secondary" data-tirar-data>Tirar</button></div>`;
  abrirModal('Datas da atividade', `
    <p class="pa-mudo">${esc(a.titulo)}</p>
    ${doCal.length ? `<p class="pa-mudo">Do calendário do Edubox: ${doCal.map(p => `${fmtData(p.data)} (${esc((p.evento || '').toLowerCase())})`).join('; ')}.</p>` : ''}
    <div id="pa-datas">${(daDir.length ? daDir : ['']).map(linhaData).join('')}</div>
    <button type="button" class="btn-secondary" id="pa-mais-data">Adicionar data</button>`,
  async () => {
    const datas = [...document.querySelectorAll('.pa-f-data')].map(i => i.value).filter(Boolean);
    try {
      const r = await apiFetch(`/${MODULO}/semestres/${encodeURIComponent(s.id)}/prazos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ datas }) });
      s.prazos = { ...(s.prazos || {}), [id]: r.prazos };
      fecharModal();
      render();
      toast('Datas salvas.');
    } catch (e) { toast(e.message, 'erro'); }
  });
  $('pa-mais-data').addEventListener('click', () => $('pa-datas').insertAdjacentHTML('beforeend', linhaData()));
  $('pa-datas').addEventListener('click', (e) => { if (e.target.closest('[data-tirar-data]')) e.target.closest('.pa-data-linha').remove(); });
}

async function salvarInicio() {
  const v = $('pa-inicio-acomp').value;
  try {
    const r = await apiFetch(`/${MODULO}/semestres/${encodeURIComponent(sem().id)}/acompanhamento`, { method: 'PUT', body: JSON.stringify({ inicioAcompanhamento: v }) });
    sem().inicioAcompanhamento = r.inicioAcompanhamento;
    toast('Data salva.');
  } catch (e) { toast(e.message, 'erro'); }
}

// ================================================================
//  DIREÇÃO — CALENDÁRIO (referência, vem do Edubox)
// ================================================================

function renderCalendario() {
  const s = sem();
  const porMes = {};
  (s.eventos || []).forEach(e => { (porMes[e.inicio.slice(0, 7)] = porMes[e.inicio.slice(0, 7)] || []).push(e); });
  const meses = Object.keys(porMes).sort();
  tela().innerHTML = `<div class="pa-cal-meses">${meses.map(mes => `
    <section class="pa-card pa-cal-mes${mes < ctx.hoje.slice(0, 7) ? ' passado' : ''}" id="cal-${mes}">
      <h3 class="pa-card-titulo">${nomeMes(mes).replace(/^./, c => c.toUpperCase())} <span class="pa-mudo">${porMes[mes].length} evento${porMes[mes].length > 1 ? 's' : ''}</span></h3>
      <ol class="pa-cal-lista">${porMes[mes].sort((a, b) => a.inicio.localeCompare(b.inicio)).map(e => {
        const naoLetivo = /FERIADO|RECESSO/.test(e.descricao);
        const passou = e.fim < ctx.hoje;
        const w = new Date(e.inicio + 'T12:00').getDay();
        return `<li class="${naoLetivo ? 'nao-letivo' : ''}${passou ? ' passou' : ''}${e.inicio <= ctx.hoje && e.fim >= ctx.hoje ? ' agora' : ''}">
          <span class="pa-cal-dia"><b>${Number(e.inicio.slice(8))}</b><small>${DIA_SEMANA[w]}</small></span>
          <span class="pa-cal-txt"><span class="pa-cal-tit">${esc(frase(e.descricao))}</span>
            ${e.complemento ? `<span class="pa-cal-comp">${esc(frase(e.complemento))}</span>` : ''}
            ${e.fim !== e.inicio ? `<span class="pa-cal-periodo">até ${fmtData(e.fim).slice(0, 5)}</span>` : ''}</span>
          ${naoLetivo ? `<span class="pa-cal-tag">${/FERIADO/.test(e.descricao) ? 'Feriado' : 'Recesso'}</span>` : ''}
        </li>`;
      }).join('')}</ol>
    </section>`).join('')}</div>
    <p class="pa-mudo pa-legenda">Calendário acadêmico do Edubox (${esc(s.calendarioEdubox || '')}). Feriados e recessos não cobram atividade.</p>`;
}

// ================================================================
//  EVENTOS
// ================================================================

function ligarEventos() {
  $('pa-semestre').addEventListener('change', () => { verUid = null; verAtrasadas = false; carregar(); });
  $('pa-abas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (!b) return;
    aba = b.dataset.aba; verUid = null; verAtrasadas = false;
    fecharDocumento();
    render();
  });
  $('pa-modal-cancelar').addEventListener('click', fecharModal);
  $('pa-modal-ok').addEventListener('click', () => { if (modalOk) modalOk(); });
  $('pa-modal').addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });

  tela().addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-ver], [data-pd-abrir]');
    if (!t) return;
    if (tratarClique(t)) return;
    if (t.dataset.ev !== undefined) return detalheEvento(Number(t.dataset.ev));
    if (t.dataset.novaTarefa !== undefined) return novaTarefa(t.dataset.novaTarefa);
    if (t.dataset.tarefa) return concluirTarefa(t.dataset.tarefa);
    if (t.dataset.excluirTarefa) return excluirTarefa(t.dataset.excluirTarefa);
    if (t.dataset.semana) {
      const s = sem();
      let d = somaDias(segundaDa(diaSel), Number(t.dataset.semana));
      if (d < s.inicio) d = s.inicio;
      if (d > s.fim) d = s.fim;
      diaSel = segundaDa(ctx.hoje) === segundaDa(d) ? ctx.hoje : d;
      return render();
    }
    if (t.dataset.marcar) {
      const chave = t.dataset.marcar;
      return marcar(chave, !marcas[chave]);
    }
    if (t.dataset.obs) return editarObs(t.dataset.obs);
    if (t.dataset.ver) { verUid = t.dataset.ver; verAtrasadas = false; diaSel = diaPadrao(); return render(); }
    if (t.dataset.editar) return editarAtividade(t.dataset.editar);
    if (t.dataset.datas) return editarDatas(t.dataset.datas);
    if (t.dataset.filtro) { filtroTipo = t.dataset.filtro; return render(); }
    const acao = t.dataset.acao;
    if (acao === 'atrasadas') { verAtrasadas = !verAtrasadas; return render(); }
    if (acao === 'hoje') { diaSel = diaPadrao(); return render(); }
    if (acao === 'voltar') { verUid = null; return render(); }
    if (acao === 'nova') return editarAtividade(null);
    if (acao === 'salvar-inicio') return salvarInicio().then(render);
    if (acao === 'ir-atividades') { aba = 'atividades'; return render(); }
    if (acao === 'imprimir') return window.print();
  });
  tela().addEventListener('keydown', (e) => {
    const linha = e.target.closest('[data-ver], [data-pd-abrir]');
    if (linha && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); linha.click(); }
  });
}

async function initApp(user, role) {
  appInitialized = true;
  initializedRole = role;
  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    await signOut(auth);
    location.href = '../../auth/login.html';
  });
  $('auth-guard').classList.add('hidden');
  $('app').classList.remove('hidden');
  ligarEventos();
  ligarDocumentos({ apiFetch, toast, abrirModal, fecharModal, esc, ctx: () => ctx, auth, render, nomeCursos, fmtData, dataHora });
  let semestres = [];
  try { semestres = await apiFetch(`/${MODULO}/semestres`); } catch (e) { semestres = []; }
  const atual = semestreAtual();
  if (!semestres.some(s => s.id === atual)) semestres.unshift({ id: atual });
  $('pa-semestre').innerHTML = semestres.map(s => `<option value="${esc(s.id)}" ${s.id === atual ? 'selected' : ''}>${esc(s.id)}</option>`).join('');
  await carregar();
}

const cached = getCachedAuth();

onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../../auth/login.html'; return; }
  currentUser = user;
  let role = 'visitante', meuOverrides = null;
  try {
    const u = await apiFetch('/usuarios/me');
    role = u.role || 'visitante';
    meuOverrides = u.permissoes || null;
  } catch (e) { role = cached ? cached.role : 'visitante'; }
  setCachedAuth(user, role, await user.getIdToken());

  let nivel = 1;
  if (role === 'adm_l1') nivel = 3;
  else {
    try {
      const perms = await apiFetch('/usuarios/config/permissions');
      const doCargo = perms[role] || {};
      const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
      nivel = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
    } catch (e) { nivel = NIVEL_PADRAO[role] || 1; }
  }
  if (nivel < 2) { location.href = '../../meu-espaco/index.html'; return; }

  if (!appInitialized || initializedRole !== role) initApp(user, role);
});
