// =====================================================================================================
// ÓRBITA — alunos da Medicina para a impressão da Aplicação de Provas (/med-provas/*) no relay (24/11/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs (o código do relay não fica
// no repositório do Órbita — ver regras/regra_do_app.md, seção 8). Instalação: regras/relay/instalar-med-provas.sh
//
// GET /med-provas/alunos?semestre=2027-1
//   Uma linha por matrícula nas turmas da MEDICINA (curtur = 'MED') do semestre: nome, RA (tac_matricula.alumat),
//   CPF só com os dígitos (tfi_cliente.cpfcli), período, nome da turma e situação da matrícula.
//   Para que: a folha de login de cada aluno na prova (login = RA, senha = "F" + CPF — padrão da Fatec).
//   CPF é dado pessoal: só esta rota devolve, só da Medicina, só leitura. O Órbita não grava: monta a folha na
//   hora para a coordenação de Medicina. Usa novoClient() e autenticadoOrbita(req) que já existem no server.mjs.
// =====================================================================================================

function medProvasResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo), 'Cache-Control': 'no-store' });
  res.end(corpo);
}

async function medProvasAlunos(semestre) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '30s';");
    const r = await client.query(`
      select trim(cl.nomcli) as nome, trim(coalesce(m.alumat, '')) as ra,
             regexp_replace(coalesce(cl.cpfcli, ''), '[^0-9]', '', 'g') as cpf,
             t.pertur as periodo, trim(t.nomtur) as turma, trim(coalesce(m.stamat, '')) as situacao
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tfi_cliente cl on cl.codcli = m.climat
       where t.semtur = $1 and trim(t.curtur) = 'MED'
       order by t.pertur, cl.nomcli`, [semestre]);
    return { ok: true, alunos: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaMedProvas(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/med-provas/')) return false;
  if (!autenticadoOrbita(req)) { medProvasResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { medProvasResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/med-provas/ping') { medProvasResponder(res, 200, { ok: true, rotas: 'med-provas', versao: 1 }); return true; }
  if (u.pathname === '/med-provas/alunos') {
    const semestre = String(u.searchParams.get('semestre') || '').trim();
    if (!/^\d{4}[/-][12]$/.test(semestre)) { medProvasResponder(res, 400, { ok: false, erro: 'semestre invalido' }); return true; }
    const r = await medProvasAlunos(semestre);
    medProvasResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  medProvasResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
