// =====================================================================================================
// ÓRBITA — corpo docente por curso (/corpo-docente/*) no relay do Edubox (09/11/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs. Instalação:
// regras/relay/instalar-corpo-docente.sh. Usado pela aba "Titulação" das Matrizes (relatório do diretor:
// doutores / mestres / especialistas por curso).
//
// GET /corpo-docente/lista?semestres=2026/2,2026-2
//   Uma linha por curso + professor com diário (tac_professor) nas turmas do semestre: código do curso,
//   código e nome do professor, titulação (tac_professor.titpro) e quantos diários ele tem no curso.
//   Só leitura; sem CPF. Usa novoClient() e autenticadoOrbita(req) que já existem no server.mjs.
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

async function rotaOrbitaCorpoDocente(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/corpo-docente/')) return false;
  if (!autenticadoOrbita(req)) { cdResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { cdResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/corpo-docente/ping') { cdResponder(res, 200, { ok: true, rotas: 'corpo-docente', versao: 1 }); return true; }
  if (u.pathname === '/corpo-docente/lista') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { cdResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await cdLista(semestres);
    cdResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  cdResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
