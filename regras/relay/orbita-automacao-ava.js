// =====================================================================================================
// ÓRBITA — rotas da Automação AVA (/automacao-ava/*) no relay do Edubox (26/10/2026; v2 com /salas).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs (o código do relay não fica
// no repositório do Órbita — ver regras/regra_do_app.md, seção 8). Instalação: regras/relay/instalar-automacao-ava.sh
//
// GET /automacao-ava/titulacoes?semestres=2026/2,2026-2,2026/1,...
//   Titulação dos professores (tac_professor.titpro: Especialização / Mestrado / Doutorado / Graduação)
//   nas salas da Fatec dos semestres pedidos, uma linha por professor + titulação + semestre.
//   O Órbita escolhe a mais recente e preenche a ficha da disciplina (valor pago pela titulação).
//
// GET /automacao-ava/salas?semestres=2027/1,2027-1
//   As salas (tac_disciplina_turma) do semestre com a sigla do AVA (tac_disciplina.noadis, sem trim:
//   o shortname do AVA = noadis + " - " + coddtu, com os espaços originais). Sem dado pessoal.
//   O Órbita monta o course.csv do Conduit e o CSV do "Carregar cursos" (templatecourse).
//
// Usa só o que já existe no server.mjs: novoClient() e autenticadoOrbita(req). Não mexe em rota, token
// nem função do SIGMA. Só leitura (usuário "consulta"), com JOIN até tac_curso.
// =====================================================================================================

function avaResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

async function avaTitulacoes(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select f.codfun, trim(f.nomfun) nome, trim(p.titpro) titulacao, t.semtur sem, count(*)::int salas
        from tac_professor p
        join trh_funcionario f on f.codfun = p.funpro
        join tac_disciplina_turma dt on dt.coddtu = p.dtupro
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
       where t.semtur = any($1) and coalesce(trim(p.titpro), '') <> ''
       group by 1, 2, 3, 4`, [semestres]);
    return { ok: true, professores: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function avaSalas(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select dt.coddtu, dt.turdtu codtur, trim(t.nomtur) turma, t.pertur periodo, t.semtur sem,
             t.curtur codcur, trim(c.descur) curso, d.coddis, trim(d.nomdis) disciplina, d.noadis,
             trim(d.tipdis) tipdis, coalesce(d.choeaddis, 0) chead, coalesce(d.chosmedis, 0) sinc
        from tac_disciplina_turma dt
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
        join tac_disciplina d on d.coddis = dt.disdtu
       where t.semtur = any($1)`, [semestres]);
    return { ok: true, salas: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaAutomacaoAva(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/automacao-ava/')) return false;
  if (!autenticadoOrbita(req)) { avaResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { avaResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/automacao-ava/ping') { avaResponder(res, 200, { ok: true, rotas: 'automacao-ava', versao: 2 }); return true; }
  const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 24);
  if (u.pathname === '/automacao-ava/salas') {
    if (!semestres.length || semestres.length > 4) { avaResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await avaSalas(semestres);
    avaResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/automacao-ava/titulacoes') {
    if (!semestres.length) { avaResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await avaTitulacoes(semestres);
    avaResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  avaResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
