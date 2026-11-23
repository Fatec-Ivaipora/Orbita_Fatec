// ================================================================
//  ÓRBITA — LEVANTAMENTO EaD (Docência · setor EAD) · 23/11/2026
//  Disciplinas EAD do semestre (a MESMA lista da Aulas EAD do T.I: o que muda aqui aparece lá, com aviso),
//  tutor de cada curso, relatório por curso/professor com a sala Zoom do professor e a mensagem pronta,
//  e o Cronograma EaD de cada disciplina (datas das UAs pelo calendário das UAs).
//  Servidor: src/rotas/levantamento-ead.js (+ rotas das disciplinas em src/rotas/ead-aulas.js)
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { getEffectiveLevel } from "../../core/permissions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const LOCAL = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.');
const API_BASE = LOCAL && !/^300[0-2]$/.test(location.port) ? `http://${location.hostname}:3000/api` : '/api';
const MODULO = 'levantamento-ead';
const NIVEL_PADRAO = { adm_l2: 3, ead: 3, ti: 2 };

const DIAS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const DIA_ROTULO = { segunda: 'Segunda-feira', terca: 'Terça-feira', quarta: 'Quarta-feira', quinta: 'Quinta-feira', sexta: 'Sexta-feira', sabado: 'Sábado' };
const DIA_CURTO = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO'];
const DOW = { segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const CAMPO_ROTULO = { professor: 'professor', dia: 'dia', horario: 'horário', ch: 'carga horária', nome: 'nome', periodo: 'período', qtd: 'unidades', obs: 'observação' };

const $ = (id) => document.getElementById(id);
const tela = () => $('le-tela');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const chaveProf = (p) => norm(p).toLowerCase().replace(/ /g, '-').slice(0, 80) || 'x'; // igual ao servidor
const nomeBonito = (n) => {
  const t = String(n || '').trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s(\/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/(?!^)(?<![\p{L}])(De|Da|Do|Das|Dos|E|Em|No|Na|Nos|Nas|Ao|Aos|À|Às|A|O|Para|Por|Com)(?![\p{L}])/gu, (x) => x.toLowerCase())
    .replace(/(?<![\p{L}])(Ii|Iii|Iv|Vi|Vii|Viii|Ix)(?![\p{L}])/gu, (x) => x.toUpperCase());
};
const periodoTxt = (p) => (!p ? '' : /todos/i.test(p) ? 'todos os períodos' : `${p}º período`);
const quando = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const isoDe = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const dataBR = (iso) => { const [, m, d] = String(iso || '').split('-'); return d ? `${d}/${m}` : ''; };
const dataBRano = (iso) => { const [a, m, d] = String(iso || '').split('-'); return d ? `${d}/${m}/${a}` : ''; };
const diaSemanaDe = (iso) => DIA_CURTO[new Date(`${iso}T12:00:00`).getDay()];

let currentUser = null, appInitialized = false, initializedRole = null, podeEditar = false, meuUid = '';
let dados = null, aba = 'disciplinas';
let filtroCurso = '', filtroDia = '', filtroProf = '', busca = '';
let relModo = 'curso', relCurso = '', relProf = '';
let crCurso = '', crDisc = '', crBim = '1';
let importando = null;

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('le-toast'); t.textContent = msg; t.className = `ea-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function copiar(txt, msg = 'Copiado.') {
  try { await navigator.clipboard.writeText(txt); toast(msg); } catch (e) { window.prompt('Copie:', txt); }
}
const fecharModal = () => $('le-modal').classList.add('hidden');
function abrirModal(titulo, html) { $('le-modal-titulo').textContent = titulo; $('le-modal-corpo').innerHTML = html; $('le-modal').classList.remove('hidden'); }

// ---------------- dados derivados ----------------
const salaDoProf = (prof) => (prof && dados.salaDoProfessor[chaveProf(prof)]) || null;
const tutorDo = (cursoId) => (dados.tutorDoCurso[cursoId] || null);
const meusCursos = () => Object.entries(dados.tutorDoCurso).filter(([, t]) => t && t.uid === meuUid).map(([c]) => c);
const cursosComDisc = () => [...new Map(dados.disciplinas.map(d => [d.cursoId, d.cursoNome])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
const professores = () => [...new Set(dados.disciplinas.map(d => d.professor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

// Unidades da disciplina na ordem da Aulas EAD: UA-01..metade, REV-1, resto, REV-2
function itensDe(d) {
  const qtd = d.qtd || 12, meio = qtd / 2, out = [];
  for (let n = 1; n <= qtd; n++) {
    out.push({ id: `UA-${String(n).padStart(2, '0')}`, ua: `UA ${String(n).padStart(2, '0')}`, bimestre: n <= meio ? 1 : 2 });
    if (n === meio) out.push({ id: 'REV-1', ua: 'REVISÃO', bimestre: 1, revisao: true });
  }
  out.push({ id: 'REV-2', ua: 'REVISÃO', bimestre: 2, revisao: true });
  return out;
}
// Datas previstas — mesma conta da Aulas EAD: início do bimestre + dia da semana; semanal nas de 12 UAs,
// quinzenal nas de 6; pula os dias sem aula. Data ajustada pelo T.I na UA vence.
function datasDe(d) {
  const cal = dados.calendario || {}, itens = itensDe(d), auto = {}, out = {};
  if (d.dia && DOW[d.dia] !== undefined) {
    const semAula = new Set(cal.semAula || []);
    const passo = (d.qtd || 12) === 6 ? 14 : 7;
    [1, 2].forEach(bim => {
      const ini = cal[`inicio${bim}`];
      if (!ini) return;
      const dt = new Date(`${ini}T12:00:00`);
      while (dt.getDay() !== DOW[d.dia]) dt.setDate(dt.getDate() + 1);
      itens.filter(it => it.bimestre === bim).forEach(it => {
        let guarda = 0;
        while (semAula.has(isoDe(dt)) && guarda++ < 20) dt.setDate(dt.getDate() + passo);
        auto[it.id] = isoDe(dt);
        dt.setDate(dt.getDate() + passo);
      });
    });
  }
  itens.forEach(it => { out[it.id] = (d.datasManuais || {})[it.id] || auto[it.id] || ''; });
  return { itens, datas: out };
}

// Feriados nacionais (sugestão pro coordenador conferir; o calendário acadêmico da Fatec pode ter outros dias)
function pascoa(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mes - 1, dia, 12);
}
function feriadosNacionais(semestre) {
  const [ano, s] = semestre.split('.').map(Number);
  const p = pascoa(ano);
  const rel = (dias) => { const d = new Date(p); d.setDate(d.getDate() + dias); return isoDe(d); };
  const fixo = (m, d) => `${ano}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const lista = s === 1
    ? [[rel(-48), 'Carnaval (ponto facultativo)'], [rel(-47), 'Carnaval (ponto facultativo)'], [rel(-2), 'Sexta-feira Santa'], [fixo(4, 21), 'Tiradentes'],
       [fixo(5, 1), 'Dia do Trabalho'], [rel(60), 'Corpus Christi (ponto facultativo)']]
    : [[fixo(9, 7), 'Independência do Brasil'], [fixo(10, 12), 'Padroeira do Brasil'], [fixo(11, 2), 'Finados'], [fixo(11, 15), 'Proclamação da República'],
       [fixo(11, 20), 'Dia da Consciência Negra']];
  return lista.map(([data, nome]) => ({ data, nome })).sort((a, b) => a.data.localeCompare(b.data));
}

// ---------------- carregar / render ----------------
async function carregar() {
  const sem = $('le-semestre').value;
  tela().innerHTML = '<p class="ea-vazio">Carregando...</p>';
  try { dados = await apiFetch(`/${MODULO}/?semestre=${encodeURIComponent(sem)}`); render(); }
  catch (e) { tela().innerHTML = `<div class="ea-card ea-erro">${esc(e.message)}</div>`; }
}
function render() {
  document.querySelectorAll('#le-abas .aba').forEach(b => { const on = b.dataset.aba === aba; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', on); });
  if (!dados) return;
  if (aba === 'relatorio') return renderRelatorio();
  if (aba === 'cronograma') return renderCronograma();
  if (aba === 'tutores') return renderTutores();
  renderDisciplinas();
}

// ================================================================
//  ABA: DISCIPLINAS
// ================================================================
function renderDisciplinas() {
  const ds = dados.disciplinas;
  const botoes = podeEditar ? `<button type="button" class="btn-secondary" data-le-importar>Importar planilha</button><button type="button" class="btn-primary" data-le-nova>Nova disciplina</button>` : '';
  if (!ds.length) {
    tela().innerHTML = `<div class="ea-card"><b>Nenhuma disciplina EAD cadastrada em ${esc(dados.semestre)}.</b>
      <p class="ea-sub" style="font-size:.86rem">Importe a planilha "DISCIPLINAS EaD ${esc(dados.semestre)} LEVANTAMENTO" (no Google Planilhas: Arquivo › Fazer download › Microsoft Excel) ou cadastre uma por uma.</p>
      <div class="ea-modal-acoes" style="justify-content:flex-start">${botoes}</div></div>`;
    return;
  }
  const b = norm(busca);
  const lista = ds.filter(d => (!filtroCurso || d.cursoId === filtroCurso) && (!b || norm(`${d.nome} ${d.professor}`).includes(b))
    && (!filtroDia || (filtroDia === '-' ? !d.dia : d.dia === filtroDia))
    && (!filtroProf || (filtroProf === '-' ? !d.professor : chaveProf(d.professor) === filtroProf)));
  const semProf = lista.filter(d => !d.professor).length, semDia = lista.filter(d => !d.dia || !d.horario).length;
  const semSala = lista.filter(d => d.professor && !salaDoProf(d.professor)).length;
  tela().innerHTML = `
    <section class="ea-resumo">
      <div class="ea-num"><b>${lista.length}</b><span>disciplinas EAD</span></div>
      <div class="ea-num"><b class="${semProf ? 'ea-alerta' : ''}">${semProf}</b><span>sem professor</span></div>
      <div class="ea-num"><b class="${semDia ? 'ea-alerta' : ''}">${semDia}</b><span>sem dia ou horário</span></div>
      <div class="ea-num"><b>${semSala}</b><span>professor sem sala Zoom (T.I)</span></div>
    </section>
    <div class="ea-ferramentas">
      <label>Curso<select class="select-filter" data-le-f="curso"><option value="">Todos os cursos</option>${cursosComDisc().map(([id, n]) => `<option value="${esc(id)}" ${filtroCurso === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label>Dia<select class="select-filter" data-le-f="dia"><option value="">Todos os dias</option>${DIAS.map(k => `<option value="${k}" ${filtroDia === k ? 'selected' : ''}>${DIA_ROTULO[k]}</option>`).join('')}<option value="-" ${filtroDia === '-' ? 'selected' : ''}>Sem dia</option></select></label>
      <label>Professor<select class="select-filter" data-le-f="prof" style="max-width:240px"><option value="">Todos</option>${professores().map(p => `<option value="${esc(chaveProf(p))}" ${filtroProf === chaveProf(p) ? 'selected' : ''}>${esc(p)}</option>`).join('')}<option value="-" ${filtroProf === '-' ? 'selected' : ''}>Sem professor</option></select></label>
      <label>Buscar<input class="ea-input ea-busca" data-le-busca value="${esc(busca)}" placeholder="Disciplina ou professor"></label>
      ${filtroCurso || filtroDia || filtroProf || busca ? '<button type="button" class="btn-secondary" data-le-limpar>Limpar filtros</button>' : ''}
      <div class="ea-direita">${botoes}</div>
    </div>
    <section class="ea-card ea-card-tabela">
      ${lista.length ? `<div class="ea-tabela-wrap"><table class="ea-tabela">
        <thead><tr><th>Disciplina</th><th>Professor</th><th>Dia e horário</th><th>Tutor do curso</th><th>Última mudança</th></tr></thead>
        <tbody>${lista.map(d => { const t = tutorDo(d.cursoId); return `<tr class="ea-clicavel" data-le-disc="${esc(d.id)}" tabindex="0">
          <td><b>${esc(nomeBonito(d.nome))}</b><span class="ea-sub">${esc(d.cursoNome)} · ${esc(periodoTxt(d.periodo))}${d.ch ? ` · ${d.ch} h` : ''}</span></td>
          <td>${d.professor ? esc(d.professor) : '<span class="ea-pill alerta">definir</span>'}</td>
          <td class="ea-nowrap">${d.dia ? esc(DIA_ROTULO[d.dia]) : '<span class="ea-pill alerta">sem dia</span>'}${d.horario ? `<span class="ea-sub">${esc(d.horario)}</span>` : ''}</td>
          <td>${t ? esc(nomeBonito(t.nome)) : '<span class="ea-sub">—</span>'}</td>
          <td><span class="ea-sub">${esc(quando(d.updatedAt))}<br>${esc(d.updatedBy || '')}</span></td></tr>`; }).join('')}</tbody></table></div>`
      : '<p class="ea-vazio">Nenhuma disciplina neste filtro.</p>'}
    </section>
    <p class="ea-legenda">Clique na disciplina para editar. Esta é a mesma lista da Aulas EAD do T.I: o que você muda aqui aparece lá na hora, e o T.I recebe um aviso com o que mudou.</p>`;
}

function htmlFormDisc(d) {
  const v = (k) => esc(d ? (d[k] ?? '') : '');
  return `<div class="ea-form">
    ${d ? `<label>Curso<input type="text" value="${esc(d.cursoNome)}" disabled></label>` : `<label>Curso<select id="le-f-curso">${dados.cursos.map(c => `<option value="${esc(c.id)}" ${filtroCurso === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>`}
    <label class="ea-largo">Disciplina<input type="text" id="le-f-nome" maxlength="200" value="${v('nome')}"></label>
    <label>Período<input type="text" id="le-f-periodo" maxlength="30" placeholder="ex.: 7 ou 4 e 5" value="${v('periodo')}"></label>
    <label>Carga horária<input type="text" id="le-f-ch" inputmode="numeric" maxlength="4" value="${v('ch')}"></label>
    <label>Professor (dá a aula)<input type="text" id="le-f-prof" maxlength="120" value="${v('professor')}" list="le-profs"></label>
    <label>Dia<select id="le-f-dia"><option value="">—</option>${DIAS.map(k => `<option value="${k}" ${d && d.dia === k ? 'selected' : ''}>${DIA_ROTULO[k]}</option>`).join('')}</select></label>
    <label>Horário<input type="text" id="le-f-hor" maxlength="40" value="${v('horario')}" placeholder="19h30min - 20h30min"></label>
    <label>Unidades<select id="le-f-qtd">${[12, 6].map(q => `<option value="${q}" ${(d ? d.qtd : 12) === q ? 'selected' : ''}>${q} (${q === 12 ? 'semanal' : 'quinzenal'})</option>`).join('')}</select></label>
    <label class="ea-largo">Observação<input type="text" id="le-f-obs" maxlength="600" value="${v('obs')}"></label>
  </div>
  <datalist id="le-profs">${professores().map(p => `<option value="${esc(p)}">`).join('')}</datalist>`;
}
function abrirDisciplina(id) {
  const d = dados.disciplinas.find(x => x.id === id);
  if (!d) return;
  const s = salaDoProf(d.professor);
  abrirModal(nomeBonito(d.nome), `
    <p class="ea-sub" style="margin:-.4rem 0 1rem;font-size:.84rem">${esc(d.cursoNome)} · ${esc(periodoTxt(d.periodo))}${s ? ` · Zoom: <b>${esc(s.conta)} · ${esc(s.nome)}</b>` : d.professor ? ' · o T.I ainda não deu sala Zoom a este professor' : ''}${d.updatedBy ? `<br>Última mudança: ${esc(d.updatedBy)} em ${esc(quando(d.updatedAt))}` : ''}</p>
    ${htmlFormDisc(d)}
    ${podeEditar ? `<div class="ea-modal-acoes">${d.temGravacao ? '<span class="ea-sub" style="margin-right:auto">Tem gravação marcada pelo T.I: só o T.I exclui.</span>' : `<button type="button" class="btn-secondary ea-perigo" data-le-excluir="${esc(d.id)}">Excluir disciplina</button>`}<button type="button" class="btn-primary" data-le-salvar="${esc(d.id)}">Salvar</button></div>` : ''}`);
  if (!podeEditar) $('le-modal-corpo').querySelectorAll('input,select').forEach(i => { i.disabled = true; });
}
function lerForm(novo) {
  const v = (id) => ($(id) ? $(id).value : undefined);
  const corpo = { nome: v('le-f-nome'), periodo: v('le-f-periodo'), ch: v('le-f-ch'), professor: v('le-f-prof'), dia: v('le-f-dia'), horario: v('le-f-hor'), qtd: Number(v('le-f-qtd')), obs: v('le-f-obs') };
  if (novo) Object.assign(corpo, { semestre: dados.semestre, cursoId: v('le-f-curso') });
  return corpo;
}

// ================================================================
//  ABA: RELATÓRIO E LINKS (por curso / por professor)
// ================================================================
function mensagemProfessor(prof) {
  const ds = dados.disciplinas.filter(d => d.professor && chaveProf(d.professor) === chaveProf(prof));
  const s = salaDoProf(prof);
  const linhas = ds.map(d => `📚 *${nomeBonito(d.nome)}* (${d.cursoNome}${d.periodo ? ` · ${periodoTxt(d.periodo)}` : ''})\n📅 ${d.dia ? DIA_ROTULO[d.dia] : 'dia a definir'}${d.horario ? ` · ${d.horario}` : ''}`).join('\n\n');
  const zoom = s ? `🔗 *Link da sala Zoom* (${s.conta} · ${s.nome}):\n${s.link}${s.senha ? `\n🔑 Senha da reunião: *${s.senha}*` : ''}` : '🔗 Link da sala Zoom: (o T.I ainda não definiu a sala)';
  const anfitriao = s && s.senhaAnfitriao ? `

Para que possam assumir o controle da reunião como anfitriões, sigam os passos abaixo:

1️⃣ Acessem a reunião normalmente pelo link acima.
2️⃣ Assim que estiverem na sala, cliquem em “Participantes” e depois em “Reivindicar Anfitrião (Claim Host)”.
3️⃣ O Zoom solicitará uma senha de anfitrião.
👉 Digitem a seguinte senha: *${s.senhaAnfitriao}*
4️⃣ Após inserir a senha, vocês terão acesso às funções de anfitrião (permitir entrada, compartilhar tela, gravar, etc). *(É OBRIGATÓRIO SE TORNAR ANFITRIÃO, CASO CONTRARIO COM 30 MINUTOS DE AULA A SALA CAI)*

Qualquer dúvida, estou à disposição.` : '';
  return `Olá, Prof(a). ${nomeBonito(prof)}! Seguem os dados da sua aula EAD de ${dados.semestre}:\n\n${linhas}\n\n${zoom}${anfitriao}`;
}
function linhaZoom(prof) {
  const s = salaDoProf(prof);
  if (!prof) return '<span class="ea-sub">—</span>';
  if (!s) return '<span class="ea-sub">sem sala (T.I)</span>';
  return `<span class="ea-nowrap"><b>${esc(s.conta)}</b> · ${esc(s.nome)}</span><span class="ea-sub">${s.senha ? `senha ${esc(s.senha)} · ` : ''}<a href="${esc(s.link)}" target="_blank" rel="noopener">abrir</a> · <button type="button" class="ea-link" data-le-copiar-link="${esc(prof)}">copiar link</button></span>`;
}
function relDisciplinas() {
  let ds = dados.disciplinas;
  if (relModo === 'curso') ds = ds.filter(d => (relCurso === 'meus' ? meusCursos().includes(d.cursoId) : !relCurso || d.cursoId === relCurso));
  else ds = ds.filter(d => d.professor && (!relProf || chaveProf(d.professor) === relProf));
  return ds;
}
function textoRelatorio() {
  const ds = relDisciplinas();
  const linha = (d) => `- ${nomeBonito(d.nome)}${d.periodo ? ` (${periodoTxt(d.periodo)})` : ''}: ${d.professor || 'sem professor'} · ${d.dia ? DIA_ROTULO[d.dia] : 'sem dia'}${d.horario ? ` · ${d.horario}` : ''}${(() => { const s = salaDoProf(d.professor); return s ? ` · Zoom ${s.conta}: ${s.link}` : ''; })()}`;
  const out = [`DISCIPLINAS EaD ${dados.semestre}`];
  if (relModo === 'curso') {
    const grupos = new Map(); ds.forEach(d => { if (!grupos.has(d.cursoNome)) grupos.set(d.cursoNome, []); grupos.get(d.cursoNome).push(d); });
    grupos.forEach((l, curso) => { const t = tutorDo(l[0].cursoId); out.push('', `${curso.toUpperCase()}${t ? ` — tutor(a): ${nomeBonito(t.nome)}` : ''}`, ...l.map(linha)); });
  } else {
    const grupos = new Map(); ds.forEach(d => { if (!grupos.has(d.professor)) grupos.set(d.professor, []); grupos.get(d.professor).push(d); });
    [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(p => out.push('', p.toUpperCase(), ...grupos.get(p).map(d => `- ${nomeBonito(d.nome)} (${d.cursoNome}${d.periodo ? `, ${periodoTxt(d.periodo)}` : ''}) · ${d.dia ? DIA_ROTULO[d.dia] : 'sem dia'}${d.horario ? ` · ${d.horario}` : ''}`), ...(salaDoProf(p) ? [`  Zoom ${salaDoProf(p).conta}: ${salaDoProf(p).link}`] : [])));
  }
  return out.join('\n');
}
function renderRelatorio() {
  const meus = meusCursos();
  if (relModo === 'curso' && relCurso === '' && meus.length && !dados.podeDefinirTutor && !renderRelatorio.jaPadrao) { relCurso = 'meus'; renderRelatorio.jaPadrao = true; }
  const ds = relDisciplinas();
  const tabelaCurso = () => {
    const grupos = new Map(); ds.forEach(d => { if (!grupos.has(d.cursoId)) grupos.set(d.cursoId, []); grupos.get(d.cursoId).push(d); });
    return [...grupos.entries()].map(([cid, l]) => { const t = tutorDo(cid); return `<section class="ea-card le-rel-bloco">
      <div class="le-rel-topo"><h3>${esc(l[0].cursoNome)}</h3><span class="ea-sub">${t ? `Tutor(a): <b>${esc(nomeBonito(t.nome))}</b>` : 'Sem tutor definido'} · ${l.length} disciplina(s)</span></div>
      <div class="ea-tabela-wrap"><table class="ea-tabela"><thead><tr><th>Disciplina</th><th>Professor</th><th>Dia e horário</th><th>Sala Zoom</th><th class="le-nao-imprime"></th></tr></thead><tbody>
      ${l.map(d => `<tr><td><b>${esc(nomeBonito(d.nome))}</b><span class="ea-sub">${esc(periodoTxt(d.periodo))}${d.ch ? ` · ${d.ch} h` : ''}</span></td>
        <td>${d.professor ? esc(d.professor) : '<span class="ea-pill alerta">definir</span>'}</td>
        <td class="ea-nowrap">${d.dia ? esc(DIA_ROTULO[d.dia]) : '—'}<span class="ea-sub">${esc(d.horario || '')}</span></td>
        <td>${linhaZoom(d.professor)}</td>
        <td class="le-nao-imprime">${d.professor ? `<button type="button" class="btn-secondary btn-mini" data-le-msg="${esc(d.professor)}">Mensagem ao professor</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div></section>`; }).join('') || '<p class="ea-vazio">Nenhuma disciplina neste filtro.</p>';
  };
  const tabelaProf = () => {
    const grupos = new Map(); ds.forEach(d => { if (!grupos.has(d.professor)) grupos.set(d.professor, []); grupos.get(d.professor).push(d); });
    return [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(p => { const l = grupos.get(p); return `<section class="ea-card le-rel-bloco">
      <div class="le-rel-topo"><h3>${esc(p)}</h3><span class="ea-sub">${l.length} disciplina(s)</span><button type="button" class="btn-primary btn-mini le-nao-imprime" data-le-msg="${esc(p)}">Copiar mensagem ao professor</button></div>
      <p class="le-zoom-linha">${linhaZoom(p)}</p>
      <div class="ea-tabela-wrap"><table class="ea-tabela"><thead><tr><th>Disciplina</th><th>Curso</th><th>Dia e horário</th><th>Tutor do curso</th></tr></thead><tbody>
      ${l.map(d => { const t = tutorDo(d.cursoId); return `<tr><td><b>${esc(nomeBonito(d.nome))}</b></td><td>${esc(d.cursoNome)}<span class="ea-sub">${esc(periodoTxt(d.periodo))}</span></td>
        <td class="ea-nowrap">${d.dia ? esc(DIA_ROTULO[d.dia]) : '—'}<span class="ea-sub">${esc(d.horario || '')}</span></td><td>${t ? esc(nomeBonito(t.nome)) : '—'}</td></tr>`; }).join('')}
      </tbody></table></div></section>`; }).join('') || '<p class="ea-vazio">Nenhum professor neste filtro.</p>';
  };
  tela().innerHTML = `
    <div class="ea-ferramentas le-nao-imprime">
      <div class="ea-pilulas">${[['curso', 'Por curso'], ['professor', 'Por professor']].map(([id, r]) => `<button type="button" class="ea-pilula${relModo === id ? ' ativo' : ''}" data-le-rel-modo="${id}">${r}</button>`).join('')}</div>
      ${relModo === 'curso'
        ? `<label>Curso<select class="select-filter" data-le-rel-curso><option value="">Todos os cursos</option>${meus.length ? `<option value="meus" ${relCurso === 'meus' ? 'selected' : ''}>Meus cursos (${meus.length})</option>` : ''}${cursosComDisc().map(([id, n]) => `<option value="${esc(id)}" ${relCurso === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`
        : `<label>Professor<select class="select-filter" data-le-rel-prof style="max-width:260px"><option value="">Todos os professores</option>${professores().map(p => `<option value="${esc(chaveProf(p))}" ${relProf === chaveProf(p) ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>`}
      <div class="ea-direita"><button type="button" class="btn-secondary" data-le-copiar-rel>Copiar em texto</button><button type="button" class="btn-primary" data-le-imprimir>Imprimir / PDF</button></div>
    </div>
    <div class="le-imprime-titulo"><img src="/img/fatec-ivp-horizontal.png" alt="FATEC Ivaiporã"><div><b>Disciplinas EaD ${esc(dados.semestre)}</b><span>${relModo === 'curso' ? 'Por curso' : 'Por professor'} · gerado em ${esc(new Date().toLocaleDateString('pt-BR'))}</span></div></div>
    ${relModo === 'curso' ? tabelaCurso() : tabelaProf()}
    <p class="ea-legenda le-nao-imprime">A sala Zoom é a que o T.I deu ao professor na Aulas EAD (o mesmo link em todos os dias dele). "Mensagem ao professor" copia o texto pronto com as disciplinas, o link, a senha e o passo a passo para virar anfitrião.</p>`;
}

// ================================================================
//  ABA: CRONOGRAMA EaD
// ================================================================
function feriadosNoPeriodo(ini, fim) {
  const nomes = (dados.cronograma && dados.cronograma.feriados) || {};
  return (dados.calendario.semAula || []).filter(x => x >= ini && x <= fim).map(x => ({ data: x, nome: nomes[x] || 'Sem aula' }));
}
function htmlCronograma(d, bim) {
  const { itens, datas } = datasDe(d);
  const doBim = itens.filter(it => it.bimestre === bim);
  const fech = ((dados.cronograma && dados.cronograma.fechamento) || {})[bim];
  const dd = doBim.map(it => datas[it.id]).filter(Boolean).sort();
  const ini = dados.calendario[`inicio${bim}`] || dd[0] || '';
  const fim = dd[dd.length - 1] || (fech && fech.data) || '';
  const alertas = ini && fim ? feriadosNoPeriodo(ini, fim) : [];
  let n = 0;
  return `<article class="le-cr">
    <header class="le-cr-topo">
      <div class="le-cr-logo"><img src="/img/fatec-ivp-horizontal.png" alt="FATEC Ivaiporã"></div>
      <div class="le-cr-titulo"><b>CRONOGRAMA EaD</b><span>${bim}º BIMESTRE • ${esc(dados.semestre)}</span></div>
      <svg class="le-cr-ico" viewBox="0 0 48 40" aria-hidden="true"><rect x="3" y="3" width="42" height="28" rx="3" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 37h16M24 31v6" stroke="currentColor" stroke-width="3"/><rect x="9" y="9" width="14" height="8" rx="1" fill="currentColor" opacity=".5"/></svg>
    </header>
    <div class="le-cr-info">
      <div><span class="le-cr-rot">DISCIPLINA</span><b>${esc(nomeBonito(d.nome))}</b></div>
      <div><span class="le-cr-rot">PROFESSOR</span><b>${esc(d.professor || 'a definir')}</b></div>
      <div><span class="le-cr-rot">DIA DA SEMANA</span><b class="le-cr-dia">${esc(d.dia ? DIA_ROTULO[d.dia].toUpperCase() : 'A DEFINIR')}</b></div>
      <div><span class="le-cr-rot">HORÁRIO</span><b>${esc(d.horario || 'a definir')}</b></div>
    </div>
    <div class="le-cr-fech"><span class="le-cr-fech-ico">!</span><b>FECHAMENTO DAS TRILHAS:</b><span class="le-cr-fech-val">${fech ? `${esc(dataBR(fech.data))} (${esc(diaSemanaDe(fech.data))})` : 'a definir'}</span>${fech && fech.hora ? `<span class="le-cr-fech-val">${esc(fech.hora.replace(':', 'h'))}</span>` : ''}</div>
    <div class="le-cr-corpo">
      <section class="le-cr-aulas">
        <div class="le-cr-aulas-topo"><b>CRONOGRAMA DAS AULAS</b>${d.dia ? `<span>${esc(DIA_ROTULO[d.dia].toUpperCase())}</span>` : ''}</div>
        ${doBim.map(it => { if (!it.revisao) n++; return `<div class="le-cr-linha${it.revisao ? ' rev' : ''}"><span class="le-cr-num">${it.revisao ? '★' : String(n).padStart(2, '0')}</span><b>${it.revisao ? 'REVISÃO' : `AULA ${String(n).padStart(2, '0')}`}</b><span class="le-cr-ua">${esc(it.ua)}</span><span class="le-cr-data">${esc(dataBR(datas[it.id]) || '—')}</span></div>`; }).join('')}
      </section>
      <section class="le-cr-alertas">
        ${alertas.length ? alertas.map(a => `<div class="le-cr-alerta"><div class="le-cr-alerta-topo">ALERTAS IMPORTANTES</div><div class="le-cr-alerta-corpo"><b>${esc(dataBR(a.data))} - ${/ponto facultativo/i.test(a.nome) ? 'PONTO FACULTATIVO' : 'FERIADO'}</b><span>${esc(a.nome.replace(/\s*\(ponto facultativo\)/i, '').toUpperCase())}</span></div></div>`).join('')
          : '<div class="le-cr-alerta"><div class="le-cr-alerta-topo">ALERTAS IMPORTANTES</div><div class="le-cr-alerta-corpo"><span>Sem feriados neste bimestre.</span></div></div>'}
      </section>
    </div>
  </article>`;
}
function renderCronograma() {
  const cal = dados.calendario || {};
  const temCal = !!cal.inicio1;
  const doCurso = dados.disciplinas.filter(d => !crCurso || d.cursoId === crCurso);
  if (crDisc && !doCurso.some(d => d.id === crDisc)) crDisc = '';
  const alvo = crDisc ? doCurso.filter(d => d.id === crDisc) : doCurso;
  const bim = Number(crBim);
  const fech = (dados.cronograma && dados.cronograma.fechamento) || {};
  tela().innerHTML = `
    <div class="ea-ferramentas le-nao-imprime">
      <label>Curso<select class="select-filter" data-le-cr-curso><option value="">Todos os cursos</option>${cursosComDisc().map(([id, n]) => `<option value="${esc(id)}" ${crCurso === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label>Disciplina<select class="select-filter" data-le-cr-disc style="max-width:300px"><option value="">Todas (${doCurso.length})</option>${doCurso.map(d => `<option value="${esc(d.id)}" ${crDisc === d.id ? 'selected' : ''}>${esc(nomeBonito(d.nome))} · ${esc(d.cursoNome)}</option>`).join('')}</select></label>
      <label>Bimestre<select class="select-filter" data-le-cr-bim><option value="1" ${crBim === '1' ? 'selected' : ''}>1º bimestre</option><option value="2" ${crBim === '2' ? 'selected' : ''}>2º bimestre</option></select></label>
      <div class="ea-direita"><button type="button" class="btn-secondary" data-le-calendario>Calendário e fechamento</button>${alvo.length ? `<button type="button" class="btn-secondary" data-le-png>Baixar imagem${alvo.length > 1 ? 'ns' : ''}</button><button type="button" class="btn-primary" data-le-imprimir>Imprimir / PDF</button>` : ''}</div>
    </div>
    <div class="ea-card le-nao-imprime le-cr-status">
      ${temCal ? `Calendário das UAs: 1º bimestre a partir de <b>${esc(dataBRano(cal.inicio1))}</b>${cal.inicio2 ? `, 2º a partir de <b>${esc(dataBRano(cal.inicio2))}</b>` : ', 2º bimestre sem início'} · ${(cal.semAula || []).length} dia(s) sem aula · fechamento das trilhas: ${fech[bim] ? `<b>${esc(dataBRano(fech[bim].data))}${fech[bim].hora ? ` às ${esc(fech[bim].hora)}` : ''}</b>` : '<span class="ea-alerta">a definir</span>'}.`
        : '<span class="ea-alerta"><b>O calendário das UAs ainda não foi definido.</b></span> Sem ele, as datas ficam em branco. Clique em "Calendário e fechamento" (o coordenador do EAD preenche; o T.I usa o mesmo calendário).'}
      ${alvo.length > 1 ? `<br><span class="ea-sub">${alvo.length} cronogramas: um por disciplina. Para um só, escolha a disciplina.</span>` : ''}
    </div>
    <div class="le-cr-lista">${alvo.map(d => htmlCronograma(d, bim)).join('') || '<p class="ea-vazio">Nenhuma disciplina.</p>'}</div>`;
}
function abrirCalendario() {
  const c = dados.calendario || {}, cr = dados.cronograma || {}, fe = cr.fechamento || {}, nomes = cr.feriados || {};
  const pode = dados.podeDefinirTutor;
  const linhas = (c.semAula || []).map(x => ({ data: x, nome: nomes[x] || '' }));
  const linhaHtml = (x) => `<div class="le-fer-linha"><input type="date" class="ea-input" data-le-fer-data value="${esc(x.data)}" ${pode ? '' : 'disabled'}><input type="text" class="ea-input" data-le-fer-nome maxlength="80" value="${esc(x.nome)}" placeholder="Ex.: Tiradentes" ${pode ? '' : 'disabled'}>${pode ? '<button type="button" class="ea-x" data-le-fer-tirar aria-label="Tirar">×</button>' : ''}</div>`;
  abrirModal(`Calendário e fechamento · ${dados.semestre}`, `
    <p class="ea-sub" style="margin:-.3rem 0 .9rem;font-size:.85rem">É o mesmo calendário das UAs da Aulas EAD: o T.I usa estas datas. Com o início de cada bimestre e o dia da semana da disciplina, a data de cada UA sai sozinha (toda semana nas de 12 UAs, a cada 15 dias nas de 6), pulando os dias sem aula.${pode ? '' : ' Só o coordenador do EAD altera.'}</p>
    <div class="ea-form">
      <label>Início do 1º bimestre<input type="date" id="le-c-ini1" value="${esc(c.inicio1 || '')}" ${pode ? '' : 'disabled'}></label>
      <label>Início do 2º bimestre<input type="date" id="le-c-ini2" value="${esc(c.inicio2 || '')}" ${pode ? '' : 'disabled'}></label>
      <label>Fechamento das trilhas · 1º bim.<span class="le-dupla"><input type="date" id="le-c-f1" value="${esc((fe[1] || {}).data || '')}" ${pode ? '' : 'disabled'}><input type="time" id="le-c-h1" value="${esc((fe[1] || {}).hora || '23:55')}" ${pode ? '' : 'disabled'}></span></label>
      <label>Fechamento das trilhas · 2º bim.<span class="le-dupla"><input type="date" id="le-c-f2" value="${esc((fe[2] || {}).data || '')}" ${pode ? '' : 'disabled'}><input type="time" id="le-c-h2" value="${esc((fe[2] || {}).hora || '23:55')}" ${pode ? '' : 'disabled'}></span></label>
    </div>
    <h3 style="margin:1rem 0 .4rem">Feriados e dias sem aula</h3>
    ${pode ? `<p class="ea-sub" style="margin:0 0 .5rem">"Sugerir feriados nacionais" traz os feriados do Brasil no semestre (com a Páscoa calculada). Confira, tire o que não vale e acrescente os da Fatec e do município quando sair o calendário acadêmico.</p>` : ''}
    <div id="le-fer-lista">${linhas.map(linhaHtml).join('') || '<p class="ea-sub" data-le-fer-vazio>Nenhum dia sem aula.</p>'}</div>
    ${pode ? `<div class="ea-modal-acoes" style="justify-content:flex-start"><button type="button" class="btn-secondary" data-le-fer-mais>+ Dia sem aula</button><button type="button" class="btn-secondary" data-le-fer-sugerir>Sugerir feriados nacionais</button></div>
    <div class="ea-modal-acoes"><button type="button" class="btn-primary" data-le-salvar-cal>Salvar calendário</button></div>` : ''}`);
  abrirCalendario.linhaHtml = linhaHtml;
}

// ================================================================
//  ABA: TUTORES DOS CURSOS
// ================================================================
function renderTutores() {
  const pode = dados.podeDefinirTutor;
  const porCurso = new Map(); dados.disciplinas.forEach(d => porCurso.set(d.cursoId, (porCurso.get(d.cursoId) || 0) + 1));
  const cursos = dados.cursos.filter(c => porCurso.has(c.id) || dados.tutorDoCurso[c.id]);
  const carga = {}; Object.values(dados.tutorDoCurso).forEach(t => { if (t) carga[t.uid] = (carga[t.uid] || 0) + 1; });
  tela().innerHTML = `
    <div class="ea-card" style="margin-bottom:1rem">${pode ? 'Escolha o tutor responsável por cada curso neste semestre. O tutor vê os cursos dele em "Relatório e links" (opção "Meus cursos").' : 'Quem define o tutor de cada curso é o coordenador do EAD.'}
      <div class="ea-pilulas" style="margin-top:.6rem">${dados.tutores.map(t => `<span class="ea-pilula">${esc(nomeBonito(t.nome))} <span>${carga[t.uid] || 0}</span></span>`).join('')}</div></div>
    <section class="ea-card ea-card-tabela"><div class="ea-tabela-wrap"><table class="ea-tabela">
      <thead><tr><th>Curso</th><th>Disciplinas EAD</th><th>Tutor responsável</th></tr></thead>
      <tbody>${cursos.map(c => { const t = dados.tutorDoCurso[c.id]; return `<tr><td><b>${esc(c.nome)}</b></td><td>${porCurso.get(c.id) || 0}</td>
        <td>${pode ? `<select class="select-filter" data-le-tutor="${esc(c.id)}"><option value="">— sem tutor —</option>${dados.tutores.map(u => `<option value="${esc(u.uid)}" ${t && t.uid === u.uid ? 'selected' : ''}>${esc(nomeBonito(u.nome))}${u.coordenador ? ' (coordenador)' : ''}</option>`).join('')}</select>`
          : (t ? esc(nomeBonito(t.nome)) : '<span class="ea-sub">—</span>')}${t && t.por ? `<span class="ea-sub">por ${esc(t.por)} em ${esc(quando(t.em))}</span>` : ''}</td></tr>`; }).join('')}</tbody>
    </table></div></section>`;
}

// ================================================================
//  IMPORTAÇÃO (prévia → confirmar) — mesma regra da Aulas EAD
// ================================================================
function lerArquivo(arquivo) {
  return new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => erro(new Error('Não consegui ler o arquivo.')); r.readAsDataURL(arquivo); });
}
async function previaImportacao(base64) {
  abrirModal('Importar disciplinas', '<p class="ea-vazio">Lendo a planilha...</p>');
  try {
    const r = await apiFetch(`/${MODULO}/disciplinas/importar`, { method: 'POST', body: JSON.stringify({ semestre: dados.semestre, arquivoBase64: base64, aplicar: false }) });
    importando = base64;
    const p = r.previa, n = (a) => p.filter(x => x.acao === a).length;
    abrirModal(`Importar disciplinas ${dados.semestre}`, `
      <p>${p.length} disciplinas de ${esc(dados.semestre)} na planilha: <b>${n('nova')}</b> novas, <b>${n('atualizar')}</b> com dia/horário/professor atualizados, ${n('igual')} sem mudança.${r.ignoradas.length ? ` ${r.ignoradas.length} linha(s) ignorada(s).` : ''}</p>
      <p class="ea-sub">Só entram as linhas do semestre ${esc(dados.semestre)}. Célula vazia na planilha não apaga o que já estiver preenchido. O T.I recebe aviso do que mudou.</p>
      <div class="ea-tabela-wrap" style="max-height:45vh"><table class="ea-tabela"><thead><tr><th>Curso</th><th>Disciplina</th><th>Dia/horário</th><th>Professor</th><th></th></tr></thead><tbody>
      ${p.filter(x => x.acao !== 'igual').map(x => `<tr><td>${esc(x.cursoNome)}<span class="ea-sub">${esc(periodoTxt(x.periodo))}</span></td><td>${esc(nomeBonito(x.nome))}</td><td>${esc(DIA_ROTULO[x.dia] || '')}<span class="ea-sub">${esc(x.horario)}</span></td><td>${esc(x.professor)}</td><td><span class="ea-pill ${x.acao === 'nova' ? 'bom' : 'alerta'}">${x.acao === 'nova' ? 'nova' : 'atualiza ' + x.muda.map(k => CAMPO_ROTULO[k] || k).join(', ')}</span></td></tr>`).join('') || '<tr><td colspan="5" class="ea-vazio">Nada novo para gravar.</td></tr>'}
      ${r.ignoradas.map(x => `<tr><td>${esc(x.cursoTxt)}</td><td>${esc(x.nome)}</td><td colspan="2" class="ea-sub">linha ${x.linha}</td><td><span class="ea-pill crit">${esc(x.motivo)}</span></td></tr>`).join('')}</tbody></table></div>
      <div class="ea-modal-acoes"><button type="button" class="btn-secondary" data-le-fechar>Cancelar</button><button type="button" class="btn-primary" data-le-confirmar-import ${!p.some(x => x.acao !== 'igual') ? 'disabled' : ''}>Confirmar importação</button></div>`);
  } catch (e) { abrirModal('Importar', `<div class="ea-card ea-erro">${esc(e.message)}</div>`); }
}

// ---------------- imagem (PNG) do cronograma ----------------
let h2cPromessa = null;
function carregarHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!h2cPromessa) h2cPromessa = new Promise((ok, erro) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload = () => ok(window.html2canvas); s.onerror = () => erro(new Error('Não consegui carregar o gerador de imagem.')); document.head.appendChild(s); });
  return h2cPromessa;
}
async function baixarPng(btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Gerando...';
  try {
    const h2c = await carregarHtml2canvas();
    const cards = [...tela().querySelectorAll('.le-cr')];
    const discs = crDisc ? dados.disciplinas.filter(d => d.id === crDisc) : dados.disciplinas.filter(d => !crCurso || d.cursoId === crCurso);
    for (let i = 0; i < cards.length; i++) {
      const canvas = await h2c(cards[i], { scale: 2, backgroundColor: '#ffffff', useCORS: true });
      const d = discs[i] || {};
      const a = document.createElement('a');
      a.download = `Cronograma EaD ${crBim}º bim ${dados.semestre} - ${nomeBonito(d.nome || 'disciplina')} - ${d.cursoNome || ''}.png`.replace(/[\\/:*?"<>|]+/g, '-');
      a.href = canvas.toDataURL('image/png'); a.click();
      await new Promise(r => setTimeout(r, 350));
    }
    toast(cards.length > 1 ? `${cards.length} imagens baixadas.` : 'Imagem baixada.');
  } catch (e) { toast(e.message, 'erro'); }
  btn.disabled = false; btn.textContent = txt;
}

// ================================================================
//  EVENTOS
// ================================================================
function trocaDisc(nova) {
  const i = dados.disciplinas.findIndex(x => x.id === nova.id);
  const antes = i >= 0 ? dados.disciplinas[i] : {};
  const d = { ...antes, ...nova, temGravacao: antes.temGravacao || false, datasManuais: antes.datasManuais || {}, updatedAt: new Date().toISOString(), updatedBy: currentUser.displayName || currentUser.email };
  if (i >= 0) dados.disciplinas[i] = d; else dados.disciplinas.push(d);
}
async function acao(e) {
  const t = e.target.closest('button, tr[data-le-disc]');
  if (!t || t.disabled) return;
  try {
    if (t.dataset.leFechar !== undefined) return fecharModal();
    if (t.dataset.leLimpar !== undefined) { filtroCurso = filtroDia = filtroProf = busca = ''; return render(); }
    if (t.dataset.leDisc && t.tagName === 'TR') return abrirDisciplina(t.dataset.leDisc);
    if (t.dataset.leImportar !== undefined) { $('le-arquivo').value = ''; return $('le-arquivo').click(); }
    if (t.dataset.leConfirmarImport !== undefined) {
      t.disabled = true; t.textContent = 'Gravando...';
      const r = await apiFetch(`/${MODULO}/disciplinas/importar`, { method: 'POST', body: JSON.stringify({ semestre: dados.semestre, arquivoBase64: importando, aplicar: true }) });
      importando = null; fecharModal(); toast(r.message); return carregar();
    }
    if (t.dataset.leNova !== undefined) return abrirModal('Nova disciplina EAD', `${htmlFormDisc(null)}<div class="ea-modal-acoes"><button type="button" class="btn-primary" data-le-criar>Cadastrar</button></div>`);
    if (t.dataset.leCriar !== undefined) {
      t.disabled = true;
      const nova = await apiFetch(`/${MODULO}/disciplinas`, { method: 'POST', body: JSON.stringify(lerForm(true)) });
      trocaDisc({ ...nova, temGravacao: false, datasManuais: {} }); fecharModal(); toast('Disciplina cadastrada. O T.I foi avisado.'); return render();
    }
    if (t.dataset.leSalvar) {
      t.disabled = true;
      const nova = await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(t.dataset.leSalvar)}`, { method: 'PUT', body: JSON.stringify(lerForm(false)) });
      const { itens, gravacoes, ...resto } = nova;
      trocaDisc(resto); fecharModal(); toast('Salvo. O T.I foi avisado da mudança.'); return render();
    }
    if (t.dataset.leExcluir) {
      if (!confirm('Excluir esta disciplina do levantamento? Ela sai também da Aulas EAD do T.I.')) return;
      await apiFetch(`/${MODULO}/disciplinas/${encodeURIComponent(t.dataset.leExcluir)}`, { method: 'DELETE' });
      dados.disciplinas = dados.disciplinas.filter(d => d.id !== t.dataset.leExcluir); fecharModal(); toast('Disciplina excluída. O T.I foi avisado.'); return render();
    }
    if (t.dataset.leRelModo) { relModo = t.dataset.leRelModo; return render(); }
    if (t.dataset.leMsg) return copiar(mensagemProfessor(t.dataset.leMsg), `Mensagem para ${t.dataset.leMsg} copiada. É só colar no WhatsApp.`);
    if (t.dataset.leCopiarLink) { const s = salaDoProf(t.dataset.leCopiarLink); return s && copiar(s.link, `Link copiado: ${s.conta} · ${s.nome}`); }
    if (t.dataset.leCopiarRel !== undefined) return copiar(textoRelatorio(), 'Relatório copiado.');
    if (t.dataset.leImprimir !== undefined) return window.print();
    if (t.dataset.lePng !== undefined) return baixarPng(t);
    if (t.dataset.leCalendario !== undefined) return abrirCalendario();
    if (t.dataset.leFerMais !== undefined) { $('le-fer-lista').querySelector('[data-le-fer-vazio]')?.remove(); $('le-fer-lista').insertAdjacentHTML('beforeend', abrirCalendario.linhaHtml({ data: '', nome: '' })); return; }
    if (t.dataset.leFerTirar !== undefined) return t.closest('.le-fer-linha').remove();
    if (t.dataset.leFerSugerir !== undefined) {
      const ja = new Set([...document.querySelectorAll('[data-le-fer-data]')].map(i => i.value));
      const novos = feriadosNacionais(dados.semestre).filter(f => !ja.has(f.data));
      $('le-fer-lista').querySelector('[data-le-fer-vazio]')?.remove();
      novos.forEach(f => $('le-fer-lista').insertAdjacentHTML('beforeend', abrirCalendario.linhaHtml(f)));
      return toast(novos.length ? `${novos.length} feriado(s) nacional(is) sugerido(s). Confira e salve.` : 'Os feriados nacionais já estão na lista.');
    }
    if (t.dataset.leSalvarCal !== undefined) {
      const semAula = [...document.querySelectorAll('.le-fer-linha')].map(l => ({ data: l.querySelector('[data-le-fer-data]').value, nome: l.querySelector('[data-le-fer-nome]').value })).filter(x => x.data);
      t.disabled = true;
      const r = await apiFetch(`/${MODULO}/semestre/${dados.semestre}/calendario`, { method: 'PUT', body: JSON.stringify({
        inicio1: $('le-c-ini1').value, inicio2: $('le-c-ini2').value, semAula,
        fechamento: { 1: { data: $('le-c-f1').value, hora: $('le-c-h1').value }, 2: { data: $('le-c-f2').value, hora: $('le-c-h2').value } } }) });
      dados.calendario = r.calendario; dados.cronograma = r.cronograma; fecharModal(); toast('Calendário salvo. O T.I usa as mesmas datas.'); return render();
    }
  } catch (err) { toast(err.message, 'erro'); t.disabled = false; }
}
async function mudanca(e) {
  const t = e.target;
  try {
    if (t.dataset.leF === 'curso') { filtroCurso = t.value; return render(); }
    if (t.dataset.leF === 'dia') { filtroDia = t.value; return render(); }
    if (t.dataset.leF === 'prof') { filtroProf = t.value; return render(); }
    if (t.dataset.leRelCurso !== undefined) { relCurso = t.value; return render(); }
    if (t.dataset.leRelProf !== undefined) { relProf = t.value; return render(); }
    if (t.dataset.leCrCurso !== undefined) { crCurso = t.value; crDisc = ''; return render(); }
    if (t.dataset.leCrDisc !== undefined) { crDisc = t.value; return render(); }
    if (t.dataset.leCrBim !== undefined) { crBim = t.value; return render(); }
    if (t.dataset.leTutor !== undefined) {
      const r = await apiFetch(`/${MODULO}/semestre/${dados.semestre}/tutor`, { method: 'PUT', body: JSON.stringify({ cursoId: t.dataset.leTutor, uid: t.value }) });
      dados.tutorDoCurso = r.tutorDoCurso; toast('Tutor do curso salvo.'); return render();
    }
  } catch (err) { toast(err.message, 'erro'); render(); }
}
function ligarEventos() {
  $('le-semestre').addEventListener('change', () => { renderRelatorio.jaPadrao = false; relCurso = ''; carregar(); });
  $('le-abas').addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (!b) return; aba = b.dataset.aba; render(); });
  tela().addEventListener('click', acao);
  tela().addEventListener('change', mudanca);
  let tBusca;
  tela().addEventListener('input', (e) => {
    if (e.target.dataset.leBusca === undefined) return;
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { busca = e.target.value; render(); const i = tela().querySelector('[data-le-busca]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
  });
  tela().addEventListener('keydown', (e) => { const l = e.target.closest('tr[data-le-disc]'); if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrirDisciplina(l.dataset.leDisc); } });
  $('le-modal').addEventListener('click', (e) => {
    if (e.target === $('le-modal') || e.target.closest('#le-modal-fechar')) return fecharModal();
    acao(e);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });
  $('le-arquivo').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await previaImportacao(await lerArquivo(f)); } catch (err) { toast(err.message, 'erro'); }
  });
}

async function initApp(user, role, nivel) {
  appInitialized = true; initializedRole = role; podeEditar = nivel >= 3; meuUid = user.uid;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../../auth/login.html'; });
  $('auth-guard').classList.add('hidden');
  $('app').classList.remove('hidden');
  ligarEventos();
  let semestres = [];
  try { semestres = await apiFetch(`/${MODULO}/semestres`); } catch (e) { toast(e.message, 'erro'); }
  const padrao = semestres.includes('2027.1') ? '2027.1' : (semestres[1] || semestres[0] || '');
  $('le-semestre').innerHTML = semestres.map(s => `<option value="${esc(s)}" ${s === padrao ? 'selected' : ''}>${esc(s)}</option>`).join('');
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
