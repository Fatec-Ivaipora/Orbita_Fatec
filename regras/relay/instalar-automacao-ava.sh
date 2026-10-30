#!/bin/bash
# Instala/atualiza as rotas /automacao-ava/* do Órbita no relay do Edubox (v2: titulacoes + salas — 26/10/2026).
# Colar INTEIRO no Web Console do droplet (DigitalOcean), como root. Só mexe no bloco do Órbita; não toca no SIGMA.
# Desfazer: cp /opt/edubox-relay/server.mjs.bak-automacao-ava-v2 /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-automacao-ava-v2
cat > /tmp/bloco-automacao-ava.mjs <<'BLOCO'
function avaResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

async function avaTitulacoes(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select f.codfun, trim(f.nomfun) nome, trim(p.titpro) titulacao, t.semtur sem, count(*)::int salas
        from tac_professor p
        join trh_funcionario f on f.codfun = p.funpro
        join tac_disciplina_turma dt on dt.coddtu = p.dtupro
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
       where t.semtur = any($1) and coalesce(trim(p.titpro), '') <> ''
       group by 1, 2, 3, 4`, [semestres]);
    return { ok: true, professores: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function avaSalas(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select dt.coddtu, dt.turdtu codtur, trim(t.nomtur) turma, t.pertur periodo, t.semtur sem,
             t.curtur codcur, trim(c.descur) curso, d.coddis, trim(d.nomdis) disciplina, d.noadis,
             trim(d.tipdis) tipdis, coalesce(d.choeaddis, 0) chead, coalesce(d.chosmedis, 0) sinc
        from tac_disciplina_turma dt
        join tac_turma t on t.codtur = dt.turdtu
        join tac_curso c on c.codcur = t.curtur
        join tac_disciplina d on d.coddis = dt.disdtu
       where t.semtur = any($1)`, [semestres]);
    return { ok: true, salas: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaAutomacaoAva(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/automacao-ava/')) return false;
  if (!autenticadoOrbita(req)) { avaResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { avaResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/automacao-ava/ping') { avaResponder(res, 200, { ok: true, rotas: 'automacao-ava', versao: 2 }); return true; }
  const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 24);
  if (u.pathname === '/automacao-ava/salas') {
    if (!semestres.length || semestres.length > 4) { avaResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await avaSalas(semestres);
    avaResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/automacao-ava/titulacoes') {
    if (!semestres.length) { avaResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await avaTitulacoes(semestres);
    avaResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  avaResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-automacao-ava.mjs", "utf8");
const MARCA = "// ---- Órbita — Automação AVA";
const a = s.indexOf("const server = http.createServer(");
if (a < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
const m = s.indexOf(MARCA);
if (m >= 0 && m < a) {
  s = s.slice(0, m) + MARCA + " (v2) ----\n" + bloco + "\n" + s.slice(a);
  console.log("bloco atualizado");
} else {
  const g = s.indexOf("if (!autenticado(req))");
  if (g < a) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
  const ini = s.lastIndexOf("\n", g) + 1, recuo = s.slice(ini, g);
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaAutomacaoAva(req, res)) return; // Órbita — Automação AVA\n" + s.slice(ini);
  s = s.slice(0, a) + MARCA + " (v2) ----\n" + bloco + "\n" + s.slice(a);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/automacao-ava/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/automacao-ava/salas?semestres=2027/1,2027-1" -H "Authorization: Bearer $TOKEN" | head -c 300; echo
