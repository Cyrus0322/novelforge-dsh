import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PageProps } from '../app/types.ts'
import { api } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { label, truncate } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Loading, Stat } from '../components/ui.tsx'
import type { Entity, Relation } from '../lib/types.ts'

// ── 常量 ─────────────────────────────────────────────────

const VIEW_W = 960
const VIEW_H = 620
const PADDING = 52
const SPRING_LENGTH = 132
const REPULSION = 20000
const ITERATIONS = 110

const KIND_COLORS: Record<string, string> = {
  character: '#d8a657',
  faction: '#7aa7dc',
  location: '#6cc08b',
  item: '#c792ea',
  ability: '#e3726a',
  world_rule: '#dfa95c',
  other: '#8e95a5',
}
const KIND_ORDER: readonly string[] = ['character', 'faction', 'location', 'item', 'ability', 'world_rule', 'other']

const NODE_TEXT = '#c9ccd4'
const EDGE_COLOR = '#394253'
const EDGE_LABEL = '#8e95a5'
const HIGHLIGHT = '#d8a657'

type GraphMode = 'all' | 'people'

interface GraphNode {
  id: string
  name: string
  kind: string
  importance: number
  x: number
  y: number
}

interface GraphEdge {
  id: string
  sourceId: string
  targetId: string
  kind: string
  tension: string
  sourceName: string
  targetName: string
}

interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

function colorOf(kind: string): string {
  return KIND_COLORS[kind] ?? KIND_COLORS.other ?? '#8e95a5'
}

function radiusOf(importance: number): number {
  const clamped = Math.min(5, Math.max(1, Number.isFinite(importance) ? importance : 3))
  return 8 + clamped * 2.6
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 手写力导向布局：圆形初始位 → 斥力（节点互推）+ 引力（关系弹簧）+ 轻微向心 → 90 次迭代。
 * 返回的坐标都在 viewBox 内，且完全由实体/关系数据决定，不依赖第三方库。
 */
function computeLayout(entities: Entity[], relations: Relation[], mode: GraphMode): GraphLayout {
  const visible = mode === 'people' ? entities.filter(entity => entity.kind === 'character') : entities
  const visibleIds = new Set(visible.map(entity => entity.id))
  const edges: GraphEdge[] = relations
    .filter(relation => visibleIds.has(relation.sourceId) && visibleIds.has(relation.targetId))
    .map(relation => ({
      id: relation.id,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      kind: relation.kind,
      tension: relation.tension,
      sourceName: relation.sourceName,
      targetName: relation.targetName,
    }))

  const nodes: GraphNode[] = visible.map((entity, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(visible.length, 1) - Math.PI / 2
    const ring = Math.min(VIEW_W, VIEW_H) * 0.34
    return {
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      importance: entity.importance,
      x: VIEW_W / 2 + Math.cos(angle) * ring,
      y: VIEW_H / 2 + Math.sin(angle) * ring,
    }
  })

  const nodeById = new Map<string, GraphNode>()
  for (const node of nodes) nodeById.set(node.id, node)

  for (let step = 0; step < ITERATIONS; step += 1) {
    // 向心：避免整张图飘出画布。
    for (const node of nodes) {
      node.x += (VIEW_W / 2 - node.x) * 0.0025
      node.y += (VIEW_H / 2 - node.y) * 0.0025
    }

    // 斥力：节点两两相推。
    for (let i = 0; i < nodes.length; i += 1) {
      const first = nodes[i]
      if (!first) continue
      for (let j = i + 1; j < nodes.length; j += 1) {
        const second = nodes[j]
        if (!second) continue
        let dx = first.x - second.x
        let dy = first.y - second.y
        let distanceSq = dx * dx + dy * dy
        if (distanceSq < 1) {
          dx = (i - j) * 0.5 + 0.3
          dy = (j - i) * 0.5 + 0.3
          distanceSq = dx * dx + dy * dy
        }
        const distance = Math.sqrt(distanceSq)
        const force = Math.min(18, REPULSION / distanceSq)
        const ux = dx / distance
        const uy = dy / distance
        first.x += ux * force
        first.y += uy * force
        second.x -= ux * force
        second.y -= uy * force
      }
    }

    // 引力：有关系的节点互相拉近。
    for (const edge of edges) {
      const source = nodeById.get(edge.sourceId)
      const target = nodeById.get(edge.targetId)
      if (!source || !target) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.sqrt(dx * dx + dy * dy) || 1
      const force = (distance - SPRING_LENGTH) * 0.02
      const ux = dx / distance
      const uy = dy / distance
      source.x += ux * force
      source.y += uy * force
      target.x -= ux * force
      target.y -= uy * force
    }

    for (const node of nodes) {
      node.x = clamp(node.x, PADDING, VIEW_W - PADDING)
      node.y = clamp(node.y, PADDING, VIEW_H - PADDING)
    }
  }

  return { nodes, edges }
}

// ── 页面 ─────────────────────────────────────────────────

export function GraphPage({ projectId, navigate }: PageProps) {
  const entities = useResource(() => api.listEntities(projectId), [projectId])
  const relations = useResource(() => api.listRelations(projectId), [projectId])

  const [mode, setMode] = useState<GraphMode>('all')
  const [showLabels, setShowLabels] = useState(true)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)

  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const movedRef = useRef(false)

  const entityList = entities.data ?? []
  const relationList = relations.data ?? []

  const layout = useMemo(
    () => computeLayout(entityList, relationList, mode),
    [entityList, relationList, mode],
  )

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of layout.nodes) map.set(node.id, node)
    return map
  }, [layout.nodes])

  const kindCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const entity of entityList) map.set(entity.kind, (map.get(entity.kind) ?? 0) + 1)
    return map
  }, [entityList])

  const relationLabel = (edge: GraphEdge): string => {
    const from = truncate(edge.sourceName, 12)
    const to = truncate(edge.targetName, 12)
    return `${from} → ${to}`
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (event.button !== 0) return
    movedRef.current = false
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    }
    setDragging(true)
    // 不在这里捕获指针：捕获会让后续 click 重定向到 <svg>，节点点击就失效了。
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    // 真正开始拖拽后才捕获指针：既保证拖出画布也顺滑，又不影响单击节点。
    if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > 3) {
      movedRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setPan({ x: drag.originX + dx, y: drag.originY + dy })
  }

  function endDrag(event: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function openEntities(): void {
    navigate(`/p/${encodeURIComponent(projectId)}/entities`)
  }

  function openEntityPage(name: string): void {
    toast.info(`资料页里可用搜索框定位「${truncate(name, 12)}」。`)
    openEntities()
  }

  if (entities.loading && !entities.data) return <Loading text="正在载入人物与关系…" />
  if (entities.error) return <ErrorBox error={entities.error} onRetry={entities.reload} />
  if (relations.error) return <ErrorBox error={relations.error} onRetry={relations.reload} />

  const peopleCount = entityList.filter(entity => entity.kind === 'character').length

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)' }}>关系图谱</h1>
          <div className="muted small">节点 = 实体，连线 = 人物关系；位置由内置力导向布局算出，不依赖任何图表库。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => { entities.reload(); relations.reload() }}>刷新</button>
          <button type="button" className="btn" onClick={openEntities}>编辑资料与关系</button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="实体" value={entityList.length} hint={`人物 ${peopleCount}`} />
        <Stat label="关系" value={relationList.length} hint="带类型与张力" tone={relationList.length > 0 ? 'accent' : 'warn'} />
        <Stat label="当前显示" value={layout.nodes.length} hint={mode === 'people' ? '只看人物' : '全部实体'} />
        <Stat label="连线" value={layout.edges.length} hint={mode === 'people' ? '两端都是人物' : '两端都在图中'} />
      </div>

      {entityList.length === 0 ? (
        <Empty
          title="还没有任何实体"
          hint="关系图谱的节点来自资料库：先建人物（主角、反派、配角），再给它们加「师徒 / 宿敌 / 利益同盟」这类关系。"
          action={<button type="button" className="btn btn-sm btn-primary" onClick={openEntities}>去建人物</button>}
        />
      ) : mode === 'people' && layout.nodes.length === 0 ? (
        <Empty
          title="还没有人物实体"
          hint="资料库里只有非人物实体。切到「全部实体」看全图，或去资料页建人物。"
          action={<button type="button" className="btn btn-sm" onClick={() => setMode('all')}>查看全部实体</button>}
        />
      ) : (
        <div className="split">
          <Card
            tight
            title="关系网络"
            subtitle={`${layout.nodes.length} 个节点 · ${layout.edges.length} 条关系 · 节点越大越重要 · 拖拽空白处平移`}
            actions={(
              <>
                <button
                  type="button"
                  className={`chip${mode === 'all' ? ' active' : ''}`}
                  style={{ font: 'inherit' }}
                  onClick={() => setMode('all')}
                >
                  全部实体 <span className="tiny">{entityList.length}</span>
                </button>
                <button
                  type="button"
                  className={`chip${mode === 'people' ? ' active' : ''}`}
                  style={{ font: 'inherit' }}
                  onClick={() => setMode('people')}
                >
                  只看人物 <span className="tiny">{peopleCount}</span>
                </button>
                <button
                  type="button"
                  className={`chip${showLabels ? ' active' : ''}`}
                  style={{ font: 'inherit' }}
                  onClick={() => setShowLabels(value => !value)}
                >
                  关系标签
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPan({ x: 0, y: 0 })}>重置视图</button>
              </>
            )}
          >
            {layout.edges.length === 0 && (
              <div className="hint-box" style={{ marginBottom: 10 }}>
                还没有关系连线。关系决定冲突与对白语气，去「编辑资料与关系」给人物之间加几条（例如：师徒 / 宿敌 / 血亲）。
              </div>
            )}
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-soft)' }}>
              <svg
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                role="img"
                aria-label="人物关系图谱"
                style={{ display: 'block', width: '100%', height: 'auto', touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <defs>
                  <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLOR} />
                  </marker>
                </defs>

                <g transform={`translate(${pan.x} ${pan.y})`}>
                  {layout.edges.map(edge => {
                    const source = nodeById.get(edge.sourceId)
                    const target = nodeById.get(edge.targetId)
                    if (!source || !target) return null
                    const dx = target.x - source.x
                    const dy = target.y - source.y
                    const distance = Math.sqrt(dx * dx + dy * dy) || 1
                    const ux = dx / distance
                    const uy = dy / distance
                    const startX = source.x + ux * (radiusOf(source.importance) + 3)
                    const startY = source.y + uy * (radiusOf(source.importance) + 3)
                    const endX = target.x - ux * (radiusOf(target.importance) + 7)
                    const endY = target.y - uy * (radiusOf(target.importance) + 7)
                    const active = hoverEdgeId === edge.id
                      || hoverNodeId === edge.sourceId
                      || hoverNodeId === edge.targetId
                    const midX = (startX + endX) / 2
                    const midY = (startY + endY) / 2
                    return (
                      <g key={edge.id} pointerEvents="none">
                        <line
                          x1={startX}
                          y1={startY}
                          x2={endX}
                          y2={endY}
                          stroke={active ? HIGHLIGHT : EDGE_COLOR}
                          strokeWidth={active ? 2.2 : 1.2}
                          markerEnd="url(#graph-arrow)"
                        />
                        {showLabels && (
                          <text
                            x={midX}
                            y={midY - 4}
                            textAnchor="middle"
                            fontSize={10}
                            fill={active ? HIGHLIGHT : EDGE_LABEL}
                            stroke="#0f1218"
                            strokeWidth={3}
                            paintOrder="stroke"
                            strokeLinejoin="round"
                            style={{ fontFamily: 'var(--sans)' }}
                          >
                            {edge.kind || '关系'}
                          </text>
                        )}
                      </g>
                    )
                  })}

                  {layout.nodes.map(node => {
                    const radius = radiusOf(node.importance)
                    const hovered = hoverNodeId === node.id
                    const connected = hoverNodeId !== null
                      && (node.id === hoverNodeId || layout.edges.some(edge =>
                        (edge.sourceId === hoverNodeId && edge.targetId === node.id)
                        || (edge.targetId === hoverNodeId && edge.sourceId === node.id),
                      ))
                    return (
                      <g
                        key={node.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`打开 ${node.name} 的资料`}
                        style={{ cursor: 'pointer', opacity: hoverNodeId !== null && !connected ? 0.28 : 1 }}
                        onPointerEnter={() => setHoverNodeId(node.id)}
                        onPointerLeave={() => setHoverNodeId(null)}
                        onClick={() => { if (!movedRef.current) openEntityPage(node.name) }}
                        onKeyDown={event => { if (event.key === 'Enter') openEntityPage(node.name) }}
                      >
                        <title>{`${node.name} · ${label(node.kind)} · 重要度 ${node.importance}（点击打开资料页）`}</title>
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={radius}
                          fill={colorOf(node.kind)}
                          fillOpacity={0.22}
                          stroke={hovered ? '#ffffff' : colorOf(node.kind)}
                          strokeWidth={hovered ? 2.4 : 1.6}
                        />
                        <circle cx={node.x} cy={node.y} r={radius * 0.42} fill={colorOf(node.kind)} fillOpacity={0.85} />
                        <text
                          x={node.x}
                          y={node.y + radius + 14}
                          textAnchor="middle"
                          fontSize={11.5}
                          fill={NODE_TEXT}
                          stroke="#0f1218"
                          strokeWidth={3}
                          paintOrder="stroke"
                          strokeLinejoin="round"
                          style={{ fontFamily: 'var(--sans)', pointerEvents: 'none' }}
                        >
                          {truncate(node.name, 10)}
                        </text>
                      </g>
                    )
                  })}
                </g>
              </svg>
            </div>
            <div className="tiny muted" style={{ marginTop: 8 }}>
              点击节点跳转到资料页（图谱只读；关系的新增 / 删除在人物与世界观页完成）。拖拽可平移画布。
            </div>
          </Card>

          <div className="stack">
            <Card title="图例" subtitle="颜色 = 实体类型 · 大小 = 重要度">
              <div className="stack-sm">
                {KIND_ORDER.filter(kind => (kindCounts.get(kind) ?? 0) > 0).map(kind => (
                  <div key={kind} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                    <span className="row-wrap" style={{ gap: 8 }}>
                      <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: colorOf(kind) }} />
                      <span className="small dim">{label(kind)}</span>
                    </span>
                    <span className="tiny muted">{kindCounts.get(kind) ?? 0}</span>
                  </div>
                ))}
                {kindCounts.size === 0 && <span className="tiny muted">还没有实体。</span>}
                <div className="divider" style={{ margin: '4px 0' }} />
                <div className="row-wrap" style={{ gap: 10 }}>
                  <span className="row-wrap" style={{ gap: 5 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', border: '1px solid #8e95a5' }} />
                    <span className="tiny muted">重要度 1</span>
                  </span>
                  <span className="row-wrap" style={{ gap: 5 }}>
                    <span style={{ display: 'inline-block', width: 17, height: 17, borderRadius: '50%', border: '1px solid #8e95a5' }} />
                    <span className="tiny muted">重要度 5</span>
                  </span>
                </div>
              </div>
            </Card>

            <Card
              title="关系列表"
              subtitle={`${layout.edges.length} 条${mode === 'people' ? '（只看人物）' : ''}`}
            >
              {layout.edges.length === 0 ? (
                <Empty
                  title="没有可显示的关系"
                  hint={mode === 'people' ? '人物之间还没有关系，或关系两端有非人物实体。切到「全部实体」看看。' : '资料库里还没有人物关系。'}
                  action={<button type="button" className="btn btn-sm" onClick={openEntities}>去添加关系</button>}
                />
              ) : (
                <div className="list scroll-y">
                  {layout.edges.map(edge => (
                    <div
                      key={`list-${edge.id}`}
                      className={`list-item${hoverEdgeId === edge.id ? ' selected' : ''}`}
                      style={{ cursor: 'default' }}
                      onPointerEnter={() => setHoverEdgeId(edge.id)}
                      onPointerLeave={() => setHoverEdgeId(null)}
                    >
                      <div className="list-item-main">
                        <div className="list-item-title">
                          <span>{relationLabel(edge)}</span>
                          <Badge tone="info">{edge.kind || '关系'}</Badge>
                        </div>
                        <div className="list-item-meta">
                          {edge.tension.trim() ? `张力：${truncate(edge.tension, 60)}` : '（没写张力，补一句「谁欠谁 / 谁恨谁」会让对白更准）'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}
