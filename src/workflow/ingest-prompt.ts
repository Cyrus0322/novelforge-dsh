import type { ChatMessage } from '../llm/client.js'

/**
 * 素材导入的提示词。核心是**防瞎编**：只抽素材里写明的信息，
 * 每条必须给出可在原文中逐字匹配的 evidence；没写就留空，不要推断。
 */
const RULES = [
  '只能抽取素材中明确写到的信息，禁止推断、补全、合并或改写设定。',
  '每个条目必须给出 evidence：从素材中原样复制的短句（8–120 字），必须能在素材中逐字找到。',
  '素材没有写的内容一律省略字段，不要填「未知」「待定」之类的占位词。',
  '数字、等级、时间、金额必须与素材完全一致，不做换算或四舍五入。',
  '区分事实与传闻：素材里如果是角色说的话，仍按素材陈述记录，不要升级为确定事实。',
  'relationship 只能建立在素材中同时出现过的两个人物/势力之间。',
  'knowledge 用来记录「谁知道什么」：凡是素材里出现『秘密、隐瞒、误会、只有某人知道』这类信息，就要抽一条；knowers 里的人物名必须也在素材里出现过。',
  'knowledge.state 取值：knows=知道、suspects=怀疑、misbelieves=误信、unaware=不知道；truth 表示这条信息本身是否属实（true/partial/false），不要和公开度混淆。',
  '同一实体不要重复列出；人物写 kind=character，地点 location，势力 faction，物品 item，规则 world_rule，其它 other。',
  '最多输出 40 个实体、20 条关系、20 个事件、10 条伏笔、8 条剧情线；信息量超载时优先保留主角、核心冲突与关键道具。',
  '只输出一个合法 JSON 对象，不要 Markdown 代码围栏，不要任何解释。',
].join('\n')

export interface IngestPromptContext {
  projectTitle: string
  genre: string
  premise: string
  existingEntities: string
  existingThreads: string
  existingForeshadowing: string
  focus: string
  material: string
}

export function ingestMessages(context: IngestPromptContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是长篇小说的资料库整理员。你把作者给的零散素材（设定笔记、人物小传、剧情梗概、正文片段）抽取成结构化资料，供写作时检索。\n${RULES}`,
    },
    {
      role: 'user',
      content: [
        `## 项目`,
        `《${context.projectTitle}》 · ${context.genre}`,
        `前提：${context.premise || '（未填写）'}`,
        context.focus ? `本次整理重点：${context.focus}` : '',
        '',
        '## 资料库中已有（不要重复创建；如需修改已有条目，name 必须与之一致）',
        `人物/设定：${context.existingEntities || '（空）'}`,
        `剧情线：${context.existingThreads || '（空）'}`,
        `伏笔：${context.existingForeshadowing || '（空）'}`,
        '',
        '## 素材原文',
        context.material,
        '',
        '## 输出 JSON 结构',
        `{
  "project": {"premise": "...", "styleGuide": "...", "pov": "...", "tense": "...", "themes": ["..."]},
  "entities": [{"kind":"character|world_rule|location|faction|item|ability|other","name":"...","summary":"...","role":"主角|反派|配角…","goal":"...","motivation":"...","flaw":"...","secret":"...","voice":"...","arc":"...","aliases":["..."],"importance":1-5,"evidence":"原文短句"}],
  "relations": [{"source":"人物/势力名","target":"人物/势力名","relationType":"师徒/搭档/敌对/父子…","tension":"...","evidence":"原文短句"}],
  "events": [{"summary":"发生了什么","eventTime":"故事内时间，没有就省略","participants":["..."],"importance":1-5,"evidence":"原文短句"}],
  "foreshadowing": [{"name":"...","description":"...","category":"道具|对话|场景|预言","importance":1-5,"evidence":"原文短句"}],
  "threads": [{"name":"...","threadKind":"main|sub|romance|mystery|revenge|growth","goal":"...","summary":"...","evidence":"原文短句"}],
  "knowledge": [{"proposition":"谁知道什么的那个事实","truth":"true|partial|false","publicLevel":"secret|circle|organization|public","knowers":[{"name":"人物或势力名","state":"knows|suspects|misbelieves|unaware"}],"evidence":"原文短句"}],
  "conflicts": [{"type":"setting|character|timeline|naming","description":"素材内部或与已有资料矛盾之处","evidence":"..."}]
}`,
      ].filter(Boolean).join('\n'),
    },
  ]
}
