/*!
 * diagnosis.js —— 高联智能提分系统 · 薄弱点诊断与精准推题引擎
 *
 * 纯前端、零依赖，直接 <script src="js/diagnosis.js"></script> 引入即可。
 * 对外暴露全局对象 window.Diagnosis：
 *   - Diagnosis.analyze(records, problems)             诊断掌握度、薄弱点、雷达图、建议
 *   - Diagnosis.recommend(records, problems, options)  按策略精准推题
 *   - Diagnosis.computeMastery(records, problems)      掌握度计算（可单独调用）
 *   - Diagnosis.levelOf(rate)                          掌握度分级辅助
 *
 * 数据约定：
 *   record  : {problemId, score, fullScore, correct, timeSpent, timestamp}
 *   problem : {id, module, knowledgePoints:[], difficulty:1-5, question, solution, ...}
 *
 * 数值约定：所有对外输出的 accuracy / scoreRate / mastery 字段均为 0~100 的百分数；
 *          levelOf(rate) 接收的 rate 为 0~1 的小数（仅内部计算使用）。
 */
(function (global) {
  'use strict';

  /* ============================ 常量与工具 ============================ */

  /** 模块固定顺序，保证雷达图/输出的键序稳定 */
  var MODULES = ['代数', '几何', '数论', '组合'];
  // 二试四大模块（雷达图主轴）；一试的其他模块归并进来参与统计
  var RADAR_AXES = ['代数', '几何', '数论', '组合'];
  var MODULE_GROUP = {
    '代数': '代数', '函数': '代数', '不等式': '代数', '数列': '代数', '复数': '代数', '三角': '代数',
    '几何': '几何', '立体几何': '几何', '解析几何': '几何',
    '数论': '数论',
    '组合': '组合', '概率统计': '组合',
  };
  /** 动态获取题库中出现的所有模块 */
  function allModules(problems) {
    var set = {};
    (problems || []).forEach(function (p) { if (p && p.module) set[p.module] = 1; });
    // 保证四大模块在前
    var order = MODULES.slice();
    Object.keys(set).forEach(function (m) { if (order.indexOf(m) < 0) order.push(m); });
    return order;
  }

  /** 题量置信度参数：题量达到 CONF_SAT 时完全信任实测值，不足则向 50% 回归 */
  var CONF_BASE = 2;   // 等效先验题量
  var CONF_SAT = 8;    // 饱和题量

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function round1(x) { return Math.round(x * 10) / 10; }

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /**
   * 掌握度分级（依据正确率）。
   * @param {number|null} rate 正确率，可传 0~100 百分数（或 0~1 小数，自动识别）
   * @returns {{i:number, t:string}} i=级序(0未练/1薄弱/2待提升/3较好/4优秀)，t=名称
   */
  function levelOf(rate) {
    if (rate === null || rate === undefined || isNaN(rate)) return { i: 0, t: '未练' };
    if (rate > 0 && rate <= 1) rate = rate * 100;   // 兼容 0~1 小数输入
    var r = clamp(rate, 0, 100);
    if (r < 50) return { i: 1, t: '薄弱' };
    if (r < 70) return { i: 2, t: '待提升' };
    if (r < 90) return { i: 3, t: '较好' };
    return { i: 4, t: '优秀' };
  }

  /** 取非空数值的平均值 */
  function avg(arr) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
      if (isNum(arr[i])) { s += arr[i]; n++; }
    }
    return n ? s / n : 0;
  }

  /** 由题库构建 id -> problem 索引（带缓存） */
  var _indexCache = { ref: null, len: -1, map: null };
  function buildIndex(problems) {
    if (!Array.isArray(problems)) return {};
    if (_indexCache.ref === problems && _indexCache.len === problems.length) return _indexCache.map;
    var map = {};
    for (var i = 0; i < problems.length; i++) {
      var p = problems[i];
      if (p && p.id !== undefined && p.id !== null) map[p.id] = p;
    }
    _indexCache = { ref: problems, len: problems.length, map: map };
    return map;
  }

  /** 规范化题目对象，兼容字符串与别名字段 */
  function normProblem(p) {
    if (typeof p === 'string') return { id: p, module: '', knowledgePoints: [], difficulty: 3 };
    p = p || {};
    var kps = p.knowledgePoints || p.kps || p.knowledge || [];
    if (typeof kps === 'string') kps = [kps];
    return {
      id: p.id,
      module: p.module || '',
      knowledgePoints: Array.isArray(kps) ? kps : [],
      difficulty: isNum(p.difficulty) ? p.difficulty : 3,
      type: p.type || '',
      question: p.question || '',
      solution: p.solution || '',
      source: p.source || '',
      paper: p.paper || '',
      scanPage: p.scanPage,
      year: p.year
    };
  }

  /* ======================= 掌握度/统计核心计算 ======================= */

  /**
   * 计算一组做题记录的综合指标（内部均为 0~1 小数）。
   * 综合掌握度公式：mastery = 实测掌握 * 置信度 + 50% * (1 - 置信度)
   *   实测掌握 = 正确率 * 0.6 + 得分率 * 0.4
   *   置信度   = min(1, max(0, n - CONF_BASE) / CONF_SAT)
   * 题量越少越向 50% 回归，避免「做 1 题全对 = 优秀」的误判。
   * @param {Array} recs 同一分组的记录
   * @returns {{done:number, correct:number, accuracy:number, scoreRate:number, mastery:number, level:string}}
   */
  /**
   * 知识点输出对象：统一 0~100 百分数，并补齐前端渲染所需字段。
   * @param {Object} k 内部 kpStats 项（accuracy/mastery 均为 0~100）
   * @param {string} [reason] 可选的诊断说明
   */
  function kpOut(k, reason) {
    var lv = levelOf(k.accuracy);
    var o = {
      kp: k.kp,
      module: k.module,
      done: k.done,
      correct: k.correct,
      accuracy: Math.round(k.accuracy),
      scoreRate: Math.round(k.scoreRate || 0),
      mastery: Math.round(k.mastery),
      level: k.level,
      levelIndex: lv.i
    };
    if (reason) o.reason = reason;
    return o;
  }

  function groupStat(recs) {
    var done = recs.length;
    var correctN = 0;
    var scoreSum = 0, fullSum = 0;
    for (var i = 0; i < done; i++) {
      var r = recs[i] || {};
      var full = isNum(r.fullScore) ? r.fullScore : 0;
      var sc = isNum(r.score) ? r.score : 0;
      // correct 字段优先；缺失时用 得分率 >= 0.6 兜底判定
      var ok = (typeof r.correct === 'boolean') ? r.correct : (full > 0 ? sc / full >= 0.6 : false);
      if (ok) correctN++;
      scoreSum += sc;
      fullSum += full;
    }
    var accuracy = done ? correctN / done : 0;
    var scoreRate = fullSum > 0 ? scoreSum / fullSum : accuracy;
    var raw = accuracy * 0.6 + scoreRate * 0.4;
    var conf = done <= CONF_BASE ? 0 : clamp((done - CONF_BASE) / CONF_SAT, 0, 1);
    var mastery = done === 0 ? 0 : clamp(raw * conf + 0.5 * (1 - conf), 0, 1);
    return {
      done: done,
      correct: correctN,
      accuracy: accuracy,
      scoreRate: scoreRate,
      mastery: mastery,
      level: done === 0 ? '未练' : levelOf(accuracy).t
    };
  }

  /**
   * 按知识点/模块聚合做题记录。
   * @returns {{byKp:Object, byModule:Object, total:number}}
   */
  function aggregate(records, problems) {
    var index = buildIndex(problems);
    var byKp = {};       // kp -> {module, recs:[]}
    var byModule = {};   // module -> recs:[]
    allModules(problems).forEach(function (m) { byModule[m] = []; });

    var list = Array.isArray(records) ? records : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      var pid = (r.problemId !== undefined) ? r.problemId : r.id;
      var prob = index[pid] ? normProblem(index[pid]) : null;
      if (!prob) continue; // 题库中找不到该题则忽略，避免污染统计
      if (!byModule[prob.module]) byModule[prob.module] = [];
      byModule[prob.module].push(r);
      var kps = prob.knowledgePoints.length ? prob.knowledgePoints : [(prob.module || '其它') + '综合'];
      for (var k = 0; k < kps.length; k++) {
        var kp = kps[k];
        if (!byKp[kp]) byKp[kp] = { module: prob.module, recs: [] };
        byKp[kp].recs.push(r);
      }
    }
    return { byKp: byKp, byModule: byModule, total: list.length };
  }

  /**
   * 计算逐知识点与逐模块的掌握度明细。
   * 输出数值均为 0~100 的百分数，供 UI 直接渲染。
   * @param {Array} records
   * @param {Array} problems
   * @returns {{moduleStats:Object, kpStats:Array}}
   */
  function computeMastery(records, problems) {
    var agg = aggregate(records, problems);

    var moduleStats = {};
    allModules(problems).forEach(function (mod) {
      var st = groupStat(agg.byModule[mod] || []);
      moduleStats[mod] = {
        done: st.done,
        correct: st.correct,
        accuracy: round1(st.accuracy * 100),
        avgScoreRate: round1(st.scoreRate * 100),
        mastery: round1(st.mastery * 100),
        level: st.level
      };
    });

    var kpStats = [];
    for (var kp in agg.byKp) {
      if (!Object.prototype.hasOwnProperty.call(agg.byKp, kp)) continue;
      var g = agg.byKp[kp];
      var s = groupStat(g.recs);
      kpStats.push({
        kp: kp,
        module: g.module,
        done: s.done,
        correct: s.correct,
        accuracy: round1(s.accuracy * 100),
        scoreRate: round1(s.scoreRate * 100),
        mastery: round1(s.mastery * 100),
        level: s.level
      });
    }
    // 稳定排序：掌握度升序 → 正确率升序 → 题量降序 → 名称
    kpStats.sort(function (a, b) {
      if (a.mastery !== b.mastery) return a.mastery - b.mastery;
      if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
      if (a.done !== b.done) return b.done - a.done;
      return a.kp < b.kp ? -1 : 1;
    });

    return { moduleStats: moduleStats, kpStats: kpStats };
  }

  /* ============================== 诊断主函数 ============================== */

  /**
   * 诊断整体学习情况。
   * @param {Array} records  做题记录数组
   * @param {Array} problems 题库数组
   * @returns {Object} 诊断结果（见文件头注释）
   */
  function analyze(records, problems) {
    var cm = computeMastery(records, problems);
    var moduleStats = cm.moduleStats;
    var kpStats = cm.kpStats;

    // 只对「练过」的知识点取薄弱/优势
    var practiced = kpStats.filter(function (k) { return k.done > 0; });
    var unpracticed = kpStats.filter(function (k) { return k.done === 0; });

    var weakPoints = practiced.slice(0, 5).map(function (k) {
      return kpOut(k, weakReason(k));
    });

    var strengths = practiced.slice().reverse().filter(function (k) {
      return k.accuracy >= 70 || k.level === '优秀' || k.level === '较好';
    }).slice(0, 5).map(function (k) {
      return kpOut(k);
    });

    // 雷达图：把各细模块按 MODULE_GROUP 归并到 4 大主轴（加权平均掌握度）
    var radar = {};
    var axisAcc = {}, axisN = {};
    RADAR_AXES.forEach(function (a) { axisAcc[a] = 0; axisN[a] = 0; radar[a] = 0; });
    Object.keys(moduleStats).forEach(function (m) {
      var axis = MODULE_GROUP[m] || '代数';
      var s = moduleStats[m];
      if (!RADAR_AXES[0] && RADAR_AXES.indexOf(axis) < 0) return;
      if (s.done > 0) { axisAcc[axis] += s.mastery * s.done; axisN[axis] += s.done; }
    });
    RADAR_AXES.forEach(function (a) {
      radar[a] = axisN[a] ? Math.round(axisAcc[a] / axisN[a]) : 0;
    });

    var overall = overallStat(records, moduleStats);
    var suggestions = buildSuggestions(weakPoints, moduleStats, overall, unpracticed, kpStats);

    return {
      moduleStats: moduleStats,
      kpStats: kpStats,
      weakPoints: weakPoints,
      strengths: strengths,
      radar: radar,
      overall: overall,
      suggestions: suggestions
    };
  }

  /** 单个薄弱知识点的原因描述（k.accuracy 为 0~100 百分数） */
  function weakReason(k) {
    var acc = Math.round(k.accuracy);
    if (k.done <= 2) return '练习量偏少（仅 ' + k.done + ' 题），数据不足，建议加练以准确评估';
    if (k.accuracy < 30) return '正确率仅 ' + acc + '%，基础方法未过手，建议回看方法模板再做同型题';
    if (k.accuracy < 50) return '正确率 ' + acc + '%，关键步骤常失分，建议专项突破典型题';
    if (k.accuracy < 70) return '正确率 ' + acc + '%，思路基本成型但稳定性不足，需强化细节与检验';
    return '正确率 ' + acc + '%，仍有提升空间';
  }

  /** 总体水平（全部返回 0~100 百分数） */
  function overallStat(records, moduleStats) {
    var st = groupStat(Array.isArray(records) ? records : []);
    // 模块掌握度平均（仅计入练过的模块，未练不计入）
    var practicedMastery = [];
    Object.keys(moduleStats).forEach(function (m) {
      var ms = moduleStats[m];
      if (ms && ms.done > 0) practicedMastery.push(ms.mastery);
    });
    var moduleAvg = practicedMastery.length ? avg(practicedMastery) : 0;
    // 总体掌握度：整体统计与模块平均各半（均为百分数），兼顾广度与深度
    var mastery = st.done === 0 ? 0 : round1(st.mastery * 100 * 0.5 + moduleAvg * 0.5);
    return {
      total: st.done,
      correct: st.correct,
      accuracy: round1(st.accuracy * 100),
      scoreRate: round1(st.scoreRate * 100),
      mastery: mastery,
      level: st.done === 0 ? '未练' : levelOf(st.accuracy).t
    };
  }

  /** 提分建议文案 */
  function buildSuggestions(weakPoints, moduleStats, overall, unpracticed, kpStats) {
    var out = [];
    if (!overall || overall.total === 0) {
      out.push('暂无做题记录：建议先从各模块的中等难度（难度 3）题目各做 2~3 道，建立初始能力画像。');
      return out;
    }

    // 1) 总体判断
    out.push('当前总体正确率 ' + Math.round(overall.accuracy) + '%，综合掌握度 '
      + Math.round(overall.mastery) + '%（' + overall.level + '）。');

    // 2) 最弱模块：在练过的模块中按正确率升序取最低（accuracy 为百分数）
    var worstMod = null, worstAcc = 101, worstM = 101;
    Object.keys(moduleStats).forEach(function (mod) {
      var ms = moduleStats[mod];
      if (!ms || ms.done === 0) return;
      if (ms.accuracy < worstAcc || (ms.accuracy === worstAcc && ms.mastery < worstM)) {
        worstAcc = ms.accuracy; worstM = ms.mastery; worstMod = mod;
      }
    });
    if (worstMod && worstAcc < 90) {
      out.push('【最需补强模块】' + worstMod + '（正确率 ' + Math.round(worstAcc)
        + '%），建议本周安排 60% 的训练时间在此模块。');
    } else if (worstMod) {
      out.push('【模块均衡】各模块正确率均较高，注意保持题型广度并挑战更高难度。');
    }

    // 3) 薄弱知识点 Top3
    if (weakPoints.length) {
      var names = weakPoints.slice(0, 3).map(function (w) {
        return w.kp + '(' + Math.round(w.accuracy) + '%)';
      });
      out.push('【优先攻克知识点】' + names.join('、')
        + '：先精读对应解法模板，再做 5 道难度 3~4 的同型题固化。');
    }

    // 4) 优势保持
    var strong = kpStats.filter(function (k) { return k.done >= 3 && k.accuracy >= 80; });
    if (strong.length) {
      out.push('【优势保持】' + strong.slice(0, 3).map(function (k) { return k.kp; }).join('、')
        + ' 掌握良好，可尝试难度 4~5 的压轴题冲击高分。');
    }

    // 5) 广度提醒
    var untouchedMods = Object.keys(moduleStats).filter(function (m) { return moduleStats[m].done === 0; });
    if (untouchedMods.length) {
      out.push('【广度提醒】' + untouchedMods.slice(0, 6).join('、') + ' 等模块尚未练习，按考点分布命题，建议补齐基础题。');
    }

    // 6) 训练节奏
    out.push('【训练节奏】每天 2~3 题、限时 90 分钟模拟二试强度，做完即刻批改并复盘逻辑链断点。');
    return out;
  }

  /* ============================== 推题引擎 ============================== */

  /**
   * 精准推荐题目。
   * @param {Array} records  做题记录
   * @param {Array} problems 题库
   * @param {Object} [options]
   * @param {string} [options.module]    限定模块（代数/几何/数论/组合）
   * @param {number} [options.count=5]   推荐数量
   * @param {string} [options.strategy]  'weak' | 'adaptive' | 'random'
   * @returns {Array} 推荐题目（含 recommendReason 字段）
   */
  function recommend(records, problems, options) {
    options = options || {};
    var count = isNum(options.count) ? Math.max(1, Math.floor(options.count)) : 5;
    var strategy = options.strategy || 'weak';
    var pool = Array.isArray(problems) ? problems : [];
    var list = Array.isArray(records) ? records : [];

    // 已做过的题 id 集合
    var doneIds = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var pid = (r.problemId !== undefined) ? r.problemId : r.id;
      if (pid !== undefined && pid !== null) doneIds[pid] = true;
    }

    function usable(p) { return p && p.id !== undefined && p.id !== null && (p.question || '').length > 0; }
    var base = pool.filter(usable).map(normProblem);
    if (options.module) {
      base = base.filter(function (p) { return p.module === options.module; });
    }
    // 优先排除已做；题量不足时在 fillIfShort 中放宽
    var fresh = base.filter(function (p) { return !doneIds[p.id]; });

    var cm = computeMastery(records, problems);
    var kpMap = {};
    for (var j = 0; j < cm.kpStats.length; j++) kpMap[cm.kpStats[j].kp] = cm.kpStats[j];

    var picked;
    if (strategy === 'random') picked = pickRandom(fresh, count, doneIds, base);
    else if (strategy === 'adaptive') picked = pickAdaptive(fresh, count, doneIds, base, cm, kpMap);
    else picked = pickWeak(fresh, count, doneIds, base, cm, kpMap);

    return picked;
  }

  /** 取该题所有知识点中最薄弱的一个作为代表（先比掌握度，再比正确率） */
  function kpScore(p, kpMap) {
    var best = null;
    var kps = p.knowledgePoints || [];
    for (var i = 0; i < kps.length; i++) {
      var st = kpMap[kps[i]];
      if (!st) continue;
      if (best === null || st.mastery < best.mastery ||
        (st.mastery === best.mastery && st.accuracy < best.accuracy)) {
        best = st;
      }
    }
    return best;
  }

  /** 组装推荐项：拷贝题目并附加推荐理由 */
  function wrap(p, reason) {
    var o = {};
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k];
    o.recommendReason = reason;
    return o;
  }

  function containsId(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return true;
    return false;
  }

  /** weak 策略：优先掌握度最低的知识点，难度锁定 3~4 附近 */
  function pickWeak(fresh, count, doneIds, base, cm, kpMap) {
    function diffRank(d) { return Math.abs(d - 3.5); }
    var scored = fresh.map(function (p) {
      var st = kpScore(p, kpMap);
      // 掌握度/正确率均为 0~100；未练知识点按中性 50 处理（不应优先于已知薄弱点）
      var mastery = st ? st.mastery : 50;
      var acc = st ? st.accuracy : 50;
      // 分数越低越优先：掌握度权重最大，其次难度贴合 3.5
      var score = mastery * 1.0 + diffRank(p.difficulty) * 6 + acc * 0.15;
      // 已知薄弱（练过且正确率 < 50%）额外加权：正确率是未经置信度回归的原始信号
      if (st && st.done > 0 && st.accuracy < 50) {
        score -= 55 - st.accuracy * 0.5; // 正确率越低提升越多（最高 -55）
      }
      return { p: p, st: st, score: score };
    });
    scored.sort(function (a, b) { return a.score - b.score; });

    var out = [];
    var seenKp = {};
    // 第一轮：尽量覆盖不同薄弱知识点
    for (var i = 0; i < scored.length && out.length < count; i++) {
      var key = scored[i].st ? scored[i].st.kp : (scored[i].p.knowledgePoints[0] || '综合');
      if (seenKp[key]) continue;
      seenKp[key] = true;
      out.push(wrap(scored[i].p, weakReason2(scored[i].st, scored[i].p)));
    }
    // 第二轮：按序补齐
    for (var j = 0; j < scored.length && out.length < count; j++) {
      if (containsId(out, scored[j].p.id)) continue;
      out.push(wrap(scored[j].p, weakReason2(scored[j].st, scored[j].p)));
    }
    return fillIfShort(out, count, doneIds, base, '题库不足，补充推荐：');
  }

  function weakReason2(st, p) {
    if (!st) {
      return '该题知识点尚未练习，属新领域基础题（难度 ' + p.difficulty + '），适合拓宽覆盖面。';
    }
    return '针对薄弱点「' + st.kp + '」（正确率 ' + Math.round(st.accuracy) + '%），'
      + '难度 ' + p.difficulty + '，建议限时训练后立即复盘。';
  }

  /** adaptive 策略：按当前水平动态调难度（答对升、答错降） */
  function pickAdaptive(fresh, count, doneIds, base, cm, kpMap) {
    var practiced = cm.kpStats.filter(function (k) { return k.done > 0; });
    // kpStats.accuracy 为 0~100 百分数，换算回 0~1 后映射难度
    var overallAcc = practiced.length
      ? avg(practiced.map(function (k) { return k.accuracy / 100; }))
      : 0.5;
    var baseDiff = clamp(2 + overallAcc * 3, 2, 5); // 正确率映射到 2~5
    var out = [];
    var used = {};
    var targetDiff = baseDiff;

    for (var step = 0; step < count; step++) {
      var best = null, bestCost = Infinity;
      for (var i = 0; i < fresh.length; i++) {
        var p = fresh[i];
        if (used[p.id]) continue;
        var st = kpScore(p, kpMap);
        var mastery = st ? st.mastery : 50;
        var cost = Math.abs(p.difficulty - targetDiff) * 10 + mastery * 0.04;
        if (cost < bestCost) { bestCost = cost; best = p; }
      }
      if (!best) break;
      used[best.id] = true;
      var bst = kpScore(best, kpMap);
      out.push(wrap(best, adaptiveReason(step, targetDiff, bst, best)));
      // 动态调整：以当前水平推断下一题难度
      var delta = overallAcc >= 0.6 ? (step === 0 ? 0.7 : 0.4) : (step === 0 ? -0.7 : -0.4);
      targetDiff = clamp(targetDiff + delta, 2, 5);
    }
    return fillIfShort(out, count, doneIds, base, '自适应题库不足，补充推荐：');
  }

  function adaptiveReason(step, targetDiff, st, p) {
    var head = step === 0 ? '自适应起始题' : ('自适应第 ' + (step + 1) + ' 题');
    var kpTxt = st ? ('围绕「' + st.kp + '」') : '兼顾知识点覆盖';
    return head + '：依据当前水平匹配难度约 ' + (Math.round(targetDiff * 10) / 10)
      + '，' + kpTxt + '，本题难度 ' + p.difficulty + '。';
  }

  /** random 策略：随机打散后取前 count */
  function pickRandom(fresh, count, doneIds, base) {
    var arr = fresh.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    var out = [];
    for (var k = 0; k < arr.length && out.length < count; k++) {
      out.push(wrap(arr[k], '随机推荐，用于查漏或放松训练。'));
    }
    return fillIfShort(out, count, doneIds, base, '随机题库不足，补充推荐：');
  }

  /** 数量不足时从全部题（含已做）中补齐 */
  function fillIfShort(out, count, doneIds, base, note) {
    if (out.length >= count) return out;
    for (var i = 0; i < base.length && out.length < count; i++) {
      var p = base[i];
      if (containsId(out, p.id)) continue;
      out.push(wrap(p, note + '（该题此前做过，可作巩固复习）'));
    }
    return out;
  }

  /* ============================== 导出 ============================== */

  var Diagnosis = {
    analyze: analyze,
    recommend: recommend,
    computeMastery: computeMastery,
    levelOf: levelOf,
    MODULES: MODULES,
    allModules: allModules,
    RADAR_AXES: RADAR_AXES,
    _internal: {
      groupStat: groupStat,
      aggregate: aggregate,
      buildIndex: buildIndex
    }
  };

  global.Diagnosis = Diagnosis;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Diagnosis;
  }
})(typeof window !== 'undefined' ? window : this);
