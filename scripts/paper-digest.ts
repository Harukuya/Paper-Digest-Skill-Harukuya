/**
 * Paper Digest - 精选论文摘要生成器 (优化版)
 * 
 * 从 arXiv 抓取 AI/ML/LLM/Materials 领域最新论文，
 * 通过 AI 批量评分筛选生成每日精选摘要。
 */

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// 获取当前文件目录（ESM 替代 __dirname）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// 常量配置
// ============================================================================

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';
const SEMANTIC_SCHOLAR_API_BASE = 'https://api.semanticscholar.org/graph/v1';
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE || 'https://api.deepseek.com/v1').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';
const API_KEY = process.env.OPENAI_API_KEY || '';

// Semantic Scholar API 配置（全局变量，由 main 函数设置）
let S2_API_KEY = process.env.S2_API_KEY || ''; // 可选，无key时限制 100 req/5min

// 配置文件路径（始终放在 skill 文件夹下）
const CONFIG_FILE = join(__dirname, '../.paper-digest-config.json');
const OUTPUT_DIR = join(__dirname, '../output');

// 用户配置接口
interface UserConfig {
  apiKey?: string;
  apiBase?: string;
  apiModel?: string;
  s2ApiKey?: string; // Semantic Scholar API Key（可选）
  defaultTopN: number;
  defaultHours: number;
  firstRun: boolean;
}

// 默认用户配置
const DEFAULT_USER_CONFIG: UserConfig = {
  defaultTopN: 10,
  defaultHours: 72,
  firstRun: true,
};

// 批量评分配置 (避免API限流)
const BATCH_SIZE = 10;        // 每批评分论文数
const MAX_CONCURRENT = 2;      // 最大并发批量数
const DELAY_BETWEEN_BATCH = 1000; // 批次间延迟(ms)

// arXiv 分类
const ARXIV_CATEGORIES: Record<string, string> = {
  // AI/ML/LLM
  'cs.LG': 'Machine Learning (机器学习)',
  'cs.CL': 'NLP/LLM (自然语言处理)',
  'cs.CV': 'Computer Vision (计算机视觉)',
  'cs.AI': 'Artificial Intelligence (人工智能)',
  'stat.ML': 'Statistics ML (统计机器学习)',
  
  // 计算机科学
  'cs.CR': 'Cryptography (密码学)',
  'cs.SE': 'Software Engineering (软件工程)',
  'cs.PL': 'Programming Languages (编程语言)',
  'cs.OS': 'Operating Systems (操作系统)',
  'cs.DC': 'Distributed Computing (分布式计算)',
  'cs.NE': 'Neural Evolution (神经演化)',
  
  // 理论/算法
  'cs.GT': 'Computational Complexity (计算复杂性)',
  'cs.LO': 'Logic (逻辑)',
  'math.OC': 'Optimization (优化)',
  
  // 数据库/信息检索
  'cs.IR': 'Information Retrieval (信息检索)',
  'cs.DB': 'Databases (数据库)',
  
  // 人机交互
  'cs.HC': 'Human-Computer Interaction (人机交互)',
  
  // 物理学
  'quant-ph': 'Quantum Physics (量子物理)',
  'hep-th': 'High Energy Physics (高能物理)',
  
  // 材料科学
  'cond-mat.mtrl-sci': 'Materials Science (材料科学)',
  'cond-mat': 'Condensed Matter (凝聚态物理)',
  
  // 生物/医学
  'q-bio.BM': 'Biomolecules (生物分子)',
  'q-bio.QM': 'Quantitative Methods (定量方法)',
  'q-bio.CB': 'Cell Behavior (细胞行为)',
  'physics.bio-ph': 'Biological Physics (生物物理)',
  
  // 数学
  'math.ST': 'Statistics (统计学)',
  'math.PR': 'Probability (概率论)',
};

// 作者信息
const AUTHOR_NAME = 'Harukuya';
const AUTHOR_HOME = 'https://github.com/Harukuya';
const REPO_URL = 'https://github.com/Harukuya/Paper-Digest-Skill-Harukuya';

/**
 * 显示欢迎信息
 */
function showWelcome(): void {
  console.log('\n' + '═'.repeat(70));
  console.log('🎉 欢迎使用 Paper Digest!');
  console.log('   作者: ' + AUTHOR_NAME);
  console.log('   欢迎 Star ⭐ / 提交 Issue 📝 / 定期 Update 🔄');
  console.log('   作者主页: ' + AUTHOR_HOME);
  if (REPO_URL) {
    console.log('   项目地址: ' + REPO_URL);
  }
  console.log('═'.repeat(70) + '\n');
}

// 预定义的领域组合
const DOMAIN_PRESETS: Record<string, string[]> = {
  'ai-ml-llm': ['cs.LG', 'cs.CL', 'cs.CV', 'cs.AI', 'stat.ML'],
  'computer-science': ['cs.CR', 'cs.SE', 'cs.PL', 'cs.OS', 'cs.DC', 'cs.NE'],
  'theory': ['cs.GT', 'cs.LO', 'math.OC'],
  'ir-db': ['cs.IR', 'cs.DB'],
  'hci': ['cs.HC'],
  'security': ['cs.CR'],
  'programming': ['cs.PL', 'cs.SE'],
  'physics': ['quant-ph', 'hep-th', 'cond-mat'],
  'materials': ['cond-mat.mtrl-sci', 'cond-mat'],
  'bio-medicine': ['q-bio.BM', 'q-bio.QM', 'q-bio.CB', 'physics.bio-ph'],
  'math': ['math.ST', 'math.PR', 'math.OC'],
  'all': Object.keys(ARXIV_CATEGORIES),
};

// 顶会配置（AI/ML/LLM领域专用 - 官网爬取）
// 策略：使用网络搜索获取真实会议URL，而非预定义模板
interface ConferenceConfig {
  name: string;
  nameZh: string;
  // 会议通常的举办月份（用于判断当年是否已开）
  typicalMonth: number;
}

const CONFERENCE_CONFIG: Record<string, ConferenceConfig[]> = {
  'ai-ml-llm': [
    { name: 'NeurIPS', nameZh: '神经信息处理系统大会', typicalMonth: 12 },
    { name: 'ICML', nameZh: '国际机器学习会议', typicalMonth: 7 },
    { name: 'ICLR', nameZh: '学习表征国际会议', typicalMonth: 5 },
    { name: 'ACL', nameZh: '计算语言学年会', typicalMonth: 8 },
    { name: 'CVPR', nameZh: '计算机视觉顶会', typicalMonth: 6 },
    { name: 'ICCV', nameZh: '国际计算机视觉会议', typicalMonth: 10 },
    { name: 'ECCV', nameZh: '欧洲计算机视觉会议', typicalMonth: 9 },
    { name: 'EMNLP', nameZh: '自然语言处理实证方法会议', typicalMonth: 11 },
    { name: 'NAACL', nameZh: '北美计算语言学会议', typicalMonth: 6 },
    { name: 'AAAI', nameZh: 'AAAI人工智能会议', typicalMonth: 2 },
    { name: 'IJCAI', nameZh: '国际人工智能联合会议', typicalMonth: 8 },
    { name: 'KDD', nameZh: '知识发现与数据挖掘会议', typicalMonth: 8 },
    { name: 'WWW', nameZh: '国际万维网会议', typicalMonth: 5 },
  ],
  'computer-science': [
    { name: 'SOSP', nameZh: '操作系统原理研讨会', typicalMonth: 10 },
    { name: 'OSDI', nameZh: '操作系统设计与实现', typicalMonth: 7 },
    { name: 'EuroSys', nameZh: '欧洲计算机系统会议', typicalMonth: 4 },
    { name: 'ASPLOS', nameZh: '体系结构/编程语言/操作系统', typicalMonth: 3 },
    { name: 'ATC', nameZh: 'USENIX年度技术会议', typicalMonth: 7 },
    { name: 'FAST', nameZh: '文件与存储技术会议', typicalMonth: 2 },
    { name: 'SIGCOMM', nameZh: '数据通信会议', typicalMonth: 8 },
    { name: 'NSDI', nameZh: '网络系统设计与实现', typicalMonth: 4 },
  ],
  'ir-db': [
    { name: 'SIGMOD', nameZh: '数据管理会议', typicalMonth: 6 },
    { name: 'VLDB', nameZh: '超大型数据库会议', typicalMonth: 8 },
    { name: 'ICDE', nameZh: '数据工程国际会议', typicalMonth: 4 },
    { name: 'CIDR', nameZh: '数据库研究创新会议', typicalMonth: 1 },
    { name: 'WWW', nameZh: '国际万维网会议', typicalMonth: 5 },
  ],
  'hci': [
    { name: 'CHI', nameZh: '人机交互会议', typicalMonth: 5 },
    { name: 'UIST', nameZh: '用户界面软件与技术', typicalMonth: 10 },
    { name: 'CSCW', nameZh: '计算机支持协同工作', typicalMonth: 11 },
  ],
  'security': [
    { name: 'IEEE S&P', nameZh: 'IEEE安全与隐私研讨会', typicalMonth: 5 },
    { name: 'ACM CCS', nameZh: '计算机与通信安全会议', typicalMonth: 11 },
    { name: 'USENIX Security', nameZh: 'USENIX安全研讨会', typicalMonth: 8 },
    { name: 'NDSS', nameZh: '网络与分布式系统安全', typicalMonth: 2 },
  ],
  'programming': [
    { name: 'PLDI', nameZh: '编程语言设计与实现', typicalMonth: 6 },
    { name: 'POPL', nameZh: '编程语言原理', typicalMonth: 1 },
    { name: 'OOPSLA', nameZh: '面向对象编程/系统/语言', typicalMonth: 10 },
    { name: 'ICFP', nameZh: '函数式编程国际会议', typicalMonth: 8 },
  ],
  'theory': [
    { name: 'STOC', nameZh: '计算理论研讨会', typicalMonth: 6 },
    { name: 'FOCS', nameZh: '计算机科学基础研讨会', typicalMonth: 11 },
    { name: 'SODA', nameZh: '离散算法研讨会', typicalMonth: 1 },
    { name: 'ICALP', nameZh: '自动机/语言与编程', typicalMonth: 7 },
  ],
};

// 使用网络搜索获取会议论文页面URL
async function searchConferenceUrl(confName: string, year: number): Promise<string | null> {
  try {
    console.log(`    🔍 搜索 ${confName} ${year} 论文页面...`);

    // 构建搜索查询 - 直接找论文列表子页面
    const queries = [
      // OpenReview 论文子页面
      `${confName} ${year} oral site:openreview.net/group`,
      `${confName} ${year} poster site:openreview.net/group`,
      `${confName} ${year} accepted papers site:openreview.net`,
      // 其他平台
      `${confName} ${year} papers site:proceedings.mlr.press`,
      `${confName} ${year} papers site:papers.nips.cc`,
      `${confName} ${year} openaccess.thecvf.com`,
    ];

    // 尝试不同的搜索词
    for (const query of queries) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

      try {
        const response = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) continue;

        const html = await response.text();

        // 从搜索结果中提取URL
        // Google搜索结果中的链接模式
        const urlPatterns = [
          /href="(https:\/\/openreview\.net\/[^"]*(?:forum|group)[^"]*)"/i,
          /href="(https:\/\/[^"]*neurips\.cc\/virtual[^"]*)"/i,
          /href="(https:\/\/[^"]*icml\.cc\/virtual[^"]*)"/i,
          /href="(https:\/\/[^"]*iclr\.cc\/virtual[^"]*)"/i,
          /href="(https:\/\/[^"]*thecvf\.com\/[^"]*)"/i,
          /href="(https:\/\/aclanthology\.org\/[^"]*)"/i,
        ];

        for (const pattern of urlPatterns) {
          const match = html.match(pattern);
          if (match) {
            let url = match[1];
            // 清理URL
            url = url.replace(/&amp;/g, '&');
            console.log(`    ✅ 找到 ${confName} ${year}: ${url}`);
            return url;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // 回退：尝试常见的URL模式（优先使用已知有效的论文库）
    const fallbackUrls = [
      // NeurIPS 专用
      ...(confName.toLowerCase() === 'neurips' ? [`https://papers.nips.cc/paper/${year}`] : []),
      // ICML/ICLR 专用 (PMLR) - ICML 2024 = v235, 2023 = v202
      ...(confName.toLowerCase() === 'icml' ? [
        `https://proceedings.mlr.press/v${year === 2024 ? '235' : year === 2023 ? '202' : String(year).slice(-2)}/`
      ] : []),
      ...(confName.toLowerCase() === 'iclr' ? [
        `https://openreview.net/group?id=ICLR.cc/${year}/Conference`,
        `https://proceedings.mlr.press/v${year === 2024 ? '235' : year === 2023 ? '202' : String(year).slice(-2)}/`
      ] : []),
      // ACL 专用
      ...(confName.toLowerCase() === 'acl' ? [`https://aclanthology.org/events/acl-${year}/`] : []),
      ...(confName.toLowerCase() === 'emnlp' ? [`https://aclanthology.org/events/emnlp-${year}/`] : []),
      ...(confName.toLowerCase() === 'naacl' ? [`https://aclanthology.org/events/naacl-${year}/`] : []),
      // CVPR/ICCV/ECCV 专用
      ...(confName.toLowerCase() === 'cvpr' ? [`https://openaccess.thecvf.com/CVPR${year}`] : []),
      ...(confName.toLowerCase() === 'iccv' ? [`https://openaccess.thecvf.com/ICCV${year}`] : []),
      ...(confName.toLowerCase() === 'eccv' ? [`https://openaccess.thecvf.com/ECCV${year}`] : []),
      // OpenReview 通用
      `https://openreview.net/group?id=${confName}.cc/${year}/Conference`,
    ];

    for (const url of fallbackUrls) {
      try {
        const response = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          console.log(`    ✅ 回退找到 ${confName} ${year}: ${url}`);
          return url;
        }
      } catch (e) {
        continue;
      }
    }

    console.log(`    ⚠️ 未找到 ${confName} ${year} 的有效URL`);
    return null;
  } catch (error) {
    console.error(`    ❌ 搜索失败: ${error}`);
    return null;
  }
}

// 顶刊RSS配置（各领域高水平期刊）
const JOURNAL_RSS_SOURCES: Record<string, { name: string; url: string; nameZh: string }[]> = {
  'ai-ml-llm': [
    { name: 'Nature Machine Intelligence', nameZh: '自然机器智能', url: 'https://www.nature.com/natmachintell/rss.xml' },
    { name: 'Journal of Machine Learning Research', nameZh: '机器学习研究期刊', url: 'https://www.jmlr.org/jmlr.xml' },
    { name: 'IEEE TPAMI', nameZh: 'IEEE模式分析与机器智能', url: 'https://ieeexplore.ieee.org/rss/periodical/34' },
    { name: 'Artificial Intelligence', nameZh: '人工智能', url: 'https://rss.sciencedirect.com/publication/science/4378' },
  ],
  'physics': [
    { name: 'Physical Review Letters', nameZh: '物理评论快报', url: 'https://journals.aps.org/prl/rss' },
    { name: 'Physical Review X', nameZh: '物理评论X', url: 'https://journals.aps.org/prx/rss' },
    { name: 'Nature Physics', nameZh: '自然物理', url: 'https://www.nature.com/nphys/rss.xml' },
    { name: 'Reviews of Modern Physics', nameZh: '现代物理评论', url: 'https://journals.aps.org/rmp/rss' },
    { name: 'Nature Reviews Physics', nameZh: '自然综述：物理', url: 'https://www.nature.com/natrevphys/rss.xml' },
  ],
  'materials': [
    { name: 'Nature Materials', nameZh: '自然材料', url: 'https://www.nature.com/nmat/rss.xml' },
    { name: 'Advanced Materials', nameZh: '先进材料', url: 'https://onlinelibrary.wiley.com/action/showFeed?type=etoc&feed=rss&jc=adma' },
    { name: 'ACS Nano', nameZh: 'ACS纳米', url: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ancac3' },
    { name: 'Nature Reviews Materials', nameZh: '自然综述：材料', url: 'https://www.nature.com/natrevmats/rss.xml' },
    { name: 'Materials Today', nameZh: '今日材料', url: 'https://rss.sciencedirect.com/publication/science/2980' },
  ],
  'bio-medicine': [
    { name: 'Nature', nameZh: '自然', url: 'https://www.nature.com/nature.rss' },
    { name: 'Science', nameZh: '科学', url: 'https://www.science.org/rss/news_current.xml' },
    { name: 'Cell', nameZh: '细胞', url: 'https://www.cell.com/cell/rss' },
    { name: 'Nature Medicine', nameZh: '自然医学', url: 'https://www.nature.com/nm/rss.xml' },
    { name: 'Nature Methods', nameZh: '自然方法', url: 'https://www.nature.com/nmeth/rss.xml' },
    { name: 'Nature Biotechnology', nameZh: '自然生物技术', url: 'https://www.nature.com/nbt/rss.xml' },
    { name: 'The Lancet', nameZh: '柳叶刀', url: 'https://www.thelancet.com/rssfeed/lancet_current.xml' },
    { name: 'NEJM', nameZh: '新英格兰医学杂志', url: 'https://feeds.nejm.org/nejm_medical.xml' },
  ],
  'computer-science': [
    { name: 'CACM', nameZh: '美国计算机协会通讯', url: 'https://cacm.acm.org/feed/' },
    { name: 'IEEE Computer', nameZh: 'IEEE计算机杂志', url: 'https://ieeexplore.ieee.org/rss/periodical/2' },
  ],
  'ir-db': [
    { name: 'VLDB Journal', nameZh: 'VLDB期刊', url: 'https://link.springer.com/search.rss?facet-content-type=Article&facet-journal-id=778&channel-name=The+VLDB+Journal' },
    { name: 'ACM TODS', nameZh: 'ACM数据库系统汇刊', url: 'https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=tods' },
    { name: 'IEEE TKDE', nameZh: 'IEEE知识与数据工程汇刊', url: 'https://ieeexplore.ieee.org/rss/periodical/69' },
    { name: 'Information Systems', nameZh: '信息系统', url: 'https://rss.sciencedirect.com/publication/science/5750' },
  ],
  'hci': [
    { name: 'TOCHI', nameZh: '人机交互汇刊', url: 'https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=tochi' },
    { name: 'IJHCS', nameZh: '人机交互研究国际期刊', url: 'https://rss.sciencedirect.com/publication/science/5924' },
    { name: 'Human-Computer Interaction', nameZh: '人机交互', url: 'https://www.tandfonline.com/action/showFeed?type=etoc&feed=rss&jc=hhci20' },
  ],
  'theory': [
    { name: 'JACM', nameZh: '美国计算机学会杂志', url: 'https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc= jacm' },
    { name: 'SIAM Journal on Computing', nameZh: 'SIAM计算杂志', url: 'https://epubs.siam.org/action/showFeed?type=etoc&feed=rss&jc=smjcat' },
    { name: 'Algorithmica', nameZh: '算法', url: 'https://link.springer.com/search.rss?facet-content-type=Article&facet-journal-id=453&channel-name=Algorithmica' },
    { name: 'Computational Complexity', nameZh: '计算复杂性', url: 'https://link.springer.com/search.rss?facet-content-type=Article&facet-journal-id=37&channel-name=Computational+Complexity' },
  ],
  'math': [
    { name: 'Annals of Mathematics', nameZh: '数学年刊', url: 'https://annals.math.princeton.edu/rss.xml' },
    { name: 'Inventiones Mathematicae', nameZh: '数学新进展', url: 'https://link.springer.com/search.rss?facet-content-type=Article&facet-journal-id=222&channel-name=Inventiones%20mathematicae' },
    { name: 'Journal of the AMS', nameZh: '美国数学学会杂志', url: 'https://www.ams.org/journals/jams/jams-rss.xml' },
  ],
};

// ============================================================================
// 类型定义
// ============================================================================

interface ArxivPaper {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
  index: number;
}

interface ScoredPaper extends ArxivPaper {
  score: number;
  scoreDetails: {
    novelty: number;
    experiment: number;
    practical: number;
  };
  chineseTitle: string;
  chineseSummary: string;
  recommendation: string;
  tags: string[];
}

// ============================================================================
// 工具函数
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    hours: 72,          // 默认3天
    topN: 20,          // 总榜精选数量
    categoryTopN: 10,   // 每个分类精选数量
    categories: DOMAIN_PRESETS['ai-ml-llm'], // 默认AI/ML/LLM
    domain: 'ai-ml-llm', // 领域预设
    lang: 'zh',
    output: join(OUTPUT_DIR, 'paper-digest.md'),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--hours':
        config.hours = parseInt(args[++i]);
        break;
      case '--top-n':
        config.topN = parseInt(args[++i]);
        break;
      case '--category-top-n':
        config.categoryTopN = parseInt(args[++i]);
        break;
      case '--domain':
        const domain = args[++i];
        config.domain = domain;
        config.categories = DOMAIN_PRESETS[domain] || [domain];
        break;
      case '--categories':
        config.categories = args[++i].split(',');
        config.domain = 'custom';
        break;
      case '--lang':
        config.lang = args[++i];
        break;
      case '--output':
        config.output = args[++i];
        break;
    }
  }

  return config;
}

function getRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}天前`;
}

// ============================================================================
// 核心功能
// ============================================================================

async function fetchArxivPapers(categories: string[], hours: number): Promise<ArxivPaper[]> {
  const papers: ArxivPaper[] = [];
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  console.log(`📡 正在抓取 arXiv 论文 (${hours}小时内)...`);
  
  for (const cat of categories) {
    try {
      const query = `cat:${cat}`;
      // 抓取足够多的论文，确保覆盖指定天数
      const url = `${ARXIV_API_BASE}?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=500`;
      
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      
      // 解析 XML
      const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
      let count = 0;
      
      for (const entry of entries) {
        const published = entry.match(/<published>(.*?)<\/published>/)?.[1] || '';
        const pubDate = new Date(published);
        
        // 按时间过滤，只保留 cutoffTime 之后的论文
        if (pubDate < cutoffTime) continue;
        
        const id = entry.match(/<id>(.*?)<\/id>/)?.[1] || '';
        const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\n/g, ' ').trim() || '';
        const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\n/g, ' ').trim() || '';
        const authors = (entry.match(/<author><name>(.*?)<\/name><\/author>/g) || [])
          .map(a => a.replace(/<author><name>|<\/name><\/author>/g, ''));
        const cats = (entry.match(/<category term="(.*?)"/g) || [])
          .map(c => c.replace(/<category term="|"/g, ''));
        // arXiv XML: <link href="..." rel="related" type="application/pdf" title="pdf"/>
        const pdfMatch = entry.match(/<link\s+[^>]*href="([^"]+)"[^>]*title="pdf"/)
          || entry.match(/<link\s+[^>]*title="pdf"[^>]*href="([^"]+)"/);
        const pdfUrl = pdfMatch?.[1] || '';
        
        papers.push({
          id,
          title,
          summary,
          authors,
          published,
          updated: entry.match(/<updated>(.*?)<\/updated>/)?.[1] || published,
          categories: cats,
          pdfUrl,
          index: papers.length,
        });
        count++;
      }
      
      console.log(`  ✅ ${cat}: ${count} 篇论文`);
    } catch (error) {
      console.error(`  ❌ ${cat}: 抓取失败 - ${error}`);
    }
  }
  
  return papers;
}

// 检测会议是否已开（通过网络搜索获取真实URL）
async function detectConferenceYear(conf: ConferenceConfig): Promise<{ year: number; url: string } | null> {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // 策略：如果当前月份已超过会议举办月份+1，尝试当年；否则从前一年开始
  let startYear = currentMonth > conf.typicalMonth + 1 ? currentYear : currentYear - 1;

  // 最多尝试3年（当年、前年、大前年）
  for (let year = startYear; year >= startYear - 2; year--) {
    try {
      console.log(`    🔍 检测 ${conf.name} ${year}...`);

      // 使用网络搜索获取真实URL
      const url = await searchConferenceUrl(conf.name, year);

      if (url) {
        // 验证页面是否有论文内容
        const fullResponse = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          signal: AbortSignal.timeout(15000)
        });

        if (fullResponse.ok) {
          const html = await fullResponse.text();

          // 严格检测：页面必须包含实际的论文列表
          // OpenReview 应该有 forum 链接，其他应该有论文标题
          const hasForumLinks = html.includes('/forum?id=');
          const hasPaperTitles = html.match(/class="[^"]*title[^"]*"/i) ||
                                html.match(/<h[1-6][^>]*>[^<]{20,200}<\/h[1-6]>/i);
          const hasActualPapers = hasForumLinks || (hasPaperTitles && html.length > 10000);

          // 排除只有投稿界面的情况
          const isSubmissionOnly = html.includes('Submission') && !hasForumLinks;

          if (hasActualPapers && !isSubmissionOnly) {
            console.log(`    ✅ 找到 ${conf.name} ${year} 会议页面 (${hasForumLinks ? '有论文链接' : '有标题'})`);
            return { year, url };
          } else {
            console.log(`    ⚠️ ${conf.name} ${year} 页面无实际论文 (可能是投稿阶段)`);
          }
        }
      }
    } catch (error) {
      // 继续尝试前一年
      continue;
    }
  }

  console.log(`    ⚠️ 未找到 ${conf.name} 的有效会议页面`);
  return null;
}

// 解析会议页面获取论文列表
async function parseConferencePapers(url: string, conf: ConferenceConfig, year: number): Promise<Partial<ArxivPaper>[]> {
  const papers: Partial<ArxivPaper>[] = [];

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      console.log(`    ⚠️ 页面返回 ${response.status}`);
      return papers;
    }

    const html = await response.text();
    const domain = new URL(url).hostname;
    console.log(`    📄 页面大小: ${html.length} 字符, 域名: ${domain}`);

    // papers.nips.cc 解析 (NeurIPS)
    if (domain.includes('papers.nips.cc')) {
      console.log(`    🔍 使用 NeurIPS papers.nips.cc 解析器`);

      const paperContentPattern = /<div class="paper-content">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      let match;
      while ((match = paperContentPattern.exec(html)) !== null && papers.length < 500) {
        const paperPath = match[1];
        const title = match[2].trim();

        if (title.length > 20 && title.length < 300) {
          const fullUrl = paperPath.startsWith('http') ? paperPath : `https://papers.nips.cc${paperPath}`;
          papers.push({ title, pdfUrl: fullUrl, summary: `来源: ${conf.nameZh} ${year}` });
        }
      }
    }
    // PMLR 解析 (ICML, ICLR)
    else if (domain.includes('proceedings.mlr.press')) {
      console.log(`    🔍 使用 PMLR 解析器`);

      const paperPattern = /<div class="paper">[\s\S]*?<p class="title">([^<]+)<\/p>/gi;
      let match;
      while ((match = paperPattern.exec(html)) !== null && papers.length < 500) {
        const title = match[1].trim();

        if (title.length > 20 && title.length < 300) {
          papers.push({ title, pdfUrl: url, summary: `来源: ${conf.nameZh} ${year}` });
        }
      }
    }
    // OpenReview 解析 (NeurIPS, ICML, ICLR, IJCAI)
    if (domain.includes('openreview.net')) {
      console.log(`    🔍 使用 OpenReview API 解析器`);

      // OpenReview 新版使用 API 获取数据
      // 构造 API URL
      const confId = conf.name.toLowerCase();
      let apiUrl: string | null = null;

      // 尝试不同的 invitation 格式
      const invitations = [
        `${conf.name}.cc/${year}/Conference/-/Blind_Submission`,
        `${conf.name}.cc/${year}/Workshop/-/Blind_Submission`,
        `${conf.name}.cc/${year}/Conference/-/Submission`,
      ];

      for (const invitation of invitations) {
        const testUrl = `https://api.openreview.net/notes?invitation=${encodeURIComponent(invitation)}&details=replyCount&offset=0&limit=200`;
        try {
          const apiResponse = await fetch(testUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(20000)
          });

          if (apiResponse.ok) {
            const data = await apiResponse.json() as { notes?: Array<{ id: string; forum: string; content?: { title?: { value: string } | string; pdf?: { value: string } | string } }> };

            if (data.notes && data.notes.length > 0) {
              console.log(`    ✅ 找到 API 数据: ${invitation} (${data.notes.length} 篇)`);

              for (const note of data.notes) {
                const titleObj = note.content?.title;
                const title = typeof titleObj === 'object' ? titleObj?.value : titleObj;
                const forumId = note.forum || note.id;

                if (title && forumId) {
                  papers.push({
                    title: title.trim(),
                    pdfUrl: `https://openreview.net/forum?id=${forumId}`,
                    summary: `来源: ${conf.nameZh} ${year}`,
                  });
                }
              }
              break; // 成功获取数据，跳出循环
            }
          }
        } catch (e) {
          continue;
        }
      }

      // 如果 API 失败，尝试旧版 HTML 解析
      if (papers.length === 0) {
        console.log(`    ⚠️ API 失败，尝试 HTML 解析...`);

        // 尝试从 script 标签中提取 JSON 数据
        const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const script of scriptMatches) {
          if (script.length > 10000) {
            // 尝试提取标题和 forum ID
            const titleMatches = [...script.matchAll(/"title"\s*:\s*"([^"]{20,300})"/g)];
            const forumMatches = [...script.matchAll(/"forum"\s*:\s*"([a-zA-Z0-9_-]{10,40})"/g)];

            if (titleMatches.length > 0 && forumMatches.length > 0) {
              const count = Math.min(titleMatches.length, forumMatches.length);
              for (let i = 0; i < count && i < 200; i++) {
                papers.push({
                  title: titleMatches[i][1],
                  pdfUrl: `https://openreview.net/forum?id=${forumMatches[i][1]}`,
                  summary: `来源: ${conf.nameZh} ${year}`,
                });
              }
              break;
            }
          }
        }
      }
    }
    // ACL Anthology 解析 (ACL, EMNLP, NAACL)
    else if (domain.includes('aclanthology.org')) {
      console.log(`    🔍 使用 ACL Anthology 解析器`);

      // ACL Anthology 页面使用无引号的属性: href=/2024.acl-long.X/
      // 结构: <span class=d-block><strong><a href=/2024.acl-long.X/>标题</a></strong></span>

      // 模式1: 匹配 d-block + strong + a 结构 (无引号 href)
      const paperPattern1 = /<span[^>]*class=["']?[^"'\s]*d-block[^"'\s]*["']?[^>]*>\s*<strong>\s*<a[^>]*href=["']?(\/\d{4}\.[^"'\s]+)["']?[^>]*>([^<]{10,300})<\/a>/gi;
      let match;

      while ((match = paperPattern1.exec(html)) !== null && papers.length < 200) {
        const paperPath = match[1];
        const title = match[2].trim();

        // 清理标题
        const cleanTitle = title.replace(/<[^>]+>/g, '').trim();

        if (cleanTitle.length > 15 && cleanTitle.length < 300 &&
            !cleanTitle.toLowerCase().includes('pdf') &&
            !cleanTitle.toLowerCase().includes('bib') &&
            !cleanTitle.toLowerCase().includes('abstract')) {
          const paperUrl = paperPath.startsWith('http') ? paperPath : `https://aclanthology.org${paperPath}`;
          papers.push({
            title: cleanTitle,
            pdfUrl: paperUrl,
            summary: `来源: ${conf.nameZh} ${year}`,
          });
        }
      }

      // 模式2: 备选 - 提取所有论文链接，然后查找对应标题
      if (papers.length === 0) {
        console.log(`    ⚠️ 主要模式失败，尝试备选模式...`);

        // 查找形如 /2024.acl-long.123 或 /2024.acl-long.123/ 的链接 (无引号或带引号)
        const linkPattern = /href=["']?(\/\d{4}\.[^"'\s]+\.\d+\/?)["']?/gi;
        const links: string[] = [];
        let linkMatch;
        while ((linkMatch = linkPattern.exec(html)) !== null) {
          const link = linkMatch[1];
          // 过滤掉 .pdf, .bib 等后缀，只保留论文页面链接
          if (!link.match(/\.(pdf|bib|txt|xml)$/i) && !links.includes(link)) {
            links.push(link);
          }
        }

        // 从页面中提取所有可能的标题
        // ACL 标题通常在 <span class=d-block>...<strong><a>标题</a></strong></span>
        const titlePattern2 = /<span[^>]*class=["']?[^"'\s]*d-block[^"'\s]*["']?[^>]*>[\s\S]*?<strong>[\s\S]*?<a[^>]*>([^<]{15,300})<\/a>/gi;
        const titles: string[] = [];
        let titleMatch;
        while ((titleMatch = titlePattern2.exec(html)) !== null) {
          const text = titleMatch[1].trim();
          if (text.length > 15 && text.length < 300 &&
              !text.toLowerCase().includes('pdf') &&
              !text.toLowerCase().includes('bib') &&
              !text.toLowerCase().includes('abstract')) {
            titles.push(text);
          }
        }

        console.log(`    📊 找到 ${links.length} 个链接和 ${titles.length} 个标题`);

        // 配对链接和标题
        const count = Math.min(links.length, titles.length, 200);
        for (let i = 0; i < count; i++) {
          papers.push({
            title: titles[i],
            pdfUrl: `https://aclanthology.org${links[i]}`,
            summary: `来源: ${conf.nameZh} ${year}`,
          });
        }
      }
    }
    // CVF 解析 (CVPR, ICCV, ECCV)
    else if (domain.includes('thecvf.com') || domain.includes('cvf')) {
      console.log(`    🔍 使用 CVF 解析器`);

      // CVF OpenAccess 格式:
      // <dt class="ptitle"><br><a href="...">标题</a></dt>
      // <dd>作者...</dd>
      // <dd>[<a href="...pdf">pdf</a>]</dd>

      // 首先查找所有 dt class="ptitle" 块
      const dtBlocks = html.split('<dt class="ptitle">');
      console.log(`    📊 找到 ${dtBlocks.length - 1} 个 ptitle 块`);

      for (let i = 1; i < dtBlocks.length && papers.length < 500; i++) {
        const block = dtBlocks[i];

        // 提取标题 (在 <a> 标签内)
        const titleMatch = block.match(/<a[^>]*>([^<]+)<\/a>/i);
        if (!titleMatch) continue;

        const title = titleMatch[1].trim();

        // 在 block 中查找 PDF 链接 (通常在下一个 <dd> 中)
        const ddBlocks = block.split('</dd>');
        let pdfUrl = '';

        for (const dd of ddBlocks) {
          const pdfMatch = dd.match(/href="([^"]*papers\/[^"]*\.pdf)"/i) ||
                           dd.match(/href="([^"]*\/content\/[^"]*\.pdf)"/i);
          if (pdfMatch) {
            pdfUrl = pdfMatch[1];
            if (!pdfUrl.startsWith('http')) {
              pdfUrl = 'https://openaccess.thecvf.com' + pdfUrl;
            }
            break;
          }
        }

        if (title.length > 20 && title.length < 300) {
          papers.push({
            title,
            pdfUrl: pdfUrl || `https://openaccess.thecvf.com`,
            summary: `来源: ${conf.nameZh} ${year}`,
          });
        }
      }

      // 备选：如果上述方法失败，使用更宽松的模式
      if (papers.length === 0) {
        console.log(`    ⚠️ 主要模式失败，尝试备选模式...`);

        // 查找所有 <dt class="ptitle"> 中的链接文本
        const ptitlePattern = /<dt[^>]*class="ptitle"[^>]*>[\s\S]*?<a[^>]*>([^<]{20,300})<\/a>/gi;
        let match;
        while ((match = ptitlePattern.exec(html)) !== null && papers.length < 500) {
          papers.push({
            title: match[1].trim(),
            pdfUrl: `https://openaccess.thecvf.com`,
            summary: `来源: ${conf.nameZh} ${year}`,
          });
        }
      }
    }
    // ACM DL 解析 (SIGMOD, SIGCOMM, CHI 等)
    else if (domain.includes('dl.acm.org')) {
      console.log(`    🔍 使用 ACM 解析器`);

      const titlePattern = /<h5[^>]*class="issue-item__title"[^>]*>([\s\S]*?)<\/h5>/gi;
      let match;
      while ((match = titlePattern.exec(html)) !== null && papers.length < 100) {
        const titleHtml = match[1];
        const titleMatch = titleHtml.match(/>([^<]+)</);
        const linkMatch = titleHtml.match(/href="([^"]+)"/);

        if (titleMatch) {
          const title = titleMatch[1].trim();
          const paperUrl = linkMatch ? `https://dl.acm.org${linkMatch[1]}` : url;
          papers.push({ title, pdfUrl: paperUrl, summary: `来源: ${conf.nameZh} ${year}` });
        }
      }
    }
    // USENIX 解析 (OSDI, SOSP, Security, ATC)
    else if (domain.includes('usenix.org') || domain.includes('usenix')) {
      console.log(`    🔍 使用 USENIX 解析器`);

      // USENIX 使用 paper-title 类
      const paperPattern = /<h2[^>]*class="paper-title"[^>]*>([\s\S]*?)<\/h2>/gi;
      let match;
      while ((match = paperPattern.exec(html)) !== null && papers.length < 100) {
        const titleText = match[1].replace(/<[^>]+>/g, '').trim();
        if (titleText.length > 20) {
          papers.push({ title: titleText, pdfUrl: url, summary: `来源: ${conf.nameZh} ${year}` });
        }
      }
    }
    // 通用解析器
    else {
      console.log(`    🔍 使用通用解析器`);

      const patterns = [
        { pattern: /<a[^>]*href="([^"]*forum[^"]*)"[^>]*>([^<]{20,200})<\/a>/gi, prefix: 'https://openreview.net' },
        { pattern: /<a[^>]*href="([^"]*paper[^"]*)"[^>]*>([^<]{20,200})<\/a>/gi, prefix: '' },
        { pattern: /<a[^>]*href="([^"]*\.pdf)"[^>]*>([^<]{20,200})<\/a>/gi, prefix: '' },
        { pattern: /<h[1-6][^>]*>([^<]{20,200})<\/h[1-6]>/gi, prefix: null },
      ];

      for (const { pattern, prefix } of patterns) {
        let match;
        while ((match = pattern.exec(html)) !== null && papers.length < 100) {
          const link = match[1];
          const title = match[2].trim();

          if (title.length < 20 || title.length > 300) continue;
          if (title.includes('Abstract') || title.includes('PDF') || title.includes('Session')) continue;
          if (papers.some(p => p.title === title)) continue;

          let fullUrl = url;
          if (prefix !== null) {
            fullUrl = prefix ? prefix + link : (link.startsWith('http') ? link : new URL(link, url).href);
          }

          papers.push({ title, pdfUrl: fullUrl, summary: `来源: ${conf.nameZh} ${year}` });
        }
        if (papers.length > 20) break;
      }
    }

    console.log(`    ✅ 解析完成，找到 ${papers.length} 篇论文`);
  } catch (error) {
    console.error(`    ❌ 解析失败: ${error}`);
  }

  return papers;
}

// 使用 Semantic Scholar API 获取顶会论文
async function fetchConferencePapersFromS2(conferenceName: string, year: number): Promise<ArxivPaper[]> {
  const papers: ArxivPaper[] = [];

  try {
    // Semantic Scholar 会议名称映射
    const venueMap: Record<string, string> = {
      'NeurIPS': 'NeurIPS',
      'ICML': 'ICML',
      'ICLR': 'ICLR',
      'ACL': 'ACL',
      'EMNLP': 'EMNLP',
      'NAACL': 'NAACL',
      'CVPR': 'CVPR',
      'ICCV': 'ICCV',
      'ECCV': 'ECCV',
      'AAAI': 'AAAI',
      'IJCAI': 'IJCAI',
      'KDD': 'KDD',
      'WWW': 'WWW',
      'SOSP': 'SOSP',
      'OSDI': 'OSDI',
      'EuroSys': 'EuroSys',
      'ASPLOS': 'ASPLOS',
      'SIGMOD': 'SIGMOD',
      'VLDB': 'VLDB',
      'ICDE': 'ICDE',
      'SIGCOMM': 'SIGCOMM',
      'NSDI': 'NSDI',
      'CHI': 'CHI',
      'UIST': 'UIST',
      'CSCW': 'CSCW',
      'IEEE S&P': 'IEEE S&P',
      'ACM CCS': 'CCS',
      'USENIX Security': 'USENIX Security',
      'NDSS': 'NDSS',
      'PLDI': 'PLDI',
      'POPL': 'POPL',
      'OOPSLA': 'OOPSLA',
      'ICFP': 'ICFP',
      'STOC': 'STOC',
      'FOCS': 'FOCS',
      'SODA': 'SODA',
      'ICALP': 'ICALP',
    };

    const venue = venueMap[conferenceName];
    if (!venue) {
      console.log(`    ⚠️ Semantic Scholar 未支持会议: ${conferenceName}`);
      return papers;
    }

    // 构建 API URL
    const fields = 'title,abstract,authors,year,venue,externalIds,openAccessPdf,citationCount,influentialCitationCount';
    const url = `${SEMANTIC_SCHOLAR_API_BASE}/paper/search?query=venue:${encodeURIComponent(venue)}+year:${year}&fields=${fields}&limit=500`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (S2_API_KEY) {
      headers['x-api-key'] = S2_API_KEY;
    }

    console.log(`    🔍 使用 Semantic Scholar API 获取 ${conferenceName} ${year}...`);

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 429) {
        console.log(`    ⚠️ Semantic Scholar API 限流，将回退到爬虫方案`);
      } else {
        console.log(`    ⚠️ Semantic Scholar API 错误 (${response.status})，将回退到爬虫方案`);
      }
      return papers;
    }

    const data = await response.json() as {
      total?: number;
      data?: Array<{
        title?: string;
        abstract?: string;
        authors?: Array<{ name: string }>;
        year?: number;
        venue?: string;
        externalIds?: { ArXiv?: string; DOI?: string };
        openAccessPdf?: { url?: string };
        citationCount?: number;
        influentialCitationCount?: number;
      }>;
    };

    if (!data.data || data.data.length === 0) {
      console.log(`    ⚠️ Semantic Scholar 未找到 ${conferenceName} ${year} 论文`);
      return papers;
    }

    console.log(`    ✅ Semantic Scholar 返回 ${data.data.length} 篇论文`);

    for (let i = 0; i < data.data.length; i++) {
      const p = data.data[i];
      if (!p.title) continue;

      // 构建 PDF URL
      let pdfUrl = '';
      if (p.openAccessPdf?.url) {
        pdfUrl = p.openAccessPdf.url;
      } else if (p.externalIds?.ArXiv) {
        pdfUrl = `https://arxiv.org/pdf/${p.externalIds.ArXiv}.pdf`;
      }

      papers.push({
        id: `${conferenceName}-${year}-${i}`,
        title: p.title,
        summary: p.abstract || `来源: ${conferenceName} ${year}`,
        authors: p.authors?.map(a => a.name) || [],
        published: new Date().toISOString(),
        updated: new Date().toISOString(),
        categories: ['conference', conferenceName.toLowerCase()],
        pdfUrl: pdfUrl,
        index: papers.length,
        // 额外元数据
        citationCount: p.citationCount,
        influentialCitationCount: p.influentialCitationCount,
      });
    }

  } catch (error) {
    console.log(`    ⚠️ Semantic Scholar API 失败: ${error}，将回退到爬虫方案`);
  }

  return papers;
}

// 抓取顶会论文（优先使用 Semantic Scholar API，失败则回退到爬虫）
async function fetchConferencePapers(domain: string, hours: number, specificYear?: number): Promise<ArxivPaper[]> {
  const papers: ArxivPaper[] = [];

  const conferences = CONFERENCE_CONFIG[domain];
  if (!conferences || conferences.length === 0) {
    console.log('📡 当前领域无顶会信息源');
    return papers;
  }

  if (specificYear) {
    console.log(`🏛️ 正在抓取 ${specificYear} 年顶会论文...`);
  } else {
    console.log(`🏛️ 正在检测并抓取顶会论文 (${hours}小时内)...`);
  }

  for (const conf of conferences) {
    try {
      const year = specificYear || new Date().getFullYear();

      console.log(`  📡 抓取 ${conf.nameZh} ${year}...`);

      let parsedPapers: ArxivPaper[] = [];

      // 1. 优先尝试 Semantic Scholar API
      if (!specificYear || year >= 2020) {
        parsedPapers = await fetchConferencePapersFromS2(conf.name, year);
      }

      // 2. 如果 API 失败或返回空，回退到爬虫方案
      if (parsedPapers.length === 0) {
        console.log(`    🔄 回退到爬虫方案...`);

        let url: string;
        if (specificYear) {
          url = await searchConferenceUrl(conf.name, year);
          if (!url) {
            console.log(`    ⚠️ ${conf.nameZh}: 未找到 ${year} 年会议页面`);
            continue;
          }
        } else {
          const confInfo = await detectConferenceYear(conf);
          if (!confInfo) {
            console.log(`    ⚠️ ${conf.nameZh}: 未找到有效会议页面`);
            continue;
          }
          url = confInfo.url;
        }

        const crawledPapers = await parseConferencePapers(url, conf, year);

        // 转换为统一格式
        for (let i = 0; i < crawledPapers.length; i++) {
          const p = crawledPapers[i];
          if (!p.title) continue;

          parsedPapers.push({
            id: `${conf.name}-${year}-${i}`,
            title: p.title,
            summary: p.summary || `来源: ${conf.nameZh} ${year}`,
            authors: [],
            published: new Date().toISOString(),
            updated: new Date().toISOString(),
            categories: ['conference', conf.name.toLowerCase()],
            pdfUrl: p.pdfUrl || '',
            index: parsedPapers.length,
          } as ArxivPaper);
        }
      }

      // 3. 如果解析到 0 篇论文且是动态检测模式，尝试前一年
      if (parsedPapers.length === 0 && !specificYear && year > 2020) {
        console.log(`    ⚠️ ${year} 年无论文，尝试 ${year - 1}...`);

        // 优先尝试 API 获取前一年
        parsedPapers = await fetchConferencePapersFromS2(conf.name, year - 1);

        // API 失败则回退到爬虫
        if (parsedPapers.length === 0) {
          const prevYearUrl = await searchConferenceUrl(conf.name, year - 1);
          if (prevYearUrl) {
            const crawledPapers = await parseConferencePapers(prevYearUrl, conf, year - 1);
            for (let i = 0; i < crawledPapers.length; i++) {
              const p = crawledPapers[i];
              if (!p.title) continue;
              parsedPapers.push({
                id: `${conf.name}-${year - 1}-${i}`,
                title: p.title,
                summary: p.summary || `来源: ${conf.nameZh} ${year - 1}`,
                authors: [],
                published: new Date().toISOString(),
                updated: new Date().toISOString(),
                categories: ['conference', conf.name.toLowerCase()],
                pdfUrl: p.pdfUrl || '',
                index: parsedPapers.length,
              } as ArxivPaper);
            }
          }
        }
      }

      papers.push(...parsedPapers);
      console.log(`  ✅ ${conf.name} ${year}: ${parsedPapers.length} 篇论文`);

    } catch (error) {
      console.error(`  ❌ ${conf.name}: 抓取失败 - ${error}`);
    }
  }

  return papers;
}

// 抓取顶刊RSS（物理、材料、生物领域）
async function fetchJournalPapers(domain: string, hours: number): Promise<ArxivPaper[]> {
  const papers: ArxivPaper[] = [];
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  const journals = JOURNAL_RSS_SOURCES[domain];
  if (!journals || journals.length === 0) {
    return papers;
  }
  
  console.log(`📚 正在抓取顶刊论文 (${hours}小时内)...`);
  
  for (const journal of journals) {
    try {
      const response = await fetch(journal.url, { signal: AbortSignal.timeout(20000) });
      const xml = await response.text();
      
      // 解析RSS/Atom
      const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) || [];
      let count = 0;
      
      for (const entry of entries) {
        const published = entry.match(/<published>(.*?)<\/published>/i)?.[1] 
          || entry.match(/<dc:date>(.*?)<\/dc:date>/i)?.[1]
          || entry.match(/<pubDate>(.*?)<\/pubDate>/i)?.[1]
          || '';
        
        if (published) {
          const pubDate = new Date(published);
          if (pubDate < cutoffTime) continue;
        }
        
        const title = entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';
        const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] 
          || entry.match(/<description>([\s\S]*?)<\/description>/i)?.[1]
          || entry.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1]
          || '';
        
        const link = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || '';
        const authorMatch = entry.match(/<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/gi) || [];
        const authors = authorMatch.map(a => a.match(/<name>([^<]+)<\/name>/i)?.[1] || '').filter(Boolean);
        
        if (title.length < 5) continue;
        
        papers.push({
          id: journal.url + '#' + title.slice(0, 20),
          title: title.replace(/<!\[CDATA\[|\]\]>/g, ''),
          summary: summary.replace(/<!\[CDATA\[|\]\]>/g, '').slice(0, 500),
          authors,
          published: published || new Date().toISOString(),
          updated: published || new Date().toISOString(),
          categories: ['journal'],
          pdfUrl: link,
          index: papers.length,
        });
        count++;
      }
      
      console.log(`  ✅ ${journal.nameZh}: ${count} 篇论文`);
    } catch (error) {
      console.error(`  ❌ ${journal.name}: 抓取失败 - ${error}`);
    }
  }
  
  return papers;
}

function buildBatchScoringPrompt(batch: ArxivPaper[]): string {
  const papersInfo = batch.map((p, i) => `
论文 ${i + 1}:
标题: ${p.title}
摘要: ${p.summary.slice(0, 300)}
作者: ${p.authors.slice(0, 3).join(', ')}
领域: ${p.categories.join(', ')}
`).join('\n');

  return `你是一位 AI 领域的顶级 reviewer。请对以下 ${batch.length} 篇论文进行评分（1-10）和简短点评。

${papersInfo}

请按以下格式评分 (直接输出，不要其他内容):

${batch.map((_, i) => `论文${i+1}: NOVELTY:[1-10] EXPERIMENT:[1-10] PRACTICAL:[1-10] REASON:[一句话推荐理由]`).join('\n')}
`;
}

async function scoreBatchWithAI(batch: ArxivPaper[]): Promise<ScoredPaper[]> {
  const prompt = buildBatchScoringPrompt(batch);
  
  try {
    const apiUrl = OPENAI_API_BASE + '/chat/completions';
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`API错误: ${response.status}`);
    }
    
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const result = data.choices?.[0]?.message?.content || '';
    
    // 解析批量结果
    const scoredPapers: ScoredPaper[] = [];
    
    for (let i = 0; i < batch.length; i++) {
      const paper = batch[i];
      
      // 匹配论文i+1的评分结果
      const paperMatch = result.match(new RegExp(`论文${i+1}:\\s*NOVELTY:(\\d+)\\s+EXPERIMENT:(\\d+)\\s+PRACTICAL:(\\d+)\\s+REASON:(.+)`));
      
      if (paperMatch) {
        const novelty = parseInt(paperMatch[1]);
        const experiment = parseInt(paperMatch[2]);
        const practical = parseInt(paperMatch[3]);
        const reason = paperMatch[4].trim();
        
        // 计算总分
        const score = Math.round(novelty * 0.4 + experiment * 0.3 + practical * 0.3) * 10;
        
        scoredPapers.push({
          ...paper,
          score,
          scoreDetails: { novelty, experiment, practical },
          chineseTitle: paper.title, // 翻译稍后批量处理
          chineseSummary: paper.summary.slice(0, 200),
          recommendation: reason,
          tags: paper.categories.slice(0, 3),
        });
      } else {
        // 解析失败，使用默认分数
        scoredPapers.push({
          ...paper,
          score: 50,
          scoreDetails: { novelty: 5, experiment: 5, practical: 5 },
          chineseTitle: paper.title,
          chineseSummary: paper.summary.slice(0, 200),
          recommendation: '值得一读',
          tags: paper.categories.slice(0, 3),
        });
      }
    }
    
    return scoredPapers;
  } catch (error) {
    console.error(`  ❌ 批量评分失败: ${error}`);
    // 返回默认分数
    return batch.map(p => ({
      ...p,
      score: 50,
      scoreDetails: { novelty: 5, experiment: 5, practical: 5 },
      chineseTitle: p.title,
      chineseSummary: p.summary.slice(0, 200),
      recommendation: '值得一读',
      tags: p.categories.slice(0, 3),
    }));
  }
}

async function translateText(text: string): Promise<string> {
  const prompt = `Translate the following to Chinese. Keep it concise:\n\n${text.slice(0, 500)}`;
  
  try {
    const apiUrl = OPENAI_API_BASE + '/chat/completions';
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
    });
    
    if (!response.ok) return text;
    
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || text;
  } catch {
    return text;
  }
}

async function translatePapers(papers: ScoredPaper[]): Promise<ScoredPaper[]> {
  console.log('  🌐 翻译标题和摘要...');
  
  const translated = await Promise.all(papers.map(async (p) => {
    const [title, summary] = await Promise.all([
      translateText(p.title),
      translateText(p.summary.slice(0, 300)),
    ]);
    
    return {
      ...p,
      chineseTitle: title,
      chineseSummary: summary,
    };
  }));
  
  return translated;
}

function generateMarkdown(
  papers: ScoredPaper[], 
  categoryTopPapers: Map<string, ScoredPaper[]>,
  config: any
): string {
  const now = new Date().toLocaleString('zh-CN');
  const totalCount = papers.length;
  const categoryCount = Array.from(categoryTopPapers.values()).reduce((sum, arr) => sum + arr.length, 0);
  
  let md = `# 📚 Paper Digest - 精选论文摘要

> 生成时间: ${now}
> 扫描领域: ${config.categories.map((c: string) => ARXIV_CATEGORIES[c] || c).join(', ')}
> 时间范围: ${config.hours} 小时 (${Math.floor(config.hours / 24)} 天)

---

## 📊 数据概览

- 抓取论文数: ${totalCount} 篇 (arXiv + 顶会)
- 分类精选: ${categoryCount} 篇 (每类 ${config.categoryTopN} 篇)
- 总榜精选: ${config.topN} 篇

---

`;

  // 分类精选榜
  md += `## 🏷️ 分类精选 Top ${config.categoryTopN}

`;
  
  for (const cat of config.categories) {
    const catPapers = categoryTopPapers.get(cat) || [];
    if (catPapers.length === 0) continue;
    
    const catName = ARXIV_CATEGORIES[cat] || cat;
    md += `### ${catName}\n\n`;
    
    for (let i = 0; i < catPapers.length; i++) {
      const p = catPapers[i];
      md += `**${i + 1}.** [${p.chineseTitle}](${p.pdfUrl})\n`;
      md += `   ⭐ ${p.score} | ${p.recommendation} | [查看论文](${p.pdfUrl})\n\n`;
    }
  }
  
  // 总榜
  md += `---

## 🏆 今日必读 Top ${config.topN}

`;
  
  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const rank = i + 1;
    md += `### ${rank}. ${p.chineseTitle}

**原文标题**: ${p.title}

**评分**: ⭐ ${p.score}/100 | 创新性: ${p.scoreDetails.novelty}/10 | 实验: ${p.scoreDetails.experiment}/10 | 实用性: ${p.scoreDetails.practical}/10

**作者**: ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? '...' : ''}

**发布时间**: ${getRelativeTime(p.published)}

**推荐理由**: ${p.recommendation}

**标签**: ${p.tags.join(', ')}

**PDF**: [下载](${p.pdfUrl})

**中文摘要**: ${p.chineseSummary}

**英文摘要**: ${p.summary}

---

`;
  }
  
  md += `

## 📝 使用说明

- 本摘要由 AI 自动生成，仅供参考
- 评分基于论文标题和摘要，未包含引用数（arXiv 新论文暂无引用数据）
- 如需更详细信息，建议直接阅读原版论文

---
*Generated by Paper Digest*
`;
  
  return md;
}

// 生成多领域报告
function generateMultiDomainMarkdown(
  domainResults: { config: DomainConfig; papers: ScoredPaper[] }[]
): string {
  const now = new Date().toLocaleString('zh-CN');
  const totalPapers = domainResults.reduce((sum, r) => sum + r.papers.length, 0);

  let md = `# 📚 Paper Digest - 多领域精选论文

> 生成时间: ${now}
> 领域数: ${domainResults.length} 个
> 总精选论文: ${totalPapers} 篇

---

## 📊 目录

`;

  // 生成目录
  for (let i = 0; i < domainResults.length; i++) {
    const { config, papers } = domainResults[i];
    md += `${i + 1}. [${config.name}](#${config.key}) - ${papers.length} 篇\n`;
  }

  md += `
---

`;

  // 每个领域的详细内容
  for (const { config, papers } of domainResults) {
    md += `## <a name="${config.key}"></a>📚 ${config.name}\n\n`;

    // 该领域的配置信息
    const sources: string[] = [];
    if (config.sources.arxiv) sources.push('arXiv');
    if (config.sources.conference) {
      sources.push(config.conferenceYear ? `顶会 (${config.conferenceYear})` : '顶会');
    }
    if (config.sources.journal) sources.push('顶刊');

    md += `**数据源**: ${sources.join(', ') || '无'}  \n`;
    if (config.sources.arxiv || config.sources.journal) {
      md += `**时间范围**: ${TIME_OPTIONS.find(t => t.hours === config.hours)?.label}  \n`;
    }
    md += `**精选数量**: ${papers.length} 篇\n\n`;

    if (papers.length === 0) {
      md += `> ⚠️ 该领域未抓取到论文\n\n`;
      md += `---\n\n`;
      continue;
    }

    // 该领域的论文列表
    for (let i = 0; i < papers.length; i++) {
      const p = papers[i];
      md += `### ${i + 1}. ${p.chineseTitle}

**原文标题**: ${p.title}

**评分**: ⭐ ${p.score}/100 | 创新性: ${p.scoreDetails.novelty}/10 | 实验: ${p.scoreDetails.experiment}/10 | 实用性: ${p.scoreDetails.practical}/10

**作者**: ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? '...' : ''}

**推荐理由**: ${p.recommendation}

**标签**: ${p.tags.join(', ')}

**PDF**: [查看论文](${p.pdfUrl})

**中文摘要**: ${p.chineseSummary}

**英文摘要**: ${p.summary}

---

`;
    }
  }

  // 添加汇总对比表
  md += `## 📈 各领域对比\n\n`;
  md += `| 领域 | 论文数 | 平均分 | 最高分 | 最低分 |\n`;
  md += `|------|--------|--------|--------|--------|\n`;

  for (const { config, papers } of domainResults) {
    if (papers.length === 0) {
      md += `| ${config.name} | 0 | - | - | - |\n`;
      continue;
    }
    const avgScore = Math.round(papers.reduce((s, p) => s + p.score, 0) / papers.length);
    const maxScore = Math.max(...papers.map(p => p.score));
    const minScore = Math.min(...papers.map(p => p.score));
    md += `| ${config.name} | ${papers.length} | ${avgScore} | ${maxScore} | ${minScore} |\n`;
  }

  md += `

## 📝 使用说明

- 本摘要由 AI 自动生成，仅供参考
- 每个领域独立配置、独立抓取、独立排名
- 评分基于论文标题和摘要
- 如需更详细信息，建议直接阅读原版论文

---
*Generated by Paper Digest*
`;

  return md;
}

// ============================================================================
// 交互式 CLI 功能
// ============================================================================

// 领域配置（带中文名）
const DOMAIN_CONFIG: { key: string; name: string; hasConference: boolean; hasJournal: boolean }[] = [
  { key: 'ai-ml-llm', name: 'AI/ML/LLM', hasConference: true, hasJournal: true },
  { key: 'computer-science', name: '计算机科学(系统/网络)', hasConference: true, hasJournal: true },
  { key: 'theory', name: '理论/算法', hasConference: true, hasJournal: true },
  { key: 'ir-db', name: '信息检索/数据库', hasConference: true, hasJournal: true },
  { key: 'hci', name: '人机交互', hasConference: true, hasJournal: true },
  { key: 'security', name: '网络安全', hasConference: true, hasJournal: false },
  { key: 'programming', name: '编程语言', hasConference: true, hasJournal: false },
  { key: 'physics', name: '物理学', hasConference: false, hasJournal: true },
  { key: 'materials', name: '材料科学', hasConference: false, hasJournal: true },
  { key: 'bio-medicine', name: '生物/医学', hasConference: false, hasJournal: true },
  { key: 'math', name: '数学', hasConference: false, hasJournal: true },
];

// 时间范围选项
const TIME_OPTIONS = [
  { hours: 24, label: '24小时 (1天)' },
  { hours: 72, label: '72小时 (3天)' },
  { hours: 168, label: '7天' },
  { hours: 720, label: '30天' },
];

function askQuestion(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function interactiveSelectDomains(): Promise<string[]> {
  console.log('\n📋 请选择领域（输入序号，多个用逗号分隔，如: 1,3,5）：\n');
  DOMAIN_CONFIG.forEach((d, i) => {
    const sources: string[] = ['arXiv'];
    if (d.hasConference) sources.push('顶会');
    if (d.hasJournal) sources.push('顶刊');
    console.log(`  ${i + 1}. ${d.name} ${sources.join('+')}`);
  });
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号: ');
  rl.close();

  const indices = answer.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < DOMAIN_CONFIG.length);
  const selected = [...new Set(indices)].map(i => DOMAIN_CONFIG[i].key);

  if (selected.length === 0) {
    console.log('⚠️ 未选择有效领域，默认使用 AI/ML/LLM');
    return ['ai-ml-llm'];
  }

  console.log(`\n✅ 已选择: ${selected.map(k => DOMAIN_CONFIG.find(d => d.key === k)?.name).join(', ')}`);
  return selected;
}

async function interactiveSelectSources(selectedDomains: string[]): Promise<{ arxiv: boolean; conference: boolean; journal: boolean; conferenceYear?: number }> {
  // 检查选中领域支持的数据源
  const hasConference = selectedDomains.some(d => DOMAIN_CONFIG.find(c => c.key === d)?.hasConference);
  const hasJournal = selectedDomains.some(d => DOMAIN_CONFIG.find(c => c.key === d)?.hasJournal);

  console.log('\n📡 请选择数据源：\n');
  console.log('  1. arXiv (所有领域都支持)');
  if (hasConference) console.log('  2. 顶会 (仅AI/ML/LLM领域)');
  else console.log('  2. 顶会 (所选领域不支持)');
  if (hasJournal) console.log('  3. 顶刊 (物理/材料/生物领域)');
  else console.log('  3. 顶刊 (所选领域不支持)');
  console.log('  0. 全部选择');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号（多个用逗号分隔）: ');
  rl.close();

  const selections = answer.split(',').map(s => s.trim());
  const selectAll = selections.includes('0');

  const sources = {
    arxiv: selectAll || selections.includes('1'),
    conference: (selectAll || selections.includes('2')) && hasConference,
    journal: (selectAll || selections.includes('3')) && hasJournal,
  };

  if (!sources.arxiv && !sources.conference && !sources.journal) {
    console.log('⚠️ 未选择数据源，默认使用 arXiv');
    sources.arxiv = true;
  }

  const selectedNames: string[] = [];
  if (sources.arxiv) selectedNames.push('arXiv');
  if (sources.conference) selectedNames.push('顶会');
  if (sources.journal) selectedNames.push('顶刊');
  console.log(`\n✅ 数据源: ${selectedNames.join(', ')}`);

  // 如果选择顶会，让用户选择年份
  let conferenceYear: number | undefined;
  if (sources.conference) {
    conferenceYear = await interactiveSelectConferenceYear();
  }

  return { ...sources, conferenceYear };
}

async function interactiveSelectConferenceYear(): Promise<number> {
  const currentYear = new Date().getFullYear();
  console.log('\n📅 请选择顶会年份：\n');
  for (let i = 0; i < 5; i++) {
    const year = currentYear - i;
    console.log(`  ${i + 1}. ${year}年`);
  }
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号 (默认 1): ');
  rl.close();

  const index = parseInt(answer) - 1;
  const year = (index >= 0 && index < 5) ? currentYear - index : currentYear;

  console.log(`\n✅ 顶会年份: ${year}年`);
  return year;
}

async function interactiveSelectTime(): Promise<number> {
  console.log('\n⏰ 请选择时间范围：\n');
  TIME_OPTIONS.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.label}`);
  });
  console.log('  5. 自定义小时数');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号 (默认 2): ');
  rl.close();

  const index = parseInt(answer) - 1;

  // 自定义输入
  if (index === 4) {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const customHours = await askQuestion(rl2, '请输入自定义小时数 (1-2160): ');
    rl2.close();
    const hours = Math.max(1, Math.min(2160, parseInt(customHours) || 72));
    console.log(`\n✅ 时间范围: ${hours}小时`);
    return hours;
  }

  const hours = (index >= 0 && index < TIME_OPTIONS.length) ? TIME_OPTIONS[index].hours : 72;

  console.log(`\n✅ 时间范围: ${TIME_OPTIONS.find(t => t.hours === hours)?.label || '72小时'}`);
  return hours;
}

// 单个领域的配置接口
interface DomainConfig {
  key: string;
  name: string;
  sources: { arxiv: boolean; conference: boolean; journal: boolean };
  conferenceYear?: number;
  hours: number;
  topN: number;  // 该领域精选论文数
  categories: string[];
}

async function interactiveMode(userConfig: UserConfig): Promise<{
  domains: string[];
  sources: { arxiv: boolean; conference: boolean; journal: boolean };
  hours: number;
  categories: string[];
  conferenceYear?: number;
}> {
  showWelcome();

  // 1. 选择领域
  const domains = await interactiveSelectDomains();

  // 2. 选择数据源
  const { conferenceYear, ...sources } = await interactiveSelectSources(domains);

  // 3. 选择时间范围 (arXiv和顶刊需要时间范围，顶会按年份)
  let hours = userConfig.defaultHours;
  if (sources.arxiv || sources.journal) {
    hours = await interactiveSelectTime();
  }

  // 4. 确认
  console.log('\n' + '='.repeat(50));
  console.log('📋 配置确认：');
  console.log(`   领域: ${domains.map(k => DOMAIN_CONFIG.find(d => d.key === k)?.name).join(', ')}`);
  console.log(`   数据源: ${[
    sources.arxiv && 'arXiv',
    sources.conference && `顶会${conferenceYear ? ` (${conferenceYear}年)` : ''}`,
    sources.journal && '顶刊'
  ].filter(Boolean).join(', ')}`);
  if (sources.arxiv || sources.journal) {
    console.log(`   时间: ${TIME_OPTIONS.find(t => t.hours === hours)?.label}`);
  }
  console.log('='.repeat(50) + '\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await askQuestion(rl, '确认开始抓取? (Y/n): ');
  rl.close();

  if (confirm.toLowerCase() === 'n') {
    console.log('❌ 已取消');
    process.exit(0);
  }

  // 合并所有分类
  const categories = [...new Set(domains.flatMap(d => DOMAIN_PRESETS[d] || []))];

  return { domains, sources, hours, categories, conferenceYear };
}


// 为单个领域选择数据源
async function interactiveSelectSourcesForDomain(
  domainInfo: typeof DOMAIN_CONFIG[0]
): Promise<{ arxiv: boolean; conference: boolean; journal: boolean; conferenceYear?: number }> {
  const hasConference = domainInfo.hasConference;
  const hasJournal = domainInfo.hasJournal;

  console.log(`\n📡 请选择数据源：\n`);
  console.log('  1. arXiv (所有领域都支持)');
  if (hasConference) console.log('  2. 顶会 (仅AI/ML/LLM领域)');
  else console.log('  2. 顶会 (该领域不支持)');
  if (hasJournal) console.log('  3. 顶刊 (物理/材料/生物领域)');
  else console.log('  3. 顶刊 (该领域不支持)');
  console.log('  0. 全部选择');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号（多个用逗号分隔）: ');
  rl.close();

  const selections = answer.split(',').map(s => s.trim());
  const selectAll = selections.includes('0');

  const sources = {
    arxiv: selectAll || selections.includes('1'),
    conference: (selectAll || selections.includes('2')) && hasConference,
    journal: (selectAll || selections.includes('3')) && hasJournal,
  };

  if (!sources.arxiv && !sources.conference && !sources.journal) {
    console.log('⚠️ 未选择数据源，默认使用 arXiv');
    sources.arxiv = true;
  }

  const selectedNames: string[] = [];
  if (sources.arxiv) selectedNames.push('arXiv');
  if (sources.conference) selectedNames.push('顶会');
  if (sources.journal) selectedNames.push('顶刊');
  console.log(`\n✅ 数据源: ${selectedNames.join(', ')}`);

  // 如果选择顶会，选择年份
  let conferenceYear: number | undefined;
  if (sources.conference) {
    conferenceYear = await interactiveSelectConferenceYearForDomain(domainInfo.name);
  }

  return { ...sources, conferenceYear };
}

// 为单个领域选择年份
async function interactiveSelectConferenceYearForDomain(domainName: string): Promise<number> {
  const currentYear = new Date().getFullYear();
  console.log(`\n📅 [${domainName}] 请选择顶会年份：\n`);
  for (let i = 0; i < 5; i++) {
    const year = currentYear - i;
    console.log(`  ${i + 1}. ${year}年`);
  }
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号 (默认 1): ');
  rl.close();

  const index = parseInt(answer) - 1;
  const year = (index >= 0 && index < 5) ? currentYear - index : currentYear;

  console.log(`✅ 顶会年份: ${year}年`);
  return year;
}

// 为单个领域选择时间范围
async function interactiveSelectTimeForDomain(domainName: string): Promise<number> {
  console.log(`\n⏰ [${domainName}] 请选择时间范围：\n`);
  TIME_OPTIONS.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.label}`);
  });
  console.log('  5. 自定义小时数');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, '请输入序号 (默认 2): ');
  rl.close();

  const index = parseInt(answer) - 1;

  // 自定义输入
  if (index === 4) {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const customHours = await askQuestion(rl2, '请输入自定义小时数 (1-2160): ');
    rl2.close();
    const hours = Math.max(1, Math.min(2160, parseInt(customHours) || 72));
    console.log(`✅ 时间范围: ${hours}小时`);
    return hours;
  }

  const hours = (index >= 0 && index < TIME_OPTIONS.length) ? TIME_OPTIONS[index].hours : 72;

  console.log(`✅ 时间范围: ${TIME_OPTIONS.find(t => t.hours === hours)?.label || '72小时'}`);
  return hours;
}

// 为单个领域选择精选数量
async function interactiveSelectTopNForDomain(domainName: string, defaultTopN: number = 10): Promise<number> {
  console.log(`\n📊 [${domainName}] 请选择该领域精选论文数量：\n`);
  console.log('  1. 3 篇');
  console.log('  2. 5 篇');
  console.log('  3. 10 篇');
  console.log('  4. 15 篇');
  console.log('  5. 20 篇');
  console.log('  6. 自定义数量');
  console.log('');

  // 根据默认值确定默认选项
  let defaultOption = 3; // 默认选10篇
  if (defaultTopN <= 3) defaultOption = 1;
  else if (defaultTopN <= 5) defaultOption = 2;
  else if (defaultTopN <= 10) defaultOption = 3;
  else if (defaultTopN <= 15) defaultOption = 4;
  else if (defaultTopN <= 20) defaultOption = 5;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, `请输入序号 (默认 ${defaultOption}): `);
  rl.close();

  const options = [3, 5, 10, 15, 20];
  const index = parseInt(answer) - 1;

  // 自定义输入
  if (index === 5) {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const customTopN = await askQuestion(rl2, '请输入自定义数量 (1-50): ');
    rl2.close();
    const topN = Math.max(1, Math.min(50, parseInt(customTopN) || defaultTopN));
    console.log(`✅ 精选数量: ${topN} 篇`);
    return topN;
  }

  const topN = (index >= 0 && index < options.length) ? options[index] : defaultTopN;

  console.log(`✅ 精选数量: ${topN} 篇`);
  return topN;
}

// ============================================================================
// 配置文件管理
// ============================================================================

// 读取用户配置
async function loadUserConfig(): Promise<UserConfig> {
  try {
    await access(CONFIG_FILE);
    const content = await readFile(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_USER_CONFIG, ...JSON.parse(content) };
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
}

// 保存用户配置
async function saveUserConfig(config: UserConfig): Promise<void> {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 首次运行引导
async function firstRunSetup(): Promise<UserConfig> {
  showWelcome();
  console.log('这是您第一次使用，请完成以下初始设置：\n');

  const config: UserConfig = { ...DEFAULT_USER_CONFIG };

  // 1. API 配置
  console.log('📡 步骤 1/3: 配置大模型 API');
  console.log('   支持：DeepSeek、OpenAI 或其他兼容 API\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // API Key
  const apiKey = await askQuestion(rl, '请输入 API Key (留空使用环境变量 OPENAI_API_KEY): ');
  if (apiKey.trim()) {
    config.apiKey = apiKey.trim();
  }

  // API Base
  const apiBase = await askQuestion(rl, '请输入 API 地址 (默认: https://api.deepseek.com/v1): ');
  if (apiBase.trim()) {
    config.apiBase = apiBase.trim();
  }

  // API Model
  const apiModel = await askQuestion(rl, '请输入模型名称 (默认: deepseek-chat): ');
  if (apiModel.trim()) {
    config.apiModel = apiModel.trim();
  }

  console.log('\n✅ AI API 配置完成\n');

  // 1.5 Semantic Scholar API（可选）
  console.log('📚 步骤 1.5/3: 配置 Semantic Scholar API（可选）');
  console.log('   用于获取顶会论文，提供更稳定的论文数据源');
  console.log('   免费版限制 100 请求/5分钟，无 Key 也可使用\n');

  const s2ApiKey = await askQuestion(rl, '请输入 Semantic Scholar API Key (留空跳过): ');
  if (s2ApiKey.trim()) {
    (config as Record<string, string>).s2ApiKey = s2ApiKey.trim();
  }

  console.log('\n✅ Semantic Scholar 配置完成\n');

  // 2. 默认精选篇数
  console.log('📊 步骤 2/3: 设置默认精选论文数量');
  console.log('   1. 5 篇');
  console.log('   2. 10 篇 (推荐)');
  console.log('   3. 15 篇');
  console.log('   4. 20 篇');
  console.log('   5. 自定义');

  const topNAnswer = await askQuestion(rl, '\n请输入序号 (默认 2): ');
  const topNOptions = [5, 10, 15, 20];
  const topNIndex = parseInt(topNAnswer) - 1;

  if (topNIndex === 4) {
    const customTopN = await askQuestion(rl, '请输入自定义数量 (1-50): ');
    config.defaultTopN = Math.max(1, Math.min(50, parseInt(customTopN) || 10));
  } else {
    config.defaultTopN = (topNIndex >= 0 && topNIndex < topNOptions.length)
      ? topNOptions[topNIndex]
      : 10;
  }
  console.log(`✅ 默认精选数量: ${config.defaultTopN} 篇\n`);

  // 3. 默认时间范围
  console.log('⏰ 步骤 3/3: 设置默认时间范围');
  console.log('   1. 24小时 (1天)');
  console.log('   2. 72小时 (3天) (推荐)');
  console.log('   3. 7天');
  console.log('   4. 30天');
  console.log('   5. 自定义');

  const timeAnswer = await askQuestion(rl, '\n请输入序号 (默认 2): ');
  const timeOptions = [24, 72, 168, 720];
  const timeIndex = parseInt(timeAnswer) - 1;

  if (timeIndex === 4) {
    const customHours = await askQuestion(rl, '请输入自定义小时数 (1-2160): ');
    config.defaultHours = Math.max(1, Math.min(2160, parseInt(customHours) || 72));
  } else {
    config.defaultHours = (timeIndex >= 0 && timeIndex < timeOptions.length)
      ? timeOptions[timeIndex]
      : 72;
  }
  console.log(`✅ 默认时间范围: ${config.defaultHours}小时\n`);

  rl.close();

  // 标记已完成首次设置
  config.firstRun = false;

  // 保存配置
  await saveUserConfig(config);

  console.log('='.repeat(70));
  console.log('✅ 初始设置完成！配置已保存到:', CONFIG_FILE);
  console.log('='.repeat(70) + '\n');

  return config;
}

// ============================================================================
// 主函数 - 自动根据领域数量选择模式
// ============================================================================

async function main() {
  // 加载用户配置
  let userConfig = await loadUserConfig();

  // 首次运行引导
  if (userConfig.firstRun) {
    userConfig = await firstRunSetup();
  }

  // 检测是否使用交互模式
  const args = process.argv.slice(2);
  const useInteractive = args.length === 0 || args.includes('--interactive');

  // 检查 API Key（优先使用环境变量，其次使用配置文件）
  const effectiveApiKey = process.env.OPENAI_API_KEY || userConfig.apiKey || '';
  if (!effectiveApiKey) {
    console.error('❌ 未配置 API Key！');
    console.error('   请设置环境变量 OPENAI_API_KEY');
    console.error('   或删除配置文件重新运行首次设置向导');
    console.error(`   配置文件位置: ${CONFIG_FILE}`);
    process.exit(1);
  }

  // 设置 Semantic Scholar API Key（从配置或环境变量）
  S2_API_KEY = userConfig.s2ApiKey || process.env.S2_API_KEY || '';

  if (useInteractive) {
    // 显示欢迎信息并选择领域
    showWelcome();
    const domains = await interactiveSelectDomains();

    // 根据选择的领域数量自动决定模式
    if (domains.length === 1) {
      // 单领域模式 - 直接使用该领域的配置
      console.log(`\n📚 单领域模式: 将为 ${domains.map(k => DOMAIN_CONFIG.find(d => d.key === k)?.name).join(', ')} 配置数据源和参数\n`);
      await runSingleDomainMode(userConfig, domains[0]);
    } else {
      // 多领域模式 - 每个领域独立配置
      console.log(`\n📚 多领域模式: 将分别为 ${domains.length} 个领域独立配置数据源和精选数量\n`);
      await runMultiDomainMode(userConfig, domains);
    }
  } else {
    // 命令行模式
    await runCommandLineMode(args);
  }
}

// 为单个领域配置
async function configureSingleDomain(
  userConfig: UserConfig,
  domainKey: string
): Promise<DomainConfig> {
  const domainInfo = DOMAIN_CONFIG.find(d => d.key === domainKey)!;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📚 配置领域: ${domainInfo.name}`);
  console.log('─'.repeat(60));

  // 选择数据源
  const { conferenceYear, ...sources } = await interactiveSelectSourcesForDomain(domainInfo);

  // 选择时间范围
  let hours = userConfig.defaultHours;
  if (sources.arxiv || sources.journal) {
    hours = await interactiveSelectTimeForDomain(domainInfo.name);
  }

  // 选择精选数量
  const topN = await interactiveSelectTopNForDomain(domainInfo.name, userConfig.defaultTopN);

  return {
    key: domainKey,
    name: domainInfo.name,
    sources,
    conferenceYear,
    hours,
    topN,
    categories: DOMAIN_PRESETS[domainKey] || [],
  };
}

// 单领域模式
async function runSingleDomainMode(userConfig: UserConfig, domainKey: string) {
  const domainConfig = await configureSingleDomain(userConfig, domainKey);

  // 确认配置
  console.log('\n' + '='.repeat(60));
  console.log('📋 配置确认：');
  console.log(`  📚 ${domainConfig.name}`);
  console.log(`     数据源: ${[
    domainConfig.sources.arxiv && 'arXiv',
    domainConfig.sources.conference && `顶会${domainConfig.conferenceYear ? ` (${domainConfig.conferenceYear}年)` : ''}`,
    domainConfig.sources.journal && '顶刊'
  ].filter(Boolean).join(', ') || '无'}`);
  if (domainConfig.sources.arxiv || domainConfig.sources.journal) {
    console.log(`     时间范围: ${TIME_OPTIONS.find(t => t.hours === domainConfig.hours)?.label}`);
  }
  console.log(`     精选数量: ${domainConfig.topN} 篇`);
  console.log('='.repeat(60) + '\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await askQuestion(rl, '确认开始抓取? (Y/n): ');
  rl.close();

  if (confirm.toLowerCase() === 'n') {
    console.log('❌ 已取消');
    process.exit(0);
  }

  // 开始处理
  console.log('\n' + '='.repeat(70));
  console.log('🚀 开始论文抓取与评分');
  console.log('='.repeat(70) + '\n');

  // 1. 抓取论文
  let papers: ArxivPaper[] = [];

  if (domainConfig.sources.arxiv) {
    console.log('📡 抓取 arXiv...');
    const arxivPapers = await fetchArxivPapers(domainConfig.categories, domainConfig.hours);
    papers = [...papers, ...arxivPapers];
  }

  if (domainConfig.sources.conference) {
    console.log('📡 抓取顶会...');
    const confPapers = await fetchConferencePapers(domainConfig.key, domainConfig.hours, domainConfig.conferenceYear);
    papers = [...papers, ...confPapers];
  }

  if (domainConfig.sources.journal) {
    console.log('📡 抓取顶刊...');
    const jourPapers = await fetchJournalPapers(domainConfig.key, domainConfig.hours);
    papers = [...papers, ...jourPapers];
  }

  console.log(`\n✅ 共抓取 ${papers.length} 篇论文\n`);

  if (papers.length === 0) {
    console.log('⚠️ 未抓取到论文');
    return;
  }

  // 2. AI 评分
  console.log('🤖 正在进行 AI 评分...');
  const batches: ArxivPaper[][] = [];
  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    batches.push(papers.slice(i, i + BATCH_SIZE));
  }

  const allScored: ScoredPaper[] = [];
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT);
    console.log(`  评分进度: ${Math.min(i + MAX_CONCURRENT, batches.length)}/${batches.length} 批次`);
    const results = await Promise.all(batchGroup.map(batch => scoreBatchWithAI(batch)));
    allScored.push(...results.flat());
    if (i + MAX_CONCURRENT < batches.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCH));
    }
  }

  // 3. 翻译
  console.log('  🌐 翻译标题和摘要...');
  const translatedPapers = await translatePapers(allScored);

  // 4. 排序并精选
  translatedPapers.sort((a, b) => b.score - a.score);
  const topPapers = translatedPapers.slice(0, domainConfig.topN);

  // 5. 生成报告
  console.log('\n📝 正在生成报告...');

  // 为单领域生成简化版报告
  const domainResult = { config: domainConfig, papers: topPapers };
  const markdown = generateMultiDomainMarkdown([domainResult]);
  const outputPath = join(OUTPUT_DIR, 'paper-digest.md');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf-8');

  console.log('\n' + '='.repeat(70));
  console.log('✅ 处理完成！');
  console.log(`📄 报告已保存: ${outputPath}`);
  console.log('='.repeat(70) + '\n');

  console.log(`  📚 ${domainConfig.name}: ${topPapers.length} 篇精选`);
  if (topPapers.length > 0) {
    console.log(`     Top 1: ${topPapers[0].chineseTitle.slice(0, 50)}... ⭐ ${topPapers[0].score}`);
  }
  console.log('');
}

// 多领域模式
async function runMultiDomainMode(userConfig: UserConfig, domains: string[]) {
  const domainConfigs: DomainConfig[] = [];

  // 为每个领域配置
  for (const domainKey of domains) {
    const config = await configureSingleDomain(userConfig, domainKey);
    domainConfigs.push(config);
  }

  // 总确认
  console.log('\n' + '='.repeat(60));
  console.log('📋 完整配置确认：\n');
  for (const cfg of domainConfigs) {
    console.log(`  📚 ${cfg.name}`);
    console.log(`     数据源: ${[
      cfg.sources.arxiv && 'arXiv',
      cfg.sources.conference && `顶会${cfg.conferenceYear ? ` (${cfg.conferenceYear}年)` : ''}`,
      cfg.sources.journal && '顶刊'
    ].filter(Boolean).join(', ') || '无'}`);
    if (cfg.sources.arxiv || cfg.sources.journal) {
      console.log(`     时间范围: ${TIME_OPTIONS.find(t => t.hours === cfg.hours)?.label}`);
    }
    console.log(`     精选数量: ${cfg.topN} 篇`);
    console.log('');
  }
  console.log('='.repeat(60) + '\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await askQuestion(rl, '确认开始抓取? (Y/n): ');
  rl.close();

  if (confirm.toLowerCase() === 'n') {
    console.log('❌ 已取消');
    process.exit(0);
  }

  // 开始处理
  console.log('\n' + '='.repeat(70));
  console.log('🚀 开始多领域论文抓取与评分');
  console.log('='.repeat(70) + '\n');

  const domainResults: { config: DomainConfig; papers: ScoredPaper[] }[] = [];

  // 逐个领域处理
  for (const config of domainConfigs) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📚 正在处理领域: ${config.name}`);
    console.log('─'.repeat(70) + '\n');

    // 1. 抓取该领域的论文
    let papers: ArxivPaper[] = [];

    if (config.sources.arxiv) {
      console.log(`📡 抓取 arXiv...`);
      const arxivPapers = await fetchArxivPapers(config.categories, config.hours);
      papers = [...papers, ...arxivPapers];
    }

    if (config.sources.conference) {
      console.log(`📡 抓取顶会...`);
      const confPapers = await fetchConferencePapers(config.key, config.hours, config.conferenceYear);
      papers = [...papers, ...confPapers];
    }

    if (config.sources.journal) {
      console.log(`📡 抓取顶刊...`);
      const jourPapers = await fetchJournalPapers(config.key, config.hours);
      papers = [...papers, ...jourPapers];
    }

    console.log(`\n✅ ${config.name}: 共抓取 ${papers.length} 篇论文\n`);

    if (papers.length === 0) {
      console.log(`⚠️ ${config.name}: 未抓取到论文，跳过`);
      continue;
    }

    // 2. AI 评分
    console.log(`🤖 正在对 ${config.name} 的论文进行 AI 评分...`);
    const batches: ArxivPaper[][] = [];
    for (let i = 0; i < papers.length; i += BATCH_SIZE) {
      batches.push(papers.slice(i, i + BATCH_SIZE));
    }

    const allScored: ScoredPaper[] = [];
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const batchGroup = batches.slice(i, i + MAX_CONCURRENT);
      console.log(`  评分进度: ${Math.min(i + MAX_CONCURRENT, batches.length)}/${batches.length} 批次`);
      const results = await Promise.all(batchGroup.map(batch => scoreBatchWithAI(batch)));
      allScored.push(...results.flat());
      if (i + MAX_CONCURRENT < batches.length) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCH));
      }
    }

    // 3. 翻译
    console.log('  🌐 翻译标题和摘要...');
    const translatedPapers = await translatePapers(allScored);

    // 4. 排序并精选
    translatedPapers.sort((a, b) => b.score - a.score);
    const topPapers = translatedPapers.slice(0, config.topN);

    domainResults.push({ config, papers: topPapers });

    console.log(`✅ ${config.name}: 完成，精选 ${topPapers.length} 篇\n`);
  }

  // 5. 生成多领域报告
  console.log('\n📝 正在生成多领域综合报告...');
  const markdown = generateMultiDomainMarkdown(domainResults);
  const outputPath = join(OUTPUT_DIR, 'paper-digest.md');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf-8');

  console.log('\n' + '='.repeat(70));
  console.log('✅ 所有领域处理完成！');
  console.log(`📄 报告已保存: ${outputPath}`);
  console.log('='.repeat(70) + '\n');

  // 打印各领域统计
  for (const { config, papers } of domainResults) {
    console.log(`  📚 ${config.name}: ${papers.length} 篇精选`);
    if (papers.length > 0) {
      console.log(`     Top 1: ${papers[0].chineseTitle.slice(0, 50)}... ⭐ ${papers[0].score}`);
    }
  }
  console.log('');
}

// 统一配置模式 (旧版)
async function runUnifiedMode(userConfig: UserConfig) {
  const interactiveConfig = await interactiveMode(userConfig);
  const selectedDomains = interactiveConfig.domains;
  const sources = interactiveConfig.sources;
  const conferenceYear = interactiveConfig.conferenceYear;

  const config = {
    hours: interactiveConfig.hours,
    topN: userConfig.defaultTopN,
    categoryTopN: Math.ceil(userConfig.defaultTopN / 2),
    categories: interactiveConfig.categories,
    domain: selectedDomains.length > 1 ? 'custom' : selectedDomains[0],
    lang: 'zh',
    output: join(OUTPUT_DIR, 'paper-digest.md'),
  };

  // 1. 抓取论文
  let papers: ArxivPaper[] = [];
  let conferencePapers: ArxivPaper[] = [];
  let journalPapers: ArxivPaper[] = [];

  if (sources.arxiv) {
    papers = await fetchArxivPapers(config.categories, config.hours);
  }

  if (sources.conference) {
    for (const domain of selectedDomains) {
      const confPapers = await fetchConferencePapers(domain, config.hours, conferenceYear);
      conferencePapers = [...conferencePapers, ...confPapers];
    }
    papers = [...papers, ...conferencePapers];
  }

  if (sources.journal) {
    for (const domain of selectedDomains) {
      const jourPapers = await fetchJournalPapers(domain, config.hours);
      journalPapers = [...journalPapers, ...jourPapers];
    }
    papers = [...papers, ...journalPapers];
  }

  console.log(`\n📊 共抓取 ${papers.length} 篇论文\n`);

  if (papers.length === 0) {
    console.log('❌ 未找到符合条件的论文');
    process.exit(1);
  }

  // 2. AI 评分
  console.log(`🤖 正在批量 AI 评分...\n`);
  const batches: ArxivPaper[][] = [];
  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    batches.push(papers.slice(i, i + BATCH_SIZE));
  }

  const allScored: ScoredPaper[] = [];
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT);
    console.log(`  评分进度: ${Math.min(i + MAX_CONCURRENT, batches.length)}/${batches.length} 批次`);
    const results = await Promise.all(batchGroup.map(batch => scoreBatchWithAI(batch)));
    allScored.push(...results.flat());
    if (i + MAX_CONCURRENT < batches.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCH));
    }
  }

  // 3. 翻译
  const translatedPapers = await translatePapers(allScored);

  // 4. 分类排名 + 总排名
  console.log('\n📊 正在排序...');
  const byCategory = new Map<string, ScoredPaper[]>();
  for (const cat of config.categories) {
    byCategory.set(cat, []);
  }

  for (const p of translatedPapers) {
    const primaryCat = p.categories.find(c => config.categories.includes(c)) || config.categories[0];
    const catPapers = byCategory.get(primaryCat) || [];
    catPapers.push(p);
    byCategory.set(primaryCat, catPapers);
  }

  const categoryTopPapers = new Map<string, ScoredPaper[]>();
  for (const [cat, catPapers] of byCategory) {
    catPapers.sort((a, b) => b.score - a.score);
    categoryTopPapers.set(cat, catPapers.slice(0, config.categoryTopN));
  }

  translatedPapers.sort((a, b) => b.score - a.score);
  const topPapers = translatedPapers.slice(0, config.topN);

  // 5. 生成报告
  console.log('\n📝 正在生成报告...');
  const markdown = generateMarkdown(topPapers, categoryTopPapers, config);
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(config.output, markdown, 'utf-8');

  console.log(`\n✅ 完成! 报告已保存至: ${config.output}`);
}

// 命令行模式
async function runCommandLineMode(args: string[]) {
  const config = parseArgs();
  const selectedDomains = [config.domain];

  // 1. 抓取论文
  let papers: ArxivPaper[] = [];

  if (true) { // arxiv
    papers = await fetchArxivPapers(config.categories, config.hours);
  }

  console.log(`\n📊 共抓取 ${papers.length} 篇论文\n`);

  if (papers.length === 0) {
    console.log('❌ 未找到符合条件的论文');
    process.exit(1);
  }

  // 2. AI 评分
  console.log(`🤖 正在批量 AI 评分...\n`);
  const batches: ArxivPaper[][] = [];
  for (let i = 0; i < papers.length; i += BATCH_SIZE) {
    batches.push(papers.slice(i, i + BATCH_SIZE));
  }

  const allScored: ScoredPaper[] = [];
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT);
    console.log(`  评分进度: ${Math.min(i + MAX_CONCURRENT, batches.length)}/${batches.length} 批次`);
    const results = await Promise.all(batchGroup.map(batch => scoreBatchWithAI(batch)));
    allScored.push(...results.flat());
    if (i + MAX_CONCURRENT < batches.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCH));
    }
  }

  // 3. 翻译
  const translatedPapers = await translatePapers(allScored);

  // 4. 排序
  console.log('\n📊 正在排序...');
  const byCategory = new Map<string, ScoredPaper[]>();
  for (const cat of config.categories) {
    byCategory.set(cat, []);
  }

  for (const p of translatedPapers) {
    const primaryCat = p.categories.find(c => config.categories.includes(c)) || config.categories[0];
    const catPapers = byCategory.get(primaryCat) || [];
    catPapers.push(p);
    byCategory.set(primaryCat, catPapers);
  }

  const categoryTopPapers = new Map<string, ScoredPaper[]>();
  for (const [cat, catPapers] of byCategory) {
    catPapers.sort((a, b) => b.score - a.score);
    categoryTopPapers.set(cat, catPapers.slice(0, config.categoryTopN));
  }

  translatedPapers.sort((a, b) => b.score - a.score);
  const topPapers = translatedPapers.slice(0, config.topN);

  // 5. 生成报告
  console.log('\n📝 正在生成报告...');
  const markdown = generateMarkdown(topPapers, categoryTopPapers, config);
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(config.output, markdown, 'utf-8');

  console.log(`\n✅ 完成! 报告已保存至: ${config.output}`);
}

main().catch(console.error);
