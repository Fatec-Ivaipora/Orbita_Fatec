---
name: BANCO MED-FATEC · NAPED
description: Identidade NAPED (Núcleo de Apoio Pedagógico da Medicina) aplicada ao Banco de Questões da Medicina no Órbita
colors:
  naped-royal: "#0052B8"
  naped-royal-escuro: "#003F8F"
  naped-ciano: "#00B3FF"
  naped-ciano-texto: "#A6E1FF"
  naped-painel: "#F7F7F7"
  tinta: "#0B1F3F"
  tinta-2: "#4A5A73"
  linha: "#DCE3EC"
  ok: "#047857"
  aviso: "#B45309"
  erro: "#B91C1C"
  bg-color: "#F4F7FB"
typography:
  display:
    fontFamily: "Montserrat, Inter, system-ui, sans-serif"
    fontWeight: 800
    textTransform: uppercase
    letterSpacing: "0.02em"
  abas:
    fontFamily: "Montserrat, Inter, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 700
    textTransform: uppercase
    letterSpacing: "0.06em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  control: "6px"
  container: "8px"
  modal: "10px"
  pill: "999px"
components:
  faixa:
    backgroundColor: "{colors.naped-royal}"
    borderBottom: "2px {colors.naped-ciano}"
  aba-ativa:
    textColor: "#FFFFFF"
    borderBottom: "4px {colors.naped-ciano}"
  barra-de-ferramentas:
    backgroundColor: "#FFFFFF"
    border: "1px {colors.linha}"
    rounded: "{rounded.control}"
  botao-primario:
    backgroundColor: "{colors.naped-royal}"
    textColor: "#FFFFFF"
    rounded: "{rounded.control}"
  botao-secundario:
    backgroundColor: "#FFFFFF"
    textColor: "{colors.naped-royal}"
    border: "1px #B9CBE6"
  faixa-de-periodo:
    backgroundColor: "{colors.naped-royal}"
    textColor: "#FFFFFF"
---

# Design System: BANCO MED-FATEC · NAPED

## Overview

**Creative North Star: "Peça do NAPED"**

Desde 13/11/2026 o módulo veste a identidade oficial do NAPED (Núcleo de Apoio Pedagógico da Medicina), tirada do material enviado pela instituição (`LOGO_NAPED.pdf`): campos azul-royal chapados, ciano só como destaque, títulos em caixa alta pesada e a linha fina ciano que atravessa as peças. O pedido foi explícito: o visual anterior "parecia amador e não entregava algo da Medicina". A casca (sidebar e header) continua vindo de `core/layout.css`; esta camada vive em `banco-med-fatec/naped.css`, carregada depois de `banco-med-fatec.css` e `avaliacoes.css`, e redefine as variáveis `--med-*` para as cores do NAPED.

**Características:**
- Uma **faixa royal** no topo do módulo: logo NAPED negativo, título "BANCO DE QUESTÕES DA MEDICINA" em caixa alta, subtítulo em ciano claro, selo MED FATEC à direita, abas em caixa alta dentro da faixa e linha ciano de 2px embaixo.
- O **azul cheio é da faixa, dos cabeçalhos de período e do rodapé com os selos**; barras de ferramentas e listas ficam no branco.
- Marcador **anel-ponto** (o estetoscópio do "E" do logo) só nos cabeçalhos de período da grade de avaliações.
- Rodapé royal com os selos MED FATEC e FATEC IVP negativos, como nas peças oficiais.

## Colors

- **NAPED Royal** (#0052B8): faixa, períodos, rodapé, botões primários, títulos de seção, número da questão.
- **NAPED Ciano** (#00B3FF): só destaque não textual (linha fina, aba ativa, anel-ponto, barra "esperado"). Sobre branco não é cor de texto; texto claro sobre o royal usa **#A6E1FF**.
- **Painel** (#F7F7F7) e **linha** (#DCE3EC) estruturam; **tinta** #0B1F3F e **tinta-2** #4A5A73 no texto.
- Estados: ok #047857, aviso #B45309, erro #B91C1C.

**The One Field Rule.** Um campo azul cheio por região: a faixa no topo e as faixas de período. Nada de segundo bloco azul (a antiga barra de ferramentas azul saiu).

## Typography

- **Display:** Montserrat 800 em caixa alta (o mais próximo disponível do lettering geométrico das peças NAPED): título da faixa, títulos de seção, abas (700), períodos, números de destaque.
- **Corpo:** Inter (stack institucional do Órbita), mantida de propósito para a leitura de enunciados longos e a consistência com os outros módulos.
- Etiquetas (dificuldade, tipo, área, padrão) em caixa normal, 0.72rem, 700, todas no mesmo estilo.

## Layout

Coluna única, `max-width: 1240px`. Faixa → barra de ferramentas branca → conteúdo (grade, lista ou editor) → rodapé com selos. A aba Avaliações abre primeiro para quem tem acesso (responsável pelas avaliações / coordenação). Menu: Avaliações · Banco de Questões · Simulado ENAMED · Importações. As Provas antigas juntaram em Avaliações e saíram do menu; a seleção em massa do banco saiu junto, por não ter mais destino.

## Elevation & Depth

Plano. Superfícies declaram borda fina; sombra só no modal. Linhas ciano são bordas, não brilho.

## Shapes

Controles 6px, contêineres 8px, modal 10px; pílulas só para etiquetas. Faixa, períodos e rodapé com cantos retos, como os campos de cor das peças impressas.

## Do's and Don'ts

### Do
- **Do** usar os PNGs oficiais em `img/naped/` (recortes do PDF da instituição sobre o mesmo royal #0052B8, sem emenda na faixa).
- **Do** manter caixa alta só em títulos, abas e períodos; nunca rótulo pequeno em cima de título.
- **Do** usar #A6E1FF (não o ciano puro) para texto sobre o royal.

### Don't
- **Don't** pintar barra de ferramentas ou listas de azul cheio.
- **Don't** marcar estado com faixa colorida grossa à esquerda; estado vai no número ou na etiqueta.
- **Don't** trocar a Inter no corpo do texto.
