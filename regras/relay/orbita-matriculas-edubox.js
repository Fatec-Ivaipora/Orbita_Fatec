// =====================================================================================================
// ÓRBITA — matrículas do Edubox para o módulo Matrículas (/matriculas-edubox/*) no relay (09/11/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs (o código do relay não fica
// no repositório do Órbita — ver regras/regra_do_app.md, seção 8). Instalação: regras/relay/instalar-matriculas-edubox.sh
//
// GET /matriculas-edubox/lista?semestres=2027/1  (Medicina: 2027-1)
//   Uma linha por matrícula das turmas do semestre: nome, curso (codcur), período, situação da matrícula
//   (stamat) e motivo (mdemat), datas, semestre e forma do ingresso, se o aluno já teve ingresso ANTES
//   (retorno), se pagou alguma parcela daquela matrícula, celular/telefone e cidade (pro Comercial).
//   Sem CPF. Só leitura. Usa novoClient() e autenticadoOrbita(req) que já existem no server.mjs.
// =====================================================================================================

function medResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

async function medLista(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '30s';");
    const r = await client.query(`
      select m.codmat, m.ingmat, trim(cl.nomcli) as nome, trim(t.curtur) as codcur, t.pertur as periodo,
             trim(t.nomtur) as turma, t.semtur as semestre, trim(m.stamat) as situacao, trim(coalesce(m.mdemat, '')) as motivo,
             m.datmat::text as data_matricula, m.dttmat::text as data_situacao,
             trim(coalesce(i.seming, '')) as semestre_ingresso, trim(coalesce(i.foring, '')) as forma_ingresso,
             exists (select 1 from tac_ingresso i2 where i2.aluing = i.aluing and i2.coding <> i.coding
                       and coalesce(i2.seming, '') < coalesce(i.seming, '')) as ingresso_anterior,
             exists (select 1 from tfi_ctreceber c where c.matctr = m.codmat and coalesce(c.valpagctr, 0) > 0) as pagou,
             trim(coalesce(cl.celcli, '')) as celular, trim(coalesce(cl.foncli, '')) as telefone,
             trim(coalesce(mu.nommun, '')) as cidade
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tfi_cliente cl on cl.codcli = m.climat
        left join tac_ingresso i on i.coding = m.ingmat
        left join sis_municipio mu on mu.codmun = cl.muncli
       where t.semtur = any($1)
       order by cl.nomcli`, [semestres]);
    return { ok: true, matriculas: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaMatriculasEdubox(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/matriculas-edubox/')) return false;
  if (!autenticadoOrbita(req)) { medResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { medResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/matriculas-edubox/ping') { medResponder(res, 200, { ok: true, rotas: 'matriculas-edubox', versao: 1 }); return true; }
  if (u.pathname === '/matriculas-edubox/lista') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { medResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await medLista(semestres);
    medResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  medResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
