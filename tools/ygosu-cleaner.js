/*!
 * YGOSU CLEANER — 와이고수 내 글 / 내 댓글 일괄 삭제 도구
 *
 * 반드시 ygosu.com 에서 로그인한 상태로 실행할 것.
 * 삭제는 와이고수 자체 일괄삭제 폼(POST /minilog/delete_all.yg)을 그대로 사용한다.
 * 체크박스 필드명은 실행 시점에 내 목록 페이지의 폼에서 직접 읽어내므로 하드코딩하지 않는다.
 *
 * 삭제는 되돌릴 수 없다. 목록을 먼저 수집해 보여주고, 체크한 항목만 지운다.
 */
(function () {
  "use strict";

  if (!/(^|\.)ygosu\.com$/i.test(location.hostname)) {
    alert("이 도구는 ygosu.com 에서 실행해야 합니다.");
    return;
  }

  if (document.getElementById("yg-cleaner-root")) {
    alert("이미 실행 중입니다.");
    return;
  }

  var ME = Number(window.CURRENT_LOGIN_MEMBER || 0);
  if (!ME) {
    alert("로그인이 필요합니다. 와이고수에 로그인한 뒤 다시 실행하세요.");
    return;
  }

  var DELETE_ACTION = "/minilog/delete_all.yg";
  var SCAN_DELAY = 400;        // 목록 페이지 요청 간격 (ms)
  var DELETE_DELAY = 600;      // 삭제 요청 간격 (ms). 건당 1요청이라 너무 길면 못 쓴다
  /* 와이고수는 article_selected[] 를 배열로 받지 않는다. 한 요청에 20개를 실어
     보내도 딱 1건만 지워진다(90개 선택 → 5배치 → 5개 삭제로 확인). 그래서
     한 건씩 보낸다. 선택한 개수만큼 요청이 나가므로 그만큼 시간이 걸린다. */
  var BATCH_SIZE = 1;
  var CHECKPOINT = 10;         // 이만큼 요청할 때마다 실제로 줄고 있는지 확인한다

  /* m.ygosu.com 은 PC 와 주소 체계가 다르다.
     PC   : /minilog/?m2=article&member=X&m3=comment&m4=normal
     모바일: /minilog/?member=X&menu=comment_list
     PC 주소를 모바일에서 열면 목록 없는 프로필 페이지가 나온다.
     마크업(.mrbox, table.tbl_ua, 삭제 폼)은 양쪽이 같아서 파서는 그대로 쓴다. */
  var MOBILE = /^m\.ygosu\.com$/i.test(location.hostname) || window.IS_MOBILE === true;

  var MODES = {
    comment: {
      label: "내 댓글",
      mode: "comment",
      url: function (page) {
        return MOBILE
          ? "/minilog/?member=" + ME + "&menu=comment_list&page=" + page
          : "/minilog/?m2=article&member=" + ME + "&m3=comment&m4=normal&page=" + page;
      },
    },
    article: {
      label: "내 글",
      mode: "article",
      url: function (page) {
        return MOBILE
          ? "/minilog/?member=" + ME + "&menu=article_list&page=" + page
          : "/minilog/?m2=article&member=" + ME + "&m3=list&page=" + page;
      },
    },
  };

  var state = { mode: "comment", items: [], field: "", hidden: {}, pages: 1, busy: false, abort: false };

  /* ── 목록 수집 ─────────────────────────────────────── */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function text(node) {
    return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
  }

  async function fetchDoc(url) {
    var response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    var buffer = await response.arrayBuffer();
    var html = new TextDecoder("utf-8").decode(buffer);
    return new DOMParser().parseFromString(html, "text/html");
  }

  /** 목록 문서 1장에서 체크 가능한 항목을 뽑는다. */
  function parsePage(doc) {
    var form = doc.querySelector('form[action*="delete_all.yg"]');
    if (!form) return { items: [], field: "", hidden: {}, hasForm: false };

    var hidden = {};
    form.querySelectorAll('input[type="hidden"]').forEach(function (input) {
      if (input.name) hidden[input.name] = input.value;
    });

    var items = [];
    var field = "";

    /* 와이고수는 선택 입력을 type=radio 로 뿌린다(이름은 article_selected[]).
       브라우저 기본 동작상 라디오는 하나만 선택되지만, 여기서는 POST 본문을
       직접 만들기 때문에 여러 값을 함께 보낼 수 있다. checkbox 도 같이 받는다. */
    form.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(function (box) {
      var value = (box.value || "").trim();
      // 전체선택용 입력은 값이 없거나 "on" 이므로 제외
      if (!box.name || !value || value.toLowerCase() === "on") return;

      var row = box.closest("tr, .mrbox, li, .item") || box.parentElement;
      // 게시판 이름 링크(/board/pan_monstarz/)가 아니라 글 링크(/board/pan_monstarz/12345)를 고른다
      var link = row
        ? Array.prototype.find.call(row.querySelectorAll('a[href*="/board/"]'), function (anchor) {
            return /\/board\/[^/]+\/\d+/.test(anchor.getAttribute("href") || "");
          }) || null
        : null;
      var board = row ? row.querySelector(".board a, .loc") : null;
      var date = row ? row.querySelector(".date") : null;
      var desc = row ? row.querySelector(".desc") : null;
      // .desc 안의 <span>추천 0 | 비추 0</span> 은 빼고 본문 텍스트만
      var body = "";
      if (desc) {
        body = Array.prototype.filter
          .call(desc.childNodes, function (node) { return node.nodeType === 3; })
          .map(function (node) { return node.textContent; })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!body) body = text(desc);
      }

      field = field || box.name;
      items.push({
        value: value,
        field: box.name,
        title: text(link) || "(제목 없음)",
        href: link ? link.getAttribute("href") : "",
        board: text(board),
        date: text(date),
        body: body.slice(0, 120),
      });
    });

    return { items: items, field: field, hidden: hidden, hasForm: true };
  }

  async function scan(maxPages, onProgress) {
    var config = MODES[state.mode];
    var collected = [];
    var seen = {};
    var field = "";
    var hidden = {};

    for (var page = 1; page <= maxPages; page++) {
      if (state.abort) break;

      var parsed = parsePage(await fetchDoc(config.url(page)));

      if (!parsed.hasForm) {
        throw new Error("일괄삭제 폼을 찾지 못했습니다. 로그인 상태와 본인 계정인지 확인하세요.");
      }
      if (!parsed.items.length) break;

      field = field || parsed.field;
      hidden = Object.keys(hidden).length ? hidden : parsed.hidden;

      // 페이지당 개수가 PC 30개 / 모바일 20~10개로 달라서 개수로 끝을 판단하지 않는다.
      // 새로 얻은 항목이 하나도 없으면 마지막 페이지를 반복해서 받은 것이다.
      var added = 0;
      parsed.items.forEach(function (item) {
        if (seen[item.value]) return;
        seen[item.value] = true;
        collected.push(item);
        added++;
      });

      onProgress(page, collected.length);

      if (!added) break;
      if (page < maxPages) await sleep(SCAN_DELAY);
    }

    state.items = collected;
    state.field = field;
    state.hidden = hidden;
    state.pages = maxPages;   // 삭제 후 같은 범위를 다시 훑어 반영 여부를 확인한다
    return collected;
  }

  /* ── 삭제 ──────────────────────────────────────────── */

  async function deleteBatch(values) {
    var body = new URLSearchParams();

    body.set("mode", MODES[state.mode].mode);
    body.set("member", String(ME));              // 항상 로그인한 본인으로 고정
    body.set("backurl", state.hidden.backurl || location.origin + MODES[state.mode].url(1));

    Object.keys(state.hidden).forEach(function (key) {
      if (key !== "mode" && key !== "member" && key !== "backurl") {
        body.set(key, state.hidden[key]);
      }
    });

    values.forEach(function (value) { body.append(state.field, value); });

    /* 네이티브 폼은 목록 페이지에서 제출된다. 다른 페이지에서 보낸 요청을
       서버가 걸러낼 수 있으므로 Referer 를 목록 페이지로 맞춘다. */
    var response = await fetch(DELETE_ACTION, {
      method: "POST",
      credentials: "same-origin",
      referrer: location.origin + MODES[state.mode].url(1),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
    });

    if (!response.ok) throw new Error("HTTP " + response.status);

    // 200 이 곧 삭제됨을 뜻하지 않는다. 실패해도 안내 페이지를 200 으로 준다.
    return response.text();
  }

  /* 삭제 응답은 backurl 로 돌아온 목록 페이지라 "(총 N개)" 가 들어 있다.
     이 숫자가 줄어들지 않으면 서버가 요청을 받아주지 않은 것이다.
     전체 재조회(200페이지면 수십 초) 없이 매 요청마다 확인할 수 있다. */
  function totalFrom(html) {
    var match = String(html).match(/\(총\s*<strong>\s*([\d,]+)\s*<\/strong>/);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  }

  /* ── UI ────────────────────────────────────────────── */

  var root = document.createElement("div");
  root.id = "yg-cleaner-root";
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647";
  document.body.appendChild(root);

  var shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    "<style>",
    ":host,*{box-sizing:border-box}",
    ".back{position:fixed;inset:0;background:rgba(3,8,18,.72);backdrop-filter:blur(4px);display:grid;place-items:center;padding:16px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif}",
    ".box{display:flex;flex-direction:column;width:min(100%,860px);max-height:min(92vh,860px);overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:linear-gradient(150deg,#0f1f3a,#071225);color:#f6f8fc;box-shadow:0 30px 90px rgba(0,0,0,.5)}",
    /* 목록만 늘어나고 나머지 줄은 절대 눌리지 않게 한다 */
    ".hd,.bar,.msg,.ft{flex:0 0 auto}",
    ".hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.12)}",
    ".hd b{font-size:15px;letter-spacing:.04em}",
    ".hd .me{color:#98a7be;font-size:12px}",
    ".x{margin-left:auto;width:32px;height:32px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:transparent;color:#cfdcf0;font-size:15px;cursor:pointer}",
    ".bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.12);font-size:13px}",
    "button{font:inherit;cursor:pointer}",
    ".seg{display:flex;gap:4px;padding:3px;border:1px solid rgba(255,255,255,.14);border-radius:11px}",
    ".seg button{padding:7px 13px;border:0;border-radius:8px;background:transparent;color:#98a7be;font-size:13px;font-weight:700}",
    ".seg button.on{color:#061022;background:#61d9ff}",
    "input[type=number]{width:64px;padding:7px 9px;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(255,255,255,.06);color:#f6f8fc;font:inherit;font-size:13px}",
    ".btn{padding:8px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.07);color:#f6f8fc;font-size:13px;font-weight:700}",
    ".btn:hover{border-color:rgba(97,217,255,.5)}",
    ".btn.go{border-color:transparent;background:#1769ff}",
    ".btn.danger{border-color:transparent;background:#e2483c}",
    ".btn:disabled{opacity:.45;cursor:not-allowed}",
    ".msg{padding:10px 18px;color:#98a7be;font-size:12.5px;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.12)}",
    ".msg.err{color:#ff9d9d}",
    ".msg.ok{color:#4be1a0}",
    ".list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px}",
    ".row{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:10px;align-items:start;padding:9px 11px;border-radius:10px;font-size:13px}",
    ".row>span{min-width:0}",
    ".row:nth-child(odd){background:rgba(255,255,255,.03)}",
    ".row .t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}",
    ".row .s{display:block;margin-top:3px;color:#8fa0b8;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".row .d{color:#8fa0b8;font-size:11px;white-space:nowrap}",
    ".empty{padding:40px;color:#98a7be;text-align:center;font-size:13px}",
    ".ft{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 18px;border-top:1px solid rgba(255,255,255,.12);font-size:13px}",
    ".ft .count{color:#61d9ff;font-weight:700}",
    ".ft .right{margin-left:auto;display:flex;gap:8px}",
    "</style>",
    '<div class="back">',
    '  <div class="box">',
    '    <div class="hd"><b>YGOSU CLEANER</b><span class="me">회원번호 ' + ME + "</span>",
    '      <button class="x" id="close" title="닫기">✕</button></div>',
    '    <div class="bar">',
    '      <div class="seg"><button id="m-comment" class="on">내 댓글</button><button id="m-article">내 글</button></div>',
    "      <span>최대</span><input type=\"number\" id=\"pages\" value=\"3\" min=\"1\" max=\"200\"><span>페이지 (한 페이지 30개)</span>",
    '      <button class="btn go" id="scan">목록 불러오기</button>',
    '      <button class="btn" id="stop" disabled>중지</button>',
    "    </div>",
    '    <div class="msg" id="msg">삭제할 항목을 먼저 불러오세요. 불러온 뒤 체크한 항목만 삭제됩니다.</div>',
    '    <div class="list" id="list"><div class="empty">목록 없음</div></div>',
    '    <div class="ft">',
    '      <button class="btn" id="all">전체 선택</button><button class="btn" id="none">선택 해제</button>',
    '      <span class="count" id="count">0개 선택</span>',
    '      <span class="right"><button class="btn danger" id="del" disabled>선택 항목 삭제</button></span>',
    "    </div>",
    "  </div>",
    "</div>",
  ].join("");

  var el = function (id) { return shadow.getElementById(id); };
  var listEl = el("list");

  function say(message, kind) {
    var box = el("msg");
    box.className = "msg" + (kind ? " " + kind : "");
    box.textContent = message;
  }

  function checkedValues() {
    return Array.prototype.slice
      .call(listEl.querySelectorAll("input:checked"))
      .map(function (box) { return box.value; });
  }

  function refreshCount() {
    var n = checkedValues().length;
    el("count").textContent = n + "개 선택";
    el("del").disabled = n === 0 || state.busy;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderList() {
    if (!state.items.length) {
      listEl.innerHTML = '<div class="empty">불러온 항목이 없습니다.</div>';
      refreshCount();
      return;
    }

    listEl.innerHTML = state.items
      .map(function (item) {
        var sub = [item.board, item.body].filter(Boolean).join(" · ");
        return (
          '<label class="row">' +
          '<input type="checkbox" value="' + escapeHtml(item.value) + '">' +
          "<span><span class=\"t\">" + escapeHtml(item.title) + "</span>" +
          (sub ? '<span class="s">' + escapeHtml(sub) + "</span>" : "") +
          "</span>" +
          '<span class="d">' + escapeHtml(item.date) + "</span>" +
          "</label>"
        );
      })
      .join("");

    listEl.querySelectorAll("input").forEach(function (box) {
      box.addEventListener("change", refreshCount);
    });
    refreshCount();
  }

  function setMode(mode) {
    if (state.busy) return;
    state.mode = mode;
    el("m-comment").className = mode === "comment" ? "on" : "";
    el("m-article").className = mode === "article" ? "on" : "";
    state.items = [];
    renderList();
    say(MODES[mode].label + " 모드. 목록을 불러오세요.");
  }

  function setBusy(busy) {
    state.busy = busy;
    el("scan").disabled = busy;
    el("stop").disabled = !busy;
    el("m-comment").disabled = busy;
    el("m-article").disabled = busy;
    refreshCount();
  }

  el("m-comment").addEventListener("click", function () { setMode("comment"); });
  el("m-article").addEventListener("click", function () { setMode("article"); });
  el("close").addEventListener("click", function () {
    if (state.busy && !confirm("작업이 진행 중입니다. 정말 닫을까요?")) return;
    state.abort = true;
    root.remove();
  });

  el("all").addEventListener("click", function () {
    listEl.querySelectorAll("input").forEach(function (box) { box.checked = true; });
    refreshCount();
  });

  el("none").addEventListener("click", function () {
    listEl.querySelectorAll("input").forEach(function (box) { box.checked = false; });
    refreshCount();
  });

  el("stop").addEventListener("click", function () {
    state.abort = true;
    say("중지 요청됨. 진행 중인 요청이 끝나면 멈춥니다.");
  });

  el("scan").addEventListener("click", async function () {
    var maxPages = Math.max(1, Math.min(200, Number(el("pages").value) || 1));
    state.abort = false;
    setBusy(true);
    say("목록을 불러오는 중…");

    try {
      await scan(maxPages, function (page, total) {
        say(page + "페이지까지 " + total + "개 수집…");
      });
      renderList();
      say(
        state.items.length
          ? state.items.length + "개를 불러왔습니다. 지울 항목만 체크하세요."
          : "불러온 항목이 없습니다.",
        state.items.length ? "ok" : null
      );
    } catch (error) {
      say("불러오기 실패: " + error.message, "err");
    } finally {
      state.abort = false;
      setBusy(false);
    }
  });

  el("del").addEventListener("click", async function () {
    var values = checkedValues();
    if (!values.length) return;

    // 와이고수가 건당 1요청만 처리하므로 개수만큼 시간이 든다. 미리 알려준다.
    var minutes = Math.ceil((values.length * DELETE_DELAY) / 60000);

    var typed = prompt(
      "선택한 " + values.length + "개 " + MODES[state.mode].label + "을(를) 삭제합니다.\n" +
        "되돌릴 수 없습니다.\n\n" +
        "와이고수는 한 번에 한 건만 지워서 약 " + minutes + "분 걸립니다. 창을 켜 두세요.\n\n" +
        "진행하려면 아래에 " + values.length + " 를 입력하세요."
    );
    if (String(typed).trim() !== String(values.length)) {
      say("취소했습니다.");
      return;
    }

    state.abort = false;
    setBusy(true);

    var done = 0;
    var failed = 0;
    var stalled = false;
    var batches = 0;
    var firstTotal = null;
    var lastTotal = null;
    var checkpointTotal = null;

    try {
      for (var i = 0; i < values.length; i += BATCH_SIZE) {
        if (state.abort) break;

        var batch = values.slice(i, i + BATCH_SIZE);
        try {
          var html = await deleteBatch(batch);
          done += batch.length;

          var total = totalFrom(html);
          if (total !== null) {
            if (firstTotal === null) firstTotal = checkpointTotal = total;
            lastTotal = total;
          }
        } catch (error) {
          failed += batch.length;
        }

        batches++;
        var left = values.length - done - failed;
        say(
          "삭제 중… " + done + "/" + values.length +
            (left > 0 ? " · 남은 시간 약 " + Math.ceil((left * DELETE_DELAY) / 60000) + "분" : "") +
            (lastTotal !== null ? " · 전체 " + lastTotal.toLocaleString("ko-KR") + "개" : "") +
            (failed ? " · 실패 " + failed : "")
        );

        /* 총 개수가 한동안 전혀 줄지 않으면 서버가 받아주지 않는 것이다.
           수백 번을 더 보내며 "성공"이라고 말하는 대신 여기서 멈춘다. */
        if (lastTotal !== null && batches % CHECKPOINT === 0) {
          if (lastTotal >= checkpointTotal) {
            stalled = true;
            break;
          }
          checkpointTotal = lastTotal;
        }

        if (i + BATCH_SIZE < values.length) await sleep(DELETE_DELAY);
      }

      /* 요청이 200 으로 돌아왔다고 지워진 게 아니다.
         목록을 다시 받아 실제로 사라졌는지 세어 보고 그 숫자를 보고한다. */
      say("삭제 반영 확인 중… 목록을 다시 불러옵니다.");

      // 중지를 눌러 멈춘 경우에도 확인은 해야 한다. 안 그러면 재조회가 즉시 끊겨
      // 항목이 사라진 것처럼 보이고 "삭제됨"으로 오판한다.
      state.abort = false;

      var requested = values.slice(0, done);
      var stillThere = {};
      var verified = true;

      try {
        await scan(state.pages || 1, function () {});
        state.items.forEach(function (item) { stillThere[item.value] = true; });
      } catch (error) {
        verified = false;
      }

      renderList();

      if (!verified) {
        say("삭제 요청은 보냈지만 목록을 다시 불러오지 못해 확인하지 못했습니다. 직접 확인하세요.", "err");
      } else {
        var gone = requested.filter(function (value) { return !stillThere[value]; }).length;
        var left = requested.length - gone;

        if (stalled) {
          say(
            "삭제 " + gone + "개에서 멈췄습니다. 그 뒤로는 전체 개수가 줄지 않아 와이고수가 요청을 " +
              "받지 않는다고 보고 중단했습니다. 잠시 뒤 적은 개수로 다시 시도하세요.",
            "err"
          );
        } else if (gone === requested.length && !failed) {
          say("삭제 완료: " + gone + "개. 목록에서 사라진 것을 확인했습니다.", "ok");
        } else if (gone === 0) {
          say(
            "실제로는 하나도 지워지지 않았습니다. 와이고수가 요청을 거부한 것으로 보입니다. " +
              "한 번에 지우는 개수를 줄여 보세요.",
            "err"
          );
        } else {
          say("삭제 확인 " + gone + "개, 남아 있는 것 " + left + "개. 남은 것은 다시 시도하세요.", "err");
        }
      }
    } finally {
      state.abort = false;
      setBusy(false);
    }
  });

  setMode("comment");
})();
