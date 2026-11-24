#!/bin/bash
# Instala/atualiza a rota /med-provas/* (alunos da Medicina com RA e CPF p/ a impressao da Aplicacao de Provas do Orbita - 24/11/2026). So leitura.
# Colar no Web Console do droplet (DigitalOcean), como root. Desfazer: cp /opt/edubox-relay/server.mjs.bak-med-provas /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-med-provas
cat > /tmp/bloco-med-provas.mjs <<'BLOCO'
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
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-med-provas.mjs", "utf8");
const MARCA = "// ---- Órbita — Med provas";
const FIM = "// ---- fim Órbita — Med provas ----";
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
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaMedProvas(req, res)) return; // Órbita — Med provas\n" + s.slice(ini);
  const cands = [s.indexOf("// ---- Órbita — Diagnóstico matrículas"), s.indexOf("// ---- Órbita — Comercial menores"), s.indexOf("// ---- Órbita — Cobrança conferência"), s.indexOf("// ---- Órbita — Comercial (v"), s.indexOf("// ---- Órbita — Automação AVA"), s.indexOf("const server = http.createServer(")].filter(x => x >= 0);
  const p = Math.min(...cands);
  s = s.slice(0, p) + MARCA + " (v1) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/med-provas/ping" -H "Authorization: Bearer $TOKEN"; echo
# so a contagem: a resposta tem CPF, nao mostrar na tela
curl -s "http://localhost:8443/med-provas/alunos?semestre=2026-2" -H "Authorization: Bearer $TOKEN" | grep -o '"ra":' | wc -l | xargs echo "alunos da Medicina em 2026-2:"
