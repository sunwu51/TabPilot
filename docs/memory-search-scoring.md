# 内置记忆搜索评分

TabManager 的长期记忆保存在浏览器 VFS 的 `/memory/index.json`。`memory_search` 不调用额外的大模型，也不维护倒排索引；首版直接遍历轻量记忆索引，对 `subject`、`entities`、`keywords` 和 `summary` 进行加权词项及中文二元组匹配。

## 返回阈值

默认且最低返回阈值为 **6 分**。得分小于 6 的候选不会返回给大模型。调用方可以通过 `minScore` 提高阈值，但不能把它降到 6 以下。

选择 6 分的目的：

- 单纯的中文二元组重叠、时效或 importance 不足以召回记忆。
- 一个明确 entity 命中通常可以越过阈值。
- 一个 keyword 命中还需要 query coverage、importance 或其他信号支持。
- 两个及以上 entity/keyword 命中会获得组合奖励，突出具有区分度的共同信号。

这个阈值是保守的首版默认值，应根据真实查询中的误召回率和漏召回率继续校准。

## 文本标准化

搜索前会执行以下处理：

1. 使用 Unicode NFKC 标准化。
2. 转为小写。
3. 将字母和数字以外的字符替换为空格。
4. 查询按空格形成去重后的词项集合。
5. 从连续中文文本中生成去重后的 2-gram 集合。

例如：

```text
OpenCode 免费模型 429 最终处理决定
```

查询词项为：

```json
["opencode", "免费模型", "429", "最终处理决定"]
```

中文 2-gram 为：

```json
["免费", "费模", "模型", "最终", "终处", "处理", "理决", "决定"]
```

## 评分公式

候选记忆的基础分数为：

```text
baseScore =
    exactSubjectPhrase × 12
  + matchedEntityCount × 8
  + matchedKeywordCount × 5
  + queryCoverage × 4
  + bigramDice × 2
  + importance
```

其中：

- `exactSubjectPhrase`：query 包含完整 subject，或 subject 包含完整 query 时为 1，否则为 0。
- `matchedEntityCount`：query 中完整出现的 entity 数量。
- `matchedKeywordCount`：query 中完整出现的 keyword 数量；与 entity 相同的词不会重复计分。
- `queryCoverage`：出现在候选检索文本中的查询词项数量，除以查询词项总数。检索文本由 subject、summary、keywords、entities 连接而成。
- `bigramDice`：query 与 `subject + summary` 的中文 2-gram Dice coefficient。
- `importance`：保存记忆时提供的 0 到 1 重要性。

Dice coefficient：

```text
bigramDice = 2 × |queryBigrams ∩ memoryBigrams|
             -----------------------------------
             |queryBigrams| + |memoryBigrams|
```

基础分算完后应用两条规则：

```text
如果 matchedEntityCount = 0 且 matchedKeywordCount = 0：
    score = baseScore × 0.35

如果去重后的 entity/keyword 命中数量 >= 2：
    score = score + 5
```

最终按 score 降序排列；同分时，最近更新的记忆排在前面。

## 示例一：OpenCode 记忆

查询：

```text
OpenCode 免费模型 429 最终处理决定
```

候选记忆：

```json
{
  "subject": "TabManager 免费模型提供商",
  "summary": "移除不稳定的 OpenCode 免费入口，关键词总结改用当前聊天模型",
  "keywords": ["OpenCode", "免费模型", "429", "Big Pickle", "关键词总结"],
  "entities": ["TabManager", "OpenCode"],
  "importance": 0.9
}
```

匹配信号：

```text
exactSubjectPhrase = 0
matchedEntities = ["OpenCode"]                      -> 1 × 8
matchedKeywords = ["免费模型", "429"]              -> 2 × 5
queryCoverage = 3 / 4 = 0.75                       -> 0.75 × 4
bigramDice = 2 × 3 / (8 + 24) = 0.1875            -> 0.1875 × 2
importance = 0.9
distinctive matches = 3                            -> +5
weak-match penalty = 不应用
```

最终分数：

```text
score = 0 + 8 + 10 + 3 + 0.375 + 0.9 + 5
      = 27.275
```

`27.275 >= 6`，因此返回给大模型。

## 示例二：Chrome 内置模型记忆

使用同一个查询，候选记忆为：

```json
{
  "subject": "Chrome 内置免费模型",
  "summary": "Chrome Built-in AI 需要在本地下载 Gemini Nano 模型",
  "keywords": ["Chrome", "内置模型", "Gemini Nano", "LanguageModel"],
  "entities": ["Chrome", "Gemini Nano"],
  "importance": 0.6
}
```

匹配信号：

```text
exactSubjectPhrase = 0
matchedEntities = []                               -> 0
matchedKeywords = []                               -> 0
queryCoverage = 1 / 4 = 0.25                      -> 0.25 × 4
bigramDice = 2 × 3 / (8 + 11) ≈ 0.315789         -> 0.315789 × 2
importance = 0.6
distinctive matches = 0                            -> 不奖励
weak-match penalty = 0.35
```

最终分数：

```text
baseScore = 0 + 0 + 0 + 1 + 0.631578 + 0.6
          = 2.231578

score = 2.231578 × 0.35
      ≈ 0.781052
```

`0.781052 < 6`，因此不会返回给大模型。虽然两条记忆都包含“免费模型”，但候选二没有命中更有区分度的 `OpenCode` 和 `429`。

## 调试返回值

返回的每条记忆都包含 `score` 和 `matchedBy`。`matchedBy` 暴露上述各项信号，用于检查记忆为何被召回：

```json
{
  "score": 27.275,
  "matchedBy": {
    "exactSubjectPhrase": false,
    "matchedEntities": ["OpenCode"],
    "matchedKeywords": ["免费模型", "429"],
    "queryCoverage": 0.75,
    "bigramDice": 0.1875,
    "importance": 0.9,
    "distinctiveBonus": 5,
    "weakMatchPenalty": 1
  }
}
```

如果后续加入倒排索引或 embedding，只应改变候选生成和重排方式；`memory_search` 的工具接口、6 分阈值语义和可调试的评分结果应保持兼容，或者通过新的索引版本明确迁移。
