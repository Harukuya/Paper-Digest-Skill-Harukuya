# Paper Digest - 智能论文精选

从 arXiv、顶会官网、顶刊 RSS 抓取论文，通过 AI 评分筛选生成每日精选摘要。

支持 **11 个学术领域**：AI/ML/LLM、计算机系统/网络、理论/算法、信息检索/数据库、人机交互、网络安全、编程语言、物理学、材料科学、生物/医学、数学。

---

## 项目信息

- **名称**: Paper Digest
- **作者**: Harukuya
- **主页**: https://github.com/Harukuya
- **项目地址**: https://github.com/Harukuya/Paper-Digest-Skill-Harukuya
- **欢迎**: ⭐ Star / 📝 Issue / 🔄 定期 Update

---

## 更新日志

- P.S.已经比较完善，不会额外配置release，可以想起来查看一下仓库的README来check有没有更新

- 当前skill版本：v1.1.0
- 更新：
- v1.1.0：顶会论文优先使用 Semantic Scholar API，失败自动回退到爬虫方案
- v1.0.0：完善了所有功能

---

## 快速开始

### 环境需求

- **Bun or Node.js** - 用于执行 TypeScript 脚本
- **AI API Key** - DeepSeek、OpenAI 或其他兼容 API（必需）
- **Semantic Scholar API Key** - 用于顶会论文获取（可选，无 Key 时限制 100 请求/5分钟）[申请地址](https://www.semanticscholar.org/product/api)

### 安装

将该项目放入你的 skills 文件夹：

```bash
# 方式1：Clone
git clone https://github.com/Harukuya/Paper-Digest-Skill-Harukuya.git ~/.claude/skills/paper-digest

# 方式2：下载压缩包并解压
# 下载 ZIP → 解压 → 放入 ~/.claude/skills/ 文件夹
```

### 运行

输入 `/paper-digest` 或让大模型读取并运行该 skill：

```
用户：搜索本周 AI 领域的最新论文
大模型：我来为你抓取并筛选本周 AI/ML 领域的论文...
（自动触发 /paper-digest）
```

首次运行会进入配置向导，按提示设置 API 和默认参数即可。

---

## 技能特点

| 特点 | 说明 |
|------|------|
| **多源聚合** | 同时抓取 arXiv、32 个顶会（NeurIPS/ICML/ACL 等）、37 个顶刊 RSS |
| **智能顶会获取** | 优先使用 Semantic Scholar API，失败自动回退到爬虫方案，降低维护成本 |
| **智能评分** | AI 从创新性(40%)、实验规模(30%)、实用性(30%)三维评分 |
| **论文报告** | 生成报告，若选择多领域论文则分开排序 |
| **双语输出** | 中文标题/摘要 + 英文原文对照 |
| **灵活配置** | 时间范围、推荐数量、数据源均可自定义 |
| **首次向导** | 自动检测首次运行，引导完成 API 配置 |

---

## 使用示例

### 示例 1：单领域深度追踪

```
用户：帮我看看这周机器学习有什么值得读的论文

大模型：好的，我将为你抓取本周机器学习领域的论文并进行 AI 评分筛选。
（触发 /paper-digest → 选择 AI/ML/LLM → 配置数据源和时间 → 生成报告）

📄 已生成报告，为你精选了 10 篇论文：
1. 联邦学习新框架 ⭐ 92 分 - 创新性地解决了...
2. ...
```

### 示例 2：多领域对比

```
用户：我想同时看看 AI 和物理学的最新进展，各领域给我推荐 5 篇

大模型：明白，我将分别为 AI 和物理学抓取论文并独立筛选。
（触发 /paper-digest → 选择 AI/ML/LLM + 物理学 → 分别配置 → 生成综合报告）

📄 多领域精选报告：

📚 AI/ML/LLM 精选 Top 5
1. ...

📚 物理学 精选 Top 5
1. ...
```

### 示例 3：指定顶会年份

```
用户：帮我找一下 NeurIPS 2024 的论文，推荐 8 篇

大模型：好的，抓取 NeurIPS 2024 的论文并进行评分...
（触发 /paper-digest → 选择 AI 领域 → 选择顶会 → 年份选 2024 → 推荐数量 8）
```

---

## 交互式流程

```
用户输入 /paper-digest
    ↓
选择领域（可多选）
    - AI/ML/LLM
    - 计算机系统/网络
    - 理论/算法
    - 信息检索/数据库
    - 人机交互
    - 网络安全
    - 编程语言
    - 物理学
    - 材料科学
    - 生物/医学
    - 数学
    ↓
自动选择模式
    - 选 1 个 → 单领域模式
    - 选多个 → 多领域模式（每个独立配置）
    ↓
逐个配置
    - 数据源：arXiv / 顶会 / 顶刊
    - 顶会年份（如选顶会）：2025/2024/2023/...
    - 时间范围（如选 arXiv/顶刊）：24h/72h/7天/30天/自定义
    - 推荐数量：5/10/15/20/自定义
    ↓
确认 → 抓取 → AI 评分 → 翻译 → 生成报告
```

---

## 数据源详情

| 领域 | arXiv 分类 | 顶会 | 顶刊 |
|------|------------|------|------|
| **AI/ML/LLM** | cs.LG, cs.CL, cs.CV, cs.AI, stat.ML | NeurIPS, ICML, ICLR, ACL, CVPR, ICCV, ECCV, EMNLP, NAACL, AAAI, IJCAI, KDD, WWW | Nature MI, JMLR, IEEE TPAMI, AI Journal |
| **计算机系统** | cs.OS, cs.DC 等 | SOSP, OSDI, EuroSys, ASPLOS, ATC, FAST, SIGCOMM, NSDI | CACM, IEEE Computer |
| **理论/算法** | cs.GT, cs.LO 等 | STOC, FOCS, SODA, ICALP | JACM, SIAM JC, Algorithmica |
| **数据库/IR** | cs.IR, cs.DB | SIGMOD, VLDB, ICDE, CIDR, WWW | VLDBJ, ACM TODS, IEEE TKDE |
| **人机交互** | cs.HC | CHI, UIST, CSCW | TOCHI, IJHCS |
| **网络安全** | cs.CR | IEEE S&P, ACM CCS, USENIX Security, NDSS | - |
| **编程语言** | cs.PL, cs.SE | PLDI, POPL, OOPSLA, ICFP | - |
| **物理学** | quant-ph, hep-th 等 | - | PRL, PRX, Nature Physics |
| **材料科学** | cond-mat.mtrl-sci 等 | - | Nature Materials, Advanced Materials |
| **生物/医学** | q-bio.* 等 | - | Nature, Science, Cell |
| **数学** | math.ST, math.PR 等 | - | Annals of Math, Inventiones |

### 顶会论文获取策略

顶会论文采用 **Semantic Scholar API 优先 + 爬虫回退** 的策略：

1. **优先使用 [Semantic Scholar API](https://www.semanticscholar.org/product/api)**
   - 覆盖 30+ 个顶会，数据稳定可靠
   - 免费版：100 请求/5分钟（无需 Key）
   - 付费版：更高配额（需 API Key）

2. **API 失败时自动回退到爬虫方案**
   - 直接抓取会议官网论文列表
   - 保证数据获取的可靠性

---

## 报告输出

生成的 Markdown 报告包含：

- **各领域精选 Top N** - 每个领域独立排名
- **论文详情** - 双语标题、评分、推荐理由、作者、PDF 链接、双语摘要
- **评分维度** - 创新性/实验规模/实用性三维度得分

示例：
```markdown
### 1. [中文标题]
**原文标题**: English Title
**评分**: ⭐ 85/100 (创新:8 实验:7 实用:9)
**推荐理由**: 创新性地解决了...
**中文摘要**: 本文提出了一种新方法...
**英文摘要**: This paper proposes a novel approach...
**PDF**: [查看论文](https://arxiv.org/pdf/xxx)
```

---

## 配置说明

首次运行会自动进入配置向导：

1. **AI API 配置** - 支持 DeepSeek、OpenAI 或兼容 API（必需）
2. **Semantic Scholar API** - 用于顶会论文获取（可选，无 Key 时限制 100 请求/5分钟）
3. **默认精选数量** - 默认推荐几篇论文
4. **默认时间范围** - 默认抓取多久内的论文

配置保存在 `~/.claude/skills/paper-digest/.paper-digest-config.json`


