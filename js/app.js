/* ============================================================
   高联智能提分系统 - 主应用逻辑
   依赖：problems.unified.js (window.PROBLEMS)、diagnosis.js、grading.js
   ============================================================ */
(function () {
  'use strict';

  var LS_RECORDS = 'gaolian_records_v1';
  var LS_SETTINGS = 'gaolian_settings_v1';
  var LS_WRONG = 'gaolian_wrong_v1';

  var State = {
    problems: [],
    records: [],
    wrong: [],
    settings: {},
    filtered: [],
    page: 0,
    PAGE_SIZE: 30,
    current: null,
    view: 'dashboard'
  };

  var MOD_LV = { '代数': 'm0', '几何': 'm1', '数论': 'm2', '组合': 'm3' };
  var LV_COLOR = ['#94a3b8', '#dc2626', '#f59e0b', '#2563eb', '#16a34a'];

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function stars(d) {
    d = Math.max(1, Math.min(5, d || 3));
    return '<span class="stars">' + '★'.repeat(d) + '☆'.repeat(5 - d) + '</span>';
  }
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2200);
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
  }
  function load(key, def) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  // 渲染后触发 MathJax 排版
  function typeset(el) {
    if (window.MathJax && window.MathJax.typesetPromise) {
      var nodes = el ? [el] : null;
      window.MathJax.typesetPromise(nodes).catch(function () { });
    }
  }

  /* ---------------- 数据初始化 ---------------- */
  function initData() {
    State.problems = window.PROBLEMS || [];
    State.records = load(LS_RECORDS, []) || [];
    State.wrong = load(LS_WRONG, []) || [];
    State.settings = load(LS_SETTINGS, {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: ''
    }) || {};
  }

  function recOf(pid) {
    for (var i = State.records.length - 1; i >= 0; i--) {
      if (String(State.records[i].problemId) === String(pid)) return State.records[i];
    }
    return null;
  }
  function isWrong(pid) {
    return State.wrong.some(function (w) { return String(w) === String(pid); });
  }

  /* ---------------- 顶部统计 ---------------- */
  function updateTopStats() {
    var done = State.records.length;
    var correct = State.records.filter(function (r) { return r.correct; }).length;
    $('s-done').textContent = done;
    $('s-acc').textContent = done ? Math.round(correct / done * 100) + '%' : '--';
  }

  /* ---------------- 视图切换 ---------------- */
  function go(view) {
    State.view = view;
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    var el = $('view-' + view);
    if (el) el.classList.add('active');
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    window.scrollTo(0, 0);
    if (view === 'dashboard') renderDashboard();
    if (view === 'browse') renderBrowse(true);
    if (view === 'diagnosis') renderDiagnosis();
    if (view === 'wrong') renderWrong();
    if (view === 'grade') renderGrade();
    if (view === 'settings') renderSettings();
  }

  /* ================= 总览 ================= */
  function renderDashboard() {
    var D = window.Diagnosis;
    if (!D) { $('view-dashboard').innerHTML = '<div class="loading">诊断模块加载失败</div>'; return; }
    var a = D.analyze(State.records, State.problems);

    $('dash-stats').innerHTML = [
      card(a.overall.total, '已做题数', ''),
      card(a.overall.accuracy + '%', '正确率', ''),
      card(a.overall.scoreRate + '%', '平均得分率', ''),
      card(a.overall.level, '整体水平', '')
    ].join('');

    drawRadar($('dash-radar'), a.radar);

    var weak = (a.weakPoints || []).slice(0, 5);
    if (!weak.length) {
      $('dash-weak').innerHTML = '<div class="empty-hint">暂无足够数据，多做一些题就能看到薄弱点了</div>';
    } else {
      $('dash-weak').innerHTML = weak.map(function (w) { return kpRow(w); }).join('');
    }

    $('dash-suggest').innerHTML = (a.suggestions || [])
      .map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
      || '<li>先完成几道题，系统将为你生成个性化提分建议</li>';

    var recs = D.recommend(State.records, State.problems, { count: 4, strategy: 'weak' });
    $('dash-rec').innerHTML = recs.length
      ? recs.map(recItem).join('')
      : '<div class="empty-hint">题库题目已基本练完 🎉</div>';
    bindRecClicks();
  }

  function card(num, lbl) {
    return '<div class="stat-card"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(lbl) + '</div></div>';
  }

  function kpRow(w) {
    var lv = w.levelIndex != null ? w.levelIndex : 1;
    return '<div class="kp-row">' +
      '<span class="name">' + esc(w.kp) + ' <span class="tag ' + (MOD_LV[w.module] || '') + '" style="font-size:10.5px">' + esc(w.module) + '</span></span>' +
      '<span class="bar"><i style="width:' + Math.round(w.mastery) + '%;background:' + LV_COLOR[lv] + '"></i></span>' +
      '<span class="lv lv-' + lv + '">' + esc(w.level) + '</span>' +
      '</div>';
  }

  /* 雷达图（SVG 自绘，四维） */
  function drawRadar(host, radar) {
    if (!host) return;
    var keys = ['代数', '几何', '数论', '组合'];
    var vals = keys.map(function (k) { return Math.max(4, radar[k] || 0); });
    var cx = 150, cy = 140, R = 100;
    function pt(i, r) {
      var ang = -Math.PI / 2 + i * Math.PI * 2 / keys.length;
      return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
    }
    var svg = '<svg width="300" height="270" viewBox="0 0 300 270">';
    // 网格
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var p = keys.map(function (_, i) { return pt(i, R * f).join(','); }).join(' ');
      svg += '<polygon points="' + p + '" fill="none" stroke="#e2e8f0" stroke-width="1"/>';
    });
    keys.forEach(function (_, i) {
      var e = pt(i, R);
      svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + e[0] + '" y2="' + e[1] + '" stroke="#e2e8f0"/>';
    });
    // 数据面
    var dp = vals.map(function (v, i) { return pt(i, R * v / 100).join(','); }).join(' ');
    svg += '<polygon points="' + dp + '" fill="rgba(37,99,235,.22)" stroke="#2563eb" stroke-width="2"/>';
    vals.forEach(function (v, i) {
      var p = pt(i, R * v / 100);
      svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3.5" fill="#2563eb"/>';
    });
    // 标签
    keys.forEach(function (k, i) {
      var p = pt(i, R + 22);
      svg += '<text x="' + p[0] + '" y="' + (p[1] + 4) + '" text-anchor="middle" font-size="13" fill="#475569" font-weight="600">' + k + '</text>';
      svg += '<text x="' + p[0] + '" y="' + (p[1] + 19) + '" text-anchor="middle" font-size="11" fill="#94a3b8">' + Math.round(radar[k] || 0) + '</text>';
    });
    svg += '</svg>';
    host.innerHTML = svg;
  }

  /* ================= 刷题 ================= */
  function populateFilters() {
    var kps = {}, srcs = {};
    State.problems.forEach(function (p) {
      (p.knowledgePoints || []).forEach(function (k) { kps[k] = 1; });
      if (p.origin) srcs[p.origin] = 1;
    });
    var ks = Object.keys(kps).sort();
    $('f-kp').innerHTML = '<option value="">全部知识点</option>' +
      ks.map(function (k) { return '<option>' + esc(k) + '</option>'; }).join('');
    var ss = Object.keys(srcs).sort();
    $('f-source').innerHTML = '<option value="">全部题源</option>' +
      ss.map(function (k) { return '<option>' + esc(k) + '</option>'; }).join('');
    $('browse-count').textContent = '共 ' + State.problems.length + ' 题';
  }

  function applyFilter() {
    var q = ($('f-search').value || '').trim().toLowerCase();
    var mod = $('f-module').value, kp = $('f-kp').value,
      diff = $('f-diff').value, src = $('f-source').value, st = $('f-status').value;
    State.filtered = State.problems.filter(function (p) {
      if (mod && p.module !== mod) return false;
      if (kp && (p.knowledgePoints || []).indexOf(kp) < 0) return false;
      if (diff && String(p.difficulty) !== diff) return false;
      if (src && p.origin !== src) return false;
      if (st === 'done' && !recOf(p.id)) return false;
      if (st === 'todo' && recOf(p.id)) return false;
      if (st === 'wrong' && !isWrong(p.id)) return false;
      if (q && (p.question || '').toLowerCase().indexOf(q) < 0
        && (p.source || '').toLowerCase().indexOf(q) < 0
        && (p.knowledgePoints || []).join(',').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderBrowse(reset) {
    if (reset === true) { State.page = 0; applyFilter(); }
    var list = State.filtered;
    var show = list.slice(0, (State.page + 1) * State.PAGE_SIZE);
    $('browse-count').textContent = '筛选出 ' + list.length + ' 题 / 共 ' + State.problems.length + ' 题';

    if (!show.length) {
      $('plist').innerHTML = '<div class="empty-hint">没有符合条件的题目</div>';
      $('load-more').style.display = 'none';
      return;
    }
    $('plist').innerHTML = show.map(function (p) {
      var r = recOf(p.id);
      var badge = r ? (r.correct ? '<span class="badge ok">已做 ✓</span>' : '<span class="badge no">已做 ✗</span>')
        : (isWrong(p.id) ? '<span class="badge no">错题</span>' : '');
      var kps = (p.knowledgePoints || []).map(function (k) { return '<span class="tag">' + esc(k) + '</span>'; }).join('');
      return '<div class="pitem" data-id="' + esc(p.id) + '">' +
        '<span class="pid">' + esc(p.id) + '</span>' +
        '<div class="pbody">' +
        '<div class="txt">' + esc((p.question || '').replace(/\s+/g, ' ').slice(0, 160)) + '</div>' +
        '<div class="pm">' +
        '<span class="tag ' + (MOD_LV[p.module] || '') + '">' + esc(p.module) + '</span>' +
        '<span class="tag diff">' + stars(p.difficulty) + '</span>' +
        kps + badge +
        '</div></div></div>';
    }).join('');

    $('plist').querySelectorAll('.pitem').forEach(function (el) {
      el.onclick = function () { openProblem(el.dataset.id); };
    });
    $('load-more').style.display = show.length < list.length ? 'inline-flex' : 'none';
  }

  function openProblem(id) {
    var p = State.problems.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!p) return;
    State.current = p;
    $('browse-list-view').style.display = 'none';
    $('browse-detail-view').style.display = 'block';
    $('q-head').innerHTML =
      '<span class="pid">' + esc(p.id) + '</span>' +
      '<span class="tag ' + (MOD_LV[p.module] || '') + '">' + esc(p.module) + '</span>' +
      '<span class="tag diff">' + stars(p.difficulty) + '</span>' +
      (p.source ? '<span class="tag">' + esc(p.source) + '</span>' : '') +
      (p.knowledgePoints || []).map(function (k) { return '<span class="tag">' + esc(k) + '</span>'; }).join('');
    $('q-text').innerHTML = esc(p.question || '（题干缺失）');
    $('q-sol').innerHTML = esc(p.solution || '');
    $('q-sol').classList.add('hidden');
    $('toggle-sol').textContent = '查看解析';
    $('q-nosol').style.display = p.solution ? 'none' : 'block';
    $('toggle-sol').style.display = p.solution ? 'inline-flex' : 'none';

    var r = recOf(p.id);
    $('ans-input').value = r ? (r.answer || '') : '';
    var sc = r ? (r.score != null ? r.score : 25) : 25;
    $('score-range').value = sc; $('score-val').textContent = sc;
    typeset($('browse-detail-view'));
    window.scrollTo(0, 0);
  }

  function saveRecord(opts) {
    var p = State.current;
    if (!p) return;
    opts = opts || {};
    var score = parseInt($('score-range').value, 10);
    var answer = $('ans-input').value || '';
    var rec = {
      problemId: p.id,
      module: p.module,
      knowledgePoints: p.knowledgePoints || [],
      difficulty: p.difficulty,
      score: score,
      fullScore: 50,
      correct: score >= 35,
      answer: answer,
      timeSpent: 0,
      timestamp: Date.now()
    };
    // 覆盖同题旧记录
    State.records = State.records.filter(function (r) { return String(r.problemId) !== String(p.id); });
    State.records.push(rec);
    store(LS_RECORDS, State.records);
    // 若得分为满分档则从错题本移除
    if (rec.correct) {
      State.wrong = State.wrong.filter(function (w) { return String(w) !== String(p.id); });
      store(LS_WRONG, State.wrong);
    }
    updateTopStats();
    toast(opts.silent ? '记录已保存' : '已保存：' + p.id + ' 得分 ' + score + '/50');
  }

  /* ================= 诊断 ================= */
  function renderDiagnosis() {
    var D = window.Diagnosis;
    if (!D) { return; }
    if (!State.records.length) {
      $('diag-empty').style.display = 'block';
      $('diag-main').style.display = 'none';
      return;
    }
    $('diag-empty').style.display = 'none';
    $('diag-main').style.display = 'block';

    var a = D.analyze(State.records, State.problems);
    $('diag-stats').innerHTML = [
      card(a.overall.total, '已做题数', ''),
      card(a.overall.accuracy + '%', '正确率', ''),
      card(a.overall.scoreRate + '%', '平均得分率', ''),
      card(a.overall.level, '整体水平', '')
    ].join('');
    drawRadar($('diag-radar'), a.radar);

    // 模块掌握度
    $('diag-modules').innerHTML = ['代数', '几何', '数论', '组合'].map(function (m) {
      var s = a.moduleStats[m] || { done: 0, accuracy: 0, mastery: 0 };
      var lv = a.overall && s.done ? D.levelOf(s.accuracy) : { i: 0, t: '未练' };
      return '<div class="kp-row">' +
        '<span class="name">' + m + ' <span style="color:var(--text-light);font-size:12px">(' + s.done + '题)</span></span>' +
        '<span class="bar"><i style="width:' + Math.round(s.mastery || 0) + '%;background:' + LV_COLOR[lv.i] + '"></i></span>' +
        '<span class="lv lv-' + lv.i + '">' + esc(lv.t) + '</span></div>';
    }).join('');

    $('diag-weak').innerHTML = (a.weakPoints || []).length
      ? a.weakPoints.map(kpRow).join('')
      : '<div class="empty-hint">暂无明显薄弱点，水平很均衡 👏</div>';

    $('diag-suggest').innerHTML = (a.suggestions || []).map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('') || '<li>继续积累做题记录以获得更精准的分析</li>';

    renderRecs();
  }

  function renderRecs() {
    var D = window.Diagnosis;
    var strategy = $('rec-strategy') ? $('rec-strategy').value : 'weak';
    var recs = D.recommend(State.records, State.problems, { count: 6, strategy: strategy });
    $('diag-rec').innerHTML = recs.length
      ? recs.map(recItem).join('')
      : '<div class="empty-hint">暂无推荐，题库可能已练完</div>';
    bindRecClicks();
  }

  function recItem(p) {
    var kps = (p.knowledgePoints || []).map(function (k) { return '<span class="tag">' + esc(k) + '</span>'; }).join('');
    return '<div class="rec-item" data-id="' + esc(p.id) + '">' +
      '<div style="display:flex;gap:10px;align-items:flex-start">' +
      '<span class="pid">' + esc(p.id) + '</span>' +
      '<div style="flex:1;min-width:0">' +
      '<div style="font-size:14px;line-height:1.55">' + esc((p.question || '').replace(/\s+/g, ' ').slice(0, 120)) + '</div>' +
      '<div class="pm" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px">' +
      '<span class="tag ' + (MOD_LV[p.module] || '') + '">' + esc(p.module) + '</span>' +
      '<span class="tag diff">' + stars(p.difficulty) + '</span>' + kps + '</div>' +
      (p.recommendReason ? '<div class="rec-reason">💡 ' + esc(p.recommendReason) + '</div>' : '') +
      '</div></div></div>';
  }

  function bindRecClicks() {
    document.querySelectorAll('.rec-item').forEach(function (el) {
      el.onclick = function () {
        go('browse');
        setTimeout(function () { openProblem(el.dataset.id); }, 60);
      };
    });
  }

  /* ================= 错题本 ================= */
  function renderWrong() {
    if (!State.wrong.length) {
      $('wrong-body').innerHTML = '<div class="empty-hint">错题本是空的。做题时点「标记为错题」即可收录。</div>';
      return;
    }
    var byKp = {};
    State.wrong.forEach(function (wid) {
      var p = State.problems.filter(function (x) { return String(x.id) === String(wid); })[0];
      if (!p) return;
      (p.knowledgePoints || ['未分类']).forEach(function (k) {
        (byKp[k] = byKp[k] || []).push(p);
      });
    });
    $('wrong-body').innerHTML = Object.keys(byKp).map(function (k) {
      return '<div class="card"><h3>' + esc(k) + ' <span class="tag" style="font-weight:400">' + byKp[k].length + ' 题</span></h3>' +
        '<div class="plist">' + byKp[k].map(function (p) {
          return '<div class="pitem" data-id="' + esc(p.id) + '">' +
            '<span class="pid">' + esc(p.id) + '</span>' +
            '<div class="pbody"><div class="txt">' + esc((p.question || '').replace(/\s+/g, ' ').slice(0, 140)) + '</div>' +
            '<div class="pm"><span class="tag ' + (MOD_LV[p.module] || '') + '">' + esc(p.module) + '</span>' +
            '<span class="tag diff">' + stars(p.difficulty) + '</span></div></div></div>';
        }).join('') + '</div></div>';
    }).join('');
    $('wrong-body').querySelectorAll('.pitem').forEach(function (el) {
      el.onclick = function () { go('browse'); setTimeout(function () { openProblem(el.dataset.id); }, 60); };
    });
  }

  /* ================= AI 批改 ================= */
  function renderGrade() {
    // 题目下拉
    var sel = $('g-problem');
    if (sel.options.length <= 1) {
      sel.innerHTML = '<option value="">— 不关联题库，仅批改作答 —</option>' +
        State.problems.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.id) + ' · ' + esc(p.module) + ' · ' +
            esc((p.question || '').replace(/\s+/g, ' ').slice(0, 42)) + '</option>';
        }).join('');
    }
    updateGradeMode();
  }

  function updateGradeMode() {
    var s = State.settings;
    var hasKey = !!(s.apiKey && s.apiKey.trim());
    $('g-mode-hint').textContent = hasKey
      ? '将使用 ' + (s.model || 'AI') + ' 联网批改'
      : '未配置 API Key，将使用本地启发式批改（可去「设置」配置以获得更精准评分）';
  }

  function runGrade() {
    var G = window.Grading;
    if (!G) { toast('批改模块未加载'); return; }
    var pid = $('g-problem').value;
    var p = pid ? State.problems.filter(function (x) { return String(x.id) === String(pid); })[0] : null;
    var studentSolution = ($('g-text').value || '').trim();
    if (!studentSolution) { toast('请先填写或粘贴你的解答'); return; }

    var problemText = p ? p.question : '（未提供原题，请依据解答本身评价其完整性与严密性）';
    var full = 50;
    var s = State.settings;
    var hasKey = !!(s.apiKey && s.apiKey.trim());

    $('g-run').disabled = true;
    $('g-progress').style.display = 'block';
    var bar = $('g-progress').querySelector('i');
    bar.style.width = '25%';

    function done(res) {
      $('g-run').disabled = false;
      $('g-progress').style.display = 'none';
      showGradeResult(res, p);
    }

    if (!hasKey) {
      bar.style.width = '80%';
      var r = G.localGrade(problemText, studentSolution, full);
      setTimeout(function () { done(r); }, 350);
      return;
    }

    bar.style.width = '55%';
    G.grade({
      apiKey: s.apiKey,
      baseUrl: s.baseUrl,
      model: s.model,
      problemText: problemText,
      studentSolution: studentSolution,
      fullScore: full,
      onProgress: function (st) { bar.style.width = st; }
    }).then(done).catch(function (e) {
      $('g-run').disabled = false;
      $('g-progress').style.display = 'none';
      toast('批改失败：' + (e.message || e) + '，已切换本地批改');
      setTimeout(function () { done(G.localGrade(problemText, studentSolution, full)); }, 400);
    });
  }

  function showGradeResult(res, p) {
    var card = $('g-result-card');
    card.style.display = 'block';
    $('g-score').innerHTML = (res.score != null ? res.score : '--') +
      ' <small>/ ' + (res.maxScore || 50) + ' 分</small>' +
      (res.mode === 'local' ? ' <small style="color:#f59e0b">(本地估算)</small>' : '');

    // 采分点
    $('g-breakdown').innerHTML = (res.breakdown || []).map(function (b) {
      var cls = b.got >= b.full ? 'ok' : (b.got > 0 ? 'mid' : 'no');
      return '<div class="bd-row"><span class="pt">' + esc(b.point) +
        (b.comment ? '<span class="cm">' + esc(b.comment) + '</span>' : '') + '</span>' +
        '<span class="sc"><span class="badge ' + cls + '">' + b.got + '/' + b.full + '</span></span></div>';
    }).join('');

    // 逻辑链
    var lc = res.logicChain || [];
    $('g-logic').innerHTML = lc.length
      ? '<h3 style="font-size:14px;margin-bottom:8px">🔗 逻辑链检查</h3>' + lc.map(function (s) {
        return '<div class="bd-row"><span class="pt">' + esc(s.step) +
          (s.comment ? '<span class="cm">' + esc(s.comment) + '</span>' : '') + '</span>' +
          '<span class="sc">' + (s.ok ? '<span class="badge ok">✓</span>' : '<span class="badge no">✗</span>') + '</span></div>';
      }).join('') : '';

    // 建议
    var ad = res.suggestions || [];
    $('g-advice').innerHTML = ad.length
      ? '<h3 style="font-size:14px;margin-bottom:8px">💡 提升建议</h3><ul class="suggest-list">' +
      ad.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '';

    typeset(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ================= 设置 ================= */
  var PROVIDERS = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { baseUrl: '', model: '' }
  };

  function renderSettings() {
    var s = State.settings;
    $('set-provider').value = s.provider || 'deepseek';
    $('set-baseurl').value = s.baseUrl || '';
    $('set-model').value = s.model || '';
    $('set-apikey').value = s.apiKey || '';
    $('set-total').textContent = State.problems.length;
    $('set-sol').textContent = State.problems.filter(function (p) { return p.solution; }).length;
  }

  function saveSettings() {
    State.settings = {
      provider: $('set-provider').value,
      baseUrl: $('set-baseurl').value.trim(),
      model: $('set-model').value.trim(),
      apiKey: $('set-apikey').value.trim()
    };
    store(LS_SETTINGS, State.settings);
    updateGradeMode();
    toast('设置已保存');
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    // 导航
    $('nav').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (b) go(b.dataset.view);
    });

    // 刷题筛选
    ['f-search', 'f-module', 'f-kp', 'f-diff', 'f-source', 'f-status'].forEach(function (id) {
      $(id).addEventListener('input', function () { renderBrowse(true); });
      $(id).addEventListener('change', function () { renderBrowse(true); });
    });
    var st;
    $('f-search').addEventListener('input', function () {
      clearTimeout(st); st = setTimeout(function () { renderBrowse(true); }, 200);
    });
    $('load-more').onclick = function () { State.page++; renderBrowse(); };
    $('back-list').onclick = function () {
      $('browse-detail-view').style.display = 'none';
      $('browse-list-view').style.display = 'block';
    };
    $('toggle-sol').onclick = function () {
      var s = $('q-sol');
      var hidden = s.classList.toggle('hidden');
      this.textContent = hidden ? '查看解析' : '收起解析';
      if (!hidden) typeset(s);
    };
    $('score-range').oninput = function () { $('score-val').textContent = this.value; };
    $('save-record').onclick = function () { saveRecord(); };
    $('mark-wrong').onclick = function () {
      var p = State.current; if (!p) return;
      if (isWrong(p.id)) { toast('已在错题本中'); return; }
      State.wrong.push(p.id);
      store(LS_WRONG, State.wrong);
      saveRecord({ silent: true });
      toast('已加入错题本');
    };
    $('next-problem').onclick = function () {
      if (!State.current) return;
      var list = State.filtered.length ? State.filtered : State.problems;
      var idx = list.findIndex(function (x) { return String(x.id) === String(State.current.id); });
      if (idx >= 0 && idx < list.length - 1) openProblem(list[idx + 1].id);
      else toast('已是最后一题');
    };

    // 诊断
    if ($('rec-strategy')) $('rec-strategy').onchange = renderRecs;

    // 批改
    $('upload-box').onclick = function () { $('g-file').click(); };
    $('g-file').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var url = URL.createObjectURL(f);
      var img = $('preview'); img.src = url; img.style.display = 'block';
      if (window.Grading && window.Grading.recognizeImage) {
        $('g-text').value = '【已上传图片：' + f.name + '】\n（浏览器端已就绪，如需自动识别请配置视觉模型；也可手动补充解答文字）';
      }
    };
    $('g-problem').onchange = function () {
      var pid = this.value;
      var p = State.problems.filter(function (x) { return String(x.id) === String(pid); })[0];
      if (p) {
        $('g-problem-preview-wrap').style.display = 'block';
        $('g-problem-preview').innerHTML = esc(p.question);
        typeset($('g-problem-preview'));
      } else {
        $('g-problem-preview-wrap').style.display = 'none';
      }
    };
    $('g-run').onclick = runGrade;

    // 设置
    $('set-provider').onchange = function () {
      var pr = PROVIDERS[this.value];
      if (pr) { $('set-baseurl').value = pr.baseUrl; $('set-model').value = pr.model; }
    };
    $('save-settings').onclick = saveSettings;
    $('export-data').onclick = function () {
      var blob = new Blob([JSON.stringify({
        records: State.records, wrong: State.wrong, settings: State.settings, exportedAt: Date.now()
      }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'gaolian-data-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      toast('数据已导出');
    };
    $('import-data').onclick = function () { $('import-file').click(); };
    $('import-file').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          if (d.records) { State.records = d.records; store(LS_RECORDS, State.records); }
          if (d.wrong) { State.wrong = d.wrong; store(LS_WRONG, State.wrong); }
          if (d.settings) { State.settings = d.settings; store(LS_SETTINGS, State.settings); }
          updateTopStats(); renderSettings(); go(State.view);
          toast('数据导入成功');
        } catch (err) { toast('导入失败：文件格式不正确'); }
      };
      rd.readAsText(f);
    };
    $('clear-data').onclick = function () {
      if (!confirm('确定清空所有做题记录和错题本？此操作不可恢复。')) return;
      State.records = []; State.wrong = [];
      store(LS_RECORDS, []); store(LS_WRONG, []);
      updateTopStats(); go('dashboard');
      toast('已清空');
    };
  }

  /* ================= 启动 ================= */
  function boot() {
    if (!window.PROBLEMS || !window.PROBLEMS.length) {
      document.querySelector('.wrap').innerHTML =
        '<div class="loading">题库加载失败：请确认 data/problems.unified.js 存在且可访问。</div>';
      return;
    }
    initData();
    populateFilters();
    applyFilter();
    bind();
    updateTopStats();
    go('dashboard');
    typeset();
    console.log('[高联提分系统] 题库', State.problems.length, '题，记录', State.records.length, '条');
  }

  window.App = { go: go, openProblem: openProblem, state: State };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
