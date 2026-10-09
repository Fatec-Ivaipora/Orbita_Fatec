---
name: Órbita Fatec
description: Padrão visual do Órbita (v2) — sistema interno da Fatec Ivaiporã, no estilo de relatório aprovado na Cobrança
colors:
  plano: "#ECEFF4"
  superficie: "#FFFFFF"
  superficie-2: "#F6F8FB"
  linha: "#E3E8F0"
  linha-2: "#EEF2F7"
  tinta: "#0D1B33"
  tinta-2: "#44536B"
  mudo: "#5B6A80"
  marca: "#12294D"
  marca-hover: "#1B3866"
  marca-suave: "#E7ECF5"
  azul: "#1F6FB2"
  laranja: "#E8791E"
  bom: "#0F7A4B"
  bom-suave: "#E2F2EA"
  alerta: "#A8650B"
  alerta-suave: "#FDF0DD"
  crit: "#C8392F"
  crit-suave: "#FBE9E6"
  age-1: "#EDC24E"
  age-2: "#E79A39"
  age-3: "#E8791E"
  age-4: "#D8542E"
  age-5: "#B12F28"
typography:
  texto:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  titulo:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 800
    lineHeight: 1.15
  numero:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 800
    lineHeight: 1.15
  rotulo:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  controle: "8px"
  cartao: "12px"
  pilula: "999px"
spacing:
  cartao: "14px 14px 13px 18px"
  cabecalho: "1.25rem 1.5rem"
components:
  cabecalho:
    backgroundColor: "{colors.marca}"
    textColor: "#FFFFFF"
    rounded: "{rounded.cartao}"
    padding: "{spacing.cabecalho}"
  botao-principal:
    backgroundColor: "{colors.marca}"
    textColor: "#FFFFFF"
    rounded: "{rounded.controle}"
  botao-secundario:
    backgroundColor: "{colors.superficie}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.controle}"
  cartao:
    backgroundColor: "{colors.superficie}"
    rounded: "{rounded.cartao}"
  indicador:
    backgroundColor: "{colors.superficie}"
    rounded: "{rounded.cartao}"
    padding: "{spacing.cartao}"
---

# Padrão visual do Órbita (v2)

Implementação: `core/orbita.css`. Adoção por página: `<body class="orb-v2">` + o arquivo carregado **depois** dos CSS do módulo. Página que ainda não adotou não muda nada; a migração é módulo a módulo (um PR por módulo, com print antes/depois).

Submarcas continuam com o próprio documento: Banco MED-FATEC em `banco-med-fatec/DESIGN.md`.

## Norte

**"O relatório da casa."** O Órbita é usado por gente do Financeiro, Secretaria, RH, TI e coordenação para trabalhar e para mostrar número à direção. O visual nasceu do painel da consultoria (Fiasini) que a direção aprovou na Cobrança em 08/10/2026: sóbrio, azul-marinho, números grandes e legíveis, cada cor com um significado. Modo **Operate**: a tela some e a tarefa aparece.

## Cores

- **Marca** `#12294D` (azul-marinho): cabeçalho da página, botão principal, aba e chip ativos, seleção de texto. É a única cor "forte" de fundo da tela.
- **Azul** `#1F6FB2`: dado neutro (barras de gráfico), links, anel de foco.
- **Laranja** `#E8791E`: destaque pontual (faixa de um indicador, uma faixa do aging). **Nunca** fundo de texto (branco sobre laranja não passa contraste).
- **Semânticas**: crítico/perda `#C8392F`, bom/ganho `#0F7A4B`, alerta `#A8650B`, cada uma com versão suave para fundo de pílula.
- **Atraso (aging)**: rampa amarelo → vinho `#EDC24E #E79A39 #E8791E #D8542E #B12F28`.
- **Texto**: tinta `#0D1B33`, tinta-2 `#44536B`, mudo `#5B6A80` — todos ≥ 4,5:1 sobre branco e sobre o plano.

**Regra da cor com significado.** Vermelho só para perda/atraso, verde só para ganho/recebido, azul para total/neutro, marinho para o resultado principal. Roxo, rosa e degradês não fazem parte do Órbita.

## Tipografia

- **Archivo** (600–800): títulos de página e de cartão, números dos indicadores.
- **IBM Plex Sans** (400–700): todo o resto (texto, rótulos, botões, tabelas).
- Números sempre com algarismos tabulares. Rótulos de indicador em caixa normal (sem CAIXA ALTA); só cabeçalho de coluna de tabela usa caixa alta pequena.
- Texto mínimo 12px na tela (o print pode ser menor).

## Forma e profundidade

- Controles 8px, cartões 12px, pílulas só para chips/etiquetas.
- **Uma elevação só: a borda.** Cartões têm borda fina `#E3E8F0` e nenhuma sombra. Nada de brilho colorido, nada de "quique" em animação.
- Transições de 150–250 ms, só para mostrar mudança de estado.

## Componentes

- **Cabeçalho da página**: faixa marinho plana (sem degradê, sem bolhas, sem rótulo acima do título). Ícone do módulo em quadrado translúcido. Botões dentro dela invertem: principal branco, secundário contorno claro.
- **Botões**: principal marinho; secundário branco com borda; altura mínima 40px (44px no celular).
- **Indicador (cartão de número)**: rótulo curto em cima, número em Archivo, uma ou duas linhas curtas de explicação embaixo. Faixa de 4px à esquerda na cor do significado (herdada do relatório da consultoria — é o único lugar onde a faixa lateral é permitida). Máximo de 5 a 7 indicadores no topo de uma tela; o resto vai para "ver a conta".
- **Tabela**: cabeçalho em caixa alta pequena cinza, linhas com divisória fina, hover cinza-claro, números alinhados à direita.
- **Ícones**: SVG de traço (mesmo estilo dos ícones do menu). Emoji não é ícone.
- **Dica ao passar o mouse/tocar** (padrão da Cobrança): título em negrito, valor, 1–2 linhas de contexto.

## Faça / Não faça

- **Faça** o filtro do topo mandar em tudo da tela (ano/semestre/mês).
- **Faça** a conta de cada número ficar escrita na tela.
- **Não** use degradê, bolhas decorativas, brilho colorido, sombra + borda juntas, roxo.
- **Não** use emoji no lugar de ícone, nem rótulo em CAIXA ALTA acima de título.
- **Não** mostre nome de aluno em relatório que sai do sistema (só números agregados).
