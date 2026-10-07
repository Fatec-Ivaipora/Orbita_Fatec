// ==========================================================================
// Sincronização Edubox -> Órbita (módulo Relatório CPA).
//
// O Edubox (Postgres na nuvem do fornecedor) só aceita conexão do IP da Fatec —
// o Órbita publicado (Vercel) não alcança. Este script roda num PC da Fatec, SÓ
// LÊ o Edubox e grava no Firestore do Órbita os resultados JÁ AGREGADOS: nenhum
// dado que identifique aluno (matrícula, nome) sai do Edubox, só contagens,
// médias e o texto dos comentários.
//
//   cpa_ciclos/{ciclo}                       um por semestre+segmento (GRA ou MED): campanhas,
//                                            cursos e participação
//   cpa_relatorios/{codava}__{curso|IES}     resultado dos ALUNOS por curso e da IES (segmento):
//                                            dimensões, perguntas (contagem de cada opção), notas e comentários
//   cpa_professores/{codava}__{curso}__{codpro}
//                                            avaliação de cada professor pelos alunos, por curso
//
// Fidelidade ao que foi aplicado (regra do relatório): mesmas dimensões, perguntas e opções de
// resposta do Edubox, com a contagem de cada opção. Nada de índice inventado; "satisfação" é só
// (Ótimo + Bom) / respostas válidas e aparece rotulada como tal. "Não sei" não entra na base.
//
// Segmentos: GRA = Graduação (todos os cursos exceto Medicina); MED = Medicina. No Edubox, a
// campanha de Medicina tem semestre no formato "2026-1" e "MEDICINA" na descrição.
//
// Uso: node scripts/cpa-edubox-sync.js                 (último ciclo de GRA e de MED)
//      node scripts/cpa-edubox-sync.js 76 74           (campanhas de ALUNOS específicas)
//      node scripts/cpa-edubox-sync.js --dry           (não grava, só resume)
// ==========================================================================
const path = require('path');
const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const edubox = require(path.join(RAIZ, 'src', 'db-edubox'));
const { classificarComentario } = require(path.join(RAIZ, 'src', 'utils', 'cpa-comentarios'));

const OPCOES = ['Ótimo', 'Bom', 'Regular', 'Ruim', 'Não sei']; // 1..5, igual em todas as perguntas aplicadas
const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const q = (sql, p) => edubox.query(sql, p).then(r => r.rows);

// SINAES (Lei 10.861/2004): dimensão -> eixo
const EIXO = { 8: 1, 1: 2, 3: 2, 2: 3, 4: 3, 9: 3, 5: 4, 6: 4, 10: 4, 7: 5 };

const soma = (a) => a.reduce((x, y) => x + y, 0);
// satisfação = (Ótimo + Bom) / (Ótimo + Bom + Regular + Ruim); "Não sei" fica fora
const satisfacao = (dist) => { const v = dist[0] + dist[1] + dist[2] + dist[3]; return v ? Math.round((dist[0] + dist[1]) / v * 1000) / 10 : null; };
const notaValida = (n) => { const x = n === null || n === undefined ? null : Number(n); return x !== null && x >= 0 && x <= 10 ? x : null; };   // há "100" no Edubox: fora da faixa 0–10 não entra na média
const media = (xs) => (xs.length ? Math.round(soma(xs) / xs.length * 100) / 100 : null);
const comentarioDe = (t) => { const x = limpa(t); return x.split(' ').filter(Boolean).length >= 2 ? { texto: x, classe: classificarComentario(x) } : null; };

async function campanhas() {
  const r = await q(`select codava, trim(desava) descricao, trim(semava) semestre, tipava, trim(atiava) ativa
                       from tav_avaliacao where tipava in ('A','P','O') order by codava desc`);
  return r.filter(c => !/teste/i.test(c.descricao + c.ativa)).map(c => ({
    ...c, segmento: (/medicina/i.test(c.descricao) || /-/.test(c.semestre)) ? 'MED' : 'GRA'
  }));
}

// matrículas ativas e respondentes por curso no semestre da campanha
async function participacao(camp) {
  const formatos = [camp.semestre, camp.semestre.replace('/', '-'), camp.semestre.replace('-', '/')];
  return q(`select c.codcur, trim(c.descur) nome,
                   count(distinct m.codmat) filter (where m.stamat = 'Ativo') ativos,
                   count(distinct m.codmat) filter (where m.stamat = 'Ativo' and p.matpar is not null) responderam
              from tac_curso c
              join tac_turma t on t.curtur = c.codcur and t.semtur = any($2)
              join tac_matricula m on m.turmat = t.codtur
              left join tav_participacao p on p.matpar = m.codmat and p.avapar = $1
             where ${camp.segmento === 'MED' ? "c.codcur = 'MED'" : "c.codcur <> 'MED'"}
             group by 1, 2 order by 2`, [camp.codava, formatos]);
}

async function dimensoes(codava) {
  const g = await q(`select codgru, trim(desgru) nome, tipgru tipo,
                            nullif((regexp_match(trim(desgru), '^([0-9]+)'))[1], '')::int numero
                       from tav_grupo where avagru = $1
                      order by coalesce((regexp_match(trim(desgru), '^([0-9]+)'))[1]::int, 999), trim(desgru)`, [codava]);
  const qs = await q(`select q.codque, q.gruque codgru, trim(q.desque) texto, trim(q.resque) opcoes
                        from tav_questao q join tav_grupo g on g.codgru = q.gruque where g.avagru = $1 order by q.codque`, [codava]);
  return g.map(d => ({ ...d, eixo: EIXO[d.numero] || null, perguntas: qs.filter(x => x.codgru === d.codgru) }));
}

const CURSO_DE_MATRICULA = `
  join tac_matricula m on m.codmat = %M%
  join tac_turma t on t.codtur = m.turmat
  join tac_curso c on c.codcur = t.curtur`;     // join até tac_curso: o banco é compartilhado com outras instituições

async function respostasGerais(codava) {         // dimensões gerais (tipgru <> 'D')
  return q(`select c.codcur, r.queres codque, (regexp_match(r.desres, '^([0-9]+)'))[1]::int op, count(*)::int n
              from tav_resp_grupo_aluno r
              join tav_questao qq on qq.codque = r.queres
              join tav_grupo g on g.codgru = qq.gruque and g.avagru = $1
              ${CURSO_DE_MATRICULA.replace('%M%', 'r.matres')}
             where r.desres ~ '^[0-9]+' group by 1, 2, 3`, [codava]);
}
async function respostasDisciplina(codava) {     // dimensões por disciplina (tipgru = 'D'): ligadas ao histórico
  return q(`select c.codcur, r.queres codque, r.prores codpro, trim(d.nomdis) disciplina, (regexp_match(r.desres, '^([0-9]+)'))[1]::int op, count(*)::int n
              from tav_resp_historico_aluno r
              join tav_questao qq on qq.codque = r.queres
              join tav_grupo g on g.codgru = qq.gruque and g.avagru = $1
              join tac_historico h on h.codhis = r.hisres
              ${CURSO_DE_MATRICULA.replace('%M%', 'h.mathis')}
              left join tac_disciplina_turma dt on dt.coddtu = h.dtuhis
              left join tac_disciplina d on d.coddis = dt.disdtu
             where r.desres ~ '^[0-9]+' group by 1, 2, 3, 4, 5`, [codava]);
}
async function notasGerais(codava) {
  return q(`select c.codcur, n.grunot codgru, n.notnot, n.obsnot
              from tav_nota_grupo_aluno n join tav_grupo g on g.codgru = n.grunot and g.avagru = $1
              ${CURSO_DE_MATRICULA.replace('%M%', 'n.matnot')}`, [codava]);
}
async function notasDisciplina(codava) {
  return q(`select c.codcur, n.grunot codgru, n.pronot codpro, n.hisnot, n.notnot, n.obsnot, trim(d.nomdis) disciplina
              from tav_nota_historico_aluno n join tav_grupo g on g.codgru = n.grunot and g.avagru = $1
              join tac_historico h on h.codhis = n.hisnot
              ${CURSO_DE_MATRICULA.replace('%M%', 'h.mathis')}
              left join tac_disciplina_turma dt on dt.coddtu = h.dtuhis
              left join tac_disciplina d on d.coddis = dt.disdtu`, [codava]);
}
async function nomesProfessores(ids) {
  if (!ids.length) return new Map();
  // um professor tem vários códigos (codpro) no Edubox, um por vínculo/curso: a pessoa é o funpro
  const r = await q(`select p.codpro, f.codfun pessoa, trim(f.nomfun) nome from tac_professor p join trh_funcionario f on f.codfun = p.funpro where p.codpro = any($1)`, [ids]);
  return new Map(r.map(x => [x.codpro, { pessoa: x.pessoa, nome: x.nome }]));
}

// ---- Docentes (P) e Administrativo (O): respondem sobre a instituição (dimensões G) e, os docentes,
// também sobre o próprio curso e o coordenador (dimensão C, por curso). Ligados ao funcionário, não à matrícula.
async function respostasPublico(codava) {
  const g = await q(`select null::text codcur, r.queres codque, (regexp_match(r.desres, '^([0-9]+)'))[1]::int op, count(*)::int n
                       from tav_resp_grupo_prof r join tav_questao qq on qq.codque = r.queres
                       join tav_grupo g on g.codgru = qq.gruque and g.avagru = $1
                      where r.desres ~ '^[0-9]+' group by 1, 2, 3`, [codava]);
  const c = await q(`select c.codcur, r.queres codque, (regexp_match(r.desres, '^([0-9]+)'))[1]::int op, count(*)::int n
                       from tav_resp_curso_prof r join tav_questao qq on qq.codque = r.queres
                       join tav_grupo g on g.codgru = qq.gruque and g.avagru = $1
                       join tac_curso c on c.codcur = r.curres
                      where r.desres ~ '^[0-9]+' group by 1, 2, 3`, [codava]);
  return [...g, ...c];
}
async function notasPublico(codava) {
  const g = await q(`select null::text codcur, n.grunot codgru, n.notnot, n.obsnot
                       from tav_nota_grupo_prof n join tav_grupo g on g.codgru = n.grunot and g.avagru = $1`, [codava]);
  const c = await q(`select c.codcur, n.grunot codgru, n.notnot, n.obsnot
                       from tav_nota_curso_prof n join tav_grupo g on g.codgru = n.grunot and g.avagru = $1
                       join tac_curso c on c.codcur = n.curnot`, [codava]);
  return [...g, ...c];
}
async function respondentesPublico(codava) {
  const r = await q(`select count(distinct propar)::int n from tav_part_professor where avapar = $1`, [codava]);
  return r[0].n;
}
// funcionários que responderam, por cargo cadastrado no Edubox (só contagem; ninguém identificado)
async function respondentesPorCargo(codava) {
  const r = await q(`select coalesce(nullif(trim(c.nomcar), ''), 'Sem cargo cadastrado') cargo, count(distinct pp.propar)::int n
                       from tav_part_professor pp join trh_funcionario f on f.codfun = pp.propar
                       left join trh_cargo c on c.codcar = f.carfun where pp.avapar = $1 group by 1 order by 2 desc, 1`, [codava]);
  return r.map(x => ({ cargo: x.cargo, n: x.n }));
}
// universo dos docentes = professores avaliados pelos alunos na campanha de alunos do mesmo ciclo
async function docentesAvaliados(codavaAluno) {
  const r = await q(`select distinct p.funpro pessoa from tac_professor p
                      where p.codpro in (select r.prores from tav_resp_historico_aluno r join tav_questao qq on qq.codque = r.queres
                                          join tav_grupo g on g.codgru = qq.gruque and g.avagru = $1 where r.prores is not null)`, [codavaAluno]);
  return r.length;
}

// ---------------------------------------------------------------- montagem
function distDe(linhas) { const d = [0, 0, 0, 0, 0]; linhas.forEach(l => { if (l.op >= 1 && l.op <= 5) d[l.op - 1] += l.n; }); return d; }

function montarRelatorio(camp, codcur, nomeCurso, dims, rg, rd, ng, nd, partic, publico = 'A') {
  const emEscopo = (x) => codcur === 'IES' || x.codcur === codcur;
  const geral = rg.filter(emEscopo), disc = rd.filter(emEscopo);
  const notasG = ng.filter(emEscopo), notasD = nd.filter(emEscopo);
  return {
    codava: camp.codava, ciclo: camp.ciclo, semestre: camp.semestre, segmento: camp.segmento, codcur, nome: nomeCurso,
    campanha: camp.descricao, publico, participacao: partic,
    dimensoes: dims.filter(d => publico === 'A' || codcur === 'IES' || d.tipo === 'C').map(d => {
      const eDisc = d.tipo === 'D' && publico === 'A';
      const nots = (eDisc ? notasD : notasG).filter(x => x.codgru === d.codgru);
      const validas = nots.map(x => notaValida(x.notnot)).filter(x => x !== null);
      const coment = nots.map(x => comentarioDe(x.obsnot)).filter(Boolean);
      return {
        codgru: d.codgru, numero: d.numero, eixo: d.eixo, nome: d.nome, tipo: d.tipo,
        nota: { media: media(validas), n: validas.length, avaliacoes: nots.length },
        perguntas: d.perguntas.map(p => {
          const dist = distDe((eDisc ? disc : geral).filter(x => x.codque === p.codque));
          return { codque: p.codque, texto: p.texto, dist, validas: dist[0] + dist[1] + dist[2] + dist[3], satisfacao: satisfacao(dist) };
        }),
        comentarios: coment.slice(0, codcur === 'IES' ? 300 : 500)
      };
    })
  };
}

function montarProfessores(camp, codcur, nomeCurso, dims, rd, nd, nomes) {
  const dimsD = dims.filter(d => d.tipo === 'D');
  const perguntasD = dimsD.flatMap(d => d.perguntas.map(p => ({ ...p, dim: d })));
  const notasCurso = nd.filter(x => x.codcur === codcur);
  const respCurso = rd.filter(x => x.codcur === codcur);
  const ids = [...new Set(notasCurso.map(x => x.codpro).filter(Boolean))];
  const baseCurso = {}; perguntasD.forEach(p => { baseCurso[p.codque] = satisfacao(distDe(respCurso.filter(x => x.codque === p.codque))); });
  return ids.map(codpro => {
    const nots = notasCurso.filter(x => x.codpro === codpro);
    const resp = respCurso.filter(x => x.codpro === codpro);
    const validas = nots.map(x => notaValida(x.notnot)).filter(x => x !== null);
    const distTotal = distDe(resp);
    const porDisc = new Map();
    nots.forEach(x => { const k = x.disciplina || '(sem disciplina)'; const o = porDisc.get(k) || { disciplina: k, notas: [], n: 0, his: new Set() }; o.n++; o.his.add(x.hisnot); const v = notaValida(x.notnot); if (v !== null) o.notas.push(v); porDisc.set(k, o); });
    const discDe = (x) => x.disciplina || '(sem disciplina)';
    return {
      codava: camp.codava, ciclo: camp.ciclo, semestre: camp.semestre, segmento: camp.segmento, codcur, curso: nomeCurso,
      codpro, nome: nomes.get(codpro) || `Professor ${codpro}`,
      avaliacoes: nots.length, respondentes: new Set(nots.map(x => x.hisnot)).size, nota: { media: media(validas), n: validas.length },
      satisfacao: satisfacao(distTotal), dist: distTotal,
      dimensoes: dimsD.map(d => {
        const nn = nots.filter(x => x.codgru === d.codgru).map(x => notaValida(x.notnot)).filter(x => x !== null);
        return { codgru: d.codgru, nome: d.nome, nota: media(nn), n: nn.length };
      }).filter(d => d.n > 0),
      perguntas: perguntasD.map(p => {
        const dist = distDe(resp.filter(x => x.codque === p.codque));
        return { codque: p.codque, texto: p.texto, dim: p.dim.nome, dist, validas: dist[0] + dist[1] + dist[2] + dist[3], satisfacao: satisfacao(dist), cursoSatisfacao: baseCurso[p.codque] };
      }).filter(p => p.validas > 0),
      disciplinas: [...porDisc.values()].map(o => {
        const rd2 = resp.filter(x => discDe(x) === o.disciplina);
        const dist = distDe(rd2);
        return {
          disciplina: o.disciplina, avaliacoes: o.n, respondentes: o.his.size, nota: media(o.notas), dist, satisfacao: satisfacao(dist),
          perguntas: perguntasD.map(p => { const dd = distDe(rd2.filter(x => x.codque === p.codque)); return { codque: p.codque, dist: dd, validas: dd[0] + dd[1] + dd[2] + dd[3], satisfacao: satisfacao(dd) }; }).filter(p => p.validas > 0)
        };
      }).sort((a, b) => b.respondentes - a.respondentes),
      comentarios: nots.map(x => { const c = comentarioDe(x.obsnot); return c && { ...c, disciplina: discDe(x) }; }).filter(Boolean)
    };
  });
}

async function processar(camp, { dry, db }) {
  const dims = await dimensoes(camp.codava);
  const [partic, rg, rd, ng, nd] = await Promise.all([participacao(camp), respostasGerais(camp.codava), respostasDisciplina(camp.codava), notasGerais(camp.codava), notasDisciplina(camp.codava)]);
  const profIds = [...new Set([...rd.map(x => x.codpro), ...nd.map(x => x.codpro)].filter(Boolean))];
  const pessoas = await nomesProfessores(profIds);
  const nomes = new Map();
  const pessoaDe = (cod) => { const p = pessoas.get(cod); if (!p) return cod; nomes.set(p.pessoa, p.nome); return p.pessoa; };
  rd.forEach(x => { if (x.codpro) x.codpro = pessoaDe(x.codpro); });   // daqui em diante codpro = pessoa (funpro)
  nd.forEach(x => { if (x.codpro) x.codpro = pessoaDe(x.codpro); });
  const cursos = partic.map(p => ({ codcur: p.codcur, nome: p.nome, ativos: Number(p.ativos), responderam: Number(p.responderam) }));
  const totPart = { ativos: soma(cursos.map(c => c.ativos)), responderam: soma(cursos.map(c => c.responderam)) };

  const relatorios = [montarRelatorio(camp, 'IES', camp.segmento === 'MED' ? 'Medicina' : 'Graduação (todos os cursos)', dims, rg, rd, ng, nd, totPart)];
  const professores = [];
  for (const c of cursos) {
    relatorios.push(montarRelatorio(camp, c.codcur, c.nome, dims, rg, rd, ng, nd, { ativos: c.ativos, responderam: c.responderam }));
    professores.push(...montarProfessores(camp, c.codcur, c.nome, dims, rd, nd, nomes));
  }
  // ---- Docentes e Administrativo do mesmo ciclo
  const outros = [];
  const universoDocentes = await docentesAvaliados(camp.codava);
  const cfgSnap = db ? await db.collection('config').doc('cpa').get() : null;
  const universoAdm = cfgSnap && cfgSnap.exists ? Number(cfgSnap.data().universoAdministrativo) || null : null;
  for (const [pub, meta] of [['P', camp.docente], ['O', camp.admin]]) {
    if (!meta) continue;
    const c2 = { ...camp, codava: meta.codava, descricao: meta.descricao };
    const dimsP = await dimensoes(meta.codava);
    const [rP, nP, resp] = await Promise.all([respostasPublico(meta.codava), notasPublico(meta.codava), respondentesPublico(meta.codava)]);
    const universo = pub === 'P' ? universoDocentes : universoAdm;
    const partP = { universo, responderam: resp };
    if (pub === 'O') partP.porCargo = await respondentesPorCargo(meta.codava);
    outros.push(montarRelatorio(c2, 'IES', camp.segmento === 'MED' ? 'Medicina' : 'Graduação (todos os cursos)', dimsP, rP, [], nP, [], partP, pub));
    if (pub === 'P') {
      for (const c of cursos) {
        const rel = montarRelatorio(c2, c.codcur, c.nome, dimsP, rP, [], nP, [], partP, pub);
        if (rel.dimensoes.some(d => d.perguntas.some(p => p.validas > 0))) outros.push(rel);
      }
    }
    meta.respondentes = resp; meta.universo = universo;
  }
  relatorios.push(...outros);
  const ciclo = {
    id: camp.ciclo, semestre: camp.semestre, segmento: camp.segmento, codavaAluno: camp.codava, campanhaAluno: camp.descricao,
    aberta: /^s/i.test(camp.ativa), cursos, participacao: totPart, escala: OPCOES,
    docentes: camp.docente || null, administrativo: camp.admin || null, atualizadoEm: new Date().toISOString()
  };
  if (!dry) {
    const col = (n) => db.collection(n);
    await col('cpa_ciclos').doc(ciclo.id).set(ciclo, { merge: true });
    for (const r of relatorios) await col('cpa_relatorios').doc(`${r.codava}__${r.codcur}`).set(r);
    // apaga professores antigos deste curso/campanha antes de regravar (não deixa lixo de rodadas anteriores)
    const antigos = await col('cpa_professores').where('codava', '==', camp.codava).get();
    for (let i = 0; i < antigos.docs.length; i += 400) { const b = db.batch(); antigos.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
    for (let i = 0; i < professores.length; i += 300) {
      const b = db.batch();
      professores.slice(i, i + 300).forEach(p => b.set(col('cpa_professores').doc(`${camp.codava}__${p.codcur}__${p.codpro}`), p));
      await b.commit();
    }
  }
  return { ciclo, relatorios, professores };
}

async function sincronizar({ codavas = [], dry = false } = {}) {
  const todas = await campanhas();
  const semNorm = (s) => s.replace('/', '-');
  const alunos = todas.filter(c => c.tipava === 'A');
  let alvo;
  if (codavas.length) alvo = alunos.filter(c => codavas.includes(c.codava));
  else alvo = ['GRA', 'MED'].map(seg => alunos.find(c => c.segmento === seg)).filter(Boolean);
  alvo.forEach(a => {
    a.ciclo = `${semNorm(a.semestre)}-${a.segmento}`;
    const mesmo = (c) => c.segmento === a.segmento && semNorm(c.semestre) === semNorm(a.semestre);
    const d = todas.find(c => c.tipava === 'P' && mesmo(c)), o = todas.find(c => c.tipava === 'O' && mesmo(c));
    a.docente = d ? { codava: d.codava, descricao: d.descricao, aberta: /^s/i.test(d.ativa) } : null;
    a.admin = o ? { codava: o.codava, descricao: o.descricao, aberta: /^s/i.test(o.ativa) } : null;
  });
  const { db } = require(path.join(RAIZ, 'src', 'firebase'));
  const saidas = [];
  for (const camp of alvo) saidas.push(await processar(camp, { dry, db }));
  return saidas;
}

module.exports = { sincronizar };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const codavas = args.filter(a => /^\d+$/.test(a)).map(Number);
  sincronizar({ codavas, dry }).then(saidas => {
    for (const { ciclo, relatorios, professores } of saidas) {
      console.log(`\n== ${ciclo.id} · ${ciclo.campanhaAluno} (campanha ${ciclo.codavaAluno}${ciclo.aberta ? ', ABERTA' : ''})`);
      console.log(`   participação: ${ciclo.participacao.responderam}/${ciclo.participacao.ativos} alunos ativos (${ciclo.participacao.ativos ? Math.round(ciclo.participacao.responderam / ciclo.participacao.ativos * 100) : 0}%)  | docentes: ${ciclo.docentes ? ciclo.docentes.descricao : '—'} | administrativo: ${ciclo.administrativo ? ciclo.administrativo.descricao : '—'}`);
      console.log(`   ${relatorios.length} relatórios (IES + ${ciclo.cursos.length} cursos), ${professores.length} avaliações de professor por curso`);
      ciclo.cursos.forEach(c => console.log(`     ${c.codcur.padEnd(9)} ${String(c.responderam).padStart(4)}/${String(c.ativos).padEnd(4)} ${c.nome}`));
    }
    console.log(dry ? '\nSIMULAÇÃO — nada gravado' : '\nGravado no Firestore');
    process.exit(0);
  }).catch(e => { console.error('ERRO:', e); process.exit(1); });
}
