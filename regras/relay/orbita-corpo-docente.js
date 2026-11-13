// =====================================================================================================
// ÓRBITA — corpo docente por curso (/corpo-docente/*) no relay do Edubox (09/11/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs. Instalação:
// regras/relay/instalar-corpo-docente.sh. Usado pela aba "Titulação" das Matrizes (relatório do diretor:
// doutores / mestres / especialistas por curso).
//
// GET /corpo-docente/lista?semestres=2026/2,2026-2
//   Uma linha por curso + professor com diário (tac_professor) nas turmas do semestre: código do curso,
//   código e nome do professor, titulação (tac_professor.titpro) e quantos diários ele tem no curso.
//   Só leitura; sem CPF.
//
// GET /corpo-docente/diarios?semestres=2026/2,2026-2&curso=MED   (v2, 12/11/2026)
//   Um diário por linha: disciplina, sigla, turma, período e o professor (nome, titulação). Provas da Medicina.
//
// GET /corpo-docente/plano?semestres=2026/2&curso=MED  ou  ?coddtu=123,456   (v3, 12/11/2026)
//   Plano de ensino dos diários: campos do formulário (tac_planoensino_frm), texto de cada campo
//   (tac_planoensino_dados) e conteúdos com unidade e carga horária (tac_planoconteudo). Usa novoClient() e autenticadoOrbita(req) que já existem no server.mjs.
// =====================================================================================================

function cdResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

async function cdLista(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '30s';");
    const r = await client.query(`
      select trim(c.codcur) as codcur, f.codfun, trim(f.nomfun) as nome,
             trim(coalesce(max(p.titpro), '')) as titulacao, count(distinct dt.coddtu)::int as diarios
        from tac_professor p
        join trh_funcionario f on f.codfun = p.funpro
        join tac_disciplina_turma dt on dt.coddtu = p.dtupro
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
       where t.semtur = any($1)
       group by 1, 2, 3
       order by 1, 3`, [semestres]);
    return { ok: true, professores: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function cdDiarios(semestres, curso) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '30s';");
    const r = await client.query(`
      select dt.coddtu, trim(c.codcur) as codcur, trim(t.nomtur) as turma, t.pertur as periodo, t.semtur as sem,
             d.coddis, trim(d.nomdis) as disciplina, trim(d.noadis) as sigla,
             f.codfun, trim(f.nomfun) as nome, trim(coalesce(p.titpro, '')) as titulacao
        from tac_professor p
        join trh_funcionario f on f.codfun = p.funpro
        join tac_disciplina_turma dt on dt.coddtu = p.dtupro
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
        join tac_disciplina d on d.coddis = dt.disdtu
       where t.semtur = any($1) and ($2 = '' or trim(c.codcur) = $2)
       order by t.pertur, d.nomdis, f.nomfun`, [semestres, curso]);
    return { ok: true, diarios: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function cdPlano(semestres, curso, coddtus) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '30s';");
    const dts = await client.query(`
      select dt.coddtu, trim(c.codcur) as codcur, trim(t.nomtur) as turma, t.pertur as periodo, t.semtur as sem,
             d.coddis, trim(d.nomdis) as disciplina, trim(d.noadis) as sigla
        from tac_disciplina_turma dt
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
        join tac_disciplina d on d.coddis = dt.disdtu
       where (cardinality($3::int[]) > 0 and dt.coddtu = any($3::int[]))
          or (cardinality($3::int[]) = 0 and t.semtur = any($1) and ($2 = '' or trim(c.codcur) = $2))
       order by t.pertur, d.nomdis
       limit 300`, [semestres, curso, coddtus]);
    const ids = dts.rows.map(x => x.coddtu);
    if (!ids.length) return { ok: true, diarios: [], campos: [], dados: [], conteudos: [] };
    const campos = await client.query(`select codpef, trim(nompef) as nome, ordpef as ordem, trim(coalesce(tippef::text, '')) as tipo from tac_planoensino_frm order by ordpef, codpef`);
    const dados = await client.query(`select dtuped as coddtu, pefped as codpef, txtped::text as texto from tac_planoensino_dados where dtuped = any($1::int[]) order by dtuped, pefped`, [ids]);
    const cont = await client.query(`select dtupco as coddtu, codpco, trim(coalesce(unipco::text, '')) as unidade, trim(coalesce("_unipco"::text, '')) as unidade2, conpco::text as conteudo, chopco::text as ch from tac_planoconteudo where dtupco = any($1::int[]) order by dtupco, codpco`, [ids]);
    return { ok: true, diarios: dts.rows, campos: campos.rows, dados: dados.rows, conteudos: cont.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaCorpoDocente(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/corpo-docente/')) return false;
  if (!autenticadoOrbita(req)) { cdResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { cdResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/corpo-docente/ping') { cdResponder(res, 200, { ok: true, rotas: 'corpo-docente', versao: 3 }); return true; }
  if (u.pathname === '/corpo-docente/lista') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { cdResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await cdLista(semestres);
    cdResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/corpo-docente/diarios') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    const curso = String(u.searchParams.get('curso') || '').trim().toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
    if (!semestres.length) { cdResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await cdDiarios(semestres, curso);
    cdResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/corpo-docente/plano') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    const curso = String(u.searchParams.get('curso') || '').trim().toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
    const coddtus = String(u.searchParams.get('coddtu') || '').split(',').map(s => parseInt(s, 10)).filter(n => n > 0).slice(0, 300);
    if (!semestres.length && !coddtus.length) { cdResponder(res, 400, { ok: false, erro: 'informe semestres ou coddtu' }); return true; }
    const r = await cdPlano(semestres, curso, coddtus);
    cdResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  cdResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
