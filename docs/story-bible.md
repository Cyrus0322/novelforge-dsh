# 长篇小说资料库字段清单

> 面向 100 万字级中文网文（起点/番茄）的 story bible 字段模型。核心设计：**双轨存储**——「叙事卡」给人读（字段宽、带例子），「原子事实」给机器查（S-P-O 三元组、可 diff）。所有字段共用元数据：`id / status(canon|proposed|disputed|retired) / source{ch,quote} / confidence / as_of_ch / version`。**没有 `source.quote` 的断言不得进 canon。**

---

## A. 必备核心（30 项）

### A1 作品与文风契约

**A01 `work.profile`｜作品档案** → 防：目标字数与平台节奏错配、写到 60 万字才发现结构撑不住
- 类型：`{title, genre[], platform(起点|番茄|晋江|其他), target_words, chapter_words:[min,max], update_cadence, audience, content_rating}`
- 示例：`{"title":"归墟","genre":["都市异能","悬疑"],"platform":"起点","target_words":1200000,"chapter_words":[2500,3500],"update_cadence":"日更2章"}`

**A02 `work.core_sell`｜核心梗与卖点循环** → 防：中后期偏离核心梗（读者用脚投票）、卖点循环耗尽
- 类型：`{logline, core_hook, loop_steps[], escalation_axes[], drift_redline[]}`
- 示例：`{"logline":"能读取死者最后一秒的外勤，用折寿三日换一条线索","core_hook":"回响","loop_steps":["接案","回响取证","被质疑","结果打脸","更大的案"],"drift_redline":["不能变成无代价升级流"]}`

**A03 `work.style`｜文风契约** → 防：视角漂移、全员一个腔调、AI 味
- 类型：`{pov(第一人称|三人称限知|三人称全知|多视角), tense(过去|现在), person, narrative_distance(贴身|中距|冷叙), chapter_template[], dialogue_ratio, banned_words[], ai_fingerprint[], style_samples[3]}`
- 示例：`{"pov":"三人称限知","tense":"过去","chapter_template":["冷开场≤200字","冲突升级","代价展示","钩子收尾"],"banned_words":["不是…而是…","仿佛","命运的齿轮"],"style_samples":["…","…","…"]}`

### A2 人物档案

**A04 `char.identity`｜身份与基本信息** → 防：称呼前后不一致、年龄辈分穿帮、已死角色被写活
- 类型：`{name, aliases[{text,user,from_ch}], gender, age{value,as_of_ch}, faction, role, rank, first_appearance{ch,scene}, last_seen_ch, status(alive|dead|missing|sealed|unknown)}`
- 示例：`{"name":"林渊","aliases":[{"text":"林队","user":"沈砚","from_ch":12},{"text":"小渊","user":"母亲","from_ch":3}],"age":{"value":24,"as_of_ch":1},"faction":"镇魔司","first_appearance":{"ch":1,"scene":"S001-2"},"status":"alive"}`

**A05 `char.appearance`｜外貌与标志物** → 防：外貌漂移、伤疤时有时无、标志物写丢
- 类型：`{height, build, face[], marks[{desc,from_ch}], props[], default_outfit, change_log[{ch,change}]}`
- 示例：`{"height":178,"marks":[{"desc":"左眉骨旧疤","from_ch":2}],"props":["廉价打火机（不抽烟）"],"default_outfit":"黑色冲锋衣"}`

**A06 `char.drive`｜目标与动机** → 防：人物工具化、动机断裂、主角突然不想干了
- 类型：`{external_goal, internal_need, motivation{source,strength:0-5}, stakes, deadline, opposition[]}`
- 示例：`{"external_goal":"查清母亲失踪","internal_need":"证明自己不是灾星","motivation":{"source":"母亲替他挡下反噬","strength":5},"stakes":"折寿至死","deadline":"30岁前"}`

**A07 `char.flaw`｜缺陷与创伤** → 防：OOC、人格分裂、为推进剧情降智
- 类型：`{flaw, wound, lie_believed, triggers[], bottom_line[], blind_spot, growth_edge}`
- 示例：`{"flaw":"用效率掩盖恐惧，习惯独走","wound":"母亲失踪那晚他被锁在柜子里","lie_believed":"只要够强就不会再失去","triggers":["被叫灾星","同伴替他受伤"],"bottom_line":"不拿活人当诱饵"}`

**A08 `char.secret`｜秘密** → 防：秘密提前泄露、或永远不揭
- 类型：`{secret_id, content, known_by[{char,how,ch}], reveal_plan{ch,method,cost}, reader_knows_ch, leaked}`
- 示例：`{"content":"每次回响折寿三日","known_by":[{"char":"白事铺老板","how":"猜到","ch":44}],"reveal_plan":{"ch":88,"method":"体检报告","cost":"沈砚信任-3"}}`

**A09 `char.voice`｜说话方式** → 防：角色串音、配角都像同一个人、对白无法辨人
- 类型：`{register(文雅|市井|军警|学术|江湖|网络), sentence_len(短|中|长), tics[], address_map{对象:称呼}, profanity:0-3, metaphor_source, banned_phrases[], sample_lines[3]}`
- 示例：`{"register":"军警","sentence_len":"短","tics":["行吧"],"address_map":{"沈砚":"沈队","上级":"组长"},"sample_lines":["行吧。你数三下，我进去。"]}`

**A10 `char.arc`｜人物弧光** → 防：人物从头到尾一个样、成长没有台阶
- 类型：`{arc_type(positive|negative|flat|corruption|redemption), start_state, end_state, milestones[{ch,event,delta}], theme_link}`
- 示例：`{"arc_type":"positive","start_state":"只信自己","end_state":"敢把后背交出去","milestones":[{"ch":30,"event":"第一次求助","delta":"信任+1"},{"ch":95,"event":"为救人放弃复仇","delta":"执念-3"}]}`

**A11 `char.state`｜当前状态快照（按章）** → 防：重伤秒好、冷却被忘、钱和人情凭空出现
- 类型：`{as_of_ch, location, level, injury[{desc,heal_ch}], resources{money,items,favors}, mood, active_goal, cooldowns[], flags[]}`
- 示例：`{"as_of_ch":120,"location":"江城·归墟巷","level":"引气七层","injury":[{"desc":"左臂骨裂","heal_ch":128}],"resources":{"money":3200,"items":["青铜灯（冷却中）"]}}`

**A12 `rel.edge`｜人物关系** → 防：关系跳跃、昨天生死之交今天互不信任、称呼与关系不匹配
- 类型：`{from, to, type(亲属|师徒|同门|上下级|搭档|敌对|恋人|前任|债主|仇人|互不知情), direction, trust:0-10, tension:0-10, public(公开|私下|伪装), changes[{ch,from,to,cause}], secret}`
- 示例：`{"from":"林渊","to":"沈砚","type":"搭档","trust":{"value":4,"as_of_ch":60},"changes":[{"ch":60,"from":7,"to":4,"cause":"沈砚隐瞒上级命令"}]}`

### A3 世界观

**A13 `world.rule`｜规则体系（硬约束/代价/禁忌）** → 防：临时改设定、能力无代价、靠新规则解围
- 类型：`{rule_id, name, hard[], cost[], taboo[], exceptions[], observable[], enforcement(物理|社会|神秘), violation[], reveal_ch}`
- 示例：`{"name":"回响","hard":["只能读取死者死前最后一秒"],"cost":["折寿三日/次"],"taboo":["同一死者不可二次回响"],"exceptions":["至亲可听见遗言"],"violation":"反噬，七窍出血"}`

**A14 `world.ladder`｜等级/修行体系** → 防：战力崩坏、等级通胀、越级挑战无解释
- 类型：`{system, tiers[{name,index,requirements,power_band,lifespan,population}], promotion{cost,ritual,failure}, cross_note}`
- 示例：`{"tiers":[{"name":"引气","index":"1-9层"},{"name":"淬体","index":10},{"name":"开脉","index":11}],"promotion":{"ritual":"引气入骨","failure":"废功"},"population":{"化劲":3}}`

**A15 `world.faction`｜势力与组织** → 防：势力行为不合逻辑、需要时出现不需要时消失
- 类型：`{name, type(官方|宗门|家族|公司|帮会|中立|邪教), goal, resources[], leader, territory, allies[], enemies[], internal[], public_face, secret}`
- 示例：`{"name":"镇魔司","type":"官方","goal":"维持夜禁","internal":["主战派","怀柔派"],"public_face":"市政下属'夜间应急办'"}`

**A16 `world.place`｜地理与地点状态** → 防：地图穿帮（瞬移）、地点被毁还在营业、赶路时间不算
- 类型：`{name, type, parent, distance{from,km,travel_min}, access_condition, sensory[3], state_log[{ch,change}], destroyed}`
- 示例：`{"name":"归墟巷","parent":"江城·老城区","distance":{"from":"镇魔司","km":4.2,"travel_min":12},"access_condition":"子时+引气五层","state_log":[{"ch":70,"change":"半毁"}]}`

**A17 `world.history`｜历史年表** → 防：历史打架、不同角色口中的往事对不上
- 类型：`{era, calendar, events[{name, story_year, years_before, actors[], consequence, source(正史|传闻|谎言)}]}`
- 示例：`{"events":[{"name":"第一次夜禁","years_before":30,"actors":["镇魔司","归墟会"],"source":"正史"},{"name":"白事铺旧主之死","years_before":30,"source":"谎言"}]}`

**A18 `world.society`｜社会制度与经济** → 防：经济失真（随手几百万）、信息传播速度不合时代、法律随剧情变
- 类型：`{currency{name,unit,rate}, prices[{item,price}], classes[], laws[], taboos[], tech_level, comms{method,delay}}`
- 示例：`{"currency":{"name":"灵钞","rate":"1灵钞=100元"},"prices":[{"item":"一碗面","price":"12元"}],"comms":{"method":"手机","delay":"夜禁区无信号"}}`

### A4 剧情结构

**A19 `plot.mainline`｜全书主线与升级曲线** → 防：主线跑偏、中段疲软、冲突不升级
- 类型：`{goal, antagonist, stakes, ending{ch,state}, acts[{name,ch_range,milestone,reversal}], escalation[{ch,risk:1-5,scale}], sub_goals[]}`
- 示例：`{"goal":"查清母亲失踪与归墟会'开门'计划","ending":{"ch":380,"state":"归墟关闭，母亲生死揭晓"},"escalation":[{"ch":1,"risk":1},{"ch":120,"risk":3},{"ch":300,"risk":5}]}`

**A20 `plot.thread`｜情节线（主线/支线）** → 防：支线失踪、烂尾、读者忘了这条线
- 类型：`{thread_id, name, kind(main|sub|romance|mystery|revenge|growth), state(open|advancing|paused|resolved|abandoned), chars[], opened_ch, last_advance_ch, planned_resolve_ch, stale_after}`
- 示例：`{"name":"沈砚的卧底身份","kind":"mystery","state":"advancing","opened_ch":40,"last_advance_ch":112,"planned_resolve_ch":200,"stale_after":40}`

**A21 `plot.volume`｜卷纲** → 防：卷与卷断裂、换地图突兀（老角色集体消失＝订阅腰斩）
- 类型：`{index, title, ch_range, word_budget, core_goal, main_conflict, climax, new_map, new_chars[], open_promises[], close_promises[]}`
- 示例：`{"index":2,"title":"夜禁","ch_range":[121,260],"word_budget":420000,"core_goal":"拿到归墟巷通行资格","climax":"与引路人正面冲突","new_map":"老城区地下"}`

**A22 `plot.chapter`｜章纲** → 防：章节功能重复、连续平淡、钩子空转
- 类型：`{no, title, words, function(推进|转折|揭露|爽点|蓄势|过渡), main_advance, sub[], emotion({from,to}∈-5..5), hook{type,strength:1-5}, promises[], scenes[]}`
- 示例：`{"no":120,"title":"体检报告","words":3000,"function":"揭露","emotion":{"from":2,"to":-3},"hook":{"type":"悬念","strength":4}}`

**A23 `plot.scene`｜场景与节拍** → 防：场景无冲突、流水账、POV 乱跳
- 类型：`{scene_id, ch, order, pov, place, story_time, goal, conflict, turn, outcome(yes|yes_but|no|no_and), emotion_delta, beats[]}`
- 示例：`{"scene_id":"S120-2","pov":"林渊","place":"镇魔司档案室","story_time":"第11天03:40","goal":"偷看档案","conflict":"沈砚突然返回","turn":"沈砚把档案递给他","outcome":"yes_but"}`

**A24 `plot.promise`｜伏笔/钩子/承诺账本** → 防：挖坑不填、伏笔遗忘、长线钩子连续重复（读者麻木）
- 类型：`{promise_id, kind(foreshadow|hook|mystery|prophecy|debt|oath), text, planted{ch,quote}, target_truth, reinforce[{ch,how}], planned_payoff_ch, deadline_ch, payoff{ch,how}, state(open|reinforced|paid|abandoned|overdue), strength:1-5}`
- 示例：`{"text":"青铜灯在无人时自己亮了","planted":{"ch":3,"quote":"…"},"planned_payoff_ch":180,"deadline_ch":220,"state":"reinforced"}`

### A5 连续性

**A25 `cont.timeline`｜事件时间线（故事内时间 × 叙述顺序）** → 防：同一晚跑三个城市、故事时间与章节顺序混淆
- 类型：`{event_id, story_time{day_offset,clock}, duration, chapter_order, place, actors[], causes[], effects[], visibility[pov]}`
- 示例：`{"event_id":"E041","story_time":{"day_offset":11,"clock":"03:40"},"duration":"20min","chapter_order":120,"causes":["E039"],"effects":["E042"]}`

**A26 `cont.knowledge`｜知情矩阵（谁知道什么）** → 防：角色开天眼、该知道的不知道、误会无法成立
- 类型：`{fact_id, proposition, truth(true|false|partial), knowers[{char,state(knows|suspects|misbelieves|unaware),how,ch}], public_level(秘密|小圈|组织|公开), reader_knows_ch}`
- 示例：`{"proposition":"林渊每次回响折寿","truth":true,"knowers":[{"char":"林渊","state":"knows"},{"char":"白事铺老板","state":"suspects","ch":44},{"char":"沈砚","state":"unaware","ch":87}],"public_level":"秘密"}`

**A27 `cont.item`｜物品道具流转** → 防：道具凭空出现/消失、能力被遗忘、谁拿着说不清
- 类型：`{item_id, name, type(法器|信物|武器|钱|钥匙|证据), abilities[], limits[], owner, location, state(intact|damaged|sealed|lost|destroyed), custody[{ch,from,to,how}]}`
- 示例：`{"name":"青铜灯","type":"法器","abilities":["封存一次回响"],"limits":["每月一次"],"owner":"林渊","state":"冷却中"}`

**A28 `cont.irreversible`｜不可逆事件与伤亡** → 防：死了又活、断手复原、世界大事下一章没人提
- 类型：`{event_id, ch, type(death|maim|exposure|betrayal|map_change|rule_change), who[], loss[], world_delta, reversible:false, retcon_note}`
- 示例：`{"ch":150,"type":"death","who":["老周"],"loss":["唯一会听骨的人"],"world_delta":"镇魔司收紧夜禁"}`

### A6 审查

**A29 `review.flag`｜一致性问题单** → 防：吃书无人发现、同类错误反复出现
- 类型：`{flag_id, type(setting|character|timeline|promise|power|geo|naming|knowledge|style), severity(blocker|major|minor), a{ch,quote}, b{ch,quote}, detector(rule|llm|human), status(open|resolved|waived|retcon), resolution}`
- 示例：`{"type":"power","a":{"ch":12,"quote":"引气五层才进得去"},"b":{"ch":98,"quote":"他引气三层，抬脚就进了"},"severity":"blocker"}`

**A30 `cont.fact`｜原子事实（S-P-O）** → 防：卡片与正文脱节；这是所有冲突检测的底座
- 类型：`{subject, predicate, object, polarity(+|-), chapter, quote, status(canon|proposed|disputed), valid_from_ch, valid_to_ch}`
- 示例：`{"subject":"林渊","predicate":"境界","object":"引气三层","chapter":12,"quote":"…","valid_from_ch":12,"valid_to_ch":97}`

---

## B. 进阶可选

**人物**
- 创作辅助（不入 canon，标 `author_only:true`）：MBTI/九型、星座、角色原型（archetype）、参考演员、声线参考、角色海报 prompt
- 深度档案：童年大事记、恐惧清单、性取向/婚恋史、消费观、日常作息、宠物、名字词源、方言/口音、习惯性小动作、写作/字迹
- 运营向：角色人气/CP 组合、退场（便当）预案、番外素材池

**世界观**
- 空间：坐标/距离矩阵、地图图层、气候与季节历法、月相、潮汐
- 社会：宗教/丧葬/节庆、饮食、服饰史、建筑、交通、教育/科举、税收、军事编制、法律条文、医疗水平、成瘾物、性别与阶层制度、民族/种族
- 体系：功法/科技树、神话体系、怪物图鉴、资源分布、贸易路线、语言/黑话/禁忌语
- 图谱：势力关系图（有向图 + 权重）、人物-势力隶属时间线

**剧情**
- 结构：Save the Cat 15 拍映射（Opening Image→Final Image）、三幕/七点、卷级 beat sheet
- 节奏：爽点/情绪折线图（章节 × 情绪值）、每 4 章冲突/每 10 章大事件校验、弃书点分析
- 信息：信息差表、红鲱鱼（误导）表、多线交汇矩阵、读者已知/未知对照表
- 管理：出场节奏表、结局备选方案、if 分支沙盘、竞品对标拆解、读者评论归档

**连续性**
- 生理：伤病恢复周期表、年龄增长/生日、疲劳与睡眠
- 后勤：出行时间矩阵、物价与收入表、通讯延迟、装备损耗、契约与债务、法律后果
- 风险：超自然暴露风险值、人口统计、势力资源消耗

**文风**
- 量化：对话/描写比例、句长分布、比喻密度、标点偏好（破折号/省略号）
- 资产：比喻库、感官词库、章节标题命名规则、序章/间章模板、视角轮换表
- 合规：平台敏感词替换表、审核红线、AI 指纹黑名单（扩展版：`不是X而是Y`、三段式排比、万能转折词）

**审查**
- 自动化规则库（regex/数值/图校验）、人工审稿 checklist、读者模拟评审、版本 diff 审查、retcon 影响面分析、平台合规审查

---

## C. 六个维度的最小可用结构

**人物（MVP：8 块）**
```yaml
character:
  id: C001
  name: 林渊
  aliases: [{text: 林队, user: 沈砚, from_ch: 12}]
  identity: {age: 24, faction: 镇魔司, role: 外勤, first_ch: 1, status: alive}
  drive: {goal: 查清母亲失踪, need: 证明自己, stake: 折寿至死}
  flaw: {flaw: 独走, wound: 被锁柜中, trigger: [灾星]}
  voice: {register: 军警, tics: [行吧], sample: "行吧。你数三下，我进去。"}
  arc: {type: positive, start: 只信自己, end: 敢交后背}
  state: {as_of_ch: 120, level: 引气七层, injury: [左臂骨裂], location: 归墟巷}
  relations: [{to: C002, type: 搭档, trust: 4, tension: 8}]
```

**世界观（MVP：6 块）**
```yaml
world:
  rules: [{id: R01, name: 回响, hard: [只读死前最后一秒], cost: [折寿三日], taboo: [不可二次], violation: 反噬}]
  ladder: {system: 修行, tiers: [引气, 淬体, 开脉], promotion: {ritual: 引气入骨, failure: 废功}}
  factions: [{id: F01, name: 镇魔司, type: 官方, goal: 维持夜禁, enemies: [F02]}]
  places: [{id: P01, name: 归墟巷, parent: 老城区, access: 子时+引气五层, state: 半毁@ch70}]
  history: [{name: 第一次夜禁, years_before: 30, source: 正史}]
  society: {currency: 灵钞, price_ref: {面: 12元}, comms: 夜禁区无信号}
```

**剧情（MVP：6 块）**
```yaml
plot:
  mainline: {goal: 查清母亲失踪, ending_ch: 380, escalation: [{ch: 1, risk: 1}, {ch: 300, risk: 5}]}
  threads: [{id: T01, kind: mystery, state: advancing, opened: 40, last: 112, resolve_plan: 200}]
  volumes: [{no: 2, ch: [121, 260], goal: 拿通行资格, climax: 与引路人冲突}]
  chapters: [{no: 120, function: 揭露, emotion: [2, -3], hook: {type: 悬念, strength: 4}}]
  scenes: [{id: S120-2, pov: 林渊, goal: 偷档案, conflict: 沈砚返回, turn: 递档案, outcome: yes_but}]
  promises: [{id: PR01, kind: foreshadow, planted: 3, payoff_plan: 180, deadline: 220, state: reinforced}]
```

**连续性（MVP：5 表）**
```yaml
continuity:
  events: [{id: E041, story_time: D11-03:40, chapter: 120, place: P01, actors: [C001], causes: [E039]}]
  knowledge: [{fact: 折寿, truth: true, knowers: [{char: C001, state: knows}, {char: C003, state: unaware}]}]
  items: [{id: I01, name: 青铜灯, owner: C001, state: 冷却, custody: [{ch: 77, from: C004, to: C001}]}]
  irreversible: [{id: X01, ch: 150, type: death, who: 老周, loss: [听骨]}]
  facts: [{s: C001, p: 境界, o: 引气七层, from: 98}]
```

**文风（MVP：6 参数）**
```yaml
style:
  pov: 三人称限知
  tense: 过去
  chapter_words: [2500, 3500]
  chapter_template: [冷开场, 冲突升级, 代价展示, 钩子收尾]
  banned: [不是…而是…, 仿佛, 命运的齿轮]
  samples: ["…", "…", "…"]
  platform_rules: {min_words: 2000, sensitive_words: []}
```

**审查（MVP：6 条硬规则 + 1 张问题单）**
```yaml
review:
  checks:
    - {id: K01, type: power, rule: "使用的等级 <= char.state(as_of_ch).level"}
    - {id: K02, type: timeline, rule: "story_time 单调不减；跨地点须满足 travel_min"}
    - {id: K03, type: knowledge, rule: "角色不得引用 state=unaware 的事实"}
    - {id: K04, type: promise, rule: "deadline_ch < 当前章 → overdue 告警"}
    - {id: K05, type: naming, rule: "称呼必须命中 aliases 或 address_map"}
    - {id: K06, type: style, rule: "banned 命中数/千字；连续 3 章 hook.type 重复"}
  flag: {id, type, severity, evidence: [{ch, quote}], status}
```

---

## D. 参考资料

| 来源 | 可借用的部分 | 链接 |
|---|---|---|
| River《Story Bible Template》 | 四段式（Cast/Places/Rules/Open questions）；**每条事实带章节号+原文短引**；矛盾进「Continuity flags」 | [meetriver.com](https://meetriver.com/templates/story-bible-template) |
| River《Character Bible Template》 | 固定事实 vs「什么变了」双栏、voice line、秘密栏、龙套一行表；所有 AI 生成内容标 `(proposed)` 直到作者确认 | [meetriver.com](https://meetriver.com/templates/character-bible) |
| 《网文大纲结构设计指南》（webnovel-writer） | 骨架/分卷/章节三层大纲；章纲含「爽点/伏笔/结尾钩子/字数」；**大纲变更日志**与「不可触碰红线」（人设、力量体系、核心主线） | [GitHub](https://github.com/lingfengqaq/webnovel-writer/blob/b38056ec3ae288af613c0af162d648e4a4e8825c/webnovel-writer/skills/webnovel-plan/references/outlining/outline-structure.md) |
| 《网文写作方法论 novel-writing-framework》 | 可量化文风指标（CJK 字数、AI 句式频次）、三章一轮自检、场景轮换 ≥5、长线钩子不得连续 3 章重复 | [GitHub](https://github.com/LAY-lgtm/novel-writing-framework) |
| 《长篇拆文参考》（oh-story） | 核心梗/卖点循环、情绪折线、20–30 万字一卷、换地图规则、力量体系不崩的前提 | [GitHub](https://github.com/zenstory-ai/oh-story-claudecode/blob/0d555cfa387f7e30ad0c2a0075c212622c230971/skills/story-long-analyze/references/deconstruction-notes.md) |
| 写作营《网文大纲如何规划更合理？》 | 章节「功能」而非「事件」写法；每 4 章冲突/每 10 章大事件；人物小传含心理变化路径与关系阈值 | [xs91.com](https://www.xs91.com/thread/online-fiction-outline-planning) |
| Plottr | 时间线视图 + 故事圣经 + 标签/情节线/系列管理的数据组织方式 | [plottr.com](https://plottr.com/features/) |
| Obsidian World Builder | 开源字段模型：Character(name/role/age/faction/description/personality/goals/secrets)、Location(type/parent/inhabitants/secrets)、Faction(alignment/goals/allies/enemies)、Lore(category)、Timeline(date/era/links) | [GitHub](https://github.com/wesswart77/obsidian-world-builder) |
| Save the Cat 15 拍（Reedsy 指南） | beat 枚举与百分比位置：Opening Image/Catalyst/Break into Two/Midpoint/All Is Lost/Finale… | [reedsy.com](https://reedsy.com/blog/guide/story-structure/save-the-cat-beat-sheet/) |
| Snowflake Method（Ingermanson） | 逐级放大：一句话→一段→人物摘要→人物表→场景清单，适合做「先粗后细」的生成流水线 | [advancedfictionwriting.com](https://www.advancedfictionwriting.com/articles/snowflake-method/) |
| DOC: Detailed Outline Control（ACL 2023） | 实证：**分层详细大纲 + 生成时对齐控制器**显著提升长篇连贯性（情节连贯 +22.5%），支持「大纲即控制信号」的设计 | [arxiv.org](https://arxiv.org/abs/2212.10077) |
| 阅文作家专区 | 平台侧投稿/福利/规则入口（起点、QQ阅读、创世等） | [write.qq.com](https://write.qq.com/portal/community/topic/detail/98494579812125001) |

---

## E. 给「一段素材 → AI 自动抽取并更新资料库」的设计建议

**E1 抽什么：实体、断言、变更，三张表分开**
- 实体：`character / place / faction / item / rule / event / thread / promise / term(专有名词)`。新实体一律先落 `new_entity_candidate`，与现有 `aliases` 做编辑距离+拼音相似度比对，防止「李明/李名」分裂成两个人。
- 断言：S-P-O + `chapter` + `quote` + `modality`，进 `cont.fact`。
- 变更：只抽「相对上一章的变化」（等级、位置、伤势、持有物、关系数值、知情状态），写成 `delta`，不重抄静态档案。
- 明确不抽：作者旁白式总结、章节标题、读者评论。

**E2 防瞎编：8 条硬约束**
1. **quote-or-drop**：`quote` 必须能在本章原文按字符匹配（允许标点/空白差异），否则整条丢弃。
2. **禁止跨章推断合并**：推断写 `op:"infer"`，只进 `proposed`，永不自动升 canon。
3. **modality 标注**：`asserted`（叙述事实）/`claimed`（角色声称）/`rumored`（传闻）/`dream`（梦境）/`hypothetical`（假设）/`ironic`（反讽）。只有 `asserted` 可进 canon。
4. **数值原样**：不换算、不四舍五入、不补单位。
5. **null 优于猜测**：没写就是 `null`，不填「大概」。
6. **差分抽取**：每章输出断言上限（如 40 条），超限即标记「本章信息密度异常」转人工。
7. **双模型**：抽取模型产出，校验模型只做「引用是否支持该断言」的判定（NLI 式），不一致进人工队列。
8. **禁止未来信息**：写第 N 章时只注入 `as_of_ch = N-1` 的快照，杜绝「提前知道结局」的泄漏。

**E3 冲突检测：规则层 + 语义层**
| 类型 | 规则（可自动） | 例 |
|---|---|---|
| 设定/数值 | 同一 S-P 在不同章取不同 O，且未声明变化 | 年龄 24 vs 26；境界回退 |
| 时间线 | `story_time` 非单调；章内跨地点不满足 `travel_min`；同一天事件超 24h | 03:40 在江城，04:10 在省城 |
| 人物状态 | 引用 `injury.heal_ch` 之前章节却行动自如；`cooldowns` 未到期 | 骨裂未愈却徒手掰铁门 |
| 能力 | 使用等级 > `char.state.level`；规则 `hard` 被违反且无 `exceptions` | 引气三层用开脉招式 |
| 知情 | 角色引用自己 `unaware` 的事实；秘密 `leaked=false` 却被公开谈论 | 沈砚说出「折寿」 |
| 伏笔 | `deadline_ch < 当前章` 仍 `open`；`paid` 后又被当未解之谜 | 第 230 章还在猜铜灯 |
| 称呼 | 称呼不在 `aliases` 也不在 `address_map` | 沈砚叫「林渊」而非「林队」 |
| 语义（LLM） | 性格/语气漂移、设定解释前后矛盾、OOC 判定 | 林渊突然长篇大论抒情 |

**E4 冲突裁决：三级闸门 + retcon 记录**
- L0 自动入库：有直接引文的新实体、静态事实（首次登场、新地点）→ 直接 canon。
- L1 批量确认：状态变更（等级/位置/伤势/关系数值）→ 每日一批，带原文 diff。
- L2 单条确认：秘密、知情变化、死亡、规则改动、伏笔回收 → 逐条确认。
- L3 硬阻断：与 canon 直接冲突且无法用「角色说谎/传闻」解释 → 冻结字段写入，生成 `review.flag(blocker)`。
- 裁决三选一：**改新章** / **改旧章（给出影响面：需回改的章号列表）** / **承认 retcon**（写 `retcon_record`：旧值、新值、生效章、受影响的 promise/thread）。
- 存储 append-only：旧值用 `valid_to_ch` 封口，不物理删除，保证任意章可「时间旅行」回看当时的世界状态。

**E5 确认界面：提案制，不是覆盖制**
- 所有 AI 产出默认 `proposed`，UI 上以「建议卡」呈现：`字段 / 旧值 / 新值 / 原文引用 / 置信度`。
- 一次点击 = 接受 / 改写 / 拒绝并加入负样本（用于调抽取 prompt）。
- 支持「按章回滚」：整章抽取结果可一键撤销。
- 每周生成「canon 变更摘要」：新增实体 N、状态变更 M、逾期伏笔 K，给作者 5 分钟扫一遍。

**E6 写章时的上下文装配（注入什么，按需）**
1. 在场人物卡（`identity + voice + state + 与在场者的 rel.edge`）
2. 本章涉及地点的 `place`（含 `state_log`）
3. 本章会用到的 `rule` 与 `ladder` 条目（只取相关，不整本注入）
4. `deadline` 临近或本章要推进的 `promise`（≤5 条）
5. 在场人物的 `knowledge` 切片（他们各自知道/不知道什么）
6. `style` 契约（POV/字数/模板/禁用词/样张 1 段）
- 预算建议：人物卡 ≤40%、规则/地点 ≤20%、promise+knowledge ≤25%、style ≤15%，硬截断按「本章出场权重」排序。

**E7 质量指标（否则无法判断抽取器好坏）**
- 抽准率：每 10 章抽 30 条人工核对，目标 ≥95%。
- 漏抽率：用「下一章回指上一章信息」反推漏抽。
- 冲突误报率：blocker 级人工复核，目标 ≤10%。
- canon 漂移率：每周被 retcon 的字段数 / 总字段数。
- 人工成本：确认耗时/章，目标 ≤3 分钟。
