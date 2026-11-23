// ================================================================
//  ÓRBITA — AULAS EAD (T.I) · 18/11/2026
//  Disciplinas EAD do semestre (dia, horário, professor que dá a aula), sala Zoom de cada professor
//  (o mesmo link em todos os dias dele), grade da semana, cadastro das salas Zoom e controle das
//  gravações das UAs (Gravou → Baixou → YouTube → AVA), com o relatório do dia para o coordenador EAD.
//  Servidor: src/rotas/ead-aulas.js
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { getEffectiveLevel } from "../../core/permissions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// local: se a página veio do próprio servidor da API (porta 3000–3002), usa ele; senão (Live Server etc.), a 3000
const LOCAL = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.');
const API_BASE = LOCAL && !/^300[0-2]$/.test(location.port) ? `http://${location.hostname}:3000/api` : '/api';
const MODULO = 'ead-aulas';
const NIVEL_PADRAO = { adm_l2: 3, ti: 3 };

const DIA_ROTULO = { segunda: 'Segunda', terca: 'Terça', quarta: 'Quarta', quinta: 'Quinta', sexta: 'Sexta', sabado: 'Sábado' };
const ETAPA_ROTULO = { gravou: 'Gravou', baixou: 'Baixou', youtube: 'YouTube', ava: 'No AVA' };
const ETAPA_QUEM = { gravou: 'professor', baixou: 'T.I', youtube: 'T.I', ava: 'T.I' };
const TIPO_REVISAO = { video: 'Vídeo', material: 'Outro material' };
const OBS_SUGESTOES = ['Mais de uma UA no mesmo vídeo', 'Sem slide', 'Sem áudio', 'Áudio ruim', 'Vídeo incompleto', 'Gravou a UA errada'];
const CURSOS = [['agronegocio', 'Agronegócio'], ['agronomia', 'Agronomia'], ['arquitetura-urbanismo', 'Arquitetura e Urbanismo'], ['biomedicina', 'Biomedicina'],
  ['contabeis', 'Ciências Contábeis'], ['direito', 'Direito'], ['enfermagem', 'Enfermagem'], ['engenharia-civil', 'Engenharia Civil'], ['fisioterapia', 'Fisioterapia'],
  ['gestao-comercial', 'Gestão Comercial'], ['gestao-financeira', 'Gestão Financeira'], ['logistica', 'Logística'], ['medicina-veterinaria', 'Medicina Veterinária'],
  ['medicina', 'Medicina'], ['pedagogia', 'Pedagogia'], ['psicologia', 'Psicologia'], ['rh', 'Recursos Humanos']];

const $ = (id) => document.getElementById(id);
const tela = () => $('ea-tela');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const chaveProf = (p) => norm(p).toLowerCase().replace(/ /g, '-').slice(0, 80) || 'x'; // igual ao servidor
const nomeBonito = (n) => {
  const t = String(n || '').trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s(\/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/(?!^)(?<![\p{L}])(De|Da|Do|Das|Dos|E|Em|No|Na|Nos|Nas|Ao|Aos|À|Às|A|O|Para|Por|Com)(?![\p{L}])/gu, (x) => x.toLowerCase())
    .replace(/(?<![\p{L}])(Ii|Iii|Iv|Vi|Vii|Viii|Ix)(?![\p{L}])/gu, (x) => x.toUpperCase());
};
const periodoTxt = (p) => (!p ? '' : /^\d+$/.test(p) ? `${p}º per.` : /todos/i.test(p) ? 'todos os per.' : `${p}º per.`);
const quando = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

let currentUser = null, appInitialized = false, initializedRole = null, podeEditar = false;
let dados = null;
let aba = 'gravacoes', filtroCurso = '', busca = '', filtroSit = 'todas', diaGrade = 'segunda', relBim = '1', relAte = 6, relModo = 'data';
let filtroDia = '', filtroProf = '', filtroData = ''; // filtros tipo planilha (18/11/2026)
let relIni = '', relFim = '', relProf = '', relDisc = '', relSoObs = false; // filtros do relatório (18/11/2026)
let importando = null; // { tipo: 'disciplinas'|'salas', base64, previa }
const senhasVisiveis = new Set();

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('ea-toast'); t.textContent = msg; t.className = `ea-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function copiar(txt, msg = 'Copiado.') {
  try { await navigator.clipboard.writeText(txt); toast(msg); } catch (e) { window.prompt('Copie:', txt); }
}
const fecharModal = () => $('ea-modal').classList.add('hidden');
function abrirModal(titulo, html) { $('ea-modal-titulo').textContent = titulo; $('ea-modal-corpo').innerHTML = html; $('ea-modal').classList.remove('hidden'); }

// ---------------- dados derivados ----------------
const salaPorId = (id) => (dados.salas || []).find(s => s.id === id) || null;
const salaDoProf = (prof) => { const v = prof && dados.salaDoProfessor[chaveProf(prof)]; return v ? salaPorId(v.salaId) : null; };
const nomeSala = (s) => s ? `${s.conta} · ${s.nome}` : '';
// Datas previstas (18/11/2026). Cada UA tem a data do calendário (início do bimestre + dia da semana da disciplina;
// semanal nas de 12 UAs, quinzenal nas de 6; pula os dias sem aula) ou a data que o T.I digitou na UA.
// Sem calendário e sem data digitada, a UA fica sem data (a página funciona igual, o relatório usa "até a UA").
const DOW = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const hojeIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const isoDe = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const dataBR = (iso) => { const [a, m, d] = String(iso || '').split('-'); return d ? `${d}/${m}` : ''; };
function datasPrevistas(d) {
  const cal = dados.calendario || {};
  const g = d.gravacoes || {};
  const out = {};
  const auto = {};
  if (d.dia && DOW[d.dia] !== undefined) {
    const semAula = new Set(cal.semAula || []);
    const passo = (d.qtd || 12) === 6 ? 14 : 7;
    [1, 2].forEach(bim => {
      const ini = cal[`inicio${bim}`];
      if (!ini) return;
      const dt = new Date(`${ini}T12:00:00`);
      while (dt.getDay() !== DOW[d.dia]) dt.setDate(dt.getDate() + 1);
      d.itens.filter(it => it.bimestre === bim).forEach(it => {
        let guarda = 0;
        while (semAula.has(isoDe(dt)) && guarda++ < 20) dt.setDate(dt.getDate() + passo);
        auto[it.id] = isoDe(dt);
        dt.setDate(dt.getDate() + passo);
      });
    });
  }
  // data ajustada antes do início do semestre (sobra de teste/outro semestre) não vale: volta ao calendário
  d.itens.forEach(it => { const m0 = g[it.id]?.data; const man = m0 && (!cal.inicio1 || m0 >= cal.inicio1) ? m0 : ''; out[it.id] = (m0 && !man) ? { data: auto[it.id] || '', manual: false, velha: m0 } : man ? { data: man, manual: true } : auto[it.id] ? { data: auto[it.id], manual: false } : { data: '', manual: false }; });
  return out;
}
// situação da UA: gravada / não gravou (motivo) / atrasada (data passou) / hoje / prevista / sem data
function situacaoItem(d, it, datas) {
  const gi = (d.gravacoes || {})[it.id] || {};
  const dt = (datas || datasPrevistas(d))[it.id].data;
  const hoje = hojeIso();
  if (gi.gravou) return { id: 'gravou', dt };
  if (gi.naoGravou) return { id: 'nao-gravou', dt, motivo: gi.naoGravou.motivo };
  if (dt && dt < hoje) return { id: 'atrasada', dt };
  if (dt && dt === hoje) return { id: 'hoje', dt };
  return { id: dt ? 'prevista' : 'sem-data', dt };
}
const atrasadas = (d) => { const ds = datasPrevistas(d); return d.itens.filter(it => ['atrasada', 'nao-gravou'].includes(situacaoItem(d, it, ds).id)).length; };

function contaGrav(d) {
  const it = d.itens || [];
  const g = d.gravacoes || {};
  const c = { total: it.length, gravou: 0, ava: 0 };
  it.forEach(i => { if (g[i.id]?.gravou) c.gravou++; if (g[i.id]?.ava) c.ava++; });
  return c;
}
function barraGrav(d) {
  const c = contaGrav(d);
  const p = (n) => (c.total ? Math.round(100 * n / c.total) : 0);
  return `<div class="ea-anda"><div class="ea-barra" title="${c.ava} no AVA · ${c.gravou - c.ava} gravadas sem publicar · ${c.total - c.gravou} sem gravar"><i class="ava" style="width:${p(c.ava)}%"></i><i class="grav" style="width:${p(c.gravou - c.ava)}%"></i></div>
    <span>${c.gravou}/${c.total} gravadas · ${c.ava} no AVA${(() => { const a = atrasadas(d); return a ? ` · <b class="ea-crit">${a} atrasada(s)</b>` : ''; })()}</span></div>`;
}
// professores com aula no semestre: { chave, nome, dias:Set, discs:[] }
function professores() {
  const m = new Map();
  dados.disciplinas.forEach(d => {
    if (!d.professor) return;
    const k = chaveProf(d.professor);
    if (!m.has(k)) m.set(k, { chave: k, nome: d.professor, dias: new Set(), discs: [] });
    const p = m.get(k); if (d.dia) p.dias.add(d.dia); p.discs.push(d);
  });
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
// ocupantes de uma sala num dia: fixa, professores (pelas disciplinas do dia) e ocupação avulsa
function ocupantes(sala, dia) {
  const profs = professores().filter(p => p.dias.has(dia) && dados.salaDoProfessor[p.chave]?.salaId === sala.id)
    .map(p => ({ ...p, doDia: p.discs.filter(d => d.dia === dia) }));
  return { fixo: sala.fixo || '', profs, avulsa: (dados.ocupacoes[dia] || {})[sala.id] || '' };
}

// ---------------- carregar / render ----------------
async function carregar() {
  const sem = $('ea-semestre').value;
  tela().innerHTML = '<p class="ea-vazio">Carregando...</p>';
  try { dados = await apiFetch(`/${MODULO}/?semestre=${encodeURIComponent(sem)}`); render(); }
  catch (e) { tela().innerHTML = `<div class="ea-card ea-erro">${esc(e.message)}</div>`; }
  carregarAvisosEad();
}

// ================================================================
//  AVISO: O QUE O EAD MUDOU NO LEVANTAMENTO EaD (23/11/2026)
//  O EAD (Carlos e tutores) edita as disciplinas e o calendário pelo Levantamento EaD (Docência), na mesma
//  lista desta página. Cada mudança chega aqui; cada pessoa do T.I marca como visto.
// ================================================================
const CAMPO_ALT = { professor: 'professor', dia: 'dia', horario: 'horário', ch: 'carga horária', nome: 'nome', periodo: 'período', qtd: 'unidades', obs: 'observação', inicio1: 'início do 1º bim.', inicio2: 'início do 2º bim.', semAula: 'dias sem aula' };
const ACAO_ALT = { nova: 'cadastrou', alterada: 'alterou', excluida: 'excluiu', importacao: 'importou a planilha', calendario: 'mudou o calendário das UAs' };
let avisosEad = null, avisosAbertos = false;
const valorAlt = (campo, v) => (campo === 'dia' ? (DIA_ROTULO[v] || v) : String(v ?? '')) || '(vazio)';
async function carregarAvisosEad() {
  try { avisosEad = await apiFetch(`/${MODULO}/alteracoes?dias=30`); } catch (e) { avisosEad = null; }
  renderAvisosEad();
  if (dados && aba === 'gravacoes') render();
}
function htmlMudancas(m) { return (m || []).map(x => `${esc(CAMPO_ALT[x.campo] || x.campo)}: <s>${esc(valorAlt(x.campo, x.de))}</s> → <b>${esc(valorAlt(x.campo, x.para))}</b>`).join(' · '); }
const avisosPendentes = () => (avisosEad ? avisosEad.itens.filter(i => !i.visto) : []);
// 23/11/2026: a disciplina que o EAD mudou fica em laranja na lista, até alguém do T.I marcar "Ciente"
function mudancasDaDisc(id) {
  const out = [];
  avisosPendentes().forEach(a => {
    if (a.discId === id) out.push({ altId: a.id, em: a.em, por: a.por, acao: a.acao, mudancas: a.mudancas || [] });
    (a.itens || []).forEach(i => { if (i.discId === id) out.push({ altId: a.id, em: a.em, por: a.por, acao: i.acao, mudancas: i.mudancas || [] }); });
  });
  return out;
}
const camposMudados = (ms) => [...new Set(ms.flatMap(m => (m.mudancas || []).map(x => CAMPO_ALT[x.campo] || x.campo)))];
async function marcarCiente(ids) {
  if (!ids.length) return;
  await apiFetch(`/${MODULO}/alteracoes/visto`, { method: 'POST', body: JSON.stringify({ ids }) });
  const set = new Set(ids);
  avisosEad.itens.forEach(i => { if (set.has(i.id)) i.visto = true; });
  renderAvisosEad();
}
function renderAvisosEad() {
  const caixa = $('ea-avisos-ead');
  if (!caixa) return;
  const pend = avisosPendentes();
  if (!pend.length) { caixa.innerHTML = ''; return; }
  caixa.innerHTML = `<section class="ea-card ea-aviso-ead">
    <div class="ea-card-topo"><h3>Mudanças do EAD · ${pend.length} para dar ciente</h3>
      <div><button type="button" class="btn-secondary btn-mini" data-ea-avisos-abrir>${avisosAbertos ? 'Esconder' : 'Ver o que mudou'}</button> <button type="button" class="btn-primary btn-mini" data-ea-avisos-visto>Ciente de todas</button></div></div>
    <p class="ea-sub" style="margin:0 .75rem .4rem">As disciplinas que o EAD mudou no Levantamento EaD ficam em laranja na lista. Abra a disciplina e clique em "Ciente".</p>
    ${avisosAbertos ? `<ul class="ea-aviso-lista">${pend.map(a => `<li><span class="ea-sub">${esc(quando(a.em))} · ${esc(a.por || '')}</span>
      ${esc(ACAO_ALT[a.acao] || a.acao)} <b>${esc(a.acao === 'importacao' || a.acao === 'calendario' ? (a.disciplina || '') : nomeBonito(a.disciplina || ''))}</b>${a.curso ? ` · ${esc(a.curso)}` : ''}
      ${a.mudancas && a.mudancas.length ? `<div class="ea-sub">${htmlMudancas(a.mudancas)}</div>` : ''}
      ${a.itens ? `<div class="ea-sub">${a.itens.slice(0, 30).map(i => `${esc(nomeBonito(i.disciplina))} (${esc(i.curso)}): ${i.acao === 'nova' ? 'nova' : htmlMudancas(i.mudancas)}`).join('<br>')}${a.itens.length > 30 ? `<br>e mais ${a.itens.length - 30}` : ''}</div>` : ''}
      <button type="button" class="ea-link" data-ea-ciente="${esc(a.id)}">Ciente</button></li>`).join('')}</ul>` : ''}
  </section>`;
}
function render() {
  document.querySelectorAll('#ea-abas .aba').forEach(b => { const on = b.dataset.aba === aba; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', on); });
  if (!dados) return;
  if (aba === 'grade') return renderGrade();
  if (aba === 'salas') return renderSalas();
  if (aba === 'relatorio') return renderRelatorio();
  renderGravacoes();
}

// ================================================================
//  ABA: DISCIPLINAS E GRAVAÇÕES
// ================================================================
function renderGravacoes() {
  const ds = dados.disciplinas;
  if (!ds.length) {
    tela().innerHTML = `<div class="ea-card"><b>Nenhuma disciplina EAD cadastrada em ${esc(dados.semestre)}.</b>
      <p class="ea-sub" style="font-size:.86rem">Importe a planilha "DISCIPLINAS EaD ${esc(dados.semestre)} LEVANTAMENTO" (no Google Planilhas: Arquivo › Fazer download › Microsoft Excel) ou cadastre uma por uma.</p>
      ${podeEditar ? `<div class="ea-modal-acoes" style="justify-content:flex-start"><button type="button" class="btn-primary" data-ea-importar="disciplinas">Importar planilha de disciplinas</button><button type="button" class="btn-secondary" data-ea-nova-disc>Nova disciplina</button></div>` : ''}</div>`;
    return;
  }
  const cursos = [...new Map(ds.map(d => [d.cursoId, d.cursoNome])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  const b = norm(busca);
  const profsLista = [...new Set(ds.map(d => d.professor).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  const temUaNaData = (d) => { const dt = datasPrevistas(d); return d.itens.some(it => dt[it.id].data === filtroData); };
  const doFiltro = ds.filter(d => (!filtroCurso || d.cursoId === filtroCurso) && (!b || norm(`${d.nome} ${d.professor}`).includes(b))
    && (!filtroDia || (filtroDia === '-' ? !d.dia : d.dia === filtroDia))
    && (!filtroProf || (filtroProf === '-' ? !d.professor : chaveProf(d.professor) === filtroProf))
    && (!filtroData || temUaNaData(d)));
  const sit = (d) => { const c = contaGrav(d); return !d.professor ? 'sem-prof' : c.ava === c.total ? 'concluida' : c.gravou > c.ava ? 'publicar' : 'andamento'; };
  const lista = doFiltro.filter(d => filtroSit === 'todas' || sit(d) === filtroSit);
  const tot = doFiltro.reduce((a, d) => { const c = contaGrav(d); a.t += c.total; a.g += c.gravou; a.v += c.ava; return a; }, { t: 0, g: 0, v: 0 });
  const conta = (s) => doFiltro.filter(d => sit(d) === s).length;
  tela().innerHTML = `
    <section class="ea-resumo">
      <div class="ea-num"><b>${doFiltro.length}</b><span>disciplinas EAD</span></div>
      <div class="ea-num"><b class="${conta('sem-prof') ? 'ea-alerta' : ''}">${conta('sem-prof')}</b><span>sem professor</span></div>
      <div class="ea-num"><b>${tot.g}<small>/${tot.t}</small></b><span>unidades gravadas</span></div>
      <div class="ea-num"><b>${tot.g - tot.v}</b><span>gravadas, falta publicar</span></div>
      <div class="ea-num"><b>${tot.v}<small>/${tot.t}</small></b><span>no AVA</span></div>
    </section>
    <div class="ea-ferramentas">
      <label>Curso<select class="select-filter" data-ea-curso><option value="">Todos os cursos</option>${cursos.map(([id, n]) => `<option value="${esc(id)}" ${filtroCurso === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label>Dia<select class="select-filter" data-ea-f-dia><option value="">Todos os dias</option>${Object.entries(DIA_ROTULO).map(([k, r]) => `<option value="${k}" ${filtroDia === k ? 'selected' : ''}>${r}</option>`).join('')}<option value="-" ${filtroDia === '-' ? 'selected' : ''}>Sem dia</option></select></label>
      <label>Professor<select class="select-filter" data-ea-f-prof style="max-width:240px"><option value="">Todos</option>${profsLista.map(p => `<option value="${esc(chaveProf(p))}" ${filtroProf === chaveProf(p) ? 'selected' : ''}>${esc(p)}</option>`).join('')}<option value="-" ${filtroProf === '-' ? 'selected' : ''}>Sem professor</option></select></label>
      <label>UA prevista em<input type="date" class="ea-input" data-ea-f-data value="${esc(filtroData)}"></label>
      <label>Buscar<input class="ea-input ea-busca" data-ea-busca value="${esc(busca)}" placeholder="Disciplina ou professor"></label>
      ${filtroCurso || filtroDia || filtroProf || filtroData || busca || filtroSit !== 'todas' ? '<button type="button" class="btn-secondary" data-ea-limpar-filtros>Limpar filtros</button>' : ''}
      <div class="ea-direita"><button type="button" class="btn-secondary" data-ea-calendario>${dados.calendario?.inicio1 ? 'Calendário das UAs' : 'Calendário das UAs (não definido)'}</button>${podeEditar ? `<button type="button" class="btn-secondary" data-ea-importar="disciplinas">Importar planilha</button><button type="button" class="btn-primary" data-ea-nova-disc>Nova disciplina</button>` : ''}</div>
    </div>
    <div class="ea-pilulas" style="margin-bottom:1rem">
      ${[['todas', 'Todas', doFiltro.length], ['sem-prof', 'Sem professor', conta('sem-prof')], ['andamento', 'Gravando', conta('andamento')], ['publicar', 'Falta publicar', conta('publicar')], ['concluida', 'Tudo no AVA', conta('concluida')]]
        .map(([id, r, n]) => `<button type="button" class="ea-pilula${filtroSit === id ? ' ativo' : ''}" data-ea-sit="${id}">${r} <span>${n}</span></button>`).join('')}
    </div>
    <section class="ea-card ea-card-tabela">
      ${lista.length ? `<div class="ea-tabela-wrap"><table class="ea-tabela">
        <thead><tr><th>Disciplina</th><th>Professor</th><th>Dia e horário</th><th>Zoom<span class="ea-sub">e-mail · sala</span></th><th>Gravações</th></tr></thead>
        <tbody>${lista.map(d => { const s = salaDoProf(d.professor); const mud = mudancasDaDisc(d.id); return `<tr class="ea-clicavel${mud.length ? ' ea-mudou' : ''}" data-ea-disc="${esc(d.id)}" tabindex="0">
          <td><b>${esc(nomeBonito(d.nome))}</b>${mud.length ? ` <span class="ea-pill ea-pill-mudou">EAD mudou${camposMudados(mud).length ? ': ' + esc(camposMudados(mud).join(', ')) : ''}</span>` : ''}<span class="ea-sub">${esc(d.cursoNome)} · ${esc(periodoTxt(d.periodo))}${d.ch ? ` · ${d.ch} h` : ''} · ${d.qtd || ''} UAs</span></td>
          <td>${d.professor ? esc(d.professor) : '<span class="ea-pill alerta">definir</span>'}</td>
          <td class="ea-nowrap">${d.dia ? esc(DIA_ROTULO[d.dia]) : '<span class="ea-sub">—</span>'}${d.horario ? `<span class="ea-sub">${esc(d.horario)}</span>` : ''}</td>
          <td class="ea-nowrap">${s ? `<span class="ea-zoom-cel"><b>${esc(s.conta)}</b><span>${esc(s.nome)}</span></span>` : d.professor ? '<span class="ea-pill alerta">sem sala</span>' : ''}</td>
          <td>${barraGrav(d)}${filtroData ? (() => { const dt = datasPrevistas(d); const its = d.itens.filter(it => dt[it.id].data === filtroData); return its.length ? `<span class="ea-pill marca" style="margin-top:.3rem">${dataBR(filtroData)}: ${its.map(it => esc(it.rotulo)).join(', ')}</span>` : ''; })() : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : '<p class="ea-vazio">Nenhuma disciplina neste filtro.</p>'}
    </section>
    <p class="ea-legenda">Clique na disciplina para editar e marcar as gravações. Disciplina de 60/80 h tem 12 UAs (6 por bimestre); de 30/40 h, 6 (3 por bimestre); cada bimestre tem uma revisão. A sala Zoom é a do professor (aba Grade da semana).</p>`;
}

function htmlFormDisc(d) {
  return `<div class="ea-form">
    ${d ? '' : `<label>Curso<select id="ea-f-curso">${CURSOS.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</select></label>
      <label class="ea-largo">Disciplina<input type="text" id="ea-f-nome" maxlength="200"></label>
      <label>Período<input type="text" id="ea-f-periodo" maxlength="30" placeholder="ex.: 7 ou 4 e 5"></label>
      <label>Carga horária<input type="text" id="ea-f-ch" inputmode="numeric" maxlength="4"></label>`}
    <label>Professor (dá a aula)<input type="text" id="ea-f-prof" maxlength="120" value="${esc(d ? d.professor : '')}" list="ea-profs"></label>
    <label>Dia<select id="ea-f-dia"><option value="">—</option>${Object.entries(DIA_ROTULO).map(([k, r]) => `<option value="${k}" ${d && d.dia === k ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <label>Horário<input type="text" id="ea-f-hor" maxlength="40" value="${esc(d ? d.horario : '')}" placeholder="19h30min - 20h30min"></label>
    <label>Unidades<select id="ea-f-qtd">${[12, 6].map(q => `<option ${d && d.qtd === q ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
    <label class="ea-largo">Observação<input type="text" id="ea-f-obs" maxlength="600" value="${esc(d ? d.obs || '' : '')}"></label>
  </div>
  <datalist id="ea-profs">${professores().map(p => `<option value="${esc(p.nome)}">`).join('')}</datalist>`;
}

function abrirDisciplina(id) {
  const d = dados.disciplinas.find(x => x.id === id);
  if (!d) return;
  const g = d.gravacoes || {};
  const s = salaDoProf(d.professor);
  const datas = datasPrevistas(d);
  const porData = {};
  d.itens.forEach(it => { const dt = datas[it.id].data; if (dt) (porData[dt] = porData[dt] || []).push(it.rotulo); });
  const SIT = { gravou: ['bom', 'gravada'], 'nao-gravou': ['alerta', 'não gravou'], atrasada: ['crit', 'atrasada'], hoje: ['marca', 'hoje'], prevista: ['', 'prevista'], 'sem-data': ['', 'sem data'] };
  const linhas = d.itens.map((it, i) => {
    const sep = (i === 0 || (it.bimestre === 2 && d.itens[i - 1].bimestre === 1)) ? `<tr class="ea-sep"><td colspan="8">${it.bimestre}º bimestre</td></tr>` : '';
    const gi = g[it.id] || {};
    const dt = datas[it.id];
    const sit = situacaoItem(d, it, datas);
    const juntas = dt.data && porData[dt.data].length > 1 ? porData[dt.data].filter(r => r !== it.rotulo) : [];
    const tipoRev = gi.tipo?.tipo || '';
    const tipoHtml = !it.revisao ? '' : podeEditar
      ? `<select class="ea-tipo-rev" data-ea-tipo="${esc(it.id)}" aria-label="O que foi entregue na ${esc(it.rotulo)}"><option value="">entregou…</option>${Object.entries(TIPO_REVISAO).map(([k, r]) => `<option value="${k}" ${tipoRev === k ? 'selected' : ''}>${r}</option>`).join('')}</select>`
      : (tipoRev ? `<span class="ea-sub">${esc(TIPO_REVISAO[tipoRev])}</span>` : '');
    // 18/11/2026: "não gravou" → as etapas não se aplicam: X no lugar das caixas (limpar o motivo volta as caixas)
    const etapasHtml = gi.naoGravou
      ? dados.etapas.map(e => `<td class="ea-check-td"><span class="ea-x" title="Não se aplica: não gravou" aria-label="${esc(it.rotulo)}: ${ETAPA_ROTULO[e]} não se aplica">X</span></td>`).join('')
      : dados.etapas.map(e => `<td class="ea-check-td">
        <input type="checkbox" class="ea-check" data-ea-grav="${esc(it.id)}" data-ea-etapa="${e}" ${gi[e] ? 'checked' : ''} ${podeEditar ? '' : 'disabled'} aria-label="${esc(it.rotulo)}: ${ETAPA_ROTULO[e]}">
        ${gi[e] ? `<span class="ea-quem" title="${esc(gi[e].por || '')}">${esc(quando(gi[e].em))}</span>` : ''}</td>`).join('');
    const obsHtml = podeEditar
      ? `<input type="text" class="ea-input ea-obs" data-ea-obs="${esc(it.id)}" value="${esc(gi.obs?.texto || '')}" maxlength="300" list="ea-obs-sugestoes" placeholder="opcional" aria-label="Observação ${esc(it.rotulo)}" title="${esc(gi.obs ? `${gi.obs.por || ''} · ${quando(gi.obs.em)}` : 'Problema do vídeo: mais de uma UA no mesmo vídeo, sem slide, sem áudio...')}">`
      : (gi.obs ? esc(gi.obs.texto) : '');
    return `${sep}<tr class="${it.revisao ? 'ea-rev' : ''}">
      <td><b>${esc(it.rotulo)}</b><span class="ea-sub"><span class="ea-pill ${SIT[sit.id][0]}">${SIT[sit.id][1]}</span></span>${tipoHtml}</td>
      <td class="ea-data-td">${podeEditar ? `<input type="date" class="ea-input ea-data" data-ea-data="${esc(it.id)}" value="${esc(dt.data)}" aria-label="Data prevista ${esc(it.rotulo)}">` : esc(dataBR(dt.data) || '—')}
        <span class="ea-sub">${dt.velha ? `<span class="ea-alerta">ajuste de ${esc(dataBR(dt.velha))} ignorado (antes do início do semestre)</span>${podeEditar ? ` · <button type="button" class="ea-link" data-ea-data-limpar="${esc(it.id)}">limpar</button>` : ''}` : ''}${dt.manual ? 'data ajustada' : dt.data && !dt.velha ? 'pelo calendário' : ''}${dt.manual && podeEditar ? ` · <button type="button" class="ea-link" data-ea-data-limpar="${esc(it.id)}">voltar ao calendário</button>` : ''}</span>
        ${juntas.length ? `<span class="ea-sub ea-alerta">mesma data de ${juntas.map(esc).join(', ')}</span>` : ''}</td>
      ${etapasHtml}
      <td>${gi.naoGravou ? `<span class="ea-alerta">${esc(gi.naoGravou.motivo)}</span>${podeEditar ? `<span class="ea-sub"><button type="button" class="ea-link" data-ea-nao-gravou-limpar="${esc(it.id)}">limpar</button></span>` : ''}`
        : (!gi.gravou && podeEditar ? `<button type="button" class="ea-link" data-ea-nao-gravou="${esc(it.id)}">não gravou…</button>` : '')}</td>
      <td class="ea-obs-td">${obsHtml}</td></tr>`;
  }).join('');
  const semCal = !dados.calendario?.inicio1;
  abrirModal(nomeBonito(d.nome), `
    <p class="ea-sub" style="margin:-.4rem 0 .8rem;font-size:.84rem">${esc(d.cursoNome)} · ${esc(periodoTxt(d.periodo))}${d.ch ? ` · ${d.ch} h` : ''}${d.professor ? ` · Prof. ${esc(d.professor)}` : ''}</p>
    ${(() => { const mud = mudancasDaDisc(d.id); return mud.length ? `<div class="ea-card ea-aviso-ead ea-aviso-disc"><b>O EAD mudou esta disciplina no Levantamento EaD</b>
      <ul class="ea-aviso-lista">${mud.map(m => `<li><span class="ea-sub">${esc(quando(m.em))} · ${esc(m.por || '')}</span>${m.acao === 'nova' ? 'cadastrou a disciplina' : htmlMudancas(m.mudancas)}</li>`).join('')}</ul>
      <div class="ea-modal-acoes" style="justify-content:flex-start;margin-top:.5rem"><button type="button" class="btn-primary btn-mini" data-ea-ciente-disc="${esc(d.id)}">Ciente</button></div></div>` : ''; })()}
    ${htmlZoomDestaque(s, d)}
    <section><h3>Dados da disciplina</h3>${htmlFormDisc(d)}
      ${podeEditar ? `<div class="ea-modal-acoes"><button type="button" class="btn-secondary ea-perigo" data-ea-excluir-disc="${esc(d.id)}">Excluir disciplina</button><button type="button" class="btn-primary" data-ea-salvar-disc="${esc(d.id)}">Salvar dados</button></div>` : ''}</section>
    <section><h3>Gravações <span class="ea-sub" style="display:inline">· marcar uma etapa marca as anteriores; desmarcar desmarca as seguintes</span></h3>
      ${semCal ? `<p class="ea-sub" style="margin:0 0 .5rem">Sem calendário das UAs neste semestre: as datas ficam em branco. Dá para digitar a data de cada UA aqui ou definir o calendário (botão "Calendário das UAs").</p>` : !d.dia ? '<p class="ea-sub" style="margin:0 0 .5rem">A disciplina está sem dia da semana: o calendário não consegue calcular as datas. Preencha o dia acima ou digite a data de cada UA.</p>' : ''}
      <div class="ea-tabela-wrap"><table class="ea-tabela ea-grav" data-ea-disc-grav="${esc(d.id)}">
        <thead><tr><th>Unidade</th><th>Data prevista</th>${dados.etapas.map(e => `<th class="ea-check-td">${ETAPA_ROTULO[e]}<span class="ea-sub">${ETAPA_QUEM[e]}</span></th>`).join('')}<th>Não gravou</th><th>Observação<span class="ea-sub">opcional</span></th></tr></thead>
        <tbody>${linhas}</tbody></table></div>
      <datalist id="ea-obs-sugestoes">${OBS_SUGESTOES.map(o => `<option value="${esc(o)}">`).join('')}</datalist>
      <p class="ea-sub" style="margin-top:.5rem">Observação: vale também para UA gravada (ex.: mais de uma UA no mesmo vídeo, sem slide, sem áudio). Salva ao sair do campo; apague o texto para limpar.</p></section>`);
}

// Destaque do Zoom (18/11/2026): e-mail (conta) e sala do professor em cartão próprio no topo da ficha
function htmlZoomDestaque(s, d) {
  if (!d.professor) return '<div class="ea-zoom ea-zoom-vazio">Defina o professor para ver o e-mail e a sala do Zoom.</div>';
  if (!s) return '<div class="ea-zoom ea-zoom-vazio">Professor <b>sem sala Zoom</b> neste semestre. Escolha na aba Grade da semana › Sala de cada professor.</div>';
  return `<div class="ea-zoom">
    <div class="ea-zoom-campo"><span>E-mail do Zoom</span><b>${esc(s.conta || '—')}</b>${s.conta ? `<button type="button" class="ea-link" data-ea-copiar-txt="${esc(s.conta)}">copiar e-mail</button>` : ''}</div>
    <div class="ea-zoom-campo"><span>Sala do Zoom</span><b>${esc(s.nome || '—')}</b><button type="button" class="ea-link" data-ea-copiar-link="${esc(s.id)}">copiar link</button></div>
  </div>`;
}

function abrirCalendario() {
  const c = dados.calendario || {};
  const br = (iso) => { const [a, m, dd] = String(iso).split('-'); return `${dd}/${m}/${a}`; };
  abrirModal(`Calendário das UAs · ${dados.semestre}`, `
    <p class="ea-sub" style="margin:-.3rem 0 .9rem;font-size:.85rem">Com o início de cada bimestre e o dia da semana da disciplina, a data prevista de cada UA sai sozinha: toda semana nas disciplinas de 12 UAs e a cada 15 dias nas de 6. Os dias sem aula são pulados. A data de uma UA ainda pode ser trocada na ficha da disciplina.</p>
    <div class="ea-form">
      <label>Início do 1º bimestre<input type="date" id="ea-c-ini1" value="${esc(c.inicio1 || '')}" ${podeEditar ? '' : 'disabled'}></label>
      <label>Início do 2º bimestre<input type="date" id="ea-c-ini2" value="${esc(c.inicio2 || '')}" ${podeEditar ? '' : 'disabled'}></label>
      <label class="ea-largo">Dias sem aula (um por linha, dd/mm/aaaa)<textarea id="ea-c-sem" rows="5" ${podeEditar ? '' : 'disabled'} placeholder="21/04/2027&#10;01/05/2027">${esc((c.semAula || []).map(br).join('\n'))}</textarea></label>
    </div>
    ${podeEditar ? '<div class="ea-modal-acoes"><button type="button" class="btn-primary" data-ea-salvar-cal>Salvar calendário</button></div>' : ''}`);
}

function lerForm(novo) {
  const v = (id) => ($(id) ? $(id).value : undefined);
  const corpo = { professor: v('ea-f-prof'), dia: v('ea-f-dia'), horario: v('ea-f-hor'), qtd: Number(v('ea-f-qtd')), obs: v('ea-f-obs') };
  if (novo) Object.assign(corpo, { semestre: dados.semestre, cursoId: v('ea-f-curso'), nome: v('ea-f-nome'), periodo: v('ea-f-periodo'), ch: v('ea-f-ch') });
  return corpo;
}
function trocaDisc(nova) { const i = dados.disciplinas.findIndex(x => x.id === nova.id); if (i >= 0) dados.disciplinas[i] = nova; else dados.disciplinas.push(nova); }

// ================================================================
//  ABA: GRADE DA SEMANA
// ================================================================
function renderGrade() {
  const salas = dados.salas;
  if (!salas.length) { tela().innerHTML = `<div class="ea-card"><b>Nenhuma sala Zoom cadastrada.</b><p class="ea-sub" style="font-size:.86rem">Importe a "LISTAGEM LINKS ZOOM" na aba Salas Zoom.</p></div>`; return; }
  const profs = professores();
  const diasComAula = new Set(dados.disciplinas.map(d => d.dia).filter(Boolean));
  const dias = Object.keys(DIA_ROTULO).filter(d => d !== 'sabado' || diasComAula.has('sabado'));
  if (!dias.includes(diaGrade)) diaGrade = dias[0];
  const conflitos = [];
  const linhas = salas.map(s => {
    const o = ocupantes(s, diaGrade);
    if (o.profs.length > 1 || (o.profs.length && (o.fixo || o.avulsa))) conflitos.push(s);
    const profsHtml = o.profs.map(p => `<div class="ea-ocup-prof"><b>${esc(p.nome)}</b>${p.doDia.map(d => `<span class="ea-sub">${esc(nomeBonito(d.nome))} · ${esc(d.cursoNome)}${d.horario ? ` · ${esc(d.horario)}` : ''}</span>`).join('')}</div>`).join('');
    const avulsa = podeEditar && !o.fixo
      ? `<input class="ea-input" data-ea-ocup="${esc(s.id)}" value="${esc(o.avulsa)}" placeholder="${o.profs.length ? 'outra ocupação (ex.: SM, reserva)' : 'LIVRE — escreva para reservar'}">`
      : (o.avulsa ? `<span>${esc(o.avulsa)}</span>` : '');
    const livre = !o.fixo && !o.profs.length && !o.avulsa;
    return `<tr>
      <td class="ea-nowrap"><b>${esc(s.conta)}</b><span class="ea-sub">${esc(s.nome)}</span></td>
      <td><div class="ea-ocup">${o.fixo ? `<span class="ea-pill marca">FIXA · ${esc(o.fixo)}</span>` : ''}${profsHtml}${avulsa}${livre && !podeEditar ? '<span class="ea-sub">livre</span>' : ''}
        ${o.profs.length > 1 ? '<span class="ea-pill crit">dois professores na mesma sala</span>' : ''}</div></td>
      <td class="ea-nowrap"><button type="button" class="ea-link" data-ea-copiar-link="${esc(s.id)}">copiar link</button></td></tr>`;
  }).join('');
  const salasLivres = salas.filter(s => !s.fixo);
  tela().innerHTML = `
    <div class="ea-ferramentas">
      <div class="ea-pilulas">${dias.map(d => `<button type="button" class="ea-pilula${diaGrade === d ? ' ativo' : ''}" data-ea-dia="${d}">${DIA_ROTULO[d]} <span>${profs.filter(p => p.dias.has(d)).length}</span></button>`).join('')}</div>
      ${podeEditar ? `<div class="ea-direita"><button type="button" class="btn-primary" data-ea-distribuir>Distribuir salas</button></div>` : ''}
    </div>
    ${conflitos.length ? `<div class="ea-card ea-crit">Atenção: ${conflitos.length} sala(s) com mais de uma ocupação na ${esc(DIA_ROTULO[diaGrade])}. Troque a sala de um dos professores abaixo.</div>` : ''}
    <section class="ea-card ea-card-tabela">
      <div class="ea-card-topo"><h3>${esc(DIA_ROTULO[diaGrade])}-feira</h3><span class="ea-sub">${salas.length} salas · ${salas.filter(s => { const o = ocupantes(s, diaGrade); return !o.fixo && !o.profs.length && !o.avulsa; }).length} livres</span></div>
      <div class="ea-tabela-wrap"><table class="ea-tabela"><thead><tr><th>Sala</th><th>Quem usa neste dia</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    </section>
    <section class="ea-card ea-card-tabela">
      <div class="ea-card-topo"><h3>Sala de cada professor</h3><span class="ea-sub">O mesmo link em todos os dias em que o professor dá aula. "Distribuir salas" escolhe, para quem não tem, uma sala livre em todos os dias dele.</span></div>
      ${profs.length ? `<div class="ea-tabela-wrap"><table class="ea-tabela"><thead><tr><th>Professor</th><th>Dias</th><th>Disciplinas</th><th>Sala</th></tr></thead><tbody>
        ${profs.map(p => { const atual = dados.salaDoProfessor[p.chave]?.salaId || ''; return `<tr>
          <td><b>${esc(p.nome)}</b></td>
          <td class="ea-nowrap">${[...p.dias].sort((a, b) => Object.keys(DIA_ROTULO).indexOf(a) - Object.keys(DIA_ROTULO).indexOf(b)).map(d => esc(DIA_ROTULO[d])).join(', ') || '<span class="ea-sub">sem dia</span>'}</td>
          <td>${p.discs.length}<span class="ea-sub">${p.discs.slice(0, 3).map(d => esc(nomeBonito(d.nome))).join(' · ')}${p.discs.length > 3 ? '…' : ''}</span></td>
          <td>${podeEditar ? `<select class="select-filter" data-ea-sala-prof="${esc(p.nome)}"><option value="">— sem sala —</option>${salasLivres.map(s => `<option value="${esc(s.id)}" ${atual === s.id ? 'selected' : ''}>${esc(nomeSala(s))}</option>`).join('')}</select>` : esc(nomeSala(salaPorId(atual)))}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<p class="ea-vazio">Nenhum professor com disciplina neste semestre.</p>'}
    </section>`;
}

// ================================================================
//  ABA: SALAS ZOOM
// ================================================================
function renderSalas() {
  const ss = dados.salas;
  tela().innerHTML = `
    <div class="ea-ferramentas"><span class="ea-sub" style="font-size:.84rem">${ss.length} salas · ${ss.filter(s => s.fixo).length} fixas de setor (não entram na distribuição)</span>
      ${podeEditar ? `<div class="ea-direita"><button type="button" class="btn-secondary" data-ea-importar="salas">Importar planilha do Zoom</button><button type="button" class="btn-primary" data-ea-nova-sala>Nova sala</button></div>` : ''}</div>
    <section class="ea-card ea-card-tabela">
      ${ss.length ? `<div class="ea-tabela-wrap"><table class="ea-tabela"><thead><tr><th>Conta</th><th>Sala</th><th>Link</th><th>Senha</th><th>Senha anfitrião</th><th></th></tr></thead><tbody>
        ${ss.map(s => `<tr>
          <td class="ea-nowrap"><b>${esc(s.conta)}</b></td>
          <td>${esc(s.nome)}${s.fixo ? `<span class="ea-sub"><span class="ea-pill marca">FIXA · ${esc(s.fixo)}</span></span>` : ''}</td>
          <td class="ea-nowrap"><button type="button" class="ea-link" data-ea-copiar-link="${esc(s.id)}">copiar link</button> · <a class="ea-link" href="${esc(s.link)}" target="_blank" rel="noopener">abrir</a></td>
          <td class="ea-senha">${esc(s.senha || '—')}</td>
          <td class="ea-senha">${senhasVisiveis.has(s.id) ? esc(s.senhaAnfitriao || '—') : '••••••'} <button type="button" class="ea-link" data-ea-ver-senha="${esc(s.id)}">${senhasVisiveis.has(s.id) ? 'ocultar' : 'ver'}</button></td>
          <td>${podeEditar ? `<button type="button" class="btn-secondary btn-mini" data-ea-editar-sala="${esc(s.id)}">Editar</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="ea-vazio">Nenhuma sala cadastrada. Importe a planilha "LISTAGEM LINKS ZOOM" (Arquivo › Fazer download › Microsoft Excel).</p>'}
    </section>
    <p class="ea-legenda">A senha de anfitrião dá controle das reuniões: esta página é só do T.I. Sala fixa = de setor (NAPED Medicina, Coordenação EAD, Suporte AVA, Direção Acadêmica).</p>`;
}
function abrirSala(id) {
  const s = id ? salaPorId(id) : { conta: '', nome: '', link: '', senha: '', senhaAnfitriao: '', fixo: '' };
  abrirModal(id ? `Sala ${s.conta} · ${s.nome}` : 'Nova sala Zoom', `
    <div class="ea-form">
      <label>Conta<input type="text" id="ea-s-conta" value="${esc(s.conta)}" placeholder="AULA 45"></label>
      <label>Nome da sala<input type="text" id="ea-s-nome" value="${esc(s.nome)}" placeholder="FATEC - EAD - 1"></label>
      <label class="ea-largo">Link do Zoom<input type="url" id="ea-s-link" value="${esc(s.link)}" placeholder="https://us02web.zoom.us/j/..."></label>
      <label>Senha<input type="text" id="ea-s-senha" value="${esc(s.senha)}"></label>
      <label>Senha anfitrião<input type="text" id="ea-s-anf" value="${esc(s.senhaAnfitriao)}"></label>
      <label class="ea-largo">Fixa de setor (vazio = sala de aula)<input type="text" id="ea-s-fixo" value="${esc(s.fixo)}" placeholder="ex.: SUPORTE AVA"></label>
    </div>
    <div class="ea-modal-acoes">${id ? `<button type="button" class="btn-secondary ea-perigo" data-ea-excluir-sala="${esc(id)}">Excluir</button>` : ''}<button type="button" class="btn-primary" data-ea-salvar-sala="${esc(id || '')}">Salvar</button></div>`);
}

// ================================================================
//  ABA: RELATÓRIO DO DIA (texto para o coordenador EAD)
// ================================================================
function temDatas() { return dados.disciplinas.some(d => d.professor && Object.values(datasPrevistas(d)).some(x => x.data)); }
// Filtros do relatório (18/11/2026): período (data inicial e final; sem final = até hoje), professor, disciplina e
// "só com observação" (lista apenas as UAs com observação, para cobrar o professor ou o T.I).
function discsDoRelatorio() {
  return dados.disciplinas.filter(d => d.professor && (!relProf || chaveProf(d.professor) === relProf) && (!relDisc || d.id === relDisc));
}
const rotuloItem = (it, gi) => `${it.rotulo}${it.revisao && gi?.tipo ? ` [${TIPO_REVISAO[gi.tipo.tipo] || gi.tipo.tipo}]` : ''}`;
function textoRelatorio() {
  const pelaData = relModo === 'data' && temDatas();
  const bim = Number(relBim), ate = Number(relAte);
  const hoje = hojeIso();
  const hojeBR = new Date().toLocaleDateString('pt-BR');
  const ini = relIni || '', fim = relFim || hoje;
  const noPeriodo = (dt) => !!dt && (!ini || dt >= ini) && dt <= fim;
  // o que já deveriam estar gravado: pela data (prevista no período e até hoje) ou até a UA "ate" do bimestre
  // (nas de 6 UAs, proporcional: 3 por bimestre; a revisão entra quando ate = 6)
  const doRecorte = (d, it, ds) => {
    if (pelaData) return noPeriodo(ds[it.id].data);
    if (it.bimestre !== bim) return false;
    if (it.revisao) return ate >= 6;
    const n = Number(it.id.slice(3)); const meio = (d.qtd || 12) / 2;
    return n - (bim === 2 ? meio : 0) <= Math.ceil(ate * meio / 6);
  };
  const devidas = (d, ds) => d.itens.filter(it => doRecorte(d, it, ds) && (!pelaData || ds[it.id].data <= hoje));
  const ds0 = discsDoRelatorio();
  const pendGrav = new Map(), pendPub = [], ok = [], naoGravou = [], deHoje = [], comObs = [];
  ds0.forEach(d => {
    const ds = datasPrevistas(d); const g = d.gravacoes || {};
    const its = devidas(d, ds);
    const quem = `${nomeBonito(d.nome)} (${d.cursoNome}) — Prof. ${d.professor}`;
    const dtTxt = (it) => (ds[it.id].data ? ` (${dataBR(ds[it.id].data)})` : '');
    // UA sem data entra em "não gravou"/"observação" só quando não há período escolhido
    const noRecorte = (it) => (pelaData ? (ds[it.id].data ? noPeriodo(ds[it.id].data) : !relIni && !relFim) : doRecorte(d, it, ds));
    if (pelaData && noPeriodo(hoje)) d.itens.forEach(it => { if (ds[it.id].data === hoje) deHoje.push(`${quem}: ${rotuloItem(it, g[it.id])}${g[it.id]?.gravou ? ' ✓ gravada' : ''}`); });
    d.itens.forEach(it => { if (g[it.id]?.naoGravou && noRecorte(it)) naoGravou.push(`${quem}: ${it.rotulo}${dtTxt(it)} — ${g[it.id].naoGravou.motivo}`); });
    d.itens.forEach(it => {
      const gi = g[it.id];
      if (!gi?.obs || !noRecorte(it)) return;
      const est = gi.naoGravou ? 'não gravou' : gi.ava ? 'no AVA' : gi.gravou ? 'gravada' : 'sem gravar';
      comObs.push(`${quem}: ${rotuloItem(it, gi)}${dtTxt(it)} [${est}] — ${gi.obs.texto}`);
    });
    const semGravar = its.filter(it => !g[it.id]?.gravou && !g[it.id]?.naoGravou);
    const semPublicar = its.filter(it => g[it.id]?.gravou && !g[it.id]?.ava);
    if (semGravar.length) { const k = d.professor; if (!pendGrav.has(k)) pendGrav.set(k, []); pendGrav.get(k).push(`${nomeBonito(d.nome)} (${d.cursoNome}): ${semGravar.map(it => `${it.rotulo}${dtTxt(it)}`).join(', ')}`); }
    if (semPublicar.length) pendPub.push(`${quem}: ${semPublicar.map(it => { const gi = g[it.id]; const falta = !gi.baixou ? 'baixar' : !gi.youtube ? 'YouTube' : 'AVA'; return `${rotuloItem(it, gi)} (falta ${falta})`; }).join(', ')}`);
    if (its.length && !semGravar.length && !semPublicar.length) ok.push(d);
  });
  const recorte = pelaData ? `UAs com data prevista ${ini ? `de ${dataBR(ini)} ` : ''}até ${fim === hoje ? 'hoje' : dataBR(fim)}` : `${bim}º bimestre, até a ${ate === 6 ? 'revisão' : `UA ${String(ate).padStart(2, '0')}`}`;
  const filtros = [relProf && ds0[0] ? `Prof. ${ds0[0].professor}` : '', relDisc && ds0[0] ? `${nomeBonito(ds0[0].nome)} (${ds0[0].cursoNome})` : ''].filter(Boolean).join(' · ');
  const L = [`${relSoObs ? 'OBSERVAÇÕES DAS GRAVAÇÕES EAD' : 'GRAVAÇÕES EAD'} — ${hojeBR} · semestre ${dados.semestre.replace('.', '/')}`, recorte + (filtros ? ` · ${filtros}` : ''), ''];
  if (relSoObs) {
    L.push(`UAs COM OBSERVAÇÃO (${comObs.length})`);
    if (!comObs.length) L.push('• Nenhuma.');
    comObs.forEach(t => L.push(`• ${t}`));
    return L.join('\n');
  }
  if (pelaData && noPeriodo(hoje)) { L.push(`PREVISTAS PARA HOJE (${deHoje.length})`); if (!deHoje.length) L.push('• Nenhuma.'); deHoje.forEach(t => L.push(`• ${t}`)); L.push(''); }
  L.push(`${pelaData ? 'ATRASADAS — ' : ''}PENDENTES DE GRAVAÇÃO (${pendGrav.size} professor(es))`);
  if (!pendGrav.size) L.push('• Nenhuma.');
  [...pendGrav.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).forEach(([p, itens]) => { L.push(`• Prof. ${p}`); itens.forEach(t => L.push(`   - ${t}`)); });
  if (naoGravou.length) { L.push('', `NÃO GRAVADAS, COM MOTIVO (${naoGravou.length})`); naoGravou.forEach(t => L.push(`• ${t}`)); }
  L.push('', `GRAVADAS, AGUARDANDO PUBLICAÇÃO PELO T.I (${pendPub.length})`);
  if (!pendPub.length) L.push('• Nenhuma.');
  pendPub.forEach(t => L.push(`• ${t}`));
  if (comObs.length) { L.push('', `OBSERVAÇÕES (${comObs.length})`); comObs.forEach(t => L.push(`• ${t}`)); }
  L.push('', `EM DIA (gravadas e no AVA): ${ok.length} disciplina(s)`);
  ok.forEach(d => L.push(`• ${nomeBonito(d.nome)} (${d.cursoNome}) — Prof. ${d.professor}`));
  const semProf = dados.disciplinas.filter(d => !d.professor).length;
  if (semProf && !relProf && !relDisc) L.push('', `Obs.: ${semProf} disciplina(s) ainda sem professor definido não entram neste relatório.`);
  return L.join('\n');
}
function renderRelatorio() {
  const comDatas = temDatas();
  const pelaData = relModo === 'data' && comDatas;
  const comProf = dados.disciplinas.filter(d => d.professor);
  const profs = [...new Map(comProf.map(d => [chaveProf(d.professor), d.professor])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  if (relProf && !profs.some(([k]) => k === relProf)) relProf = '';
  const discs = comProf.filter(d => !relProf || chaveProf(d.professor) === relProf).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.cursoNome.localeCompare(b.cursoNome, 'pt-BR'));
  if (relDisc && !discs.some(d => d.id === relDisc)) relDisc = '';
  const algumFiltro = relIni || relFim || relProf || relDisc || relSoObs;
  tela().innerHTML = `
    <div class="ea-ferramentas">
      <label>Considerar<select class="select-filter" data-ea-rel-modo>
        <option value="data" ${pelaData ? 'selected' : ''} ${comDatas ? '' : 'disabled'}>Pelas datas previstas${comDatas ? '' : ' — sem calendário'}</option>
        <option value="ua" ${pelaData ? '' : 'selected'}>Até uma unidade</option></select></label>
      ${pelaData ? `<label>De<input type="date" class="ea-input" data-ea-rel-ini value="${esc(relIni)}" aria-label="Data inicial"></label>
      <label>Até<input type="date" class="ea-input" data-ea-rel-fim value="${esc(relFim)}" aria-label="Data final (vazio = hoje)" title="Vazio = até hoje"></label>`
      : `<label>Bimestre<select class="select-filter" data-ea-rel-bim>${['1', '2'].map(b => `<option value="${b}" ${relBim === b ? 'selected' : ''}>${b}º bimestre</option>`).join('')}</select></label>
      <label>Até a unidade<select class="select-filter" data-ea-rel-ate>${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}" ${Number(relAte) === n ? 'selected' : ''}>${n === 6 ? 'UA 06 + revisão' : `UA ${String(n).padStart(2, '0')}`}</option>`).join('')}</select></label>`}
      <label>Professor<select class="select-filter" data-ea-rel-prof style="max-width:240px"><option value="">Todos</option>${profs.map(([k, n]) => `<option value="${esc(k)}" ${relProf === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label>Disciplina<select class="select-filter" data-ea-rel-disc style="max-width:280px"><option value="">Todas</option>${discs.map(d => `<option value="${esc(d.id)}" ${relDisc === d.id ? 'selected' : ''}>${esc(nomeBonito(d.nome))} · ${esc(d.cursoNome)}</option>`).join('')}</select></label>
      <label class="ea-check-label"><input type="checkbox" data-ea-rel-obs ${relSoObs ? 'checked' : ''}> Só com observação</label>
      ${algumFiltro ? '<button type="button" class="btn-secondary" data-ea-rel-limpar>Limpar filtros</button>' : ''}
      <div class="ea-direita"><button type="button" class="btn-primary" data-ea-copiar-rel>Copiar relatório</button></div>
    </div>
    <section class="ea-card"><pre class="ea-relatorio" id="ea-rel-texto">${esc(textoRelatorio())}</pre></section>
    <p class="ea-legenda">${comDatas ? '"Pelas datas" usa a data prevista de cada UA (calendário ou data ajustada na ficha). Sem "Até", o período vai até hoje; UA com data futura dentro do período não conta como atrasada.' : 'Quando houver calendário das UAs (ou datas digitadas nas fichas), o relatório passa a usar as datas e o filtro de período.'} "Até a unidade" conta as UAs do bimestre que já deveriam estar gravadas (nas de 6 UAs, a proporção: UA 06 das de 12 = UA 03 das de 6). "Só com observação" lista apenas as UAs com observação. Copie e cole no WhatsApp ou no e-mail do coordenador EAD.</p>`;
}

// ================================================================
//  IMPORTAÇÃO (prévia → confirmar)
// ================================================================
function lerArquivo(arquivo) {
  return new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => erro(new Error('Não consegui ler o arquivo.')); r.readAsDataURL(arquivo); });
}
async function previaImportacao(tipo, base64) {
  abrirModal(tipo === 'salas' ? 'Importar salas Zoom' : 'Importar disciplinas', '<p class="ea-vazio">Lendo a planilha...</p>');
  try {
    const url = tipo === 'salas' ? `/${MODULO}/salas/importar` : `/${MODULO}/disciplinas/importar`;
    const r = await apiFetch(url, { method: 'POST', body: JSON.stringify({ semestre: dados.semestre, arquivoBase64: base64, aplicar: false }) });
    importando = { tipo, base64 };
    const p = r.previa;
    const n = (a) => p.filter(x => x.acao === a).length;
    const corpo = tipo === 'salas'
      ? `<p>${p.length} salas na planilha: <b>${n('nova')}</b> novas, <b>${n('atualizar')}</b> já cadastradas (link igual) serão atualizadas.</p>
        <div class="ea-tabela-wrap" style="max-height:45vh"><table class="ea-tabela"><thead><tr><th>Conta</th><th>Sala</th><th>Fixa</th><th></th></tr></thead><tbody>
        ${p.map(s => `<tr><td>${esc(s.conta)}</td><td>${esc(s.nome)}</td><td>${esc(s.fixo || '')}</td><td><span class="ea-pill ${s.acao === 'nova' ? 'bom' : ''}">${s.acao}</span></td></tr>`).join('')}</tbody></table></div>`
      : `<p>${p.length} disciplinas de ${esc(dados.semestre)}: <b>${n('nova')}</b> novas, <b>${n('atualizar')}</b> com dia/horário/professor atualizados, ${n('igual')} sem mudança.${r.ignoradas.length ? ` ${r.ignoradas.length} linha(s) ignorada(s).` : ''}</p>
        <p class="ea-sub">Célula vazia na planilha não apaga o que já estiver preenchido aqui. Gravações não são mexidas.</p>
        <div class="ea-tabela-wrap" style="max-height:45vh"><table class="ea-tabela"><thead><tr><th>Curso</th><th>Disciplina</th><th>Dia/horário</th><th>Professor</th><th></th></tr></thead><tbody>
        ${p.filter(x => x.acao !== 'igual').map(x => `<tr><td>${esc(x.cursoNome)}<span class="ea-sub">${esc(periodoTxt(x.periodo))}</span></td><td>${esc(nomeBonito(x.nome))}</td><td>${esc(DIA_ROTULO[x.dia] || '')}<span class="ea-sub">${esc(x.horario)}</span></td><td>${esc(x.professor)}</td><td><span class="ea-pill ${x.acao === 'nova' ? 'bom' : 'alerta'}">${x.acao === 'nova' ? 'nova' : 'atualiza ' + x.muda.join(', ')}</span></td></tr>`).join('') || '<tr><td colspan="5" class="ea-vazio">Nada novo para gravar.</td></tr>'}
        ${r.ignoradas.map(x => `<tr><td>${esc(x.cursoTxt)}</td><td>${esc(x.nome)}</td><td colspan="2" class="ea-sub">linha ${x.linha}</td><td><span class="ea-pill crit">${esc(x.motivo)}</span></td></tr>`).join('')}</tbody></table></div>`;
    abrirModal(tipo === 'salas' ? 'Importar salas Zoom' : `Importar disciplinas ${dados.semestre}`, `${corpo}
      <div class="ea-modal-acoes"><button type="button" class="btn-secondary" data-ea-fechar-modal>Cancelar</button><button type="button" class="btn-primary" data-ea-confirmar-import ${tipo !== 'salas' && !p.some(x => x.acao !== 'igual') ? 'disabled' : ''}>Confirmar importação</button></div>`);
  } catch (e) { abrirModal('Importar', `<div class="ea-card ea-erro">${esc(e.message)}</div>`); }
}
async function confirmarImportacao(btn) {
  if (!importando) return;
  btn.disabled = true; btn.textContent = 'Gravando...';
  try {
    const url = importando.tipo === 'salas' ? `/${MODULO}/salas/importar` : `/${MODULO}/disciplinas/importar`;
    const r = await apiFetch(url, { method: 'POST', body: JSON.stringify({ semestre: dados.semestre, arquivoBase64: importando.base64, aplicar: true }) });
    importando = null; fecharModal(); toast(r.message); await carregar();
  } catch (e) { toast(e.message, 'erro'); btn.disabled = false; btn.textContent = 'Confirmar importação'; }
}

// ================================================================
//  EVENTOS
// ================================================================
async function acao(e) {
  const t = e.target.closest('button, [data-ea-disc], input[type="checkbox"]');
  if (!t || t.disabled) return;
  try {
    if (t.dataset.eaFecharModal !== undefined) return fecharModal();
    if (t.dataset.eaSit) { filtroSit = t.dataset.eaSit; return render(); }
    if (t.dataset.eaLimparFiltros !== undefined) { filtroCurso = filtroDia = filtroProf = filtroData = busca = ''; filtroSit = 'todas'; return render(); }
    if (t.dataset.eaRelLimpar !== undefined) { relIni = relFim = relProf = relDisc = ''; relSoObs = false; return render(); }
    if (t.dataset.eaDia) { diaGrade = t.dataset.eaDia; return render(); }
    if (t.dataset.eaDisc && t.tagName === 'TR') return abrirDisciplina(t.dataset.eaDisc);
    if (t.dataset.eaCienteDisc) {
      t.disabled = true;
      await marcarCiente([...new Set(mudancasDaDisc(t.dataset.eaCienteDisc).map(m => m.altId))]);
      toast('Ciente.'); render(); return abrirDisciplina(t.dataset.eaCienteDisc);
    }
    if (t.dataset.eaImportar) { $('ea-arquivo').dataset.tipo = t.dataset.eaImportar; $('ea-arquivo').value = ''; return $('ea-arquivo').click(); }
    if (t.dataset.eaConfirmarImport !== undefined) return confirmarImportacao(t);
    if (t.dataset.eaCopiarLink) { const s = salaPorId(t.dataset.eaCopiarLink); return s && copiar(s.link, `Link copiado: ${nomeSala(s)}`); }
    if (t.dataset.eaCopiarTxt) return copiar(t.dataset.eaCopiarTxt, `Copiado: ${t.dataset.eaCopiarTxt}`);
    if (t.dataset.eaVerSenha) { senhasVisiveis.has(t.dataset.eaVerSenha) ? senhasVisiveis.delete(t.dataset.eaVerSenha) : senhasVisiveis.add(t.dataset.eaVerSenha); return render(); }
    if (t.dataset.eaCopiarRel !== undefined) return copiar(textoRelatorio(), 'Relatório copiado.');
    if (t.dataset.eaNovaDisc !== undefined) return abrirModal('Nova disciplina EAD', `${htmlFormDisc(null)}<div class="ea-modal-acoes"><button type="button" class="btn-primary" data-ea-criar-disc>Cadastrar</button></div>`);
    if (t.dataset.eaCriarDisc !== undefined) {
      t.disabled = true;
      const nova = await apiFetch(`/${MODULO}/disciplinas`, { method: 'POST', body: JSON.stringify(lerForm(true)) });
      trocaDisc(nova); fecharModal(); toast('Disciplina cadastrada.'); return render();
    }
    if (t.dataset.eaSalvarDisc) {
      t.disabled = true;
      const nova = await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(t.dataset.eaSalvarDisc)}`, { method: 'PUT', body: JSON.stringify(lerForm(false)) });
      trocaDisc(nova); toast('Dados salvos.'); render(); return abrirDisciplina(nova.id);
    }
    if (t.dataset.eaExcluirDisc) {
      if (!confirm('Excluir esta disciplina e as marcações de gravação dela?')) return;
      await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(t.dataset.eaExcluirDisc)}`, { method: 'DELETE' });
      dados.disciplinas = dados.disciplinas.filter(d => d.id !== t.dataset.eaExcluirDisc); fecharModal(); toast('Disciplina excluída.'); return render();
    }
    if (t.dataset.eaCalendario !== undefined) return abrirCalendario();
    if (t.dataset.eaSalvarCal !== undefined) {
      const semAula = $('ea-c-sem').value.split(/\n|,|;/).map(x => x.trim()).filter(Boolean).map(x => { const m = x.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; });
      if (semAula.includes(null)) { toast('Escreva os dias sem aula como dd/mm/aaaa, um por linha.', 'erro'); return; }
      t.disabled = true;
      const r = await apiFetch(`/${MODULO}/semestre/${dados.semestre}/calendario`, { method: 'PUT', body: JSON.stringify({ inicio1: $('ea-c-ini1').value, inicio2: $('ea-c-ini2').value, semAula }) });
      dados.calendario = r.calendario; fecharModal(); toast('Calendário salvo: as datas das UAs foram calculadas.'); return render();
    }
    if (t.dataset.eaNaoGravou || t.dataset.eaNaoGravouLimpar || t.dataset.eaDataLimpar) {
      const tab = t.closest('[data-ea-disc-grav]');
      let corpo;
      if (t.dataset.eaNaoGravou) {
        const motivo = window.prompt('Por que o professor não gravou esta unidade? (ex.: falta, feriado, reposição marcada)');
        if (!motivo || !motivo.trim()) return;
        corpo = { item: t.dataset.eaNaoGravou, naoGravou: motivo.trim() };
      } else if (t.dataset.eaNaoGravouLimpar) corpo = { item: t.dataset.eaNaoGravouLimpar, naoGravou: '' };
      else corpo = { item: t.dataset.eaDataLimpar, data: '' };
      const nova = await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(tab.dataset.eaDiscGrav)}/item`, { method: 'PATCH', body: JSON.stringify(corpo) });
      trocaDisc(nova); render(); return abrirDisciplina(nova.id);
    }
    if (t.dataset.eaGrav) {
      const tab = t.closest('[data-ea-disc-grav]');
      t.disabled = true;
      const nova = await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(tab.dataset.eaDiscGrav)}/gravacao`, { method: 'PATCH', body: JSON.stringify({ item: t.dataset.eaGrav, etapa: t.dataset.eaEtapa, feito: t.checked }) });
      trocaDisc(nova); render(); return abrirDisciplina(nova.id);
    }
    if (t.dataset.eaDistribuir !== undefined) {
      t.disabled = true;
      const r = await apiFetch(`/${MODULO}/semestre/${dados.semestre}/distribuir`, { method: 'POST', body: '{}' });
      dados.salaDoProfessor = r.salaDoProfessor; toast(r.message, r.semSala.length ? 'erro' : ''); return render();
    }
    if (t.dataset.eaNovaSala !== undefined) return abrirSala(null);
    if (t.dataset.eaEditarSala) return abrirSala(t.dataset.eaEditarSala);
    if (t.dataset.eaSalvarSala !== undefined) {
      const corpo = { conta: $('ea-s-conta').value, nome: $('ea-s-nome').value, link: $('ea-s-link').value, senha: $('ea-s-senha').value, senhaAnfitriao: $('ea-s-anf').value, fixo: $('ea-s-fixo').value };
      t.disabled = true;
      const id = t.dataset.eaSalvarSala;
      const s = await apiFetch(`/${MODULO}/salas${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(corpo) });
      const i = dados.salas.findIndex(x => x.id === s.id); if (i >= 0) dados.salas[i] = s; else dados.salas.push(s);
      fecharModal(); toast('Sala salva.'); return render();
    }
    if (t.dataset.eaExcluirSala) {
      if (!confirm('Excluir esta sala do cadastro?')) return;
      await apiFetch(`/${MODULO}/salas/${encodeURIComponent(t.dataset.eaExcluirSala)}`, { method: 'DELETE' });
      dados.salas = dados.salas.filter(s => s.id !== t.dataset.eaExcluirSala); fecharModal(); toast('Sala excluída.'); return render();
    }
  } catch (err) {
    toast(err.message, 'erro'); t.disabled = false;
    if (t.type === 'checkbox') t.checked = !t.checked;
  }
}

async function mudanca(e) {
  const t = e.target;
  try {
    if (t.dataset.eaCurso !== undefined) { filtroCurso = t.value; return render(); }
    if (t.dataset.eaFDia !== undefined) { filtroDia = t.value; return render(); }
    if (t.dataset.eaFProf !== undefined) { filtroProf = t.value; return render(); }
    if (t.dataset.eaFData !== undefined) { filtroData = t.value; return render(); }
    if (t.dataset.eaRelBim !== undefined) { relBim = t.value; return render(); }
    if (t.dataset.eaRelModo !== undefined) { relModo = t.value; return render(); }
    if (t.dataset.eaRelAte !== undefined) { relAte = Number(t.value); return render(); }
    if (t.dataset.eaRelIni !== undefined) { relIni = t.value; return render(); }
    if (t.dataset.eaRelFim !== undefined) { relFim = t.value; return render(); }
    if (t.dataset.eaRelProf !== undefined) { relProf = t.value; relDisc = ''; return render(); }
    if (t.dataset.eaRelDisc !== undefined) { relDisc = t.value; return render(); }
    if (t.dataset.eaRelObs !== undefined) { relSoObs = t.checked; return render(); }
    if (t.dataset.eaSalaProf !== undefined) {
      const r = await apiFetch(`/${MODULO}/semestre/${dados.semestre}/sala-professor`, { method: 'PUT', body: JSON.stringify({ professor: t.dataset.eaSalaProf, salaId: t.value }) });
      dados.salaDoProfessor = r.salaDoProfessor; toast('Sala do professor salva.'); return render();
    }
    if (t.dataset.eaOcup !== undefined) {
      const r = await apiFetch(`/${MODULO}/semestre/${dados.semestre}/ocupacao`, { method: 'PUT', body: JSON.stringify({ dia: diaGrade, salaId: t.dataset.eaOcup, texto: t.value }) });
      dados.ocupacoes = r.ocupacoes; toast('Ocupação salva.'); return render();
    }
  } catch (err) { toast(err.message, 'erro'); }
}

function ligarEventos() {
  $('ea-avisos-ead').addEventListener('click', async (e) => {
    if (e.target.closest('[data-ea-avisos-abrir]')) { avisosAbertos = !avisosAbertos; return renderAvisosEad(); }
    const um = e.target.closest('[data-ea-ciente]');
    const b = um || e.target.closest('[data-ea-avisos-visto]');
    if (!b) return;
    b.disabled = true;
    try {
      await marcarCiente(um ? [um.dataset.eaCiente] : avisosPendentes().map(i => i.id));
      if (!um) avisosAbertos = false;
      renderAvisosEad(); if (dados) render(); toast('Ciente.');
    } catch (err) { toast(err.message, 'erro'); b.disabled = false; }
  });
  $('ea-semestre').addEventListener('change', carregar);
  $('ea-abas').addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (!b) return; aba = b.dataset.aba; render(); });
  tela().addEventListener('click', acao);
  tela().addEventListener('change', mudanca);
  let tBusca;
  tela().addEventListener('input', (e) => {
    if (e.target.dataset.eaBusca === undefined) return;
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { busca = e.target.value; render(); const i = tela().querySelector('[data-ea-busca]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
  });
  tela().addEventListener('keydown', (e) => { const l = e.target.closest('tr[data-ea-disc]'); if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrirDisciplina(l.dataset.eaDisc); } });
  $('ea-modal').addEventListener('change', async (e) => {
    const i = e.target.closest('[data-ea-data], [data-ea-obs], [data-ea-tipo]');
    if (!i) return;
    const tab = i.closest('[data-ea-disc-grav]');
    const corpo = i.dataset.eaData ? { item: i.dataset.eaData, data: i.value }
      : i.dataset.eaObs ? { item: i.dataset.eaObs, obs: i.value.trim() }
        : { item: i.dataset.eaTipo, tipo: i.value };
    const msg = i.dataset.eaData ? 'Data da UA salva.' : i.dataset.eaObs ? (corpo.obs ? 'Observação salva.' : 'Observação apagada.') : 'Tipo da revisão salvo.';
    const rolagem = $('ea-modal').scrollTop;
    try {
      const nova = await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(tab.dataset.eaDiscGrav)}/item`, { method: 'PATCH', body: JSON.stringify(corpo) });
      trocaDisc(nova); toast(msg); render(); abrirDisciplina(nova.id); $('ea-modal').scrollTop = rolagem;
    } catch (err) { toast(err.message, 'erro'); }
  });
  $('ea-modal').addEventListener('click', (e) => {
    if (e.target === $('ea-modal') || e.target.closest('#ea-modal-fechar')) return fecharModal();
    acao(e);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });
  $('ea-arquivo').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await previaImportacao(e.target.dataset.tipo, await lerArquivo(f)); } catch (err) { toast(err.message, 'erro'); }
  });
}

async function initApp(user, role, nivel) {
  appInitialized = true; initializedRole = role; podeEditar = nivel >= 3;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../../auth/login.html'; });
  $('auth-guard').classList.add('hidden');
  $('app').classList.remove('hidden');
  ligarEventos();
  let semestres = [];
  try { semestres = await apiFetch(`/${MODULO}/semestres`); } catch (e) { toast(e.message, 'erro'); }
  const padrao = semestres.includes('2027.1') ? '2027.1' : (semestres[1] || semestres[0] || '');
  $('ea-semestre').innerHTML = semestres.map(s => `<option value="${esc(s)}" ${s === padrao ? 'selected' : ''}>${esc(s)}</option>`).join('');
  await carregar();
}

const cached = getCachedAuth();
onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../../auth/login.html'; return; }
  currentUser = user;
  let role = 'visitante', meuOverrides = null;
  try { const u = await apiFetch('/usuarios/me'); role = u.role || 'visitante'; meuOverrides = u.permissoes || null; }
  catch (e) { role = cached ? cached.role : 'visitante'; }
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
  if (!appInitialized || initializedRole !== role) initApp(user, role, nivel);
});
