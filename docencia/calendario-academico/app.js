// ================================================================
//  ÓRBITA — CALENDÁRIO ACADÊMICO (Docência, 23/11/2026)
//  Diretor acadêmico (Roni) e ajudante (Thalia): copiam um semestre anterior (carregado do Edubox) e ajustam.
//  Publicado → Agenda Interna (lida na hora) e site novo (/api/publico/calendario-academico).
//  Servidor: src/rotas/calendario-academico.js · regras: src/utils/calendarioAcademico.js
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
  ? `http://${location.hostname}:3000/api` : '/api';
const MODULO = 'calendario-academico';
const $ = (id) => document.getElementById(id);
const COR = { feriado: 'var(--ca-feriado)', recesso: 'var(--ca-recesso)', letivo: 'var(--ca-letivo)', avaliacao: 'var(--ca-avaliacao)', prazo: 'var(--ca-prazo)', evento: 'var(--ca-evento)', reuniao: 'var(--ca-reuniao)', outro: 'var(--ca-outro)' };
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_C = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const ST_ROT = { modelo: 'Modelo (Edubox)', rascunho: 'Rascunho', publicado: 'Publicado' };

let currentUser = null, appInitialized = false;
let tipos = {}, semestres = [], calendario = 'graduacao', semestre = '', dados = { semestre: null, eventos: [] };
let vista = 'lista', filtro = '', editando = null;

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error || `Erro ${res.status}`); e.status = res.status; throw e; }
  return j;
}
let toastTimer;
function toast(msg, tipo = '') { const t = $('ca-toast'); t.textContent = msg; t.className = `ca-toast ${tipo}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3800); }
const dLocal = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d, 12); };
const isoDe = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ddmm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const dataBR = (iso) => iso ? iso.split('-').reverse().join('/') : '';
function periodo(e) {
  const d1 = dLocal(e.inicio);
  if (!e.fim || e.fim === e.inicio) return `<span class="ca-data">${ddmm(e.inicio)}<small>${DIAS[d1.getDay()]}</small></span>`;
  return `<span class="ca-data">${ddmm(e.inicio)} a ${ddmm(e.fim)}<small>${DIAS_C[d1.getDay()]} a ${DIAS_C[dLocal(e.fim).getDay()]}</small></span>`;
}
const abrir = (id) => $(id).classList.remove('hidden');
const fechar = (id) => $(id).classList.add('hidden');

// ---------- carregar ----------
async function carregarSemestres(selecionar) {
  const r = await apiFetch('/calendario-academico/semestres');
  tipos = r.tipos; semestres = r.semestres;
  const deste = semestres.filter(s => s.calendario === calendario).map(s => s.semestre);
  const lista = [...new Set(deste)].sort().reverse();
  if (selecionar) semestre = selecionar;
  if (!lista.includes(semestre)) semestre = lista[0] || '';
  $('ca-semestre').innerHTML = lista.length ? lista.map(s => { const info = semestres.find(x => x.semestre === s && x.calendario === calendario); return `<option value="${s}" ${s === semestre ? 'selected' : ''}>${s} · ${ST_ROT[info.status] || info.status} (${info.eventos})</option>`; }).join('') : '<option value="">Nenhum semestre ainda</option>';
  $('ev-tipo').innerHTML = Object.entries(tipos).map(([k, v]) => `<option value="${k}">${esc(v.rotulo)}</option>`).join('');
}
async function carregarEventos() {
  if (!semestre) { dados = { semestre: null, eventos: [] }; render(); return; }
  $('ca-conteudo').innerHTML = '<div class="ca-vazio">Carregando…</div>';
  try { dados = await apiFetch(`/calendario-academico/eventos?semestre=${semestre}&calendario=${calendario}`); render(); }
  catch (e) { $('ca-conteudo').innerHTML = `<div class="ca-vazio">${esc(e.message)}</div>`; }
}

// ---------- tela ----------
function render() {
  const s = dados.semestre, evs = dados.eventos;
  const st = s ? s.status : '';
  $('ca-status').className = `ca-status ${st}`; $('ca-status').textContent = st ? ST_ROT[st] || st : '';
  const pub = $('ca-btn-publicar');
  pub.disabled = !s; pub.textContent = st === 'publicado' ? 'Voltar a rascunho' : 'Publicar';
  pub.className = st === 'publicado' ? 'btn-secondary' : 'btn-primary';
  // resumo e filtros
  const conferir = evs.filter(e => e.conferir).length;
  const comErro = evs.filter(e => (e.avisos || []).some(a => a.nivel === 'erro')).length;
  const comAviso = evs.filter(e => (e.avisos || []).length).length;
  const porTipo = {}; evs.forEach(e => { porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1; });
  const chip = (v, rot, n, cls = '', cor = '') => `<button type="button" class="ca-chip-f ${cls} ${filtro === v ? 'ativo' : ''}" data-filtro="${v}">${cor ? `<span class="ca-bola" style="background:${cor}"></span>` : ''}${rot} <b>${n}</b></button>`;
  $('ca-resumo').innerHTML = !evs.length ? '' : chip('', 'Todos', evs.length)
    + (conferir ? chip('conferir', 'A conferir', conferir, 'conferir') : '')
    + (comAviso ? chip('aviso', comErro ? 'Domingo, sábado ou feriado' : 'Sábado / avisos', comAviso, 'alerta') : '')
    + Object.keys(tipos).filter(k => porTipo[k]).map(k => chip(`t:${k}`, esc(tipos[k].rotulo), porTipo[k], '', COR[k])).join('');
  const lista = evs.filter(e => !filtro || (filtro === 'conferir' && e.conferir) || (filtro === 'aviso' && (e.avisos || []).length) || (filtro.startsWith('t:') && e.tipo === filtro.slice(2)));
  if (!s) { $('ca-conteudo').innerHTML = `<div class="ca-vazio">Ainda não há semestre de ${calendario === 'medicina' ? 'Medicina' : 'Graduação'}. Use <b>Copiar de outro semestre</b> para começar.</div>`; return; }
  if (!lista.length) { $('ca-conteudo').innerHTML = '<div class="ca-vazio">Nenhum evento com esse filtro.</div>'; return; }
  if (vista === 'dias') { renderDias(); return; }
  $('ca-conteudo').innerHTML = vista === 'mes' ? renderMes(lista) : renderLista(lista);
}
function tagsDe(e) {
  return `<span class="ca-tag tipo">${esc((tipos[e.tipo] || {}).rotulo || e.tipo)}</span>`
    + (e.naAgenda === false ? '<span class="ca-tag oculto" title="Não aparece na Agenda Interna">Agenda</span>' : '')
    + (e.noSite === false ? '<span class="ca-tag oculto" title="Não aparece no site">Site</span>' : '')
    + (e.conferir ? `<span class="ca-tag conf" title="${esc(e.regraCopia || '')}">A conferir</span>` : '')
    + (e.avisos || []).map(a => `<span class="ca-tag ${a.nivel}">${esc(a.msg)}</span>`).join('');
}
function renderLista(lista) {
  const porMes = {}; lista.forEach(e => { (porMes[e.inicio.slice(0, 7)] = porMes[e.inicio.slice(0, 7)] || []).push(e); });
  return Object.keys(porMes).sort().map(k => {
    const [a, m] = k.split('-');
    return `<section class="ca-mes"><h3>${MESES[Number(m) - 1][0].toUpperCase() + MESES[Number(m) - 1].slice(1)} de ${a}<small>${porMes[k].length} evento(s)</small></h3>
      ${porMes[k].map(e => `<article class="ca-item ${e.conferir ? 'conferir' : ''}" style="--cor:${COR[e.tipo] || COR.outro}">
        ${periodo(e)}
        <div><div class="ca-tit">${esc(e.titulo)}</div>${e.complemento ? `<div class="ca-comp">${esc(e.complemento)}</div>` : ''}<div class="ca-tags">${tagsDe(e)}</div></div>
        <div class="ca-acoes">${e.conferir ? `<button type="button" class="ca-btn-mini ok" data-conferido="${e.id}" title="A data está certa">Conferido</button>` : ''}<button type="button" class="ca-btn-mini" data-editar="${e.id}">Editar</button></div>
      </article>`).join('')}</section>`;
  }).join('');
}
function renderMes(lista) {
  const meses = [...new Set(lista.map(e => e.inicio.slice(0, 7)))].sort();
  const feriados = new Set(); dados.eventos.filter(e => e.tipo === 'feriado').forEach(e => { for (let d = dLocal(e.inicio); isoDe(d) <= e.fim; d.setDate(d.getDate() + 1)) feriados.add(isoDe(d)); });
  return meses.map(k => {
    const [a, m] = k.split('-').map(Number);
    const primeiro = new Date(a, m - 1, 1, 12), ultimo = new Date(a, m, 0, 12);
    const cels = [];
    for (let i = 0; i < primeiro.getDay(); i++) cels.push('<div class="ca-cel fora"></div>');
    for (let d = new Date(primeiro); d <= ultimo; d.setDate(d.getDate() + 1)) {
      const iso = isoDe(d);
      const doDia = lista.filter(e => e.inicio <= iso && e.fim >= iso);
      cels.push(`<div class="ca-cel ${d.getDay() % 6 === 0 ? 'fds' : ''} ${feriados.has(iso) ? 'feriado' : ''}"><span class="ca-cel-n">${d.getDate()}</span>${doDia.map(e => `<button type="button" class="ca-ev" style="--cor:${COR[e.tipo] || COR.outro}" data-editar="${e.id}" title="${esc(e.titulo + (e.complemento ? ' — ' + e.complemento : ''))}">${esc(e.titulo)}</button>`).join('')}</div>`);
    }
    return `<section class="ca-grade-mes"><h3>${MESES[m - 1][0].toUpperCase() + MESES[m - 1].slice(1)} de ${a}</h3><div class="ca-grade">${DIAS_C.map(d => `<div class="cab">${d}</div>`).join('')}${cels.join('')}</div></section>`;
  }).join('');
}

// ---------- dias letivos (mesma conta da planilha "DIAS LETIVOS" da Direção) ----------
const DS = ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
async function renderDias() {
  const ano = semestre.slice(0, 4);
  $('ca-conteudo').innerHTML = '<div class="ca-vazio">Contando os dias letivos…</div>';
  let r;
  try { r = await apiFetch(`/calendario-academico/dias-letivos?ano=${ano}&calendario=${calendario}`); } catch (e) { $('ca-conteudo').innerHTML = `<div class="ca-vazio">${esc(e.message)}</div>`; return; }
  const linha = (rot, v, cls = '') => `<tr class="${cls}"><th>${rot}</th>${v.map(n => `<td>${n}</td>`).join('')}<td class="ca-dl-tot">${v.reduce((a, b) => a + b, 0)}</td></tr>`;
  const zero = () => [0, 0, 0, 0, 0, 0];
  const totAno = zero(); let metaAno = 0;
  const blocos = r.semestres.map((s, i) => {
    // meses que o semestre ocupa (do 1º ao último dia letivo): o 1º semestre pode entrar em julho
    const mIni = s.de ? Number(s.de.slice(5, 7)) : (i === 0 ? 1 : 7), mFim = s.ate ? Number(s.ate.slice(5, 7)) : (i === 0 ? 6 : 12);
    const meses = []; for (let m = Math.min(mIni, i === 0 ? 1 : 7); m <= Math.max(mFim, i === 0 ? 6 : 12); m++) meses.push(m);
    if (!s.existe) return `<section class="ca-dl-bloco"><h3>${s.semestre}</h3><p class="ca-dica">Semestre ainda não montado.</p></section>`;
    const sub = zero();
    const linhas = meses.map(m => { const k = `${ano}-${String(m).padStart(2, '0')}`; const v = s.porMes[k] || zero(); v.forEach((n, j) => { sub[j] += n; }); return linha(MESES[m - 1].toUpperCase(), v); }).join('');
    sub.forEach((n, j) => { totAno[j] += n; }); metaAno += s.meta;
    const falta = s.meta - s.total;
    return `<section class="ca-dl-bloco">
      <div class="ca-dl-cab"><h3>${s.semestre} <small>${ST_ROT[s.status] || ''}</small></h3>
        <span class="ca-dl-res ${falta > 0 ? 'baixo' : 'ok'}"><b>${s.total}</b> dias letivos · meta ${s.meta}${falta > 0 ? ` · faltam ${falta}` : ' ✓'}</span></div>
      <div class="ca-dl-lim">
        <label class="ca-campo"><span>Primeiro dia letivo</span><input type="date" data-dl="letivoDe" data-id="${s.id}" value="${s.de || ''}"><small>${s.manual.de ? 'definido à mão' : 'automático: Início das aulas'}</small></label>
        <label class="ca-campo"><span>Último dia letivo</span><input type="date" data-dl="letivoAte" data-id="${s.id}" value="${s.ate || ''}"><small>${s.manual.ate ? 'definido à mão' : 'automático: Término do 2º bimestre'}</small></label>
        <label class="ca-campo"><span>Meta do semestre</span><input type="number" min="1" max="200" data-dl="metaDias" data-id="${s.id}" value="${s.meta}"></label>
        ${s.manual.de || s.manual.ate ? `<button type="button" class="ca-btn-mini" data-dl-auto="${s.id}">Voltar ao automático</button>` : ''}
      </div>
      <div class="ca-dl-tab-wrap"><table class="ca-dl-tab"><thead><tr><th></th>${DS.map(d => `<th>${d}</th>`).join('')}<th>DIAS LETIVOS</th></tr></thead>
        <tbody>${linhas}${linha('SUBTOTAL', sub, 'ca-dl-sub')}</tbody></table></div>
      ${s.descontados.length ? `<p class="ca-dica"><b>Não contam (feriado ou recesso):</b> ${s.descontados.map(x => `${ddmm(x.data)} ${esc(x.motivo.toLowerCase())}`).join(' · ')}</p>` : ''}
    </section>`;
  }).join('');
  const tAno = totAno.reduce((a, b) => a + b, 0);
  $('ca-conteudo').innerHTML = `<div class="ca-dl">
    <p class="ca-dica">Conta segunda a sábado entre o primeiro e o último dia letivo, sem feriados e recessos. Para um dia contar ou deixar de contar, mude o tipo do evento (Feriado e Recesso não contam). Calendário: <b>${calendario === 'medicina' ? 'Medicina' : 'Graduação'}</b>.</p>
    ${blocos}
    <section class="ca-dl-bloco ca-dl-ano"><div class="ca-dl-cab"><h3>Total ${ano}</h3><span class="ca-dl-res ${tAno < metaAno ? 'baixo' : 'ok'}"><b>${tAno}</b> dias letivos · meta ${metaAno}</span></div>
      <div class="ca-dl-tab-wrap"><table class="ca-dl-tab"><thead><tr><th></th>${DS.map(d => `<th>${d}</th>`).join('')}<th>DIAS LETIVOS</th></tr></thead><tbody>${linha('TOTAL', totAno, 'ca-dl-sub')}</tbody></table></div></section>
  </div>`;
}
async function salvarLimite(el) {
  const v = el.dataset.dl === 'metaDias' ? Number(el.value) : (el.value || null);
  try { await apiFetch(`/calendario-academico/semestres/${el.dataset.id}`, { method: 'PUT', body: JSON.stringify({ [el.dataset.dl]: v }) }); toast('Dias letivos recalculados.'); renderDias(); }
  catch (e) { toast(e.message, 'erro'); }
}

// ---------- evento ----------
function dicaDatas() {
  const i = $('ev-inicio').value, f = $('ev-fim').value || i; const p = $('ev-dica');
  if (!i) { p.textContent = ''; return; }
  const di = dLocal(i).getDay(), df = dLocal(f).getDay();
  const fer = dados.eventos.find(e => e.tipo === 'feriado' && (!editando || e.id !== editando.id) && i <= e.fim && f >= e.inicio);
  const msgs = [`Começa numa ${DIAS[di]}${f !== i ? ` e termina numa ${DIAS[df]}` : ''}.`];
  if (di === 0 || df === 0) msgs.push('Atenção: cai num domingo.'); else if (di === 6 || df === 6) msgs.push('Cai num sábado.');
  if (fer && $('ev-tipo').value !== 'feriado' && $('ev-tipo').value !== 'recesso') msgs.push(`Cruza com o feriado de ${ddmm(fer.inicio)} (${fer.complemento || fer.titulo}).`);
  p.textContent = msgs.join(' '); p.className = `ca-dica ${di === 0 || df === 0 || fer ? 'erro' : (di === 6 || df === 6 ? 'aviso' : '')}`;
}
function abrirEvento(ev) {
  editando = ev || null;
  $('ca-ev-tit').textContent = ev ? 'Editar evento' : 'Novo evento';
  $('ev-titulo').value = ev ? ev.titulo : ''; $('ev-complemento').value = ev ? ev.complemento || '' : '';
  $('ev-inicio').value = ev ? ev.inicio : ''; $('ev-fim').value = ev ? ev.fim : '';
  $('ev-tipo').value = ev ? ev.tipo : 'evento';
  $('ev-agenda').checked = ev ? ev.naAgenda !== false : true; $('ev-site').checked = ev ? ev.noSite !== false : true;
  $('ev-obs').value = ev ? ev.observacao || '' : '';
  $('ev-excluir').classList.toggle('hidden', !ev); $('ev-excluir').textContent = 'Excluir'; $('ev-excluir').dataset.conf = '';
  $('ev-origem').textContent = ev ? `${ev.origem ? `Origem: ${ev.origem}. ` : ''}${ev.regraCopia ? `Cópia: ${ev.regraCopia}. ` : ''}Última alteração: ${ev.atualizadoPor || '—'}.` : '';
  dicaDatas(); abrir('ca-modal-ev'); $('ev-titulo').focus();
}
async function salvarEvento(ev) {
  ev.preventDefault();
  const corpo = { semestre, calendario, titulo: $('ev-titulo').value, complemento: $('ev-complemento').value, inicio: $('ev-inicio').value, fim: $('ev-fim').value || $('ev-inicio').value, tipo: $('ev-tipo').value, naAgenda: $('ev-agenda').checked, noSite: $('ev-site').checked, observacao: $('ev-obs').value };
  try {
    const r = editando ? await apiFetch(`/calendario-academico/eventos/${editando.id}`, { method: 'PUT', body: JSON.stringify(corpo) }) : await apiFetch('/calendario-academico/eventos', { method: 'POST', body: JSON.stringify(corpo) });
    fechar('ca-modal-ev'); toast(r.message); await carregarSemestres(); await carregarEventos();
  } catch (e) { toast(e.message, 'erro'); }
}
async function excluirEvento() {
  const b = $('ev-excluir');
  if (!b.dataset.conf) { b.dataset.conf = '1'; b.textContent = 'Clique de novo para excluir'; return; }
  try { const r = await apiFetch(`/calendario-academico/eventos/${editando.id}`, { method: 'DELETE' }); fechar('ca-modal-ev'); toast(r.message); await carregarSemestres(); await carregarEventos(); }
  catch (e) { toast(e.message, 'erro'); }
}

// ---------- copiar ----------
const proximoSem = (s) => { const [a, n] = s.split('.').map(Number); return n === 1 ? `${a}.2` : `${a + 1}.1`; };
function abrirCopiar() {
  const deste = [...new Set(semestres.filter(s => s.calendario === calendario && s.eventos).map(s => s.semestre))].sort().reverse();
  if (!deste.length) { toast('Não há semestre com eventos para copiar.', 'erro'); return; }
  const ultimo = deste[0];
  const para = proximoSem(ultimo);
  // modelo do mesmo tipo de semestre (1º copia do 1º do ano anterior)
  const mesmoTipo = deste.find(s => s.endsWith(para.slice(-2))) || ultimo;
  $('cp-de').innerHTML = deste.map(s => `<option ${s === mesmoTipo ? 'selected' : ''}>${s}</option>`).join('');
  $('cp-para').value = para; sugerirInicio(); abrir('ca-modal-copiar');
}
function sugerirInicio() {
  const de = $('cp-de').value, para = $('cp-para').value;
  const base = semestres.find(s => s.semestre === de && s.calendario === calendario);
  const dest = semestres.find(s => s.semestre === para && s.calendario === calendario);
  $('cp-subst-l').classList.toggle('hidden', !(dest && dest.eventos)); $('cp-subst').checked = false;
  if (!base || !base.inicio || !/^\d{4}\.[12]$/.test(para)) { $('cp-dica').textContent = ''; return; }
  const anos = Number(para.slice(0, 4)) - Number(de.slice(0, 4)), mesmo = para.slice(-1) === de.slice(-1);
  const semanas = mesmo ? Math.round(anos * 365.25 / 7) : Math.round((anos * 365.25 + (para.slice(-1) === '2' ? 182 : -182)) / 7);
  const d = dLocal(base.inicio); d.setDate(d.getDate() + semanas * 7);
  $('cp-inicio').value = isoDe(d);
  $('cp-dica').textContent = `Em ${de} o semestre letivo começou em ${dataBR(base.inicio)} (${DIAS[dLocal(base.inicio).getDay()]}). Sugestão para ${para}: ${dataBR(isoDe(d))}, mesmo dia da semana. Ajuste se a data oficial for outra.`;
}
async function copiar(ev) {
  ev.preventDefault();
  const b = $('cp-ok'); b.disabled = true; b.textContent = 'Copiando…';
  try {
    const para = $('cp-para').value;
    const r = await apiFetch('/calendario-academico/copiar', { method: 'POST', body: JSON.stringify({ de: $('cp-de').value, para, calendario, inicioNovo: $('cp-inicio').value, substituir: $('cp-subst').checked }) });
    fechar('ca-modal-copiar'); toast(r.message); filtro = 'conferir'; await carregarSemestres(para); await carregarEventos();
  } catch (e) { toast(e.message, 'erro'); if (e.status === 409) $('cp-subst-l').classList.remove('hidden'); }
  finally { b.disabled = false; b.textContent = 'Copiar'; }
}

// ---------- publicar e site ----------
async function publicar() {
  const s = dados.semestre; if (!s) return;
  const novo = s.status === 'publicado' ? 'rascunho' : 'publicado';
  const pend = dados.eventos.filter(e => e.conferir).length;
  const b = $('ca-btn-publicar');
  if (novo === 'publicado' && pend && b.dataset.conf !== '1') { b.dataset.conf = '1'; b.textContent = `Ainda há ${pend} a conferir. Publicar mesmo assim?`; return; }
  b.dataset.conf = '';
  try { const r = await apiFetch(`/calendario-academico/semestres/${s.id}`, { method: 'PUT', body: JSON.stringify({ status: novo }) }); toast(r.message); await carregarSemestres(); await carregarEventos(); }
  catch (e) { toast(e.message, 'erro'); }
}
function abrirSite() {
  const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'https://orbita-fatec-ti.vercel.app' : location.origin;
  const api = `${base}/api/publico/calendario-academico?semestre=${semestre}&calendario=${calendario}`;
  const pag = `${base}/calendario/?semestre=${semestre}&calendario=${calendario}`;
  $('ca-site-corpo').innerHTML = `
    <p class="ca-dica">Só os semestres <b>publicados</b> aparecem, e só os eventos com "Mostrar no site" marcado. Qualquer edição aqui muda no site em até 5 minutos.</p>
    <label class="ca-campo"><span>Página pronta (para colocar no site com um iframe)</span><div class="ca-codigo">${esc(`<iframe src="${pag}" style="width:100%;height:900px;border:0" title="Calendário Acadêmico"></iframe>`)}</div></label>
    <p><a class="btn-secondary" href="${pag}" target="_blank" rel="noopener">Abrir a página</a></p>
    <label class="ca-campo"><span>Dados em JSON (para o programador do site montar do jeito dele)</span><div class="ca-codigo">${esc(api)}</div></label>`;
  abrir('ca-modal-site');
}

function wire() {
  document.querySelectorAll('.ca-abas [data-cal]').forEach(b => b.addEventListener('click', async () => {
    calendario = b.dataset.cal; document.querySelectorAll('.ca-abas [data-cal]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    filtro = ''; await carregarSemestres(semestre); await carregarEventos();
  }));
  document.querySelectorAll('.ca-vistas [data-vista]').forEach(b => b.addEventListener('click', () => {
    vista = b.dataset.vista; document.querySelectorAll('.ca-vistas [data-vista]').forEach(x => x.setAttribute('aria-selected', String(x === b))); render();
  }));
  $('ca-conteudo').addEventListener('change', (e) => { const el = e.target.closest('[data-dl]'); if (el) salvarLimite(el); });
  $('ca-conteudo').addEventListener('click', async (e) => { const a = e.target.closest('[data-dl-auto]'); if (!a) return; try { await apiFetch(`/calendario-academico/semestres/${a.dataset.dlAuto}`, { method: 'PUT', body: JSON.stringify({ letivoDe: null, letivoAte: null }) }); renderDias(); } catch (er) { toast(er.message, 'erro'); } });
  $('ca-semestre').addEventListener('change', async (e) => { semestre = e.target.value; filtro = ''; await carregarEventos(); });
  $('ca-resumo').addEventListener('click', (e) => { const c = e.target.closest('[data-filtro]'); if (c) { filtro = c.dataset.filtro; render(); } });
  $('ca-conteudo').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-editar]'); if (ed) { abrirEvento(dados.eventos.find(x => x.id === ed.dataset.editar)); return; }
    const cf = e.target.closest('[data-conferido]');
    if (cf) { try { await apiFetch(`/calendario-academico/eventos/${cf.dataset.conferido}`, { method: 'PUT', body: JSON.stringify({ soConferir: true }) }); await carregarEventos(); } catch (er) { toast(er.message, 'erro'); } }
  });
  $('ca-btn-novo').addEventListener('click', () => { if (!semestre) { toast('Escolha ou crie um semestre primeiro.', 'erro'); return; } abrirEvento(null); });
  $('ca-btn-copiar').addEventListener('click', abrirCopiar);
  $('ca-btn-publicar').addEventListener('click', publicar);
  $('ca-btn-site').addEventListener('click', abrirSite);
  $('ca-form-ev').addEventListener('submit', salvarEvento);
  $('ev-excluir').addEventListener('click', excluirEvento);
  ['ev-inicio', 'ev-fim', 'ev-tipo'].forEach(id => $(id).addEventListener('change', () => { if (id === 'ev-inicio' && (!$('ev-fim').value || $('ev-fim').value < $('ev-inicio').value)) $('ev-fim').value = $('ev-inicio').value; dicaDatas(); }));
  $('ca-form-copiar').addEventListener('submit', copiar);
  ['cp-de', 'cp-para'].forEach(id => $(id).addEventListener('change', sugerirInicio));
  document.querySelectorAll('.ca-modal-fundo').forEach(m => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-fechar]')) m.classList.add('hidden'); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.ca-modal-fundo:not(.hidden)').forEach(m => m.classList.add('hidden')); });
}

async function initApp(user, role) {
  appInitialized = true;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../../auth/login.html'; });
  wire();
  try { await carregarSemestres(); await carregarEventos(); }
  catch (e) { if (e.status === 403) { location.href = '../../meu-espaco/index.html'; return; } toast(e.message, 'erro'); }
}
const cached = getCachedAuth();
onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../../auth/login.html'; return; }
  currentUser = user;
  let role = 'visitante';
  try { const u = await apiFetch('/usuarios/me'); role = u.role || 'visitante'; } catch (e) { role = cached ? cached.role : 'visitante'; }
  setCachedAuth(user, role, await user.getIdToken());
  if (!appInitialized) initApp(user, role);
});
