// Aplicação de Provas — IMPRESSÃO DA PROVA (24/11/2026)
// Para a secretaria acadêmica (Joyce): para cada prova, por sala, a lista da porta (aluno e nº do computador),
// a folha de login de cada aluno (login = RA, senha = "F" + CPF) e a ata de aplicação.
//   LAB12: computadores 1–60 · LAB20: 1–30 · NAPA: sala da prova (notebooks, sem número).
//   Os alunos do NAPA não entram nas listas dos laboratórios (fazem a prova separados).
//   A divisão da turma entre os laboratórios (ex.: da letra A até "Emily Silva" no LAB20, o resto no LAB12) fica salva.
// Alunos, RA e CPF vêm do Edubox na hora (relay) e não são gravados. A impressão é em preto e branco: nada depende de cor.
import { escapeHTML as esc } from '../../core/security.js';

const ROTULO_SALA = { LAB12: 'Laboratório 12', LAB20: 'Laboratório 20' };
const CAPACIDADE = { LAB12: 60, LAB20: 30 };
const CHAMADA = { b1: '1ª chamada · 1º bimestre', b2: '1ª chamada · 2º bimestre', sub: '2ª chamada', exame: 'Exame' };
// provas de adaptação e dependência (25/11/2026): os alunos são os que cursam a disciplina fora da turma dela
const ESPECIAIS = { ADP: 'Adaptação', DP: 'Dependência' };
const grupoEt = (et) => (et === 'b1' || et === 'b2' ? 'c1' : et);
// "1ª CHAMADA · 2º BIMESTRE", "2ª CHAMADA", "EXAME" — com "ADAPTAÇÃO" / "DEPENDÊNCIA" na frente quando for o caso
const tipoProva = (prova) => [ESPECIAIS[prova.turma], CHAMADA[prova.etapa]].filter(Boolean).join(' · ').toUpperCase();
const turmaTxt = (info) => (info.especial ? `${info.rotuloTurma} (${info.turma})` : `Turma ${info.turma} (${info.periodo}º período)`);
const PARTICULAS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
const toks = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w && !PARTICULAS.has(w));
// "Emily Silva" ⊂ "EMILY SILVA SANTOS": mesmo primeiro nome e os outros nomes digitados aparecem no nome completo
function casa(curto, completo) {
  const a = toks(curto), b = toks(completo);
  return !!a.length && a[0] === b[0] && a.slice(1).every(w => b.includes(w));
}
const dataBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const dois = (n) => String(n).padStart(2, '0');

export function criarImpressao({ api, toast, BASE, dadosAtuais, provasVisiveis }) {
  const cache = new Map(); // chave da prova → resposta do servidor (só na memória desta aba)
  const eduboxEscolhida = new Map(); // ADP/DP: disciplina do Edubox que a pessoa trocou na tela (por prova)
  let provaId = '';

  // turma regular: a turma toda; ADP/DP: quem cursa a disciplina da prova fora da turma dela
  const chave = (prova) => `${dadosAtuais().semestre}|${prova.turma}${ESPECIAIS[prova.turma] ? `|${prova.disciplina}|${eduboxEscolhida.get(prova.id) || ''}` : ''}`;
  async function alunosDa(prova) {
    const d = dadosAtuais();
    const k = chave(prova);
    if (!cache.has(k)) {
      const extra = ESPECIAIS[prova.turma] ? `&disciplina=${encodeURIComponent(prova.disciplina)}&edubox=${encodeURIComponent(eduboxEscolhida.get(prova.id) || '')}` : '';
      cache.set(k, await api(`${BASE}/impressao/alunos?semestre=${encodeURIComponent(d.semestre)}&turma=${encodeURIComponent(prova.turma)}${extra}`));
    }
    return cache.get(k);
  }

  // distribui a turma nas salas → { salas: [{ id, rotulo, alunos:[{...,pc}] }], napa: {...}, avisos: [] }
  function distribuir(info, prova) {
    const d = dadosAtuais();
    const avisos = [];
    const napaNomes = ((d.config.napaAlunos || {})[info.turma]) || [];
    const napaRa = new Set();
    const napaProblemas = []; // nome do NAPA que não achou um aluno só → a tela pede para escolher
    napaNomes.forEach((n, i) => {
      const ach = info.alunos.filter(a => casa(n, a.nome));
      if (ach.length === 1) { napaRa.add(ach[0].ra); return; }
      // parecidos: mesmo começo do primeiro nome (ISABELLI ~ ISABELLE / ISABELLY)
      const ini = (toks(n)[0] || '').slice(0, 4);
      const parecidos = ach.length ? ach : info.alunos.filter(a => ini && (toks(a.nome)[0] || '').startsWith(ini));
      napaProblemas.push({ i, nome: n, candidatos: parecidos.map(a => a.nome), ambiguo: ach.length > 1 });
    });
    const napaAlunos = info.alunos.filter(a => napaRa.has(a.ra));
    const resto = info.alunos.filter(a => !napaRa.has(a.ra));
    const s = info.especial ? { ...(info.salas || {}), modo: 'unica' } : (info.salas || { modo: 'unica', primeira: 'LAB12' });
    let partes;
    if (s.modo === 'dividida') {
      const alvos = info.alunos.filter(a => casa(s.ate, a.nome));
      if (alvos.length !== 1) {
        avisos.push(alvos.length ? `Divisão: "${s.ate}" bate com mais de um aluno. Escolha o aluno exato na divisão.` : `Divisão: "${s.ate}" não está na turma. Escolha de novo até qual aluno vai para o ${ROTULO_SALA[s.primeira]}.`);
        partes = [[s.primeira, resto]];
      } else {
        const limite = alvos[0].nome;
        partes = [[s.primeira, resto.filter(a => a.nome.localeCompare(limite, 'pt-BR') <= 0)], [s.segunda, resto.filter(a => a.nome.localeCompare(limite, 'pt-BR') > 0)]];
      }
    } else partes = [[s.primeira || 'LAB12', resto]];
    const salas = partes.filter(([, l]) => l.length).map(([id, l]) => {
      // a numeração começa no computador que a Joyce escolheu (padrão 1)
      const ini = Math.max(1, parseInt(((s.inicio || {})[id]), 10) || 1);
      const ult = ini + l.length - 1;
      if (ult > CAPACIDADE[id]) avisos.push(`${ROTULO_SALA[id]}: começando no computador ${ini}, os ${l.length} alunos vão até o ${ult}, mas o laboratório tem ${CAPACIDADE[id]}.`);
      return { id, rotulo: ROTULO_SALA[id], inicio: ini, alunos: l.map((a, i) => ({ ...a, pc: ini + i })) };
    });
    if (info.semCpf) avisos.push(`${info.semCpf} aluno(s) sem CPF no Edubox: a folha sai sem senha (procure a secretaria).`);
    const salaTxt = String((prova.napa && prova.napa.sala) || (d.config.napa && d.config.napa.sala) || '33').trim();
    const napaSala = /^\d+$/.test(salaTxt) ? `Sala ${salaTxt}` : salaTxt; // "33" → "Sala 33"
    const napa = napaAlunos.length ? { id: 'NAPA', rotulo: napaSala, alunos: napaAlunos, napa: true } : null;
    return { salas, napa, avisos, napaProblemas };
  }

  // ------------------------------------------------------------------ tela
  function opcoesProva() {
    const ps = provasVisiveis().slice().sort((a, b) => a.data.localeCompare(b.data) || a.turma.localeCompare(b.turma));
    if (!provaId || !ps.some(p => p.id === provaId)) {
      const hoje = new Date().toISOString().slice(0, 10);
      provaId = (ps.find(p => p.data >= hoje) || ps[0] || {}).id || '';
    }
    return ps;
  }

  async function render(alvo) {
    const ps = opcoesProva();
    if (!ps.length) { alvo.innerHTML = '<div class="ap-vazio">Nenhuma prova nesta etapa. Cadastre a prova primeiro.</div>'; return; }
    const prova = ps.find(p => p.id === provaId);
    alvo.innerHTML = `<div class="ap-imp">
      <div class="ap-imp-topo">
        <label class="ap-campo"><span>Prova</span><select id="ap-imp-prova">${ps.map(p => `<option value="${esc(p.id)}" ${p.id === provaId ? 'selected' : ''}>${dataBR(p.data)} · ${esc(p.turma)} · ${esc(p.disciplina)} · ${esc(tipoProva(p))}</option>`).join('')}</select></label>
      </div>
      <div class="ap-imp-tipo ap-et-${grupoEt(prova.etapa)}" role="note"><span>Tipo de prova:</span> <b>${esc(tipoProva(prova))}</b> <span>${esc(prova.disciplina)} · ${dataBR(prova.data)}</span></div>
      <div id="ap-imp-corpo"><div class="ap-vazio">Buscando ${ESPECIAIS[prova.turma] ? `os alunos em ${esc(ESPECIAIS[prova.turma].toLowerCase())} de ${esc(prova.disciplina)}` : `os alunos da ${esc(prova.turma)}`} no Edubox…</div></div>
      <p class="ap-nota">Login = RA do aluno; senha = F + CPF (padrão da Fatec). Os dados vêm do Edubox na hora e não ficam gravados no Órbita. Só a coordenação e a secretaria de Medicina veem esta aba.</p>
    </div>`;
    try {
      const info = await alunosDa(prova);
      if (provaId !== prova.id) return; // trocou de prova enquanto buscava: a outra chamada desenha
      renderCorpo(prova, info);
    } catch (e) {
      const c = document.getElementById('ap-imp-corpo');
      if (c && provaId === prova.id) c.innerHTML = `<div class="ap-vazio">${esc(e.message)}</div>`;
    }
  }

  function renderCorpo(prova, info) {
    const c = document.getElementById('ap-imp-corpo');
    if (!c) return;
    const dist = distribuir(info, prova);
    const s = info.especial ? { ...(info.salas || {}), modo: 'unica' } : (info.salas || {});
    const todas = [...dist.salas, ...(dist.napa ? [dist.napa] : [])];
    const atualiz = info.atualizadoEm ? new Date(info.atualizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const blocoEspecial = info.especial ? `
      <section class="ap-imp-div">
        <h3>${esc(info.rotuloTurma)}: quem cursa a disciplina fora da turma dela (Edubox)</h3>
        <div class="ap-imp-div-campos">
          <label class="ap-campo"><span>Disciplina no Edubox</span><select id="ap-imp-edubox"><option value="">— escolha —</option>${(info.opcoes || []).map(o => `<option value="${esc(o.nome)}" ${o.nome === info.disciplinaEdubox ? 'selected' : ''}>${esc(o.nome)} (${o.n} aluno${o.n === 1 ? '' : 's'})</option>`).join('')}</select></label>
          <p class="ap-nota">${info.disciplinaEdubox ? `A prova "${esc(prova.disciplina)}" foi ligada a esta disciplina do Edubox. Se não for a certa, troque aqui.` : `Não achei no Edubox ninguém em ${esc(info.rotuloTurma.toLowerCase())} de "${esc(prova.disciplina)}". Escolha a disciplina na lista (só aparecem as que têm aluno fora da turma).`}${atualiz ? ` Dados do Edubox de ${atualiz}.` : ''}</p>
        </div>
        ${info.alunos.length ? `<ol class="ap-imp-esp-lista">${info.alunos.map(a => `<li>${esc(a.nome)} <small>(${esc(a.turmaAluno || '')})</small></li>`).join('')}</ol>` : ''}
      </section>` : '';
    if (info.especial && !info.alunos.length) { c.innerHTML = blocoEspecial; return; }
    c.innerHTML = `${blocoEspecial}
      <section class="ap-imp-div">
        <h3>${info.especial ? `Sala da prova (${info.alunos.length} aluno${info.alunos.length === 1 ? '' : 's'})` : `Como a ${esc(info.turma)} (${info.periodo}º período · ${info.alunos.length} alunos no Edubox) fica nas salas`}</h3>
        <div class="ap-imp-div-campos">
          ${info.especial ? '' : `<label class="ap-check"><input type="radio" name="ap-imp-modo" value="unica" ${s.modo !== 'dividida' ? 'checked' : ''}> Uma sala só</label>
          <label class="ap-check"><input type="radio" name="ap-imp-modo" value="dividida" ${s.modo === 'dividida' ? 'checked' : ''}> Dividida em dois laboratórios</label>`}
          <label class="ap-campo"><span>${s.modo === 'dividida' ? 'Da letra A vai para o' : 'Sala'}</span><select id="ap-imp-primeira">${Object.keys(ROTULO_SALA).map(k => `<option value="${k}" ${(s.primeira || 'LAB12') === k ? 'selected' : ''}>${ROTULO_SALA[k]}</option>`).join('')}</select></label>
          ${s.modo === 'dividida' ? `<label class="ap-campo"><span>até o(a) aluno(a)</span><select id="ap-imp-ate">${info.alunos.map(a => `<option value="${esc(a.nome)}" ${casa(s.ate, a.nome) ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select></label>
            <p class="ap-nota">O resto da turma vai para o ${esc(ROTULO_SALA[(s.primeira || 'LAB12') === 'LAB12' ? 'LAB20' : 'LAB12'])}.</p>` : ''}
          <button type="button" class="ap-btn" id="ap-imp-salvar-div">Salvar divisão e numeração</button>        </div>
      </section>
      ${dist.napaProblemas.length ? `<section class="ap-imp-avisos" role="alert"><b>NAPA da ${esc(info.turma)}: confirme quem é cada aluno</b>
        <p class="ap-nota" style="margin:.2rem 0 .5rem">O NAPA está cadastrado só com o primeiro nome. Escolha o aluno certo: o nome completo fica salvo e ele sai da lista do laboratório. Enquanto não escolher, não imprima.</p>
        ${dist.napaProblemas.map(p => `<label class="ap-campo"><span>"${esc(p.nome)}"${p.ambiguo ? ' (mais de um aluno com esse nome)' : ' (não achei com essa grafia)'}</span>
          <select data-napa-i="${p.i}"><option value="">— escolha —</option>${(p.candidatos.length ? p.candidatos : info.alunos.map(a => a.nome)).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>`).join('')}
        <button type="button" class="ap-btn ap-btn-pri" id="ap-imp-salvar-napa">Salvar nomes do NAPA</button></section>` : ''}
      ${dist.avisos.length ? `<div class="ap-imp-avisos" role="alert"><b>Confira antes de imprimir:</b><ul>${dist.avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      <div class="ap-imp-salas">${todas.map(sl => `<article class="ap-imp-sala">
        <h4>${esc(sl.rotulo)}${sl.napa ? ' <small>(NAPA)</small>' : ''}</h4>
        <p><b>${sl.alunos.length}</b> aluno(s)${CAPACIDADE[sl.id] ? ` · computadores ${sl.inicio} a ${sl.inicio + sl.alunos.length - 1} (o laboratório tem ${CAPACIDADE[sl.id]})` : ' · notebooks, sem número'}</p>
        ${CAPACIDADE[sl.id] ? `<label class="ap-campo ap-imp-inicio"><span>Começar no computador nº</span><input type="number" min="1" max="${CAPACIDADE[sl.id]}" value="${sl.inicio}" data-inicio-sala="${sl.id}"></label>` : ''}
        <div class="ap-imp-botoes">
          <button type="button" class="ap-btn ap-btn-pri" data-imp="tudo:${sl.id}">Baixar tudo desta sala (PDF)</button>
          ${sl.napa ? '' : `<button type="button" class="ap-btn" data-imp="porta:${sl.id}">Lista da porta (PDF)</button>`}
          <button type="button" class="ap-btn" data-imp="logins:${sl.id}">Folhas de login (${sl.alunos.length}) (PDF)</button>
          <button type="button" class="ap-btn" data-imp="ata:${sl.id}">Ata (PDF)</button>
        </div>
        ${sl.napa ? '' : `<details><summary>Ver a lista</summary><ol class="ap-imp-lista" start="${sl.inicio || 1}">${sl.alunos.map(a => `<li>${esc(a.nome)}</li>`).join('')}</ol></details>`}
      </article>`).join('')}</div>
      <div class="ap-imp-geral"><button type="button" class="ap-btn ap-btn-pri" data-imp="tudo:*">Baixar tudo da prova em PDF (todas as salas)</button>
        <span class="ap-nota">Sai na ordem: para cada sala, a lista da porta, a ata e as folhas de login na ordem dos computadores.</span></div>
      <p class="ap-nota"><b>O PDF baixa no computador em folhas A4:</b> abra o arquivo e imprima por ele. Atenção: o PDF das folhas de login tem as senhas dos alunos; guarde só onde a secretaria tem acesso e apague depois da prova.</p>`;
  }

  // ------------------------------------------------------------------ PDF (A4 retrato, preto e branco) — 24/11/2026
  // O botão BAIXA o PDF; quem abre o arquivo imprime por ele. Desenhado com o jsPDF (texto e linhas, não imagem):
  // fica leve e nítido. Tem as cores da MED FATEC (azul royal), escuras o bastante para sair legível na impressora preto e branco.
  let jspdfPromessa = null;
  function carregarJsPDF() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    jspdfPromessa = jspdfPromessa || new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
      s.onload = () => ok(window.jspdf);
      s.onerror = () => { jspdfPromessa = null; falha(new Error('Não consegui carregar o gerador de PDF. Confira a internet e tente de novo.')); };
      document.head.appendChild(s);
    });
    return jspdfPromessa;
  }
  let logoPromessa = null;
  function logoMed() {
    logoPromessa = logoPromessa || new Promise((ok) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0);
        ok({ data: c.toDataURL('image/png'), prop: img.naturalWidth / img.naturalHeight });
      };
      img.onerror = () => ok(null);
      img.src = '/img/medfatec-logo.png';
    });
    return logoPromessa;
  }

  const M = 15, LARG = 210 - 2 * M; // margens de 15 mm
  const AZUL = [0, 82, 184], AZUL_CLARO = [230, 240, 251], PRETO = [0, 0, 0], BRANCO = [255, 255, 255];
  const cor = (doc, c) => doc.setTextColor(...c);
  // cabeçalho de tabela: fundo azul, letra branca
  const celTitulo = (doc, x, y, w, h) => { doc.setFillColor(...AZUL); doc.setDrawColor(...PRETO); doc.rect(x, y, w, h, 'FD'); };
  // texto que cabe na largura: diminui a fonte até caber (nomes longos)
  function caber(doc, txt, larg, tam, min = 7) {
    let t = tam;
    doc.setFontSize(t);
    while (t > min && doc.getTextWidth(txt) > larg) { t -= 0.5; doc.setFontSize(t); }
    return t;
  }
  // como caber(), e se nem na fonte mínima couber, corta o fim com "..." (devolve o texto que vai para a folha)
  function caberTxt(doc, txt, larg, tam, min = 7) {
    caber(doc, txt, larg, tam, min);
    let t = txt;
    while (t.length > 4 && doc.getTextWidth(t) > larg) t = `${t.slice(0, -4).trimEnd()}...`;
    return t;
  }
  function cabecalho(doc, logo) {
    let x = M;
    if (logo) { const h = 11; doc.addImage(logo.data, 'PNG', M, 11, h * logo.prop, h); x = M + h * logo.prop + 5; }
    cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('FATEC Ivaiporã', x, 15.5);
    cor(doc, PRETO); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Bacharelado em Medicina', x, 20);
    doc.setDrawColor(...AZUL); doc.setLineWidth(0.8); doc.line(M, 25, 210 - M, 25); doc.setDrawColor(...PRETO);
  }
  function linhaProvaTxt(prova, info) {
    return `${prova.disciplina} · ${turmaTxt(info)} · ${dataBR(prova.data)}${prova.horario ? ` · ${prova.horario.replace(':', 'h')}` : ''}`;
  }
  // faixa com o tipo da prova (1ª chamada / 2ª chamada / exame) — em todas as folhas, bem visível
  function faixaTipo(doc, prova, y) {
    const t = tipoProva(prova);
    const exame = prova.etapa === 'exame';
    doc.setLineWidth(0.6); doc.setDrawColor(...AZUL); doc.setFillColor(...(exame ? AZUL : AZUL_CLARO)); doc.rect(M, y, LARG, 9, 'FD'); doc.setDrawColor(...PRETO);
    cor(doc, exame ? BRANCO : AZUL); doc.setFont('helvetica', 'bold'); caber(doc, t, LARG - 6, 14); doc.text(t, 105, y + 6.4, { align: 'center' }); cor(doc, PRETO);
  }
  function pdfPorta(doc, logo, sl, prova, info) {
    cabecalho(doc, logo);
    cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.text(sl.rotulo.toUpperCase(), 105, 40, { align: 'center' });
    cor(doc, PRETO); doc.setFont('helvetica', 'normal'); caber(doc, linhaProvaTxt(prova, info), LARG, 10); doc.text(linhaProvaTxt(prova, info), 105, 47, { align: 'center' });
    faixaTipo(doc, prova, 50);
    const duas = sl.alunos.length > 30;
    const linhas = duas ? Math.ceil(sl.alunos.length / 2) : sl.alunos.length;
    const alt = duas ? 7 : Math.min(7.5, 205 / Math.max(linhas, 1));
    const colLarg = duas ? LARG / 2 : LARG, pcLarg = 11;
    let y = 62;
    doc.setLineWidth(0.3);
    const cel = (x, yy, aluno) => {
      doc.rect(x, yy, pcLarg, alt); doc.rect(x + pcLarg, yy, colLarg - pcLarg, alt);
      if (!aluno) return;
      cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(duas ? 10 : 11); doc.text(dois(aluno.pc), x + pcLarg / 2, yy + alt - 2.1, { align: 'center' });
      cor(doc, PRETO); doc.setFont('helvetica', 'normal'); doc.text(caberTxt(doc, aluno.nome, colLarg - pcLarg - 3, duas ? 9.5 : 11), x + pcLarg + 1.5, yy + alt - 2.1);
    };
    // cabeçalho da tabela
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    cor(doc, BRANCO);
    [0, ...(duas ? [colLarg] : [])].forEach(dx => { celTitulo(doc, M + dx, y, pcLarg, alt); celTitulo(doc, M + dx + pcLarg, y, colLarg - pcLarg, alt); doc.text('PC', M + dx + pcLarg / 2, y + alt - 2.1, { align: 'center' }); doc.text('Aluno(a)', M + dx + pcLarg + 1.5, y + alt - 2.1); });
    cor(doc, PRETO);
    y += alt;
    for (let i = 0; i < linhas; i++) {
      cel(M, y, sl.alunos[i]);
      if (duas) cel(M + colLarg, y, sl.alunos[i + linhas]);
      y += alt;
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`${sl.alunos.length} aluno(s) neste laboratório`, M, y + 5);
  }
  function pdfAta(doc, logo, sl, prova, info) {
    cabecalho(doc, logo);
    cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('ATA DE APLICAÇÃO DE PROVA', 105, 36, { align: 'center' }); cor(doc, PRETO);
    faixaTipo(doc, prova, 39);
    let y = 55;
    const campo = (rot, val) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.text(rot, M, y); const w = doc.getTextWidth(rot) + 1.5; doc.setFont('helvetica', 'normal'); caber(doc, val, LARG - w, 10.5); doc.text(val, M + w, y); y += 6.5; };
    campo('Instituição:', 'FACULDADE TECNOLÓGICA DO VALE DO IVAÍ');
    campo('Curso:', 'BACHARELADO EM MEDICINA');
    campo('Disciplina:', prova.disciplina.toUpperCase());
    campo('Tipo de prova:', tipoProva(prova));
    campo('Turma:', `${info.especial ? `${info.rotuloTurma.toUpperCase()} (${info.turma})` : `${info.turma} (${info.periodo}º período)`}    Sala: ${sl.rotulo.toUpperCase()}    Alunos previstos: ${sl.alunos.length}`);
    campo('Data:', `${dataBR(prova.data)}    Horário de início: ________    Horário de término: ________`);
    y += 3;
    cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.text('Ocorrências durante a aplicação', M, y); y += 7; cor(doc, PRETO);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    doc.text('(    ) Nenhuma ocorrência registrada.', M, y); y += 6;
    doc.text('(    ) Ocorreram as seguintes situações:', M, y); y += 4;
    doc.setLineWidth(0.3);
    for (let i = 0; i < 3; i++) { y += 7.5; doc.line(M, y, 210 - M, y); }
    y += 8;
    doc.text(doc.splitTextToSize('Nada mais havendo a relatar, lavra-se a presente ata, que vai assinada pelo(a) professor(a) responsável e, se necessário, por fiscais presentes.', LARG), M, y);
    y += 14;
    const tabela = (titulo, cols, n) => {
      cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.text(titulo, M, y); y += 3;
      const alt = 8.5;
      let x = M;
      doc.setFontSize(10); cor(doc, BRANCO);
      cols.forEach(([rot, w]) => { celTitulo(doc, x, y, w, alt); doc.text(rot, x + 1.5, y + alt - 2.8); x += w; });
      cor(doc, PRETO);
      y += alt;
      doc.setFont('helvetica', 'normal');
      for (let i = 1; i <= n; i++) { x = M; cols.forEach(([, w], j) => { doc.rect(x, y, w, alt); if (j === 0) doc.text(String(i), x + 1.5, y + alt - 2.8); x += w; }); y += alt; }
      y += 8;
    };
    tabela('Aplicadores', [['Nº', 12], ['Nome', LARG - 12 - 72], ['Assinatura', 72]], 4);
    tabela('Registro dos dois últimos alunos a deixar a sala', [['Nº', 12], ['Nome do(a) aluno(a)', LARG - 12 - 32 - 52], ['Horário de saída', 32], ['Assinatura', 52]], 2);
  }
  function pdfLogin(doc, logo, a, sl, prova, info) {
    cabecalho(doc, logo);
    const lugar = sl.napa ? sl.rotulo.toUpperCase() : `${sl.rotulo.toUpperCase()} · COMPUTADOR ${dois(a.pc)}`;
    doc.setLineWidth(1); doc.setDrawColor(...AZUL); doc.setFillColor(...AZUL_CLARO); doc.rect(M, 31, LARG, 15, 'FD'); doc.setDrawColor(...PRETO);
    cor(doc, AZUL); doc.setFont('helvetica', 'bold'); caber(doc, lugar, LARG - 6, 20); doc.text(lugar, 105, 41.5, { align: 'center' }); cor(doc, PRETO);
    doc.setFont('helvetica', 'normal'); caber(doc, linhaProvaTxt(prova, info), LARG, 9.5); doc.text(linhaProvaTxt(prova, info), 105, 52, { align: 'center' });
    faixaTipo(doc, prova, 55);
    doc.setFont('helvetica', 'bold'); doc.text(caberTxt(doc, a.nome, LARG, 15, 9), M, 75);
    cor(doc, AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('Login:', M, 85); doc.text('Senha:', M, 94); cor(doc, PRETO);
    doc.setFont('courier', 'bold'); doc.setFontSize(17); doc.text(a.ra, M + 22, 85); doc.text(a.senha || '(procure a secretaria)', M + 22, 94);
    doc.setLineDashPattern([1.2, 1.2], 0); doc.setLineWidth(0.3); doc.line(M, 103, 210 - M, 103); doc.setLineDashPattern([], 0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Anotações', M, 108);
  }

  async function baixar(acao) {
    const [o, salaId] = acao.split(':');
    const prova = provasVisiveis().find(p => p.id === provaId);
    if (!prova) return;
    const info = await alunosDa(prova);
    const dist = distribuir(info, prova);
    const todas = [...dist.salas, ...(dist.napa ? [dist.napa] : [])];
    const alvo = salaId === '*' ? todas : todas.filter(s => s.id === salaId);
    if (!alvo.length) { toast('Nada para baixar nesta sala.', 'erro'); return; }
    toast('Gerando o PDF…');
    const [{ jsPDF }, logo] = await Promise.all([carregarJsPDF(), logoMed()]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    let primeira = true;
    const nova = () => { if (!primeira) doc.addPage('a4', 'portrait'); primeira = false; };
    alvo.forEach(sl => {
      if ((o === 'tudo' || o === 'porta') && !sl.napa) { nova(); pdfPorta(doc, logo, sl, prova, info); }
      if (o === 'tudo' || o === 'ata') { nova(); pdfAta(doc, logo, sl, prova, info); }
      if (o === 'tudo' || o === 'logins') sl.alunos.forEach(a => { nova(); pdfLogin(doc, logo, a, sl, prova, info); });
    });
    if (primeira) { toast('Nada para baixar nesta sala.', 'erro'); return; }
    const OQUE = { tudo: 'Prova', porta: 'Lista da porta', logins: 'Logins', ata: 'Ata' };
    const ondeTxt = salaId === '*' ? 'todas as salas' : alvo.map(s => s.rotulo).join(' ');
    const tipoArq = { b1: '1a chamada', b2: '1a chamada', sub: '2a chamada', exame: 'Exame' }[prova.etapa] || '';
    const nomeArq = `${OQUE[o] || 'Prova'} ${info.turma} - ${prova.disciplina} - ${tipoArq} - ${ondeTxt} - ${dataBR(prova.data).replace(/\//g, '-')}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').slice(0, 150);
    doc.save(`${nomeArq}.pdf`);
    toast(`PDF baixado (${doc.getNumberOfPages()} folha(s) A4). Abra o arquivo e imprima.`);
  }

  // troca o primeiro nome do NAPA pelo nome completo escolhido (sem reabrir o calendário validado)
  async function salvarNapa() {
    const d = dadosAtuais();
    const prova = provasVisiveis().find(p => p.id === provaId);
    if (!prova) return;
    const nomes = [...(((d.config.napaAlunos || {})[prova.turma]) || [])];
    let mudou = 0;
    document.querySelectorAll('[data-napa-i]').forEach(s => { if (s.value) { nomes[Number(s.dataset.napaI)] = s.value; mudou++; } });
    if (!mudou) { toast('Escolha o aluno em pelo menos um nome.', 'erro'); return; }
    const r = await api(`${BASE}/impressao/napa/${encodeURIComponent(d.semestre)}`, { method: 'PUT', body: JSON.stringify({ turma: prova.turma, nomes }) });
    d.config.napaAlunos = { ...(d.config.napaAlunos || {}), [prova.turma]: r.nomes };
    toast(r.message);
    renderCorpo(prova, await alunosDa(prova));
  }

  async function salvarDivisao() {
    const d = dadosAtuais();
    const prova = provasVisiveis().find(p => p.id === provaId);
    if (!prova) return;
    const modo = ESPECIAIS[prova.turma] ? 'unica' : ((document.querySelector('[name="ap-imp-modo"]:checked') || {}).value || 'unica');
    const primeira = document.getElementById('ap-imp-primeira').value;
    const ateSel = document.getElementById('ap-imp-ate');
    const info = await alunosDa(prova);
    const ate = modo === 'dividida' ? (ateSel ? ateSel.value : (info.alunos[Math.floor(info.alunos.length / 2)] || {}).nome || '') : '';
    // número inicial de cada laboratório: o que está na tela (ou o que já estava salvo); cada laboratório tem a sua numeração
    const inicio = { ...((info.salas || {}).inicio || {}) };
    document.querySelectorAll('[data-inicio-sala]').forEach(i => { inicio[i.dataset.inicioSala] = Math.max(1, parseInt(i.value, 10) || 1); });
    const r = await api(`${BASE}/impressao/salas/${encodeURIComponent(d.semestre)}`, { method: 'PUT', body: JSON.stringify({ salas: { [prova.turma]: { modo, primeira, ate, inicio } } }) });
    info.salas = r.salas[prova.turma];
    toast(r.message);
    renderCorpo(prova, info);
  }

  function ligar(alvo) {
    alvo.addEventListener('change', (e) => {
      if (e.target.id === 'ap-imp-prova') { provaId = e.target.value; render(alvo); return; }
      if (e.target.id === 'ap-imp-edubox') { eduboxEscolhida.set(provaId, e.target.value); render(alvo); return; }
      if (e.target.dataset.inicioSala) {
        // mostra a nova numeração na hora; fica salva em "Salvar divisão"
        const pr = provasVisiveis().find(p => p.id === provaId);
        const inf = pr && cache.get(chave(pr));
        if (inf) {
          inf.salas = { ...(inf.salas || {}), inicio: { ...((inf.salas || {}).inicio || {}), [e.target.dataset.inicioSala]: Math.max(1, parseInt(e.target.value, 10) || 1) } };
          renderCorpo(pr, inf);
          toast('Numeração atualizada. Clique em "Salvar divisão e numeração" para guardar.');
        }
        return;
      }
      if (e.target.name === 'ap-imp-modo') {
        // mostra/esconde o "até" sem salvar ainda
        const prova = provasVisiveis().find(p => p.id === provaId);
        const info = cache.get(chave(prova));
        if (info) { info.salas = { ...(info.salas || {}), modo: e.target.value, ate: info.salas && info.salas.ate ? info.salas.ate : (info.alunos[Math.floor(info.alunos.length / 2)] || {}).nome || '' }; renderCorpo(prova, info); }
      }
    });
    alvo.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-imp]');
      try {
        if (b) { b.disabled = true; try { await baixar(b.dataset.imp); } finally { b.disabled = false; } return; }
        if (e.target.closest('#ap-imp-salvar-div')) await salvarDivisao();
        if (e.target.closest('#ap-imp-salvar-napa')) await salvarNapa();
      } catch (err) { toast(err.message, 'erro'); }
    });
  }

  return { render, ligar, limpar: () => cache.clear() };
}
