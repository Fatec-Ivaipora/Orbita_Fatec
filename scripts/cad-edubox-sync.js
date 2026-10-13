// ==========================================================================
// Sincronização Edubox -> Órbita (módulo CADD — Conselho Acadêmico de Desempenho Discente).
//
// O Edubox (Postgres na nuvem do fornecedor) só aceita conexão do IP da Fatec. Este script roda num
// PC da Fatec, SÓ LÊ o Edubox e grava no Firestore, por turma, a nota e as faltas de cada aluno ATIVO
// em cada disciplina, separadas por bimestre:
//
//   cad_ciclos/{semestre}            semestre (2026.2 / 2026-2 da Medicina), bimestres e lista de turmas
//   cad_turmas/{semestre}__{codtur}  alunos x disciplinas: nota do bimestre, composição (de qual
//                                    avaliação veio cada parte), faltas no semestre, professor
//   cad_alunos/{codalu}              desempenho do aluno bimestre a bimestre, em todos os semestres
//                                    sincronizados (gráfico) — chave = código do ALUNO, que não muda
//                                    de um semestre pro outro (a matrícula muda)
//
// Regras (definidas com a coordenação, 13/10/2026):
//  - Nota do bimestre = soma das notas das avaliações daquele bimestre (o Edubox lança tudo como
//    "SOMATÓRIO", de 0 a 10) — e SÓ quando todas as avaliações do bimestre já têm nota, igual à
//    coluna 1B da "Planilha de Notas" do Edubox (conferido em 13/10/2026 com Agronomia). Com
//    avaliação faltando, fica sem nota (guardamos a soma parcial à parte, só como informação).
//  - "Nota vermelha" = abaixo de 7,0 — aplicada na tela (o script só grava os números).
//  - Faltas = campo de faltas do histórico (falhis), o mesmo da coluna FT da Planilha de Notas:
//    total da disciplina no semestre até hoje (o Edubox não separa por bimestre).
//  - Só matrícula Ativo. Disciplina de outra turma (DP) aparece marcada.
//  - Tipo da disciplina (igual ao módulo Matrizes): "A Distância" com carga síncrona mediada = SÍNCRONA;
//    "A Distância" sem ela = EAD; o resto = PRESENCIAL. EAD não tem falta (o que vier do Edubox é
//    ignorado); síncrona e presencial têm.
//  - Sem semestre informado: o atual e os 3 anteriores (Graduação e Medicina) — dá o histórico do gráfico.
//
// Uso: node scripts/cad-edubox-sync.js                (semestre atual, Graduação e Medicina)
//      node scripts/cad-edubox-sync.js 2026/2 2026-2  (semestres do Edubox)
//      node scripts/cad-edubox-sync.js --dry          (não grava, só resume)
// ==========================================================================
const path = require('path');
const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const edubox = require(path.join(RAIZ, 'src', 'db-edubox'));

const q = (sql, p) => edubox.query(sql, p).then(r => r.rows);
const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const r2 = (v) => Math.round(v * 100) / 100;

function semestresAtuais(quantos = 4) {
  const d = new Date();
  let ano = d.getFullYear(), n = d.getMonth() < 6 ? 1 : 2;
  const lista = [];
  for (let i = 0; i < quantos; i++) {
    lista.push(`${ano}/${n}`, `${ano}-${n}`);   // graduação e medicina
    if (n === 2) n = 1; else { n = 2; ano--; }
  }
  return lista;
}
const paraOrbita = (sem) => sem.replace('/', '.');   // 2026/2 -> 2026.2 ; 2026-2 continua 2026-2 (Medicina)

const SQL_BASE = `
  select tm.codtur, trim(tm.nomtur) turma, trim(tm.curtur) codcur, trim(cu.descur) curso, tm.pertur periodo,
         m.codmat, a.codalu alu, trim(cl.nomcli) nome, h.codhis, coalesce(h.falhis, 0) faltas, dt.coddtu, trim(d.nomdis) disciplina,
         (dt.turdtu <> m.turmat) dp, trim(d.tipdis) tipdis, coalesce(d.chosmedis, 0) sinc,
         (select string_agg(distinct trim(f.nomfun), ', ') from tac_professor p join trh_funcionario f on f.codfun = p.funpro
           where p.dtupro = dt.coddtu) professor
    from tac_historico h
    join tac_matricula m on m.codmat = h.mathis and m.stamat = 'Ativo'
    join tac_turma tm on tm.codtur = m.turmat
    join tac_curso cu on cu.codcur = tm.curtur
    join tac_disciplina_turma dt on dt.coddtu = h.dtuhis
    join tac_disciplina d on d.coddis = dt.disdtu
    join tac_aluno a on a.codalu = m.alumat
    join tfi_cliente cl on cl.codcli = a.clialu
   where tm.semtur = $1`;

// Turmas que estudam juntas (mesma regra do módulo Matrizes): no curso de Tecnologia todos os períodos
// estudam juntos; nos demais, pares de períodos vizinhos com 60% ou mais das disciplinas em comum
// (matriz rotativa). Cada turma entra em no máximo um par. Usado na Correção de Provas pra imprimir
// as folhas de quem faz a prova junto. t.grupo = id da primeira turma do grupo.
function marcarGrupos(lista) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const porCurso = new Map();
  lista.forEach(t => { t.grupo = t.id; (porCurso.get(t.codcur) || porCurso.set(t.codcur, []).get(t.codcur)).push(t); });
  for (const ts of porCurso.values()) {
    const regulares = ts.filter(t => !/^DP\b/i.test(t.turma) && [...t.disciplinas.values()].some(d => !d.dp)).sort((a, b) => a.periodo - b.periodo);
    if (/SUPERIOR DE TECNOLOGIA/i.test(ts[0].curso)) { regulares.forEach(t => { t.grupo = regulares[0].id; }); continue; }
    const nomes = regulares.map(t => new Set([...t.disciplinas.values()].filter(d => !d.dp).map(d => norm(d.nome))));
    const arestas = [];
    regulares.forEach((a, i) => {
      const j = regulares.findIndex(t => t.periodo === a.periodo + 1);
      if (j < 0) return;
      const inter = [...nomes[i]].filter(x => nomes[j].has(x)).length, menor = Math.min(nomes[i].size, nomes[j].size);
      const score = menor >= 2 ? inter / menor : 0;
      if (score >= 0.6) arestas.push({ i, j, score, impar: a.periodo % 2 === 1, p: a.periodo });
    });
    arestas.sort((x, y) => y.score - x.score || Number(y.impar) - Number(x.impar) || x.p - y.p);
    const usado = new Set();
    arestas.forEach(e => { if (usado.has(e.i) || usado.has(e.j)) return; usado.add(e.i); usado.add(e.j); regulares[e.j].grupo = regulares[e.i].id; });
  }
}

async function sincronizarSemestre(semEdubox, db, dry) {
  const fases = await q(`select codfas, trim(nomfas) nome, dinfas::date ini, dfifas::date fim from tac_faseletiva where semfas = $1 order by codfas`, [semEdubox]);
  if (!fases.length) { console.log(`${semEdubox}: sem bimestres cadastrados — pulei`); return null; }
  const ids = fases.map(f => f.codfas);
  const [base, notas, avaliacoes, aulas] = await Promise.all([
    q(SQL_BASE, [semEdubox]),
    // cada nota com a avaliação de onde vem (TRABALHOS, SIMULADO, AV. BIMESTRAL, TRILHAS EAD...)
    q(`select n.hisnot his, a.fasava fas, a.codava, n.notnot nota
         from tac_nota n join tac_avaliacao a on a.codava = n.avanot
        where a.fasava = any($1)`, [ids]),
    q(`select a.dtuava dtu, a.fasava fas, a.codava, trim(a.desava) nome, a.datava::date data
         from tac_avaliacao a join tac_disciplina_turma dt on dt.coddtu = a.dtuava join tac_turma t on t.codtur = dt.turdtu
        where a.fasava = any($1) and t.semtur = $2 order by a.datava, a.codava`, [ids, semEdubox]),
    q(`select dturea dtu, fasrea fas, count(*) aulas from tac_regaula where fasrea = any($1) group by 1, 2`, [ids])
  ]);
  const notaDe = new Map(notas.map(n => [`${n.his}|${n.codava}`, n.nota === null ? null : Number(n.nota)]));
  // avaliações de cada disciplina por bimestre, na ordem de data
  const avsDe = new Map();
  for (const a of avaliacoes) { const k = `${a.dtu}|${a.fas}`; (avsDe.get(k) || avsDe.set(k, []).get(k)).push({ id: a.codava, nome: limpa(a.nome) }); }
  const aulasDe = new Map(aulas.map(a => [`${a.dtu}|${a.fas}`, Number(a.aulas)]));

  const sem = paraOrbita(semEdubox);
  const segmento = /-/.test(semEdubox) ? 'MED' : 'GRA';
  const turmas = new Map();
  for (const l of base) {
    const t = turmas.get(l.codtur) || turmas.set(l.codtur, {
      id: `${sem}__${l.codtur}`, semestre: sem, segmento, codtur: l.codtur, turma: limpa(l.turma), codcur: l.codcur,
      curso: limpa(l.curso), periodo: l.periodo, alunos: new Map(), disciplinas: new Map()
    }).get(l.codtur);
    if (!t.disciplinas.has(l.coddtu)) {
      const aulasFase = {};
      for (const f of ids) aulasFase[f] = aulasDe.get(`${l.coddtu}|${f}`) || 0;
      const avs = {};
      for (const f of ids) avs[f] = (avsDe.get(`${l.coddtu}|${f}`) || []).map(a => a.nome);
      // estágio é presencial no Edubox: ganha etiqueta própria (tem falta, como síncrona e presencial)
      const modal = /EST[AÁ]GIO/i.test(l.disciplina || '') ? 'estagio' : /dist/i.test(l.tipdis || '') ? (Number(l.sinc) > 0 ? 'sincrona' : 'ead') : 'presencial';
      t.disciplinas.set(l.coddtu, { id: l.coddtu, nome: limpa(l.disciplina), professor: limpa(l.professor) || '', dp: !!l.dp, modal, aulas: aulasFase, avs });
    }
    const al = t.alunos.get(l.codmat) || t.alunos.set(l.codmat, { id: l.codmat, alu: l.alu, nome: limpa(l.nome), d: [] }).get(l.codmat);
    const porFase = {};
    for (const f of ids) {
      const avs = avsDe.get(`${l.coddtu}|${f}`) || [];
      const c = avs.map(a => { const v = notaDe.get(`${l.codhis}|${a.id}`); return v === undefined || v === null ? null : r2(v); });   // nota de cada avaliação, na ordem de disciplina.avs
      const lanc = c.filter(v => v !== null);
      const soma = r2(lanc.reduce((s2, v) => s2 + v, 0));
      const completa = avs.length > 0 && lanc.length === avs.length;
      porFase[f] = {
        n: completa ? soma : null,                         // nota do bimestre (igual ao 1B do Edubox)
        p: !completa && lanc.length ? soma : null,         // soma parcial, avaliação faltando
        l: lanc.length, t: avs.length, c
      };
    }
    const ead = t.disciplinas.get(l.coddtu).modal === 'ead';
    al.d.push({ id: l.coddtu, ft: ead ? 0 : (Number(l.faltas) || 0), f: porFase });   // EAD não tem falta
  }

  const agora = new Date().toISOString();
  const lista = [...turmas.values()].sort((a, b) => a.turma.localeCompare(b.turma, 'pt-BR'));
  marcarGrupos(lista);
  const ciclo = {
    id: sem, semestre: sem, semEdubox, segmento, atualizadoEm: agora,
    fases: fases.map(f => ({ id: f.codfas, nome: limpa(f.nome).replace('°', 'º'), ini: new Date(f.ini).toISOString().slice(0, 10), fim: new Date(f.fim).toISOString().slice(0, 10) })),
    turmas: lista.map(t => ({ id: t.id, turma: t.turma, codcur: t.codcur, curso: t.curso, periodo: t.periodo, alunos: t.alunos.size, grupo: t.grupo }))
  };
  console.log(`${semEdubox}: ${lista.length} turmas, ${lista.reduce((s, t) => s + t.alunos.size, 0)} alunos ativos, ${base.length} aluno x disciplina, bimestres ${ciclo.fases.map(f => f.nome).join(' / ')}`);
  ciclo._turmas = lista;   // pro histórico por aluno (não vai pro Firestore)
  if (dry || !db) return ciclo;

  const { _turmas, ...cicloGravar } = ciclo;
  await db.collection('cad_ciclos').doc(sem).set(cicloGravar);
  for (let i = 0; i < lista.length; i += 20) {
    const b = db.batch();
    lista.slice(i, i + 20).forEach(t => b.set(db.collection('cad_turmas').doc(t.id), {
      id: t.id, semestre: sem, segmento, codtur: t.codtur, turma: t.turma, codcur: t.codcur, curso: t.curso, periodo: t.periodo,
      fases: ciclo.fases, disciplinas: [...t.disciplinas.values()],
      alunos: [...t.alunos.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')), atualizadoEm: agora
    }));
    await b.commit();
  }
  return ciclo;
}

// Desempenho de cada aluno por bimestre (média das notas completas, quantas vermelhas, faltas no
// semestre) — vai pra cad_alunos/{codalu}.p["2026.2|114"], com merge: rodar só o semestre atual
// não apaga os pontos dos semestres anteriores.
function pontosPorAluno(ciclos) {
  const alunos = new Map();
  for (const c of ciclos) for (const t of c._turmas) for (const a of t.alunos.values()) {
    if (!a.alu) continue;
    const x = alunos.get(a.alu) || alunos.set(a.alu, { alu: a.alu, nome: a.nome, codcur: t.codcur, curso: t.curso, ultimo: '', p: {} }).get(a.alu);
    if (c.semestre >= x.ultimo) { x.ultimo = c.semestre; x.nome = a.nome; x.codcur = t.codcur; x.curso = t.curso; x.turma = t.turma; }
    const faltas = a.d.reduce((s2, d) => s2 + (d.ft || 0), 0);
    for (const f of c.fases) {
      const notas = a.d.map(d => (d.f[f.id] || {}).n).filter(n => n !== null && n !== undefined);
      if (!notas.length) continue;
      x.p[`${c.semestre}|${f.id}`] = {
        sem: c.semestre, fase: f.id, nome: f.nome, ini: f.ini,
        media: r2(notas.reduce((s2, n) => s2 + n, 0) / notas.length),
        vermelhas: notas.filter(n => n < 7).length, comNota: notas.length, disciplinas: a.d.length, faltas
      };
    }
  }
  return [...alunos.values()];
}

// Vida acadêmica: média final e reprovações de cada semestre cursado DESDE O INGRESSO ATUAL do aluno
// (pedido da coordenação, 13/10/2026): cada matrícula do Edubox aponta pro seu ingresso (tac_ingresso,
// com semestre e forma de entrada); quem já estudou antes e se matriculou de novo tem outro ingresso,
// e essa passagem anterior não entra. Só quem está ativo nos semestres sincronizados.
// Vai pra cad_alunos/{codalu}.s["2024/1"] e .ingresso.
async function trajetoria(semestres) {
  const linhas = await q(`
    with alunos as (   -- ingresso da matrícula ativa mais recente de cada aluno
      select distinct on (m.alumat) m.alumat, m.ingmat from tac_matricula m join tac_turma t on t.codtur = m.turmat
       where t.semtur = any($1) and m.stamat = 'Ativo' and m.ingmat is not null
       order by m.alumat, replace(t.semtur, '-', '/') desc)
    select m.alumat alu, replace(t.semtur, '-', '/') sem, count(*) disciplinas,
           round(avg(h.medhis::numeric) filter (where h.medhis::numeric between 0 and 10), 2) media,
           count(*) filter (where h.medhis::numeric between 0 and 10) com_media,
           count(*) filter (where h.reshis ilike 'REP%') reprov,
           string_agg(distinct trim(cu.descur), ' / ') curso
      from tac_historico h
      join tac_matricula m on m.codmat = h.mathis
      join alunos a on a.alumat = m.alumat and m.ingmat = a.ingmat
      join tac_disciplina_turma dt on dt.coddtu = h.dtuhis
      join tac_turma t on t.codtur = dt.turdtu
      join tac_curso cu on cu.codcur = t.curtur
     group by 1, 2`, [semestres]);
  const ingressos = await q(`
    with alunos as (
      select distinct on (m.alumat) m.alumat, m.ingmat from tac_matricula m join tac_turma t on t.codtur = m.turmat
       where t.semtur = any($1) and m.stamat = 'Ativo' and m.ingmat is not null
       order by m.alumat, replace(t.semtur, '-', '/') desc)
    select a.alumat alu, trim(i.seming) sem, trim(i.foring) forma, i.dating::date data
      from alunos a join tac_ingresso i on i.coding = a.ingmat`, [semestres]);
  const porAluno = new Map();
  for (const g of ingressos) porAluno.set(g.alu, { _ingresso: { sem: limpa(g.sem).replace('-', '/'), forma: limpa(g.forma), data: g.data ? new Date(g.data).toISOString().slice(0, 10) : null } });
  for (const l of linhas) {
    const x = porAluno.get(l.alu) || porAluno.set(l.alu, {}).get(l.alu);
    x[l.sem] = { media: l.media === null ? null : Number(l.media), disciplinas: Number(l.disciplinas), comMedia: Number(l.com_media), reprov: Number(l.reprov), curso: limpa(l.curso) };
  }
  return porAluno;
}

async function sincronizar(semestres, { dry = false, origem = 'manual' } = {}) {
  const db = dry ? null : require(path.join(RAIZ, 'src', 'firebase')).db;
  const cfg = db && db.collection('config').doc('cad_sync');
  const t0 = Date.now();
  if (cfg) await cfg.set({ status: 'rodando', rodandoDesde: new Date().toISOString(), origemRodando: origem }, { merge: true });
  try {
    const feitos = await sincronizarTudo(semestres, db, dry);
    if (cfg) await cfg.set({ status: 'ok', ultimaAtualizacao: new Date().toISOString(), ultimaOrigem: origem, duracaoMs: Date.now() - t0, semestres: feitos, erro: null }, { merge: true });
    return feitos;
  } catch (err) {
    if (cfg) await cfg.set({ status: 'erro', erro: err.message, erroEm: new Date().toISOString() }, { merge: true }).catch(() => {});
    throw err;
  }
}

async function sincronizarTudo(semestres, db, dry) {
  const feitos = [], ciclos = [];
  for (const s of semestres) { const c = await sincronizarSemestre(s, db, dry); if (c) { feitos.push(c.id); ciclos.push(c); } }
  const alunos = pontosPorAluno(ciclos);
  const traj = await trajetoria(semestres);
  for (const a of alunos) { const t = traj.get(a.alu); if (t) { const { _ingresso, ...sems } = t; a.s = sems; a.ingresso = _ingresso || null; } }
  console.log(`histórico: ${alunos.length} alunos, ${alunos.reduce((s2, a) => s2 + Object.keys(a.p).length, 0)} bimestres com nota, ${alunos.reduce((s2, a) => s2 + Object.keys(a.s || {}).length, 0)} semestres na vida acadêmica`);
  if (db) {
    for (let i = 0; i < alunos.length; i += 400) {
      const b = db.batch();
      alunos.slice(i, i + 400).forEach(a => {
        const ref = db.collection('cad_alunos').doc(String(a.alu));
        const { s: sems, ...resto } = a;
        b.set(ref, { ...resto, atualizadoEm: new Date().toISOString() }, { merge: true });   // bimestres (p) somam aos já gravados
        b.update(ref, { s: sems || {} });                                                    // vida acadêmica: substitui inteira
      });
      await b.commit();
    }
  }
  return feitos;
}

module.exports = { sincronizar, semestresAtuais };

if (require.main === module) {
  const args = process.argv.slice(2);
  const sems = args.filter(a => !a.startsWith('--'));
  sincronizar(sems.length ? sems : semestresAtuais(), { dry: args.includes('--dry') })
    .then(f => { console.log('Concluído:', f.join(', ') || '(nada)'); process.exit(0); })
    .catch(e => { console.error('Falhou:', e.message); process.exit(1); });
}
