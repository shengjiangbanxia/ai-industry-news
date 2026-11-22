"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "";
  const cycle = params.get("cycle") || "";
  let event, pollTimer, pollStarted = 0, pendingSince = 0, submitted = false;
  let apiEndpoint = "./api/event-capture";
  const apiUrl = () => `${apiEndpoint}?event_id=${encodeURIComponent(id)}&cycle=${encodeURIComponent(cycle)}`;
  const isPages = location.hostname.endsWith(".github.io");
  const owner = isPages ? location.hostname.slice(0, -".github.io".length) : "";
  const repository = isPages ? location.pathname.split("/").filter(Boolean)[0] : "";
  // A bot commit does not rebuild branch-based GitHub Pages. Read public material
  // directly from the repository there, so new captures appear without a rebuild.
  const materialBase = isPages && /^[\w.-]+$/.test(repository)
    ? `https://raw.githubusercontent.com/${owner}/${repository}/master/data/event-materials/`
    : "./data/event-materials/";
  const materialUrl = `${materialBase}${encodeURIComponent(id)}-${encodeURIComponent(cycle)}.json`;

  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch { return null; }
  }
  function link(text, value) {
    const anchor = document.createElement("a");
    anchor.textContent = text;
    const target = safeLink(value);
    if (target) { anchor.href = target; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    return anchor;
  }
  function paragraph(text, className = "") {
    const p = document.createElement("p");
    p.textContent = text;
    p.className = className;
    return p;
  }
  function dateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  }
  function renderMaterials(payload) {
    $("materialPages").replaceChildren();
    const pages = Array.isArray(payload.pages) ? payload.pages : [];
    $("materialsMeta").textContent = `${pages.length} 个页面 · 更新于 ${dateLabel(payload.generated_at)}`;
    $("materialsStatus").textContent = payload.status === "partial" ? "部分官方来源读取失败，以下为已成功收集的资料。" : pages.length ? "按官网栏目与关键词排序，点击标题查看原文。" : "未找到可展示的官网页面。";
    $("materialsNotice").textContent = payload.notice || "官网原文摘录，未使用大模型分析。";
    const categories = ["官方发布", "主旨演讲", "技术报告", "大会信息"];
    for (const category of categories) {
      const group = pages.filter((item) => (categories.includes(item.category) ? item.category : "大会信息") === category);
      if (!group.length) continue;
      const groupHeading = document.createElement("h2");
      groupHeading.className = "event-material-category";
      groupHeading.textContent = `${category} · ${group.length}`;
      $("materialPages").appendChild(groupHeading);
      for (const item of group) {
      const article = document.createElement("article");
      article.className = "event-page";
      const heading = document.createElement("h3");
      heading.appendChild(link(item.title || "官方页面", item.url));
      article.appendChild(heading);
      if (item.published_at) article.appendChild(paragraph(`原文日期：${item.published_at}`, "event-page-date"));
      if (item.description) article.appendChild(paragraph(item.description));
      if (Array.isArray(item.excerpts) && item.excerpts.length) {
        const excerpt = document.createElement("blockquote");
        excerpt.setAttribute("aria-label", "原文摘录");
        for (const text of item.excerpts) excerpt.appendChild(paragraph(text));
        article.appendChild(excerpt);
      }
      const source = paragraph("来源：", "event-page-source");
      source.appendChild(link(new URL(item.url).hostname, item.url));
      article.appendChild(source);
      $("materialPages").appendChild(article);
      }
    }
    $("resourceList").replaceChildren();
    const resources = Array.isArray(payload.resources) ? payload.resources : [];
    $("resourceSection").hidden = !resources.length;
    for (const item of resources) {
      const row = document.createElement("li");
      const type = { video: "视频", pdf: "PDF", slides: "演示文稿" }[item.type] || "资料";
      row.appendChild(link(`${type} · ${item.title}`, item.url));
      row.append(" · ");
      row.appendChild(link("发现于官网", item.source_url));
      $("resourceList").appendChild(row);
    }
    $("errorList").replaceChildren();
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    $("errorSection").hidden = !errors.length;
    for (const item of errors) {
      const li = document.createElement("li");
      li.textContent = `${item.url}：${item.reason}`;
      $("errorList").appendChild(li);
    }
    $("showCapture").textContent = "重新抓取";
  }
  async function loadMaterials() {
    try {
      const response = await fetch(`${materialUrl}?t=${Date.now()}`, { cache: "no-store" });
      if (response.status === 404) {
        $("materialsStatus").textContent = "尚未收集此大会的资料。点击【抓取】即可启动任务。";
        return false;
      }
      if (!response.ok) throw new Error();
      const payload = await response.json();
      renderMaterials(payload);
      return !pendingSince || Date.parse(payload.generated_at) >= pendingSince;
    } catch {
      $("materialsStatus").textContent = "资料暂时无法加载，请稍后点击【刷新资料】重试。";
      return false;
    }
  }
  function configureMissing() {
    $("captureStatus").textContent = "公开抓取服务尚未配置，暂时无法启动新任务；已有资料可正常阅读。";
    $("manualCapture").hidden = false;
    $("captureForm").hidden = true;
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (Date.now() - pollStarted < 12 * 60000) pollTimer = setTimeout(checkStatus, 12000);
    else {
      $("captureStatus").textContent = "等待时间较长，可查看任务进度，完成后刷新资料。";
      $("startCapture").disabled = false;
    }
  }
  async function checkStatus() {
    try {
      const response = await fetch(apiUrl(), { cache: "no-store" });
      if (response.status === 404) { configureMissing(); return; }
      if (response.status === 503) {
        const result = await response.json();
        if (result.error === "capture_not_configured") { configureMissing(); return; }
      }
      if (!response.ok) throw new Error();
      const { run, pending_since } = await response.json();
      if (pending_since) {
        submitted = true;
        pendingSince = Date.parse(pending_since);
        if (!pollStarted) pollStarted = Date.now();
      }
      if (!run || (pendingSince && Date.parse(run.created_at) < pendingSince - 5000)) {
        if (submitted) { $("captureStatus").textContent = "已提交，等待任务进入队列…"; schedulePoll(); }
        return;
      }
      const runUrl = safeLink(run.url);
      $("runLink").hidden = !runUrl;
      if (runUrl) $("runLink").href = runUrl;
      if (run.status !== "completed") {
        if (!pollStarted) pollStarted = Date.now();
        pendingSince = Date.parse(run.created_at);
        $("captureStatus").textContent = run.status === "in_progress" ? "正在收集官网资料…" : "任务排队中…";
        $("startCapture").disabled = true;
        schedulePoll();
      } else if (run.conclusion === "success") {
        $("startCapture").disabled = false;
        pendingSince = Date.parse(run.created_at);
        const fresh = await loadMaterials();
        $("captureStatus").textContent = fresh ? "抓取完成，官方资料已更新。" : "抓取完成，正在等待网站发布新资料…";
        if (!fresh) { if (!pollStarted) pollStarted = Date.now(); schedulePoll(); }
        else { submitted = false; pendingSince = 0; }
      } else {
        $("startCapture").disabled = false;
        $("captureStatus").textContent = "任务未成功完成，可查看进度了解原因；已有资料仍保留。";
        submitted = false;
      }
    } catch {
      $("captureStatus").textContent = "任务状态暂时无法读取，可查看任务进度或稍后刷新。";
      $("startCapture").disabled = false;
      if (submitted) schedulePoll();
    }
  }
  $("showCapture").addEventListener("click", () => {
    $("capturePanel").hidden = false;
    checkStatus();
  });
  $("refreshMaterials").addEventListener("click", () => { if (event) loadMaterials(); });
  $("captureForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!event) return;
    $("startCapture").disabled = true;
    $("captureStatus").textContent = "正在检查已有资料与共享任务…";
    try {
      const response = await fetch(apiEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: event.id, cycle: event.cycle }),
      });
      if (response.status === 404) { configureMissing(); return; }
      if (response.status === 503) {
        const failure = await response.json();
        if (failure.error === "capture_not_configured") { configureMissing(); return; }
        throw new Error("抓取服务暂时不可用，请稍后重试。");
      }
      if (response.status === 429) {
        const failure = await response.json();
        throw new Error(failure.error === "daily_limit_reached" ? "今日的新任务额度已用完，已有资料仍可阅读。" : `操作较频繁，请约 ${Math.ceil((failure.retry_after || 60) / 60)} 分钟后重试。`);
      }
      if (response.status === 502) {
        const failure = await response.json();
        if (failure.error === "dispatch_status_unknown") {
          submitted = true;
          pendingSince = Date.now() - 5000;
          pollStarted = Date.now();
          $("captureStatus").textContent = "提交结果正在确认，请等待任务状态更新…";
          schedulePoll();
          return;
        }
      }
      if (!response.ok) throw new Error("任务未能提交，请稍后重试。");
      const result = await response.json();
      if (result.cached) {
        pendingSince = Date.parse(result.generated_at) || 0;
        const ready = await loadMaterials();
        $("captureStatus").textContent = ready ? "已复用 6 小时内收集的资料，无需重复抓取。" : "已有近期资料，正在同步到展示页面，请稍后刷新资料。";
        pendingSince = 0;
        $("startCapture").disabled = false;
        return;
      }
      submitted = true;
      pendingSince = result.run ? Date.parse(result.run.created_at) : result.pending_since ? Date.parse(result.pending_since) : Date.now() - 5000;
      pollStarted = Date.now();
      $("captureStatus").textContent = result.existing ? "已有共享任务，正在等待结果…" : "已提交，等待抓取任务启动…";
      schedulePoll();
    } catch (error) {
      $("captureStatus").textContent = error.message || "网络连接失败，请重试。";
      $("startCapture").disabled = false;
    }
  });
  window.addEventListener("pagehide", () => clearTimeout(pollTimer));

  async function init() {
    if (!/^[a-z0-9-]+$/.test(id) || !/^20\d{2}$/.test(cycle)) {
      $("materialsStatus").textContent = "大会链接无效，请返回首页选择大会。";
      $("eventMeta").textContent = "未选择有效大会";
      return;
    }
    try {
      const settings = await fetch("./config/event-capture.json");
      if (!settings.ok) throw new Error();
      const configured = (await settings.json()).api_url;
      if (configured) {
        const endpoint = safeLink(configured);
        if (!endpoint || new URL(endpoint).search || new URL(endpoint).hash) throw new Error();
        apiEndpoint = endpoint;
      }
      const response = await fetch("./data/industry-events.json");
      if (!response.ok) throw new Error();
      const calendar = await response.json();
      event = calendar.events.find((row) => row.id === id && String(row.cycle) === cycle);
      if (!event) throw new Error();
      $("eventTitle").textContent = `${event.name} ${event.cycle}`;
      document.title = `${event.name} ${event.cycle} · 官方资料`;
      $("eventMeta").textContent = `${event.start_date || "日期待公布"}${event.end_date && event.end_date !== event.start_date ? ` — ${event.end_date}` : ""} · ${event.location || "地点待定"}`;
      const official = safeLink(event.source_url);
      if (official) { $("officialLink").hidden = false; $("officialLink").href = official; }
      $("manualInputs").textContent = `event_id=${id}，cycle=${cycle}`;
      $("showCapture").disabled = false;
      await loadMaterials();
      if (params.get("capture") === "1") $("showCapture").click();
    } catch {
      $("eventMeta").textContent = "大会信息无法加载";
      $("materialsStatus").textContent = "未找到此大会，请返回首页重试。";
    }
  }
  init();
})();
