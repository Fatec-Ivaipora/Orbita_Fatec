// ================================================================
//  PLANO DE AÇÃO — PARTE 2: DOCUMENTOS DA DIREÇÃO COM ASSINATURA
//  (21/10/2026). A Direção preenche os planos de ação (Equipe
//  Multidisciplinar, Coordenação de Curso, Colegiado) e a Avaliação de
//  Desempenho da Coordenação e envia; a assinatura do Diretor Acadêmico
//  entra sozinha no envio e o responsável assina confirmando a senha.
//  O documento sai no layout dos modelos em Word, com as assinaturas no
//  padrão do SIGMA (ASSINATURAS-CERTIFICADO.md) e o código de verificação.
//  Servidor: src/rotas/plano-acao-documentos.js
// ================================================================
import { EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

let A = null;            // { apiFetch, toast, abrirModal, fecharModal, esc, ctx(), auth, render, nomeCursos, fmtData, dataHora }
let meta = null;         // modelos + quem assina
let lista = null;        // documentos do semestre (Direção) ou do responsável
let assinantes = null;   // aba Assinaturas
let aberto = null;       // documento aberto (completo)
let editando = false;
let filtroStatus = '';
let filtroCurso = '__todos';   // Direção: um curso por vez ou todos agrupados por curso

const STATUS = {
  rascunho: { rotulo: 'Rascunho', classe: 'st-rasc' },
  aguardando: { rotulo: 'Aguardando assinatura', classe: 'st-agu' },
  assinado: { rotulo: 'Assinado', classe: 'st-ass' },
  devolvido: { rotulo: 'Devolvido para correção', classe: 'st-dev' }
};
const TIPO_CURTO = {
  equipe_multidisciplinar: 'Plano · Equipe Multidisciplinar', coordenacao: 'Plano · Coordenação de Curso',
  colegiado: 'Plano · Colegiado de Curso', avaliacao: 'Avaliação da Coordenação'
};

export function ligarDocumentos(api) {
  A = api;
  document.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-pd-curso]');
    if (!sel) return;
    filtroCurso = sel.value;
    A.render();
  });
}
export const temDocumentoAberto = () => !!aberto;
export function fecharDocumento() { aberto = null; editando = false; document.body.classList.remove('pd-doc-aberto'); }
export function limparDocumentos() { lista = null; aberto = null; editando = false; assinantes = null; }

const e = (s) => A.esc(s);
const sem = () => A.ctx().semestre;
const fmtDataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const chipStatus = (s) => `<span class="pd-status ${STATUS[s].classe}">${STATUS[s].rotulo}</span>`;
const fmt2 = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(2).replace('.', ','));

async function garantirMeta() {
  if (!meta) meta = await A.apiFetch('/plano-acao/documentos/meta');
  return meta;
}
async function carregarLista() {
  lista = await A.apiFetch(`/plano-acao/documentos?semestre=${encodeURIComponent(sem().id)}`);
  return lista;
}
async function abrir(id) {
  aberto = await A.apiFetch(`/plano-acao/documentos/${encodeURIComponent(id)}`);
  editando = false;
  A.render();
}

// ================================================================
//  LISTA (Direção)
// ================================================================
export function renderListaDirecao(tela) {
  if (aberto) return renderDocumento(tela);
  document.body.classList.remove('pd-doc-aberto');
  if (!meta || !lista) {
    tela.innerHTML = '<p class="pa-vazio">Carregando os documentos...</p>';
    Promise.all([garantirMeta(), carregarLista()]).then(() => A.render()).catch(err => { tela.innerHTML = `<div class="pa-card pa-erro">${e(err.message)}</div>`; });
    return;
  }
  // Separado por semestre (seletor do topo) e por curso (pedido 22/10/2026:
  // "separar por curso e semestre os documentos pra não misturar").
  // Equipe Multidisciplinar (EAD) não tem curso: fica num grupo próprio.
  const SEM_CURSO = '';
  const nomeGrupo = (c) => c === SEM_CURSO ? 'EAD · Equipe Multidisciplinar' : A.nomeCursos([c]);
  const cursos = [...new Set(lista.map(d => d.curso || SEM_CURSO))]
    .sort((a, b) => (a === SEM_CURSO) - (b === SEM_CURSO) || nomeGrupo(a).localeCompare(nomeGrupo(b), 'pt-BR'));
  if (filtroCurso !== '__todos' && !cursos.includes(filtroCurso)) filtroCurso = '__todos';
  const doCurso = lista.filter(d => filtroCurso === '__todos' || (d.curso || SEM_CURSO) === filtroCurso);
  const filtrados = doCurso.filter(d => !filtroStatus || d.status === filtroStatus);
  const conta = (st) => doCurso.filter(d => d.status === st).length;
  const grupos = cursos.map(c => ({ c, docs: filtrados.filter(d => (d.curso || SEM_CURSO) === c) })).filter(g => g.docs.length);
  const ordemTipo = Object.keys(TIPO_CURTO);

  const tabela = (docs) => `<div class="pa-tabela-wrap"><table class="pa-tabela pa-tabela-atv">
      <thead><tr><th scope="col">Documento</th><th scope="col">Responsável</th><th scope="col">Situação</th><th scope="col">Atualizado</th></tr></thead>
      <tbody>${docs.sort((a, b) => ordemTipo.indexOf(a.tipo) - ordemTipo.indexOf(b.tipo) || (b.data || '').localeCompare(a.data || '')).map(d => `
        <tr class="pa-linha" data-pd-abrir="${e(d.id)}" tabindex="0">
          <td><span class="pa-titulo">${e(TIPO_CURTO[d.tipo])}</span><span class="pa-atv-det">data ${A.fmtData(d.data)}${d.codigo ? ` · código ${e(d.codigo)}` : ''}</span></td>
          <td>${e(d.signatario.nome)}<span class="pa-atv-det">${e(d.signatario.cargo || '')}</span></td>
          <td>${chipStatus(d.status)}${d.status === 'devolvido' && d.motivoDevolucao ? `<span class="pa-atv-det">"${e(d.motivoDevolucao)}"</span>` : ''}</td>
          <td class="pa-mudo">${d.atualizadoEm ? A.dataHora(d.atualizadoEm) : ''}</td>
        </tr>`).join('')}</tbody></table></div>`;

  tela.innerHTML = `
    <section class="pa-card pd-topo">
      <div><h3 class="pa-card-titulo">Documentos da Direção Acadêmica <span class="pa-secao-prazo">semestre ${e(sem().id)}</span></h3>
        <p class="pa-mudo">Planos de ação e avaliação da coordenação, separados por curso. Para ver outro semestre, troque no seletor do topo. Ao enviar, a assinatura do Diretor Acadêmico entra sozinha.</p></div>
      <button type="button" class="btn-primary" data-pd="novo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Novo documento</button>
    </section>
    <div class="pd-filtros-linha">
      <label class="pd-filtro-curso">Curso
        <select class="select-filter" data-pd-curso>
          <option value="__todos">Todos os cursos (${lista.length})</option>
          ${cursos.map(c => `<option value="${e(c)}" ${filtroCurso === c ? 'selected' : ''}>${e(nomeGrupo(c))} (${lista.filter(d => (d.curso || SEM_CURSO) === c).length})</option>`).join('')}
        </select>
      </label>
      <div class="pa-filtros">
        <button type="button" class="pa-filtro${!filtroStatus ? ' ativo' : ''}" data-pd-filtro="">Todos <span>${doCurso.length}</span></button>
        ${Object.entries(STATUS).map(([k, st]) => `<button type="button" class="pa-filtro${filtroStatus === k ? ' ativo' : ''}" data-pd-filtro="${k}">${st.rotulo} <span>${conta(k)}</span></button>`).join('')}
      </div>
    </div>
    ${grupos.length ? grupos.map(g => `
      <section class="pa-card pa-card-tabela pd-grupo">
        <h3 class="pa-card-titulo pd-grupo-titulo">${e(nomeGrupo(g.c))} <span class="pa-mudo">${g.docs.length} documento${g.docs.length > 1 ? 's' : ''} · ${e(sem().id)}</span></h3>
        ${tabela(g.docs)}
      </section>`).join('')
    : `<section class="pa-card"><p class="pa-mudo pd-vazio">${lista.length ? 'Nenhum documento com esse filtro.' : `Nenhum documento em ${e(sem().id)}. Use "Novo documento" para preencher um plano de ação ou a avaliação de uma coordenação.`}</p></section>`}`;
}

// ================================================================
//  DOCUMENTOS PRA ASSINAR (responsável) — aparece no topo do plano dele
// ================================================================
export function blocoParaAssinar() {
  if (!aberto) document.body.classList.remove('pd-doc-aberto');
  if (lista === null) {
    lista = [];
    carregarLista().then(() => A.render()).catch(() => {});
    return '';
  }
  const pend = lista.filter(d => d.status === 'aguardando');
  const assinados = lista.filter(d => d.status === 'assinado');
  if (!pend.length && !assinados.length) return '';
  return `<section class="pa-card pd-assinar">
    <h3 class="pa-card-titulo">${pend.length ? `Documento${pend.length > 1 ? 's' : ''} para assinar <span class="pd-badge">${pend.length}</span>` : 'Documentos da Direção'}</h3>
    <ul class="pd-mini">${[...pend, ...assinados.slice(0, 5)].map(d => `
      <li><button type="button" class="pd-mini-item" data-pd-abrir="${e(d.id)}">
        <span><b>${e(TIPO_CURTO[d.tipo])}</b> <span class="pa-mudo">${e(A.nomeCursos(d.curso ? [d.curso] : []))} · ${A.fmtData(d.data)}</span></span>
        ${chipStatus(d.status)}</button></li>`).join('')}</ul>
  </section>`;
}

export function renderDocumentoResponsavel(tela) { renderDocumento(tela); }

// ================================================================
//  NOVO DOCUMENTO
// ================================================================
async function novoDocumento() {
  await garantirMeta();
  const sigs = meta.signatarios || [];
  const cursos = (u) => (u && u.cursos) || [];
  A.abrirModal('Novo documento', `
    <label class="pa-campo">Documento<select id="pd-tipo" class="select-filter">${Object.entries(meta.tipos).map(([k, t]) => `<option value="${k}">${e(t)}</option>`).join('')}</select></label>
    <label class="pa-campo">Responsável que assina<select id="pd-sig" class="select-filter">${sigs.map(s => `<option value="${e(s.uid)}">${e(s.nome)}${s.ead ? ' — EAD' : s.cursos.length ? ` — ${e(A.nomeCursos(s.cursos))}` : ''}</option>`).join('')}</select></label>
    <div class="pa-campos-2">
      <label class="pa-campo">Curso<select id="pd-curso" class="select-filter"></select></label>
      <label class="pa-campo">Data do documento<input type="date" id="pd-data" value="${e(A.ctx().hoje)}"></label>
    </div>
    <label class="pa-campo pd-so-aval">Período da avaliação<input type="text" id="pd-periodo" maxlength="80" placeholder="Ex.: 2º semestre de 2026"></label>`,
  async () => {
    const body = { tipo: $('pd-tipo').value, signatarioUid: $('pd-sig').value, curso: $('pd-curso').value, data: $('pd-data').value, periodo: $('pd-periodo').value, semestre: sem().id };
    try {
      const r = await A.apiFetch('/plano-acao/documentos', { method: 'POST', body: JSON.stringify(body) });
      A.fecharModal();
      lista = null;
      await abrir(r.id);
      editando = true;
      A.render();
    } catch (err) { A.toast(err.message, 'erro'); }
  }, 'Criar e preencher');
  const atualizar = () => {
    const s = sigs.find(x => x.uid === $('pd-sig').value);
    const cs = cursos(s);
    $('pd-curso').innerHTML = (cs.length ? '' : '<option value="">— (sem curso)</option>') + cs.map(c => `<option value="${e(c)}">${e(A.nomeCursos([c]))}</option>`).join('');
    document.querySelector('.pd-so-aval').classList.toggle('hidden', $('pd-tipo').value !== 'avaliacao');
  };
  $('pd-sig').addEventListener('change', atualizar);
  $('pd-tipo').addEventListener('change', atualizar);
  if (!$('pd-periodo').value) $('pd-periodo').value = `${sem().id.endsWith('.1') ? '1º' : '2º'} semestre de ${sem().id.slice(0, 4)}`;
  atualizar();
}
const $ = (id) => document.getElementById(id);

// ================================================================
//  DOCUMENTO (ver / editar / assinar)
// ================================================================
function renderDocumento(tela) {
  const d = aberto;
  document.body.classList.add('pd-doc-aberto');
  const ctx = A.ctx();
  const souResp = d.signatarioUid === ctx.uid;
  const podeEditar = ctx.direcao && ['rascunho', 'devolvido'].includes(d.status);
  const barra = `
    <div class="pd-barra">
      <button type="button" class="btn-secondary" data-pd="voltar">Voltar</button>
      <div class="pd-barra-info"><b>${e(d.titulo)}</b> ${chipStatus(d.status)}</div>
      <div class="pd-barra-acoes">
        ${ctx.direcao && (d.status !== 'assinado' || (meta && meta.admN1)) ? '<button type="button" class="btn-secondary pa-btn-perigo" data-pd="excluir"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>Excluir</button><span class="pd-barra-sep" aria-hidden="true"></span>' : ''}
        ${souResp && d.status === 'aguardando' ? '<button type="button" class="btn-secondary" data-pd="devolver">Pedir correção</button>' : ''}
        ${!editando && d.status !== 'rascunho' ? '<button type="button" class="btn-secondary" data-pd="pdf">Abrir PDF</button>' : ''}
        ${podeEditar && !editando ? '<button type="button" class="btn-secondary" data-pd="editar">Editar</button>' : ''}
        ${podeEditar && editando ? '<button type="button" class="btn-secondary" data-pd="salvar">Salvar rascunho</button>' : ''}
        ${podeEditar ? '<button type="button" class="btn-primary" data-pd="enviar">Enviar para assinatura</button>' : ''}
      </div>
    </div>
    ${d.status === 'devolvido' && d.motivoDevolucao ? `<div class="pd-aviso">Devolvido por ${e(d.signatario.nome)}: "${e(d.motivoDevolucao)}". Corrija e envie de novo.</div>` : ''}
    ${souResp && d.status === 'aguardando' ? `<div class="pd-aviso pd-aviso-azul">Confira o documento e, no fim dele, clique em <b>"Clique aqui para assinar"</b>. A sua assinatura entra com data e hora e o documento recebe o código de verificação.${d.tipo === 'avaliacao' ? ' Se quiser, escreva antes as suas considerações no quadro "Coordenador(a)".' : ''}</div>` : ''}`;
  tela.innerHTML = barra + `<div class="pd-papel-wrap"><article class="pd-papel" id="pd-papel">${papel(d, editando)}</article></div>`;
  if (editando) ligarEditor();
}

// ---------- o "papel": mesmo layout do Word ----------
function papel(d, edit) {
  // Mesmo cabeçalho/rodapé institucional das provas do Banco de Provas
  // (src/utils/gerarProvaDocx.js: criarCabecalhoInstitucional / criarRodapeInstitucional).
  const cab = `
    <header class="pd-cab">
      <img src="/docencia/plano-acao/img/logo-fatec-cabecalho.png" alt="FATEC Ivaiporã" class="pd-logo">
      <div class="pd-cab-inst">
        <span>Mantida pela União de Ensino Superior do Vale do Ivaí Ltda - UNESVI</span>
        <span>Credenciamento EaD - Portaria nº 874 de 28 de novembro de 2025</span>
        <span>Recredenciamento - Portaria nº 878 de 28 de novembro de 2025</span>
      </div>
    </header>`;
  const cursoNome = A.nomeCursos(d.curso ? [d.curso] : []) || '—';
  let corpo;
  if (d.tipo === 'avaliacao') corpo = corpoAvaliacao(d, edit, cursoNome);
  else corpo = corpoPlano(d, edit, cursoNome);
  const rodapeInst = `
    <footer class="pd-rodape-inst">
      <span>Avenida Brasil, 45 – Fone (43) 3472-0201 – CEP 86870-000 – Ivaiporã /Paraná</span>
      <span>www.fatecivaipora.com.br</span>
    </footer>`;
  // último quadro + assinaturas + rodapé ficam juntos (nunca assinatura sozinha numa página)
  const [antes, fim] = corpo.split('<!--pd-fim-->');
  return cab + `<div class="pd-miolo">${antes}<div class="pd-fim">${fim || ''}${assinaturas(d)}${rodape(d)}${rodapeInst}</div></div>`;
}

function corpoPlano(d, edit, cursoNome) {
  const m = d.conteudo;
  const r = d.respostas || {};
  return `
    <div class="pd-campos">
      <span><b>CURSO:</b> ${e(cursoNome)}</span>
      <span><b>DATA:</b> ${edit ? `<input type="date" id="pd-e-data" value="${e(d.data)}">` : A.fmtData(d.data)}</span>
    </div>
    <table class="pd-tab">
      <thead><tr><th colspan="3" class="pd-tab-titulo">${e(m.titulo)}</th></tr>
        <tr><th>Atividades desenvolvidas</th><th class="pd-col-per">Periodicidade</th><th>Indicador de desempenho</th></tr></thead>
      <tbody>${m.itens.map(it => `
        <tr><td>${e(it.atividade)}</td><td class="pd-col-per">${e(it.periodicidade)}</td>
          <td>${it.indicadores.map(ind => `
            <div class="pd-ind"><span class="pd-ind-perg">${e(ind.pergunta)}:</span>
              <span class="pd-ops">${ind.opcoes.map(o => edit
                ? `<label class="pd-op"><input type="radio" name="${e(ind.id)}" value="${e(o)}" ${r[ind.id] === o ? 'checked' : ''}><span>${e(o)}</span></label>`
                : `<span class="pd-op-v ${r[ind.id] === o ? 'sim' : ''}">${r[ind.id] === o ? '☒' : '☐'} ${e(o)}</span>`).join('')}</span></div>`).join('')}
          </td></tr>`).join('')}</tbody>
    </table>
    <!--pd-fim-->
    <div class="pd-campos pd-campos-resp"><span><b>RESPONSÁVEL:</b> ${e(d.signatario.nome)}${d.signatario.cargo ? ` — ${e(d.signatario.cargo)}` : ''}</span></div>`;
}

function corpoAvaliacao(d, edit, cursoNome) {
  const m = d.conteudo;
  const n = d.notas || {};
  const res = d.resultados || calcular(d);
  const notaCel = (c) => edit
    ? `<span class="pd-notas">${[1, 2, 3, 4, 5].map(v => `<label class="pd-nota"><input type="radio" name="${c.id}" value="${v}" ${Number(n[c.id]) === v ? 'checked' : ''}><span>${v}</span></label>`).join('')}</span>`
    : `<b class="pd-nota-v">${n[c.id] ?? '—'}</b>`;
  return `
    <h2 class="pd-titulo">${e(m.titulo)}</h2>
    <table class="pd-tab pd-tab-campos pd-tab-inteira"><tbody>
      <tr><td colspan="2"><b>COORDENADOR AVALIADO:</b> ${e(d.signatario.nome)}</td></tr>
      <tr><td><b>CURSO:</b> ${e(cursoNome)}</td><td><b>PERÍODO DA AVALIAÇÃO:</b> ${edit ? `<input type="text" id="pd-e-periodo" value="${e(d.periodo || '')}" maxlength="80">` : e(d.periodo || '—')}</td></tr>
    </tbody></table>
    ${m.blocos.map(b => `
      <table class="pd-tab pd-tab-inteira">
        <thead><tr><th colspan="3" class="pd-tab-titulo">${e(b.titulo)}</th></tr>
          <tr><th class="pd-col-crit">Critério</th><th>Descrição</th><th class="pd-col-nota">Nota (1 – 5)</th></tr></thead>
        <tbody>${b.criterios.map(c => `<tr><td><b>${e(c.nome)}</b></td><td>${e(c.descricao)}</td><td class="pd-col-nota">${notaCel(c)}</td></tr>`).join('')}
          <tr class="pd-tot"><td colspan="2">Somatória das notas</td><td class="pd-col-nota" data-soma="${b.id}">${res.blocos[b.id].soma ?? '—'}</td></tr>
          <tr class="pd-tot"><td colspan="2">Nota média do bloco</td><td class="pd-col-nota" data-media="${b.id}">${fmt2(res.blocos[b.id].media)}</td></tr>
        </tbody>
      </table>`).join('')}
    <table class="pd-tab pd-tab-inteira">
      <thead><tr><th colspan="4" class="pd-tab-titulo">Média obtida nos blocos</th></tr>
        <tr>${m.blocos.map((b, i) => `<th>Bloco ${['I', 'II', 'III', 'IV'][i]}</th>`).join('')}</tr></thead>
      <tbody><tr>${m.blocos.map(b => `<td class="pd-col-nota" data-media2="${b.id}">${fmt2(res.blocos[b.id].media)}</td>`).join('')}</tr>
        <tr class="pd-tot"><td colspan="3">Resultado da Gestão (RDG)</td><td class="pd-col-nota" data-rdg>${fmt2(res.rdg)}</td></tr></tbody>
    </table>
    <!--pd-fim-->
    <table class="pd-tab pd-tab-inteira">
      <thead><tr><th>Resultados</th><th class="pd-col-nota">Valor obtido</th><th>Considerações gerais</th></tr></thead>
      <tbody>
        <tr><td>Resultado da Gestão (RDG)</td><td class="pd-col-nota" data-rdg>${fmt2(res.rdg)}</td>
          <td rowspan="5" class="pd-consid">
            <p><b>Direção Acadêmica:</b> ${edit ? `<textarea id="pd-e-consid" rows="4" maxlength="3000">${e(d.consideracoesDirecao || '')}</textarea>` : e(d.consideracoesDirecao || '—')}</p>
            <p><b>Coordenador(a):</b> ${podeAssinar(d) ? '<textarea id="pd-a-consid" rows="4" maxlength="3000" placeholder="Suas considerações (opcional)"></textarea>' : e(d.consideracoesResponsavel || (d.status === 'assinado' ? '—' : '(o coordenador escreve ao assinar)'))}</p>
          </td></tr>
        <tr><td>Resultado da Avaliação Discente (RDI)</td><td class="pd-col-nota">${edit ? `<input type="number" id="pd-e-rdi" step="0.01" min="0" max="10" value="${d.rdi ?? ''}">` : fmt2(d.rdi)}</td></tr>
        <tr><td>Resultado da Avaliação Docente (RDO)</td><td class="pd-col-nota">${edit ? `<input type="number" id="pd-e-rdo" step="0.01" min="0" max="10" value="${d.rdo ?? ''}">` : fmt2(d.rdo)}</td></tr>
        <tr><td>Total geral de pontos</td><td class="pd-col-nota" data-total>${fmt2(res.total)}</td></tr>
        <tr class="pd-tot"><td>Resultado final (RF)</td><td class="pd-col-nota" data-rf>${fmt2(res.rf)}</td></tr>
      </tbody>
    </table>`;
}

// Mesma conta do servidor (src/utils/planoAcaoModelos.js → resultadosAvaliacao)
function calcular(d) {
  const media = (l) => l.length && l.every(Number.isFinite) ? Math.round(l.reduce((a, b) => a + b, 0) / l.length * 100) / 100 : null;
  const blocos = {};
  d.conteudo.blocos.forEach(b => {
    const ns = b.criterios.map(c => Number((d.notas || {})[c.id]));
    blocos[b.id] = { soma: ns.every(Number.isFinite) ? ns.reduce((a, x) => a + x, 0) : null, media: media(ns) };
  });
  const rdg = media(d.conteudo.blocos.map(b => blocos[b.id].media));
  const vals = [rdg, d.rdi === '' || d.rdi === null ? NaN : Number(d.rdi), d.rdo === '' || d.rdo === null ? NaN : Number(d.rdo)];
  const total = vals.every(Number.isFinite) ? Math.round(vals.reduce((a, x) => a + x, 0) * 100) / 100 : null;
  return { blocos, rdg, total, rf: total === null ? null : Math.round(total / 3 * 100) / 100 };
}

// ---------- assinaturas (layout do SIGMA) ----------
const podeAssinar = (d) => d.status === 'aguardando' && d.signatarioUid === A.ctx().uid;

function assinaturas(d) {
  const bloco = (a, img, pendente, botao) => `
    <div class="pd-ass">
      <div class="pd-ass-img">${botao || (img ? `<img src="${e(img)}" alt="Assinatura de ${e(a.nome)}">` : pendente ? `<span class="pd-ass-pend">${e(pendente)}</span>` : '')}</div>
      <div class="pd-ass-linha"></div>
      <strong>${e((a.nome || '').toUpperCase())}</strong>
      <span>${e(a.cargo || '')}</span>
      ${a.em ? `<small>Assinado eletronicamente em ${fmtDataHora(a.em)}</small>` : ''}
    </div>`;
  const dir = d.assinaturaDirecao;
  const resp = d.assinaturaResponsavel;
  return `<section class="pd-assinaturas">
    ${dir ? bloco(dir, d.imagens && d.imagens.direcao) : bloco({ nome: 'Diretor Acadêmico', cargo: 'Direção Acadêmica' }, null, 'assina ao enviar')}
    ${resp ? bloco(resp, d.imagens && d.imagens.responsavel, resp.comImagem ? null : 'assinatura eletrônica')
      : bloco(d.signatario, null, d.status === 'aguardando' ? 'aguardando assinatura' : 'pendente', podeAssinar(d) ? `
        <div class="pd-ass-acao" id="pd-ass-acao">
          <button type="button" class="pd-ass-btn" data-pd="assinar">Clique aqui para assinar</button>
          <div class="pd-ass-senha hidden" id="pd-ass-senha">
            <label for="pd-a-senha">Confirme a sua senha</label>
            <span><input type="password" id="pd-a-senha" autocomplete="current-password"><button type="button" class="pd-ass-ok" data-pd="assinar-senha">Assinar</button></span>
          </div>
        </div>` : null)}
  </section>`;
}

function rodape(d) {
  if (!d.codigo) return '';
  const url = `${location.origin}/docencia/plano-acao/verificar.html?c=${encodeURIComponent(d.codigo)}`;
  return `<footer class="pd-rodape">
    Documento ${d.status === 'assinado' ? 'assinado' : 'emitido'} eletronicamente no Órbita FATEC · código de verificação <b>${e(d.codigo)}</b><br>
    Confira em ${e(url)}${d.hash ? ` · ${e(d.hash.slice(0, 16))}` : ''}
  </footer>`;
}

// ---------- editor ----------
function lerEditor() {
  const d = aberto;
  const body = {};
  if ($('pd-e-data')) body.data = $('pd-e-data').value;
  if ($('pd-e-periodo')) body.periodo = $('pd-e-periodo').value;
  if (d.tipo === 'avaliacao') {
    body.notas = {};
    d.conteudo.blocos.forEach(b => b.criterios.forEach(c => { const x = document.querySelector(`input[name="${c.id}"]:checked`); if (x) body.notas[c.id] = Number(x.value); }));
    body.rdi = $('pd-e-rdi').value; body.rdo = $('pd-e-rdo').value;
    body.consideracoesDirecao = $('pd-e-consid').value;
  } else {
    body.respostas = {};
    d.conteudo.itens.forEach(it => it.indicadores.forEach(ind => { const x = document.querySelector(`input[name="${CSS.escape(ind.id)}"]:checked`); if (x) body.respostas[ind.id] = x.value; }));
  }
  return body;
}

function ligarEditor() {
  if (aberto.tipo !== 'avaliacao') return;
  // recalcula somas e médias na hora
  $('pd-papel').addEventListener('input', () => {
    const b = lerEditor();
    const res = calcular({ ...aberto, notas: b.notas, rdi: b.rdi, rdo: b.rdo });
    Object.entries(res.blocos).forEach(([id, x]) => {
      document.querySelectorAll(`[data-soma="${id}"]`).forEach(el => { el.textContent = x.soma ?? '—'; });
      document.querySelectorAll(`[data-media="${id}"], [data-media2="${id}"]`).forEach(el => { el.textContent = fmt2(x.media); });
    });
    document.querySelectorAll('[data-rdg]').forEach(el => { el.textContent = fmt2(res.rdg); });
    document.querySelector('[data-total]').textContent = fmt2(res.total);
    document.querySelector('[data-rf]').textContent = fmt2(res.rf);
  });
}

async function salvar(silencioso) {
  const body = lerEditor();
  await A.apiFetch(`/plano-acao/documentos/${encodeURIComponent(aberto.id)}`, { method: 'PUT', body: JSON.stringify(body) });
  Object.assign(aberto, body);
  if (!silencioso) A.toast('Rascunho salvo.');
}

async function enviar() {
  try {
    if (editando) await salvar(true);
    if (!confirm(`Enviar para ${aberto.signatario.nome} assinar? A assinatura do Diretor Acadêmico será aplicada agora e o documento não poderá mais ser editado (a não ser que o responsável peça correção).`)) return;
    await A.apiFetch(`/plano-acao/documentos/${encodeURIComponent(aberto.id)}/enviar`, { method: 'POST' });
    lista = null;
    await abrir(aberto.id);
    A.toast('Enviado para assinatura.');
  } catch (err) { A.toast(err.message, 'erro'); }
}

// Clique na assinatura: se o login é recente (até 10 min) assina na hora;
// senão o servidor pede a senha, que é digitada ali mesmo (sem janela).
async function assinar(senha) {
  const d = aberto;
  const btn = document.querySelector('[data-pd="assinar"]');
  const ok = document.querySelector('[data-pd="assinar-senha"]');
  [btn, ok].forEach(b => { if (b) b.disabled = true; });
  try {
    if (senha) {
      const u = A.auth.currentUser;
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, senha));
      await u.getIdToken(true);
    }
    await A.apiFetch(`/plano-acao/documentos/${encodeURIComponent(d.id)}/assinar`, { method: 'POST', body: JSON.stringify({ consideracoes: $('pd-a-consid') ? $('pd-a-consid').value : '' }) });
    lista = null;
    const consid = $('pd-a-consid') ? $('pd-a-consid').value : '';
    await abrir(d.id);
    if (consid && !aberto.consideracoesResponsavel) aberto.consideracoesResponsavel = consid;
    A.toast('Documento assinado.');
  } catch (err) {
    [btn, ok].forEach(b => { if (b) b.disabled = false; });
    if (/Confirme a sua senha/.test(err.message)) {
      $('pd-ass-senha').classList.remove('hidden');
      if (btn) btn.classList.add('hidden');
      $('pd-a-senha').focus();
      return;
    }
    A.toast(/auth\/(wrong-password|invalid-credential|invalid-login)/.test(err.code || err.message) ? 'Senha incorreta.' : err.message, 'erro');
  }
}

function devolver() {
  A.abrirModal('Pedir correção', `
    <p class="pa-mudo">O documento volta para a Direção corrigir e enviar de novo.</p>
    <label class="pa-campo">O que precisa ser corrigido<textarea id="pd-d-motivo" rows="4" maxlength="1000"></textarea></label>`,
  async () => {
    try {
      await A.apiFetch(`/plano-acao/documentos/${encodeURIComponent(aberto.id)}/devolver`, { method: 'POST', body: JSON.stringify({ motivo: $('pd-d-motivo').value }) });
      A.fecharModal();
      lista = null;
      aberto = null;
      A.render();
      A.toast('Documento devolvido para a Direção.');
    } catch (err) { A.toast(err.message, 'erro'); }
  }, 'Devolver');
}

async function excluir() {
  const msg = aberto.status === 'assinado'
    ? `Este documento JÁ ESTÁ ASSINADO por ${aberto.signatario.nome}.

Excluir apaga o documento de vez e o código de verificação ${aberto.codigo} deixa de funcionar. Isso não pode ser desfeito.

Excluir mesmo assim?`
    : 'Excluir este documento?';
  if (!confirm(msg)) return;
  try {
    await A.apiFetch(`/plano-acao/documentos/${encodeURIComponent(aberto.id)}`, { method: 'DELETE' });
    lista = null; aberto = null;
    A.render();
    A.toast('Documento excluído.');
  } catch (err) { A.toast(err.message, 'erro'); }
}

// ================================================================
//  PDF (22/10/2026): o botão gera o arquivo PDF (A4 paisagem, como os modelos
//  em Word) e abre numa aba nova — imprimir/baixar fica pra quando a pessoa
//  quiser. html2pdf.js (cdnjs) é carregado só na primeira vez.
// ================================================================
const HTML2PDF = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
let html2pdfPronto = null;
function carregarHtml2pdf() {
  if (window.html2pdf) return Promise.resolve();
  if (!html2pdfPronto) {
    html2pdfPronto = new Promise((ok, erro) => {
      const sc = document.createElement('script');
      sc.src = HTML2PDF;
      sc.onload = ok;
      sc.onerror = () => { html2pdfPronto = null; erro(new Error('Não consegui carregar o gerador de PDF. Verifique a internet e tente de novo.')); };
      document.head.appendChild(sc);
    });
  }
  return html2pdfPronto;
}

// "F" da marca d'água em PNG (o jsPDF não desenha SVG): img/marca-f.svg (tirado do logo vetorial) num canvas.
let marcaPng = null;
function marcaDagua() {
  if (marcaPng) return Promise.resolve(marcaPng);
  return new Promise((ok, erro) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = 636; cv.height = 714;
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      marcaPng = cv.toDataURL('image/png');
      ok(marcaPng);
    };
    img.onerror = () => erro(new Error('Não consegui carregar a marca d’água.'));
    img.src = '/docencia/plano-acao/img/marca-f.svg';
  });
}

async function abrirPdf() {
  const d = aberto;
  // a aba abre já no clique (depois de esperar, o navegador bloqueia o pop-up)
  const aba = window.open('', '_blank');
  if (aba) aba.document.write('<p style="font-family:sans-serif;padding:2rem">Gerando o PDF...</p>');
  const btn = document.querySelector('[data-pd="pdf"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF...'; }
  const fora = document.createElement('div');
  try {
    await carregarHtml2pdf();
    // cópia do documento com a largura útil da folha (A4 paisagem menos as margens)
    fora.className = 'pd-pdf-fora';
    fora.innerHTML = `<article class="pd-papel pd-papel-pdf">${papel(d, false)}</article>`;
    document.body.appendChild(fora);
    await Promise.all([...fora.querySelectorAll('img')].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    const curso = d.curso ? ` - ${A.nomeCursos([d.curso])}` : '';
    const nome = `${d.titulo}${curso} - ${d.signatario.nome} - ${A.fmtData(d.data).replace(/\//g, '-')}.pdf`;
    const marca = await marcaDagua();
    const blob = await window.html2pdf().set({
      margin: [8, 10, 8, 10],
      filename: nome,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.pd-fim', '.pd-tab-inteira', 'tr', '.pd-assinaturas', '.pd-cab', '.pd-campos'] } // tabela da Avaliação vai inteira pra próxima página (22/10)
    }).from(fora.firstElementChild).toPdf().get('pdf').then(pdf => {
      // marca d'água: o "F" da FATEC no centro de cada página, bem claro
      const n = pdf.internal.getNumberOfPages();
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const lw = 115, lh = 115 * 238 / 212;
      for (let i = 1; i <= n; i++) {
        pdf.setPage(i);
        pdf.setGState(new pdf.GState({ opacity: 0.05 }));
        pdf.addImage(marca, 'PNG', (pw - lw) / 2, (ph - lh) / 2, lw, lh);
        pdf.setGState(new pdf.GState({ opacity: 1 }));
      }
      return pdf.output('blob');
    });
    const url = URL.createObjectURL(new File([blob], nome, { type: 'application/pdf' }));
    if (aba) aba.location.href = url;
    else {
      const a = document.createElement('a');
      a.href = url; a.download = nome; a.click();
    }
  } catch (err) {
    if (aba) aba.close();
    A.toast(err.message, 'erro');
  } finally {
    fora.remove();
    if (btn) { btn.disabled = false; btn.textContent = 'Abrir PDF'; }
  }
}

// ================================================================
//  ASSINATURAS CADASTRADAS (Direção)
// ================================================================
export function renderAssinaturas(tela) {
  if (!assinantes) {
    tela.innerHTML = '<p class="pa-vazio">Carregando as assinaturas...</p>';
    A.apiFetch('/plano-acao/documentos/assinantes').then(r => { assinantes = r; A.render(); }).catch(err => { tela.innerHTML = `<div class="pa-card pa-erro">${e(err.message)}</div>`; });
    return;
  }
  const ordem = [...assinantes].sort((a, b) => (b.diretor - a.diretor) || a.nome.localeCompare(b.nome, 'pt-BR'));
  const faltam = ordem.filter(a => !a.url).length;
  tela.innerHTML = `
    <section class="pa-card pd-topo">
      <div><h3 class="pa-card-titulo">Assinaturas digitalizadas</h3>
        <p class="pa-mudo">Imagem só do rabisco (PNG com fundo transparente fica melhor). Nome e cargo são escritos embaixo pelo Órbita, como no SIGMA. ${faltam ? `<b class="pd-falta">${faltam} sem imagem</b> — o documento sai com nome, cargo e "assinatura eletrônica".` : ''}</p></div>
    </section>
    <div class="pd-ass-grade">${ordem.map(a => `
      <article class="pa-card pd-ass-card${a.url ? '' : ' falta'}">
        <div class="pd-ass-prev">${a.url ? `<img src="${e(a.url)}" alt="Assinatura de ${e(a.nome)}">` : '<span>sem imagem</span>'}</div>
        <div class="pd-ass-linha"></div>
        <strong>${e((a.nome || '').toUpperCase())}</strong>
        <span class="pa-mudo">${e(a.cargo || 'cargo não cadastrado')}</span>
        ${a.diretor ? '<span class="pa-tag pa-tag-dir">assina todos os documentos</span>' : ''}
        <button type="button" class="btn-secondary" data-pd-ass="${e(a.uid)}">${a.url ? 'Editar' : 'Cadastrar assinatura'}</button>
      </article>`).join('')}</div>`;
}

function editarAssinante(uid) {
  const a = assinantes.find(x => x.uid === uid);
  A.abrirModal('Assinatura', `
    <label class="pa-campo">Nome como sai no documento<input type="text" id="pd-s-nome" maxlength="120" value="${e(a.nome || '')}"></label>
    <label class="pa-campo">Cargo<input type="text" id="pd-s-cargo" maxlength="160" value="${e(a.cargo || '')}" placeholder="Ex.: Coordenação de Enfermagem"></label>
    <label class="pa-campo">Imagem da assinatura (PNG ou JPG, até 1 MB)<input type="file" id="pd-s-img" accept="image/png,image/jpeg"></label>
    <p class="pa-mudo">Recorte só o rabisco, sem a linha e sem o nome impresso.</p>`,
  async () => {
    const f = $('pd-s-img').files[0];
    let imagem = null;
    if (f) imagem = await new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = erro; r.readAsDataURL(f); });
    try {
      const r = await A.apiFetch(`/plano-acao/documentos/assinantes/${encodeURIComponent(uid)}`, { method: 'PUT', body: JSON.stringify({ nome: $('pd-s-nome').value, cargo: $('pd-s-cargo').value, imagem }) });
      Object.assign(a, { nome: r.nome, cargo: r.cargo, url: r.url || a.url });
      A.fecharModal();
      A.render();
      A.toast('Assinatura salva.');
    } catch (err) { A.toast(err.message, 'erro'); }
  });
}

// ================================================================
//  CLIQUES (chamado pelo app.js)
// ================================================================
export function tratarClique(t) {
  if (t.dataset.pdAbrir) { abrir(t.dataset.pdAbrir).catch(err => A.toast(err.message, 'erro')); return true; }
  if (t.dataset.pdFiltro !== undefined) { filtroStatus = t.dataset.pdFiltro; A.render(); return true; }
  if (t.dataset.pdCurso !== undefined) return true; // <select>: tratado no "change" (ligarFiltroCurso)
  if (t.dataset.pdAss) { editarAssinante(t.dataset.pdAss); return true; }
  const acao = t.dataset.pd;
  if (!acao) return false;
  if (acao === 'novo') novoDocumento().catch(err => A.toast(err.message, 'erro'));
  else if (acao === 'voltar') { if (editando && !confirm('Sair sem salvar as alterações?')) return true; aberto = null; editando = false; A.render(); }
  else if (acao === 'editar') { editando = true; A.render(); }
  else if (acao === 'salvar') salvar().then(() => { editando = false; A.render(); }).catch(err => A.toast(err.message, 'erro'));
  else if (acao === 'enviar') enviar();
  else if (acao === 'assinar') assinar();
  else if (acao === 'assinar-senha') { const v = $('pd-a-senha').value; if (!v) A.toast('Digite a sua senha.', 'erro'); else assinar(v); }
  else if (acao === 'devolver') devolver();
  else if (acao === 'excluir') excluir();
  else if (acao === 'pdf') abrirPdf();
  return true;
}
