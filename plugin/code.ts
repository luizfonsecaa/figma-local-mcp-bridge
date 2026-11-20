/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 320, height: 320, themeColors: true });

interface RequestContext {
  styleCache: Map<string, BaseStyle | null>;
  variableCache: Map<string, Variable | null>;
  collectionCache: Map<string, VariableCollection | null>;
}

interface TreeOptions {
  maxDepth: number;
  includeCss: boolean;
  includeHidden: boolean;
  includeVectors: boolean;
}

const VECTOR_NODE_TYPES = new Set<string>([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "POLYGON",
]);

const VECTOR_LEAF_TYPES = new Set<string>([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "POLYGON",
  "ELLIPSE",
]);

function createContext(): RequestContext {
  return {
    styleCache: new Map<string, BaseStyle | null>(),
    variableCache: new Map<string, Variable | null>(),
    collectionCache: new Map<string, VariableCollection | null>(),
  };
}

function getFileSummary() {
  return {
    name: figma.root.name,
    currentPage: {
      id: figma.currentPage.id,
      name: figma.currentPage.name,
    },
    selectionCount: figma.currentPage.selection.length,
  };
}

function sendStatus(): void {
  figma.ui.postMessage({
    type: "plugin-status",
    file: getFileSummary(),
  });
}

figma.on("selectionchange", sendStatus);
figma.on("currentpagechange", sendStatus);

function isMixed(val: unknown): boolean {
  return val === figma.mixed;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n * 255)));
}

function toHexByte(n: number): string {
  return clampByte(n).toString(16).padStart(2, "0");
}

function serializeColor(color: RGB | RGBA): Record<string, unknown> {
  const r = Number(color.r.toFixed(4));
  const g = Number(color.g.toFixed(4));
  const b = Number(color.b.toFixed(4));
  const a = "a" in color && typeof color.a === "number" ? Number(color.a.toFixed(4)) : 1;
  const hex =
    a >= 0.999
      ? `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`
      : `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}${toHexByte(a)}`;
  return { hex, r, g, b, a };
}

function serializePaint(paint: Paint): Record<string, unknown> {
  const out: Record<string, unknown> = { type: paint.type };
  if (paint.visible === false) out.visible = false;
  if (typeof paint.opacity === "number" && paint.opacity < 0.999) {
    out.opacity = Number(paint.opacity.toFixed(4));
  }
  if (paint.blendMode && paint.blendMode !== "NORMAL") {
    out.blendMode = paint.blendMode;
  }

  if (paint.type === "SOLID") {
    out.color = serializeColor({
      r: paint.color.r,
      g: paint.color.g,
      b: paint.color.b,
      a: typeof paint.opacity === "number" ? paint.opacity : 1,
    });
  } else if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    out.gradientStops = paint.gradientStops.map((stop) => ({
      position: Number(stop.position.toFixed(4)),
      color: serializeColor(stop.color),
    }));
    out.gradientTransform = paint.gradientTransform;
  } else if (paint.type === "IMAGE") {
    out.scaleMode = paint.scaleMode;
    out.imageHash = paint.imageHash;
    if (paint.scalingFactor !== undefined) {
      out.scalingFactor = paint.scalingFactor;
    }
  }

  return out;
}

function serializePaints(paints: readonly Paint[] | typeof figma.mixed): unknown {
  if (isMixed(paints)) return "mixed";
  if (!Array.isArray(paints) || paints.length === 0) return undefined;
  return paints.map(serializePaint);
}

function serializeEffect(effect: Effect): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: effect.type,
  };
  if (effect.visible === false) out.visible = false;
  if ("radius" in effect) out.radius = effect.radius;
  if ("spread" in effect && typeof effect.spread === "number" && effect.spread !== 0) {
    out.spread = effect.spread;
  }
  if ("offset" in effect && effect.offset) {
    out.offset = effect.offset;
  }
  if ("color" in effect && effect.color) {
    out.color = serializeColor(effect.color);
  }
  if ("blendMode" in effect && effect.blendMode && effect.blendMode !== "NORMAL") {
    out.blendMode = effect.blendMode;
  }
  return out;
}

async function getStyleCached(ctx: RequestContext, id: string): Promise<BaseStyle | null> {
  if (!id) return null;
  if (ctx.styleCache.has(id)) {
    return ctx.styleCache.get(id) ?? null;
  }
  try {
    const style = await figma.getStyleByIdAsync(id);
    ctx.styleCache.set(id, style);
    return style;
  } catch {
    ctx.styleCache.set(id, null);
    return null;
  }
}

async function getVariableCached(ctx: RequestContext, id: string): Promise<Variable | null> {
  if (!id) return null;
  if (ctx.variableCache.has(id)) {
    return ctx.variableCache.get(id) ?? null;
  }
  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    ctx.variableCache.set(id, variable);
    return variable;
  } catch {
    ctx.variableCache.set(id, null);
    return null;
  }
}

async function getCollectionCached(
  ctx: RequestContext,
  id: string
): Promise<VariableCollection | null> {
  if (!id) return null;
  if (ctx.collectionCache.has(id)) {
    return ctx.collectionCache.get(id) ?? null;
  }
  try {
    const col = await figma.variables.getVariableCollectionByIdAsync(id);
    ctx.collectionCache.set(id, col);
    return col;
  } catch {
    ctx.collectionCache.set(id, null);
    return null;
  }
}

function isVariableAlias(val: unknown): val is VariableAlias {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (val as { id?: unknown }).id === "string"
  );
}

async function resolveBoundEntry(ctx: RequestContext, val: unknown): Promise<unknown> {
  if (val === undefined || val === null) return undefined;

  if (isVariableAlias(val)) {
    const variable = await getVariableCached(ctx, val.id);
    if (!variable) return { id: val.id };
    const collection = await getCollectionCached(ctx, variable.variableCollectionId);
    return {
      id: variable.id,
      name: variable.name,
      resolvedType: variable.resolvedType,
      collectionName: collection ? collection.name : undefined,
    };
  }

  if (Array.isArray(val)) {
    const resolvedItems: unknown[] = [];
    for (let i = 0; i < val.length; i++) {
      resolvedItems.push(await resolveBoundEntry(ctx, val[i]));
    }
    return resolvedItems;
  }

  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(val as Record<string, unknown>);
    for (let i = 0; i < entries.length; i++) {
      const pair = entries[i]!;
      const resolved = await resolveBoundEntry(ctx, pair[1]);
      if (resolved !== undefined) {
        out[pair[0]] = resolved;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return val;
}

async function resolveNodeStyles(
  ctx: RequestContext,
  node: SceneNode
): Promise<Record<string, unknown> | undefined> {
  const styleRefs: Array<[string, unknown]> = [];
  if ("fillStyleId" in node) styleRefs.push(["fillStyle", node.fillStyleId]);
  if ("strokeStyleId" in node) styleRefs.push(["strokeStyle", node.strokeStyleId]);
  if ("effectStyleId" in node) styleRefs.push(["effectStyle", node.effectStyleId]);
  if ("textStyleId" in node) styleRefs.push(["textStyle", node.textStyleId]);
  if ("gridStyleId" in node) styleRefs.push(["gridStyle", node.gridStyleId]);

  const resolved: Record<string, unknown> = {};
  for (let i = 0; i < styleRefs.length; i++) {
    const [label, rawId] = styleRefs[i]!;
    if (isMixed(rawId)) {
      resolved[label] = "mixed";
      continue;
    }
    if (typeof rawId === "string" && rawId.length > 0) {
      const style = await getStyleCached(ctx, rawId);
      resolved[label] = style
        ? { id: style.id, name: style.name, key: style.key }
        : { id: rawId };
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function isIconContainer(node: SceneNode): boolean {
  if (VECTOR_NODE_TYPES.has(node.type)) {
    return true;
  }
  if (
    node.type !== "FRAME" &&
    node.type !== "GROUP" &&
    node.type !== "INSTANCE" &&
    node.type !== "COMPONENT"
  ) {
    return false;
  }
  if (node.width > 96 || node.height > 96) {
    return false;
  }
  if (!("children" in node) || node.children.length === 0) {
    return false;
  }

  let hasLeaf = false;
  const stack: SceneNode[] = [...node.children];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if ("children" in cur && cur.children.length > 0 && cur.type !== "BOOLEAN_OPERATION") {
      if (cur.type !== "FRAME" && cur.type !== "GROUP") {
        return false;
      }
      for (let i = 0; i < cur.children.length; i++) {
        stack.push(cur.children[i]!);
      }
    } else {
      if (!VECTOR_LEAF_TYPES.has(cur.type)) {
        return false;
      }
      hasLeaf = true;
    }
  }
  return hasLeaf;
}

function serializeTextNode(node: TextNode): Record<string, unknown> {
  const textData: Record<string, unknown> = {
    characters: node.characters,
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
  };

  if (node.textTruncation && node.textTruncation !== "DISABLED") {
    textData.textTruncation = node.textTruncation;
    if (node.maxLines !== null) {
      textData.maxLines = node.maxLines;
    }
  }

  textData.fontName = isMixed(node.fontName) ? "mixed" : node.fontName;
  textData.fontSize = isMixed(node.fontSize) ? "mixed" : node.fontSize;
  textData.fontWeight = isMixed(node.fontWeight) ? "mixed" : node.fontWeight;
  textData.lineHeight = isMixed(node.lineHeight) ? "mixed" : node.lineHeight;
  textData.letterSpacing = isMixed(node.letterSpacing) ? "mixed" : node.letterSpacing;
  if (!isMixed(node.textCase) && node.textCase !== "ORIGINAL") {
    textData.textCase = node.textCase;
  } else if (isMixed(node.textCase)) {
    textData.textCase = "mixed";
  }
  if (!isMixed(node.textDecoration) && node.textDecoration !== "NONE") {
    textData.textDecoration = node.textDecoration;
  } else if (isMixed(node.textDecoration)) {
    textData.textDecoration = "mixed";
  }
  if (!isMixed(node.hyperlink) && node.hyperlink !== null) {
    textData.hyperlink = node.hyperlink;
  } else if (isMixed(node.hyperlink)) {
    textData.hyperlink = "mixed";
  }

  try {
    const segments = node.getStyledTextSegments([
      "fontName",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "textCase",
      "textDecoration",
      "fills",
      "textStyleId",
      "fillStyleId",
      "hyperlink",
    ]);
    textData.segments = segments.map((seg) => {
      const out: Record<string, unknown> = {
        characters: seg.characters,
        start: seg.start,
        end: seg.end,
        fontName: seg.fontName,
        fontSize: seg.fontSize,
        fontWeight: seg.fontWeight,
        lineHeight: seg.lineHeight,
        letterSpacing: seg.letterSpacing,
      };
      if (seg.textCase !== "ORIGINAL") out.textCase = seg.textCase;
      if (seg.textDecoration !== "NONE") out.textDecoration = seg.textDecoration;
      if (seg.hyperlink) out.hyperlink = seg.hyperlink;
      if (seg.textStyleId) out.textStyleId = seg.textStyleId;
      if (seg.fillStyleId) out.fillStyleId = seg.fillStyleId;
      const fills = serializePaints(seg.fills);
      if (fills !== undefined) out.fills = fills;
      return out;
    });
  } catch {
    // Ignore segment read failures on malformed text nodes
  }

  return textData;
}

async function serializeNode(
  ctx: RequestContext,
  node: SceneNode,
  opts: TreeOptions,
  depth: number
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.visible === false) {
    out.visible = false;
  }
  if ("locked" in node && node.locked) {
    out.locked = true;
  }

  const bounds: Record<string, unknown> = {
    x: Number(node.x.toFixed(2)),
    y: Number(node.y.toFixed(2)),
    width: Number(node.width.toFixed(2)),
    height: Number(node.height.toFixed(2)),
  };
  if ("rotation" in node && typeof node.rotation === "number" && Math.abs(node.rotation) > 0.001) {
    bounds.rotation = Number(node.rotation.toFixed(2));
  }
  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    bounds.absolute = {
      x: Number(node.absoluteBoundingBox.x.toFixed(2)),
      y: Number(node.absoluteBoundingBox.y.toFixed(2)),
      width: Number(node.absoluteBoundingBox.width.toFixed(2)),
      height: Number(node.absoluteBoundingBox.height.toFixed(2)),
    };
  }
  out.bounds = bounds;

  if ("opacity" in node && typeof node.opacity === "number" && node.opacity < 0.999) {
    out.opacity = Number(node.opacity.toFixed(4));
  }
  if (
    "blendMode" in node &&
    node.blendMode !== "PASS_THROUGH" &&
    node.blendMode !== "NORMAL"
  ) {
    out.blendMode = node.blendMode;
  }

  if ("clipsContent" in node && node.clipsContent) {
    out.clipsContent = true;
  }

  // Auto Layout container properties
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    const autoLayout: Record<string, unknown> = {
      layoutMode: node.layoutMode,
      primaryAxisAlignItems: node.primaryAxisAlignItems,
      counterAxisAlignItems: node.counterAxisAlignItems,
      primaryAxisSizingMode: node.primaryAxisSizingMode,
      counterAxisSizingMode: node.counterAxisSizingMode,
      itemSpacing: node.itemSpacing,
      padding: {
        top: node.paddingTop,
        right: node.paddingRight,
        bottom: node.paddingBottom,
        left: node.paddingLeft,
      },
    };
    if ("layoutWrap" in node && node.layoutWrap !== "NO_WRAP") {
      autoLayout.layoutWrap = node.layoutWrap;
      autoLayout.counterAxisSpacing = node.counterAxisSpacing;
    }
    if ("itemReverseZIndex" in node && node.itemReverseZIndex) {
      autoLayout.itemReverseZIndex = true;
    }
    out.autoLayout = autoLayout;
  } else if ("inferredAutoLayout" in node && node.inferredAutoLayout) {
    out.inferredAutoLayout = {
      layoutMode: node.inferredAutoLayout.layoutMode,
      primaryAxisAlignItems: node.inferredAutoLayout.primaryAxisAlignItems,
      counterAxisAlignItems: node.inferredAutoLayout.counterAxisAlignItems,
      itemSpacing: node.inferredAutoLayout.itemSpacing,
      padding: {
        top: node.inferredAutoLayout.paddingTop,
        right: node.inferredAutoLayout.paddingRight,
        bottom: node.inferredAutoLayout.paddingBottom,
        left: node.inferredAutoLayout.paddingLeft,
      },
    };
  }

  // Child sizing, positioning & constraints
  const layoutProps: Record<string, unknown> = {};
  if ("layoutSizingHorizontal" in node) layoutProps.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if ("layoutSizingVertical" in node) layoutProps.layoutSizingVertical = node.layoutSizingVertical;
  if ("layoutAlign" in node && node.layoutAlign !== "INHERIT") layoutProps.layoutAlign = node.layoutAlign;
  if ("layoutGrow" in node && node.layoutGrow !== 0) layoutProps.layoutGrow = node.layoutGrow;
  if ("layoutPositioning" in node && node.layoutPositioning !== "AUTO") {
    layoutProps.layoutPositioning = node.layoutPositioning;
  }
  if ("constraints" in node) layoutProps.constraints = node.constraints;
  if ("minWidth" in node && node.minWidth !== null) layoutProps.minWidth = node.minWidth;
  if ("maxWidth" in node && node.maxWidth !== null) layoutProps.maxWidth = node.maxWidth;
  if ("minHeight" in node && node.minHeight !== null) layoutProps.minHeight = node.minHeight;
  if ("maxHeight" in node && node.maxHeight !== null) layoutProps.maxHeight = node.maxHeight;
  if (Object.keys(layoutProps).length > 0) {
    out.layoutProps = layoutProps;
  }

  // Fills & Strokes
  if ("fills" in node) {
    const fills = serializePaints(node.fills);
    if (fills !== undefined) out.fills = fills;
  }

  if ("strokes" in node) {
    const strokes = serializePaints(node.strokes);
    if (strokes !== undefined) {
      out.strokes = strokes;
      if ("strokeAlign" in node) out.strokeAlign = node.strokeAlign;
      if ("strokeWeight" in node) {
        if (isMixed(node.strokeWeight)) {
          if ("strokeTopWeight" in node) {
            out.individualStrokeWeights = {
              top: node.strokeTopWeight,
              right: node.strokeRightWeight,
              bottom: node.strokeBottomWeight,
              left: node.strokeLeftWeight,
            };
          } else {
            out.strokeWeight = "mixed";
          }
        } else {
          out.strokeWeight = node.strokeWeight;
        }
      }
      if ("dashPattern" in node && node.dashPattern.length > 0) {
        out.dashPattern = node.dashPattern;
      }
    }
  }

  // Corner radii
  if ("cornerRadius" in node) {
    if (isMixed(node.cornerRadius)) {
      if ("topLeftRadius" in node) {
        out.cornerRadius = {
          topLeft: node.topLeftRadius,
          topRight: node.topRightRadius,
          bottomRight: node.bottomRightRadius,
          bottomLeft: node.bottomLeftRadius,
        };
      }
    } else if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
      out.cornerRadius = node.cornerRadius;
    }
    if ("cornerSmoothing" in node && node.cornerSmoothing > 0) {
      out.cornerSmoothing = Number(node.cornerSmoothing.toFixed(3));
    }
  }

  // Effects
  if ("effects" in node && Array.isArray(node.effects) && node.effects.length > 0) {
    out.effects = node.effects.map(serializeEffect);
  }

  // Text
  if (node.type === "TEXT") {
    out.text = serializeTextNode(node);
  }

  // Styles & Bound variables
  const resolvedStyles = await resolveNodeStyles(ctx, node);
  if (resolvedStyles) {
    out.resolvedStyles = resolvedStyles;
  }

  if ("boundVariables" in node && node.boundVariables) {
    const resolvedBound = await resolveBoundEntry(ctx, node.boundVariables);
    if (resolvedBound !== undefined) {
      out.resolvedBoundVariables = resolvedBound;
    }
  }

  // Component / Instance metadata
  if (node.type === "INSTANCE") {
    try {
      const mainComp = await node.getMainComponentAsync();
      const compInfo: Record<string, unknown> = {
        mainComponent: mainComp
          ? {
              id: mainComp.id,
              name: mainComp.name,
              key: mainComp.key,
              parentSetName:
                mainComp.parent && mainComp.parent.type === "COMPONENT_SET"
                  ? mainComp.parent.name
                  : undefined,
            }
          : null,
      };
      if (node.componentProperties && Object.keys(node.componentProperties).length > 0) {
        compInfo.componentProperties = node.componentProperties;
      }
      out.componentInfo = compInfo;
    } catch {
      // Ignore mainComponent resolution errors
    }
  } else if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    const compInfo: Record<string, unknown> = {
      key: node.key,
      description: node.description || undefined,
    };
    try {
      if (node.componentPropertyDefinitions) {
        compInfo.componentPropertyDefinitions = node.componentPropertyDefinitions;
      }
    } catch {
      // Variant COMPONENT inside COMPONENT_SET throws on componentPropertyDefinitions
    }
    out.componentInfo = compInfo;
  }

  // Native Dev-Mode CSS
  if (opts.includeCss && "getCSSAsync" in node) {
    try {
      const css = await node.getCSSAsync();
      if (css && Object.keys(css).length > 0) {
        out.css = css;
      }
    } catch {
      // Ignore getCSSAsync errors on unsupported nodes
    }
  }

  // Icon / Vector candidate marking
  const iconCandidate = isIconContainer(node);
  if (iconCandidate) {
    out.isIconCandidate = true;
  }

  // Children recursion
  if ("children" in node && node.children.length > 0) {
    if (iconCandidate && !opts.includeVectors) {
      out.vectorChildCount = node.children.length;
    } else if (opts.maxDepth >= 0 && depth >= opts.maxDepth) {
      out.truncatedChildrenCount = node.children.length;
    } else {
      const children: Array<Record<string, unknown>> = [];
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        if (!opts.includeHidden && child.visible === false) {
          continue;
        }
        children.push(await serializeNode(ctx, child, opts, depth + 1));
      }
      out.children = children;
    }
  }

  return out;
}

function serializeOutlineNode(
  node: SceneNode,
  maxDepth: number,
  includeHidden: boolean,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: {
      x: Number(node.x.toFixed(1)),
      y: Number(node.y.toFixed(1)),
      width: Number(node.width.toFixed(1)),
      height: Number(node.height.toFixed(1)),
    },
  };

  if (node.visible === false) {
    out.visible = false;
  }
  if (node.type === "TEXT") {
    const text = node.characters;
    out.characters = text.length > 80 ? text.slice(0, 80) + "..." : text;
  }

  if ("children" in node) {
    out.childCount = node.children.length;
    if (node.children.length > 0 && (maxDepth < 0 || depth < maxDepth)) {
      const children: Array<Record<string, unknown>> = [];
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        if (!includeHidden && child.visible === false) continue;
        children.push(serializeOutlineNode(child, maxDepth, includeHidden, depth + 1));
      }
      out.children = children;
    }
  }

  return out;
}

async function resolveVariableValue(
  ctx: RequestContext,
  val: VariableValue,
  preferredModeId: string,
  visited: Set<string>
): Promise<{
  resolvedValue: unknown;
  aliasTo?: { id: string; name: string; collectionName?: string };
}> {
  if (isVariableAlias(val)) {
    const targetVar = await getVariableCached(ctx, val.id);
    if (!targetVar) {
      return { resolvedValue: val };
    }
    const targetCol = await getCollectionCached(ctx, targetVar.variableCollectionId);
    const aliasMeta = {
      id: targetVar.id,
      name: targetVar.name,
      collectionName: targetCol ? targetCol.name : undefined,
    };

    if (visited.has(val.id)) {
      return { resolvedValue: `[Circular: ${targetVar.name}]`, aliasTo: aliasMeta };
    }

    const nextVisited = new Set(visited);
    nextVisited.add(val.id);

    let nextModeId = preferredModeId;
    if (!(nextModeId in targetVar.valuesByMode)) {
      if (targetCol && targetCol.defaultModeId in targetVar.valuesByMode) {
        nextModeId = targetCol.defaultModeId;
      } else {
        const availableModes = Object.keys(targetVar.valuesByMode);
        nextModeId = availableModes[0] ?? preferredModeId;
      }
    }

    const nextVal = targetVar.valuesByMode[nextModeId];
    if (nextVal === undefined) {
      return { resolvedValue: null, aliasTo: aliasMeta };
    }

    const inner = await resolveVariableValue(ctx, nextVal, nextModeId, nextVisited);
    return {
      resolvedValue: inner.resolvedValue,
      aliasTo: aliasMeta,
    };
  }

  if (
    typeof val === "object" &&
    val !== null &&
    "r" in val &&
    "g" in val &&
    "b" in val
  ) {
    return { resolvedValue: serializeColor(val as RGBA) };
  }

  return { resolvedValue: val };
}

function getTreeOptions(params: Record<string, unknown>): TreeOptions {
  return {
    maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : 8,
    includeCss: typeof params.includeCss === "boolean" ? params.includeCss : true,
    includeHidden: typeof params.includeHidden === "boolean" ? params.includeHidden : false,
    includeVectors: typeof params.includeVectors === "boolean" ? params.includeVectors : false,
  };
}

async function handleGetDocumentInfo() {
  const pages = figma.root.children.map((page) => ({
    id: page.id,
    name: page.name,
    isCurrent: page.id === figma.currentPage.id,
  }));

  const topLevelFrames = figma.currentPage.children.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    bounds: {
      x: Number(node.x.toFixed(2)),
      y: Number(node.y.toFixed(2)),
      width: Number(node.width.toFixed(2)),
      height: Number(node.height.toFixed(2)),
    },
  }));

  const selection = figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: {
      x: Number(node.x.toFixed(2)),
      y: Number(node.y.toFixed(2)),
      width: Number(node.width.toFixed(2)),
      height: Number(node.height.toFixed(2)),
    },
  }));

  return {
    fileName: figma.root.name,
    currentPage: {
      id: figma.currentPage.id,
      name: figma.currentPage.name,
    },
    pages,
    topLevelFrames,
    selection,
  };
}

async function handleGetSelection(params: Record<string, unknown>) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return {
      fileName: figma.root.name,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      selectionCount: 0,
      nodes: [],
      message: "Nenhum nó selecionado atualmente no Figma Desktop.",
    };
  }

  const ctx = createContext();
  const opts = getTreeOptions(params);
  const nodes: Array<Record<string, unknown>> = [];
  for (let i = 0; i < selection.length; i++) {
    nodes.push(await serializeNode(ctx, selection[i]!, opts, 0));
  }

  return {
    fileName: figma.root.name,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selectionCount: nodes.length,
    nodes,
  };
}

async function handleGetNode(params: Record<string, unknown>) {
  const nodeIds = Array.isArray(params.nodeIds)
    ? params.nodeIds.filter((id): id is string => typeof id === "string")
    : [];
  const ctx = createContext();
  const opts = getTreeOptions(params);

  const nodes: Array<Record<string, unknown>> = [];
  const notFound: string[] = [];

  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i]!;
    const baseNode = await figma.getNodeByIdAsync(id);
    if (!baseNode || baseNode.type === "DOCUMENT") {
      notFound.push(id);
      continue;
    }
    if (baseNode.type === "PAGE") {
      await baseNode.loadAsync();
      const children: Array<Record<string, unknown>> = [];
      for (let j = 0; j < baseNode.children.length; j++) {
        const child = baseNode.children[j]!;
        if (!opts.includeHidden && child.visible === false) continue;
        children.push(await serializeNode(ctx, child, opts, 1));
      }
      nodes.push({
        id: baseNode.id,
        name: baseNode.name,
        type: baseNode.type,
        children,
      });
      continue;
    }
    nodes.push(await serializeNode(ctx, baseNode as SceneNode, opts, 0));
  }

  return {
    fileName: figma.root.name,
    nodes,
    notFound: notFound.length > 0 ? notFound : undefined,
  };
}

async function handleGetPageStructure(params: Record<string, unknown>) {
  let targetPage: PageNode = figma.currentPage;
  if (typeof params.pageId === "string" && params.pageId.length > 0) {
    const candidate = await figma.getNodeByIdAsync(params.pageId);
    if (!candidate || candidate.type !== "PAGE") {
      throw new Error(`Página não encontrada para pageId '${params.pageId}'.`);
    }
    targetPage = candidate;
  }

  await targetPage.loadAsync();
  const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : 4;
  const includeHidden = typeof params.includeHidden === "boolean" ? params.includeHidden : false;

  const children: Array<Record<string, unknown>> = [];
  for (let i = 0; i < targetPage.children.length; i++) {
    const child = targetPage.children[i]!;
    if (!includeHidden && child.visible === false) continue;
    children.push(serializeOutlineNode(child, maxDepth, includeHidden, 1));
  }

  return {
    fileName: figma.root.name,
    page: { id: targetPage.id, name: targetPage.name },
    childCount: targetPage.children.length,
    children,
  };
}

async function handleSearchNodes(params: Record<string, unknown>) {
  const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
  const typeFilter = Array.isArray(params.types)
    ? new Set(params.types.filter((t): t is string => typeof t === "string"))
    : null;
  const scope =
    params.scope === "selection" || params.scope === "all_pages" ? params.scope : "current_page";
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 200) : 50;

  let roots: Array<{ node: SceneNode; pageName: string }> = [];
  if (scope === "selection") {
    roots = figma.currentPage.selection.map((n) => ({
      node: n,
      pageName: figma.currentPage.name,
    }));
  } else if (scope === "all_pages") {
    await figma.loadAllPagesAsync();
    for (let p = 0; p < figma.root.children.length; p++) {
      const page = figma.root.children[p]!;
      for (let c = 0; c < page.children.length; c++) {
        roots.push({ node: page.children[c]!, pageName: page.name });
      }
    }
  } else {
    roots = figma.currentPage.children.map((n) => ({
      node: n,
      pageName: figma.currentPage.name,
    }));
  }

  const results: Array<Record<string, unknown>> = [];
  const queue = [...roots];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!;
    const n = current.node;

    const typeMatch = !typeFilter || typeFilter.size === 0 || typeFilter.has(n.type);
    const nameMatch = !query || n.name.toLowerCase().includes(query);
    const textMatch =
      !query ||
      (n.type === "TEXT" && n.characters.toLowerCase().includes(query));

    if (typeMatch && (nameMatch || textMatch)) {
      const hit: Record<string, unknown> = {
        id: n.id,
        name: n.name,
        type: n.type,
        pageName: current.pageName,
        visible: n.visible,
        bounds: {
          x: Number(n.x.toFixed(1)),
          y: Number(n.y.toFixed(1)),
          width: Number(n.width.toFixed(1)),
          height: Number(n.height.toFixed(1)),
        },
      };
      if (n.type === "TEXT") {
        hit.characters =
          n.characters.length > 120 ? n.characters.slice(0, 120) + "..." : n.characters;
      }
      results.push(hit);
    }

    if ("children" in n && n.children.length > 0) {
      for (let i = 0; i < n.children.length; i++) {
        queue.push({ node: n.children[i]!, pageName: current.pageName });
      }
    }
  }

  return {
    fileName: figma.root.name,
    scope,
    count: results.length,
    results,
  };
}

async function handleGetStyles() {
  const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);

  return {
    fileName: figma.root.name,
    paintStyles: paintStyles.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description || undefined,
      paints: s.paints.map(serializePaint),
    })),
    textStyles: textStyles.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description || undefined,
      fontName: s.fontName,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      paragraphSpacing: s.paragraphSpacing,
      paragraphIndent: s.paragraphIndent,
      textCase: s.textCase,
      textDecoration: s.textDecoration,
    })),
    effectStyles: effectStyles.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description || undefined,
      effects: s.effects.map(serializeEffect),
    })),
    gridStyles: gridStyles.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description || undefined,
      layoutGrids: s.layoutGrids,
    })),
  };
}

async function handleGetVariables() {
  const ctx = createContext();
  const [collections, variables] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);

  for (let i = 0; i < collections.length; i++) {
    ctx.collectionCache.set(collections[i]!.id, collections[i]!);
  }
  for (let i = 0; i < variables.length; i++) {
    ctx.variableCache.set(variables[i]!.id, variables[i]!);
  }

  const serializedCollections = collections.map((col) => ({
    id: col.id,
    name: col.name,
    defaultModeId: col.defaultModeId,
    modes: col.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
  }));

  const serializedVariables: Array<Record<string, unknown>> = [];

  for (let i = 0; i < variables.length; i++) {
    const v = variables[i]!;
    const col = ctx.collectionCache.get(v.variableCollectionId);
    const modeNameMap = new Map<string, string>();
    if (col) {
      for (let m = 0; m < col.modes.length; m++) {
        modeNameMap.set(col.modes[m]!.modeId, col.modes[m]!.name);
      }
    }

    const valuesByMode: Record<string, unknown> = {};
    const modeEntries = Object.entries(v.valuesByMode);
    for (let m = 0; m < modeEntries.length; m++) {
      const [modeId, rawVal] = modeEntries[m]!;
      const resolved = await resolveVariableValue(ctx, rawVal, modeId, new Set([v.id]));
      valuesByMode[modeId] = {
        modeId,
        modeName: modeNameMap.get(modeId) ?? modeId,
        rawValue: rawVal,
        resolvedValue: resolved.resolvedValue,
        aliasTo: resolved.aliasTo,
      };
    }

    serializedVariables.push({
      id: v.id,
      name: v.name,
      collectionId: v.variableCollectionId,
      collectionName: col ? col.name : "",
      resolvedType: v.resolvedType,
      description: v.description || undefined,
      scopes: v.scopes,
      codeSyntax: v.codeSyntax && Object.keys(v.codeSyntax).length > 0 ? v.codeSyntax : undefined,
      valuesByMode,
    });
  }

  return {
    collections: serializedCollections,
    variables: serializedVariables,
  };
}

async function handleGetComponents(params: Record<string, unknown>) {
  const scope = params.scope === "all_pages" ? "all_pages" : "current_page";
  let pages: PageNode[];

  if (scope === "all_pages") {
    await figma.loadAllPagesAsync();
    pages = [...figma.root.children];
  } else {
    pages = [figma.currentPage];
  }

  const components: Array<Record<string, unknown>> = [];

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]!;
    const found = page.findAllWithCriteria({
      types: ["COMPONENT", "COMPONENT_SET"],
    });

    for (let i = 0; i < found.length; i++) {
      const comp = found[i]!;
      if (comp.type === "COMPONENT" && comp.parent && comp.parent.type === "COMPONENT_SET") {
        continue;
      }

      const item: Record<string, unknown> = {
        id: comp.id,
        key: comp.key,
        name: comp.name,
        type: comp.type,
        pageName: page.name,
        description: comp.description || undefined,
        bounds: {
          width: Number(comp.width.toFixed(2)),
          height: Number(comp.height.toFixed(2)),
        },
      };

      try {
        if (comp.componentPropertyDefinitions) {
          item.componentPropertyDefinitions = comp.componentPropertyDefinitions;
        }
      } catch {
        // Ignore if property definitions cannot be read
      }

      if (comp.type === "COMPONENT_SET") {
        try {
          item.variantGroupProperties = comp.variantGroupProperties;
        } catch {
          // Ignore invalid variant sets
        }
        item.variantCount = comp.children.length;
      }

      components.push(item);
    }
  }

  return {
    fileName: figma.root.name,
    scope,
    count: components.length,
    components,
  };
}

async function handleExportNode(params: Record<string, unknown>) {
  const nodeId = typeof params.nodeId === "string" ? params.nodeId : undefined;
  const format =
    params.format === "JPG" || params.format === "SVG" || params.format === "PNG"
      ? params.format
      : "PNG";
  const scale = typeof params.scale === "number" ? params.scale : 2;

  let target: BaseNode | null = null;
  if (nodeId) {
    target = await figma.getNodeByIdAsync(nodeId);
    if (!target) {
      throw new Error(`Nó '${nodeId}' não encontrado no documento.`);
    }
  } else {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      throw new Error("Nenhum nodeId informado e nenhum nó selecionado no Figma Desktop.");
    }
    target = sel[0]!;
  }

  if (!("exportAsync" in target)) {
    throw new Error(`O nó '${target.name}' (${target.type}) não suporta exportação.`);
  }

  const exportable = target as SceneNode;
  const bytes =
    format === "SVG"
      ? await exportable.exportAsync({ format: "SVG" })
      : await exportable.exportAsync({
          format,
          constraint: { type: "SCALE", value: scale },
        });

  return {
    __binaryExport: true,
    nodeId: exportable.id,
    name: exportable.name,
    format,
    scale: format === "SVG" ? undefined : scale,
    bytes,
  };
}

async function dispatchRequest(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (method) {
    case "get_document_info":
      return handleGetDocumentInfo();
    case "get_selection":
      return handleGetSelection(params);
    case "get_node":
      return handleGetNode(params);
    case "get_page_structure":
      return handleGetPageStructure(params);
    case "search_nodes":
      return handleSearchNodes(params);
    case "get_styles":
      return handleGetStyles();
    case "get_variables":
      return handleGetVariables();
    case "get_components":
      return handleGetComponents(params);
    case "export_node":
      return handleExportNode(params);
    default:
      throw new Error(`Método RPC desconhecido no plugin: '${method}'`);
  }
}

figma.ui.onmessage = async (msg: unknown) => {
  if (!msg || typeof msg !== "object") return;
  const data = msg as {
    type?: string;
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    width?: number;
    height?: number;
  };

  if (data.type === "ui-ready") {
    sendStatus();
    return;
  }

  if (data.type === "resize" && typeof data.width === "number" && typeof data.height === "number") {
    const width = Math.min(800, Math.max(160, Math.round(data.width)));
    const height = Math.min(600, Math.max(36, Math.round(data.height)));
    figma.ui.resize(width, height);
    return;
  }

  if (data.type === "request" && typeof data.id === "string" && typeof data.method === "string") {
    try {
      const result = await dispatchRequest(data.method, data.params ?? {});
      figma.ui.postMessage({
        type: "response",
        id: data.id,
        ok: true,
        result,
      });
    } catch (err) {
      figma.ui.postMessage({
        type: "response",
        id: data.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

sendStatus();
