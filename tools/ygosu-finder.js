/*!
 * YGOSU FINDER — 회원번호로 그 사람이 쓴 글을 게시판별로 모아 보는 도구
 *
 * ygosu.com 에서 실행할 것. (읽기 전용, 로그인 없어도 동작)
 * ygosu.com 은 CORS 헤더를 주지 않아 외부 페이지에서는 목록을 가져올 수 없다.
 * 그래서 사이트 안에서 같은 출처로 요청한다.
 *
 * 목록 출처: /minilog/?m2=article&member={no}&m3=list&page={n}  (30개/페이지)
 */
(function () {
  "use strict";

  if (!/(^|\.)ygosu\.com$/i.test(location.hostname)) {
    alert("이 도구는 ygosu.com 에서 실행해야 합니다.");
    return;
  }

  if (document.getElementById("yg-finder-root")) {
    alert("이미 실행 중입니다.");
    return;
  }

  var SCAN_DELAY = 350;

  /* m.ygosu.com 은 PC 와 주소 체계가 다르다.
     PC   : /minilog/?m2=article&member=X&m3=list
     모바일: /minilog/?member=X&menu=article_list
     PC 주소를 모바일에서 열면 목록 없는 프로필 페이지가 나온다.
     마크업(table.tbl_ua)은 양쪽이 같아서 파서는 그대로 쓴다. */
  var MOBILE = /^m\.ygosu\.com$/i.test(location.hostname) || window.IS_MOBILE === true;

  function listUrl(member, page) {
    return MOBILE
      ? "/minilog/?member=" + member + "&menu=article_list&page=" + page
      : "/minilog/?m2=article&member=" + member + "&m3=list&page=" + page;
  }

  var state = { items: [], board: "", query: "", busy: false, abort: false, member: 0 };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function text(node) {
    return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** "703365", "member=703365", 미니로그 주소 어느 쪽이든 회원번호를 뽑는다. */
  function parseMember(raw) {
    var value = String(raw || "").trim();
    var fromUrl = value.match(/member=(\d+)/);
    if (fromUrl) return Number(fromUrl[1]);
    var digits = value.match(/\d+/);
    return digits ? Number(digits[0]) : 0;
  }

  function absolute(href) {
    if (!href) return "";
    if (href.indexOf("//") === 0) return location.protocol + href;
    if (href.indexOf("http") === 0) return href;
    return location.origin + href;
  }

  async function fetchDoc(url) {
    var response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    var buffer = await response.arrayBuffer();
    return new DOMParser().parseFromString(new TextDecoder("utf-8").decode(buffer), "text/html");
  }

  function parsePage(doc) {
    var items = [];

    doc.querySelectorAll("table.tbl_ua tbody tr").forEach(function (row) {
      var titleLink = row.querySelector("td.tit a");
      if (!titleLink) return;

      var boardLink = row.querySelector("td.board a");
      var boardHref = boardLink ? boardLink.getAttribute("href") || "" : "";
      var boardId = (boardHref.match(/\/board\/([^/?#]+)/) || [])[1] || "";

      items.push({
        title: text(titleLink) || "(제목 없음)",
        url: absolute(titleLink.getAttribute("href")),
        boardId: boardId,
        boardName: text(boardLink) || boardId || "(게시판 불명)",
        view: text(row.querySelector("td.view")),
        date: text(row.querySelector("td.date")),
        vote: text(row.querySelector("td.vote")),
      });
    });

    /* PC:     <h3><a ...>닉네임</a> <em>님의 작성글</em> <i>(총 <strong>N</strong>개)</i></h3>
       모바일: <h3>닉네임 <em>님의 작성글</em> <i>(총 <strong>N</strong>개)</i></h3>  ← 링크 없이 텍스트 */
    var head = doc.querySelector(".det_myboard h3");
    var nick = text(head && head.querySelector("a"));
    if (!nick && head) {
      nick = Array.prototype.filter
        .call(head.childNodes, function (node) { return node.nodeType === 3; })
        .map(function (node) { return node.textContent; })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // PC 는 글/댓글 탭에 각각 개수가 붙는다. 모바일에는 없어서 h3 의 총 개수를 쓴다.
    var counts = Array.prototype.map.call(
      doc.querySelectorAll(".yg-minilog-tab-count"),
      function (node) { return text(node).replace(/[()]/g, ""); }
    );
    if (!counts.length && head && head.querySelector("strong")) {
      counts = [text(head.querySelector("strong"))];
    }

    var profile = { nick: nick, counts: counts };

    return { items: items, profile: profile };
  }

  async function scan(member, maxPages, onProgress) {
    var collected = [];
    var seen = {};
    var profile = null;

    for (var page = 1; page <= maxPages; page++) {
      if (state.abort) break;

      var parsed = parsePage(await fetchDoc(listUrl(member, page)));

      if (!profile && parsed.profile.nick) profile = parsed.profile;
      if (!parsed.items.length) break;

      // 페이지당 개수가 PC 30개 / 모바일 20개로 달라서 개수로 끝을 판단하지 않는다.
      // 새로 얻은 항목이 하나도 없으면 마지막 페이지를 반복해서 받은 것이다.
      var added = 0;
      parsed.items.forEach(function (item) {
        if (seen[item.url]) return;
        seen[item.url] = true;
        collected.push(item);
        added++;
      });

      onProgress(page, collected.length);

      if (!added) break;
      if (page < maxPages) await sleep(SCAN_DELAY);
    }

    return { items: collected, profile: profile || { nick: "", counts: [] } };
  }

  /* ── UI ────────────────────────────────────────────── */

  var root = document.createElement("div");
  root.id = "yg-finder-root";
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647";
  document.body.appendChild(root);

  var shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    "<style>",
    ":host,*{box-sizing:border-box}",
    ".back{position:fixed;inset:0;background:rgba(3,8,18,.72);backdrop-filter:blur(4px);display:grid;place-items:center;padding:16px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif}",
    ".box{display:flex;flex-direction:column;width:min(100%,900px);max-height:min(92vh,880px);overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:linear-gradient(150deg,#0f1f3a,#071225);color:#f6f8fc;box-shadow:0 30px 90px rgba(0,0,0,.5)}",
    /* 목록만 늘어나고 나머지 줄은 절대 눌리지 않게 한다 */
    ".hd,.bar,.msg,.chips,.ft{flex:0 0 auto}",
    ".hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.12)}",
    ".hd b{font-size:15px;letter-spacing:.04em}",
    ".hd .who{color:#61d9ff;font-size:13px;font-weight:700}",
    ".hd .sub{color:#98a7be;font-size:12px}",
    ".x{margin-left:auto;width:32px;height:32px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:transparent;color:#cfdcf0;font-size:15px;cursor:pointer}",
    ".bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.12);font-size:13px}",
    "button{font:inherit;cursor:pointer}",
    "input{padding:8px 10px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(255,255,255,.06);color:#f6f8fc;font:inherit;font-size:13px}",
    "input#member{width:170px}input#pages{width:62px}input#q{flex:1;min-width:120px}",
    ".btn{padding:8px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.07);color:#f6f8fc;font-size:13px;font-weight:700}",
    ".btn:hover{border-color:rgba(97,217,255,.5)}",
    ".btn.go{border-color:transparent;background:#1769ff}",
    ".btn:disabled{opacity:.45;cursor:not-allowed}",
    ".msg{padding:10px 18px;color:#98a7be;font-size:12.5px;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.12)}",
    ".msg.err{color:#ff9d9d}.msg.ok{color:#4be1a0}",
    ".chips{display:flex;gap:6px;flex-wrap:wrap;padding:11px 18px;border-bottom:1px solid rgba(255,255,255,.12);max-height:124px;overflow-y:auto}",
    ".chip{flex:0 0 auto;padding:6px 11px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.05);color:#c4d0e1;font-size:12px;font-weight:700;line-height:1.2;white-space:nowrap}",
    ".chip.on{border-color:transparent;background:#61d9ff;color:#061022}",
    ".chip i{font-style:normal;opacity:.7;margin-left:5px}",
    ".list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px}",
    ".grp{margin:10px 6px 4px;color:#61d9ff;font-size:12px;font-weight:700;letter-spacing:.08em}",
    ".row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 11px;border-radius:10px;text-decoration:none;color:inherit}",
    ".row>span{min-width:0}",
    ".row:nth-child(odd){background:rgba(255,255,255,.03)}",
    ".row:hover{background:rgba(97,217,255,.10)}",
    ".row .t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:700}",
    ".row .s{display:block;margin-top:3px;color:#8fa0b8;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".row .m{color:#8fa0b8;font-size:11.5px;line-height:1.45;white-space:nowrap;text-align:right}",
    ".empty{padding:40px;color:#98a7be;text-align:center;font-size:13px}",
    ".ft{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.12);color:#8fa0b8;font-size:12px}",
    "</style>",
    '<div class="back"><div class="box">',
    '  <div class="hd"><b>YGOSU FINDER</b><span class="who" id="who"></span><span class="sub" id="sub"></span>',
    '    <button class="x" id="close" title="닫기">✕</button></div>',
    '  <div class="bar">',
    '    <input id="member" placeholder="회원번호 또는 미니로그 주소" inputmode="numeric">',
    '    <span>최대</span><input id="pages" type="number" value="5" min="1" max="200"><span>페이지</span>',
    '    <button class="btn go" id="go">조회</button><button class="btn" id="stop" disabled>중지</button>',
    '    <input id="q" placeholder="제목 검색">',
    "  </div>",
    '  <div class="msg" id="msg">회원번호를 넣고 조회하세요. 한 페이지에 글 30개씩 가져옵니다.</div>',
    '  <div class="chips" id="chips" hidden></div>',
    '  <div class="list" id="list"><div class="empty">아직 조회 결과가 없습니다.</div></div>',
    '  <div class="ft" id="ft">게시판별로 묶어 보여줍니다. 제목을 누르면 새 탭에서 글이 열립니다.</div>',
    "</div></div>",
  ].join("");

  var el = function (id) { return shadow.getElementById(id); };
  var listEl = el("list");

  function say(message, kind) {
    var box = el("msg");
    box.className = "msg" + (kind ? " " + kind : "");
    box.textContent = message;
  }

  function boardCounts() {
    var map = {};
    state.items.forEach(function (item) {
      map[item.boardName] = (map[item.boardName] || 0) + 1;
    });
    return Object.keys(map)
      .map(function (name) { return { name: name, count: map[name] }; })
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  function visibleItems() {
    var query = state.query.toLowerCase();
    return state.items.filter(function (item) {
      if (state.board && item.boardName !== state.board) return false;
      if (query && item.title.toLowerCase().indexOf(query) < 0) return false;
      return true;
    });
  }

  function renderChips() {
    var groups = boardCounts();
    if (!groups.length) {
      el("chips").hidden = true;
      return;
    }

    el("chips").hidden = false;
    el("chips").innerHTML =
      '<button class="chip' + (state.board ? "" : " on") + '" data-board="">전체<i>' + state.items.length + "</i></button>" +
      groups
        .map(function (group) {
          return (
            '<button class="chip' + (state.board === group.name ? " on" : "") + '" data-board="' +
            escapeHtml(group.name) + '">' + escapeHtml(group.name) + "<i>" + group.count + "</i></button>"
          );
        })
        .join("");

    el("chips").querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        state.board = chip.dataset.board;
        renderChips();
        renderList();
      });
    });
  }

  function renderList() {
    var items = visibleItems();

    if (!items.length) {
      listEl.innerHTML = '<div class="empty">조건에 맞는 글이 없습니다.</div>';
      el("ft").textContent = "0개 표시";
      return;
    }

    var html = "";
    var lastBoard = null;

    // 게시판 필터가 걸려 있지 않으면 게시판별로 묶어서 보여준다
    var ordered = state.board
      ? items
      : items.slice().sort(function (a, b) {
          if (a.boardName === b.boardName) return 0;
          return a.boardName.localeCompare(b.boardName);
        });

    ordered.forEach(function (item) {
      if (!state.board && item.boardName !== lastBoard) {
        lastBoard = item.boardName;
        html += '<div class="grp">' + escapeHtml(item.boardName) + "</div>";
      }
      html +=
        '<a class="row" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span><span class="t">' + escapeHtml(item.title) + "</span>" +
        '<span class="s">' + escapeHtml(item.boardName) + " · " + escapeHtml(item.date) + "</span></span>" +
        '<span class="m">조회 ' + escapeHtml(item.view || "-") + "<br>추천 " + escapeHtml(item.vote || "-") + "</span>" +
        "</a>";
    });

    listEl.innerHTML = html;
    el("ft").textContent = items.length + "개 표시 / 전체 " + state.items.length + "개 수집";
  }

  function setBusy(busy) {
    state.busy = busy;
    el("go").disabled = busy;
    el("stop").disabled = !busy;
  }

  el("close").addEventListener("click", function () {
    state.abort = true;
    root.remove();
  });

  el("stop").addEventListener("click", function () {
    state.abort = true;
    say("중지 요청됨.");
  });

  el("q").addEventListener("input", function () {
    state.query = el("q").value.trim();
    renderList();
  });

  el("member").addEventListener("keydown", function (event) {
    if (event.key === "Enter") el("go").click();
  });

  el("go").addEventListener("click", async function () {
    var member = parseMember(el("member").value);
    if (!member) {
      say("회원번호를 확인하세요. 숫자 또는 member=... 가 포함된 주소를 넣으면 됩니다.", "err");
      return;
    }

    var maxPages = Math.max(1, Math.min(200, Number(el("pages").value) || 1));
    state.abort = false;
    state.member = member;
    state.board = "";
    setBusy(true);
    say("불러오는 중…");

    try {
      var result = await scan(member, maxPages, function (page, total) {
        say(page + "페이지까지 " + total + "개 수집…");
      });

      state.items = result.items;
      el("who").textContent = result.profile.nick ? result.profile.nick + " (#" + member + ")" : "#" + member;
      el("sub").textContent = result.profile.counts.length
        ? "작성글 " + result.profile.counts[0] + " / 작성댓글 " + (result.profile.counts[1] || "-")
        : "";

      renderChips();
      renderList();
      say(
        state.items.length
          ? state.items.length + "개 수집 완료. 게시판 칩으로 걸러 볼 수 있습니다."
          : "글이 없거나 비공개 회원입니다.",
        state.items.length ? "ok" : null
      );
    } catch (error) {
      say("조회 실패: " + error.message, "err");
    } finally {
      state.abort = false;
      setBusy(false);
    }
  });

  // 현재 보고 있는 페이지에 회원번호가 있으면 미리 채워 둔다
  var prefill = parseMember(location.search);
  if (prefill) el("member").value = String(prefill);
  el("member").focus();
})();
