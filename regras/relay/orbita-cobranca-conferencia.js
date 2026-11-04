// =====================================================================================================
// ÓRBITA — conferência da Cobrança (/cobranca-conferencia/*) no relay do Edubox (04/11/2026).
// Cópia de referência do bloco acrescentado em /opt/edubox-relay/server.mjs (o código do relay não fica
// no repositório do Órbita — ver regras/regra_do_app.md, seção 8). Instalação: regras/relay/instalar-cobranca-conferencia.sh
//
// GET /cobranca-conferencia/vencidas?ate=AAAA-MM-DD
//   Parcelas VENCIDAS (vencimento < ate) e em aberto (status Aberto/Parcial, valor - pago > 0) de tfi_ctreceber,
//   somadas POR ALUNO e grupo (Medicina = semestre do contrato com "-"). Aluno = mesma chave da lista da Cobrança
//   (CPF com 11 dígitos, senão "cli<código>"), devolvida só como md5 — nada de nome, CPF ou telefone em claro. O Órbita compara com a lista da Cobrança gravada pelo agente
//   (scripts/cobranca-edubox-sync.js) para avisar se a tela ficou diferente do Edubox.
//   Por cliente: n (parcelas), t (total em aberto), j (parte jurídica = plano categoria 9),
//   e (parte "para enviar ao advogado" = não jurídica com matrícula fora de Ativo/Concluído/Pendente ou sem matrícula).
//
// Usa só o que já existe no server.mjs: novoClient() e autenticadoOrbita(req). Só leitura.
// =====================================================================================================

function cconfResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

async function cconfVencidas(ate) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      with p as (
        select md5(case when length(regexp_replace(coalesce(cl.cpfcli, ''), '[^0-9]', '', 'g')) = 11
                        then regexp_replace(cl.cpfcli, '[^0-9]', '', 'g') else 'cli' || c.clictr end) as cli,
               (coalesce(c.semctr, '') ~ '-') as med,
               (c.valctr - coalesce(c.valpagctr, 0)) as aberto,
               coalesce(pl.catpla = 9, false) as jur,
               coalesce(trim(m.stamat), '') as sit
          from tfi_ctreceber c
          left join tfi_plano pl on pl.codpla = c.plactr
          left join tac_matricula m on m.codmat = c.matctr
          left join tfi_cliente cl on cl.codcli = c.clictr
         where c.stactr in ('Aberto', 'Parcial')
           and coalesce(pl.despla, '') !~* '^teste$'
           and c.venctr < $1::date
           and (c.valctr - coalesce(c.valpagctr, 0)) > 0
      )
      select cli, med, count(*)::int as n, round(sum(aberto)::numeric, 2)::float as t,
             round(coalesce(sum(aberto) filter (where jur), 0)::numeric, 2)::float as j,
             round(coalesce(sum(aberto) filter (where not jur and sit not in ('Ativo', 'Concluído', 'Pendente')), 0)::numeric, 2)::float as e
        from p group by cli, med`, [ate]);
    return { ok: true, ate, clientes: r.rows.map(x => ({ c: x.cli, m: x.med, n: x.n, t: x.t, j: x.j, e: x.e })) };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaCobrancaConferencia(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/cobranca-conferencia/')) return false;
  if (!autenticadoOrbita(req)) { cconfResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { cconfResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/cobranca-conferencia/ping') { cconfResponder(res, 200, { ok: true, rotas: 'cobranca-conferencia', versao: 1 }); return true; }
  if (u.pathname === '/cobranca-conferencia/vencidas') {
    const ate = String(u.searchParams.get('ate') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ate)) { cconfResponder(res, 400, { ok: false, erro: 'ate invalido (AAAA-MM-DD)' }); return true; }
    const r = await cconfVencidas(ate);
    cconfResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  cconfResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
