import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/dsh-plugin/index.js'
import { NovelForgeError } from '../src/shared/errors.js'
import { testConfig } from './helpers.js'

describe('DSH 插件适配层', () => {
  it('按真实 defineTool 契约注册并执行工具，审批服务控制敏感写入', async () => {
    const definitions: ToolDefinition[] = []
    let approvalOutcome = 'allowed-once'
    const fakeContext = {
      tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
      approval: { request: async () => approvalOutcome },
      effect: () => {},
    } as unknown as Context
    const config = testConfig()
    apply(fakeContext, config)
    expect(definitions.map(tool => tool.name)).toContain('novel_search')
    expect(definitions.map(tool => tool.name)).toContain('novel_finalize_chapter')

    const exec = { signal: new AbortController().signal, agent: {}, callId: 'call-1' } as unknown as ToolRunContext
    const create = definitions.find(tool => tool.name === 'novel_create_project')!
    const created = await create.execute({ title: '插件书', genre: '科幻' }, exec) as { id: string }
    const chapterPlan = definitions.find(tool => tool.name === 'novel_plan_outline')!
    expect(chapterPlan.parameters.type).toBe('object')

    const proposal = definitions.find(tool => tool.name === 'novel_propose_change')!
    const proposed = await proposal.execute({
      project_id: created.id, target_type: 'entity', operation: 'create',
      payload: { kind: 'character', name: '顾言', summary: '工程师' },
    }, exec) as { id: string }
    const applyChange = definitions.find(tool => tool.name === 'novel_apply_change')!
    approvalOutcome = 'rejected'
    await expect(applyChange.execute({ proposal_id: proposed.id }, exec)).rejects.toThrow(NovelForgeError)
    approvalOutcome = 'allowed-once'
    const applied = await applyChange.execute({ proposal_id: proposed.id }, exec) as { status: string }
    expect(applied.status).toBe('applied')
  })
})
