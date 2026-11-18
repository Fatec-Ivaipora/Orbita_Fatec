// ================================================================
//  ÓRBITA — RELATÓRIO DESEMPENHO · montagem do documento
//
//  Só monta o HTML do relatório a partir do documento que a API devolve.
//  Não fala com Firebase, nem com o DOM da tela, nem com a API — assim o
//  layout dá pra ser conferido fora do Órbita (é como a saída foi validada
//  contra o relatório em PDF que originou este módulo).
// ================================================================
import { escapeHTML as esc } from "../../core/security.js";

export const LIMITE_REVISAO = 20;

// ---------------- Formatação ----------------

// Versão literal (hex) — o SVG gerado como string não resolve var() em todo
// navegador na hora de imprimir.
// Faixas da discriminação conforme o material CADAM (RS19 p.562) — ver src/utils/parseEstatisticasAva.js.
// Relatório gravado antes de 18/11/2026 e ainda não recalculado pode trazer os nomes antigos: cor de reserva.
export const CORES_HEX = {
  'Muito boa': '#004F9F',
  'Boa': '#009FE3',
  'Fraca': '#E9B43A',
  'Muito fraca': '#EC7A45',
  'Problemática': '#B91C1C',
  'Excelente': '#004F9F', 'Razoável': '#E9B43A'
};
const ORDEM_FAIXAS = ['Muito boa', 'Boa', 'Fraca', 'Muito fraca', 'Problemática'];

const MESES = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
const DIAS = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];

export function pct(v, casas = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(casas).replace('.', ',') + '%';
}

export function dataExtenso(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return iso; // não era ISO — mostra como o AVA mandou
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  let txt = `${DIAS[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}`;
  if (m[4] && (m[4] !== '00' || m[5] !== '00')) txt += `, ${m[4]}:${m[5]}`;
  return txt;
}

export function dataCurta(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}


// ---------------- Gráficos (SVG inline) ----------------

function svgRosca(contagens, total) {
  const raio = 150, espessura = 62, cx = 170, cy = 170;
  const circ = 2 * Math.PI * raio;
  let offset = 0;
  const fatias = ORDEM_FAIXAS.map(nome => {
    const qtd = contagens[nome] || 0;
    if (!qtd) return '';
    const fatia = total ? circ * qtd / total : 0;
    const s = `<circle cx="${cx}" cy="${cy}" r="${raio}" fill="none" stroke="${CORES_HEX[nome]}" stroke-width="${espessura}" stroke-dasharray="${fatia.toFixed(3)} ${(circ - fatia).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}"></circle>`;
    offset += fatia;
    return s;
  }).join('');

  return `<svg viewBox="0 0 340 340" class="rd-rosca" role="img" aria-label="Distribuição das questões por qualidade">
    <g transform="rotate(-90 ${cx} ${cy})">
      <circle cx="${cx}" cy="${cy}" r="${raio}" fill="none" stroke="#E7ECEE" stroke-width="${espessura}"></circle>
      ${fatias}
    </g>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" class="rd-rosca-num">${total}</text>
    <text x="${cx}" y="${cy + 40}" text-anchor="middle" class="rd-rosca-rot">questões</text>
  </svg>`;
}

function svgDispersao(questoes) {
  const L = 52, R = 18, T = 16, B = 46, W = 620, H = 320;
  const px = W - L - R, py = H - T - B;
  const vals = questoes.map(q => q.discriminacao).filter(v => Number.isFinite(v));
  const ymin = Math.min(0, Math.floor((vals.length ? Math.min(...vals) : 0) / 10) * 10);
  const ymax = Math.max(60, Math.ceil((vals.length ? Math.max(...vals) : 60) / 10) * 10);
  const X = v => L + px * (v / 100);
  const Y = v => T + py * (1 - (v - ymin) / (ymax - ymin));

  const grade = [0, 20, 30, 50].filter(t => t >= ymin && t <= ymax).map(t =>
    `<line x1="${L}" y1="${Y(t).toFixed(1)}" x2="${L + px}" y2="${Y(t).toFixed(1)}" stroke="#E4EAEC"${[20, 30].includes(t) ? ' stroke-dasharray="4 4"' : ''}></line>
     <text x="${L - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="rd-eixo">${t}</text>`
  ).join('') + [0, 25, 50, 75, 100].map(t =>
    `<text x="${X(t).toFixed(1)}" y="${T + py + 20}" text-anchor="middle" class="rd-eixo">${t}</text>`
  ).join('');

  const pontos = questoes.filter(q => Number.isFinite(q.facilidade) && Number.isFinite(q.discriminacao)).map(q =>
    `<circle cx="${X(q.facilidade).toFixed(1)}" cy="${Y(q.discriminacao).toFixed(1)}" r="5.5" fill="${CORES_HEX[q.classificacao]}" opacity="0.92"><title>Q${q.n} · ${esc(q.nome)} — facilidade ${pct(q.facilidade)} · discriminação ${pct(q.discriminacao)}</title></circle>`
  ).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="rd-grafico" role="img" aria-label="Discriminação por facilidade">
    ${grade}
    <line x1="${L}" y1="${T + py}" x2="${L + px}" y2="${T + py}" stroke="#C9D4D8"></line>
    ${pontos}
    <text x="${L + px / 2}" y="${H - 6}" text-anchor="middle" class="rd-eixo">Índice de facilidade (%) →</text>
    <text x="14" y="${T + py / 2}" text-anchor="middle" class="rd-eixo" transform="rotate(-90 14 ${T + py / 2})">Índice de discriminação (%) ↑</text>
  </svg>`;
}

function svgBarras(questoes) {
  const L = 44, R = 12, T = 14, B = 52;
  const W = Math.max(760, 22 * questoes.length + L + R), H = 300;
  const px = W - L - R, py = H - T - B;
  const vals = questoes.map(q => Number.isFinite(q.discriminacao) ? q.discriminacao : 0);
  const ymin = Math.min(0, Math.floor(Math.min(0, ...vals) / 10) * 10);
  const ymax = 100;
  const Y = v => T + py * (1 - (v - ymin) / (ymax - ymin));

  const largura = px / Math.max(questoes.length, 1);
  const barra = largura * 0.62;

  const grade = [0, 10, 20, 40, 100].map(t =>
    `<line x1="${L}" y1="${Y(t).toFixed(1)}" x2="${L + px}" y2="${Y(t).toFixed(1)}" stroke="#E4EAEC"${[10, 20].includes(t) ? ' stroke-dasharray="4 4"' : ''}></line>
     <text x="${L - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="rd-eixo">${t}</text>`
  ).join('');

  let barras = '', rotulos = '';
  questoes.forEach((q, i) => {
    const d = Number.isFinite(q.discriminacao) ? q.discriminacao : 0;
    const x = L + i * largura + (largura - barra) / 2;
    const topo = Y(Math.max(d, 0)), base = Y(Math.min(d, 0));
    barras += `<rect x="${x.toFixed(1)}" y="${topo.toFixed(1)}" width="${barra.toFixed(1)}" height="${Math.max(base - topo, 1.2).toFixed(1)}" rx="2" fill="${CORES_HEX[q.classificacao]}"><title>Q${q.n} · ${esc(q.nome)} — discriminação ${pct(q.discriminacao)}</title></rect>`;
    if (q.n % 2 === 1) rotulos += `<text x="${(x + barra / 2).toFixed(1)}" y="${T + py + 20}" text-anchor="middle" class="rd-eixo">${q.n}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" class="rd-grafico" role="img" aria-label="Índice de discriminação por questão">
    ${grade}${barras}
    <line x1="${L}" y1="${Y(0).toFixed(1)}" x2="${L + px}" y2="${Y(0).toFixed(1)}" stroke="#C9D4D8"></line>
    ${rotulos}
    <text x="${L}" y="${H - 8}" class="rd-eixo">Q# da questão · linhas tracejadas = 10% (abaixo: muito fraca) e 20% (a partir daqui: boa)</text>
  </svg>`;
}

export function miniBarra(valor, cor) {
  const v = Math.max(0, Math.min(100, Number.isFinite(valor) ? valor : 0));
  return `<span class="mini"><span class="mini-fill" style="width:${v.toFixed(1)}%;background:${cor}"></span></span><span class="mini-num">${pct(valor)}</span>`;
}


// ---------------- Tela: o relatório ----------------

// O que o AVA chama de "coeficiente de consistência interna" É o Alfa de
// Cronbach (a própria doc do Moodle diz isso). Mostramos na escala 0–1.
// 18/11/2026: SEM rótulo de qualidade ("excelente", "fraco"...). O material CADAM trata o alfa/KR-20 como
// medida de confiabilidade, mas não dá faixas — e lembra que nota confiável pede ~100 questões ou mais
// (NBME22 p.7; NBME16 p.4): prova bimestral tem alfa menor por natureza. As faixas antigas não tinham fonte.
export function alfaCronbach(percentual) {
  if (percentual === null || percentual === undefined || !Number.isFinite(percentual)) return null;
  const v = percentual / 100;
  return { valor: v, texto: v.toFixed(2).replace('.', ','), rotulo: 'confiabilidade', cor: 'inherit' };
}

function campoEditavel(rotulo, valor, chave) {
  const attr = chave ? ` class="editavel" contenteditable="true" data-campo="${chave}"` : '';
  return `<div><dt>${rotulo}</dt><dd><span${attr}>${esc(valor)}</span></dd></div>`;
}

// Disciplina · Turma · período · semestre — o que o docente/coordenação
// precisa ver no topo da folha impressa. Usa o que foi preenchido no
// formulário e completa com o "2026.2 - T.3 - 2° PER - DISCIPLINA" que o AVA
// manda no nome do curso (25/09).
export function identificacaoTurma(r) {
  const ct = String(r.cursoTurma || '');
  const m = ct.match(/^(\d{4}\.\d)\s*-\s*T\s*\.?\s*(\d+)\s*-\s*(\d{1,2})\s*[°ºo]?\s*PER\w*\s*-\s*(.+)$/i);
  const turmaCod = (`${r.turma || ''} ${ct}`.match(/\bT\s*\.?\s*(\d+)\b/i) || [])[1];
  const disciplina = r.disciplina || (m ? m[4].trim() : '');
  const periodo = r.periodo || (m ? m[3] : '');
  const semestre = r.semestre || (m ? m[1] : '');
  return {
    disciplina,
    turma: turmaCod ? `Turma T.${turmaCod}` : '',
    periodo: periodo ? `${periodo}º período` : '',
    semestre
  };
}

export function montarRelatorioHTML(r) {
  const qs = (r.questoes || []).slice().sort((a, b) => a.n - b.n);
  const resumo = r.resumo || {};
  const contagens = resumo.contagens || {};
  const revisar = qs.filter(q => q.revisar).sort((a, b) => (a.discriminacao || 0) - (b.discriminacao || 0));
  const notaMedia = Number.isFinite(r.notaMedia) ? r.notaMedia : resumo.facilidadeMedia;

  const alfa = alfaCronbach(r.consistenciaInterna);
  const alfaTexto = alfa ? `${alfa.texto} · ${alfa.rotulo}` : '—';

  const meta = [
    campoEditavel('Curso / turma', r.cursoTurma || r.turma || '—', 'cursoTurma'),
    campoEditavel('Disciplina', r.disciplina || '—', 'disciplina'),
    campoEditavel('Aplicação', dataExtenso(r.aplicacao), null),
    campoEditavel('Encerramento', dataExtenso(r.encerramento), null),
    campoEditavel('Professor(a) responsável', r.professor || '—', 'professor'),
    campoEditavel('Nº de alunos (tentativas)', r.nAlunos != null ? r.nAlunos : '—', null),
    campoEditavel('Nota média', pct(notaMedia), null),
    campoEditavel('Desvio padrão', pct(r.desvioPadrao), null),
    campoEditavel('Alfa de Cronbach (consistência interna)', alfaTexto, null)
  ].join('');

  const legenda = ORDEM_FAIXAS.filter(n => contagens[n]).map(n =>
    `<span class="chip"><i style="--c:${CORES_HEX[n]};background:var(--c)"></i>${n} · <b>${contagens[n]}</b></span>`
  ).join('');

  const blocosRevisao = revisar.length ? revisar.map(q => `
    <div class="rd-rev" style="border-left-color:${CORES_HEX[q.classificacao]}">
      <div class="rd-rev-top">
        <b>Q${q.n}</b>
        ${q.situacaoTexto ? `<span class="rd-situacao rd-sit-${q.situacao}">${esc(q.situacaoTexto)}</span>` : ''}
        <span class="tag" style="--c:${CORES_HEX[q.classificacao]};background:var(--c)">${q.classificacao}</span>
        <span class="rd-rev-num">discriminação ${pct(q.discriminacao)} · facilidade ${pct(q.facilidade)}</span>
      </div>
      <div class="rd-rev-nome">${esc(q.nome)}</div>
      <p class="rd-rev-motivo">${esc(q.motivo || '')}</p>
    </div>`).join('')
    : `<p class="rd-secao-nota">Nenhuma questão precisa de revisão. Prova bem calibrada.</p>`;

  const linhasTabela = qs.map(q => `
    <tr>
      <td class="num">${q.n}</td>
      <td>${esc(q.nome)}</td>
      <td class="num">${q.tentativas != null ? q.tentativas : '—'}</td>
      <td class="num">${pct(q.facilidade)}</td>
      <td>${miniBarra(q.discriminacao, CORES_HEX[q.classificacao])}</td>
      <td class="num">${pct(q.eficiencia)}</td>
      <td><span class="tag" style="--c:${CORES_HEX[q.classificacao]};background:var(--c)">${q.classificacao}</span></td>
    </tr>`).join('');

  const legendaTabela = [
    ['Muito boa', 'Muito boa ≥ 40%'], ['Boa', 'Boa 20–39%'], ['Fraca', 'Fraca 10–19%'],
    ['Muito fraca', 'Muito fraca 0–9%'], ['Problemática', 'Problemática &lt; 0']
  ].map(([n, rot]) => `<span class="chip"><i style="--c:${CORES_HEX[n]};background:var(--c)"></i>${rot}</span>`).join('');

  const comAlts = qs.filter(q => (q.alternativas || []).length);
  const iconeCheck = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  const iconeAlerta = '<svg viewBox="0 0 24 24"><line x1="12" y1="7" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  const secaoAlts = comAlts.length ? `
    <section class="rd-secao rd-quebra-anexo rd-anexo">
      <h2>Detalhamento das alternativas por questão</h2>
      <p class="rd-secao-nota">Percentual de alunos em cada alternativa.
        <b style="color:var(--med-azul-escuro)">Azul</b> = correta ·
        <b style="color:var(--q-fraca)">laranja</b> = distrator que mais atraiu ·
        <b>não funcional</b> = distrator escolhido por menos de 5% dos alunos — reescrever (RS19; ES21).
        Clique numa questão para recolher.</p>
      <div class="rd-2col">${comAlts.map(q => `
        <details class="rd-q" open>
          <summary>
            <span class="rd-q-id">Q${q.n}</span>
            <span class="rd-q-nome">${esc(q.nome)}</span>
            <span class="rd-q-disc">disc. ${pct(q.discriminacao)}</span>
            <span class="rd-q-seta">▶</span>
          </summary>
          <div class="rd-alts">
            ${(q.alternativas || []).map(a => {
              const cor = a.correta ? CORES_HEX['Muito boa'] : (a.distratorForte ? CORES_HEX['Muito fraca'] : '#B9C5CA');
              const marca = a.correta
                ? `<span class="rd-marca ok">${iconeCheck}</span>`
                : (a.distratorForte ? `<span class="rd-marca dist">${iconeAlerta}</span>` : '<span class="rd-marca"></span>');
              const pill = a.correta
                ? '<span class="pill ok">correta</span>'
                : (a.distratorForte ? '<span class="pill dist">+ marcada errada</span>' : (a.naoFuncional ? '<span class="pill nf">não funcional</span>' : ''));
              const freq = Number.isFinite(a.frequencia) ? a.frequencia : 0;
              const cont = a.contagem != null ? `${a.contagem} aluno(s) · ` : '';
              return `<div class="rd-alt">
                ${marca}
                <div class="rd-alt-txt">${esc(a.texto)}${pill}</div>
                <div>${miniBarra(freq, cor)}</div>
                <div class="rd-alt-num">${cont}${pct(freq)}</div>
              </div>`;
            }).join('')}
          </div>
        </details>`).join('')}</div>
    </section>` : '';

  // Questões em que um distrator atraiu tanto ou mais gente que o gabarito.
  // Vale destacar à parte: a questão pode até discriminar bem e ainda assim
  // apontar que a turma inteira aprendeu a coisa errada.
  const comDistrator = qs.filter(q => q.alertaDistrator);
  const secaoDistratores = comDistrator.length ? `
    <section class="rd-secao">
      <h2>Distratores que atraíram mais que o gabarito</h2>
      <p class="rd-secao-nota">Nestas questões a turma não errou espalhado: convergiu numa alternativa errada.
        Costuma indicar erro conceitual coletivo, enunciado ambíguo ou gabarito trocado — e aparece mesmo
        quando a discriminação está boa.</p>
      <div class="rd-2col">${comDistrator.map(q => {
        const correta = (q.alternativas || []).find(a => a.correta);
        const dominante = (q.alternativas || []).find(a => a.distratorDominante);
        if (!correta || !dominante) return '';
        return `<div class="rd-rev" style="border-left-color:var(--q-razoavel);background:#FFFCF3">
          <div class="rd-rev-top">
            <b>Q${q.n}</b>
            <span class="tag" style="--c:${CORES_HEX[q.classificacao]};background:var(--c)">${q.classificacao}</span>
            <span class="rd-rev-num">gabarito ${pct(correta.frequencia)} · distrator ${pct(dominante.frequencia)}</span>
          </div>
          <div class="rd-rev-nome">${esc(q.nome)}</div>
          <p class="rd-rev-motivo">
            <b>Marcada pela turma:</b> ${esc(dominante.texto)}<br>
            <b>Gabarito:</b> ${esc(correta.texto)}
          </p>
        </div>`;
      }).join('')}</div>
    </section>` : '';

  const html = `
    <div class="rd-doc-topo">
      <img class="rd-doc-logo" src="/img/medfatec-logo.png" alt="MED FATEC">
      <div class="rd-doc-kicker">Análise psicométrica das questões da avaliação</div>
    </div>
    <h1><span class="editavel" contenteditable="true" data-campo="titulo">${esc(r.titulo || 'Avaliação sem título')}</span></h1>
    ${(() => {
      const id = identificacaoTurma(r);
      const resto = [id.turma, id.periodo, id.semestre].filter(Boolean).map(esc).join(' · ');
      return (id.disciplina || resto)
        ? `<p class="rd-doc-ident">${id.disciplina ? `<b>${esc(id.disciplina)}</b>` : ''}${id.disciplina && resto ? ' · ' : ''}${resto}</p>`
        : '';
    })()}
    <p class="rd-doc-sub">Relatório gerado a partir do export de Estatísticas do questionário (AVA) — ${esc(r.nomeArquivo || 'arquivo do AVA')}</p>

    ${(r.avisos || []).length ? `<div class="rd-erro rd-aviso-arquivo">⚠ ${r.avisos.map(esc).join('<br>')}</div>` : ''}
    <dl class="rd-meta">${meta}</dl>
    <p class="rd-nota-edit">
      <svg class="rd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      Campos sublinhados podem ser corrigidos antes de imprimir — depois clique em “Salvar cabeçalho”. Os números vêm do AVA e não se editam (IA prepara, humano confirma).
    </p>

    <hr class="rd-regua">

    <section class="rd-secao">
      <h2>Resumo executivo</h2>
      <div class="rd-cards">
        <div class="rd-card"><div class="v">${resumo.total || 0}</div><div class="r">Questões analisadas</div></div>
        <div class="rd-card escuro"><div class="v">${pct(resumo.discriminacaoMedia)}</div><div class="r">Discriminação média</div></div>
        <div class="rd-card"><div class="v">${pct(resumo.facilidadeMedia)}</div><div class="r">Facilidade média</div></div>
        <div class="rd-card"><div class="v">${resumo.boasOuExcelentes || 0}</div><div class="r">Boas ou muito boas (disc. ≥ 20%)</div></div>
        <div class="rd-card alerta"><div class="v">${resumo.paraRevisar || 0}</div><div class="r">Para revisar</div></div>
        <div class="rd-card"><div class="v">${resumo.faceis != null ? resumo.faceis : qs.filter(q => q.situacao === 'facil').length}</div><div class="r">Fáceis — conteúdo dominado</div></div>
        <div class="rd-card"><div class="v">${alfa ? alfa.texto : '—'}</div><div class="r">Alfa de Cronbach (confiabilidade)</div></div>
        ${(() => { // conta das questões (o resumo gravado pode não ter o campo)
          const nf = qs.reduce((s, q) => s + (q.alternativas || []).filter(a => a.naoFuncional).length, 0);
          const nq = qs.filter(q => (q.alternativas || []).some(a => a.naoFuncional)).length;
          return qs.some(q => (q.alternativas || []).length) ? `<div class="rd-card"><div class="v">${nf}</div><div class="r">Distratores não funcionais (&lt; 5%) em ${nq} questão(ões)</div></div>` : '';
        })()}
      </div>
    </section>

    <section class="rd-secao">
      <h2>Panorama visual</h2>
      <div class="rd-duas">
        <div class="rd-painel">
          <h3>Distribuição por qualidade</h3>
          ${svgRosca(contagens, resumo.total || qs.length)}
          <div class="rd-legenda">${legenda}</div>
        </div>
        <div class="rd-painel">
          <h3>Discriminação × Facilidade (cada ponto = 1 questão)</h3>
          ${svgDispersao(qs)}
          <p class="rd-secao-nota" style="margin:0.6rem 0 0">Ideal: facilidade média (40–80%) com discriminação alta.
            Pontos no canto inferior costumam ser questões fáceis demais ou confusas.</p>
        </div>
      </div>
    </section>

    <section class="rd-secao">
      <div class="rd-painel">
        <h3>Índice de discriminação por questão</h3>
        ${svgBarras(qs)}
      </div>
    </section>

    <section class="rd-secao rd-quebra">
      <h2>Questões que merecem revisão</h2>
      <p class="rd-secao-nota">Questões com discriminação negativa, que quase ninguém acertou, ou de dificuldade média que não separam
        quem domina de quem não domina o conteúdo. Questões fáceis (a turma dominou) não entram aqui. Vale conferir enunciado, gabarito e distratores.</p>
      <div class="rd-2col">${blocosRevisao}</div>
    </section>

    ${secaoDistratores}

    <section class="rd-secao rd-quebra">
      <h2>Tabela completa de questões</h2>
      <div class="rd-legenda-tabela">${legendaTabela}</div>
      <div class="rd-tabela-wrap">
        <table class="rd-tabela">
          <thead><tr>
            <th class="num">Q#</th><th>Tópico / nome da questão</th><th class="num">Tent.</th>
            <th class="num">Facilidade</th><th>Discriminação</th><th class="num">Eficiência</th><th>Classificação</th>
          </tr></thead>
          <tbody>${linhasTabela}</tbody>
        </table>
      </div>
    </section>
    ${secaoAlts}

    <p class="rd-rodape">
      <b>Como ler o Alfa de Cronbach:</b> é o que o AVA chama de "coeficiente de consistência interna" e mede a
      <b>confiabilidade</b> da prova (o mesmo papel do KR-20): o quanto as questões medem de forma consistente.
      O relatório não dá nota ao alfa. O material da capacitação Avaliação CADAM não traz faixas para ele e lembra
      que uma nota confiável pede cerca de 100 questões ou mais (NBME); numa prova bimestral, com menos questões e
      vários assuntos, o alfa tende a ser menor sem que isso indique problema nos itens.<br><br>
      <b>Como ler o índice de discriminação:</b> mede o quanto a questão separa os alunos de melhor desempenho geral
      dos de pior desempenho. Faixas (RS19): abaixo de 10% muito fraca · 10–19% fraca · 20–39% boa · 40% ou mais
      muito boa. Discriminação negativa ou perto de zero sugere gabarito errado ou duas alternativas corretas (NBME).<br><br>
      <b>Como ler a facilidade:</b> é o percentual de acerto. Acima de 95% ou abaixo de 30% a questão informa pouco
      sobre a turma (NBME); a prova deve ter predomínio de dificuldade média, 35–64% de acerto (RS19).<br><br>
      <b>Distrator não funcional:</b> alternativa errada escolhida por menos de 5% dos alunos — reescrever (RS19; ES21).<br><br>
      <b>Fontes</b> (material da capacitação Avaliação CADAM): NBME — Constructing Written Test Questions for the Basic and
      Clinical Sciences (2016 e 2022); RS19 e ES21 — diretrizes de elaboração e análise de itens usadas na capacitação.<br><br>
      Gerado a partir do export de Estatísticas do questionário (AVA) em ${esc(dataCurta(r.createdAt) || '—')} ·
      Órbita Fatec · Ferramenta de apoio: a decisão pedagógica final é do(a) docente.
    </p>`;

  return {
    html,
    tituloToolbar: r.titulo || 'Relatório',
    metaToolbar: [r.disciplina, r.turma, r.semestre, `${resumo.total || 0} questões`].filter(Boolean).join(' · ')
  };
}

