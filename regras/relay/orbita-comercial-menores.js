// =====================================================================================================
// ÓRBITA — menores de 18 entre os matriculados (/comercial-menores/*) no relay do Edubox (06/11/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs (o código do relay não fica
// no repositório do Órbita — ver regras/regra_do_app.md, seção 8). Instalação: regras/relay/instalar-comercial-menores.sh
//
// GET /comercial-menores/lista?semestres=2027/1,2027-1
//   Alunos matriculados nas turmas dos semestres pedidos que têm MENOS DE 18 ANOS hoje (tfi_cliente.nascli),
//   e os que estão SEM data de nascimento no Edubox. Devolve só NOME (normalizado: maiúsculo, sem acento e
//   pontuação) e o código do curso — nada de data de nascimento, CPF ou telefone. Uso: Contratos do Comercial
//   (marca "-18": contrato assinado pelo pai ou responsável).
//
// Usa só o que já existe no server.mjs: novoClient() e autenticadoOrbita(req). Só leitura.
// =====================================================================================================

function menResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

const MEN_NOME_SQL = (col) => `regexp_replace(regexp_replace(translate(upper(trim(${col})), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9 ]+', ' ', 'g'), ' +', ' ', 'g')`;

async function menLista(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select distinct trim(${MEN_NOME_SQL('cl.nomcli')}) as nome, trim(c.codcur) as codcur,
             case when cl.nascli is null then 'sem' else 'menor' end as tipo
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tac_curso c on c.codcur = t.curtur
        join tfi_cliente cl on cl.codcli = m.climat
       where t.semtur = any($1)
         and (cl.nascli is null or cl.nascli > (current_date - interval '18 years'))`, [semestres]);
    return {
      ok: true,
      menores: r.rows.filter(x => x.tipo === 'menor').map(x => ({ nome: x.nome, codcur: x.codcur })),
      semNascimento: r.rows.filter(x => x.tipo === 'sem').map(x => ({ nome: x.nome, codcur: x.codcur }))
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

// Aniversário de 18 anos (só de quem completa 18 entre 1 ano atrás e o futuro) — pra saber se era menor
// NA DATA DA MATRÍCULA/CONTRATO, não só hoje (v2, 06/11/2026). Devolve nome, curso e a data em que faz 18.
async function menAniversarios(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select distinct trim(${MEN_NOME_SQL('cl.nomcli')}) as nome, trim(c.codcur) as codcur,
             to_char(cl.nascli + interval '18 years', 'YYYY-MM-DD') as faz18
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tac_curso c on c.codcur = t.curtur
        join tfi_cliente cl on cl.codcli = m.climat
       where t.semtur = any($1)
         and cl.nascli is not null
         and cl.nascli > (current_date - interval '19 years')`, [semestres]);
    return { ok: true, alunos: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaComercialMenores(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/comercial-menores/')) return false;
  if (!autenticadoOrbita(req)) { menResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { menResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/comercial-menores/ping') { menResponder(res, 200, { ok: true, rotas: 'comercial-menores', versao: 2 }); return true; }
  if (u.pathname === '/comercial-menores/aniversarios') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { menResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await menAniversarios(semestres);
    menResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/comercial-menores/lista') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { menResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await menLista(semestres);
    menResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  menResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
