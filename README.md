# Figma Local MCP Bridge

Servidor MCP local + Plugin para **Figma Desktop** conectado diretamente via **WebSocket (`ws://localhost:3055`)**, sem depender da REST API web (`api.figma.com`), sem token da API e sem limites de requisição.

Projetado especificamente para **Dev Handoff (somente leitura)**: a IA lê o Scene Graph completo da seleção atual, CSS nativo (`getCSSAsync`), estilos, variáveis/design tokens resolvidos e imagens/SVGs exportados para gerar código fiel ao layout.

## Arquitetura

- **Zero chamadas HTTP para `api.figma.com`**: tudo roda localmente na memória do Figma Desktop e trafega em loopback (`localhost:3055` — `127.0.0.1` / `::1`).
- **Auto-eleição Leader / Follower (`src/bridge.ts`)**: o primeiro processo MCP aberto pelo cliente (Antigravity, Claude Code, etc.) sobe o servidor WebSocket na porta `3055` (`leader`). Outras janelas ou clientes abertos ao mesmo tempo entram como `follower` no mesmo socket — e se o líder fechar, o próximo assume a liderança automaticamente.
- **Suporte a múltiplas abas do Figma**: roteia automaticamente para a aba ativa mais recente ou permite especificar o parâmetro `file` nas ferramentas.

## Pré-requisitos

- **Node.js 18+**
- **Figma Desktop** instalado *(não funciona no Figma Web/navegador, pois a importação de plugins locais via `manifest.json` só existe no app Desktop)*.

---

## Passo 1 — Clonar e compilar

```bash
git clone <url-do-repositorio> figma-bridge
cd figma-bridge
npm install
npm run build
pwd
```

> **Importante:** `npm run build` gera `build/index.js` (servidor MCP) e `plugin/code.js` (código do plugin), ambos ignorados no `.gitignore`. Rode esse comando antes de importar o plugin no Figma. Guarde a saída do `pwd` para usar nos caminhos abaixo.

---

## Passo 2 — Configurar o MCP no seu cliente

> **Dica (`nvm`):** se você usa `nvm`, descubra o caminho absoluto do binário com `which node` e use-o no lugar de `"node"`, pois aplicativos GUI/desktop nem sempre carregam o `$PATH` do seu shell.

### Antigravity

1. Abra o arquivo de configuração global `~/.gemini/config/mcp_config.json`.
2. Adicione a entrada `"figma"` dentro de `"mcpServers"` (substituindo `/caminho/absoluto/para/figma-bridge` pela saída do `pwd`):

```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": [
        "/caminho/absoluto/para/figma-bridge/build/index.js"
      ]
    }
  }
}
```

3. No Antigravity, recarregue os servidores em **Additional Options (`...`) > MCP Servers** (ou reinicie a sessão).

### Claude Code

Você pode conectar via CLI ou editando o JSON manualmente:

#### Opção 1 — Via CLI

* **Global (disponível em todos os projetos — `--scope user`):**

```bash
claude mcp add --transport stdio --scope user figma -- node /caminho/absoluto/para/figma-bridge/build/index.js
```

* **Apenas no projeto atual (cria `.mcp.json` — `--scope project`):**

```bash
claude mcp add --transport stdio --scope project figma -- node /caminho/absoluto/para/figma-bridge/build/index.js
```

#### Opção 2 — Configuração manual em JSON

Adicione ao `.mcp.json` na raiz do projeto (ou em `mcpServers` dentro de `~/.claude.json`):

```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": [
        "/caminho/absoluto/para/figma-bridge/build/index.js"
      ]
    }
  }
}
```

Para confirmar que conectou no Claude Code, rode `claude mcp list` no terminal ou digite `/mcp` dentro de uma sessão ativa.

> **Uso simultâneo:** como o bridge usa eleição **leader/follower**, você pode manter **Antigravity e Claude Code abertos ao mesmo tempo** compartilhando a mesma janela do plugin no Figma Desktop, sem conflito de porta.

---

## Passo 3 — Importar e executar o plugin no Figma Desktop

1. Abra o aplicativo **Figma Desktop**.
2. **Abra qualquer arquivo de design** *(o menu de plugins não aparece na tela inicial **Recents**)*.
3. Aperte **`Cmd + K`** (macOS) ou **`Ctrl + K`** (Windows/Linux), digite `Import plugin from manifest` e pressione **Enter** *(ou vá no menu **Plugins > Development > Import plugin from manifest...**)*.
4. Selecione o arquivo `figma-bridge/plugin/manifest.json`.
5. Execute o plugin: **`Cmd + K`** (ou `Ctrl + K`) → **`Figma Local MCP Bridge`**.
6. Aguarde até 2 segundos: o badge ficará verde (**`Conectado :3055`**).
   * *Se aparecer `Servidor offline / Reconectando...`, confira se o passo 2 foi carregado no Antigravity ou Claude Code — assim que o cliente MCP iniciar, o plugin conecta sozinho.*
   * *Mantenha a janela do plugin aberta ou clique em **Minimizar** (encolhe para `240×40`). Fechar no `X` encerra a execução do plugin.*

### Opcional: trocar a porta padrão (`3055`)

Se a porta `3055` já estiver ocupada, é preciso atualizar os **3 pontos** abaixo:

1. No `mcp_config.json` / `.mcp.json`, adicione `"env": { "FIGMA_BRIDGE_PORT": "3056" }` na entrada `"figma"`.
2. Em `plugin/manifest.json`, atualize `devAllowedDomains` para `["ws://localhost:3056", "http://localhost:3056"]` e reimporte o manifest no Figma Desktop.
3. Na interface do plugin, informe `3056` no campo **Porta WS** e clique em **Reconectar**.

---

## Como referenciar telas para a IA

1. **Selecionar o frame no Figma:** clique no título do frame/tela (ou na camada na aba *Layers*) e peça para a IA ler a seleção (`figma_get_selection`).
2. **Citar o nome do frame ou página:** peça pelo nome (ex: *"Leia a tela Login na página Light Mode"*).
3. **Colar o link da seleção (`Cmd + L` / `Ctrl + L`):** a IA extrai apenas o `node-id` do link e consulta localmente via `figma_get_node`, sem bater na API web.

## Exemplos de uso (prompts)

Com o plugin conectado (`Conectado :3055`), peça diretamente no chat do Antigravity ou do Claude Code:

### 1. Gerar tela ou componente a partir da seleção atual
> "Cria essa tela que está selecionada no Figma em React + Tailwind."

> "Implementa esse componente selecionado no Figma usando HTML e CSS seguindo exatamente o Auto Layout, espaçamentos e cores."

> "Lê a seleção atual no Figma, exporta um preview PNG para conferir o visual e cria a página em Next.js com componentes separados."

### 2. Usar o link copiado do Figma (`Cmd + L` / `Ctrl + L`)
> "Analisa esse componente do Figma e cria ele em React Native: `https://www.figma.com/design/...?...&node-id=7342-2879`"

### 3. Buscar por nome da tela ou página
> "Lista todas as telas da página `Light Mode` e me mostra a estrutura da tela `Dashboard`."

> "Procura o frame `Bottom Navigation` no arquivo aberto e gera o código dele com os ícones."

### 4. Extrair Design Tokens, Cores e Tipografia
> "Extrai todas as variáveis e estilos desse arquivo Figma e gera um `tokens.css` com `:root` e modo escuro (`[data-theme='dark']`)."

> "Lê as variáveis do Figma em formato DTCG e atualiza nosso `tailwind.config` com as cores, fontes e espaçamentos do Design System."

### 5. Exportar ícones SVG ou imagens
> "Exporta todos os ícones da barra de navegação selecionada em SVG para a pasta `src/assets/icons/`."

### 6. Quando houver mais de um arquivo aberto no Figma
> "Lê a seleção do arquivo `Design System` no Figma e compara com o componente `Button` do nosso projeto."

---

## Ferramentas MCP expostas (10 tools)

| Ferramenta                 | Descrição                                                                                                                                |
| :------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `figma_get_status`         | Status do bridge (`leader`/`follower`) e abas do Figma conectadas.                                                                       |
| `figma_get_document_info`  | Nome do arquivo, páginas, frames de primeiro nível e resumo da seleção.                                                                  |
| `figma_get_selection`      | Scene Graph completo da seleção atual (Auto Layout, bounds, tipografia, fills, strokes, `getCSSAsync`, estilos e `boundVariables`).      |
| `figma_get_node`           | Scene Graph completo para um ou mais `nodeId`/`nodeIds`.                                                                                 |
| `figma_get_page_structure` | Outline leve da página atual ou específica (`pageId`) para descobrir IDs.                                                                |
| `figma_search_nodes`       | Busca nós por nome, texto ou tipo na seleção, página atual ou arquivo inteiro.                                                           |
| `figma_get_styles`         | Todos os estilos locais (cores, tipografia, sombras/blurs, grids).                                                                       |
| `figma_get_variables`      | Collections, modes e variáveis locais com resolução recursiva de aliases (`json`, `css` ou `dtcg`).                                      |
| `figma_get_components`     | Catálogo de `COMPONENT` e `COMPONENT_SET` locais com propriedades e variantes.                                                           |
| `figma_export_node`        | Exporta um nó como `PNG`, `JPG` (enviando a imagem direto para o contexto visual da IA) ou `SVG` (opcionalmente salvando em `savePath`). |

---

## Solução de problemas

- **`Servidor offline / Reconectando...` no plugin:** recarregue os servidores MCP no Antigravity (**Additional Options (`...`) > MCP Servers**) ou verifique com `claude mcp list` no Claude Code. Se usar `nvm`, troque `"node"` pelo caminho completo obtido com `which node`.
- **Menu `Plugins > Development` não aparece no Figma:** abra um arquivo de design primeiro (não funciona na tela inicial *Recents*) e certifique-se de estar usando o **Figma Desktop**, não o navegador.
- **Erro ao importar `manifest.json` / `code.js` não encontrado:** rode `npm install && npm run build` na raiz do projeto antes de importar no Figma.
- **Erro de conexão após trocar a porta:** lembre-se de atualizar `devAllowedDomains` em `plugin/manifest.json` para a nova porta e reimportar o manifest no Figma Desktop.

## Desenvolvimento e testes

```bash
# Compilar servidor MCP + plugin do Figma
npm run build

# Executar suíte de testes E2E (inclui eleição leader/follower e failover)
npm test
```
