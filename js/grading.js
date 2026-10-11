/*!
 * grading.js —— 高联智能提分系统 · AI 批改引擎
 *
 * 纯前端、零依赖（仅用浏览器原生 fetch），直接 <script src="js/grading.js"></script> 引入。
 * 对外暴露全局对象 window.Grading：
 *   - Grading.buildRecognizePrompt()                          手写解答 OCR 识别提示词
 *   - Grading.buildRubricPrompt(problemText, fullScore, step) 评分标准生成提示词
 *   - Grading.buildGradePrompt(problemText, rubric, studentSolution, fullScore) 批改提示词
 *   - Grading.grade(options)                                  异步 AI 批改（OpenAI 兼容接口）
 *   - Grading.localGrade(problemText, studentSolution, fullScore) 无 API 本地兜底批改
 *   - Grading.listModels()                                    常用模型列表
 *
 * 评分风格源自高联二试真实阅卷实践：
 *   - 从「逻辑链条」给分，而非看写了多少字；
 *   - 最高档要求初等方法、逻辑自含；超纲工具/未推导的现成结论降档。
 */
(function (global) {
  'use strict';

  /* ============================ 默认配置 ============================ */

  var DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
  var DEFAULT_MODEL = 'deepseek-chat';

  /** 常见可选模型（含 baseUrl），供前端下拉选择 */
  var MODELS = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', baseUrl: 'https://api.deepseek.com/v1', recommend: true },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'qwen-plus', name: '通义千问 Plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'qwen-max', name: '通义千问 Max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'glm-4-plus', name: '智谱 GLM-4-Plus', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'moonshot-v1-8k', name: 'Kimi Moonshot v1', baseUrl: 'https://api.moonshot.cn/v1' },
    { id: 'gpt-4o-mini', name: 'OpenAI GPT-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    { id: 'gpt-4o', name: 'OpenAI GPT-4o', baseUrl: 'https://api.openai.com/v1' }
  ];

  /* ============================ 提示词构建 ============================ */

  /**
   * 图片转文字识别提示词（手写解答 OCR）。
   * @returns {string} 识别提示词
   */
  function buildRecognizePrompt() {
    return '你是中国数学奥林匹克（高联）二试试卷数字化助手。任务：把图片中的试题题面与学生手写解答精确转录为文字。' +
      '要求：' +
      '1) 数学式一律用 LaTeX（行内 $...$，行间 $$...$$）；' +
      '2) 学生解答按原有步骤顺序逐条转录，保留原有记号；完全空白则 solution 为空字符串；' +
      '3) 手写潦草、无法确认的字符用 (?) 标注，绝不臆造内容；' +
      '4) problem_type 从 代数/几何/数论/组合 中选一个。' +
      '只输出 JSON，不要任何解释文字。' +
      '输出格式：{"problem":"题面转录","solution":"学生解答逐步转录","problem_type":"代数/几何/数论/组合"}';
  }

  /**
   * 评分标准生成提示词。
   * @param {string} problemText 题干
   * @param {number} fullScore   满分（默认 20）
   * @param {number} [step=5]    档距（每档分值），默认 5 分
   * @returns {string} 提示词
   */
  function buildRubricPrompt(problemText, fullScore, step) {
    fullScore = numOr(fullScore, 20);
    step = numOr(step, fullScore >= 40 ? 10 : 5);
    if (step <= 0) step = 5;
    var tiers = Math.floor(fullScore / step) + 1;
    return '你是中国数学奥林匹克（高联）二试阅卷组长，请按官方阅卷风格为该题制定评分标准。' +
      '【题目】' + (problemText || '（题干缺失）') + '\n' +
      '【满分】' + fullScore + ' 分，每档间距 ' + step + ' 分（分数只能是 ' + fullScore + ',' +
      (fullScore - step) + ',…,0 共 ' + tiers + ' 档）。' +
      '【要求】' +
      '1) 逐档给出得分条件，从满分档到 0 分档；' +
      '2) 满分档必须满足「初等方法、逻辑自含」——核心步骤直接引用未推导的现成结论（如勾股数通解公式、经典强不等式模板）或使用超纲工具（Jensen、求导证不等式等）的不属于满分档；' +
      '3) 主体思路成立但存在关键缺口（未证存在性/唯一性、情形遗漏、核心引理未证）应降一档；仅转述题意或方向错误给 0 分；' +
      '4) 列出 3~6 个关键采分点（key_points）。' +
      '只输出 JSON，不要解释文字。' +
      '输出格式：{"problem_type":"代数/几何/数论/组合","full_score":' + fullScore +
      ',"tiers":[{"score":' + fullScore + ',"desc":"得满分条件"},…],"key_points":["采分点1","采分点2"]}';
  }

  /**
   * 批改提示词（核心理念：按逻辑链给分）。
   * @param {string} problemText     题干
   * @param {Object|string} rubric   评分标准（对象或已是文本）
   * @param {string} studentSolution 学生解答
   * @param {number} fullScore       满分
   * @returns {string} 提示词
   */
  function buildGradePrompt(problemText, rubric, studentSolution, fullScore) {
    fullScore = numOr(fullScore, 20);
    var rubricText = typeof rubric === 'string' ? rubric : (rubric ? JSON.stringify(rubric) : '（未提供评分标准，请自行按满分 ' + fullScore + ' 分制定）');
    var sol = (studentSolution || '').trim();
    if (!sol) sol = '（学生未作答）';
    return '你是高联二试阅卷专家，评分尺度参照《百题精选》做题记录的批改实践：从解答的【逻辑关系】给分。' +
      '【题目】' + (problemText || '（题干缺失）') + '\n' +
      '【评分标准】' + rubricText + '\n' +
      '【学生解答】' + sol + '\n' +
      '【满分】' + fullScore + ' 分。\n' +
      '【批改方法】把学生解答拆成逻辑链条——①问题转化/目标等价变形 → ②关键观察或引理 → ③主体推证（每一环节是否真正作为后续推理的依据成立）→ ④结论的最终得出，逐环节核实「这一步的依据是否已被证明」，而不是看写了多少字。\n' +
      '【典型逻辑缺口（发现即降档）】直接断言而未证（如断言最值/极值点/存在性/唯一性却无证明）；用特例代替一般论证；循环论证；情形分类遗漏；所引定理前提未验证；记号或对象与所证命题不符；关键构造只描述未验证。\n' +
      '【尺度规则】' +
      '1) 核心方法使用竞赛不允许的超纲工具（如直接引用 Jensen 不等式、求导/微积分证不等式），或所选路线本质走不通 → 直接 0 分档，不给过程分；' +
      '2) 核心步骤直接引用未推导的现成结论/通解公式而题目要求自含证明 → 该环节视为未建立，最高只给最低非零档；' +
      '3) 竞赛几何默认使用有向角（mod 180°）：由圆周角、弦切角得出的「角相等或互补」在有向角意义下合法，不得以「可能互补」判错；' +
      '4) 手写转录可能有识别误差：若疑点更像笔误且学生思路自洽，按思路主体给分，把疑点写进 suggestions（前缀✎）而不扣档；' +
      '5) 几何题导角与计算链条整体自洽且结论正确即为完整逻辑链，给满分档；' +
      '6) 未作答则 score=0 并在 suggestions 注明「未作答」。\n' +
      '【输出要求】只输出 JSON，不要任何解释文字。格式：' +
      '{"score":整数,"maxScore":' + fullScore + ',' +
      '"breakdown":[{"point":"采分点/环节","got":得分,"full":该点满分,"comment":"说明"}],' +
      '"logicChain":[{"step":"逻辑环节描述","ok":true或false,"comment":"依据是否成立"}],' +
      '"suggestions":["改进建议1","改进建议2"]}' +
      '。score 必须为评分标准允许的整档分数，且 breakdown 的 got 之和应等于 score。';
  }

  /* ============================ 工具函数 ============================ */

  function numOr(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }

  function clampNum(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /** 四舍五入到指定小数位 */
  function round(x, d) { var f = Math.pow(10, d || 0); return Math.round(x * f) / f; }

  /**
   * 从模型返回文本中稳健提取 JSON 对象。
   * 优先直接 JSON.parse；失败则剥离 ```json 代码块；再失败用花括号配对 + 正则兜底。
   * @param {string} text
   * @returns {Object|null}
   */
  function extractJSON(text) {
    if (!text || typeof text !== 'string') return null;
    var t = text.trim();

    // 1) 直接解析
    try { return JSON.parse(t); } catch (e) { /* continue */ }

    // 2) 去掉 markdown 代码围栏
    var fence = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(fence); } catch (e) { /* continue */ }

    // 3) 花括号配对截取第一个完整对象
    var start = fence.indexOf('{');
    if (start >= 0) {
      var depth = 0, inStr = false, esc = false, end = -1;
      for (var i = start; i < fence.length; i++) {
        var c = fence[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else {
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
      }
      if (end > start) {
        var sliced = fence.slice(start, end + 1);
        try { return JSON.parse(sliced); } catch (e2) {
          // 4) 正则兜底：修复常见问题（尾逗号、中文引号、单引号）
          var fixed = sliced
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u2018\u2019]/g, "'");
          try { return JSON.parse(fixed); } catch (e3) { /* fallthrough */ }
        }
      }
    }

    // 5) 极端兜底：正则分别抓取 score 与 suggestions
    var m = t.match(/"score"\s*:\s*(-?\d+(?:\.\d+)?)/);
    if (m) return { score: parseFloat(m[1]), _partial: true };
    return null;
  }

  /** 规范化批改结果为统一结构 */
  function normalizeResult(obj, fullScore) {
    fullScore = numOr(fullScore, 20);
    obj = obj || {};
    var score = numOr(obj.score, 0);
    score = clampNum(score, 0, fullScore);

    var breakdown = Array.isArray(obj.breakdown) ? obj.breakdown.map(function (b) {
      b = b || {};
      return {
        point: String(b.point || b.name || ''),
        got: numOr(b.got, numOr(b.score, 0)),
        full: numOr(b.full, numOr(b.max, 0)),
        comment: String(b.comment || '')
      };
    }) : [];

    var logicChain = Array.isArray(obj.logicChain) ? obj.logicChain.map(function (s) {
      s = s || {};
      return {
        step: String(s.step || s.name || ''),
        ok: s.ok === true || s.ok === 'true',
        comment: String(s.comment || s.reason || '')
      };
    }) : [];

    var suggestions = [];
    if (Array.isArray(obj.suggestions)) {
      suggestions = obj.suggestions.map(function (s) { return String(s); });
    } else if (typeof obj.suggestions === 'string') {
      suggestions = [obj.suggestions];
    }
    if (obj.summary) suggestions.unshift(String(obj.summary));

    return {
      score: round(score, 1),
      maxScore: fullScore,
      breakdown: breakdown,
      logicChain: logicChain,
      suggestions: suggestions,
      raw: obj
    };
  }

  /* ============================ AI 批改主函数 ============================ */

  /**
   * 调用 OpenAI 兼容接口进行批改。
   * @param {Object} options
   * @param {string}  options.apiKey           API Key（必填）
   * @param {string}  [options.baseUrl]        接口前缀，默认 https://api.deepseek.com/v1
   * @param {string}  [options.model]          模型名，默认 deepseek-chat
   * @param {string}  options.problemText      题干
   * @param {Object|string} [options.rubric]   评分标准
   * @param {string}  options.studentSolution  学生解答
   * @param {number}  [options.fullScore=20]   满分
   * @param {Function}[options.onProgress]     进度回调 (stage, info)
   * @param {number}  [options.timeout=60000]  超时毫秒
   * @returns {Promise<Object>} {score,maxScore,breakdown,logicChain,suggestions,raw,mode:'ai'}
   */
  function grade(options) {
    options = options || {};
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};

    return new Promise(function (resolve, reject) {
      if (!options.apiKey) { reject(makeErr('缺少 API Key，请在设置中填写。')); return; }
      if (typeof fetch !== 'function') { reject(makeErr('当前环境不支持 fetch，无法调用 AI 接口。')); return; }

      var baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
      var model = options.model || DEFAULT_MODEL;
      var fullScore = numOr(options.fullScore, 20);
      var rubric = options.rubric;
      var prompt;

      // 若未提供 rubric，先用 rubric 提示词让模型自建（两步式）；这里直接合并进批改提示词，
      // 单次请求即可同时生成标准并批改，降低成本与延迟。
      onProgress('prepare', '正在构建批改提示词…');
      prompt = buildGradePrompt(options.problemText, rubric, options.studentSolution, fullScore);

      var url = baseUrl + '/chat/completions';
      var body = {
        model: model,
        messages: [
          { role: 'system', content: '你是严谨的高联二试阅卷专家，严格按逻辑链给分，只输出 JSON。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      };

      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, numOr(options.timeout, 60000));

      onProgress('request', '正在请求 ' + model + ' …');

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + options.apiKey
        },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (txt) {
            throw makeErr('接口返回错误 ' + resp.status + '：' + (txt || '').slice(0, 300));
          });
        }
        return resp.json();
      }).then(function (data) {
        clearTimeout(timer);
        onProgress('parse', '正在解析批改结果…');
        var content = '';
        try {
          content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        } catch (e) { content = ''; }
        if (!content) throw makeErr('模型返回内容为空，请检查模型或额度。');
        var obj = extractJSON(content);
        if (!obj) throw makeErr('无法从模型返回中解析出 JSON 结果。原始内容：' + content.slice(0, 300));
        var result = normalizeResult(obj, fullScore);
        result.mode = 'ai';
        result.model = model;
        onProgress('done', '批改完成');
        resolve(result);
      }).catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') { reject(makeErr('请求超时，请检查网络后重试。')); return; }
        if (err && err.message && err.message.indexOf('接口返回错误') === 0) { reject(err); return; }
        if (err && err.__readable) { reject(err); return; }
        reject(makeErr('网络请求失败：' + (err && err.message ? err.message : String(err))));
      });
    });
  }

  function makeErr(msg) {
    var e = new Error(msg);
    e.__readable = true;
    return e;
  }

  /* ============================ 本地兜底批改 ============================ */

  var LOGIC_WORDS = ['证明', '因为', '所以', '故', '因此', '设', '令', '由', '从而', '即可得', '于是', '⇒', '⟹', '若', '则'];
  var CONCLUSION_WORDS = ['证毕', '得证', '成立', '结论', '□', '∎', '综上', '完毕'];
  var MATH_STRONG = ['$$', '\\sum', '\\int', '\\prod', '\\frac', '\\sqrt'];

  /**
   * 无 API 时的启发式本地批改。返回结构与 grade 一致，mode='local'。
   * 评分维度：解答长度、逻辑连接词密度、关键对象覆盖、结论句、数学式规范。
   * @param {string} problemText     题干
   * @param {string} studentSolution 学生解答
   * @param {number} [fullScore=20]  满分
   * @returns {Object}
   */
  function localGrade(problemText, studentSolution, fullScore) {
    fullScore = numOr(fullScore, 20);
    var sol = (studentSolution || '').trim();
    var breakdown = [];
    var logicChain = [];
    var suggestions = [];

    if (!sol) {
      return {
        score: 0,
        maxScore: fullScore,
        breakdown: [],
        logicChain: [{ step: '未作答', ok: false, comment: '学生未提交解答。' }],
        suggestions: ['未作答：请先独立完成解答再提交批改。'],
        raw: null,
        mode: 'local'
      };
    }

    // 1) 篇幅分（占 25%）
    var len = sol.length;
    var lenRatio = clampNum(len / 400, 0, 1);
    breakdown.push({
      point: '解答完整度（篇幅）',
      got: round(fullScore * 0.25 * lenRatio, 1),
      full: round(fullScore * 0.25, 1),
      comment: len < 60 ? '解答过短，论证可能不充分。' : (len < 250 ? '篇幅中等，注意补全关键论证。' : '篇幅充分。')
    });

    // 2) 逻辑连接词密度（占 30%）
    var logicHits = countHits(sol, LOGIC_WORDS);
    var logicRatio = clampNum(logicHits / 6, 0, 1);
    breakdown.push({
      point: '逻辑链条与推理依据',
      got: round(fullScore * 0.30 * logicRatio, 1),
      full: round(fullScore * 0.30, 1),
      comment: logicHits >= 6 ? '推理连接词充分，逻辑链较完整。'
        : (logicHits >= 3 ? '有一定推理过程，但关键「因为/所以」链可能不足。' : '几乎无推理连接词，逻辑链严重缺失。')
    });
    logicChain.push({ step: '推理连接词检测', ok: logicHits >= 3, comment: '命中推理词 ' + logicHits + ' 处。' });

    // 3) 关键对象覆盖（占 25%）：题干中的变量/记号是否在解答里出现
    var tokens = extractTokens(problemText);
    var covered = 0;
    for (var i = 0; i < tokens.length; i++) { if (sol.indexOf(tokens[i]) >= 0) covered++; }
    var coverRatio = tokens.length ? clampNum(covered / tokens.length, 0, 1) : 0.6;
    breakdown.push({
      point: '关键对象与条件覆盖',
      got: round(fullScore * 0.25 * coverRatio, 1),
      full: round(fullScore * 0.25, 1),
      comment: '题干关键记号覆盖 ' + covered + '/' + tokens.length + '。'
    });
    logicChain.push({ step: '关键对象覆盖', ok: coverRatio >= 0.6, comment: '覆盖比例 ' + round(coverRatio * 100) + '%。' });

    // 4) 结论与数学规范（占 20%）
    var hasConcl = countHits(sol, CONCLUSION_WORDS) > 0;
    var hasMath = hasAny(sol, MATH_STRONG) || sol.indexOf('$') >= 0;
    breakdown.push({
      point: '结论句与数学式规范',
      got: round(fullScore * 0.20 * ((hasConcl ? 0.6 : 0) + (hasMath ? 0.4 : 0)), 1),
      full: round(fullScore * 0.20, 1),
      comment: (hasConcl ? '有明确结论。' : '缺少明确结论句（如「证毕/得证」）。')
        + (hasMath ? '数学式规范。' : '建议用 LaTeX 规范书写数学式。')
    });
    logicChain.push({ step: '结论得出', ok: hasConcl, comment: hasConcl ? '给出明确结论。' : '未明确给出结论。' });

    var score = 0;
    for (var b = 0; b < breakdown.length; b++) score += breakdown[b].got;
    score = clampNum(round(score, 1), 0, fullScore);

    suggestions.push('本地批改仅依据文本特征估算，结果仅供参考；配置 API Key 可获得基于逻辑链的精准批改。');
    if (len < 60) suggestions.push('解答过短，请补充关键推导步骤。');
    if (logicHits < 3) suggestions.push('缺少推理连接词，务必写清每一步的依据（因为/所以/由…得）。');
    if (!hasConcl) suggestions.push('解答末尾应给出明确结论，回扣题目所求。');
    if (!hasMath) suggestions.push('数学式建议使用 LaTeX（$...$）书写，便于阅卷识别。');

    return {
      score: score,
      maxScore: fullScore,
      breakdown: breakdown,
      logicChain: logicChain,
      suggestions: suggestions,
      raw: null,
      mode: 'local'
    };
  }

  /** 统计一组关键词在文本中的命中种类数 */
  function countHits(text, words) {
    var n = 0;
    for (var i = 0; i < words.length; i++) { if (text.indexOf(words[i]) >= 0) n++; }
    return n;
  }

  function hasAny(text, words) {
    for (var i = 0; i < words.length; i++) { if (text.indexOf(words[i]) >= 0) return true; }
    return false;
  }

  /**
   * 从题干中提取关键记号（变量名、LaTeX 命令、参数符号），用于覆盖度检测。
   * @param {string} text
   * @returns {string[]}
   */
  function extractTokens(text) {
    text = text || '';
    var set = {};
    // 单个字母变量（a-z A-Z，排除常见无意义词）
    var m1 = text.match(/[a-zA-Z]/g) || [];
    for (var i = 0; i < m1.length; i++) set[m1[i]] = true;
    // 带下标的记号如 a_1, x_{n}
    var m2 = text.match(/[a-zA-Z]_\{?[a-zA-Z0-9]+\}?/g) || [];
    for (var j = 0; j < m2.length; j++) set[m2[j]] = true;
    // 希腊字母与常见命令
    var m3 = text.match(/\\(?:alpha|beta|gamma|theta|lambda|mu|pi|sigma|varphi|epsilon)/g) || [];
    for (var k = 0; k < m3.length; k++) set[m3[k]] = true;
    var out = [];
    for (var t in set) if (Object.prototype.hasOwnProperty.call(set, t)) out.push(t);
    return out.slice(0, 30);
  }

  /* ============================== 导出 ============================== */

  var Grading = {
    buildRecognizePrompt: buildRecognizePrompt,
    buildRubricPrompt: buildRubricPrompt,
    buildGradePrompt: buildGradePrompt,
    grade: grade,
    localGrade: localGrade,
    listModels: function () { return MODELS.slice(); },
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    DEFAULT_MODEL: DEFAULT_MODEL,
    _internal: { extractJSON: extractJSON, normalizeResult: normalizeResult, extractTokens: extractTokens }
  };

  global.Grading = Grading;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Grading;
  }
})(typeof window !== 'undefined' ? window : this);
