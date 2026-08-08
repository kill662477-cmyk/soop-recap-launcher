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

  /* 미니로그를 비공개로 잠근 회원은 목록 대신 안내문만 돌려준다.
     PC/모바일, 글/댓글 모두 같은 마크업이다:
       <div class='fr_not'>닉 님이 글목록을 <strong>비공개</strong> (으)로 설정하였습니다.</div>
     이걸 "글이 없다"로 처리하면 비공개 회원이 전부 클린유저로 판정된다. */
  function blockedNote(doc) {
    var note = doc.querySelector(".fr_not");
    if (!note) return null;
    var body = text(note);
    if (!/비공개|설정하였습니다/.test(body)) return null;

    // PC 는 안내문 안에 닉네임 링크가 있고, 모바일은 맨 텍스트라 문장에서 뽑는다.
    var nick = text(note.querySelector("a")) || (body.match(/^(.+?)\s*님이/) || [])[1] || "";
    return { nick: nick, note: body };
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

  /* ── 글목록 비공개 회원용 우회 경로 ────────────────────
     미니로그가 잠겨 있어도 글 자체는 게시판에 공개돼 있고,
     게시판 검색에는 글쓴이 검색(searcht=w)이 있다.
     다만 글쓴이와 단어를 동시에 걸 수 없어 제목만 대조한다. 본문은 못 본다. */

  async function loadBoards() {
    var doc = await fetchDoc("/board/all");
    var seen = {};
    var boards = [];

    doc.querySelectorAll('a[href*="/board/"]').forEach(function (anchor) {
      var id = ((anchor.getAttribute("href") || "").match(/\/board\/([a-z_0-9]+)/) || [])[1];
      if (!id || seen[id]) return;
      if (["all", "ad", "notice", "best_article"].indexOf(id) >= 0) return;
      seen[id] = true;
      boards.push({ id: id, name: text(anchor).replace(/^☆\s*/, "").trim() || id });
    });

    return boards;
  }

  function parseAuthorRows(doc, board, boardName) {
    var rows = [];
    var postPattern = new RegExp("/board/" + board + "/(\\d+)");
    // 검색 결과 링크에는 ?searcht=w&search=... 가 붙어 있다. 글 주소만 남긴다.
    var clean = function (href) { return absolute((href || "").split("?")[0]); };

    // PC: <table class='bd_list'> 안의 <tr>. 회원번호가 닉네임 onclick 에 들어 있다.
    doc.querySelectorAll("table.bd_list tr").forEach(function (tr) {
      if (tr.className.indexOf("notice") >= 0) return;

      var link = tr.querySelector("td.tit a[href*='/board/']");
      if (!link || !postPattern.test(link.getAttribute("href") || "")) return;

      var nickLink = tr.querySelector("td.name a[onclick*='show_nick_dropdown']");
      var memberNo = nickLink
        ? ((nickLink.getAttribute("onclick") || "").match(/show_nick_dropdown\([^,]*,\s*'[^']*',\s*'(\d+)'/) || [])[1]
        : "";

      rows.push({
        title: text(link) || "(제목 없음)",
        url: clean(link.getAttribute("href")),
        boardId: board,
        boardName: boardName,
        memberNo: memberNo || "",
        nick: text(nickLink),
        date: text(tr.querySelector("td.date")),
      });
    });

    if (rows.length) return rows;

    // 모바일: 회원번호가 없어 닉네임으로만 대조할 수 있다.
    doc.querySelectorAll("li a[href*='/board/']").forEach(function (anchor) {
      if (!postPattern.test(anchor.getAttribute("href") || "")) return;

      var meta = text(anchor.querySelector("p")).split("|");
      rows.push({
        title: text(anchor.querySelector(".subject")) || "(제목 없음)",
        url: clean(anchor.getAttribute("href")),
        boardId: board,
        boardName: boardName,
        memberNo: "",
        nick: (meta[0] || "").trim(),
        date: (meta[1] || "").trim(),
      });
    });

    return rows;
  }

  /** 게시판을 돌며 그 회원 글의 제목에서 단어를 찾는다. */
  async function judgeByAuthor(member, nick, pagesPerBoard, hits, seen, onProgress) {
    var boards = await loadBoards();
    var scanned = 0;

    for (var b = 0; b < boards.length; b++) {
      if (state.abort) break;
      var board = boards[b];
      if (EXCLUDE_BOARDS.indexOf(board.id) >= 0) continue; // 스타대학 제외

      for (var page = 1; page <= pagesPerBoard; page++) {
        if (state.abort) break;

        var doc;
        try {
          doc = await fetchDoc("/board/" + board.id + "/?searcht=w&search=" + encodeURIComponent(nick) + "&page=" + page);
        } catch (error) {
          break;
        }

        var rows = parseAuthorRows(doc, board.id, board.name);
        if (!rows.length) break;

        var fresh = 0;
        rows.forEach(function (row) {
          if (row.memberNo ? row.memberNo !== String(member) : row.nick !== nick) return;
          if (seen["a|" + row.url]) return;
          seen["a|" + row.url] = true;
          fresh++;
          scanned++;

          var word = WORDS.find(function (candidate) {
            return row.title.indexOf(candidate) >= 0;
          });
          if (!word) return;

          hits.push({
            kind: "글제목",
            word: word,
            title: row.title,
            sub: row.boardName,
            url: row.url,
            boardName: row.boardName,
            date: row.date,
          });
        });

        onProgress(b + 1, boards.length, board.name, scanned, hits.length);
        if (!fresh) break;
        await sleep(DELAY);
      }
    }

    return scanned;
  }

  /** 작성댓글 목록을 훑어 본문에 단어가 들어간 댓글을 모은다. */
  async function scanComments(member, maxPages, hits, seen, onProgress) {
    var scanned = 0;
    var blocked = null;

    for (var page = 1; page <= maxPages; page++) {
      if (state.abort) break;

      var doc = await fetchDoc(commentUrl(member, page));

      if (page === 1) {
        blocked = blockedNote(doc);
        if (blocked) break;
      }

      var rows = parseComments(doc);
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

    return { scanned: scanned, blocked: !!blocked };
  }

  async function judge(member, postPages, commentPages, onProgress) {
    var hits = [];
    var seen = {};
    var scanned = 0;
    var nick = "";
    var postsBlocked = false;

    for (var w = 0; w < WORDS.length && !postsBlocked; w++) {
      if (state.abort) break;
      var word = WORDS[w];

      for (var page = 1; page <= postPages; page++) {
        if (state.abort) break;

        var doc = await fetchDoc(searchUrl(member, word, page));
        if (!nick) nick = nickOf(doc);

        var blocked = blockedNote(doc);
        if (blocked) {
          postsBlocked = true;
          if (!nick) nick = blocked.nick;
          break;
        }

        var rows = parseRows(doc);
        if (!rows.length) break;

        // fresh 는 제외 여부와 무관하게 "처음 본 글" 수다.
        // 스타대학 글만 나온 페이지에서 멈추면 그 뒤의 다른 게시판 글을 놓치므로
        // 적발 건수가 아니라 fresh 로 끝을 판단한다.
        var fresh = 0;
        rows.forEach(function (row) {
          var key = word + "|" + row.url;
          if (seen[key]) return;
          seen[key] = true;
          fresh++;
          scanned++;

          if (EXCLUDE_BOARDS.indexOf(row.boardId) >= 0) return; // 스타대학 제외

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
        if (!fresh) break;
        await sleep(DELAY);
      }
    }

    // 글목록이 잠겨 있으면 게시판 글쓴이 검색으로 돌아간다(제목만 대조).
    var viaAuthor = false;
    if (postsBlocked && nick && !state.abort) {
      viaAuthor = true;
      scanned += await judgeByAuthor(member, nick, postPages, hits, seen, function (index, total, name, done, found) {
        onProgress("[" + index + "/" + total + "] " + name + " 글쓴이 검색… 제목 " + done + "건 대조 / 적발 " + found + "건");
      });
    }

    var commentsScanned = 0;
    var commentsBlocked = false;
    if (!state.abort && commentPages > 0) {
      var result = await scanComments(member, commentPages, hits, seen, function (page, done, found) {
        onProgress("댓글 " + page + "페이지까지 " + done + "건 대조… 적발 " + found + "건");
      });
      commentsScanned = result.scanned;
      commentsBlocked = result.blocked;
    }

    return {
      hits: hits,
      scanned: scanned,
      commentsScanned: commentsScanned,
      postsBlocked: postsBlocked,
      commentsBlocked: commentsBlocked,
      viaAuthor: viaAuthor,
      nick: nick,
    };
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
    "input#member{width:190px}input#ppages,input#cpages{width:62px}",
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
    ".card.unknown{background:linear-gradient(160deg,#2b3550,#141b2c);box-shadow:0 30px 80px rgba(0,0,0,.45)}",
    ".card.unknown h2{color:#c4d0e1}",
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
    '    <span>글</span><input id="ppages" type="number" value="10" min="1" max="200">',
    '    <span>댓글</span><input id="cpages" type="number" value="20" min="0" max="200"><span>페이지</span>',
    '    <button class="btn go" id="go">감별</button><button class="btn" id="stop" disabled>중지</button>',
    "  </div>",
    '  <div class="msg" id="msg">회원번호를 넣고 감별을 누르세요. 스타대학 게시판 글은 판정에서 빠집니다.</div>',
    '  <div class="list" id="list"><div class="empty">아직 감별하지 않았습니다.</div></div>',
    '  <div class="ft" id="ft">검사 단어: ' + WORDS.join(", ") +
      "<br>글은 단어 하나당, 댓글은 전체 기준 페이지 수입니다. 결과가 더 없으면 상한 전에 알아서 멈춥니다." +
      "<br>댓글은 목록에 보이는 앞부분만 대조합니다(긴 댓글은 뒤쪽이 잘림). 댓글에 0을 넣으면 건너뜁니다.</div>",
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

  /** 이번 조회에서 "못 본 구간"을 사람이 읽을 문장으로 만든다. */
  function limitsOf(result) {
    var limits = [];
    if (result.postsBlocked && !result.viaAuthor) limits.push("글목록 비공개");
    if (result.viaAuthor) limits.push("글목록이 비공개라 제목만 확인");
    if (result.commentsBlocked) limits.push("댓글목록 비공개");
    return limits;
  }

  function showPopup(result, member) {
    var hits = result.hits;
    var posts = hits.filter(function (hit) { return hit.kind === "글"; }).length;
    var comments = hits.length - posts;

    // 적발이 하나라도 있으면 그대로 판정한다. 적발이 없는데 못 본 구간이 있으면
    // "안 썼다"가 아니라 "못 봤다"이므로 클린유저로 처리하지 않는다.
    var blockedNames = limitsOf(result);
    var kind = hits.length ? "bad" : blockedNames.length ? "unknown" : "good";

    el("card").className = "card " + kind;
    el("face").textContent = kind === "bad" ? "💩" : kind === "good" ? "✨" : "🔒";
    el("verdict").textContent = kind === "bad" ? "똥퀴!" : kind === "good" ? "클린유저" : "판정 불가";

    if (kind === "bad") {
      el("detail").innerHTML =
        "금지 단어 <b>" + escapeHtml(hits[0].word) + "</b> 등 <b>" + hits.length + "건</b> 사용 확인." +
        "<br>글 " + posts + "건 · 댓글 " + comments + "건" +
        "<br>스타대학 게시판은 판정에서 제외했습니다.";
    } else if (kind === "good") {
      el("detail").innerHTML =
        "검사 단어 " + WORDS.length + "개 중 사용 이력 없음." +
        "<br>글 " + result.scanned + "건 · 댓글 " + result.commentsScanned + "건을 훑었습니다.";
    } else {
      el("detail").innerHTML =
        "확인한 범위에서는 적발되지 않았습니다." +
        "<br>다만 <b>" + escapeHtml(blockedNames.join(", ")) + "</b>이라 전부 보지는 못했습니다." +
        "<br>결백으로 단정할 수 없습니다.";
    }

    el("who2").textContent = (result.nick ? result.nick + " " : "") + "#" + member;
    el("pop").hidden = false;
  }

  function renderHits(hits, result) {
    var list = el("list");

    if (!hits.length) {
      var locked = result ? limitsOf(result) : [];

      list.innerHTML = locked.length
        ? '<div class="empty">🔒 ' + escapeHtml(locked.join(", ")) + " — 전부 확인하지는 못했습니다.</div>"
        : '<div class="empty">해당 단어를 쓴 글이 없습니다.</div>';
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

    var postPages = Math.max(1, Math.min(200, Number(el("ppages").value) || 1));
    var commentPages = Math.max(0, Math.min(200, Number(el("cpages").value) || 0));

    try {
      var result = await judge(member, postPages, commentPages, say);

      el("who").textContent = (result.nick ? result.nick + " " : "") + "#" + member;
      renderHits(result.hits, result);

      var locked = limitsOf(result);

      if (result.hits.length) {
        say("적발 " + result.hits.length + "건. 아래 목록에서 원문을 확인하세요.");
      } else if (locked.length) {
        say("적발 없음. 다만 " + locked.join(", ") + " — 판정할 수 없습니다.", "err");
      } else {
        say("적발 없음. 훑은 글 " + result.scanned + "건 · 댓글 " + result.commentsScanned + "건.");
      }

      showPopup(result, member);
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
