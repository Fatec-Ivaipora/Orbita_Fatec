#!/bin/bash
# Instala/atualiza a rota /matriculas-edubox/* (matriculas do Edubox p/ o modulo Matriculas do Orbita - 09/11/2026). So leitura.
# Colar no Web Console do droplet (DigitalOcean), como root. Desfazer: cp /opt/edubox-relay/server.mjs.bak-matriculas-edubox /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-matriculas-edubox
cat > /tmp/bloco-med.mjs <<'BLOCO'
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

// GET /matriculas-edubox/financeiro?semestre=2027/1&codmats=1,2,3 (12/11/2026, v2) — parcelas do semestre de cada
// matrícula, pro e-mail "MATRÍCULAS dd/mm" (nº de parcelas, valor, % de desconto, 1º vencimento). Sem CPF.
async function medFinanceiro(semestre, codmats) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '30s';");
    const r = await client.query(`
      select c.matctr as codmat, c.parctr as parcela, c.venctr::text as vencimento, c.valctr::float as valor,
             c.valbasctr::float as valor_base, c.desctr::float as desconto, trim(coalesce(c.stactr, '')) as status,
             c.canctr as cancelada, trim(coalesce(pl.despla, '')) as plano, left(trim(coalesce(pl.obspla, '')), 300) as plano_obs,
             (select string_agg(coalesce(d.perctd, 0)::text || ';' || coalesce(d.valctd, 0)::text || ';' || trim(coalesce(d.tilctd, '')), '|' order by d.ordctd)
                from tfi_ctreceber_desacr d where d.ctrctd = c.codctr) as descontos
        from tfi_ctreceber c
        left join tfi_plano pl on pl.codpla = c.plactr
       where c.matctr = any($1) and c.semctr = $2
       order by c.matctr, c.venctr, c.parctr`, [codmats, semestre]);
    return { ok: true, parcelas: r.rows };
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
  if (u.pathname === '/matriculas-edubox/ping') { medResponder(res, 200, { ok: true, rotas: 'matriculas-edubox', versao: 2 }); return true; }
  if (u.pathname === '/matriculas-edubox/lista') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { medResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await medLista(semestres);
    medResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/matriculas-edubox/financeiro') {
    const semestre = String(u.searchParams.get('semestre') || '').trim();
    const codmats = String(u.searchParams.get('codmats') || '').split(',').map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0).slice(0, 400);
    if (!/^\d{4}[/-][12]$/.test(semestre) || !codmats.length) { medResponder(res, 400, { ok: false, erro: 'semestre/codmats invalidos' }); return true; }
    const r = await medFinanceiro(semestre, codmats);
    medResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  medResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-med.mjs", "utf8");
const MARCA = "// ---- Órbita — Matrículas Edubox";
const FIM = "// ---- fim Órbita — Matrículas Edubox ----";
const a = s.indexOf("const server = http.createServer(");
if (a < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
const m = s.indexOf(MARCA), f = s.indexOf(FIM);
if (m >= 0 && f > m && f < a) {
  s = s.slice(0, m) + MARCA + " (v2) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(f + FIM.length + 1);
  console.log("bloco atualizado");
} else {
  const g = s.indexOf("if (!autenticado(req))", a);
  if (g < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
  const ini = s.lastIndexOf("\n", g) + 1, recuo = s.slice(ini, g);
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaMatriculasEdubox(req, res)) return; // Órbita — Matrículas Edubox\n" + s.slice(ini);
  const cands = [s.indexOf("// ---- Órbita — Diagnóstico matrículas"), s.indexOf("// ---- Órbita — Comercial menores"), s.indexOf("// ---- Órbita — Cobrança conferência"), s.indexOf("// ---- Órbita — Comercial (v"), s.indexOf("// ---- Órbita — Automação AVA"), s.indexOf("const server = http.createServer(")].filter(x => x >= 0);
  const p = Math.min(...cands);
  s = s.slice(0, p) + MARCA + " (v2) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/matriculas-edubox/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/matriculas-edubox/lista?semestres=2027/1" -H "Authorization: Bearer $TOKEN" | head -c 120; echo " ..."
