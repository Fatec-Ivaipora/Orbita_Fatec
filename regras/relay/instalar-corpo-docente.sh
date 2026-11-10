#!/bin/bash
# Instala/atualiza a rota /corpo-docente/* (professores e titulacao por curso, p/ a aba Titulacao das Matrizes do Orbita - 09/11/2026). So leitura.
# Colar no Web Console do droplet (DigitalOcean), como root. Desfazer: cp /opt/edubox-relay/server.mjs.bak-corpo-docente /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-corpo-docente
cat > /tmp/bloco-cd.mjs <<'BLOCO'
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
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-cd.mjs", "utf8");
const MARCA = "// ---- Órbita — Corpo docente";
const FIM = "// ---- fim Órbita — Corpo docente ----";
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
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaCorpoDocente(req, res)) return; // Órbita — Corpo docente\n" + s.slice(ini);
  const cands = [s.indexOf("// ---- Órbita — Matrículas Edubox"), s.indexOf("// ---- Órbita — Diagnóstico matrículas"), s.indexOf("// ---- Órbita — Comercial menores"), s.indexOf("// ---- Órbita — Cobrança conferência"), s.indexOf("// ---- Órbita — Comercial (v"), s.indexOf("// ---- Órbita — Automação AVA"), s.indexOf("const server = http.createServer(")].filter(x => x >= 0);
  const p = Math.min(...cands);
  s = s.slice(0, p) + MARCA + " (v1) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/corpo-docente/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/corpo-docente/lista?semestres=2026/2" -H "Authorization: Bearer $TOKEN" | head -c 160; echo " ..."
