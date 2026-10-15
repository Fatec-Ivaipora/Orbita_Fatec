import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';
import { montarPdfProfessor, disciplinasPorProfessor } from './pdf-professor.js?v=1';
import { montarRelatorioDirecao } from './relatorio-direcao.js?v=1';

// ==========================================================================
// Relatório CPA — substitui em 2026-10-14 o módulo anterior (a diretoria não
// aprovou aquela versão; aprovou, em vez dela, o app "cpa-fatec" que o
// usuário construiu por conta própria). Esta tela é esse app reimplantado
// aqui dentro, com o login/RBAC do Órbita — mesma lógica de relatório,
// mesmo critério de classificação de comentário.
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'cpa';
const NIVEL_PADRAO = { adm_l2: 3, coordenador: 2, coord_medicina: 2 };

let currentUser = null, appInitialized = false, initializedRole = null, souAdmin = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

async function apiFetch(endpoint) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try { return await apiFetch(endpoint); } catch (err) { if (i === tentativas) throw err; await new Promise(r => setTimeout(r, 600)); }
  }
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('toast'); t.textContent = msg; t.className = `cpa-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- AUTH ----------
const cached = getCachedAuth();
if (cached) { currentUser = cached.user; initApp(cached.user, cached.role); }

onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); window.location.href = '../auth/login.html'; return; }
  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante', meuOverrides = null;
    try {
      const u = await apiFetchComRetentativa('/usuarios/me');
      role = u.role || 'visitante'; meuOverrides = u.permissoes || null;
    } catch (e) { role = cached ? cached.role : 'visitante'; }
    setCachedAuth(user, role, token);
    let level = 1;
    if (role === 'adm_l1') level = 3;
    else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        const doCargo = perms[role] || {};
        const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
      } catch (e) { level = NIVEL_PADRAO[role] || 1; }
    }
    if (level < 2) { window.location.href = '../meu-espaco/index.html'; return; }
    if (!appInitialized || initializedRole !== role) { initializedRole = role; initApp(user, role); }
  } catch (err) { console.error('Erro na revalidação de auth:', err); }
});

function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true; initializedRole = role;
  souAdmin = role === 'adm_l1' || role === 'adm_l2';
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); window.location.href = '../auth/login.html'; });
  $('app').classList.remove('hidden');
  if (!souAdmin) { $('aba-administrativo').remove(); $('aba-docentes').remove(); }
  if (!souAdmin) { $('alu-pdf-disciplinas').remove(); $('alu-pdf-direcao').remove(); }
  wireAbas();
  montarAba({ prefixo: 'part', tipo: 'A', carregar: carregarParticipacao });
  montarAba({ prefixo: 'alu', tipo: 'A', temCurso: true, carregar: carregarRelatorioAluno });
  if (souAdmin) montarAba({ prefixo: 'doc', tipo: 'P', temCurso: true, cursoOpcional: true, filtrarCursosPorCampanha: false, carregar: carregarRelatorioStaff('P') });
  if (souAdmin) montarAba({ prefixo: 'adm', tipo: 'O', carregar: carregarRelatorioStaff('O') });
  wireModal();
}

// ---------- ABAS ----------
function wireAbas() {
  document.querySelectorAll('.cpa-aba').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.cpa-aba').forEach(x => x.classList.toggle('ativa', x === b));
      document.querySelectorAll('.cpa-painel').forEach(p => p.classList.toggle('ativo', p.id === `painel-${b.dataset.aba}`));
    });
  });
}

// Fábrica genérica: cada aba tem select de campanha (filtrado por `tipo`) e,
// opcionalmente, select de curso (preenchido já escopado pelo backend —
// coordenador só vê os próprios cursos). `cursoOpcional` libera "Todos os
// professores (institucional)", só pra quem vê tudo (adm_l1/adm_l2).
function montarAba({ prefixo, tipo, temCurso, cursoOpcional, filtrarCursosPorCampanha = true, carregar }) {
  const selCampanha = $(`${prefixo}-campanha`);
  const selCurso = temCurso ? $(`${prefixo}-curso`) : null;
  const btnPdfDisciplinas = $(`${prefixo}-pdf-disciplinas`);
  // Relatório da Direção: só precisa da campanha (é a campanha inteira, todos os cursos)
  const btnDirecao = $(`${prefixo}-pdf-direcao`);

  async function onCampanhaMudou() {
    const codava = selCampanha.value;
    if (btnPdfDisciplinas) btnPdfDisciplinas.disabled = true;
    if (btnDirecao) btnDirecao.disabled = !codava;
    if (!temCurso) {
      if (!codava) { mostrarVazio(prefixo, 'Escolha uma campanha pra ver o relatório.'); return; }
      await carregar(prefixo, { codava });
      return;
    }
    selCurso.innerHTML = '<option value="">Selecione o curso…</option>';
    selCurso.disabled = true;
    mostrarVazio(prefixo, 'Escolha uma campanha e um curso pra ver o relatório.');
    if (!codava) return;
    try {
      const q = filtrarCursosPorCampanha ? `?codava=${encodeURIComponent(codava)}` : '';
      const { cursos } = await apiFetch(`/cpa/cursos${q}`);
      let opcoes = cursos.map(c => `<option value="${esc(c.codcur)}">${esc(c.nome)}</option>`).join('');
      if (cursoOpcional) opcoes = `<option value="">Todos os professores (institucional)</option>` + opcoes;
      selCurso.innerHTML = '<option value="">Selecione o curso…</option>' + opcoes;
      selCurso.disabled = false;
      if (cursos.length === 0 && !cursoOpcional) toast('Nenhuma resposta encontrada pra essa campanha ainda.', 'erro');
    } catch (err) {
      toast('Erro ao carregar cursos: ' + err.message, 'erro');
    }
  }

  selCampanha.addEventListener('change', onCampanhaMudou);
  if (selCurso) {
    selCurso.addEventListener('change', async () => {
      const codava = selCampanha.value, curso = selCurso.value;
      if (!codava || (!curso && !cursoOpcional)) { mostrarVazio(prefixo, 'Escolha uma campanha e um curso pra ver o relatório.'); return; }
      try {
        await carregar(prefixo, { codava, curso });
        if (btnPdfDisciplinas) btnPdfDisciplinas.disabled = false;
      } catch (err) {
        toast('Erro ao gerar relatório: ' + err.message, 'erro');
      }
    });
  }
  if (btnDirecao) btnDirecao.addEventListener('click', () => gerarRelatorioDirecao(tipo, selCampanha.value, btnDirecao));
  if (btnPdfDisciplinas) btnPdfDisciplinas.addEventListener('click', () => {
    const nomeCurso = selCurso.selectedOptions[0]?.textContent || selCurso.value;
    gerarPdfsPorProfessor(prefixo, nomeCurso, btnPdfDisciplinas);
  });

  apiFetch(`/cpa/campanhas?tipo=${tipo}`).then(({ campanhas }) => {
    selCampanha.innerHTML = '<option value="">Selecione a campanha…</option>' +
      campanhas.map(c => `<option value="${c.codava}">${esc(c.descricao)} (${esc(c.semava)})</option>`).join('');
  }).catch(err => toast(`Erro ao carregar campanhas: ${err.message}`, 'erro'));
}

function mostrarVazio(prefixo, msg) {
  $(`${prefixo}-conteudo`).innerHTML = `<p class="cpa-vazio">${esc(msg)}</p>`;
  const kpis = $(`${prefixo}-resumo`); if (kpis) kpis.classList.add('hidden');
}

// ---------- CARREGAMENTO ----------
async function carregarParticipacao(prefixo, { codava }) {
  try {
    const dados = await apiFetch(`/cpa/participacao?codava=${encodeURIComponent(codava)}`);
    renderParticipacao(dados, codava);
  } catch (err) {
    mostrarVazio(prefixo, `Não foi possível carregar: ${esc(err.message)}`);
  }
}
async function carregarRelatorioAluno(prefixo, { codava, curso }) {
  const dados = await apiFetch(`/cpa/relatorio-aluno?codava=${encodeURIComponent(codava)}&curso=${encodeURIComponent(curso)}`);
  renderRelatorio(prefixo, dados, { comDisciplinas: true });
}
function carregarRelatorioStaff(tipo) {
  return async (prefixo, { codava, curso }) => {
    const q = `codava=${encodeURIComponent(codava)}&tipo=${tipo}${curso ? `&curso=${encodeURIComponent(curso)}` : ''}`;
    const dados = await apiFetch(`/cpa/relatorio-staff?${q}`);
    renderRelatorio(prefixo, dados, { comDisciplinas: false });
  };
}

// ---------- RENDER: PARTICIPAÇÃO ----------
function corPorPercentual(p) {
  if (p >= 60) return 'var(--orb-bom)';
  if (p >= 30) return 'var(--orb-alerta)';
  return 'var(--orb-crit)';
}
const fmtPct = (p) => `${String(p).replace('.', ',')}%`;

function renderParticipacao(dados, codava) {
  const resumo = $('part-resumo');
  if (!dados.cursos.length) {
    resumo.classList.add('hidden');
    mostrarVazio('part', 'Nenhum curso com matrícula ativa encontrado.');
    return;
  }
  const total = dados.cursos.reduce((s, c) => s + c.totalMatriculados, 0);
  const concluiram = dados.cursos.reduce((s, c) => s + c.respondentes, 0);
  const pct = total ? Math.round((concluiram / total) * 1000) / 10 : 0;
  resumo.classList.remove('hidden');
  resumo.innerHTML = `
    <div class="cpa-kpi"><b style="color:${corPorPercentual(pct)}">${fmtPct(pct)}</b><span>de participação geral</span></div>
    <div class="cpa-kpi"><b>${concluiram}</b><span>de ${total} alunos concluíram</span></div>
    <div class="cpa-kpi"><b>${dados.cursos.length}</b><span>${dados.cursos.length === 1 ? 'curso' : 'cursos'} com matrícula ativa</span></div>`;

  $('part-conteudo').innerHTML = dados.cursos.map((c, i) => `
    <div class="cpa-curso-card">
      <button type="button" class="cpa-curso-card-cab" data-idx="${i}" aria-expanded="false">
        <div class="cpa-curso-card-info">
          <b>${esc(c.nome)}</b>
          <span class="cpa-meta">${c.respondentes} de ${c.totalMatriculados} concluíram${c.iniciaram !== c.respondentes ? ` · ${c.iniciaram} iniciaram` : ''}</span>
        </div>
        <div class="cpa-barra" style="flex:1;max-width:160px"><i style="width:${Math.min(100, c.percentual)}%;background:${corPorPercentual(c.percentual)}"></i></div>
        <b style="color:${corPorPercentual(c.percentual)};min-width:3.2rem;text-align:right">${fmtPct(c.percentual)}</b>
        <span class="cpa-curso-card-seta">▾</span>
      </button>
      <div class="cpa-curso-card-turmas hidden" id="part-turmas-${i}">
        ${c.turmas.length ? `<div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th>Turma</th><th class="num">Iniciou</th><th class="num">Concluiu</th><th class="num">Total</th><th class="num">%</th></tr></thead><tbody>
          ${c.turmas.map(t => `<tr><td>${esc(t.nome)}</td><td class="num">${t.iniciou}</td><td class="num">${t.concluiu}</td><td class="num">${t.total}</td><td class="num" style="color:${corPorPercentual(t.percentual)}">${fmtPct(t.percentual)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="cpa-meta">Nenhuma turma encontrada.</p>'}
        <div style="margin-top:0.8rem">
          <button type="button" class="cpa-btn cpa-btn-sec cpa-btn-mini cpa-no-print" data-pdf-participacao="${esc(c.codcur)}" data-nome="${esc(c.nome)}">Gerar PDF (quem já respondeu / falta responder)</button>
        </div>
      </div>
    </div>`).join('');

  $('part-conteudo').querySelectorAll('.cpa-curso-card-cab').forEach(btn => {
    btn.addEventListener('click', () => {
      const painel = $(`part-turmas-${btn.dataset.idx}`);
      const abrindo = painel.classList.contains('hidden');
      painel.classList.toggle('hidden', !abrindo);
      btn.setAttribute('aria-expanded', String(abrindo));
    });
  });
  $('part-conteudo').querySelectorAll('[data-pdf-participacao]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      gerarPdfsPorTurma(codava, btn.dataset.pdfParticipacao, btn.dataset.nome, btn);
    });
  });
}

const nomeArquivo = (t) => String(t).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

function folhaParticipacaoHtml(nomeCurso, turma, alunos) {
  const responderam = alunos.filter(a => a.concluiu).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const faltam = alunos.filter(a => !a.concluiu).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const lista = (titulo, itens) => `
    <h3>${esc(titulo)} <span class="cpa-meta">(${itens.length})</span></h3>
    ${itens.length ? `<div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th class="num" style="width:3rem">#</th><th>Aluno</th></tr></thead><tbody>
      ${itens.map((a, i) => `<tr><td class="num">${i + 1}</td><td>${esc(a.nome)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="cpa-meta">Ninguém nessa situação.</p>'}`;
  return `<div class="cpa-folha">
    <div class="cpa-cab"><img src="/img/fateclogoazul.png" alt="FATEC Ivaiporã"><div><h2>Participação CPA — ${esc(nomeCurso)}</h2><p>${esc(turma)} · FATEC Ivaiporã</p></div></div>
    <p class="cpa-meta" style="margin-bottom:1rem">Emitido em ${esc(new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }))}</p>
    ${lista('Já responderam', responderam)}
    ${lista('Ainda não responderam', faltam)}
  </div>`;
}

// Gera um PDF por item (turma, disciplina, ...) e baixa tudo junto num .zip —
// mesma técnica usada no PDF de professores do antigo módulo CPA.
async function gerarZipDePdfs({ itens, nomeDoItem, montarHtml, montarExtra, nomeZip, btn }) {
  if (!window.html2pdf || !window.JSZip) { toast('Não foi possível carregar o gerador de PDF. Verifique a conexão e tente de novo.', 'erro'); return; }
  if (!itens.length) { toast('Nada pra gerar.', 'erro'); return; }
  const rotuloOriginal = btn.textContent;
  btn.disabled = true;
  const palco = document.createElement('div');
  palco.className = 'cpa-palco-pdf';
  palco.style.cssText = 'width:794px;background:#fff;';
  const fora = document.createElement('div');
  fora.style.cssText = 'position:fixed;left:-10000px;top:0;';
  fora.appendChild(palco); document.body.appendChild(fora);
  try {
    const zip = new window.JSZip();
    const usados = new Set();
    for (let i = 0; i < itens.length; i++) {
      btn.textContent = `Gerando ${i + 1} de ${itens.length}…`;
      palco.innerHTML = montarHtml(itens[i]);
      const limpar = montarExtra ? montarExtra(itens[i]) : null;
      const blob = await window.html2pdf().from(palco).set({
        margin: [10, 8, 12, 8], image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale: 1.4, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        // 'avoid-all' marca TODO elemento com page-break-inside:avoid — mais
        // "bruto" que listar seletores à mão, mas garante que nada (barra,
        // comentário grande, o que for) fica cortado na borda da página,
        // ao custo de eventualmente deixar um espaço em branco maior no
        // rodapé de alguma página.
        pagebreak: { mode: 'avoid-all' },
      }).outputPdf('blob');
      if (limpar) limpar();
      let nome = nomeArquivo(nomeDoItem(itens[i]));
      let k = 2; while (usados.has(nome.toLowerCase())) nome = nomeArquivo(`${nomeDoItem(itens[i])} (${k++})`);
      usados.add(nome.toLowerCase());
      zip.file(`${nome}.pdf`, blob);
    }
    btn.textContent = 'Compactando…';
    const out = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = nomeArquivo(nomeZip) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    toast(`${itens.length} PDF(s) gerado(s).`);
  } catch (err) {
    toast('Erro ao gerar PDF: ' + err.message, 'erro');
  } finally {
    fora.remove();
    btn.disabled = false; btn.textContent = rotuloOriginal;
  }
}

async function gerarPdfsPorTurma(codava, curso, nomeCurso, btn) {
  btn.textContent = 'Buscando lista…';
  let alunos;
  try {
    ({ alunos } = await apiFetch(`/cpa/participacao-detalhe?codava=${encodeURIComponent(codava)}&curso=${encodeURIComponent(curso)}`));
  } catch (err) { toast('Erro ao buscar participação: ' + err.message, 'erro'); return; }
  const porTurma = new Map();
  alunos.forEach(a => { if (!porTurma.has(a.turma)) porTurma.set(a.turma, []); porTurma.get(a.turma).push(a); });
  const turmas = [...porTurma.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  await gerarZipDePdfs({
    itens: turmas,
    nomeDoItem: (turma) => turma,
    montarHtml: (turma) => folhaParticipacaoHtml(nomeCurso, turma, porTurma.get(turma)),
    nomeZip: `Participação CPA - ${nomeCurso}`,
    btn,
  });
}

// Relatório dos professores: um PDF por professor com todas as disciplinas
// dele no curso (antes era um por disciplina — 46 arquivos em Agronomia).
// PDF vetorial montado direto com o jsPDF (cpa/pdf-professor.js): sai em
// segundos, pesa poucos KB e não corta pergunta nem comentário.
let logoPdf = null;
async function carregarLogoPdf() {
  if (logoPdf) return logoPdf;
  const blob = await (await fetch('/img/fateclogoazul.png')).blob();
  const dataUrl = await new Promise((ok, erro) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = erro; r.readAsDataURL(blob); });
  const img = await new Promise((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = erro; i.src = dataUrl; });
  logoPdf = { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
  return logoPdf;
}

// Relatório da Direção: visão executiva da campanha inteira (alunos = todos os
// cursos juntos; docentes; administrativo). PDF montado em cpa/relatorio-direcao.js.
async function gerarRelatorioDirecao(tipo, codava, btn) {
  if (!codava) return;
  if (!window.jspdf) { toast('Não foi possível carregar o gerador de PDF. Verifique a conexão e tente de novo.', 'erro'); return; }
  const rotuloOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = 'Buscando dados…';
  try {
    const dados = await apiFetch(`/cpa/relatorio-direcao?codava=${encodeURIComponent(codava)}&tipo=${tipo}`);
    if (!dados.dimensoes.length) { toast('Nenhuma resposta encontrada nessa campanha ainda.', 'erro'); return; }
    btn.textContent = 'Montando o PDF…';
    await new Promise(r => setTimeout(r)); // deixa o botão atualizar antes da análise dos comentários
    const logo = await carregarLogoPdf().catch(() => null);
    const doc = montarRelatorioDirecao(window.jspdf.jsPDF, { dados, tipo, logo });
    doc.save(nomeArquivo(`Relatório da Direção CPA - ${dados.avaliacao.descricao}`) + '.pdf');
    toast('Relatório da Direção gerado.');
  } catch (err) {
    toast('Erro ao gerar o Relatório da Direção: ' + err.message, 'erro');
  } finally {
    btn.disabled = false; btn.textContent = rotuloOriginal;
  }
}

async function gerarPdfsPorProfessor(prefixo, nomeCurso, btn) {
  if (!window.jspdf || !window.JSZip) { toast('Não foi possível carregar o gerador de PDF. Verifique a conexão e tente de novo.', 'erro'); return; }
  const grupos = disciplinasPorProfessor(dimensoesPorAba.get(prefixo) || []);
  if (!grupos.length) { toast('Nada pra gerar.', 'erro'); return; }
  const rotuloOriginal = btn.textContent;
  btn.disabled = true;
  try {
    const logo = await carregarLogoPdf().catch(() => null);
    const campanha = campanhaPorAba.get(prefixo) || '';
    const zip = new window.JSZip();
    const usados = new Set();
    for (let i = 0; i < grupos.length; i++) {
      btn.textContent = `Gerando ${i + 1} de ${grupos.length}…`;
      const { professor, disciplinas } = grupos[i];
      const doc = montarPdfProfessor(window.jspdf.jsPDF, { professor, nomeCurso, campanha, disciplinas, logo });
      let nome = nomeArquivo(professor);
      let k = 2; while (usados.has(nome.toLowerCase())) nome = nomeArquivo(`${professor} (${k++})`);
      usados.add(nome.toLowerCase());
      zip.file(`${nome}.pdf`, doc.output('arraybuffer'));
      await new Promise(r => setTimeout(r)); // deixa o botão atualizar o contador
    }
    btn.textContent = 'Compactando…';
    const out = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = nomeArquivo(`CPA por professor - ${nomeCurso}`) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`${grupos.length} PDF(s) gerado(s), um por professor.`);
  } catch (err) {
    toast('Erro ao gerar PDF: ' + err.message, 'erro');
  } finally {
    btn.disabled = false; btn.textContent = rotuloOriginal;
  }
}

// ---------- RENDER: RELATÓRIO (Alunos / Docentes / Administrativo) ----------
const CLASSES = { bom: { label: 'Bons', cor: '#0f7a4b' }, neutro: { label: 'Neutros', cor: '#a8650b' }, atencao: { label: 'Atenção', cor: '#c8392f' } };
const chartsPorAba = new Map();   // prefixo -> Map(idx -> Chart)
const dimensoesPorAba = new Map(); // prefixo -> array de dimensões (pra abrir modal de comentário)
const campanhaPorAba = new Map();  // prefixo -> nome da campanha (vai no PDF dos professores)

function contarPorClasse(comentarios) {
  return comentarios.reduce((acc, c) => { acc[c.classificacao] = (acc[c.classificacao] || 0) + 1; return acc; }, {});
}
function alturaGrafico(n) { return Math.max(160, n * 40); }
function valorExibido(p) {
  if (p.media === null) return null;
  const max = p.opcoes.length || 5;
  return p.escalaInvertida ? (max + 1 - p.media) : p.media;
}
function positividade(p) {
  const max = p.opcoes.length || 5;
  if (p.media === null) return 0.5;
  const norm = (p.media - 1) / (max - 1 || 1);
  return p.escalaInvertida ? (1 - norm) : norm;
}
function corPorPositividade(p) { if (p >= 0.66) return '#0f7a4b'; if (p >= 0.4) return '#a8650b'; return '#c8392f'; }
function truncar(t, max) { const s = String(t || ''); return s.length > max ? s.slice(0, max - 1).trim() + '…' : s; }
// o Edubox guarda a pergunta em MAIÚSCULAS — mostra em frase (só a primeira letra maiúscula)
const frase = (s) => String(s || '').toLowerCase().replace(/(^\s*[a-zà-ú])/, m => m.toUpperCase());

function renderRelatorio(prefixo, dados, { comDisciplinas }) {
  const dimensoes = dados.dimensoes.filter(d => d.totalAvaliacoes > 0);
  dimensoesPorAba.set(prefixo, dimensoes);
  campanhaPorAba.set(prefixo, dados.avaliacao.descricao);
  (chartsPorAba.get(prefixo) || new Map()).forEach(c => c && c.destroy());
  chartsPorAba.set(prefixo, new Map());

  if (!dimensoes.length) {
    mostrarVazio(prefixo, 'Nenhuma resposta encontrada pra esse recorte, nessa campanha.');
    return;
  }

  const container = $(`${prefixo}-conteudo`);
  container.innerHTML = `<div class="cpa-rel-cab"><h2>${esc(dados.avaliacao.descricao)}</h2><span class="cpa-meta">Emitido em ${esc(new Date().toLocaleString('pt-BR'))}</span></div>` +
    dimensoes.map((dim, idx) => {
      const nota = dim.mediaGeral !== null ? dim.mediaGeral.toFixed(1) + '/10' : '—';
      const canvasId = `${prefixo}-chart-${idx}`;
      const contagem = contarPorClasse(dim.comentarios);
      return `<div class="cpa-folha cpa-dimensao-card">
        <div class="cpa-dimensao-header">
          <h3 style="margin:0">${esc(dim.nome)}</h3>
          <span class="cpa-meta">Nota geral: <b>${nota}</b> (${dim.totalAvaliacoes} avaliações)</span>
        </div>
        ${comDisciplinas && dim.disciplinas.length ? '<p class="cpa-meta">Média de todas as disciplinas desta categoria — veja o detalhamento por disciplina abaixo.</p>' : ''}
        <div class="cpa-no-print" style="height:${alturaGrafico(dim.perguntas.length)}px"><canvas id="${canvasId}"></canvas></div>
        <img class="cpa-only-print" id="${canvasId}-img" style="width:100%" alt="">
        <div class="cpa-chips" style="margin-top:0.6rem">
          ${Object.entries(CLASSES).map(([k, v]) => `<span class="cpa-chip ${k}">${contagem[k] || 0} ${v.label.toLowerCase()}</span>`).join('')}
          ${dim.comentarios.length ? `<button type="button" class="cpa-btn cpa-btn-sec cpa-btn-mini cpa-no-print" data-ver-comentarios="${idx}">Ver comentários (${dim.comentarios.length})</button>` : ''}
        </div>
        ${comDisciplinas && dim.disciplinas.length ? `
          <h4>Por disciplina (${dim.disciplinas.length})</h4>
          <div class="cpa-tabela-wrap"><table class="cpa-tabela"><thead><tr><th>Disciplina / Professor</th><th class="num">Nota</th><th class="num">Avaliações</th><th></th></tr></thead><tbody>
            ${dim.disciplinas.map((d, di) => `<tr><td>${esc(d.disciplina)}${d.professores && d.professores.length ? `<br><span class="cpa-meta">${esc(d.professores.join(', '))}</span>` : ''}</td><td class="num">${d.mediaGeral !== null ? d.mediaGeral.toFixed(1) + '/10' : '—'}</td><td class="num">${d.totalAvaliacoes}</td><td class="num">${d.comentarios.length ? `<button type="button" class="cpa-btn cpa-btn-sec cpa-btn-mini cpa-no-print" data-ver-disciplina="${idx}|${di}">Comentários (${d.comentarios.length})</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
      </div>`;
    }).join('');

  dimensoes.forEach((dim, idx) => {
    if (dim.perguntas.length) chartsPorAba.get(prefixo).set(idx, criarGrafico(`${prefixo}-chart-${idx}`, dim.perguntas));
  });
  container.querySelectorAll('[data-ver-comentarios]').forEach(btn => btn.addEventListener('click', () => abrirModalComentarios(dimensoesPorAba.get(prefixo)[Number(btn.dataset.verComentarios)])));
  container.querySelectorAll('[data-ver-disciplina]').forEach(btn => {
    const [idx, di] = btn.dataset.verDisciplina.split('|').map(Number);
    btn.addEventListener('click', () => abrirModalComentarios(dimensoesPorAba.get(prefixo)[idx].disciplinas[di], true));
  });
}

function criarGrafico(canvasId, perguntas) {
  const labels = perguntas.map(p => truncar(frase(p.pergunta), 60));
  const valores = perguntas.map(valorExibido);
  const cores = perguntas.map(p => corPorPositividade(positividade(p)));
  const escalaMax = Math.max(5, ...perguntas.map(p => p.opcoes.length || 5));
  return new Chart($(canvasId), {
    type: 'bar',
    data: { labels, datasets: [{ data: valores, backgroundColor: cores, borderRadius: 6, barThickness: 20 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { min: 0, max: escalaMax, ticks: { stepSize: 1 } }, y: { ticks: { autoSkip: false } } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => frase(perguntas[items[0].dataIndex].pergunta),
            label: (item) => {
              const p = perguntas[item.dataIndex];
              const exibido = valorExibido(p);
              const opcaoMaisProxima = p.opcoes[Math.max(0, Math.min(p.opcoes.length - 1, Math.round(p.media) - 1))];
              const linhas = [`Qualidade: ${exibido === null ? '—' : exibido.toFixed(2)} de 5 — ${p.respostas} respostas`, `Resposta mais comum: "${opcaoMaisProxima || ''}"`];
              if (p.escalaInvertida) linhas.push(`(escala original invertida — nota real do Edubox: ${p.media} de ${p.opcoes.length || 5})`);
              return linhas;
            },
          },
        },
      },
    },
  });
}

// ---------- MODAL DE COMENTÁRIOS ----------
let modalComentarios = [], modalFiltro = 'todos';
function abrirModalComentarios(origem, ehDisciplina) {
  modalFiltro = 'todos';
  modalComentarios = origem.comentarios;
  $('mc-titulo').textContent = `Comentários — ${origem.nome || origem.disciplina}`;
  renderTabsModal(); renderListaModal();
  $('modal-comentarios').classList.remove('hidden');
}
function renderTabsModal() {
  const contagem = contarPorClasse(modalComentarios);
  const opcoes = [{ key: 'todos', label: 'Todos', n: modalComentarios.length }, ...Object.entries(CLASSES).map(([k, v]) => ({ key: k, label: v.label, n: contagem[k] || 0 }))];
  $('mc-tabs').innerHTML = opcoes.map(o => `<button type="button" class="cpa-btn ${o.key === modalFiltro ? 'cpa-btn-pri' : 'cpa-btn-sec'} cpa-btn-mini" data-filtro="${o.key}">${o.label} (${o.n})</button>`).join('');
  $('mc-tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { modalFiltro = b.dataset.filtro; renderTabsModal(); renderListaModal(); }));
}
function renderListaModal() {
  const lista = modalFiltro === 'todos' ? modalComentarios : modalComentarios.filter(c => c.classificacao === modalFiltro);
  $('mc-lista').innerHTML = lista.length
    ? lista.map(c => `<div class="cpa-coment ${c.classificacao}">${esc(c.texto)}</div>`).join('')
    : '<p class="cpa-meta">Nenhum comentário nessa categoria.</p>';
}
function wireModal() {
  $('mc-fechar').addEventListener('click', () => $('modal-comentarios').classList.add('hidden'));
  $('modal-comentarios').addEventListener('click', (e) => { if (e.target.id === 'modal-comentarios') $('modal-comentarios').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal-comentarios').classList.add('hidden'); });
}
