// =====================================================================================================
// ÓRBITA — rota do Comercial (/comercial/*) no relay do Edubox (27/10/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs (o código do relay não fica
// no repositório do Órbita — ver regras/regra_do_app.md, seção 8). Instalação: regras/relay/instalar-comercial-enderecos.sh
//
// GET /comercial/enderecos?semestres=2027/1,2027-1&nomes=NOME UM|NOME DOIS
//   Nome e endereço (rua, número, bairro, cidade, UF, CEP — tfi_cliente) SÓ dos alunos pedidos (até 40 nomes,
//   os da rota do dia, cadastrados no Contratos do Comercial), matriculados nas turmas da Fatec nos semestres
//   pedidos. Uso: Contratos › Rota de coleta (coletar a assinatura do contrato na casa do aluno).
//   Só esses campos — nada de CPF, nascimento ou telefone. Nome comparado sem acento/pontuação.
//   DADO PESSOAL: o Órbita só chama esta rota se EDUBOX_RELAY_URL for https://.
//
// Usa só o que já existe no server.mjs: novoClient() e autenticadoOrbita(req). Não mexe em rota, token
// nem função do SIGMA. Só leitura (usuário "consulta"), com JOIN até tac_curso.
// =====================================================================================================

function comResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

const COM_NOME_SQL = (col) => `regexp_replace(regexp_replace(translate(upper(trim(${col})), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9 ]+', ' ', 'g'), ' +', ' ', 'g')`;

async function comEnderecos(semestres, nomes) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select distinct on (cl.codcli)
             trim(cl.nomcli) nome, trim(coalesce(cl.endcli, '')) rua, trim(coalesce(cl.numcli::text, '')) numero,
             trim(coalesce(cl.baicli, '')) bairro, trim(coalesce(mu.nommun, '')) cidade,
             trim(coalesce(cl.uf_cli, mu.uf_mun, '')) uf, trim(coalesce(cl.cepcli, '')) cep, t.semtur sem
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tac_curso c on c.codcur = t.curtur
        join tfi_cliente cl on cl.codcli = m.climat
        left join sis_municipio mu on mu.codmun = cl.muncli
       where t.semtur = any($1) and trim(${COM_NOME_SQL('cl.nomcli')}) = any($2)
       order by cl.codcli, t.semtur desc`, [semestres, nomes]);
    return { ok: true, alunos: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaComercial(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/comercial/')) return false;
  if (!autenticadoOrbita(req)) { comResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { comResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/comercial/ping') { comResponder(res, 200, { ok: true, rotas: 'comercial', versao: 2 }); return true; }
  if (u.pathname === '/comercial/enderecos') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    const nomes = [...new Set(String(u.searchParams.get('nomes') || '').split('|').map(n => n.trim().toUpperCase()).filter(n => /^[A-Z0-9 ]{3,150}$/.test(n)))];
    if (!semestres.length) { comResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    if (!nomes.length || nomes.length > 40) { comResponder(res, 400, { ok: false, erro: 'informe de 1 a 40 nomes' }); return true; }
    const r = await comEnderecos(semestres, nomes);
    comResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  comResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
