#!/bin/bash
# Instala/atualiza a rota /cobranca-conferencia/* do Órbita no relay do Edubox (conferência automática da Cobrança — 04/11/2026).
# Colar INTEIRO no Web Console do droplet (DigitalOcean), como root. Só acrescenta o bloco do Órbita; não toca no SIGMA nem nas outras rotas.
# Desfazer: cp /opt/edubox-relay/server.mjs.bak-cobconf /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-cobconf
cat > /tmp/bloco-cobconf.mjs <<'BLOCO'
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
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-cobconf.mjs", "utf8");
const MARCA = "// ---- Órbita — Cobrança conferência";
const FIM = "// ---- fim Órbita — Cobrança conferência ----";
const a = s.indexOf("const server = http.createServer(");
if (a < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
const m = s.indexOf(MARCA), f = s.indexOf(FIM);
if (m >= 0 && f > m && f < a) {
  s = s.slice(0, m) + MARCA + " (v1) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(f + FIM.length + 1);
  console.log("bloco atualizado");
} else {
  const g = s.indexOf("if (!autenticado(req))", a);
  if (g < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
  const ini = s.lastIndexOf("\n", g) + 1, recuo = s.slice(ini, g);
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaCobrancaConferencia(req, res)) return; // Órbita — Cobrança conferência\n" + s.slice(ini);
  // antes dos blocos do Comercial e da Automação AVA (os instaladores deles trocam só o que está entre os marcadores deles,
  // e o da AVA troca do marcador dela até o createServer) — assim nenhum reinstalar apaga este bloco
  const cands = [s.indexOf("// ---- Órbita — Comercial"), s.indexOf("// ---- Órbita — Automação AVA"), s.indexOf("const server = http.createServer(")].filter(x => x >= 0);
  const p = Math.min(...cands);
  s = s.slice(0, p) + MARCA + " (v1) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/cobranca-conferencia/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/cobranca-conferencia/vencidas?ate=$(TZ=America/Sao_Paulo date +%F)" -H "Authorization: Bearer $TOKEN" | head -c 120; echo " ..."
