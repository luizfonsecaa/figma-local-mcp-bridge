import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FigmaBridge } from "./bridge.js";

export interface VariableModeValue {
  modeId: string;
  modeName: string;
  rawValue: unknown;
  resolvedValue: unknown;
  aliasTo?: {
    id: string;
    name: string;
    collectionName?: string;
  };
}

export interface SerializedVariable {
  id: string;
  name: string;
  collectionId: string;
  collectionName: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN" | string;
  description?: string;
  scopes?: string[];
  codeSyntax?: Record<string, string>;
  valuesByMode: Record<string, VariableModeValue>;
}

export interface SerializedVariableCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: Array<{ modeId: string; name: string }>;
}

export interface VariablesPayload {
  collections: SerializedVariableCollection[];
  variables: SerializedVariable[];
}

interface ExportNodeResponse {
  nodeId: string;
  name: string;
  format: "PNG" | "JPG" | "SVG";
  scale?: number;
  byteLength: number;
  base64?: string;
  svg?: string;
}

const FILE_PARAM_PROP = {
  type: "string",
  description:
    "Opcional: nome parcial (case-insensitive) ou clientId de um arquivo Figma específico quando houver mais de uma aba aberta.",
} as const;

const TREE_OPTIONS_PROPS = {
  maxDepth: {
    type: "number",
    description:
      "Profundidade máxima de traversal da árvore de nós (padrão: 8). Use -1 para árvore ilimitada.",
  },
  includeCss: {
    type: "boolean",
    description:
      "Inclui o resultado de node.getCSSAsync() em cada nó (padrão: true). Desative se quiser payloads mais enxutos em árvores gigantes.",
  },
  includeHidden: {
    type: "boolean",
    description: "Inclui camadas invisíveis (visible === false). Padrão: false.",
  },
  includeVectors: {
    type: "boolean",
    description:
      "Expande filhos internos de ícones/ilustrações vetoriais em vez de marcá-los apenas com isIconCandidate=true. Padrão: false.",
  },
  file: FILE_PARAM_PROP,
} as const;

export const FIGMA_TOOLS: Tool[] = [
  {
    name: "figma_get_status",
    description:
      "Verifica o status do bridge WebSocket local (leader/follower, porta) e lista todos os arquivos abertos no Figma Desktop conectados pelo plugin.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "figma_get_document_info",
    description:
      "Retorna metadados do arquivo Figma ativo no Desktop: nome do arquivo, lista de páginas, página atual, frames de primeiro nível na página atual e resumo da seleção atual.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PARAM_PROP,
      },
    },
  },
  {
    name: "figma_get_selection",
    description:
      "Lê o Scene Graph completo (layout/Auto Layout, bounds, tipografia, fills, strokes, cornerRadius, effects, CSS nativo via getCSSAsync, estilos e variáveis vinculadas) dos nós atualmente selecionados no Figma Desktop. Ideal como referência principal para gerar layouts em código.",
    inputSchema: {
      type: "object",
      properties: {
        ...TREE_OPTIONS_PROPS,
      },
    },
  },
  {
    name: "figma_get_node",
    description:
      "Lê o Scene Graph completo para um ou mais nós específicos por ID (nodeId ou nodeIds), com todas as propriedades de layout, estilo, texto, variáveis e CSS.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "ID de um único nó do Figma (ex: '12:345').",
        },
        nodeIds: {
          type: "array",
          items: { type: "string" },
          description: "Lista de IDs de nós do Figma (ex: ['12:345', '12:346']).",
        },
        ...TREE_OPTIONS_PROPS,
      },
    },
  },
  {
    name: "figma_get_page_structure",
    description:
      "Retorna uma visão leve em árvore (id, name, type, bounds, childCount e trecho de texto) da página atual ou de uma página específica para localizar IDs antes de ler nós em detalhe.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "Opcional: ID da página a inspecionar (padrão: página atual).",
        },
        maxDepth: {
          type: "number",
          description: "Profundidade máxima do outline (padrão: 4). Use -1 para ilimitada.",
        },
        includeHidden: {
          type: "boolean",
          description: "Inclui camadas invisíveis. Padrão: false.",
        },
        file: FILE_PARAM_PROP,
      },
    },
  },
  {
    name: "figma_search_nodes",
    description:
      "Busca nós por nome ou conteúdo de texto e/ou por tipos (ex: FRAME, TEXT, COMPONENT, INSTANCE) na seleção, página atual ou em todas as páginas.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Texto para buscar (case-insensitive) no nome do nó ou conteúdo de texto.",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Filtro opcional de tipos de nó do Figma (ex: ['FRAME', 'TEXT', 'COMPONENT', 'INSTANCE']).",
        },
        scope: {
          type: "string",
          enum: ["selection", "current_page", "all_pages"],
          description: "Escopo da busca (padrão: 'current_page').",
        },
        limit: {
          type: "number",
          description: "Número máximo de resultados (padrão: 50).",
        },
        file: FILE_PARAM_PROP,
      },
    },
  },
  {
    name: "figma_get_styles",
    description:
      "Lista todos os estilos locais (Paint/Cores, Text/Tipografia, Effect/Sombras e Blurs, Grid/Layout Grids) definidos no arquivo Figma ativo.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PARAM_PROP,
      },
    },
  },
  {
    name: "figma_get_variables",
    description:
      "Extrai todas as collections, modes e variáveis (design tokens) locais do Figma com resolução recursiva de aliases. Pode retornar JSON estruturado, CSS custom properties (:root / [data-theme]) ou formato W3C DTCG.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "css", "dtcg"],
          description: "Formato de saída (padrão: 'json'). Use 'css' para CSS variables prontas ou 'dtcg' para W3C Design Tokens.",
        },
        file: FILE_PARAM_PROP,
      },
    },
  },
  {
    name: "figma_get_components",
    description:
      "Lista componentes (COMPONENT e COMPONENT_SET) locais com descrições, dimensões, variantes e componentPropertyDefinitions.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["current_page", "all_pages"],
          description: "Escopo de busca dos componentes locais (padrão: 'current_page').",
        },
        file: FILE_PARAM_PROP,
      },
    },
  },
  {
    name: "figma_export_node",
    description:
      "Exporta um nó específico (ou o primeiro nó selecionado, se nodeId for omitido) como PNG, JPG ou SVG diretamente do Figma Desktop. Para PNG/JPG retorna a imagem diretamente no contexto visual + metadados (e opcionalmente salva em disco).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Opcional: ID do nó a exportar. Se omitido, exporta o primeiro nó da seleção atual.",
        },
        format: {
          type: "string",
          enum: ["PNG", "JPG", "SVG"],
          description: "Formato de exportação (padrão: 'PNG'). Use 'SVG' para ícones/vetores.",
        },
        scale: {
          type: "number",
          description: "Escala de rasterização para PNG/JPG entre 0.5 e 4 (padrão: 2).",
        },
        savePath: {
          type: "string",
          description: "Opcional: caminho absoluto no disco para salvar o arquivo exportado.",
        },
        file: FILE_PARAM_PROP,
      },
    },
  },
];

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function optionalString(val: unknown): string | undefined {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

function optionalBoolean(val: unknown, fallback: boolean): boolean {
  return typeof val === "boolean" ? val : fallback;
}

function optionalNumber(val: unknown, fallback: number): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function slugifyTokenName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function isColorObject(val: unknown): val is { r: number; g: number; b: number; a?: number; hex?: string } {
  return (
    typeof val === "object" &&
    val !== null &&
    typeof (val as Record<string, unknown>).r === "number" &&
    typeof (val as Record<string, unknown>).g === "number" &&
    typeof (val as Record<string, unknown>).b === "number"
  );
}

function formatCssColor(val: unknown): string {
  if (typeof val === "string") return val;
  if (!isColorObject(val)) return String(val);

  const a = typeof val.a === "number" ? val.a : 1;
  if (a >= 0.999 && typeof val.hex === "string") {
    return val.hex;
  }
  const r = Math.round(val.r * 255);
  const g = Math.round(val.g * 255);
  const b = Math.round(val.b * 255);
  if (a >= 0.999) {
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

const UNITLESS_FLOAT_SCOPES = new Set(["OPACITY", "FONT_WEIGHT"]);

function formatCssValue(variable: SerializedVariable, modeValue: VariableModeValue): string {
  const resolved = modeValue.resolvedValue;
  let formatted: string;

  if (variable.resolvedType === "COLOR") {
    formatted = formatCssColor(resolved);
  } else if (variable.resolvedType === "FLOAT" && typeof resolved === "number") {
    const scopes = variable.scopes ?? [];
    const isUnitless =
      scopes.length > 0 && scopes.every((s) => UNITLESS_FLOAT_SCOPES.has(s));
    formatted = isUnitless ? String(resolved) : `${resolved}px`;
  } else if (typeof resolved === "string") {
    formatted = JSON.stringify(resolved);
  } else {
    formatted = String(resolved);
  }

  if (modeValue.aliasTo) {
    const targetVar = `--${slugifyTokenName(modeValue.aliasTo.name)}`;
    return `var(${targetVar}) /* ${formatted} */`;
  }
  return formatted;
}

export function formatVariablesAsCss(payload: VariablesPayload): string {
  const collectionMap = new Map(payload.collections.map((c) => [c.id, c]));
  const rootLines: string[] = [];
  const themeBlocks = new Map<string, string[]>();

  for (const variable of payload.variables) {
    const collection = collectionMap.get(variable.collectionId);
    const cssVarName = `--${slugifyTokenName(variable.name)}`;

    for (const [modeId, modeVal] of Object.entries(variable.valuesByMode)) {
      const valueText = formatCssValue(variable, modeVal);
      const line = `  ${cssVarName}: ${valueText};`;

      const isDefault = !collection || collection.defaultModeId === modeId || collection.modes.length <= 1;
      if (isDefault) {
        rootLines.push(line);
      } else {
        const modeSlug = slugifyTokenName(modeVal.modeName || modeId) || modeId;
        const block = themeBlocks.get(modeSlug) ?? [];
        block.push(line);
        themeBlocks.set(modeSlug, block);
      }
    }
  }

  const sections: string[] = [];
  if (rootLines.length > 0) {
    sections.push(`:root {\n${rootLines.join("\n")}\n}`);
  }
  for (const [modeSlug, lines] of themeBlocks.entries()) {
    sections.push(`[data-theme="${modeSlug}"] {\n${lines.join("\n")}\n}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : "/* Nenhuma variável local encontrada */";
}

function mapDtcgType(variable: SerializedVariable): string {
  switch (variable.resolvedType) {
    case "COLOR":
      return "color";
    case "FLOAT": {
      const scopes = variable.scopes ?? [];
      const isUnitless =
        scopes.length > 0 && scopes.every((s) => UNITLESS_FLOAT_SCOPES.has(s));
      return isUnitless ? "number" : "dimension";
    }
    case "BOOLEAN":
      return "boolean";
    default:
      return "string";
  }
}

function formatDtcgScalar(variable: SerializedVariable, modeValue: VariableModeValue): unknown {
  if (modeValue.aliasTo) {
    const refPath = modeValue.aliasTo.name
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(".");
    if (refPath) {
      return `{${refPath}}`;
    }
  }

  const resolved = modeValue.resolvedValue;
  if (variable.resolvedType === "COLOR") {
    return formatCssColor(resolved);
  }
  if (variable.resolvedType === "FLOAT" && typeof resolved === "number") {
    const scopes = variable.scopes ?? [];
    const isUnitless =
      scopes.length > 0 && scopes.every((s) => UNITLESS_FLOAT_SCOPES.has(s));
    return isUnitless ? resolved : `${resolved}px`;
  }
  return resolved;
}

export function formatVariablesAsDtcg(payload: VariablesPayload): Record<string, unknown> {
  const collectionMap = new Map(payload.collections.map((c) => [c.id, c]));
  const root: Record<string, unknown> = {};

  for (const variable of payload.variables) {
    const collection = collectionMap.get(variable.collectionId);
    const segments = [
      ...(collection ? [collection.name] : []),
      ...variable.name.split("/").map((s) => s.trim()).filter(Boolean),
    ];

    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      const existing = cursor[segment];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }

    const leafKey = segments[segments.length - 1] ?? variable.name;
    const modeEntries = Object.entries(variable.valuesByMode);
    const defaultEntry =
      modeEntries.find(([modeId]) => collection?.defaultModeId === modeId) ?? modeEntries[0];

    const tokenObj: Record<string, unknown> = {
      $type: mapDtcgType(variable),
      $value: defaultEntry ? formatDtcgScalar(variable, defaultEntry[1]) : null,
    };

    if (variable.description) {
      tokenObj.$description = variable.description;
    }

    if (modeEntries.length > 1) {
      const modesMap: Record<string, unknown> = {};
      for (const [, modeValue] of modeEntries) {
        modesMap[modeValue.modeName] = formatDtcgScalar(variable, modeValue);
      }
      tokenObj.$extensions = {
        "com.figma": {
          modes: modesMap,
        },
      };
    }

    cursor[leafKey] = tokenObj;
  }

  return root;
}

export async function handleToolCall(
  bridge: FigmaBridge,
  toolName: string,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = asRecord(rawArgs);
  const file = optionalString(args.file);

  try {
    switch (toolName) {
      case "figma_get_status": {
        const status = await bridge.getStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      }

      case "figma_get_document_info": {
        const result = await bridge.request("get_document_info", {}, { targetFile: file });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_get_selection": {
        const result = await bridge.request(
          "get_selection",
          {
            maxDepth: optionalNumber(args.maxDepth, 8),
            includeCss: optionalBoolean(args.includeCss, true),
            includeHidden: optionalBoolean(args.includeHidden, false),
            includeVectors: optionalBoolean(args.includeVectors, false),
          },
          { targetFile: file }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_get_node": {
        const ids: string[] = [];
        const single = optionalString(args.nodeId);
        if (single) ids.push(single);
        if (Array.isArray(args.nodeIds)) {
          for (const item of args.nodeIds) {
            if (typeof item === "string" && item.trim().length > 0 && !ids.includes(item.trim())) {
              ids.push(item.trim());
            }
          }
        }
        if (ids.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Informe 'nodeId' ou 'nodeIds' com pelo menos um ID de nó válido do Figma.",
              },
            ],
          };
        }

        const result = await bridge.request(
          "get_node",
          {
            nodeIds: ids,
            maxDepth: optionalNumber(args.maxDepth, 8),
            includeCss: optionalBoolean(args.includeCss, true),
            includeHidden: optionalBoolean(args.includeHidden, false),
            includeVectors: optionalBoolean(args.includeVectors, false),
          },
          { targetFile: file }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_get_page_structure": {
        const result = await bridge.request(
          "get_page_structure",
          {
            pageId: optionalString(args.pageId),
            maxDepth: optionalNumber(args.maxDepth, 4),
            includeHidden: optionalBoolean(args.includeHidden, false),
          },
          { targetFile: file }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_search_nodes": {
        const types = Array.isArray(args.types)
          ? args.types.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          : undefined;
        const scope =
          args.scope === "selection" || args.scope === "current_page" || args.scope === "all_pages"
            ? args.scope
            : "current_page";

        const result = await bridge.request(
          "search_nodes",
          {
            query: optionalString(args.query),
            types,
            scope,
            limit: optionalNumber(args.limit, 50),
          },
          { targetFile: file }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_get_styles": {
        const result = await bridge.request("get_styles", {}, { targetFile: file });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_get_variables": {
        const format =
          args.format === "css" || args.format === "dtcg" || args.format === "json"
            ? args.format
            : "json";
        const payload = await bridge.request<VariablesPayload>(
          "get_variables",
          {},
          { targetFile: file }
        );

        if (format === "css") {
          return {
            content: [{ type: "text", text: formatVariablesAsCss(payload) }],
          };
        }
        if (format === "dtcg") {
          return {
            content: [
              { type: "text", text: JSON.stringify(formatVariablesAsDtcg(payload), null, 2) },
            ],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      }

      case "figma_get_components": {
        const scope = args.scope === "all_pages" ? "all_pages" : "current_page";
        const result = await bridge.request(
          "get_components",
          { scope },
          { targetFile: file }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "figma_export_node": {
        const format =
          args.format === "JPG" || args.format === "SVG" || args.format === "PNG"
            ? args.format
            : "PNG";
        const rawScale = optionalNumber(args.scale, 2);
        const scale = Math.min(4, Math.max(0.5, rawScale));
        const savePath = optionalString(args.savePath);

        const exported = await bridge.request<ExportNodeResponse>(
          "export_node",
          {
            nodeId: optionalString(args.nodeId),
            format,
            scale,
          },
          { targetFile: file, timeoutMs: 60_000 }
        );

        let savedTo: string | undefined;
        if (savePath) {
          const resolvedPath = path.resolve(savePath);
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          if (format === "SVG") {
            fs.writeFileSync(resolvedPath, exported.svg ?? "", "utf8");
          } else {
            fs.writeFileSync(resolvedPath, Buffer.from(exported.base64 ?? "", "base64"));
          }
          savedTo = resolvedPath;
        }

        if (format === "SVG") {
          const svgContent = exported.svg ?? "";
          return {
            content: [
              {
                type: "text",
                text: savedTo
                  ? `<!-- Saved to: ${savedTo} -->\n${svgContent}`
                  : svgContent,
              },
            ],
          };
        }

        const mimeType = format === "JPG" ? "image/jpeg" : "image/png";
        const metadata = {
          nodeId: exported.nodeId,
          name: exported.name,
          format: exported.format,
          scale: exported.scale ?? scale,
          byteLength: exported.byteLength,
          ...(savedTo ? { savedTo } : {}),
        };

        return {
          content: [
            {
              type: "image",
              data: exported.base64 ?? "",
              mimeType,
            },
            {
              type: "text",
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Ferramenta desconhecida: ${toolName}` }],
        };
    }
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
