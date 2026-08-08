/*!
 * 똥퀴감별기 — 회원번호로 전 게시판(스타대학 제외) 글을 뒤져 특정 단어 사용 여부를 판정
 *
 * ygosu.com 에서 실행할 것. (읽기 전용, 로그인 없어도 동작)
 * 와이고수 자체 검색을 쓴다: /minilog/?...&searcht=sb&search={단어}
 * searcht=sb 는 제목+내용 검색이라 본문에 쓴 것도 잡힌다.
 */
(function () {
  "use strict";

  if (!/(^|\.)ygosu\.com$/i.test(location.hostname)) {
    alert("이 도구는 ygosu.com 에서 실행해야 합니다.");
    return;
  }

  if (document.getElementById("yg-ddong-root")) {
    alert("이미 실행 중입니다.");
    return;
  }

  var WORDS = ["젖퀴", "젖캄", "젖갤", "젖몬", "젖센세", "젖햄", "젖능크", "젖카페", "젖환", "젖대게"];
  var EXCLUDE_BOARDS = ["pan_monstarz"]; // 스타대학(스대게)은 판정 대상에서 제외
  var MAX_PAGES = 3;                     // 단어 하나당 훑을 최대 페이지 수
  var DELAY = 300;

  var MOBILE = /^m\.ygosu\.com$/i.test(location.hostname) || window.IS_MOBILE === true;

  function searchUrl(member, word, page) {
    var q = encodeURIComponent(word);
    return MOBILE
      ? "/minilog/?member=" + member + "&menu=article_list&searcht=sb&search=" + q + "&page=" + page
      : "/minilog/?m2=article&m3=list&member=" + member + "&searcht=sb&search=" + q + "&page=" + page;
  }

  /* 댓글은 부분 지원이다.
     와이고수 댓글 검색은 키워드를 무시하고 전체를 돌려주므로 쓸 수 없다.
     대신 작성댓글 목록을 훑어 화면에 보이는 본문과 직접 대조한다.
     목록의 본문은 27자 안팎에서 잘리므로 뒤쪽에 쓴 단어는 잡히지 않는다. */
  function commentUrl(member, page) {
    return MOBILE
      ? "/minilog/?member=" + member + "&menu=comment_list&page=" + page
      : "/minilog/?m2=article&m3=comment&m4=normal&member=" + member + "&page=" + page;
  }

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

  function parseRows(doc) {
    var rows = [];

    doc.querySelectorAll("table.tbl_ua tbody tr").forEach(function (row) {
      var titleLink = row.querySelector("td.tit a");
      if (!titleLink) return;

      var boardLink = row.querySelector("td.board a");
      var boardHref = boardLink ? boardLink.getAttribute("href") || "" : "";

      rows.push({
        title: text(titleLink) || "(제목 없음)",
        url: absolute(titleLink.getAttribute("href")),
        boardId: (boardHref.match(/\/board\/([^/?#]+)/) || [])[1] || "",
        boardName: text(boardLink) || "(게시판 불명)",
        date: text(row.querySelector("td.date")),
      });
    });

    return rows;
  }

  /** 작성댓글 목록 한 장에서 (본문, 원글 링크, 게시판) 을 뽑는다. */
  function parseComments(doc) {
    var rows = [];

    doc.querySelectorAll(".mrbox").forEach(function (box) {
      var links = box.querySelectorAll('a[href*="/board/"]');
      var boardLink = box.querySelector("a.loc") || links[0] || null;
      var postLink = Array.prototype.find.call(links, function (anchor) {
        return /\/board\/[^/]+\/\d+/.test(anchor.getAttribute("href") || "");
      }) || null;

      var desc = box.querySelector(".desc");
      var body = "";
      if (desc) {
        // .desc 끝의 <span>추천 0 | 비추 0</span> 은 빼고 본문 텍스트만
        body = Array.prototype.filter
          .call(desc.childNodes, function (node) { return node.nodeType === 3; })
          .map(function (node) { return node.textContent; })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }

      var boardHref = boardLink ? boardLink.getAttribute("href") || "" : "";

      rows.push({
        body: body,
        title: text(postLink) || "(원글 제목 없음)",
        url: absolute(postLink ? postLink.getAttribute("href") : ""),
        boardId: (boardHref.match(/\/board\/([^/?#]+)/) || [])[1] || "",
        boardName: text(boardLink) || "(게시판 불명)",
        date: text(box.querySelector(".date")),
      });
    });

    return rows;
  }

  function nickOf(doc) {
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
    return nick;
  }

  var state = { busy: false, abort: false };

  /** 작성댓글 목록을 훑어 본문에 단어가 들어간 댓글을 모은다. */
  async function scanComments(member, maxPages, hits, seen, onProgress) {
    var scanned = 0;

    for (var page = 1; page <= maxPages; page++) {
      if (state.abort) break;

      var rows = parseComments(await fetchDoc(commentUrl(member, page)));
      if (!rows.length) break;

      var fresh = 0;
      rows.forEach(function (row) {
        var key = "c|" + row.url + "|" + row.body;
        if (seen[key]) return;
        seen[key] = true;
        fresh++;
        scanned++;

        if (EXCLUDE_BOARDS.indexOf(row.boardId) >= 0) return; // 스타대학 제외

        var word = WORDS.find(function (candidate) {
          return row.body.indexOf(candidate) >= 0;
        });
        if (!word) return;

        hits.push({
          kind: "댓글",
          word: word,
          title: row.body,
          sub: row.boardName + " · " + row.title,
          url: row.url,
          boardName: row.boardName,
          date: row.date,
        });
      });

      onProgress(page, scanned, hits.length);
      if (!fresh) break;
      await sleep(DELAY);
    }

    return scanned;
  }

  async function judge(member, commentPages, onProgress) {
    var hits = [];
    var seen = {};
    var scanned = 0;
    var nick = "";

    for (var w = 0; w < WORDS.length; w++) {
      if (state.abort) break;
      var word = WORDS[w];

      for (var page = 1; page <= MAX_PAGES; page++) {
        if (state.abort) break;

        var doc = await fetchDoc(searchUrl(member, word, page));
        if (!nick) nick = nickOf(doc);

        var rows = parseRows(doc);
        if (!rows.length) break;

        var added = 0;
        rows.forEach(function (row) {
          scanned++;
          if (EXCLUDE_BOARDS.indexOf(row.boardId) >= 0) return; // 스타대학 제외

          var key = word + "|" + row.url;
          if (seen[key]) return;
          seen[key] = true;
          added++;
          hits.push({
            kind: "글",
            word: word,
            title: row.title,
            sub: row.boardName,
            url: row.url,
            boardName: row.boardName,
            date: row.date,
          });
        });

        onProgress("[" + (w + 1) + "/" + WORDS.length + "] 글 '" + word + "' 검사… 적발 " + hits.length + "건 / 훑은 글 " + scanned + "건");
        if (!added && page > 1) break;
        await sleep(DELAY);
      }
    }

    var commentsScanned = 0;
    if (!state.abort && commentPages > 0) {
      commentsScanned = await scanComments(member, commentPages, hits, seen, function (page, done, found) {
        onProgress("댓글 " + page + "페이지까지 " + done + "건 대조… 적발 " + found + "건");
      });
    }

    return { hits: hits, scanned: scanned, commentsScanned: commentsScanned, nick: nick };
  }

  /* ── UI ────────────────────────────────────────────── */

  var root = document.createElement("div");
  root.id = "yg-ddong-root";
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647";
  document.body.appendChild(root);

  var shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    "<style>",
    ":host,*{box-sizing:border-box}",
    ".back{position:fixed;inset:0;background:rgba(3,8,18,.72);backdrop-filter:blur(4px);display:grid;place-items:center;padding:16px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif}",
    ".box{display:flex;flex-direction:column;width:min(100%,760px);max-height:min(92vh,860px);overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:linear-gradient(150deg,#0f1f3a,#071225);color:#f6f8fc;box-shadow:0 30px 90px rgba(0,0,0,.5)}",
    ".hd,.bar,.msg,.ft{flex:0 0 auto}",
    ".hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.12)}",
    ".hd b{font-size:15px;letter-spacing:.04em}",
    ".hd .who{color:#61d9ff;font-size:13px;font-weight:700}",
    ".x{margin-left:auto;width:32px;height:32px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:transparent;color:#cfdcf0;font-size:15px;cursor:pointer}",
    ".bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.12);font-size:13px}",
    "button{font:inherit;cursor:pointer}",
    "input{padding:8px 10px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(255,255,255,.06);color:#f6f8fc;font:inherit;font-size:13px}",
    "input#member{width:190px}input#cpages{width:64px}",
    ".kind{padding:3px 8px;border:1px solid rgba(255,255,255,.18);border-radius:999px;color:#c4d0e1;font-size:11px;font-weight:700;white-space:nowrap}",
    ".btn{padding:8px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.07);color:#f6f8fc;font-size:13px;font-weight:700}",
    ".btn.go{border-color:transparent;background:#1769ff}",
    ".btn:disabled{opacity:.45;cursor:not-allowed}",
    ".msg{padding:10px 18px;color:#98a7be;font-size:12.5px;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.12)}",
    ".msg.err{color:#ff9d9d}",
    ".list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px}",
    ".row{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:9px;align-items:center;padding:9px 11px;border-radius:10px;text-decoration:none;color:inherit}",
    ".row>span{min-width:0}",
    ".row:nth-child(odd){background:rgba(255,255,255,.03)}",
    ".row:hover{background:rgba(255,122,112,.12)}",
    ".word{padding:3px 9px;border-radius:999px;background:#e2483c;color:#fff;font-size:11.5px;font-weight:700;white-space:nowrap}",
    ".row .t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:700}",
    ".row .s{display:block;margin-top:3px;color:#8fa0b8;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".row .d{color:#8fa0b8;font-size:11.5px;white-space:nowrap}",
    ".empty{padding:40px;color:#98a7be;text-align:center;font-size:13px}",
    ".ft{padding:12px 18px;border-top:1px solid rgba(255,255,255,.12);color:#8fa0b8;font-size:11.5px;line-height:1.6}",
    ".pop{position:fixed;inset:0;display:grid;place-items:center;padding:20px;background:rgba(2,6,14,.82);backdrop-filter:blur(6px)}",
    ".pop[hidden]{display:none}",
    ".card{width:min(100%,440px);padding:34px 28px 26px;border:1px solid rgba(255,255,255,.16);border-radius:22px;text-align:center;animation:pop .32s cubic-bezier(.2,.9,.3,1.2) both}",
    ".card.bad{background:linear-gradient(160deg,#5a1712,#2a0b09);box-shadow:0 30px 80px rgba(226,72,60,.35)}",
    ".card.good{background:linear-gradient(160deg,#0d4030,#062018);box-shadow:0 30px 80px rgba(75,225,160,.28)}",
    ".card .face{font-size:60px;line-height:1}",
    ".card h2{margin:14px 0 0;font-size:44px;font-weight:900;letter-spacing:-.03em}",
    ".card.bad h2{color:#ff8b80}",
    ".card.good h2{color:#63e8b0}",
    ".card p{margin:14px 0 0;color:#dfe8f5;font-size:14px;line-height:1.7}",
    ".card .who2{margin-top:6px;color:#9fb0c5;font-size:12.5px}",
    ".card button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:12px;background:rgba(255,255,255,.14);color:#fff;font-size:14px;font-weight:700}",
    ".card button:hover{background:rgba(255,255,255,.22)}",
    "@keyframes pop{from{opacity:0;transform:scale(.88) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}",
    "</style>",
    '<div class="back"><div class="box">',
    '  <div class="hd"><b>똥퀴감별기</b><span class="who" id="who"></span>',
    '    <button class="x" id="close" title="닫기">✕</button></div>',
    '  <div class="bar">',
    '    <input id="member" placeholder="회원번호 또는 미니로그 주소" inputmode="numeric">',
    '    <span>댓글</span><input id="cpages" type="number" value="20" min="0" max="200"><span>페이지</span>',
    '    <button class="btn go" id="go">감별</button><button class="btn" id="stop" disabled>중지</button>',
    "  </div>",
    '  <div class="msg" id="msg">회원번호를 넣고 감별을 누르세요. 스타대학 게시판 글은 판정에서 빠집니다.</div>',
    '  <div class="list" id="list"><div class="empty">아직 감별하지 않았습니다.</div></div>',
    '  <div class="ft" id="ft">검사 단어: ' + WORDS.join(", ") +
      "<br>댓글은 목록에 보이는 앞부분만 대조합니다(긴 댓글은 뒤쪽이 잘림). 0을 넣으면 댓글을 건너뜁니다.</div>",
    "</div></div>",
    '<div class="pop" id="pop" hidden><div class="card" id="card">',
    '  <div class="face" id="face"></div><h2 id="verdict"></h2>',
    '  <p id="detail"></p><div class="who2" id="who2"></div>',
    '  <button id="popClose">확인</button>',
    "</div></div>",
  ].join("");

  var el = function (id) { return shadow.getElementById(id); };

  function say(message, kind) {
    var box = el("msg");
    box.className = "msg" + (kind ? " " + kind : "");
    box.textContent = message;
  }

  function showPopup(isBad, result, member) {
    var hits = result.hits;
    var posts = hits.filter(function (hit) { return hit.kind === "글"; }).length;
    var comments = hits.length - posts;

    el("card").className = "card " + (isBad ? "bad" : "good");
    el("face").textContent = isBad ? "💩" : "✨";
    el("verdict").textContent = isBad ? "똥퀴!" : "클린유저";
    el("detail").innerHTML = isBad
      ? "금지 단어 <b>" + escapeHtml(hits[0].word) + "</b> 등 <b>" + hits.length + "건</b> 사용 확인." +
        "<br>글 " + posts + "건 · 댓글 " + comments + "건" +
        "<br>스타대학 게시판은 판정에서 제외했습니다."
      : "검사 단어 " + WORDS.length + "개 중 사용 이력 없음." +
        "<br>글 " + result.scanned + "건 · 댓글 " + result.commentsScanned + "건을 훑었습니다.";
    el("who2").textContent = (result.nick ? result.nick + " " : "") + "#" + member;
    el("pop").hidden = false;
  }

  function renderHits(hits) {
    var list = el("list");

    if (!hits.length) {
      list.innerHTML = '<div class="empty">해당 단어를 쓴 글이 없습니다.</div>';
      return;
    }

    list.innerHTML = hits
      .map(function (hit) {
        return (
          '<a class="row" href="' + escapeHtml(hit.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="kind">' + escapeHtml(hit.kind) + "</span>" +
          '<span class="word">' + escapeHtml(hit.word) + "</span>" +
          '<span><span class="t">' + escapeHtml(hit.title) + "</span>" +
          '<span class="s">' + escapeHtml(hit.sub || hit.boardName) + "</span></span>" +
          '<span class="d">' + escapeHtml(hit.date) + "</span></a>"
        );
      })
      .join("");
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

  el("popClose").addEventListener("click", function () {
    el("pop").hidden = true;
  });

  el("stop").addEventListener("click", function () {
    state.abort = true;
    say("중지 요청됨.");
  });

  el("member").addEventListener("keydown", function (event) {
    if (event.key === "Enter") el("go").click();
  });

  el("go").addEventListener("click", async function () {
    var member = parseMember(el("member").value);
    if (!member) {
      say("회원번호를 확인하세요.", "err");
      return;
    }

    state.abort = false;
    setBusy(true);
    el("list").innerHTML = '<div class="empty">감별 중…</div>';
    say("감별 중…");

    var commentPages = Math.max(0, Math.min(200, Number(el("cpages").value) || 0));

    try {
      var result = await judge(member, commentPages, say);

      el("who").textContent = (result.nick ? result.nick + " " : "") + "#" + member;
      renderHits(result.hits);
      say(
        result.hits.length
          ? "적발 " + result.hits.length + "건. 아래 목록에서 원문을 확인하세요."
          : "적발 없음. 훑은 글 " + result.scanned + "건 · 댓글 " + result.commentsScanned + "건."
      );
      showPopup(result.hits.length > 0, result, member);
    } catch (error) {
      say("감별 실패: " + error.message, "err");
    } finally {
      state.abort = false;
      setBusy(false);
    }
  });

  var prefill = parseMember(location.search);
  if (prefill) el("member").value = String(prefill);
  el("member").focus();
})();
