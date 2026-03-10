---
name: paper-digest
description: "从 arXiv、顶会、顶刊抓取论文，AI评分筛选生成精选摘要。支持11个领域，根据选择数量自动切换单/多领域模式。顶会论文优先使用 Semantic Scholar API，失败自动回退到爬虫。⚠️ 首次运行必须完成初始化配置。触发命令: /paper-digest"
---

# Paper Digest

智能论文精选工具，从 arXiv、顶会官网、顶刊 RSS 抓取论文，通过 AI 评分筛选生成每日精选摘要。根据选择的领域数量自动选择模式。

## 运行

### 初次运行（重要！）

**首次使用必须完成初始化配置**，否则技能无法正常工作：

1. **运行技能**触发首次配置向导：
   ```bash
   bun scripts/paper-digest.ts
   ```

2. **按提示完成配置**：
   - 配置大模型 API（Key/地址/模型名）
   - 配置 Semantic Scholar API（可选，用于顶会论文）
   - 设置默认精选论文数量
   - 设置默认时间范围

3. **配置自动保存**，下次运行无需重复设置

### 正常运行

```bash
# 配置 API Key（可选，如已在向导中配置则无需设置）
export OPENAI_API_KEY="your-api-key"

# 交互式模式（推荐）
bun scripts/paper-digest.ts

# 命令行模式
bun scripts/paper-digest.ts --domain ai --hours 72
```

## 核心特性

### 智能模式切换

| 模式 | 触发条件 | 说明 |
|------|---------|------|
| **单领域模式** | 选择 1 个领域 | 为该领域配置数据源、时间/年份、推荐数量 |
| **多领域模式** | 选择多个领域 | 每个领域独立配置数据源、年份、推荐数量 |

### 支持的领域

| 领域 | 顶会 | 顶刊 |
|------|------|------|
| AI/ML/LLM | ✅ 13个 (NeurIPS, ICML, ICLR, ACL, CVPR, etc.) | ✅ 4个 (Nature MI, JMLR, TPAMI, AIJ) |
| 计算机系统 | ✅ 8个 (SOSP, OSDI, EuroSys, etc.) | ✅ 2个 (CACM, IEEE Computer) |
| 理论/算法 | ✅ 4个 (STOC, FOCS, SODA, ICALP) | ✅ 4个 (JACM, SIAM JC, etc.) |
| 数据库/IR | ✅ 5个 (SIGMOD, VLDB, ICDE, etc.) | ✅ 4个 (VLDBJ, TODS, TKDE, IS) |
| 人机交互 | ✅ 3个 (CHI, UIST, CSCW) | ✅ 3个 (TOCHI, IJHCS, HCIJ) |
| 网络安全 | ✅ 4个 (IEEE S&P, CCS, USENIX Security, NDSS) | ❌ |
| 编程语言 | ✅ 4个 (PLDI, POPL, OOPSLA, ICFP) | ❌ |
| 物理学 | ❌ | ✅ 5个 (PRL, PRX, Nature Physics, etc.) |
| 材料科学 | ❌ | ✅ 5个 (Nature Materials, Adv. Materials, etc.) |
| 生物/医学 | ❌ | ✅ 8个 (Nature, Science, Cell, etc.) |
| 数学 | ❌ | ✅ 3个 (Annals, Inventiones, JAMS) |

**总计**: 32个顶会 + 37个顶刊

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--domain` | `ai` | 领域预设 |
| `--hours` | 72 | 抓取时间(小时) |
| `--top-n` | 20 | 总榜精选数 |
| `--category-top-n` | 10 | 分类精选数 |
| `--categories` | - | 自定义分类 |
| `--output` | ./output/paper-digest.md | 输出路径 |

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | ✅ | AI API Key |
| `OPENAI_API_BASE` | ❌ | 默认: https://api.deepseek.com/v1 |
| `OPENAI_MODEL` | ❌ | 默认: deepseek-chat |
| `S2_API_KEY` | ❌ | Semantic Scholar API Key（可选）|

## 交互式流程

```
/paper-digest
  ↓
[1] 选择领域（可多选）
    ☐ AI/ML/LLM
    ☐ 计算机系统/网络
    ...
  ↓
[2] 自动选择模式
    选 1 个 → 单领域模式
    选多个 → 多领域独立配置模式
    ☐ AI/ML/LLM
    ☐ 计算机系统/网络
    ☐ 理论/算法
    ☐ 信息检索/数据库
    ☐ 人机交互
    ☐ 网络安全
    ☐ 编程语言
    ☐ 物理学
    ☐ 材料科学
    ☐ 生物/医学
    ☐ 数学
  ↓
[3] 逐个领域配置
    AI/ML/LLM:
      - 数据源: [x] arXiv [x] 顶会 [ ] 顶刊
      - 顶会年份: 2024
      - 时间范围: 72小时
      - 推荐数量: 5篇

    物理学 (多领域模式才显示):
      - 数据源: [x] arXiv [ ] 顶会 [x] 顶刊
      - 时间范围: 168小时
      - 推荐数量: 3篇
  ↓
[4] 确认并开始 → 分别抓取 → AI评分 → 分别排名 → 生成报告
```

## 工作流程

1. **分别抓取** - 每个领域独立抓取配置的源
2. **AI 批量评分** - 创新性、实验规模、实用性三维评分
3. **分别排名** - 每个领域独立排序，取 Top N
4. **双语翻译** - 标题和摘要译为中文，保留英文原文
5. **生成报告** - 多领域综合报告，各领域独立章节

## 报告输出

### 多领域报告结构
```markdown
# 📚 Paper Digest - 多领域精选论文

## 📚 AI/ML/LLM 精选 Top 5
### 1. [中文标题]
**原文标题**: ...
**评分**: ⭐ 85/100
**推荐理由**: ...
**中文摘要**: ...
**英文摘要**: ...

## 📚 物理学 精选 Top 3
...

## 📈 各领域对比
| 领域 | 论文数 | 平均分 | 最高分 |
|------|--------|--------|--------|
| AI/ML/LLM | 5 | 82 | 90 |
| 物理学 | 3 | 78 | 85 |
```

## 评分维度

AI 从三个维度评分（1-100分）：

| 维度 | 权重 | 说明 |
|------|------|------|
| 创新性 | 40% | 核心创新点和突破程度 |
| 实验规模 | 30% | 数据集、消融实验、baseline对比 |
| 实用性 | 30% | 工程价值、代码开源、应用场景 |

## 建议

- **领域选择**: 每次选择 1-3 个领域为宜，避免 API 限流
- **模式选择**:
  - 只关注一个领域 → 单领域模式（简单直接）
  - 对比多个领域 → 多领域模式（各自独立配置）
- **时间范围**: 顶会按年份选择，arXiv/顶刊按小时选择（支持自定义）
- **推荐数量**: 每个领域 3-10 篇为宜，可自定义数量

## 触发命令

输入 `/paper-digest` 启动交互式引导。
